/**
 * Head/upper-body fallback detector: RTMDet-nano person boxes + RTMPose-t body
 * keypoints (OpenMMLab, Apache-2.0) on onnxruntime-node, CPU.
 *
 * YuNet misses faces turned away, looking up, or with a hand on the chin. The
 * body keypoints (nose, eyes, ears, shoulders) still give the head, so a head
 * box shaped like a YuNet face box (eyes at 40% of its height) is derived from
 * them. Without any face keypoint the top of the person box is used (source
 * 'person': tracking continuity only, never a "good shot").
 *
 * Pre-processing follows the models' mmdeploy pipeline.json:
 *  - RTMDet: keep-ratio resize into 320x320, pad 114 bottom/right, BGR,
 *    mean (103.53, 116.28, 123.675), std (57.375, 57.12, 58.395);
 *    output dets [1, N, 5] = x1 y1 x2 y2 score in input pixels (NMS included).
 *  - RTMPose: box centre/size x1.25, aspect fixed to 192:256, affine crop
 *    192x256, RGB, mean (123.675, 116.28, 103.53), std (58.395, 57.12, 57.375);
 *    outputs SimCC x [1,17,384] / y [1,17,512] (split ratio 2); keypoint score =
 *    the smaller of the two maxima.
 */
import type { RgbaImage } from '../image/jpeg.js';
import type { Face } from './yunet.js';

export interface PersonBox {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

/** COCO-17 keypoint [x, y, score] in image pixels. */
export type Keypoint = [number, number, number];

export const KP = { nose: 0, lEye: 1, rEye: 2, lEar: 3, rEar: 4, lShoulder: 5, rShoulder: 6 } as const;

export interface HeadDetector {
  /**
   * Head boxes (YuNet-face-like, source 'pose' or 'person') of the people whose
   * box overlaps `roi` (image pixels; whole frame if omitted), best first.
   */
  detect(img: RgbaImage, opts?: { roi?: { x: number; y: number; w: number; h: number }; maxPersons?: number }): Promise<Face[]>;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Sample channel values (R, G, B) at (x, y) with bilinear interpolation; `out` gets r, g, b. Outside -> fill. */
function sampler(img: RgbaImage) {
  const stride = img.stride ?? img.width * 4;
  const bgr = img.fourcc?.startsWith('BGR') ?? false;
  const [ri, bi] = bgr ? [2, 0] : [0, 2];
  const d = img.data;
  const W = img.width;
  const H = img.height;
  return (x: number, y: number, out: number[], fill: number): void => {
    if (x < -0.5 || y < -0.5 || x > W - 0.5 || y > H - 0.5) {
      out[0] = out[1] = out[2] = fill;
      return;
    }
    const x0 = clamp(Math.floor(x), 0, W - 1);
    const y0 = clamp(Math.floor(y), 0, H - 1);
    const x1 = Math.min(W - 1, x0 + 1);
    const y1 = Math.min(H - 1, y0 + 1);
    const fx = clamp(x - x0, 0, 1);
    const fy = clamp(y - y0, 0, 1);
    const a = y0 * stride + x0 * 4;
    const b = y0 * stride + x1 * 4;
    const c = y1 * stride + x0 * 4;
    const e = y1 * stride + x1 * 4;
    const w00 = (1 - fx) * (1 - fy);
    const w01 = fx * (1 - fy);
    const w10 = (1 - fx) * fy;
    const w11 = fx * fy;
    const ch = [ri, 1, bi];
    for (let k = 0; k < 3; k++) {
      const o = ch[k]!;
      out[k] = d[a + o]! * w00 + d[b + o]! * w01 + d[c + o]! * w10 + d[e + o]! * w11;
    }
  };
}

/** RTMDet input: keep-ratio resize into size x size, pad 114, BGR planar, normalised. */
export function rtmdetInput(img: RgbaImage, size = 320): { data: Float32Array; scale: number } {
  const scale = Math.min(size / img.width, size / img.height);
  const plane = size * size;
  const data = new Float32Array(3 * plane);
  const mean = [103.53, 116.28, 123.675];
  const std = [57.375, 57.12, 58.395];
  const sw = Math.round(img.width * scale);
  const sh = Math.round(img.height * scale);
  const s = sampler(img);
  const px = [0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * size + x;
      if (x >= sw || y >= sh) {
        for (let k = 0; k < 3; k++) data[k * plane + o] = (114 - mean[k]!) / std[k]!;
        continue;
      }
      s((x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5, px, 114);
      // planes in BGR order
      data[o] = (px[2]! - mean[0]!) / std[0]!;
      data[plane + o] = (px[1]! - mean[1]!) / std[1]!;
      data[2 * plane + o] = (px[0]! - mean[2]!) / std[2]!;
    }
  }
  return { data, scale };
}

export const POSE_W = 192;
export const POSE_H = 256;

/** Pose crop for a person box: centre and size (box x1.25, aspect 192:256). */
export function poseCrop(b: PersonBox): { cx: number; cy: number; w: number; h: number } {
  let w = b.w * 1.25;
  let h = b.h * 1.25;
  const aspect = POSE_W / POSE_H;
  if (w > h * aspect) h = w / aspect;
  else w = h * aspect;
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w, h };
}

/** RTMPose input: affine crop to 192x256, RGB planar, normalised (outside the image: 0). */
export function rtmposeInput(img: RgbaImage, crop: { cx: number; cy: number; w: number; h: number }): Float32Array {
  const plane = POSE_W * POSE_H;
  const data = new Float32Array(3 * plane);
  const mean = [123.675, 116.28, 103.53];
  const std = [58.395, 57.12, 57.375];
  const s = sampler(img);
  const px = [0, 0, 0];
  const x0 = crop.cx - crop.w / 2;
  const y0 = crop.cy - crop.h / 2;
  const kx = crop.w / POSE_W;
  const ky = crop.h / POSE_H;
  for (let v = 0; v < POSE_H; v++) {
    for (let u = 0; u < POSE_W; u++) {
      s(x0 + (u + 0.5) * kx - 0.5, y0 + (v + 0.5) * ky - 0.5, px, 0);
      const o = v * POSE_W + u;
      for (let k = 0; k < 3; k++) data[k * plane + o] = (px[k]! - mean[k]!) / std[k]!;
    }
  }
  return data;
}

/** SimCC decode: argmax per keypoint, back to image pixels. */
export function decodeSimcc(
  sx: ArrayLike<number>,
  sy: ArrayLike<number>,
  k: number,
  crop: { cx: number; cy: number; w: number; h: number },
  split = 2,
): Keypoint[] {
  const nx = sx.length / k;
  const ny = sy.length / k;
  const out: Keypoint[] = [];
  for (let j = 0; j < k; j++) {
    let bx = 0;
    let vx = -Infinity;
    for (let i = 0; i < nx; i++) {
      const v = sx[j * nx + i]!;
      if (v > vx) (vx = v), (bx = i);
    }
    let by = 0;
    let vy = -Infinity;
    for (let i = 0; i < ny; i++) {
      const v = sy[j * ny + i]!;
      if (v > vy) (vy = v), (by = i);
    }
    const x = (bx / split / POSE_W) * crop.w + crop.cx - crop.w / 2;
    const y = (by / split / POSE_H) * crop.h + crop.cy - crop.h / 2;
    out.push([x, y, Math.min(vx, vy)]);
  }
  return out;
}

/** Keypoint visibility threshold (SimCC maxima; rtmlib uses 0.3). */
export const KP_THRESHOLD = 0.3;

/**
 * A YuNet-like head box from body keypoints (eyes at 40% of the box height, box
 * ~1.2x the head width tall), or from the top of the person box when no face
 * keypoint is visible. Null if nothing usable.
 */
export function headFromKeypoints(kps: Keypoint[], person: PersonBox, thr = KP_THRESHOLD): Face | null {
  const vis = (i: number) => (kps[i] && kps[i]![2] >= thr ? kps[i]! : null);
  const dist = (a: Keypoint, b: Keypoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const nose = vis(KP.nose);
  const le = vis(KP.lEye);
  const re = vis(KP.rEye);
  const lr = vis(KP.lEar);
  const rr = vis(KP.rEar);
  const ls = vis(KP.lShoulder);
  const rs = vis(KP.rShoulder);
  const facePts = [nose, le, re, lr, rr].filter((p): p is Keypoint => !!p);
  const shoulder = ls && rs ? dist(ls, rs) : null;

  // head width: from the ears / eyes; turned heads shrink those, the shoulders keep a floor
  const est: number[] = [];
  if (lr && rr) est.push(dist(lr, rr) * 1.15);
  if (le && re) est.push(dist(le, re) * 2.4);
  let headW = est.length ? Math.max(...est) : 0;
  if (shoulder) headW = clamp(headW || shoulder * 0.42, shoulder * 0.33, shoulder * 0.62);
  if (!headW) headW = person.w * 0.3;
  if (headW < 4) return null;
  const h = headW * 1.2;
  const w = headW * 0.95;

  if (facePts.length) {
    let ex: number;
    let ey: number;
    if (le && re) [ex, ey] = [(le[0] + re[0]) / 2, (le[1] + re[1]) / 2];
    else if ((le || re) && nose) {
      const e = (le ?? re)!;
      [ex, ey] = [(e[0] + nose[0]) / 2, e[1]];
    } else if (lr && rr) [ex, ey] = [(lr[0] + rr[0]) / 2, (lr[1] + rr[1]) / 2 - 0.05 * h];
    else if (nose) [ex, ey] = [nose[0], nose[1] - 0.15 * h];
    else {
      const p = facePts[0]!;
      [ex, ey] = [p[0], p[1]];
    }
    const kpScore = facePts.reduce((a, p) => a + Math.min(1, p[2]), 0) / facePts.length;
    // confidence: the face keypoints and the person box; more face points -> more trust
    const score = clamp(0.5 * Math.min(1, person.score) + 0.5 * kpScore, 0, 1) * (facePts.length >= 3 ? 1 : 0.85);
    return { x: ex - w / 2, y: ey - 0.4 * h, w, h, score, landmarks: [], source: 'pose' };
  }
  // no face keypoint: head = top of the person box (continuity only)
  const cx = ls && rs ? (ls[0] + rs[0]) / 2 : person.x + person.w / 2;
  const top = person.y;
  return { x: cx - w / 2, y: top + 0.3 * h, w, h, score: Math.min(1, person.score) * 0.6, landmarks: [], source: 'person' };
}

export interface RtmOptions {
  detPath: string;
  posePath: string;
  /** Person boxes below this score are ignored (default 0.4). */
  personScore?: number;
  threads?: number;
}

type Ort = typeof import('onnxruntime-node');
type Sess = import('onnxruntime-node').InferenceSession;

export class RtmHeadDetector implements HeadDetector {
  private sessions: Promise<{ ort: Ort; det: Sess; pose: Sess }> | null = null;
  /** Last call's timings (ms). */
  lastMs = { det: 0, pose: 0, total: 0 };

  constructor(private o: RtmOptions) {}

  private load() {
    this.sessions ??= (async () => {
      const ort = (await import('onnxruntime-node')) as Ort;
      const opts = { executionProviders: ['cpu'], intraOpNumThreads: this.o.threads ?? 2, graphOptimizationLevel: 'all' as const };
      const [det, pose] = await Promise.all([ort.InferenceSession.create(this.o.detPath, opts), ort.InferenceSession.create(this.o.posePath, opts)]);
      return { ort, det, pose };
    })().catch((e) => {
      this.sessions = null;
      throw e;
    });
    return this.sessions;
  }

  async warmup(width = 640, height = 360): Promise<void> {
    const img = { width, height, data: new Uint8Array(width * height * 4) };
    await this.persons(img);
    await this.keypoints(img, { x: 100, y: 50, w: 200, h: 250, score: 1 });
  }

  async persons(img: RgbaImage): Promise<PersonBox[]> {
    const { ort, det } = await this.load();
    const { data, scale } = rtmdetInput(img);
    const out = await det.run({ [det.inputNames[0]!]: new ort.Tensor('float32', data, [1, 3, 320, 320]) });
    const d = out.dets!.data as Float32Array;
    const min = this.o.personScore ?? 0.4;
    const boxes: PersonBox[] = [];
    for (let i = 0; i + 4 < d.length; i += 5) {
      const score = d[i + 4]!;
      if (score < min) continue;
      const x1 = clamp(d[i]! / scale, 0, img.width);
      const y1 = clamp(d[i + 1]! / scale, 0, img.height);
      const x2 = clamp(d[i + 2]! / scale, 0, img.width);
      const y2 = clamp(d[i + 3]! / scale, 0, img.height);
      if (x2 - x1 < 4 || y2 - y1 < 4) continue;
      boxes.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, score });
    }
    return boxes.sort((a, b) => b.score - a.score);
  }

  async keypoints(img: RgbaImage, b: PersonBox): Promise<Keypoint[]> {
    const { ort, pose } = await this.load();
    const crop = poseCrop(b);
    const input = new ort.Tensor('float32', rtmposeInput(img, crop), [1, 3, POSE_H, POSE_W]);
    const out = await pose.run({ [pose.inputNames[0]!]: input });
    const sx = out.simcc_x!;
    return decodeSimcc(sx.data as Float32Array, out.simcc_y!.data as Float32Array, sx.dims[1]!, crop);
  }

  async detect(img: RgbaImage, opts: { roi?: { x: number; y: number; w: number; h: number }; maxPersons?: number } = {}): Promise<Face[]> {
    const t0 = performance.now();
    let persons = await this.persons(img);
    const t1 = performance.now();
    const roi = opts.roi;
    if (roi) {
      const overlap = (p: PersonBox) =>
        Math.max(0, Math.min(p.x + p.w, roi.x + roi.w) - Math.max(p.x, roi.x)) * Math.max(0, Math.min(p.y + p.h, roi.y + roi.h) - Math.max(p.y, roi.y));
      persons = persons
        .map((p) => ({ p, o: overlap(p) / (p.w * p.h) }))
        .filter((x) => x.o > 0.2)
        .sort((a, b) => b.o * b.p.score - a.o * a.p.score)
        .map((x) => x.p);
    }
    const heads: Face[] = [];
    for (const p of persons.slice(0, opts.maxPersons ?? 2)) {
      const h = headFromKeypoints(await this.keypoints(img, p), p);
      if (h) heads.push(h);
    }
    const t2 = performance.now();
    this.lastMs = { det: t1 - t0, pose: t2 - t1, total: t2 - t0 };
    return heads;
  }
}
