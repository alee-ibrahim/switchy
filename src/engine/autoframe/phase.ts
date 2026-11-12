/**
 * Image shift estimation by phase correlation (pure TS, radix-2 FFT).
 * Used for person-free PTZ calibration: move by a known VISCA delta, grab a
 * frame before and after, and measure how far the scene moved.
 */
import { downscale, type RgbaImage } from '../image/jpeg.js';

/** In-place iterative radix-2 FFT. n = re.length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] = re[i]! / n), (im[i] = im[i]! / n);
}

function fft2d(re: Float64Array, im: Float64Array, w: number, h: number, inverse = false) {
  const rr = new Float64Array(w);
  const ri = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    rr.set(re.subarray(y * w, y * w + w));
    ri.set(im.subarray(y * w, y * w + w));
    fft(rr, ri, inverse);
    re.set(rr, y * w);
    im.set(ri, y * w);
  }
  const cr = new Float64Array(h);
  const ci = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) (cr[y] = re[y * w + x]!), (ci[y] = im[y * w + x]!);
    fft(cr, ci, inverse);
    for (let y = 0; y < h; y++) (re[y * w + x] = cr[y]!), (im[y * w + x] = ci[y]!);
  }
}

const pow2Below = (n: number) => 1 << Math.floor(Math.log2(n));

/** Centre crop (power-of-two size) as luma, Hann-windowed and mean-removed. */
export function lumaWindow(img: RgbaImage, cw: number, ch: number): Float64Array {
  const stride = img.stride ?? img.width * 4;
  const x0 = Math.floor((img.width - cw) / 2);
  const y0 = Math.floor((img.height - ch) / 2);
  const out = new Float64Array(cw * ch);
  let sum = 0;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const p = (y0 + y) * stride + (x0 + x) * 4;
      const v = 0.299 * img.data[p]! + 0.587 * img.data[p + 1]! + 0.114 * img.data[p + 2]!;
      out[y * cw + x] = v;
      sum += v;
    }
  }
  const mean = sum / out.length;
  for (let y = 0; y < ch; y++) {
    const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / (ch - 1));
    for (let x = 0; x < cw; x++) {
      const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / (cw - 1));
      out[y * cw + x] = (out[y * cw + x]! - mean) * wx * wy;
    }
  }
  return out;
}

export interface Shift {
  /** Scene content in `b` sits (dx, dy) pixels from where it was in `a` (in the input image's pixels). */
  dx: number;
  dy: number;
  /** Peak height relative to the mean of the correlation surface (confidence; > ~10 is solid). */
  peak: number;
}

/** Estimate the translation from image a to image b (same size). */
export function phaseCorrelate(a: RgbaImage, b: RgbaImage): Shift {
  if (a.width !== b.width || a.height !== b.height) throw new Error('phaseCorrelate: size mismatch');
  const cw = pow2Below(a.width);
  const ch = pow2Below(a.height);
  const ar = lumaWindow(a, cw, ch);
  const br = lumaWindow(b, cw, ch);
  const ai = new Float64Array(cw * ch);
  const bi = new Float64Array(cw * ch);
  fft2d(ar, ai, cw, ch);
  fft2d(br, bi, cw, ch);
  // R = Fb * conj(Fa) / |Fb * conj(Fa)|  -> peak at +shift
  for (let i = 0; i < ar.length; i++) {
    const r = br[i]! * ar[i]! + bi[i]! * ai[i]!;
    const im = bi[i]! * ar[i]! - br[i]! * ai[i]!;
    const m = Math.hypot(r, im) || 1;
    ar[i] = r / m;
    ai[i] = im / m;
  }
  fft2d(ar, ai, cw, ch, true);
  let best = 0;
  let sum = 0;
  for (let i = 0; i < ar.length; i++) {
    sum += Math.abs(ar[i]!);
    if (ar[i]! > ar[best]!) best = i;
  }
  const px = best % cw;
  const py = Math.floor(best / cw);
  const at = (x: number, y: number) => ar[((y + ch) % ch) * cw + ((x + cw) % cw)]!;
  const sub = (l: number, c: number, r: number) => {
    const d = l - 2 * c + r;
    return d !== 0 ? (0.5 * (l - r)) / d : 0;
  };
  let dx = px + sub(at(px - 1, py), at(px, py), at(px + 1, py));
  let dy = py + sub(at(px, py - 1), at(px, py), at(px, py + 1));
  if (dx > cw / 2) dx -= cw;
  if (dy > ch / 2) dy -= ch;
  return { dx, dy, peak: ar[best]! / (sum / ar.length || 1) };
}

export interface VideoStillResult {
  ms: number;
  frames: number;
  still: boolean;
  /** Largest frame-to-frame shift seen (px at the analysed width). */
  maxShift: number;
  /** The last frame grabbed (full size), e.g. for face detection once still. */
  last?: RgbaImage;
}

/**
 * Wait until the picture stops moving: grab consecutive frames and stop once the
 * frame-to-frame shift stays below `threshold` (px at `width`) for `stable`
 * comparisons in a row. The P100 reports its VISCA target position (and sends
 * the completion) before the head has actually stopped, so this is the reliable
 * settle signal, and it also absorbs the NDI latency.
 */
export async function waitVideoStill(
  grab: () => Promise<RgbaImage | null>,
  opts: {
    signal?: AbortSignal;
    /** Don't look before this (the picture lags the command by ~150-200 ms). */
    minMs?: number;
    maxMs?: number;
    width?: number;
    threshold?: number;
    stable?: number;
  } = {},
): Promise<VideoStillResult> {
  const t0 = Date.now();
  const minMs = opts.minMs ?? 250;
  const maxMs = opts.maxMs ?? 2000;
  const width = opts.width ?? 320;
  const threshold = opts.threshold ?? 0.15;
  const need = opts.stable ?? 2;
  if (minMs > 0) await new Promise((r) => setTimeout(r, minMs));
  let prev: RgbaImage | null = null;
  let ok = 0;
  let frames = 0;
  let maxShift = 0;
  let last: RgbaImage | undefined;
  while (Date.now() - t0 < maxMs) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const f = await grab();
    if (!f) continue;
    frames++;
    last = f;
    const img = f.width > width ? downscale(f, width) : f;
    if (prev) {
      const s = phaseCorrelate(prev, img);
      const m = Math.hypot(s.dx, s.dy);
      maxShift = Math.max(maxShift, m);
      ok = m < threshold ? ok + 1 : 0;
      if (ok >= need) return { ms: Date.now() - t0, frames, still: true, maxShift, last };
    }
    prev = img;
  }
  return { ms: Date.now() - t0, frames, still: false, maxShift, last };
}
