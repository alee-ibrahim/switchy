/**
 * Per-room switching state machine.
 *
 * Mic on (two-camera room):  cut to wide -> recall seat preset on PTZ ->
 * wait settle -> cut to PTZ. A new speaker mid-move cancels and restarts.
 * Nobody on: back to the wide shot after policy.returnToWideMs.
 *
 * Track mode (with a wide camera to fall back on): after the settle the
 * tracking session starts and the SHOT GATE decides the program, per tick:
 * the PTZ only while its shot is good (held for trackHoldBeforeCutMs), back to
 * wide when the target is lost (trackLostToWideMs) or the shot is bad
 * (trackBadToWideMs), with trackMinDwellMs between gate cuts. No cut on a
 * timeout. Auto-frame mode cuts only if the verify picture passes the same
 * gate (else policy.autoFrameFallback).
 *
 * Pure logic + timers; all I/O goes through injected drivers/output so it can
 * be tested with recorded DCen sequences and fake timers.
 */
import { EventEmitter } from 'node:events';
import type { CameraDriver } from '../cameras/types.js';
import type { ProgramOutput } from '../output/program.js';
import type { DcenEvent } from '../dcen/parser.js';
import type { CameraConfig, RoomConfig, SeatConfig } from '../types.js';
import { selectSpeaker } from './policy.js';
import { calibrationFromOptions } from '../autoframe/calibration.js';
import { checkAgainstPreset, excursionUnits, FALLBACK_UNITS, fmtPos } from '../autoframe/limits.js';
import { idlePosition, presetPositions } from '../autoframe/presets.js';
import { gateThresholds, gateTiming, ProgramGate, type GateState, type ShotObservation } from '../autoframe/shot-gate.js';

export type ProgramTarget = { kind: 'camera'; cameraId: string } | { kind: 'holding' };

export interface Shot {
  cameraId: string;
  preset: string | null;
  reason: string;
  unit: number | null;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type RoomEvent =
  | { type: 'log'; level: LogLevel; msg: string; at: number }
  | { type: 'mics'; on: number[]; at: number }
  | { type: 'program'; target: ProgramTarget | null; source: string | null; at: number }
  | { type: 'preset'; cameraId: string; preset: string; ok: boolean; at: number }
  | { type: 'dcen'; connected: boolean; detail: string; at: number }
  | { type: 'learned'; unit: number; at: number }
  | { type: 'state'; at: number };

interface CamState {
  lastPreset: string | null;
  settledAt: number;
  error: string | null;
  /** Something (tracking, refine, jog) may have moved the camera since the last recall. */
  moved: boolean;
  /** The last preset recalled on this camera (kept when it moved away). */
  lastRecalled: string | null;
  /** Last manual control (jog, manual recall, preset save). */
  manualAt: number;
}

export interface RoomSnapshot {
  id: string;
  name: string;
  outputName: string;
  paused: boolean;
  dcenConnected: boolean;
  micsOn: number[];
  speaker: number | null;
  program: ProgramTarget | null;
  programSource: string | null;
  moving: { cameraId: string; preset: string | null; unit: number | null } | null;
  cameras: Record<string, { lastPreset: string | null; error: string | null }>;
  learning: boolean;
  tracking: TrackingSnapshot | null;
}

export interface RefineContext {
  room: RoomConfig;
  camera: CameraConfig;
  driver: CameraDriver;
  shot: Shot;
  /** Aborted on timeout or when a new speaker takes over. */
  signal: AbortSignal;
  /** Auto-frame: the gate result of each picture analysed (used if the refine times out). */
  onCheck?(g: RefineGate): void;
}

export interface RefineResult {
  /** True if the camera position was changed. */
  adjusted: boolean;
  detail?: string;
  /**
   * Shot gate on the verify picture (auto-frame). Absent: the refiner could not
   * look (not calibrated, no PTZ control...): the preset is cut as before.
   */
  gate?: RefineGate;
}

export interface RefineGate {
  /** The verify picture passes the shot gate. */
  good: boolean;
  /** At least a face was seen with headroom (autoFrameFallback 'preset-if-face'). */
  faceWithHeadroom: boolean;
  reason: string;
}

/**
 * Runs after the PTZ arrived at the seat preset and before the cut
 * (src/engine/autoframe/refiner.ts: face detection + one pan/tilt correction).
 * Must honour ctx.signal.
 */
export type ShotRefiner = (ctx: RefineContext) => Promise<RefineResult>;

export type TrackingState = 'acquiring' | 'locked' | 'lost' | 'holding';

export interface TrackingSnapshot {
  cameraId: string;
  unit: number | null;
  state: TrackingState;
  /** Started from the API test hook, not by a mic. */
  manual: boolean;
  since: number;
  /** Shot gate (track mode with a wide camera): what it thinks of the shot and where the program is. */
  gate?: { state: GateState; reason: string; onPtz: boolean } | null;
}

export interface TrackContext extends RefineContext {
  /** State changes (for the live view badge); not per frame. */
  onState(state: TrackingState): void;
  log(level: LogLevel, msg: string): void;
  /** Every tick: what the tracker sees (target box, lock, camera speed) for the shot gate. */
  onShot?(o: ShotObservation): void;
}

/** A running tracking session (src/engine/autoframe/tracker.ts). */
export interface TrackSession {
  /** Resolves once the target is acquired and roughly framed (the cut may happen). */
  ready: Promise<RefineResult>;
  /** The shot is on program now (ends the faster pre-cut acquisition). */
  onAir(): void;
  /** The shot left program again (gate cut to wide). */
  offAir?(): void;
  /** The camera was moved away from the preset. */
  readonly moved: boolean;
  /** Explicit stop (the stop command is queued before this returns); resolves when the loop has ended. */
  stop(reason: string): Promise<void>;
  /** Resolves when the session has ended (stopped or failed). */
  done: Promise<void>;
}

/** Starts active tracking (policy.refine = 'track') for a seat shot. */
export type ShotTracker = (ctx: TrackContext) => TrackSession;

export interface ControllerDeps {
  drivers: Map<string, CameraDriver>;
  output: ProgramOutput;
  refiner?: ShotRefiner;
  tracker?: ShotTracker;
  /** Called when a seat move starts and refine is on (e.g. open the PTZ's NDI receiver early). */
  refinePrepare?: (camera: CameraConfig) => void;
  now?: () => number;
}

/** Idle-PTZ sanity check: skipped this long after manual control (an operator may be aiming). */
export const SANITY_MANUAL_QUIET_MS = 120_000;

/** Max length of the DCen connect dump window if READY; never arrives. */
export const DUMP_WINDOW_MS = 5000;

const abortError = () => new DOMException('aborted', 'AbortError');
const isAbort = (e: unknown) => (e as { name?: string })?.name === 'AbortError';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    if (ms <= 0) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface TrackingEntry {
  session: TrackSession;
  ac: AbortController;
  info: TrackingSnapshot;
  /** Shot gate (null: no wide camera to fall back on, or the manual test). */
  gate: ProgramGate | null;
  shot: Shot;
  /** "not good yet" note after refineTimeoutMs. */
  noteTimer: NodeJS.Timeout | null;
}

export class RoomController extends EventEmitter<{ event: [RoomEvent] }> {
  private onList: number[] = [];
  private speaker: number | null = null;
  private program: ProgramTarget | null = null;
  private cams = new Map<string, CamState>();
  private paused = false;
  private dcenConnected = false;
  /** After a DCen disconnect the next all-off dump must re-establish the wide shot. */
  private resync = false;
  /**
   * True while the DCen connect status dump is running (from connect until READY;).
   * Only then is MIC-OFF;FFFF honoured as "all mics off": the DCen also emits
   * MIC-OFF;FFFF;FFFF; at random times while a mic is still on (seen in the test room:
   * unit 8 on 19:54:51, FFFF 19:55:15, MIC-OFF;0008 only 19:55:40).
   * Starts true so a controller fed a dump without a connect event (tests) behaves.
   */
  private inDump = true;
  private dumpTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private move: { ac: AbortController; shot: Shot } | null = null;
  private learners: Array<(unit: number) => void> = [];
  private tracking: TrackingEntry | null = null;
  /** Time of the last program change (the gate's minimum dwell). */
  private lastCutAt = -1e12;
  /** The last tracking session's explicit stop; a preset recall waits for it. */
  private trackStop: Promise<void> = Promise.resolve();
  private now: () => number;
  private sanityTimer: NodeJS.Timeout | null = null;
  private sanityRunning = false;
  /** Resolves when the current shot task finishes (tests). */
  idle: Promise<void> = Promise.resolve();

  constructor(
    private cfg: RoomConfig,
    private deps: ControllerDeps,
  ) {
    super();
    this.now = deps.now ?? Date.now;
    for (const c of cfg.cameras) this.cams.set(c.id, { lastPreset: null, settledAt: 0, error: null, moved: false, lastRecalled: null, manualAt: -1e12 });
  }

  get config(): RoomConfig {
    return this.cfg;
  }

  // ---------------------------------------------------------------- events

  private emitEv(e: RoomEvent) {
    this.emit('event', e);
  }

  log(level: LogLevel, msg: string) {
    this.emitEv({ type: 'log', level, msg, at: this.now() });
  }

  /** Feed a parsed DCen event. */
  handleDcen(ev: DcenEvent): void {
    switch (ev.type) {
      case 'mic-on':
        this.micOn(ev.unit);
        break;
      case 'mic-off':
        if (ev.unit !== 'all') this.micOff(ev.unit);
        else if (this.inDump) this.allOff();
        else
          this.log(
            'warn',
            `DCen sent "${ev.raw.trim()}" outside the connect dump; ignored (mics still on: [${this.onList.join(', ')}])`,
          );
        break;
      case 'ready':
        this.endDump();
        this.log('info', `DCen status dump complete; mics on: [${this.onList.join(', ')}]`);
        break;
      case 'unknown':
        this.log('debug', `DCen: unhandled line "${ev.raw}"`);
        break;
      default:
        break;
    }
  }

  private endDump() {
    this.inDump = false;
    if (this.dumpTimer) clearTimeout(this.dumpTimer);
    this.dumpTimer = null;
  }

  setDcenConnected(connected: boolean, detail: string) {
    this.dcenConnected = connected;
    // A new connection starts with a status dump. If READY; never arrives, close the window anyway.
    this.endDump();
    this.inDump = true;
    if (connected) this.dumpTimer = setTimeout(() => this.endDump(), DUMP_WINDOW_MS);
    this.emitEv({ type: 'dcen', connected, detail, at: this.now() });
    this.log(connected ? 'info' : 'warn', `DCen ${connected ? 'connected' : 'disconnected'}: ${detail}`);
    if (!connected) this.resync = true;
    if (!connected && this.onList.length) {
      // Mic state is unknown while offline. Forget it and keep the camera where it is;
      // after reconnect the dump (MIC-OFF;FFFF) resets us properly.
      this.onList = [];
      this.speaker = null;
      this.clearTimer();
      this.stopTracking('DCen disconnected');
      this.cancelMove('DCen disconnected');
      this.emitEv({ type: 'mics', on: [], at: this.now() });
    }
  }

  micOn(unit: number) {
    this.onList = this.onList.filter((u) => u !== unit);
    this.onList.push(unit);
    this.emitEv({ type: 'mics', on: [...this.onList], at: this.now() });
    const l = this.learners;
    this.learners = [];
    for (const fn of l) fn(unit);
    if (l.length) this.emitEv({ type: 'learned', unit, at: this.now() });
    this.recompute(`mic ${unit} on`);
  }

  micOff(unit: number) {
    if (!this.onList.includes(unit)) return;
    this.onList = this.onList.filter((u) => u !== unit);
    this.emitEv({ type: 'mics', on: [...this.onList], at: this.now() });
    this.recompute(`mic ${unit} off`);
  }

  allOff() {
    const had = this.onList.length > 0;
    this.onList = [];
    this.emitEv({ type: 'mics', on: [], at: this.now() });
    const force = this.program === null || this.resync;
    this.resync = false;
    if (had || this.speaker !== null || force) this.recompute(force ? 'state sync (all mics off)' : 'all mics off', force);
  }

  // ------------------------------------------------------------- decisions

  private recompute(why: string, force = false) {
    const next = selectSpeaker(this.onList, this.speaker, this.cfg.policy);
    if (next === this.speaker && !force) return;
    const prev = this.speaker;
    this.speaker = next;
    this.log('info', `speaker ${prev ?? 'none'} -> ${next ?? 'none'} (${why}); on=[${this.onList.join(', ')}]`);
    this.clearTimer();
    if (this.tracking && this.tracking.info.unit !== next) this.stopTracking('speaker changed');
    // a move towards someone who is no longer the speaker is pointless: cancel it
    if (this.move && this.move.shot.unit !== next) this.cancelMove('speaker changed');
    if (this.paused) return;
    if (next !== null) {
      this.timer = setTimeout(() => this.runSeat(next), this.cfg.policy.debounceMs);
    } else {
      this.timer = setTimeout(() => this.runWide('nobody speaking'), this.cfg.policy.returnToWideMs);
    }
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private camera(id: string): CameraConfig | undefined {
    return this.cfg.cameras.find((c) => c.id === id);
  }

  /** The room's wide shot: first 'wide' camera, else first 'both' camera. */
  wideShot(reason: string): Shot | null {
    const cam =
      this.cfg.cameras.find((c) => c.role === 'wide') ?? this.cfg.cameras.find((c) => c.role === 'both');
    if (!cam) return null;
    return { cameraId: cam.id, preset: cam.homePreset || null, reason, unit: null };
  }

  seatShot(unit: number): Shot | null {
    const seat = this.cfg.seats.find((s) => s.unit === unit);
    if (seat && this.camera(seat.cameraId)) {
      return { cameraId: seat.cameraId, preset: seat.preset || null, reason: `seat ${seat.label || unit}`, unit };
    }
    if (this.cfg.policy.unmappedSeat === 'ignore') return null;
    const w = this.wideShot(`unit ${unit} has no seat mapping`);
    return w ? { ...w, unit } : null;
  }

  private runSeat(unit: number) {
    this.timer = null;
    const shot = this.seatShot(unit);
    if (!shot) {
      this.log('warn', `mic ${unit}: no seat mapping, ignored`);
      return;
    }
    this.startShot(shot);
  }

  private runWide(reason: string) {
    this.timer = null;
    const shot = this.wideShot(reason);
    if (!shot) {
      this.log('warn', 'no wide camera configured');
      return;
    }
    this.startShot(shot);
  }

  /** Pick what to show while `movingId` moves: another wide-capable camera, the holding source, or nothing (live). */
  private pickCover(movingId: string): ProgramTarget | null {
    const other =
      this.cfg.cameras.find((c) => c.id !== movingId && c.role === 'wide') ??
      this.cfg.cameras.find((c) => c.id !== movingId && c.role === 'both');
    if (other) return { kind: 'camera', cameraId: other.id };
    if (this.cfg.policy.oneCameraMove === 'holding' && this.cfg.policy.holdingSource) return { kind: 'holding' };
    return null;
  }

  private cancelMove(why: string) {
    if (!this.move) return;
    this.log('debug', `cancel move to ${this.move.shot.reason}: ${why}`);
    this.move.ac.abort();
    this.move = null;
  }

  private startShot(shot: Shot) {
    this.stopTracking('new shot');
    this.cancelMove('new shot');
    const ac = new AbortController();
    const mv = { ac, shot };
    this.move = mv;
    this.idle = this.executeShot(shot, ac.signal)
      .catch((e) => {
        if (!isAbort(e)) this.log('error', `shot ${shot.reason} failed: ${(e as Error).message}`);
      })
      .finally(() => {
        if (this.move === mv) this.move = null;
        this.emitEv({ type: 'state', at: this.now() });
      });
  }

  private async executeShot(shot: Shot, signal: AbortSignal): Promise<void> {
    const cam = this.camera(shot.cameraId);
    if (!cam) throw new Error(`camera ${shot.cameraId} not found`);
    const st = this.cams.get(cam.id)!;
    const target: ProgramTarget = { kind: 'camera', cameraId: cam.id };
    // Hard rule: with tracking/auto-framing on a PTZ every speaker turn starts from the seat preset
    // (the camera may have been moved by tracking, a jog, a refine, or something outside Switchy).
    // The "same preset again" shortcut is only kept for plain presets on a camera nothing has moved.
    const framing = this.cfg.policy.refine !== 'off' && shot.unit !== null && !!this.deps.drivers.get(cam.id)?.ptz;
    const again = shot.preset !== null && st.lastPreset === shot.preset && (st.moved || framing);
    const needsMove = shot.preset !== null && (st.lastPreset !== shot.preset || again);
    const stillSettling = !needsMove && st.settledAt > this.now();

    const tracking = this.cfg.policy.refine === 'track' && shot.unit !== null && !!this.deps.tracker;
    // the gate needs somewhere to go while the shot is not good
    const gated = tracking && !!this.pickCover(cam.id) && !!this.deps.drivers.get(cam.id)?.ptz;
    if (!needsMove && !stillSettling) {
      // already on the preset (e.g. the same seat again): tracking still starts
      if (gated) return this.startGated(cam, shot);
      if (tracking) await this.track(cam, shot, signal);
      if (signal.aborted) throw abortError();
      this.cut(target, shot.reason);
      if (tracking && this.tracking?.info.cameraId === cam.id) this.tracking.session.onAir();
      return;
    }

    // Don't show the move: cover with the wide camera (or holding source).
    if (this.program === null || this.isProgram(target)) {
      const cover = this.pickCover(cam.id);
      if (cover) this.cut(cover, `cover while ${cam.name} moves`);
    }

    if (needsMove) {
      const driver = this.deps.drivers.get(cam.id);
      if (this.cfg.policy.refine !== 'off' && shot.unit !== null && (this.deps.refiner || this.deps.tracker)) {
        try {
          this.deps.refinePrepare?.(cam);
        } catch {
          /* best effort */
        }
      }
      st.lastPreset = shot.preset;
      st.moved = false;
      st.lastRecalled = shot.preset;
      st.settledAt = this.now() + cam.settleMs;
      try {
        // a tracking drive must be stopped before the recall goes out
        await this.trackStop;
        if (signal.aborted) throw abortError();
        await driver?.recallPreset(shot.preset!);
        st.error = null;
        this.emitEv({ type: 'preset', cameraId: cam.id, preset: shot.preset!, ok: true, at: this.now() });
        this.log(
          'info',
          `${cam.name}: recall preset ${shot.preset} (${shot.reason}${again ? `; again: ${framing ? `${this.cfg.policy.refine} mode` : 'the camera moved since'}` : ''})`,
        );
      } catch (e) {
        st.lastPreset = null;
        st.settledAt = 0;
        st.error = (e as Error).message;
        this.emitEv({ type: 'preset', cameraId: cam.id, preset: shot.preset!, ok: false, at: this.now() });
        this.log('error', `${cam.name}: recall preset ${shot.preset} failed: ${st.error}`);
        // stay on the cover shot; never cut to a camera that may be pointing elsewhere
        return;
      }
    }
    if (signal.aborted) throw abortError();

    const driver = this.deps.drivers.get(cam.id);
    const remaining = Math.max(0, st.settledAt - this.now());
    if (needsMove && driver?.waitSettled) {
      await driver.waitSettled(signal, Math.max(remaining, cam.settleMs));
    } else {
      await sleep(remaining, signal);
    }
    if (signal.aborted) throw abortError();
    st.settledAt = 0;
    if (gated) return this.startGated(cam, shot);
    if (tracking) {
      await this.track(cam, shot, signal);
      if (signal.aborted) throw abortError();
      this.cut(target, shot.reason);
      if (this.tracking?.info.cameraId === cam.id) this.tracking.session.onAir();
      return;
    }
    if (needsMove && !(await this.refine(cam, shot, signal))) {
      if (signal.aborted) throw abortError();
      return; // the shot gate said no: stay on the wide/cover shot for this turn
    }
    if (signal.aborted) throw abortError();
    this.cut(target, shot.reason);
  }

  /**
   * Track mode with a wide camera: start tracking and let the shot gate drive
   * the program (no cut here; the program stays on the cover shot until the
   * shot is good).
   */
  private startGated(cam: CameraConfig, shot: Shot): void {
    const driver = this.deps.drivers.get(cam.id)!;
    const p = this.cfg.policy;
    this.beginTracking(cam, driver, shot, false, true);
    const entry = this.tracking;
    if (!entry?.gate) return;
    // a note (not a cut) when the shot never became good within the old timeout
    entry.noteTimer = setTimeout(() => {
      entry.noteTimer = null;
      if (this.tracking !== entry || entry.gate!.onPtz) return;
      this.log('info', `${cam.name}: shot not good after ${p.refineTimeoutMs} ms (${entry.gate!.verdict.reason}); program stays on wide until it is`);
    }, p.refineTimeoutMs);
  }

  /** A tracking tick: feed the shot gate and cut if it says so. */
  private onShot(entry: TrackingEntry, o: ShotObservation) {
    const gate = entry.gate;
    if (!gate || this.tracking !== entry || this.paused) return;
    const before = `${gate.state}|${gate.onPtz}`;
    const act = gate.update(o);
    const publish = () => {
      entry.info = { ...entry.info, gate: { state: gate.state, reason: gate.verdict.reason, onPtz: gate.onPtz } };
      this.emitEv({ type: 'state', at: this.now() });
    };
    if (!act) {
      if (`${gate.state}|${gate.onPtz}` !== before) publish();
      return;
    }
    // only for the current speaker, and never while a move is running
    if (this.move || this.speaker !== entry.info.unit) return;
    const cam = this.camera(entry.info.cameraId);
    if (!cam) return;
    if (act.to === 'ptz') {
      this.cut({ kind: 'camera', cameraId: cam.id }, `${entry.shot.reason}; ${act.reason}`);
      entry.session.onAir();
    } else {
      const cover = this.pickCover(cam.id);
      if (!cover) return;
      this.cut(cover, act.reason);
      entry.session.offAir?.();
    }
    publish();
  }

  /** Start tracking; wait until the target is roughly framed (or refineTimeoutMs) so the caller can cut. Tracking keeps running. */
  private async track(cam: CameraConfig, shot: Shot, signal: AbortSignal): Promise<void> {
    const p = this.cfg.policy;
    const driver = this.deps.drivers.get(cam.id);
    if (!this.deps.tracker || !driver || shot.unit === null) return;
    if (!driver.ptz) {
      this.log('debug', `${cam.name}: tracking skipped (driver has no fine PTZ control)`);
      return;
    }
    const session = this.beginTracking(cam, driver, shot, false);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<'timeout'>((res) => {
      timer = setTimeout(() => res('timeout'), p.refineTimeoutMs);
    });
    const aborted = new Promise<'aborted'>((res) => {
      onAbort = () => res('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const r = await Promise.race([session.ready, timeout, aborted]);
      if (r === 'aborted') return;
      if (r === 'timeout') {
        const st = this.tracking?.session === session ? this.tracking.info.state : 'ended';
        this.log('info', `${cam.name}: tracking not framed after ${p.refineTimeoutMs} ms (${st}); cutting anyway`);
      } else this.log('info', `${cam.name}: ${r.detail ?? 'tracking: framed'}`);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private beginTracking(cam: CameraConfig, driver: CameraDriver, shot: Shot, manual: boolean, gated = false): TrackSession {
    this.stopTracking('new tracking session');
    const ac = new AbortController();
    const p = this.cfg.policy;
    const gate = gated
      ? new ProgramGate(gateTiming(p), gateThresholds(p, false), gateThresholds(p, true), this.lastCutAt)
      : null;
    if (gate) gate.onPtz = this.isProgram({ kind: 'camera', cameraId: cam.id });
    const info: TrackingSnapshot = {
      cameraId: cam.id,
      unit: shot.unit,
      state: 'acquiring',
      manual,
      since: this.now(),
      gate: gate ? { state: gate.state, reason: gate.verdict.reason, onPtz: gate.onPtz } : null,
    };
    const entry: TrackingEntry = { session: null as unknown as TrackSession, ac, info, gate, shot, noteTimer: null };
    this.tracking = entry;
    this.log('info', `${cam.name}: tracking ${shot.reason} started${manual ? ' (test)' : ''}`);
    entry.session = this.deps.tracker!({
      room: this.cfg,
      camera: cam,
      driver,
      shot,
      signal: ac.signal,
      onState: (state) => {
        if (this.tracking !== entry) return;
        entry.info = { ...entry.info, state, since: this.now() };
        this.emitEv({ type: 'state', at: this.now() });
      },
      log: (level, msg) => this.log(level, msg),
      onShot: gate ? (o) => this.onShot(entry, o) : undefined,
    });
    this.emitEv({ type: 'state', at: this.now() });
    // a session that ends by itself (error) releases the slot
    void entry.session.done.then(() => {
      if (this.tracking !== entry) return;
      this.stopTracking('ended');
      // gate: the PTZ is only on program while it is tracked
      const cover = entry.gate?.onPtz && !this.paused && this.speaker === entry.info.unit ? this.pickCover(cam.id) : null;
      if (cover) this.cut(cover, 'tracking ended');
    });
    return entry.session;
  }

  /** Stop tracking (explicit camera stop). The next preset recall waits for the stop to be sent. */
  stopTracking(why: string) {
    const t = this.tracking;
    if (!t) return;
    this.tracking = null;
    if (t.noteTimer) clearTimeout(t.noteTimer);
    const stop = t.session.stop(why);
    t.ac.abort();
    this.trackStop = stop.catch(() => undefined);
    // the camera may no longer be exactly on its preset: the next shot must recall it again
    const st = this.cams.get(t.info.cameraId);
    if (st) st.moved = true;
    if (st && t.session.moved) st.lastPreset = null;
    this.emitEv({ type: 'state', at: this.now() });
  }

  /**
   * Test hook: track on the camera's current shot for durationMs, only while
   * it is not on program, no mic is on and automation is running. Any mic,
   * manual control or pause stops it. Resolves when it ends.
   */
  async startManualTracking(cameraId: string, durationMs: number): Promise<void> {
    const cam = this.camera(cameraId);
    if (!cam) throw new Error('unknown camera');
    const driver = this.deps.drivers.get(cam.id);
    if (!this.deps.tracker) throw new Error('tracking not available');
    if (!driver?.ptz) throw new Error(`${cam.name} has no pan/tilt control`);
    if (this.paused) throw new Error('automation is paused: tracking never runs while paused');
    if (this.onList.length) throw new Error(`mic ${this.onList.join(', ')} on: test only while the room is quiet`);
    if (this.move) throw new Error('a camera move is running');
    if (this.program?.kind === 'camera' && this.program.cameraId === cam.id) throw new Error(`${cam.name} is on program`);
    const preset = this.cams.get(cam.id)?.lastPreset ?? null;
    const session = this.beginTracking(cam, driver, { cameraId: cam.id, preset, reason: 'test', unit: null }, true);
    const t0 = this.now();
    void session.ready.then((r) => {
      if (r.detail?.startsWith('tracking:')) this.log('info', `${cam.name}: ${r.detail} (test, ${this.now() - t0} ms after start)`);
    });
    const timer = setTimeout(() => {
      if (this.tracking?.session === session) this.stopTracking('test duration over');
    }, durationMs);
    await session.done;
    clearTimeout(timer);
  }

  /**
   * The verify picture failed the shot gate (or there was none): cut anyway?
   * policy.autoFrameFallback: 'preset' yes; 'preset-if-face' only if a face was
   * seen with headroom; 'wide' no.
   */
  private refineFallback(cam: CameraConfig, g: RefineGate | null, why: string): boolean {
    const mode = this.cfg.policy.autoFrameFallback;
    const cut = mode === 'preset' || (mode === 'preset-if-face' && !!g?.faceWithHeadroom);
    const what = g ? g.reason : 'no picture analysed';
    this.log(
      'info',
      cut
        ? `${cam.name}: ${why} (${what}); showing the preset shot (fallback ${mode})`
        : `${cam.name}: ${why} (${what}); program stays on wide (fallback ${mode})`,
    );
    return cut;
  }

  /**
   * Optional refine step (auto-framing). Never delays the cut longer than
   * refineTimeoutMs. Resolves true if the PTZ may be cut to (shot gate on the
   * verify picture, else policy.autoFrameFallback).
   */
  private async refine(cam: CameraConfig, shot: Shot, signal: AbortSignal): Promise<boolean> {
    const p = this.cfg.policy;
    const refiner = this.deps.refiner;
    const driver = this.deps.drivers.get(cam.id);
    if (p.refine === 'off' || !refiner || !driver || shot.unit === null) return true;
    if (!driver.ptz) {
      this.log('debug', `${cam.name}: refine skipped (driver has no fine PTZ control)`);
      return true;
    }
    let last: RefineGate | null = null;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((res) => {
      timer = setTimeout(() => res('timeout'), p.refineTimeoutMs);
    });
    try {
      const r = await Promise.race([
        refiner({ room: this.cfg, camera: cam, driver, shot, signal: ac.signal, onCheck: (g) => (last = g) }),
        timeout,
      ]);
      if (r === 'timeout') {
        ac.abort();
        if (last && (last as RefineGate).good) {
          this.log('info', `${cam.name}: refine timed out after ${p.refineTimeoutMs} ms; last picture passed the shot gate (${(last as RefineGate).reason})`);
          return true;
        }
        return this.refineFallback(cam, last, `refine timed out after ${p.refineTimeoutMs} ms`);
      }
      this.log('info', `${cam.name}: refine ${r.adjusted ? 'adjusted framing' : 'kept preset framing'}${r.detail ? ` (${r.detail})` : ''}`);
      const st = this.cams.get(cam.id);
      if (r.adjusted && st) st.moved = true;
      if (r.adjusted && p.refineSavePreset && shot.preset && !signal.aborted) {
        await driver.ptz.savePreset(shot.preset);
        if (st) st.moved = false;
        this.log('info', `${cam.name}: saved refined position as preset ${shot.preset}`);
      }
      if (!r.gate) return true;
      if (r.gate.good) {
        this.log('info', `${cam.name}: shot gate passed (${r.gate.reason})`);
        return true;
      }
      return this.refineFallback(cam, r.gate, 'verify picture failed the shot gate');
    } catch (e) {
      if (signal.aborted) throw abortError();
      this.log('warn', `${cam.name}: refine failed: ${(e as Error).message}`);
      return this.refineFallback(cam, last, 'refine failed');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private isProgram(t: ProgramTarget): boolean {
    const p = this.program;
    if (!p) return false;
    if (p.kind === 'holding' || t.kind === 'holding') return p.kind === t.kind;
    return p.cameraId === t.cameraId;
  }

  private sourceFor(t: ProgramTarget): string | null {
    if (t.kind === 'holding') return this.cfg.policy.holdingSource || null;
    return this.camera(t.cameraId)?.ndiSource || null;
  }

  private cut(t: ProgramTarget, reason: string) {
    if (this.isProgram(t)) return;
    const source = this.sourceFor(t);
    const label = t.kind === 'holding' ? 'holding source' : (this.camera(t.cameraId)?.name ?? t.cameraId);
    this.program = t;
    this.lastCutAt = this.now();
    // keep the shot gate's idea of the program (and its dwell clock) in step with every cut
    const tr = this.tracking;
    if (tr?.gate) {
      tr.gate.switched(t.kind === 'camera' && t.cameraId === tr.info.cameraId, this.lastCutAt);
      tr.info = { ...tr.info, gate: { state: tr.gate.state, reason: tr.gate.verdict.reason, onPtz: tr.gate.onPtz } };
    }
    if (!source) {
      this.log('warn', `program -> ${label} (${reason}) but it has no NDI source name configured`);
    } else {
      const r = this.deps.output.show(source);
      if (!r.ok) this.log('warn', `program -> ${label} "${source}" (${reason}): routing failed: ${r.error ?? 'unknown'}`);
      else
        this.log(
          'info',
          `program -> ${label} "${source}" (${reason})${r.unresolved ? ' [source not discovered yet, routed by name]' : ''}`,
        );
    }
    this.emitEv({ type: 'program', target: t, source, at: this.now() });
  }

  // ---------------------------------------------------------------- manual

  setPaused(paused: boolean) {
    if (this.paused === paused) return;
    this.paused = paused;
    this.log('info', paused ? 'automation paused' : 'automation resumed');
    this.clearTimer();
    if (paused) {
      this.stopTracking('paused');
      this.cancelMove('paused');
    } else {
      // act on the current state right away
      const s = this.speaker;
      if (s !== null) this.timer = setTimeout(() => this.runSeat(s), this.cfg.policy.debounceMs);
      else this.timer = setTimeout(() => this.runWide('nobody speaking'), this.cfg.policy.returnToWideMs);
    }
    this.emitEv({ type: 'state', at: this.now() });
  }

  /** Put a camera on program right now (automation will take over again on the next mic change unless paused). */
  takeCamera(cameraId: string) {
    if (!this.camera(cameraId)) throw new Error('unknown camera');
    this.stopTracking('manual take');
    this.cancelMove('manual take');
    this.clearTimer();
    this.cut({ kind: 'camera', cameraId }, 'manual');
  }

  takeHolding() {
    if (!this.cfg.policy.holdingSource) throw new Error('no holding source configured');
    this.stopTracking('manual take');
    this.cancelMove('manual take');
    this.clearTimer();
    this.cut({ kind: 'holding' }, 'manual');
  }

  /** Recall a preset live (manual). Always sends, even if it was the last preset. */
  async recallPreset(cameraId: string, preset: string) {
    const cam = this.camera(cameraId);
    if (!cam) throw new Error('unknown camera');
    this.stopTracking('manual recall');
    this.cancelMove('manual recall');
    const st = this.cams.get(cam.id)!;
    const driver = this.deps.drivers.get(cam.id);
    try {
      await this.trackStop;
      await driver?.recallPreset(preset);
      st.lastPreset = preset;
      st.moved = false;
      st.lastRecalled = preset;
      st.manualAt = this.now();
      st.settledAt = this.now() + cam.settleMs;
      st.error = null;
      this.emitEv({ type: 'preset', cameraId: cam.id, preset, ok: true, at: this.now() });
      this.log('info', `${cam.name}: recall preset ${preset} (manual)`);
    } catch (e) {
      st.error = (e as Error).message;
      st.lastPreset = null;
      this.emitEv({ type: 'preset', cameraId: cam.id, preset, ok: false, at: this.now() });
      this.log('error', `${cam.name}: manual recall ${preset} failed: ${st.error}`);
      throw e;
    }
  }

  /** Resolve with the next unit whose mic goes on (null on timeout). */
  learnNext(timeoutMs = 30000): Promise<number | null> {
    return new Promise((resolve) => {
      const fn = (u: number) => {
        clearTimeout(t);
        resolve(u);
      };
      const t = setTimeout(() => {
        this.learners = this.learners.filter((x) => x !== fn);
        this.emitEv({ type: 'state', at: this.now() });
        resolve(null);
      }, timeoutMs);
      this.learners.push(fn);
      this.emitEv({ type: 'state', at: this.now() });
    });
  }

  /** Replace the seat map without restarting the room (keeps DCen connection, pause and program). */
  updateSeats(seats: SeatConfig[]) {
    this.cfg = { ...this.cfg, seats };
    this.emitEv({ type: 'state', at: this.now() });
  }

  /** Replace camera configs in place (same ids; e.g. updated options). Drivers are not recreated. */
  updateCameras(cameras: CameraConfig[]) {
    this.cfg = { ...this.cfg, cameras };
  }

  /**
   * The camera was moved by hand (jog) or a preset was just stored there. The
   * controller must not assume it still sits on its last recalled preset, or it
   * would skip the next recall of that preset.
   */
  cameraMovedManually(cameraId: string, nowAtPreset: string | null = null) {
    const st = this.cams.get(cameraId);
    if (!st) return;
    if (this.tracking?.info.cameraId === cameraId) this.stopTracking('manual control');
    st.lastPreset = nowAtPreset;
    st.moved = nowAtPreset === null;
    if (nowAtPreset) st.lastRecalled = nowAtPreset;
    st.manualAt = this.now();
    st.settledAt = 0;
    this.emitEv({ type: 'state', at: this.now() });
  }

  snapshot(): RoomSnapshot {
    const cameras: RoomSnapshot['cameras'] = {};
    for (const [id, s] of this.cams) cameras[id] = { lastPreset: s.lastPreset, error: s.error };
    return {
      id: this.cfg.id,
      name: this.cfg.name,
      outputName: this.cfg.outputName,
      paused: this.paused,
      dcenConnected: this.dcenConnected,
      micsOn: [...this.onList],
      speaker: this.speaker,
      program: this.program,
      programSource: this.program ? this.sourceFor(this.program) : null,
      moving: this.move
        ? { cameraId: this.move.shot.cameraId, preset: this.move.shot.preset, unit: this.move.shot.unit }
        : null,
      cameras,
      learning: this.learners.length > 0,
      tracking: this.tracking ? { ...this.tracking.info } : null,
    };
  }

  // ---------------------------------------------------------------- safety

  /**
   * Start-up safety: an explicit pan/tilt + zoom stop to every PTZ (a drive or
   * jog left running by a crash or a killed process is ended before anything
   * else is sent), then the periodic idle sanity check (intervalMs, 0 = off).
   */
  startSafety(intervalMs: number, firstCheckMs = 5000) {
    const stops: Promise<unknown>[] = [];
    for (const cam of this.cfg.cameras) {
      const ptz = this.deps.drivers.get(cam.id)?.ptz;
      if (!ptz) continue;
      stops.push(ptz.stop().catch((e) => this.log('warn', `${cam.name}: start-up stop failed: ${(e as Error).message}`)));
    }
    if (stops.length) this.log('info', `sent pan/tilt/zoom stop to ${stops.length} PTZ camera(s) at start-up`);
    // the first preset recall waits for these stops
    const prev = this.trackStop;
    this.trackStop = Promise.all([prev, ...stops]).then(() => undefined);
    if (intervalMs > 0) {
      const tick = () => {
        void this.sanityCheck().catch((e) => this.log('debug', `idle sanity check failed: ${(e as Error).message}`));
        this.sanityTimer = setTimeout(tick, intervalMs);
      };
      this.sanityTimer = setTimeout(tick, firstCheckMs);
    }
  }

  /** Why the idle sanity check must leave a camera alone right now (null = it may check it). */
  private sanityBusy(cameraId: string): string | null {
    if (this.paused) return 'automation paused';
    if (this.move) return 'a move is running';
    if (this.timer) return 'a shot is about to start';
    if (this.tracking?.info.cameraId === cameraId) return 'tracking';
    if (this.program?.kind === 'camera' && this.program.cameraId === cameraId) return 'on program';
    if (this.learners.length) return 'learning';
    const st = this.cams.get(cameraId);
    if (st && this.now() - st.manualAt < SANITY_MANUAL_QUIET_MS) return 'manual control';
    return null;
  }

  /**
   * Idle PTZ sanity check (hard rule): while a PTZ with stored preset positions
   * is idle and not on program, read its position (two agreeing idle reads half
   * a second apart, so it is still). If it is far from every state it may
   * legitimately be in (its last preset, or any stored preset within the
   * excursion/zoom limits), stop it and recall its last preset.
   */
  async sanityCheck(): Promise<void> {
    if (this.sanityRunning) return;
    this.sanityRunning = true;
    try {
      const p = this.cfg.policy;
      for (const cam of this.cfg.cameras) {
        const driver = this.deps.drivers.get(cam.id);
        const ptz = driver?.ptz;
        const stored = presetPositions(cam.options);
        if (!driver || !ptz || !Object.keys(stored).length) continue;
        if (this.sanityBusy(cam.id)) continue;
        const a = await idlePosition(ptz, { reads: 6, need: 2, gapMs: 30 }).catch(() => null);
        if (!a) continue;
        await new Promise((r) => setTimeout(r, 500));
        const b = await idlePosition(ptz, { reads: 6, need: 2, gapMs: 30 }).catch(() => null);
        if (!b || a.pan !== b.pan || a.tilt !== b.tilt || a.zoom !== b.zoom) continue; // moving or unreadable
        if (this.sanityBusy(cam.id)) continue;
        const st = this.cams.get(cam.id)!;
        const cal = calibrationFromOptions(cam.options);
        const exc = (p.trackMaxExcursionPct / 100) * 1.3;
        const expected = st.lastPreset && !st.moved && stored[st.lastPreset] ? [st.lastPreset] : Object.keys(stored);
        const ok = expected.some((k) => {
          const sp = stored[k]!;
          const units = cal ? excursionUnits(cal, sp.zoom, exc) : FALLBACK_UNITS;
          return checkAgainstPreset(b, sp, { zoomTolPct: p.trackZoomTolerancePct, units }).ok;
        });
        if (ok) continue;
        const preset =
          st.lastRecalled ?? this.cfg.seats.find((s) => s.cameraId === cam.id && s.preset)?.preset ?? cam.homePreset ?? null;
        if (!preset) continue;
        this.log(
          'warn',
          `${cam.name}: idle at ${fmtPos(b)}, far from ${expected.length === 1 ? `preset ${expected[0]}` : 'every stored preset'}; stop + recall preset ${preset}`,
        );
        await ptz.stop().catch(() => undefined);
        if (this.sanityBusy(cam.id)) continue;
        try {
          await driver.recallPreset(preset);
          st.lastPreset = preset;
          st.lastRecalled = preset;
          st.moved = false;
          st.settledAt = this.now() + cam.settleMs;
          this.emitEv({ type: 'preset', cameraId: cam.id, preset, ok: true, at: this.now() });
        } catch (e) {
          st.lastPreset = null;
          this.log('error', `${cam.name}: sanity recall ${preset} failed: ${(e as Error).message}`);
        }
      }
    } finally {
      this.sanityRunning = false;
    }
  }

  /** Stop everything; resolves once the explicit camera stops were sent (or failed). */
  dispose(): Promise<void> {
    this.endDump();
    this.clearTimer();
    if (this.sanityTimer) clearTimeout(this.sanityTimer);
    this.sanityTimer = null;
    const tracked = this.tracking?.info.cameraId ?? null;
    this.stopTracking('room stopped');
    this.cancelMove('dispose');
    this.learners = [];
    // every exit path ends with an explicit stop on every PTZ (no drive or jog may outlive the room)
    const stops: Promise<unknown>[] = [this.trackStop];
    for (const cam of this.cfg.cameras) {
      const ptz = this.deps.drivers.get(cam.id)?.ptz;
      if (ptz && cam.id !== tracked) stops.push(ptz.stop().catch(() => undefined));
    }
    return Promise.all(stops).then(() => undefined);
  }
}
