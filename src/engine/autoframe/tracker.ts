/**
 * Active tracking session (I/O around TrackController): low-bandwidth NDI
 * frames -> YuNet faces + ego-motion (phase correlation) -> controller ->
 * VISCA pan/tilt velocity drive (+ optional bounded zoom steps).
 *
 * Hard rules (camera units, independent of the image estimates):
 *  - at the start (picture still) the idle VISCA position is read; if the zoom
 *    is more than trackZoomTolerancePct off the seat preset's stored zoom, or
 *    pan/tilt are far beyond the excursion limit, the camera is stopped and the
 *    preset recalled (a recall that did not take, a camera moved by hand);
 *  - pan/tilt never go further than trackMaxExcursionPct (converted to VISCA
 *    units with the calibration at the preset zoom) from the preset's stored
 *    position: dead-reckoned from the commanded speeds while moving, re-read
 *    while idle; the controller is told which drive directions are blocked;
 *  - zoom (only with trackZoom) is sent as small ABSOLUTE steps inside the
 *    preset zoom +/- tolerance, never as a free-running zoom drive;
 *  - a face taller than trackTightFacePct, or an idle zoom read off by more than
 *    the tolerance, recalls the preset;
 *  - no face for noFaceCheckMs after the start: the position is checked and the
 *    preset recalled if it is off.
 *  At most MAX_RECALLS recalls per session (no loops).
 *
 * Stale positions: after a preset recall the P100 keeps answering the pan/tilt
 * inquiry with the position from BEFORE the recall (zoom is current), for many
 * seconds (round 2: "camera at 265" = preset 5 while it showed preset 11; three
 * needless recalls, 10 s without tracking). So after a start or recall a
 * pan/tilt read is only trusted once it agrees with the preset, or once it has
 * changed after a drive (the reply is live again). Until then the estimate is
 * the stored preset position plus dead reckoning, and only a zoom far off
 * recalls. Garbage replies (pan equal to the zoom value, tilt out of range) are
 * ignored.
 *
 * Detection: YuNet every tick; when it has no usable face in the seat region,
 * the head/upper-body fallback (RTMDet person + RTMPose keypoints) runs too.
 * Every tick the shot observation goes to ctx.onShot (the room's shot gate).
 *
 * Safety:
 *  - only changed commands are sent; stop is always explicit (drive stop on
 *    both axes + zoom stop, each retried once) when the session ends, the
 *    target is lost, or the controller says so;
 *  - watchdog: if the loop stalls (no tick for watchdogMs) while the camera is
 *    moving, the camera is stopped, like the jog deadman;
 *  - stop() sends the stop synchronously into the VISCA queue before anything
 *    else can be queued, so a later preset recall never races a drive.
 *
 * Learned correction (policy.trackLearn, learn.ts): after the recall and the
 * still picture, a seat's learned offset is applied as one move (relative pan;
 * with a tilt part an absolute move to the preset's STORED coordinates plus
 * the correction, as the P100's relative tilt is broken), then tracking
 * starts. Good turns add a sample when the session ends. The preset itself is
 * never saved or changed here.
 *
 * Sharpness (policy.trackBlurRatioPct): every matched tick the head-region
 * sharpness goes into the shot observation with the seat's recent sharp
 * baseline; the gate does not cut to the PTZ while the head is blurry.
 */
import type { CameraConfig, RoomPolicy } from '../types.js';
import type { CameraDriver, JogDir, PtzPosition } from '../cameras/types.js';
import type { FrameSource } from '../ndi/frames.js';
import type { RefineResult, TrackContext, TrackSession, TrackingState, ShotTracker } from '../room/controller.js';
import { downscale, type RgbaImage } from '../image/jpeg.js';
import { calibrationFromOptions, coefficientsAt, type Calibration } from './calibration.js';
import {
  describeCorrection,
  LEARN_END_REASONS,
  LEARN_MIN_GOOD_MS,
  LEARN_MIN_TICKS,
  LEARN_STILL_MS,
  iqr,
  learnedCorrection,
  offsetToUnits,
  type LearnedCorrection,
  type SeatLearning,
} from './learn.js';
import { headSharpness, SharpnessBaselines } from './sharpness.js';
import { gateThresholds, judgeShot, type GateThresholds, type ShotObservation } from './shot-gate.js';
import { checkAgainstPreset, clampZoom, excursionUnits, FALLBACK_UNITS, fmtPos } from './limits.js';
import { phaseCorrelate, waitVideoStill } from './phase.js';
import { idlePosition, presetPosition, type PresetPosition } from './presets.js';
import { P100_RATES, P100_RATES_ZOOM, TrackController, type TrackCommand, type TrackSettings } from './track-controller.js';
import type { FaceDetector } from './yunet.js';
import type { HeadDetector } from './person.js';

export interface TrackerDeps {
  frames: FrameSource;
  detector: () => Promise<FaceDetector>;
  /** Head/upper-body fallback (null/absent or failing: YuNet only). */
  heads?: () => Promise<HeadDetector | null>;
  /** Loop period (ms); default 100 (10 Hz). */
  periodMs?: number;
  watchdogMs?: number;
  now?: () => number;
  /** Idle position re-read interval while tracking (ms; default 2000). */
  positionCheckMs?: number;
  /** Idle for this long after a move before a position read (ms; default 700). */
  idleReadAfterMs?: number;
  /** No face this long after the start: check the position (ms; default 6000). */
  noFaceCheckMs?: number;
  /** After a recall, don't look for a still picture before this (ms; default 1800: the P100 starts late). */
  recallStillMinMs?: number;
  /** Per-seat learned corrections (absent: no learning). */
  learning?: SeatLearning;
  /** Per-seat sharpness baselines (createTracker makes one if absent). */
  sharpness?: SharpnessBaselines;
  /** A turn teaches only after the shot was good this long (ms; default LEARN_MIN_GOOD_MS; tests shorten it). */
  learnMinGoodMs?: number;
}

/** A blurry head blocks the cut to the PTZ for at most this long per turn (a stale baseline must not keep a seat off air). */
export const BLUR_RELEASE_MS = 8000;

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const ODO_W = 320;
/** At most this many preset recalls per tracking session (no recall loops). */
export const MAX_RECALLS = 3;
/** "Far off" (needs a recall) = this many times the excursion limit. */
const OFF_FACTOR = 1.3;

/** Controller settings from the room policy and camera options (options.autoframe.track overrides). */
export function trackSettings(policy: RoomPolicy, camera: CameraConfig): Partial<TrackSettings> {
  const af = (camera.options.autoframe ?? {}) as Record<string, unknown>;
  const o = (af.track ?? {}) as Record<string, unknown>;
  const cal = calibrationFromOptions(camera.options);
  const num = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : undefined);
  const arr = (k: string) => (Array.isArray(o[k]) && (o[k] as unknown[]).every((x) => typeof x === 'number') ? (o[k] as number[]) : undefined);
  const exc = policy.trackMaxExcursionPct / 100;
  const s: Partial<TrackSettings> = {
    deadzoneX: policy.trackDeadzoneXPct / 100,
    deadzoneY: policy.trackDeadzoneYPct / 100,
    maxLevel: policy.trackMaxSpeed,
    maxExcursionX: exc,
    maxExcursionY: exc,
    lossHoldMs: policy.trackLossTimeoutMs,
    returnAfterMs: policy.trackReturnAfterMs,
    zoom: policy.trackZoom,
    reacquire: policy.trackReacquire,
    seatScore: policy.trackSeatMinScore,
    tightFace: policy.trackTightFacePct / 100,
    ratesPan: arr('ratesPan') ?? P100_RATES.pan,
    ratesTilt: arr('ratesTilt') ?? P100_RATES.tilt,
    // calibration sign: dxPerPan < 0 means pan + (drive right) moves the scene left
    panSign: cal && cal.points[0]!.dxPerPan > 0 ? -1 : 1,
    tiltSign: cal && cal.points[0]!.dyPerTilt < 0 ? 1 : -1,
    // headroom rule: tilt up below the gate's stay threshold (+2%), until the cut threshold + 5%
    headroomTrigger: Math.max(0, policy.trackHeadroomPct / 100 - 0.02) + 0.02,
    headroomComfort: policy.trackHeadroomPct / 100 + 0.05,
  };
  for (const k of ['kp', 'kd', 'tau', 'innerRatio', 'coastMs', 'slewUp', 'slewDown'] as const) {
    const v = num(k);
    if (v !== undefined) s[k] = v;
  }
  return s;
}

export interface TrackSummary {
  reason: string;
  ms: number;
  ticks: number;
  hz: number;
  grabMs: number;
  detectMs: number;
  odoMs: number;
  lockedPct: number;
  starts: number;
  reversals: number;
  losses: number;
  maxExcursion: { x: number; y: number };
  scale: { pan: number; tilt: number };
  state: TrackingState | 'not-acquired';
  /** Preset recalls by the hard rules during the session. */
  recalls?: number;
  /** Ticks where the head/upper-body fallback ran, and its mean time (ms). */
  fallbackTicks?: number;
  fallbackMs?: number;
}

export function describeSummary(s: TrackSummary): string {
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  return (
    `${s.reason}; ${(s.ms / 1000).toFixed(1)} s, ${s.ticks} ticks at ${s.hz.toFixed(1)} Hz ` +
    `(grab ${s.grabMs.toFixed(0)} ms, detect ${s.detectMs.toFixed(0)} ms, motion ${s.odoMs.toFixed(0)} ms per tick), ` +
    `locked ${s.lockedPct.toFixed(0)}%, ${s.starts} moves, ${s.reversals} reversals, ${s.losses} losses, ` +
    `max excursion x ${pct(s.maxExcursion.x)} y ${pct(s.maxExcursion.y)}, speed scale pan ${s.scale.pan.toFixed(2)} tilt ${s.scale.tilt.toFixed(2)}` +
    (s.recalls ? `, ${s.recalls} preset recall(s) by the hard limits` : '') +
    (s.fallbackTicks ? `, head/body fallback on ${s.fallbackTicks} ticks (${(s.fallbackMs ?? 0).toFixed(0)} ms each)` : '')
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Axis = 'pan' | 'tilt';
const AXES: Axis[] = ['pan', 'tilt'];

class Session implements TrackSession {
  ready: Promise<RefineResult>;
  done: Promise<void>;
  moved = false;
  summary: TrackSummary | null = null;
  private stopped = false;
  private stopReason = '';
  private resolveReady!: (r: RefineResult) => void;
  private ctl: TrackController;
  private sent: TrackCommand = { pan: { dir: 0, level: 0 }, tilt: { dir: 0, level: 0 }, zoom: 0 };
  private watchdog: NodeJS.Timeout | null = null;
  private state: TrackingState = 'acquiring';
  private t0: number;
  private times = { grab: 0, detect: 0, odo: 0, n: 0, fb: 0, fbN: 0 };
  private heads: HeadDetector | null = null;
  private headsFailed = false;
  /** Pan/tilt reads are live (see "Stale positions" above). */
  private ptTrusted = false;
  /** First untrusted pan/tilt read after a start/recall. */
  private ptStale: { pan: number; tilt: number } | null = null;
  private staleLogged = false;
  private onAirFlag = false;
  private now: () => number;
  private prev: RgbaImage | null = null;
  // ---- hard limits in camera units
  private presetPos: PresetPosition | null;
  /** excursion limit in VISCA units (null: no calibration) */
  private units: { pan: number; tilt: number } | null = null;
  /** VISCA units per second per speed level (null: no calibration) */
  private unitRates: { pan: number[]; tilt: number[] } | null = null;
  /** camera position estimate: last idle read + dead reckoning */
  est: { pan: number; tilt: number } | null = null;
  private estAt = 0;
  private anchorPos: { pan: number; tilt: number } | null = null;
  private travel = { pan: 0, tilt: 0 };
  /** drive +1 changes the position by +posSign (learnt from reads if a camera is mirrored) */
  private posSign: Record<Axis, 1 | -1> = { pan: 1, tilt: 1 };
  private lastRead = -1e12;
  private lastMoveEnd = 0;
  private zoomCur: number | null = null;
  private lastZoomAt = -1e12;
  private zoomWarned = false;
  recalls = 0;
  private tightRecalled = false;
  private stillAt = 0;
  private faceSeen = false;
  private noFaceChecked = false;
  // ---- learned correction / sharpness
  private cal: Calibration | null;
  private strictThr: GateThresholds;
  private lastMovingAt = -1e12;
  private lastTickAt: number | null = null;
  private learnGoodMs = 0;
  private learnXs: number[] = [];
  private learnYs: number[] = [];
  /** Good-shot time with the delegate beyond trackLearnMaxOffsetPct (not sampled), and the largest offset seen there. */
  private learnOutMs = 0;
  private learnOutMax = { x: 0, y: 0 };
  /** Correction applied at the start of this turn. */
  applied: LearnedCorrection | null = null;
  private sharpVals: number[] = [];
  private blurSince: number | null = null;
  private blurLogs = 0;
  private blurReleased = false;

  constructor(
    private deps: TrackerDeps,
    private ctx: TrackContext,
  ) {
    this.now = deps.now ?? Date.now;
    this.t0 = this.now();
    const settings = trackSettings(ctx.room.policy, ctx.camera);
    this.ctl = new TrackController(settings);
    // before the cut (not on air) acquisition may move a little faster
    this.ctl.setMaxLevel(Math.min(12, (settings.maxLevel ?? 5) + 2));
    this.presetPos = presetPosition(ctx.camera.options, ctx.shot.preset);
    const cal = calibrationFromOptions(ctx.camera.options);
    this.cal = cal;
    this.strictThr = gateThresholds(ctx.room.policy, false);
    if (cal && this.presetPos) {
      this.units = excursionUnits(cal, this.presetPos.zoom, ctx.room.policy.trackMaxExcursionPct / 100);
      const c = coefficientsAt(cal, P100_RATES_ZOOM);
      // the rate table is image speed at P100_RATES_ZOOM; in camera units it does not depend on zoom.
      // 1.3x: overestimate the travel (conservative for the limit; idle reads correct it)
      const toUnits = (rates: number[], per: number) => rates.map((r) => (1.3 * r) / Math.max(Math.abs(per), 1e-6));
      this.unitRates = { pan: toUnits(this.ctl.s.ratesPan, c.dxPerPan), tilt: toUnits(this.ctl.s.ratesTilt, c.dyPerTilt) };
    }
    this.ready = new Promise((r) => (this.resolveReady = r));
    this.done = this.run().catch((e) => {
      const abort = (e as { name?: string })?.name === 'AbortError';
      if (!abort) this.ctx.log('warn', `${ctx.camera.name}: tracking failed: ${(e as Error).message}`);
      this.resolveReady({ adjusted: false, detail: abort ? 'tracking aborted' : `tracking failed: ${(e as Error).message}` });
      return this.finish(abort ? this.stopReason || 'aborted' : `error: ${(e as Error).message}`);
    });
  }

  private get ptz() {
    return this.ctx.driver.ptz!;
  }

  private get policy() {
    return this.ctx.room.policy;
  }

  private setState(s: TrackingState) {
    if (s === this.state) return;
    this.state = s;
    this.ctx.onState(s);
  }

  onAir() {
    if (this.onAirFlag) return;
    this.onAirFlag = true;
    this.ctl.setMaxLevel(this.policy.trackMaxSpeed);
  }

  /** Back off program (the gate cut to wide): framing may move a little faster again. */
  offAir() {
    if (!this.onAirFlag) return;
    this.onAirFlag = false;
    this.ctl.setMaxLevel(Math.min(12, this.policy.trackMaxSpeed + 2));
  }

  /**
   * Explicit stop: pan/tilt stop AND zoom stop, queued into the VISCA queue right
   * now, before anything else; each retried once if the camera did not answer.
   */
  private sendStop(): Promise<void> {
    this.integrate();
    this.sent = { pan: { dir: 0, level: 0 }, tilt: { dir: 0, level: 0 }, zoom: 0 };
    this.disarm();
    const p = this.ptz.drive({ pan: 0, tilt: 0 });
    const q = this.ptz.zoomDrive(0);
    return Promise.all([p.catch(() => this.ptz.drive({ pan: 0, tilt: 0 })), q.catch(() => this.ptz.zoomDrive(0))]).then(() => undefined);
  }

  stop(reason: string): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.stopReason = reason;
      // sent synchronously into the queue: nothing the loop does afterwards can overtake it
      const s = this.sendStop().catch(() => undefined);
      this.resolveReady({ adjusted: this.moved, detail: `stopped before framing (${reason})` });
      return Promise.all([s, this.done]).then(() => undefined);
    }
    return this.done;
  }

  private arm() {
    this.disarm();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.stopped) return;
      this.ctx.log('warn', `${this.ctx.camera.name}: tracking loop stalled for ${this.deps.watchdogMs ?? 600} ms, camera stopped`);
      this.ctl.halt(this.now());
      this.sendStop().catch(() => undefined);
    }, this.deps.watchdogMs ?? 600);
  }

  private disarm() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  // ------------------------------------------------------------ camera-unit limits

  /** Dead reckoning: add the travel of the command in force since estAt. */
  private integrate() {
    const t = this.now();
    if (this.est && this.unitRates) {
      const dt = Math.max(0, t - this.estAt) / 1000;
      for (const axis of AXES) {
        const c = this.sent[axis];
        if (!c.dir) continue;
        const rates = this.unitRates[axis];
        const d = this.posSign[axis] * c.dir * (rates[c.level] ?? rates[rates.length - 1]!) * dt;
        this.est[axis] += d;
        this.travel[axis] += d;
      }
    }
    this.estAt = t;
  }

  /** A trusted idle position: re-anchor the estimate (and learn the drive sign if a camera runs the other way). */
  private anchor(pos: { pan: number; tilt: number }) {
    if (this.anchorPos) {
      for (const axis of AXES) {
        const real = pos[axis] - this.anchorPos[axis];
        const exp = this.travel[axis];
        if (Math.abs(exp) > 8 && Math.abs(real) > 4 && Math.sign(real) !== Math.sign(exp)) {
          this.posSign[axis] = this.posSign[axis] === 1 ? -1 : 1;
          this.ctx.log('debug', `${this.ctx.camera.name}: tracking: ${axis} position runs opposite to the drive; corrected`);
        }
      }
    }
    this.anchorPos = { pan: pos.pan, tilt: pos.tilt };
    this.est = { pan: pos.pan, tilt: pos.tilt };
    this.estAt = this.now();
    this.travel = { pan: 0, tilt: 0 };
  }

  private anchorToPreset() {
    if (!this.presetPos) return;
    this.anchor(this.presetPos);
    this.zoomCur = this.presetPos.zoom;
  }

  /** Tell the controller which drive direction would take an axis past the limit (VISCA units). */
  private updateBlock() {
    this.integrate();
    if (!this.est || !this.units || !this.presetPos) {
      this.ctl.block = { pan: 0, tilt: 0 };
      return;
    }
    const block: { pan: -1 | 0 | 1; tilt: -1 | 0 | 1 } = { pan: 0, tilt: 0 };
    for (const axis of AXES) {
      const c = this.sent[axis];
      const rates = this.unitRates?.[axis] ?? [];
      // where it will be once a stop sent now has taken effect (~0.35 s)
      const ahead = c.dir ? this.posSign[axis] * c.dir * (rates[c.level] ?? 0) * 0.35 : 0;
      const off = this.est[axis] + ahead - this.presetPos[axis];
      const latched = this.ctl.block[axis];
      if (Math.abs(off) >= this.units[axis]) block[axis] = (Math.sign(off) * this.posSign[axis]) as -1 | 1;
      // hysteresis: stay blocked until the camera is back well inside the limit (no start/stop chatter at the edge)
      else if (latched && Math.abs(off) >= this.units[axis] * 0.8 && Math.sign(off) * this.posSign[axis] === latched) block[axis] = latched;
    }
    this.ctl.block = block;
  }

  private async readIdle(): Promise<PtzPosition | null> {
    this.lastRead = this.now();
    return idlePosition(this.ptz, { reads: 5, need: 2, gapMs: 20 }).catch(() => null);
  }

  /**
   * Read the idle position; recall the preset if it is far off (zoom beyond the
   * tolerance, pan/tilt beyond the excursion limit with a margin).
   * Returns true if the preset was recalled.
   */
  private async checkPosition(when: string): Promise<boolean> {
    const pp = this.presetPos;
    if (!pp) return false;
    const pos = await this.readIdle();
    if (this.stopped) return false;
    if (!pos) {
      this.ctx.log('debug', `${this.ctx.camera.name}: tracking: no agreeing position reads (${when})`);
      return false;
    }
    if ((pos.pan === pos.zoom && pos.zoom !== 0) || Math.abs(pos.tilt) > 3000) {
      this.ctx.log('debug', `${this.ctx.camera.name}: tracking: garbage position reply ${fmtPos(pos)} ignored (${when})`);
      return false;
    }
    const u = this.units ?? FALLBACK_UNITS;
    const lim = { zoomTolPct: this.policy.trackZoomTolerancePct, units: { pan: Math.round(u.pan * OFF_FACTOR), tilt: Math.round(u.tilt * OFF_FACTOR) } };
    const c = checkAgainstPreset(pos, pp, lim);
    if (!this.ptTrusted) {
      const changed = !!this.ptStale && (Math.abs(pos.pan - this.ptStale.pan) > 3 || Math.abs(pos.tilt - this.ptStale.tilt) > 3);
      if (c.ok || changed) this.ptTrusted = true;
      else {
        // pan/tilt may be the pre-recall position: keep the preset estimate; only a zoom far off recalls
        this.ptStale ??= { pan: pos.pan, tilt: pos.tilt };
        const z = checkAgainstPreset({ pan: pp.pan, tilt: pp.tilt, zoom: pos.zoom }, pp, lim);
        if (!z.ok) return this.recallPreset(`${when}: camera at ${fmtPos(pos)}, preset ${this.ctx.shot.preset} is at ${fmtPos(pp)} (${z.why})`);
        if (!this.staleLogged) {
          this.staleLogged = true;
          this.ctx.log(
            'info',
            `${this.ctx.camera.name}: tracking: pan/tilt read ${pos.pan}/${pos.tilt} is far from preset ${this.ctx.shot.preset} (${pp.pan}/${pp.tilt}) but the zoom is right: treated as a stale reply (the P100 reports the pre-recall position), no recall`,
          );
        }
        return false;
      }
    }
    this.anchor(pos);
    if (c.ok) return false;
    return this.recallPreset(`${when}: camera at ${fmtPos(pos)}, preset ${this.ctx.shot.preset} is at ${fmtPos(pp)} (${c.why})`);
  }

  /** Stop, recall the seat preset, wait for a still picture, start acquiring again. */
  private async recallPreset(why: string): Promise<boolean> {
    const preset = this.ctx.shot.preset;
    const name = this.ctx.camera.name;
    if (!preset || this.stopped) return false;
    if (this.recalls >= MAX_RECALLS) {
      this.ctx.log('warn', `${name}: tracking: ${why}; not recalling again (${MAX_RECALLS} recalls already)`);
      return false;
    }
    this.recalls++;
    this.ctx.log('warn', `${name}: tracking: ${why}; stop + recall preset ${preset}`);
    this.ctl.halt(this.now());
    // the camera is about to move: the shot is not usable until the target is acquired again
    this.ctl.reset();
    this.ctx.onShot?.(this.ctl.observe(this.now()));
    await this.sendStop();
    if (this.stopped) return false;
    await this.ctx.driver.recallPreset(preset);
    this.ctl.reset();
    this.moved = false;
    this.setState('acquiring');
    const grab = () => this.deps.frames.grab(this.ctx.camera.ndiSource);
    await waitVideoStill(grab, { minMs: this.deps.recallStillMinMs ?? 1800, maxMs: 6000, stable: 3, signal: this.ctx.signal });
    this.prev = null;
    this.anchorToPreset();
    this.ptTrusted = false;
    this.ptStale = null;
    this.stillAt = this.now();
    this.faceSeen = false;
    return true;
  }

  // ------------------------------------------------------------ learned correction

  private get seatKey(): string {
    return `${this.ctx.room.id}|${this.ctx.shot.unit ?? 'test'}`;
  }

  /** Learning applies to this turn: a mic turn on a calibrated seat preset with stored coordinates, zoom fixed. */
  private get learnOn(): boolean {
    const p = this.policy;
    return !!(p.trackLearn && !p.trackZoom && this.deps.learning && this.ctx.shot.unit !== null && this.ctx.shot.preset && this.presetPos && this.cal);
  }

  private learnedNow(): LearnedCorrection | null {
    if (!this.learnOn) return null;
    const { room, camera, shot } = this.ctx;
    const rec = this.deps.learning!.get(room.id, shot.unit!, camera.id, shot.preset!, this.presetPos);
    if (!rec) return null;
    return learnedCorrection(rec.samples, { cap: this.policy.trackLearnCapPct / 100, coef: coefficientsAt(this.cal!, this.presetPos!.zoom) });
  }

  /** After the recall + still picture: one move by the seat's learned correction. */
  private async applyLearned(grab: () => Promise<RgbaImage | null>): Promise<void> {
    const c = this.learnedNow();
    const pp = this.presetPos;
    if (!c || !pp || this.stopped) return;
    const name = this.ctx.camera.name;
    const seat = this.ctx.shot.unit;
    if (Math.abs(c.x) < 0.01 && Math.abs(c.y) < 0.01) {
      this.ctx.log('debug', `${name}: learned correction for seat ${seat}: ${describeCorrection(c)}; under 1%, not applied`);
      return;
    }
    this.ctx.log('info', `${name}: learned correction for seat ${seat}: ${describeCorrection(c)}; applied after the recall`);
    // pan relative; tilt (P100: relative tilt unusable) absolute to the STORED preset coordinates + correction
    this.moved = true;
    try {
      if (c.tilt) await this.ptz.moveAbsolute({ pan: pp.pan + c.pan, tilt: pp.tilt + c.tilt }, { pan: 0x18, tilt: 0x14 });
      else await this.ptz.moveRelative({ pan: c.pan, tilt: 0 }, { pan: 0x18, tilt: 0x14 });
    } catch (e) {
      // the move may or may not have happened: the start position check below finds out; track from the picture
      this.ctx.log('warn', `${name}: learned correction move failed: ${(e as Error).message}`);
      return;
    }
    this.applied = c;
    if (this.stopped) return;
    await waitVideoStill(grab, { minMs: 300, maxMs: 2500, stable: 3, signal: this.ctx.signal });
    this.prev = null;
    this.anchor({ pan: pp.pan + c.pan, tilt: pp.tilt + c.tilt });
    this.ctl.setPresetOffset(c.x, c.y);
    this.stillAt = this.now();
  }

  /** Per tick: sample the aim offset while the shot is good, the person seated and the camera still. */
  private learnTick(o: ShotObservation, dtMs: number) {
    if (!this.learnOn) return;
    const aim = this.ctl.aim();
    if (!aim) return;
    if (!judgeShot({ ...o, sharp: null }, this.strictThr).good) return;
    // far from the preset aim: probably not the seat's delegate; not sampled (a large offset alone is fine)
    const lim = this.policy.trackLearnMaxOffsetPct / 100;
    if (Math.abs(aim.x) > lim || Math.abs(aim.y) > lim) {
      this.learnOutMs += dtMs;
      if (Math.abs(aim.x) > Math.abs(this.learnOutMax.x)) this.learnOutMax.x = aim.x;
      if (Math.abs(aim.y) > Math.abs(this.learnOutMax.y)) this.learnOutMax.y = aim.y;
      return;
    }
    this.learnGoodMs += dtMs;
    const still = !this.ctl.moving && o.t - this.lastMovingAt >= LEARN_STILL_MS && Math.abs(aim.vx) < 0.05 && Math.abs(aim.vy) < 0.05;
    if (!still) return;
    this.learnXs.push(aim.x);
    this.learnYs.push(aim.y);
  }

  /** At the end of a turn: a good turn adds one sample (median aim offset) for the seat; otherwise one line says why not. */
  private recordLearning(reason: string) {
    const { room, camera, shot } = this.ctx;
    const p = this.policy;
    const name = camera.name;
    const notLearned = (why: string) => this.ctx.log('info', `${name}: seat ${shot.unit} turn not learned: ${why}`);
    if (!this.learnOn) {
      // learning wanted for this seat but impossible: say so (off / no seat: silent)
      if (p.trackLearn && this.deps.learning && shot.unit !== null) {
        notLearned(
          p.trackZoom
            ? 'tracking zoom is on'
            : !shot.preset || !this.presetPos
              ? `no stored coordinates for preset ${shot.preset ?? '-'}`
              : 'camera not calibrated',
        );
      }
      return;
    }
    const st = this.ctl.observe(this.now());
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
    const sgn = (v: number) => `${v >= 0 ? '+' : ''}${pct(v)}`;
    const maxSpread = p.trackLearnMaxSpreadPct / 100;
    const minGood = this.deps.learnMinGoodMs ?? LEARN_MIN_GOOD_MS;
    const n = this.learnXs.length;
    const spread = { x: iqr(this.learnXs), y: iqr(this.learnYs) };
    const outside = () =>
      this.learnOutMs > 0
        ? ` (${(this.learnOutMs / 1000).toFixed(1)} s with offset beyond the ${p.trackLearnMaxOffsetPct}% limit, up to x ${sgn(this.learnOutMax.x)} y ${sgn(this.learnOutMax.y)})`
        : '';
    const why = !LEARN_END_REASONS.has(reason)
      ? `ended: ${reason}`
      : this.recalls
        ? 'the preset was recalled during the turn'
        : !(st.state === 'locked' || (st.state === 'lost' && st.lostMs < 1000))
          ? `target ${st.state} at the end`
          : this.learnGoodMs < minGood
            ? `shot good for ${(this.learnGoodMs / 1000).toFixed(1)} s < ${minGood / 1000} s${outside()}`
            : n < LEARN_MIN_TICKS
              ? `only ${n} still, good frames < ${LEARN_MIN_TICKS}`
              : spread.x > maxSpread || spread.y > maxSpread
                ? `offset not steady: spread (IQR) x ${pct(spread.x)} y ${pct(spread.y)} > ${p.trackLearnMaxSpreadPct}% over ${n} frames (median x ${sgn(median(this.learnXs))} y ${sgn(median(this.learnYs))})`
                : null;
    if (why) {
      notLearned(why);
      return;
    }
    const learning = this.deps.learning!;
    const pp = this.presetPos!;
    const x = median(this.learnXs);
    const y = median(this.learnYs);
    const u = offsetToUnits(this.cal!, pp.zoom, x, y);
    const o = { cap: this.policy.trackLearnCapPct / 100, coef: coefficientsAt(this.cal!, pp.zoom) };
    const old = learning.get(room.id, shot.unit!, camera.id, shot.preset!, pp);
    const before = old ? learnedCorrection(old.samples, o) : null;
    const presetPos = { pan: pp.pan, tilt: pp.tilt, zoom: pp.zoom };
    const rec = learning.add(
      room.id,
      shot.unit!,
      camera.id,
      shot.preset!,
      presetPos,
      { pan: u.pan, tilt: u.tilt, x, y, ticks: this.learnXs.length, at: new Date().toISOString() },
      this.policy.trackLearnSamples,
    );
    const after = learnedCorrection(rec.samples, o);
    const sample = `turn sample ${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}% x, ${y >= 0 ? '+' : ''}${(y * 100).toFixed(1)}% y over ${n} frames, spread x ${pct(spread.x)} y ${pct(spread.y)}`;
    const changed = !before !== !after || (before && after && (Math.abs(before.x - after.x) >= 0.005 || Math.abs(before.y - after.y) >= 0.005));
    if (after && changed) this.ctx.log('info', `${name}: learned correction for seat ${shot.unit}: ${describeCorrection(after)} (${sample})`);
    else if (!after) this.ctx.log('info', `${name}: learned correction for seat ${shot.unit}: ${sample} stored (${rec.samples.length} of 2 needed)`);
    else this.ctx.log('debug', `${name}: learned correction for seat ${shot.unit}: unchanged, ${describeCorrection(after)} (${sample})`);
  }

  // ------------------------------------------------------------ sharpness

  /** Head-region sharpness for the gate (median of the last 3 matched ticks) and the seat's baseline. */
  private sharpTick(f: RgbaImage, o: ShotObservation): ShotObservation['sharp'] {
    const ratio = this.policy.trackBlurRatioPct / 100;
    if (!ratio) return null;
    if (o.state !== 'locked' || !o.box || o.source === 'person') {
      this.sharpVals = [];
      return null;
    }
    if (this.ctl.matchedThisTick) {
      const v = headSharpness(f, o.box);
      if (v !== null) {
        this.sharpVals.push(v);
        if (this.sharpVals.length > 3) this.sharpVals.shift();
      }
    }
    if (!this.sharpVals.length) return null;
    const value = median(this.sharpVals);
    const base = this.deps.sharpness!;
    const key = this.seatKey;
    const baseline = base.baseline(key);
    // the baseline only learns from good shots taken with the camera still (no motion blur by the camera)
    const still = !this.ctl.moving && o.t - this.lastMovingAt >= LEARN_STILL_MS;
    if (this.ctl.matchedThisTick && still && judgeShot({ ...o, sharp: null }, this.strictThr).good) base.add(key, this.sharpVals[this.sharpVals.length - 1]!);
    const sharp = { value, baseline: this.blurReleased ? null : baseline };
    const v = judgeShot({ ...o, sharp }, this.strictThr);
    const name = this.ctx.camera.name;
    if (v.reason.startsWith('head blurry')) {
      this.blurSince ??= o.t;
      if (!this.onAirFlag && this.blurLogs < 5 && o.t === this.blurSince) {
        this.blurLogs++;
        this.ctx.log('info', `${name}: shot gate: ${v.reason}; not cutting to the PTZ while the head is blurry`);
      }
      if (o.t - this.blurSince >= BLUR_RELEASE_MS) {
        this.blurReleased = true;
        this.ctx.log('info', `${name}: head region soft for ${BLUR_RELEASE_MS / 1000} s (${v.reason}); sharpness check released for this turn`);
        return { value, baseline: null };
      }
    } else this.blurSince = null;
    return sharp;
  }

  // ------------------------------------------------------------ commands

  private async apply(c: TrackCommand) {
    if (this.stopped) return;
    this.integrate();
    const s = this.sent;
    const pt = c.pan.dir !== s.pan.dir || c.pan.level !== s.pan.level || c.tilt.dir !== s.tilt.dir || c.tilt.level !== s.tilt.level;
    const wasMoving = !!(s.pan.dir || s.tilt.dir);
    // zoom is never a free-running drive here (see zoomStep)
    this.sent = { pan: c.pan, tilt: c.tilt, zoom: 0 };
    const jobs: Promise<void>[] = [];
    if (pt) {
      if (c.pan.dir || c.tilt.dir) this.moved = true;
      else if (wasMoving) this.lastMoveEnd = this.now();
      jobs.push(
        this.ptz.drive({ pan: c.pan.dir as JogDir, tilt: c.tilt.dir as JogDir }, { pan: Math.max(1, c.pan.level), tilt: Math.max(1, c.tilt.level) }),
      );
    }
    if (c.pan.dir || c.tilt.dir) this.arm();
    else this.disarm();
    await Promise.all(jobs);
  }

  /** Optional zoom (trackZoom): one small ABSOLUTE step at a time, always inside preset zoom +/- tolerance. */
  private async zoomStep(dir: number) {
    if (!dir || !this.policy.trackZoom || this.ctl.moving) return;
    const pp = this.presetPos;
    if (!pp || this.zoomCur === null) {
      if (!this.zoomWarned) {
        this.zoomWarned = true;
        this.ctx.log('info', `${this.ctx.camera.name}: tracking: zoom disabled (no stored zoom for preset ${this.ctx.shot.preset ?? '-'})`);
      }
      return;
    }
    if (this.now() - this.lastZoomAt < 1500) return;
    const step = Math.max(pp.zoom, 1000) * 0.04;
    const target = clampZoom(this.zoomCur + dir * step, pp.zoom, this.policy.trackZoomTolerancePct);
    if (target === this.zoomCur) return;
    this.lastZoomAt = this.now();
    this.zoomCur = target;
    this.moved = true;
    await this.ptz.zoomTo(target);
  }

  private async run(): Promise<void> {
    const { camera } = this.ctx;
    if (!camera.ndiSource) throw new Error(`${camera.name} has no NDI source configured`);
    const src = camera.ndiSource;
    const grab = () => this.deps.frames.grab(src);
    const detector = await this.deps.detector();
    if (this.policy.trackFallbackDetector && this.deps.heads) {
      this.heads = await this.deps.heads().catch((e) => {
        this.ctx.log('warn', `${camera.name}: head/body fallback detector unavailable: ${(e as Error).message}`);
        return null;
      });
    }
    const period = this.deps.periodMs ?? 100;
    const highScore = this.ctl.s.highScore;

    // the preset recall must be finished before anything is analysed
    const still = await waitVideoStill(grab, { minMs: 0, maxMs: 2500, stable: 3, signal: this.ctx.signal });
    if (this.stopped) return this.finish(this.stopReason);
    this.ctx.log('debug', `${camera.name}: tracking: picture ${still.still ? 'still' : 'not still'} after ${still.ms} ms`);
    this.stillAt = this.now();
    this.anchorToPreset();
    // learned per-seat correction: one move from the hand-saved preset (never stored back into it)
    await this.applyLearned(grab);
    if (this.stopped) return this.finish(this.stopReason);
    // hard rule: the camera must really be at the seat preset (a recall can be ignored, a camera moved by hand)
    await this.checkPosition('start');

    let framedAt: number | null = null;
    let lastTick = this.now();
    while (!this.stopped && !this.ctx.signal.aborted) {
      const tick = this.now();
      let t = tick;
      const f = await grab();
      this.times.grab += this.now() - t;
      if (this.stopped) break;
      if (!f) {
        this.ctl.halt(this.now());
        await this.apply(this.ctl.command());
        continue;
      }
      t = this.now();
      const small = downscale(f, ODO_W);
      const sh = this.prev ? phaseCorrelate(this.prev, small) : null;
      this.prev = small;
      this.times.odo += this.now() - t;
      t = this.now();
      const faces = await detector.detect(f, { scoreThreshold: 0.35 });
      this.times.detect += this.now() - t;
      this.times.n++;
      if (this.stopped) break;
      if (this.heads && !this.headsFailed && !this.ctl.hasSeatFace(faces, f.width, f.height)) {
        // YuNet has nothing usable in the seat (turned head, hand on the face, looking up): head from body keypoints
        t = this.now();
        try {
          faces.push(...(await this.heads.detect(f, { roi: this.ctl.seatRoi(f.width, f.height), maxPersons: 2 })));
        } catch (e) {
          this.headsFailed = true;
          this.ctx.log('warn', `${camera.name}: head/body fallback failed, YuNet only from now on: ${(e as Error).message}`);
        }
        this.times.fb += this.now() - t;
        this.times.fbN++;
        if (this.stopped) break;
      }
      if (faces.some((x) => x.score >= highScore)) this.faceSeen = true;
      this.updateBlock();
      const out = this.ctl.step({
        t: this.now(),
        width: f.width,
        height: f.height,
        faces,
        shift: sh ? { dx: sh.dx / small.width, dy: sh.dy / small.height, peak: sh.peak } : null,
      });
      await this.apply(out.cmd);
      this.setState(out.state);
      const tNow = this.now();
      if (this.sent.pan.dir || this.sent.tilt.dir || this.ctl.moving) this.lastMovingAt = tNow;
      const o = this.ctl.observe(tNow);
      o.sharp = this.sharpTick(f, o);
      this.ctx.onShot?.(o);
      this.learnTick(o, this.lastTickAt === null ? 0 : Math.min(300, tNow - this.lastTickAt));
      this.lastTickAt = tNow;
      let recall: string | null = null;
      for (const e of out.events) {
        if (e.kind === 'framed') {
          framedAt ??= this.now();
          this.resolveReady({ adjusted: this.moved, detail: `tracking: ${e.msg} after ${this.now() - this.t0} ms` });
          continue;
        }
        this.ctx.log(e.kind === 'limit' || e.kind === 'too-tight' ? 'warn' : 'info', `${camera.name}: tracking: ${e.msg}`);
        if (e.kind === 'return') recall = 'target not seen, back to the preset';
        if (e.kind === 'too-tight' && !this.tightRecalled) {
          this.tightRecalled = true;
          recall = 'face too big in the frame';
        }
      }
      if (recall && (await this.recallPreset(recall))) continue;
      if (out.state !== 'acquiring') await this.zoomStep(out.cmd.zoom);
      const now0 = this.now();
      const idle = !this.sent.pan.dir && !this.sent.tilt.dir;
      if (this.presetPos && idle && !this.stopped) {
        if (this.state === 'acquiring' && !this.faceSeen && !this.noFaceChecked && now0 - this.stillAt > (this.deps.noFaceCheckMs ?? 6000)) {
          // no face for a long time: is the camera where the preset is? (recall if not)
          this.noFaceChecked = true;
          if (await this.checkPosition('no face found')) continue;
        } else if (now0 - this.lastMoveEnd >= (this.deps.idleReadAfterMs ?? 700) && now0 - this.lastRead >= (this.deps.positionCheckMs ?? 2000)) {
          // re-anchor the position estimate; a zoom (or position) far off the preset means something else moved it
          if (await this.checkPosition('idle check')) continue;
        }
      }
      // pre-cut: not acquired within the timeout -> the controller's timeout cuts anyway
      const now = this.now();
      if (now - lastTick > 1000) this.ctx.log('debug', `${camera.name}: tracking tick took ${now - lastTick} ms`);
      lastTick = now;
      const wait = period - (now - tick);
      if (wait > 0) await sleep(wait);
    }
    return this.finish(this.stopReason || 'aborted');
  }

  private async finish(reason: string): Promise<void> {
    this.stopped = true;
    await this.sendStop().catch(() => undefined);
    try {
      this.recordLearning(reason);
    } catch (e) {
      this.ctx.log('warn', `${this.ctx.camera.name}: learned correction not recorded: ${(e as Error).message}`);
    }
    const st = this.ctl.stats;
    const ms = this.now() - this.t0;
    const n = Math.max(1, this.times.n);
    this.summary = {
      reason,
      ms,
      ticks: st.ticks,
      hz: st.ticks / Math.max(0.001, ms / 1000),
      grabMs: this.times.grab / n,
      detectMs: this.times.detect / n,
      odoMs: this.times.odo / n,
      lockedPct: (100 * st.lockedTicks) / Math.max(1, st.ticks),
      starts: st.starts,
      reversals: st.reversals,
      losses: st.losses,
      maxExcursion: st.maxExcursion,
      scale: st.scale,
      state: st.lockedTicks ? this.state : 'not-acquired',
      recalls: this.recalls,
      fallbackTicks: this.times.fbN,
      fallbackMs: this.times.fb / Math.max(1, this.times.fbN),
    };
    this.ctx.log('info', `${this.ctx.camera.name}: tracking ${this.ctx.shot.reason} ended: ${describeSummary(this.summary)}`);
  }
}

/** ShotTracker for policy.refine = 'track'. */
export function createTracker(deps: TrackerDeps): ShotTracker {
  const d = { ...deps, sharpness: deps.sharpness ?? new SharpnessBaselines() };
  return (ctx: TrackContext) => new Session(d, ctx);
}

export type { Session as TrackSessionImpl };
