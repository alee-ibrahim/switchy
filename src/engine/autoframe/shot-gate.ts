/**
 * Shot-quality gate (pure): the program shows the PTZ only while its shot is
 * good; otherwise the wide camera.
 *
 * A shot is good when the target is locked and its head is fully in the frame
 * with headroom (top of the head = face box top - 0.3 x face height, at least
 * `headroom` below the top edge), the face is not cut at the sides or the
 * bottom, the face height is in a sane band, the eye line is near the target
 * line, and the camera is not moving fast. Staying on the PTZ uses slightly
 * looser thresholds than cutting to it (hysteresis).
 *
 * ProgramGate turns per-tick verdicts into cuts: to the PTZ after the shot was
 * good for holdMs; back to wide when the target was lost for lostToWideMs
 * (always) or the shot was bad for badToWideMs; at least minDwellMs on each
 * source between gate cuts (except for a lost target).
 */
import type { RoomPolicy } from '../types.js';

export interface ShotBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the tracker sees this tick (frame fractions). */
export interface ShotObservation {
  t: number;
  /** Tracking state: 'acquiring' = no target yet (or after a preset recall). */
  state: 'acquiring' | 'locked' | 'lost' | 'holding';
  /** ms since the target was last matched (Infinity if never). */
  lostMs: number;
  /** Target face/head box at its last match. */
  box: ShotBox | null;
  /** Eye point at the last match. */
  eye: { x: number; y: number } | null;
  /** Detector that produced the last match. */
  source: 'face' | 'pose' | 'person' | null;
  /** Commanded camera image speed, frame fractions per second (largest axis). */
  speed: number;
  /**
   * Head-region sharpness this tick (Laplacian variance, smoothed over a few
   * ticks) and the seat's recent sharp baseline (null while unknown).
   * Absent: no sharpness check.
   */
  sharp?: { value: number; baseline: number | null } | null;
}

export interface GateThresholds {
  /** Top of the head at least this far below the top edge (frame fraction). */
  headroom: number;
  /** Face box at least this far from the sides and the bottom. */
  margin: number;
  faceMin: number;
  faceMax: number;
  /** Eye line target and tolerance (frame fractions from the top). */
  eyeLine: number;
  eyeTol: number;
  /** Faster than this (frame fractions/s) = moving fast. */
  maxSpeed: number;
  /** Head sharpness below this fraction of the seat's baseline = blurry (0 = no check). */
  minSharpRatio?: number;
}

/** Top of the head above the face box top, in face heights. */
export const HEAD_ABOVE_FACE = 0.3;

export const GATE_DEFAULTS: GateThresholds = {
  headroom: 0.05,
  margin: 0.02,
  faceMin: 0.08,
  faceMax: 0.35,
  eyeLine: 1 / 3,
  eyeTol: 0.15,
  // P100 pan level 4 is ~0.18 frames/s: slow tracking moves are fine
  maxSpeed: 0.2,
};

/** Strict thresholds (cut to the PTZ) or loose ones (stay on it). */
export function gateThresholds(
  policy: Pick<RoomPolicy, 'trackHeadroomPct' | 'trackTightFacePct'> & Partial<Pick<RoomPolicy, 'trackBlurRatioPct'>>,
  loose: boolean,
): GateThresholds {
  const strict: GateThresholds = {
    ...GATE_DEFAULTS,
    headroom: policy.trackHeadroomPct / 100,
    faceMax: Math.min(GATE_DEFAULTS.faceMax, policy.trackTightFacePct / 100),
    // only for cutting TO the PTZ: a soft picture never takes the PTZ off program
    minSharpRatio: (policy.trackBlurRatioPct ?? 0) / 100,
  };
  if (!loose) return strict;
  return {
    ...strict,
    minSharpRatio: 0,
    headroom: Math.max(0, strict.headroom - 0.02),
    margin: strict.margin / 2,
    faceMin: strict.faceMin * 0.85,
    faceMax: strict.faceMax * 1.15,
    eyeTol: strict.eyeTol + 0.05,
    maxSpeed: strict.maxSpeed * 1.6,
  };
}

export interface ShotVerdict {
  good: boolean;
  /** Short reason ("headroom 9%, face 22%" or what is wrong). */
  reason: string;
  /** Top of the head below the top edge (frame fraction; negative = cut off). */
  headroom: number | null;
  face: number | null;
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

/** Head box top (frame fraction) for a face box. */
export function headTop(box: ShotBox): number {
  return box.y - HEAD_ABOVE_FACE * box.h;
}

export function judgeShot(o: Pick<ShotObservation, 'state' | 'box' | 'eye' | 'source' | 'speed' | 'sharp'>, thr: GateThresholds): ShotVerdict {
  const bad = (reason: string, headroom: number | null = null, face: number | null = null): ShotVerdict => ({ good: false, reason, headroom, face });
  if (o.state === 'acquiring' || !o.box) return bad('searching for the speaker');
  if (o.state !== 'locked') return bad('target lost');
  const b = o.box;
  const head = headTop(b);
  const face = b.h;
  if (o.source === 'person') return bad('no head keypoints (person box only)', head, face);
  if (head < thr.headroom) return bad(head < 0 ? `head cut off at the top (${pct(head)})` : `no headroom (${pct(head)} < ${pct(thr.headroom)})`, head, face);
  if (b.x < thr.margin || b.x + b.w > 1 - thr.margin) return bad('face cut at the side', head, face);
  if (b.y + b.h > 1 - thr.margin) return bad('face cut at the bottom', head, face);
  if (face < thr.faceMin) return bad(`face too small (${pct(face)})`, head, face);
  if (face > thr.faceMax) return bad(`face too big (${pct(face)})`, head, face);
  const ey = o.eye?.y ?? b.y + 0.4 * b.h;
  if (Math.abs(ey - thr.eyeLine) > thr.eyeTol) return bad(`eye line ${ey < thr.eyeLine ? 'high' : 'low'} (${pct(ey)})`, head, face);
  if (o.speed > thr.maxSpeed) return bad('camera moving fast', head, face);
  const sh = o.sharp;
  if (thr.minSharpRatio && sh && sh.baseline && sh.value < thr.minSharpRatio * sh.baseline) {
    return bad(`head blurry (sharpness ${pct(sh.value / sh.baseline)} of this seat's usual)`, head, face);
  }
  return { good: true, reason: `headroom ${pct(head)}, face ${pct(face)}${o.source === 'pose' ? ', head from body keypoints' : ''}`, headroom: head, face };
}

export interface GateTiming {
  lostToWideMs: number;
  badToWideMs: number;
  holdMs: number;
  minDwellMs: number;
}

export function gateTiming(p: Pick<RoomPolicy, 'trackLostToWideMs' | 'trackBadToWideMs' | 'trackHoldBeforeCutMs' | 'trackMinDwellMs'>): GateTiming {
  return { lostToWideMs: p.trackLostToWideMs, badToWideMs: p.trackBadToWideMs, holdMs: p.trackHoldBeforeCutMs, minDwellMs: p.trackMinDwellMs };
}

export type GateAction = { to: 'ptz' | 'wide'; reason: string } | null;

export type GateState = 'searching' | 'good' | 'bad' | 'lost';

export class ProgramGate {
  onPtz = false;
  private goodSince: number | null = null;
  private badSince: number | null = null;
  /** Last verdict (for the live view). */
  verdict: ShotVerdict = { good: false, reason: 'searching for the speaker', headroom: null, face: null };
  state: GateState = 'searching';

  constructor(
    private timing: GateTiming,
    private strict: GateThresholds,
    private loose: GateThresholds,
    /** Time of the last program cut (any source). */
    public lastSwitchAt: number,
  ) {}

  /** The program was cut by someone else (cover, manual): keep the dwell clock and source in step. */
  switched(onPtz: boolean, t: number) {
    this.onPtz = onPtz;
    this.lastSwitchAt = t;
    this.goodSince = this.badSince = null;
  }

  update(o: ShotObservation): GateAction {
    const t = o.t;
    const v = judgeShot(o, this.onPtz ? this.loose : this.strict);
    this.verdict = v;
    this.state = v.good ? 'good' : o.state === 'acquiring' && o.lostMs === Infinity ? 'searching' : o.state === 'locked' ? 'bad' : 'lost';
    if (v.good) {
      this.goodSince ??= t;
      this.badSince = null;
    } else {
      this.badSince ??= t;
      this.goodSince = null;
    }
    const dwell = t - this.lastSwitchAt >= this.timing.minDwellMs;
    if (!this.onPtz) {
      if (this.goodSince !== null && t - this.goodSince >= this.timing.holdMs && dwell) {
        return { to: 'ptz', reason: `shot good: ${v.reason}` };
      }
      return null;
    }
    if (o.state !== 'locked' && o.lostMs >= this.timing.lostToWideMs) {
      return { to: 'wide', reason: o.lostMs === Infinity ? `target lost (${v.reason})` : `target lost ${Math.round(o.lostMs)} ms` };
    }
    if (this.badSince !== null && t - this.badSince >= this.timing.badToWideMs && dwell) {
      return { to: 'wide', reason: `shot bad for ${Math.round(t - this.badSince)} ms: ${v.reason}` };
    }
    return null;
  }
}
