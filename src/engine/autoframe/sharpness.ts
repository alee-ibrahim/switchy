/**
 * Head-region sharpness (pure): variance of the 4-neighbour Laplacian of the
 * luma inside the head box (face box plus the top of the head), on the
 * tracker's low-bandwidth NDI frame.
 *
 * Absolute values depend on the light, the person and the seat, so the shot
 * gate compares each tick with that seat's own recent sharp baseline (a high
 * percentile of the values measured while the shot was good and the camera
 * still). Only a picture far softer than the seat's usual one (motion blur
 * right after a move, autofocus hunting or focused on the wall behind) blocks
 * the cut to the PTZ. It never takes the PTZ off program.
 */
import type { RgbaImage } from '../image/jpeg.js';
import { HEAD_ABOVE_FACE, type ShotBox } from './shot-gate.js';

/** Laplacian variance of the head region (box in frame fractions); null if the region is too small. */
export function headSharpness(img: RgbaImage, box: ShotBox): number | null {
  const W = img.width;
  const H = img.height;
  const x0 = Math.max(1, Math.floor(box.x * W));
  const x1 = Math.min(W - 2, Math.ceil((box.x + box.w) * W));
  const y0 = Math.max(1, Math.floor((box.y - HEAD_ABOVE_FACE * box.h) * H));
  const y1 = Math.min(H - 2, Math.ceil((box.y + box.h) * H));
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w < 8 || h < 8) return null;
  const stride = img.stride ?? W * 4;
  const bgr = img.fourcc?.startsWith('BGR') ?? false;
  const [ri, bi] = bgr ? [2, 0] : [0, 2];
  const d = img.data;
  // luma of the region plus a 1-pixel border
  const lw = w + 2;
  const lh = h + 2;
  const L = new Float32Array(lw * lh);
  for (let y = 0; y < lh; y++) {
    const row = (y0 - 1 + y) * stride;
    for (let x = 0; x < lw; x++) {
      const o = row + (x0 - 1 + x) * 4;
      L[y * lw + x] = 0.299 * d[o + ri]! + 0.587 * d[o + 1]! + 0.114 * d[o + bi]!;
    }
  }
  let s = 0;
  let s2 = 0;
  for (let y = 1; y <= h; y++) {
    for (let x = 1; x <= w; x++) {
      const i = y * lw + x;
      const v = L[i - 1]! + L[i + 1]! + L[i - lw]! + L[i + lw]! - 4 * L[i]!;
      s += v;
      s2 += v * v;
    }
  }
  const n = w * h;
  const m = s / n;
  return s2 / n - m * m;
}

export interface SharpnessOptions {
  /** Values kept per seat. */
  keep: number;
  /** A baseline needs at least this many values. */
  minSamples: number;
  /** Baseline = this percentile of the kept values. */
  percentile: number;
}

export const SHARPNESS_DEFAULTS: SharpnessOptions = { keep: 120, minSamples: 20, percentile: 0.75 };

/**
 * Recent sharp baseline per seat (in memory; it is rebuilt within a turn or
 * two after a restart and needs no persistence).
 */
export class SharpnessBaselines {
  private seats = new Map<string, number[]>();
  readonly o: SharpnessOptions;
  constructor(o: Partial<SharpnessOptions> = {}) {
    this.o = { ...SHARPNESS_DEFAULTS, ...o };
  }

  /** A value measured while the shot was good and the camera still. */
  add(key: string, v: number) {
    if (!Number.isFinite(v) || v <= 0) return;
    const a = this.seats.get(key) ?? [];
    a.push(v);
    if (a.length > this.o.keep) a.splice(0, a.length - this.o.keep);
    this.seats.set(key, a);
  }

  /** The seat's baseline, or null while there are too few values. */
  baseline(key: string): number | null {
    const a = this.seats.get(key);
    if (!a || a.length < this.o.minSamples) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(this.o.percentile * (s.length - 1)))]!;
  }

  clear(key?: string) {
    if (key === undefined) this.seats.clear();
    else this.seats.delete(key);
  }
}
