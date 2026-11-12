/**
 * Small JPEG helpers (pure JS via jpeg-js, no native deps).
 * Frames are tiny (NDI proxy stream, 640x360) so encoding takes a few ms.
 */
import jpeg from 'jpeg-js';

export interface RgbaImage {
  width: number;
  height: number;
  /** 4 bytes per pixel, rows `stride` bytes apart. */
  data: Buffer | Uint8Array;
  stride?: number;
  /** Byte order of the pixels; BGRA/BGRX are swapped to RGBA. Default RGBA. */
  fourcc?: string;
}

/**
 * Box-downscale by an integer factor so the result is at most maxWidth wide,
 * returning a tightly packed RGBA buffer (alpha forced to 255).
 */
export function downscale(img: RgbaImage, maxWidth: number): { width: number; height: number; data: Buffer } {
  const stride = img.stride ?? img.width * 4;
  const f = Math.max(1, Math.ceil(img.width / Math.max(1, maxWidth)));
  const w = Math.max(1, Math.floor(img.width / f));
  const h = Math.max(1, Math.floor(img.height / f));
  const bgr = img.fourcc?.startsWith('BGR') ?? false;
  const [ri, bi] = bgr ? [2, 0] : [0, 2];
  const src = img.data;
  const out = Buffer.alloc(w * h * 4);
  const n = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < f; dy++) {
        let p = (y * f + dy) * stride + x * f * 4;
        for (let dx = 0; dx < f; dx++, p += 4) {
          r += src[p + ri]!;
          g += src[p + 1]!;
          b += src[p + bi]!;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

export function encodeJpeg(img: RgbaImage, opts: { maxWidth?: number; quality?: number } = {}): Buffer {
  const s = downscale(img, opts.maxWidth ?? img.width);
  return Buffer.from(jpeg.encode(s, opts.quality ?? 75).data);
}

/** Decode any JPEG and re-encode it at most maxWidth wide (used for thumbnail uploads). */
export function resizeJpeg(input: Buffer, opts: { maxWidth: number; quality?: number }): Buffer {
  const d = jpeg.decode(input, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 });
  return encodeJpeg({ width: d.width, height: d.height, data: d.data }, opts);
}

/** Width/height of a JPEG without a full decode (SOF0/SOF2 marker). */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/** Thumbnail size stored per seat. */
export const THUMB_WIDTH = 320;
