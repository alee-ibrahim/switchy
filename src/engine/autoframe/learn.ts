/**
 * Per-seat learned correction (track mode).
 *
 * After each GOOD tracking turn (shot gate good for at least LEARN_MIN_GOOD_MS
 * in total, target locked, turn ended normally, not on a target loss) the
 * median offset of the delegate from the seat preset's aim, measured
 * while the shot was good and the camera still, is stored for the seat. The
 * offset is the tracker's world eye position (accumulated camera motion, as
 * measured from the picture, plus the remaining image offset), converted to
 * VISCA pan/tilt units with the calibration at the preset's stored zoom. P100
 * position reads are never used for it.
 *
 * The last `keep` samples per seat are stored in Postgres (seat_corrections,
 * covered by the normal DB backup). The learned correction is the median of
 * the stored samples, used once there are at least LEARN_MIN_SAMPLES, capped
 * per axis at trackLearnCapPct of the frame. On the next turn the session
 * recalls the hand-saved preset (never overwritten), waits for a still
 * picture, applies the correction as one move, then starts tracking.
 */
import { coefficientsAt, type Calibration } from './calibration.js';

export const LEARN_MIN_SAMPLES = 2;
/** A turn teaches only when the shot was good (and the person seated) this long in total. */
export const LEARN_MIN_GOOD_MS = 5000;
/** ...and at least this many still, good ticks were measured. */
export const LEARN_MIN_TICKS = 15;
/** Camera idle this long before a tick counts as "still". */
export const LEARN_STILL_MS = 600;
/*
 * Which turns teach (policy, frame fractions):
 *  - trackLearnMaxOffsetPct (35, = the default excursion limit): ticks with the
 *    delegate further than this from the preset aim on either axis are not
 *    sampled (the wrong person, someone walking past). A large offset by itself
 *    is NOT a reason to reject a turn: a preset that is 20% off for whoever sits
 *    there is exactly what learning fixes.
 *  - trackLearnMaxSpreadPct (8): the turn is used only if the offset was stable
 *    while the shot was good: interquartile range of the sampled offsets per
 *    axis at most this (standing up / leaning out / a swap during the turn
 *    makes it wider).
 * What is APPLIED stays capped by trackLearnCapPct.
 */

/** Interquartile range (linear interpolation); 0 for fewer than 2 values. */
export function iqr(v: number[]): number {
  if (v.length < 2) return 0;
  const s = [...v].sort((a, b) => a - b);
  const q = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
  };
  return q(0.75) - q(0.25);
}
/** Stop reasons of a normally ended turn. */
export const LEARN_END_REASONS = new Set(['speaker changed', 'new shot']);

export interface LearnSample {
  /** Aim offset from the preset in VISCA units (+pan = the camera turns the way +pan drives). */
  pan: number;
  tilt: number;
  /** The same offset in frame fractions at the preset zoom (+x right, +y down). */
  x: number;
  y: number;
  /** Still, good ticks the median was taken over. */
  ticks: number;
  at: string;
}

export interface SeatLearnRecord {
  roomId: string;
  unit: number;
  cameraId: string;
  preset: string;
  /** Stored preset coordinates the samples are relative to (a re-saved preset invalidates them). */
  presetPos: { pan: number; tilt: number; zoom: number } | null;
  samples: LearnSample[];
  updatedAt: string;
}

export interface LearnPersistence {
  load(): Promise<SeatLearnRecord[]>;
  save(r: SeatLearnRecord): Promise<void>;
  /** unit undefined: the whole room. */
  remove(roomId: string, unit?: number): Promise<void>;
}

export interface LearnedCorrection {
  pan: number;
  tilt: number;
  x: number;
  y: number;
  /** Samples the median was taken over. */
  n: number;
  capped: boolean;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * The correction from the stored samples: median per axis in VISCA units,
 * capped at `cap` (frame fraction) per axis; null with fewer than minSamples.
 * `coef`: calibration coefficients at the preset zoom (null: the stored frame
 * fractions are used for the cap and the display).
 */
export function learnedCorrection(
  samples: LearnSample[],
  o: { cap: number; minSamples?: number; coef?: { dxPerPan: number; dyPerTilt: number } | null },
): LearnedCorrection | null {
  if (samples.length < (o.minSamples ?? LEARN_MIN_SAMPLES)) return null;
  let pan = median(samples.map((s) => s.pan));
  let tilt = median(samples.map((s) => s.tilt));
  // frame fractions: scene shift = coef * units, aim offset = -shift
  let x = o.coef ? -pan * o.coef.dxPerPan : median(samples.map((s) => s.x));
  let y = o.coef ? -tilt * o.coef.dyPerTilt : median(samples.map((s) => s.y));
  let capped = false;
  if (Math.abs(x) > o.cap) {
    pan *= o.cap / Math.abs(x);
    x = Math.sign(x) * o.cap;
    capped = true;
  }
  if (Math.abs(y) > o.cap) {
    tilt *= o.cap / Math.abs(y);
    y = Math.sign(y) * o.cap;
    capped = true;
  }
  return { pan: Math.round(pan), tilt: Math.round(tilt), x, y, n: samples.length, capped };
}

/** Aim offset (frame fractions at the preset zoom) -> VISCA units. */
export function offsetToUnits(cal: Calibration, zoom: number, x: number, y: number): { pan: number; tilt: number } {
  const c = coefficientsAt(cal, zoom);
  // to aim right by x the scene must move left by x: -x = dxPerPan * pan
  return { pan: Math.round(-x / c.dxPerPan) || 0, tilt: Math.round(-y / c.dyPerTilt) || 0 };
}

const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

export function describeCorrection(c: LearnedCorrection): string {
  return `${fmtPct(c.x)} x, ${fmtPct(c.y)} y (pan ${c.pan >= 0 ? '+' : ''}${c.pan}, tilt ${c.tilt >= 0 ? '+' : ''}${c.tilt}; ${c.n} turn${c.n === 1 ? '' : 's'}${c.capped ? ', capped' : ''})`;
}

const samePos = (a: SeatLearnRecord['presetPos'], b: SeatLearnRecord['presetPos']) =>
  (!a && !b) || (!!a && !!b && a.pan === b.pan && a.tilt === b.tilt && a.zoom === b.zoom);

/**
 * In-memory view of the stored samples (loaded once at start), written through
 * to the persistence. Never touches camera presets or preset coordinates.
 */
export class SeatLearning {
  private recs = new Map<string, SeatLearnRecord>();
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private p: LearnPersistence | null = null,
    private log: (msg: string) => void = () => {},
  ) {}

  private key = (roomId: string, unit: number) => `${roomId}|${unit}`;

  async init(): Promise<void> {
    if (!this.p) return;
    for (const r of await this.p.load()) this.recs.set(this.key(r.roomId, r.unit), r);
  }

  /** The seat's record if it belongs to this camera, preset and stored preset position; else null. */
  get(roomId: string, unit: number, cameraId: string, preset: string, presetPos: SeatLearnRecord['presetPos']): SeatLearnRecord | null {
    const r = this.recs.get(this.key(roomId, unit));
    if (!r || r.cameraId !== cameraId || r.preset !== preset || !samePos(r.presetPos, presetPos)) return null;
    return r;
  }

  list(roomId: string): SeatLearnRecord[] {
    return [...this.recs.values()].filter((r) => r.roomId === roomId).sort((a, b) => a.unit - b.unit);
  }

  /** Add one turn's sample (keeps the last `keep`); a different camera/preset/preset position starts over. */
  add(
    roomId: string,
    unit: number,
    cameraId: string,
    preset: string,
    presetPos: SeatLearnRecord['presetPos'],
    s: LearnSample,
    keep: number,
  ): SeatLearnRecord {
    const old = this.get(roomId, unit, cameraId, preset, presetPos);
    const samples = [...(old?.samples ?? []), s].slice(-Math.max(1, keep));
    const r: SeatLearnRecord = { roomId, unit, cameraId, preset, presetPos, samples, updatedAt: new Date().toISOString() };
    this.recs.set(this.key(roomId, unit), r);
    this.write(() => this.p!.save(r));
    return r;
  }

  /** Forget one seat (or, without unit, the whole room). */
  reset(roomId: string, unit?: number): number {
    let n = 0;
    for (const [k, r] of this.recs) {
      if (r.roomId === roomId && (unit === undefined || r.unit === unit)) {
        this.recs.delete(k);
        n++;
      }
    }
    this.write(() => this.p!.remove(roomId, unit));
    return n;
  }

  /** Writes are serialised; resolves when the last one is done (tests). */
  flush(): Promise<unknown> {
    return this.chain;
  }

  private write(fn: () => Promise<void>) {
    if (!this.p) return;
    const run = () => fn().catch((e) => this.log(`learned corrections: database write failed: ${(e as Error).message}`));
    this.chain = this.chain.then(run, run);
  }
}
