/**
 * Active tracking controller (pure, no I/O): keeps the locked delegate framed
 * with slow VISCA pan/tilt velocity drive, like a calm human operator.
 *
 * Per tick it gets the detected faces and the measured scene shift since the
 * previous frame (phase correlation, "ego-motion"), and returns the drive
 * command (direction + VISCA speed level per axis).
 *
 *  - Target state: constant-velocity Kalman filters on the target's eye point
 *    and face height, in "world" coordinates (image position minus the
 *    accumulated scene shift S), so camera motion is not mistaken for the
 *    person moving.
 *  - Identity lock: ByteTrack-style association. High-confidence detections
 *    are matched first, low-confidence ones only with a tighter gate, by IoU
 *    with the predicted box plus a centre-distance gate (in face heights) and a
 *    size-ratio gate. Nothing outside the gate is ever taken: another person is
 *    never adopted. No match for coastMs: stop and wait ('lost'); after
 *    lossHoldMs: 'holding'; optionally after returnAfterMs: back to the preset.
 *  - Latency (Smith predictor): the picture lags the command by ~0.2-0.45 s
 *    (P100 start ~185-260 ms, stop ~230-440 ms incl. NDI). The error used for
 *    control is the measured one plus the correction still "in flight" (the
 *    expected effect of the commands sent during the last tau seconds) plus the
 *    target's own motion over tau.
 *  - Control: PD on the predicted error with hysteresis (start outside the
 *    outer band, stop inside the inner band or on overshoot), desired image
 *    velocity v = kp*e_pred + kd*target_velocity, mapped non-linearly onto the
 *    camera's measured speed levels, capped at maxLevel, slew-rate limited.
 *    kp*tau ~ 0.25 keeps the loop well damped.
 *  - Speed levels are mapped through a table of image speed per level
 *    (measured on the P100); a per-axis scale is adapted online from the
 *    measured ego-motion (the P100's speed per level depends on zoom).
 *  - Excursion: the camera offset from the preset (minus the scene shift,
 *    in preset-frame fractions) is limited to maxExcursion; motion further out
 *    is blocked, motion back is allowed.
 *  - Headroom (the shot gate's rule wins over the eye-line deadzone): with a
 *    big face the eyes can sit inside the vertical deadzone while the top of
 *    the head is already at the top edge (round 3, seat 10: wide/PTZ flip-flop
 *    with "head cut off at the top"). As soon as the predicted headroom falls
 *    below headroomTrigger (the gate's stay threshold + a small margin) the
 *    camera tilts up, even inside the deadzone, until the headroom is
 *    headroomComfort (but never so far that the eyes drop below the eye line +
 *    the inner band). Too much headroom keeps the normal, tolerant deadzone.
 */
import { eyePoint, pickTarget } from './framing.js';
import { HEAD_ABOVE_FACE, type ShotObservation } from './shot-gate.js';
import type { Face } from './yunet.js';

export type TrackState = 'acquiring' | 'locked' | 'lost' | 'holding';
export type Dir = -1 | 0 | 1;

export interface AxisCommand {
  dir: Dir;
  /** VISCA speed level (0 when dir is 0). */
  level: number;
}

export interface TrackCommand {
  pan: AxisCommand;
  tilt: AxisCommand;
  zoom: Dir;
}

export interface TrackInput {
  /** ms */
  t: number;
  width: number;
  height: number;
  /** All detections down to the low score threshold. */
  faces: Face[];
  /** Scene shift since the previous tick's frame (frame fractions, +x right, +y down), or null. */
  shift: { dx: number; dy: number; peak: number } | null;
}

export interface TrackEvent {
  kind: 'acquired' | 'lost' | 'holding' | 'reacquired' | 'framed' | 'return' | 'limit' | 'too-tight';
  msg: string;
}

export interface TrackOutput {
  cmd: TrackCommand;
  state: TrackState;
  events: TrackEvent[];
  /** Current target error (frame fractions), when locked. */
  error?: { x: number; y: number };
}

export interface TrackSettings {
  /** Outer band (start moving outside it), frame fractions. */
  deadzoneX: number;
  deadzoneY: number;
  /** Inner band = outer * innerRatio (stop inside it). */
  innerRatio: number;
  /** Eye line, fraction of the frame height from the top. */
  eyeLine: number;
  /** Highest VISCA level used (pan 1-24, tilt 1-20; capped per axis). */
  maxLevel: number;
  /** Largest camera offset from the preset, frame fractions at the preset zoom. */
  maxExcursionX: number;
  maxExcursionY: number;
  /** No match for this long: stop moving. */
  coastMs: number;
  /** No match for this long: 'holding'. */
  lossHoldMs: number;
  /** No match for this long: go back to the preset (0 = never). */
  returnAfterMs: number;
  /** Command + frame latency, s. */
  tau: number;
  /** Proportional gain, 1/s (desired image velocity per unit of error). */
  kp: number;
  /** Feed-forward of the target's own velocity (0-1). */
  kd: number;
  /** Slew limits, levels per second. */
  slewUp: number;
  slewDown: number;
  /** Acquisition: the delegate must be within this offset from the target point. */
  acquireMaxX: number;
  acquireMaxY: number;
  minRelativeSize: number;
  highScore: number;
  /** Inside the seat region a detection this confident is enough for (re)acquisition (YuNet misses turned faces). */
  seatScore: number;
  lowScore: number;
  /** Optional slow zoom to keep the face height in a band (the session turns the wish into bounded absolute steps). */
  zoom: boolean;
  /**
   * After a loss, take a face again without the strict identity gate when it is
   * near the last known position or near the preset aim, of a plausible size,
   * and inside the seat region (never a neighbour).
   */
  reacquire: boolean;
  /** Face taller than this (frame fraction): too tight, the session recalls the preset. */
  tightFace: number;
  faceBand: [number, number];
  /** Zoom never changes the face size beyond these factors of the acquired size. */
  zoomLimits: [number, number];
  /** Image speed per level (frame fractions/s; index = level, index 0 unused). */
  ratesPan: number[];
  ratesTilt: number[];
  /** Drive direction that reduces a positive error: pan +1 = right; tilt +1 = up. */
  panSign: 1 | -1;
  tiltSign: 1 | -1;
  /** Tilt up when the predicted headroom (top of the head below the top edge, frame fraction) falls below this; 0 = off. */
  headroomTrigger: number;
  /** ...and keep tilting until the headroom is this. */
  headroomComfort: number;
}

/**
 * BirdDog P100 drive speeds measured in a test room at zoom 8202:
 * image speed in frame widths (pan) / heights (tilt) per second. Pan level 1
 * barely moves. At zoom 5872 the higher levels were up to 1.6x faster, hence
 * the online scale adaptation.
 */
/** Zoom (VISCA units) at which P100_RATES were measured. */
export const P100_RATES_ZOOM = 8202;

export const P100_RATES = {
  pan: [0, 0.006, 0.091, 0.157, 0.179, 0.25, 0.324, 0.39, 0.45, 0.51, 0.57, 0.63, 0.69],
  tilt: [0, 0.063, 0.051, 0.179, 0.31, 0.42, 0.53, 0.62, 0.71, 0.8, 0.89, 0.98],
};

export const TRACK_DEFAULTS: TrackSettings = {
  deadzoneX: 0.1,
  deadzoneY: 0.12,
  innerRatio: 0.4,
  eyeLine: 1 / 3,
  maxLevel: 5,
  maxExcursionX: 0.35,
  maxExcursionY: 0.35,
  coastMs: 250,
  lossHoldMs: 1500,
  returnAfterMs: 0,
  tau: 0.3,
  kp: 0.85,
  kd: 0.5,
  slewUp: 8,
  slewDown: 14,
  acquireMaxX: 0.3,
  acquireMaxY: 0.3,
  minRelativeSize: 0.45,
  highScore: 0.6,
  seatScore: 0.5,
  lowScore: 0.35,
  zoom: false,
  reacquire: true,
  tightFace: 0.35,
  faceBand: [0.14, 0.3],
  zoomLimits: [0.75, 1.5],
  ratesPan: P100_RATES.pan,
  ratesTilt: P100_RATES.tilt,
  panSign: 1,
  tiltSign: -1,
  headroomTrigger: 0.05,
  headroomComfort: 0.1,
};

// ------------------------------------------------------------------ Kalman

/** 1-D constant-velocity Kalman filter (position, velocity). */
export class Kalman1D {
  p: number;
  v = 0;
  private P: [number, number, number, number];
  constructor(
    p0: number,
    private q: number,
    private r: number,
  ) {
    this.p = p0;
    this.P = [r, 0, 0, 0.05];
  }
  predict(dt: number) {
    if (dt <= 0) return;
    this.p += this.v * dt;
    const [a, b, c, d] = this.P;
    // F P F^T + Q (white-acceleration model)
    const q = this.q;
    const dt2 = dt * dt;
    this.P = [
      a + dt * (b + c) + dt2 * d + (q * dt2 * dt2) / 4,
      b + dt * d + (q * dt2 * dt) / 2,
      c + dt * d + (q * dt2 * dt) / 2,
      d + q * dt2,
    ];
  }
  update(z: number) {
    const [a, b, c, d] = this.P;
    const s = a + this.r;
    const k0 = a / s;
    const k1 = c / s;
    const y = z - this.p;
    this.p += k0 * y;
    this.v += k1 * y;
    this.P = [(1 - k0) * a, (1 - k0) * b, c - k1 * a, d - k1 * b];
  }
  at(dt: number) {
    return this.p + this.v * dt;
  }
}

// ------------------------------------------------------------------ helpers

const sign = (v: number): Dir => (v > 0 ? 1 : v < 0 ? -1 : 0);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Levels whose speed is above every lower level and clearly non-zero (P100 pan 1 and tilt 2 drop out). */
export function usableLevels(rates: number[], cap: number): number[] {
  const out: number[] = [];
  let best = 0.02;
  for (let l = 1; l < rates.length && l <= cap; l++) {
    if (rates[l]! > best) {
      out.push(l);
      best = rates[l]!;
    }
  }
  return out;
}

/** Level whose speed is closest (in log terms) to v; at least the slowest usable level. */
export function levelFor(v: number, rates: number[], usable: number[], scale: number): number {
  if (!usable.length) return 0;
  let best = usable[0]!;
  let bestD = Infinity;
  for (const l of usable) {
    const d = Math.abs(Math.log((rates[l]! * scale) / Math.max(v, 1e-4)));
    if (d < bestD) (bestD = d), (best = l);
  }
  return best;
}

interface AxisState {
  moving: boolean;
  dir: Dir;
  /** slewed level (float) */
  level: number;
  /** level actually commanded */
  out: number;
  /** time the current (dir, out) was commanded */
  since: number;
  lastActive: number;
  /** adaptive speed scale (measured / table) */
  scale: number;
}

interface ControlOptions {
  /** Start moving even inside the outer band. */
  force?: boolean;
  /** Stop band override (0 = only on overshoot). */
  inner?: number;
  /** End the current move now. */
  stop?: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

export interface TrackStats {
  ticks: number;
  lockedTicks: number;
  starts: number;
  reversals: number;
  losses: number;
  maxExcursion: { x: number; y: number };
  limitHits: number;
  scale: { pan: number; tilt: number };
}

export class TrackController {
  s: TrackSettings;
  state: TrackState = 'acquiring';
  /** Accumulated scene shift since the preset (current-frame fractions). */
  S = { x: 0, y: 0 };
  /** Camera offset from the preset (preset-frame fractions). */
  E = { x: 0, y: 0 };
  private kx: Kalman1D | null = null;
  private ky: Kalman1D | null = null;
  private kh: Kalman1D | null = null;
  private aspect = 16 / 9;
  private h0 = 0.2;
  private lastT: number | null = null;
  private lastMatch = 0;
  private box: Box | null = null;
  private candidate: { face: Face; n: number } | null = null;
  private ax: { pan: AxisState; tilt: AxisState };
  private zoomDir: Dir = 0;
  private zoomSince = 0;
  /** commanded image-error rate history for the Smith predictor: [t, ux, uy] */
  private hist: Array<[number, number, number]> = [];
  private framedSent = false;
  private holdSent = false;
  private returnSent = false;
  private limitWarned = false;
  private tightTicks = 0;
  private tightSent = false;
  private reCand: { wx: number; wy: number; h: number } | null = null;
  /** Detector of the last match and the eye point measured then (frame fractions). */
  private src: 'face' | 'pose' | 'person' | null = null;
  private lastEye: { x: number; y: number } | null = null;
  private everLocked = false;
  /** Eye to top of the head, in face heights (measured on the matched boxes; YuNet ~0.7). */
  private headK = 0.4 + HEAD_ABOVE_FACE;
  /** The current tilt move was started by the headroom rule. */
  private hrDrive = false;
  /** The target was matched on the last step (its box is from this frame). */
  matchedThisTick = false;
  /**
   * Drive direction per axis that is forbidden right now (hard limit in camera
   * units, set by the session from VISCA positions); 0 = none. Moving back is
   * always allowed.
   */
  block: { pan: Dir; tilt: Dir } = { pan: 0, tilt: 0 };
  private usable: { pan: number[]; tilt: number[] };
  stats: TrackStats = {
    ticks: 0,
    lockedTicks: 0,
    starts: 0,
    reversals: 0,
    losses: 0,
    maxExcursion: { x: 0, y: 0 },
    limitHits: 0,
    scale: { pan: 1, tilt: 1 },
  };

  constructor(settings: Partial<TrackSettings> = {}) {
    this.s = { ...TRACK_DEFAULTS, ...settings };
    const axis = (): AxisState => ({ moving: false, dir: 0, level: 0, out: 0, since: 0, lastActive: -1e9, scale: 1 });
    this.ax = { pan: axis(), tilt: axis() };
    this.usable = { pan: [], tilt: [] };
    this.setMaxLevel(this.s.maxLevel);
  }

  setMaxLevel(level: number) {
    this.s.maxLevel = level;
    this.usable = { pan: usableLevels(this.s.ratesPan, Math.min(level, 24)), tilt: usableLevels(this.s.ratesTilt, Math.min(level, 20)) };
  }

  /** Back to acquisition at the preset (after a return-to-preset or a restart). */
  reset() {
    this.state = 'acquiring';
    this.kx = this.ky = this.kh = null;
    this.S = { x: 0, y: 0 };
    this.E = { x: 0, y: 0 };
    this.candidate = null;
    this.box = null;
    this.hist = [];
    this.framedSent = this.holdSent = this.returnSent = this.limitWarned = this.tightSent = false;
    this.tightTicks = 0;
    this.reCand = null;
    this.src = null;
    this.lastEye = null;
    this.everLocked = false;
    this.hrDrive = false;
    this.matchedThisTick = false;
    this.block = { pan: 0, tilt: 0 };
    for (const a of Object.values(this.ax)) Object.assign(a, { moving: false, dir: 0, level: 0, out: 0 });
    this.zoomDir = 0;
  }

  /**
   * The camera starts this far from the preset aim (a learned correction was
   * applied after the recall): frame fractions at the preset zoom, +x right,
   * +y down. Keeps the seat region and the excursion limit relative to the
   * preset.
   */
  setPresetOffset(x: number, y: number) {
    this.S = { x: -x, y: -y };
    this.E = { x, y };
  }

  /**
   * Where the target is relative to the preset aim (world eye point minus the
   * framing target; frame fractions at the preset zoom), and its velocity.
   * This is the accumulated camera motion plus the remaining image offset.
   * Null when not locked.
   */
  aim(): { x: number; y: number; vx: number; vy: number } | null {
    if (this.state !== 'locked' || !this.kx || !this.ky) return null;
    return { x: this.kx.p - 0.5, y: this.ky.p - this.s.eyeLine, vx: this.kx.v, vy: this.ky.v };
  }

  /** Force all axes to stopped (e.g. after the watchdog sent a stop). */
  halt(t: number) {
    for (const a of Object.values(this.ax)) {
      if (a.out) a.lastActive = t;
      Object.assign(a, { moving: false, dir: 0, level: 0, out: 0, since: t });
    }
    this.zoomDir = 0;
  }

  get moving(): boolean {
    return this.ax.pan.out > 0 || this.ax.tilt.out > 0;
  }

  command(): TrackCommand {
    const c = (a: AxisState): AxisCommand => ({ dir: a.out ? a.dir : 0, level: a.out });
    return { pan: c(this.ax.pan), tilt: c(this.ax.tilt), zoom: this.zoomDir };
  }

  /** Expected image-error rate (frame fractions/s) of an axis's current command (0 if idle). */
  private rate(axis: 'pan' | 'tilt'): number {
    const a = this.ax[axis];
    if (!a.out) return 0;
    const rates = axis === 'pan' ? this.s.ratesPan : this.s.ratesTilt;
    const sgn = axis === 'pan' ? this.s.panSign : this.s.tiltSign;
    // a command in direction sgn reduces a positive error: de/dt = -dir*sgn*rate
    return -a.dir * sgn * (rates[a.out] ?? rates[rates.length - 1]!) * a.scale;
  }

  /** Integral of the commanded error rate over [t0, t1] (piecewise constant history). */
  private integral(t0: number, t1: number): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (let i = 0; i < this.hist.length; i++) {
      const [ts, ux, uy] = this.hist[i]!;
      const te = i + 1 < this.hist.length ? this.hist[i + 1]![0] : t1;
      const a = Math.max(ts, t0);
      const b = Math.min(te, t1);
      if (b > a) (x += (ux * (b - a)) / 1000), (y += (uy * (b - a)) / 1000);
    }
    return { x, y };
  }

  private record(t: number) {
    const ux = this.rate('pan');
    const uy = this.rate('tilt');
    const last = this.hist[this.hist.length - 1];
    if (!last || last[1] !== ux || last[2] !== uy) this.hist.push([t, ux, uy]);
    const keep = t - (this.s.tau * 1000 + 1500);
    while (this.hist.length > 1 && this.hist[1]![0] < keep) this.hist.shift();
  }

  step(inp: TrackInput): TrackOutput {
    const s = this.s;
    const t = inp.t;
    const dt = this.lastT === null ? 0 : (t - this.lastT) / 1000;
    this.lastT = t;
    this.aspect = inp.width / inp.height;
    this.stats.ticks++;
    this.matchedThisTick = false;
    const events: TrackEvent[] = [];

    // ---- ego-motion: accumulate the scene shift while the camera may be moving
    const tauMs = s.tau * 1000;
    const recentlyMoving = Math.max(this.ax.pan.out ? t : this.ax.pan.lastActive, this.ax.tilt.out ? t : this.ax.tilt.lastActive) > t - (tauMs + 500);
    if (recentlyMoving && dt > 0) {
      // what the commands should have done to this frame (they show up ~tau later)
      const exp = this.integral(t - tauMs - dt * 1000, t - tauMs);
      let d = exp;
      if (inp.shift && inp.shift.peak >= 8 && Math.abs(inp.shift.dx) < 0.3 && Math.abs(inp.shift.dy) < 0.3) {
        d = { x: inp.shift.dx, y: inp.shift.dy };
        const t0 = t - tauMs - dt * 1000 - 120;
        if (this.steady(t0, t - tauMs, 1)) this.adapt('pan', d.x, exp.x);
        if (this.steady(t0, t - tauMs, 2)) this.adapt('tilt', d.y, exp.y);
      }
      this.S.x += d.x;
      this.S.y += d.y;
      const mag = this.kh ? clamp(this.kh.p / this.h0, 0.5, 2) : 1;
      this.E.x -= d.x / mag;
      this.E.y -= d.y / mag;
      this.stats.maxExcursion.x = Math.max(this.stats.maxExcursion.x, Math.abs(this.E.x));
      this.stats.maxExcursion.y = Math.max(this.stats.maxExcursion.y, Math.abs(this.E.y));
    }

    // ---- target association
    for (const k of [this.kx, this.ky, this.kh]) k?.predict(dt);
    const faces = inp.faces.filter((f) => f.score >= s.lowScore);
    if (this.state === 'acquiring') this.acquire(faces, inp, t, events);
    else {
      let m = this.associate(faces, inp, t);
      if (!m && this.state !== 'locked') m = this.reacquire(faces, inp, events);
      if (m) {
        const [ex, ey] = eyePoint(m);
        this.kx!.update(ex / inp.width - this.S.x);
        this.ky!.update(ey / inp.height - this.S.y);
        this.kh!.update(m.h / inp.height);
        this.box = { x: m.x / inp.width, y: m.y / inp.height, w: m.w / inp.width, h: m.h / inp.height };
        this.matched(m, inp);
        this.matchedThisTick = true;
        this.lastMatch = t;
        if (this.state !== 'locked') {
          events.push({ kind: 'reacquired', msg: `target reacquired after ${t - this.lostAt} ms` });
          this.state = 'locked';
          this.holdSent = this.returnSent = false;
          this.reCand = null;
        }
      } else if (this.state === 'locked' && t - this.lastMatch > s.coastMs) {
        this.state = 'lost';
        this.lostAt = this.lastMatch;
        this.stats.losses++;
        // keep the last known position: a prediction running on with the old velocity would walk away from the person
        for (const k of [this.kx, this.ky, this.kh]) if (k) k.v = 0;
        events.push({ kind: 'lost', msg: 'target lost, stopped' });
      }
      if (this.state === 'lost' && t - this.lastMatch > s.lossHoldMs && !this.holdSent) {
        this.state = 'holding';
        this.holdSent = true;
        events.push({ kind: 'holding', msg: `target not seen for ${s.lossHoldMs} ms, holding` });
      }
      if (this.state === 'holding' && s.returnAfterMs > 0 && t - this.lastMatch > s.returnAfterMs && !this.returnSent) {
        this.returnSent = true;
        events.push({ kind: 'return', msg: `target not seen for ${s.returnAfterMs} ms, back to the preset` });
      }
    }

    // ---- control
    let error: { x: number; y: number } | undefined;
    if (this.state === 'locked' && this.kx && this.ky && this.kh) {
      this.stats.lockedTicks++;
      const ex = this.kx.p + this.S.x - 0.5;
      const ey = this.ky.p + this.S.y - s.eyeLine;
      error = { x: ex, y: ey };
      const flight = this.integral(t - tauMs, t);
      const px = ex + flight.x + this.kx.v * s.tau;
      const py = ey + flight.y + this.ky.v * s.tau;
      this.control('pan', px, this.kx.v, s.deadzoneX, s.maxExcursionX, this.E.x - flight.x, dt, t, events);
      const [ty, topt] = this.headroomTilt(py);
      this.control('tilt', ty, this.ky.v, s.deadzoneY, s.maxExcursionY, this.E.y - flight.y, dt, t, events, topt);
      this.zoomStep(t);
      // hard rule: a face this big means the shot is far too tight (zoomed in by something): the session recalls the preset
      this.tightTicks = this.kh.p > s.tightFace ? this.tightTicks + 1 : 0;
      if (this.tightTicks >= 3 && !this.tightSent) {
        this.tightSent = true;
        events.push({ kind: 'too-tight', msg: `face ${(this.kh.p * 100).toFixed(0)}% of the frame high (limit ${(s.tightFace * 100).toFixed(0)}%): too tight` });
      }
      if (!this.framedSent && !this.moving && Math.abs(ex) <= s.deadzoneX && Math.abs(ey) <= s.deadzoneY) {
        this.framedSent = true;
        events.push({ kind: 'framed', msg: `framed: offset x ${(ex * 100).toFixed(1)}% y ${(ey * 100).toFixed(1)}%` });
      }
    } else {
      // no fresh measurement to steer by: stop and wait
      if (this.moving) this.halt(t);
      this.hrDrive = false;
    }
    this.record(t);
    this.stats.scale = { pan: this.ax.pan.scale, tilt: this.ax.tilt.scale };
    return { cmd: this.command(), state: this.state, events, error };
  }

  private lostAt = 0;

  private matched(f: Face, inp: TrackInput) {
    const [ex, ey] = eyePoint(f);
    this.src = f.source ?? 'face';
    this.lastEye = { x: ex / inp.width, y: ey / inp.height };
    this.everLocked = true;
    if (f.h > 0 && this.src !== 'person') {
      const k = clamp((ey - f.y) / f.h + HEAD_ABOVE_FACE, 0.5, 1);
      this.headK += 0.3 * (k - this.headK);
    }
  }

  /**
   * Tilt error and control options with the headroom rule (see the header):
   * predicted top of the head = predicted eye line - headK x face height.
   */
  private headroomTilt(py: number): [number, ControlOptions | undefined] {
    const s = this.s;
    if (!(s.headroomTrigger > 0) || !this.kh) {
      this.hrDrive = false;
      return [py, undefined];
    }
    const hr = py + s.eyeLine - this.headK * this.kh.p;
    // how far the picture may still move down: to comfortable headroom, eyes at most the inner band below the eye line
    const room = Math.min(s.headroomComfort - hr, s.deadzoneY * s.innerRatio - py);
    if (!this.hrDrive && hr < s.headroomTrigger && room > 0.01) this.hrDrive = true;
    if (!this.hrDrive) return [py, undefined];
    if (room > 0.005) return [Math.min(py, -room), { force: true, inner: 0 }];
    // comfortable again: end the move unless the eye line alone would have started one
    this.hrDrive = false;
    return [py, Math.abs(py) <= s.deadzoneY ? { stop: true } : undefined];
  }

  /** Image speed of the current drive (frame fractions/s, largest axis). */
  get speed(): number {
    return Math.max(Math.abs(this.rate('pan')), Math.abs(this.rate('tilt')));
  }

  /** What the shot gate needs this tick. */
  observe(t: number): ShotObservation {
    return {
      t,
      state: this.state,
      lostMs: this.everLocked ? Math.max(0, t - this.lastMatch) : Infinity,
      box: this.box ? { ...this.box } : null,
      eye: this.lastEye ? { ...this.lastEye } : null,
      source: this.src,
      speed: this.speed,
    };
  }

  /**
   * A detection usable for (re)acquisition or tracking inside the seat region
   * (image coordinates of this frame). When there is none, the session runs the
   * head/upper-body fallback.
   */
  hasSeatFace(faces: Face[], width: number, height: number): boolean {
    const s = this.s;
    return faces.some((f) => {
      if (f.score < s.seatScore) return false;
      const [ex, ey] = eyePoint(f);
      return this.inSeatRegion(ex / width - this.S.x, ey / height - this.S.y);
    });
  }

  /** The seat region in this frame's pixels (for the fallback detector's person filter). */
  seatRoi(width: number, height: number): { x: number; y: number; w: number; h: number } {
    const s = this.s;
    const rx = Math.max(s.acquireMaxX, s.maxExcursionX);
    const x0 = Math.max(0, 0.5 - rx + this.S.x);
    const x1 = Math.min(1, 0.5 + rx + this.S.x);
    return { x: x0 * width, y: 0, w: Math.max(0, x1 - x0) * width, h: height };
  }

  private acquire(faces: Face[], inp: TrackInput, t: number, events: TrackEvent[]) {
    const s = this.s;
    // near the preset aim (the seat) a less confident face is enough; a bare person box never
    const cands = faces.filter((f) => {
      if (f.source === 'person') return false;
      if (f.score >= s.highScore) return true;
      if (f.score < s.seatScore) return false;
      const [ex, ey] = eyePoint(f);
      return Math.abs(ex / inp.width - this.S.x - 0.5) <= s.acquireMaxX && Math.abs(ey / inp.height - this.S.y - s.eyeLine) <= s.acquireMaxY;
    });
    const f = pickTarget(cands, inp.width, inp.height, { minRelativeSize: s.minRelativeSize, eyeLine: s.eyeLine });
    if (!f) {
      this.candidate = null;
      return;
    }
    const [ex, ey] = eyePoint(f);
    const ox = ex / inp.width - 0.5;
    const oy = ey / inp.height - s.eyeLine;
    if (Math.abs(ox) > s.acquireMaxX || Math.abs(oy) > s.acquireMaxY) {
      this.candidate = null;
      return;
    }
    // too tight at the preset aim: never lock on it; the session recalls the preset
    if (f.h / inp.height > s.tightFace) {
      this.candidate = null;
      if (++this.tightTicks >= 3 && !this.tightSent) {
        this.tightSent = true;
        events.push({ kind: 'too-tight', msg: `face ${((f.h / inp.height) * 100).toFixed(0)}% of the frame high (limit ${(s.tightFace * 100).toFixed(0)}%): too tight` });
      }
      return;
    }
    this.tightTicks = 0;
    // two consecutive consistent picks
    const c = this.candidate;
    if (c && Math.hypot((c.face.x - f.x) / f.h, (c.face.y - f.y) / f.h) < 0.5 && f.h / c.face.h > 0.7 && f.h / c.face.h < 1.43) {
      const q = 0.02; // accel noise (frame fractions/s^2)^2
      const r = 0.004 ** 2;
      this.kx = new Kalman1D(ex / inp.width - this.S.x, q, r);
      this.ky = new Kalman1D(ey / inp.height - this.S.y, q, r);
      this.kh = new Kalman1D(f.h / inp.height, 0.005, 0.006 ** 2);
      this.h0 = f.h / inp.height;
      this.box = { x: f.x / inp.width, y: f.y / inp.height, w: f.w / inp.width, h: f.h / inp.height };
      this.matched(f, inp);
      this.lastMatch = t;
      this.state = 'locked';
      events.push({
        kind: 'acquired',
        msg: `target acquired: offset x ${(ox * 100).toFixed(1)}% y ${(oy * 100).toFixed(1)}%, face ${((f.h / inp.height) * 100).toFixed(0)}% high, ${faces.length} face(s) in view`,
      });
    } else this.candidate = { face: f, n: 1 };
  }

  /**
   * Re-acquisition after a loss (no strict identity gate): a confident face of
   * plausible size, inside the seat region, near the last known position or
   * near the preset aim. Two consistent ticks in a row. Never outside the seat
   * region, so a neighbour is never adopted.
   */
  /** World (preset-frame) eye point inside this seat's region: the preset aim +/- max(acquire offset, excursion). */
  private inSeatRegion(wx: number, wy: number): boolean {
    const s = this.s;
    return Math.abs(wx - 0.5) <= Math.max(s.acquireMaxX, s.maxExcursionX) && Math.abs(wy - s.eyeLine) <= Math.max(s.acquireMaxY, s.maxExcursionY);
  }

  private reacquire(faces: Face[], inp: TrackInput, events: TrackEvent[]): Face | null {
    const s = this.s;
    if (!this.kx || !this.ky || !this.kh) return null;
    // a face in the seat region far too big (zoomed in by something): the tracked one jumped in size and got lost
    const tight = faces.some((f) => {
      if (f.score < s.highScore || f.h / inp.height <= s.tightFace) return false;
      const [ex, ey] = eyePoint(f);
      return this.inSeatRegion(ex / inp.width - this.S.x, ey / inp.height - this.S.y);
    });
    this.tightTicks = tight ? this.tightTicks + 1 : 0;
    if (this.tightTicks >= 3 && !this.tightSent) {
      this.tightSent = true;
      events.push({ kind: 'too-tight', msg: `face over ${(s.tightFace * 100).toFixed(0)}% of the frame high in the seat region: too tight` });
    }
    if (!s.reacquire) return null;
    const lastH = this.kh.p;
    let best: { f: Face; wx: number; wy: number; h: number; d: number } | null = null;
    for (const f of faces) {
      // region-gated below: a less confident face (or a head from body keypoints) is enough here
      if (f.score < s.seatScore || f.source === 'person') continue;
      const h = f.h / inp.height;
      if (h > s.tightFace || h < lastH * 0.6 || h > lastH * 1.7) continue;
      const [ex, ey] = eyePoint(f);
      const wx = ex / inp.width - this.S.x;
      const wy = ey / inp.height - this.S.y;
      // seat region (world = preset-frame coordinates): hard gate
      if (!this.inSeatRegion(wx, wy)) continue;
      const dLast = Math.hypot((wx - this.kx.p) * this.aspect, wy - this.ky.p) / lastH;
      const nearLast = dLast <= 2;
      const nearAim = Math.abs(wx - 0.5) <= s.acquireMaxX && Math.abs(wy - s.eyeLine) <= s.acquireMaxY;
      if (!nearLast && !nearAim) continue;
      if (!best || dLast < best.d) best = { f, wx, wy, h, d: dLast };
    }
    if (!best) {
      this.reCand = null;
      return null;
    }
    const c = this.reCand;
    this.reCand = { wx: best.wx, wy: best.wy, h: best.h };
    if (!c || Math.hypot((c.wx - best.wx) * this.aspect, c.wy - best.wy) / best.h > 0.5 || best.h / c.h < 0.7 || best.h / c.h > 1.43) return null;
    // restart the filters at the new measurement (the old prediction may be stale)
    const q = 0.02;
    const r = 0.004 ** 2;
    this.kx = new Kalman1D(best.wx, q, r);
    this.ky = new Kalman1D(best.wy, q, r);
    this.kh = new Kalman1D(best.h, 0.005, 0.006 ** 2);
    return best.f;
  }

  /** ByteTrack-style: high-score detections first, then low-score ones with a tighter gate. */
  private associate(faces: Face[], inp: TrackInput, t: number): Face | null {
    const s = this.s;
    if (!this.kx || !this.ky || !this.kh || !this.box) return null;
    const px = this.kx.p + this.S.x;
    const py = this.ky.p + this.S.y;
    const ph = this.kh.p;
    // predicted box: last box moved with the eye point
    const b = this.box;
    const [bx, by] = [b.x + b.w / 2, b.y + b.h * 0.4];
    const pred: Box = { x: b.x + (px - bx), y: b.y + (py - by), w: b.w, h: b.h };
    // after a loss the person may have moved a little: widen the gate slowly (never beyond ~1.2 face heights)
    const lostFor = Math.max(0, t - this.lastMatch);
    const widen = this.state === 'locked' ? 0 : Math.min(0.4, lostFor / 5000);
    const pick = (cands: Face[], gate: number, minIou: number): Face | null => {
      let best: Face | null = null;
      let bestC = Infinity;
      for (const f of cands) {
        const [ex, ey] = eyePoint(f);
        const fh = f.h / inp.height;
        const ratio = fh / ph;
        if (ratio < 0.7 || ratio > 1.43) continue;
        // after a loss, never outside the seat region (a neighbour), however wide the gate got
        if (this.state !== 'locked' && !this.inSeatRegion(ex / inp.width - this.S.x, ey / inp.height - this.S.y)) continue;
        const d = Math.hypot((ex / inp.width - px) * this.aspect, ey / inp.height - py) / ph;
        const o = iou(pred, { x: f.x / inp.width, y: f.y / inp.height, w: f.w / inp.width, h: f.h / inp.height });
        if (d > gate || (o < minIou && d > gate * 0.5)) continue;
        const c = d - o;
        if (c < bestC) (bestC = c), (best = f);
      }
      return best;
    };
    const strong = (f: Face) => {
      if (f.score >= s.highScore) return true;
      if (f.score < s.seatScore || f.source === 'person') return false;
      const [ex, ey] = eyePoint(f);
      return this.inSeatRegion(ex / inp.width - this.S.x, ey / inp.height - this.S.y);
    };
    const high = faces.filter(strong);
    const low = faces.filter((f) => !strong(f));
    const hit = pick(high, 0.8 + widen, 0.2);
    if (hit) return hit;
    // low-confidence detections only keep a live track going (not for reacquisition)
    return this.state === 'locked' ? pick(low, 0.5, 0.35) : null;
  }

  /** The commanded rate on one axis (1 pan, 2 tilt) was constant and non-zero over [t0, t1]. */
  private steady(t0: number, t1: number, k: 1 | 2): boolean {
    let v: number | null = null;
    for (let i = 0; i < this.hist.length; i++) {
      const ts = this.hist[i]![0];
      const te = i + 1 < this.hist.length ? this.hist[i + 1]![0] : Infinity;
      if (te <= t0 || ts >= t1) continue;
      const u = this.hist[i]![k];
      if (v !== null && u !== v) return false;
      v = u;
      if (ts > t0) return false;
    }
    return !!v;
  }

  private adapt(axis: 'pan' | 'tilt', measured: number, expected: number) {
    const a = this.ax[axis];
    // only during steady motion on this axis (acceleration transients excluded by steady())
    if (Math.abs(expected) < 0.004) return;
    if (Math.sign(measured) !== Math.sign(expected)) return;
    const r = clamp(Math.abs(measured / expected), 0.3, 3);
    a.scale = clamp(a.scale * (r ** 0.2), 0.3, 3);
  }

  private control(
    axis: 'pan' | 'tilt',
    e: number,
    vel: number,
    outer: number,
    maxExc: number,
    excursion: number,
    dt: number,
    t: number,
    events: TrackEvent[],
    opt?: ControlOptions,
  ) {
    const s = this.s;
    const a = this.ax[axis];
    const sgn = axis === 'pan' ? s.panSign : s.tiltSign;
    const inner = opt?.inner ?? outer * s.innerRatio;
    if (opt?.stop) a.moving = false;
    // hysteresis
    if (!a.moving && (Math.abs(e) > outer || (opt?.force && e !== 0))) a.moving = true;
    else if (a.moving && (Math.abs(e) < inner || (a.dir && sign(e) * sgn !== a.dir))) a.moving = false;

    let want = 0;
    let dir: Dir = 0;
    if (a.moving) {
      dir = (sign(e) * sgn) as Dir;
      if (dir !== 0 && dir === this.block[axis]) {
        // hard limit in camera units (from the session's VISCA position): never further away
        a.moving = false;
        dir = 0;
        this.stats.limitHits++;
        if (!this.limitWarned) {
          this.limitWarned = true;
          events.push({ kind: 'limit', msg: `${axis} at the excursion limit (camera position, VISCA units)` });
        }
      }
      // excursion: the camera moving in `dir` changes E by +dir*sgn... (E = -S, and S changes by -dir*sgn*rate)
      const towards = dir * sgn; // sign of the change of E
      if (Math.abs(excursion) >= maxExc && Math.sign(excursion) === towards) {
        a.moving = false;
        dir = 0;
        this.stats.limitHits++;
        if (!this.limitWarned) {
          this.limitWarned = true;
          events.push({ kind: 'limit', msg: `${axis} at the excursion limit (${(maxExc * 100).toFixed(0)}% of the frame from the preset)` });
        }
      } else {
        // PD: desired image speed towards the target (frame fractions/s)
        const v = Math.max(0, s.kp * Math.abs(e) + s.kd * vel * sign(e));
        const rates = axis === 'pan' ? s.ratesPan : s.ratesTilt;
        want = levelFor(v, rates, this.usable[axis], a.scale);
      }
    }

    const prevOut = a.out;
    const prevDir = a.dir;
    if (!dir || (a.dir && dir !== a.dir)) {
      // stop (and a reversal always goes through a stop)
      if (a.dir && dir && dir !== a.dir) this.stats.reversals++;
      a.level = 0;
      a.out = 0;
      a.dir = 0;
    } else {
      const min = this.usable[axis][0] ?? 1;
      if (!a.dir) {
        a.dir = dir;
        a.level = min;
        this.stats.starts++;
      } else if (want > a.level) a.level = Math.min(want, a.level + s.slewUp * dt);
      else a.level = Math.max(want, a.level - s.slewDown * dt);
      // snap to a usable level at or below the slewed value
      const u = this.usable[axis];
      let out = u[0] ?? 0;
      for (const l of u) if (l <= a.level + 1e-6) out = l;
      a.out = out;
    }
    if (a.out !== prevOut || a.dir !== prevDir) {
      if (prevOut) a.lastActive = t;
      a.since = t;
    }
  }

  private zoomStep(t: number) {
    const s = this.s;
    if (!s.zoom || !this.kh) {
      this.zoomDir = 0;
      return;
    }
    const h = this.kh.p;
    const [lo, hi] = s.faceBand;
    const mid = (lo + hi) / 2;
    const rel = h / this.h0;
    // zoom only while pan/tilt are idle, and only within the limits
    if (this.ax.pan.out || this.ax.tilt.out) {
      this.zoomDir = 0;
      return;
    }
    let d: Dir = this.zoomDir;
    if (d === 0) {
      if (h < lo && rel < s.zoomLimits[1]) d = 1;
      else if (h > hi && rel > s.zoomLimits[0]) d = -1;
    } else if ((d === 1 && (h >= mid * 0.95 || rel >= s.zoomLimits[1])) || (d === -1 && (h <= mid * 1.05 || rel <= s.zoomLimits[0]))) d = 0;
    if (d !== this.zoomDir) this.zoomSince = t;
    this.zoomDir = d;
  }
}
