/**
 * YuNet face detector (OpenCV Zoo, MIT) on onnxruntime-node, CPU.
 *
 * Pre-processing and decoding follow OpenCV's FaceDetectorYN (4.8+):
 *   input  1x3xHxW float32, BGR, 0-255, no mean/scale; image padded bottom/right
 *          with zeros to a multiple of 32.
 *   output cls/obj/bbox/kps for strides 8, 16, 32; score = sqrt(cls * obj);
 *          box centre = (col + dx, row + dy) * stride, size = exp(dw|dh) * stride;
 *          landmarks = (col + kx, row + ky) * stride
 *          (right eye, left eye, nose tip, right mouth corner, left mouth corner).
 */
import type { RgbaImage } from '../image/jpeg.js';

export interface Face {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  /** 5 landmarks [x, y]: right eye, left eye, nose, right mouth corner, left mouth corner. */
  landmarks: Array<[number, number]>;
  /**
   * Where the box came from: YuNet ('face', the default), a head box from body
   * keypoints ('pose'), or the top of a person box ('person', continuity only).
   */
  source?: 'face' | 'pose' | 'person';
}

export interface FaceDetector {
  /** scoreThreshold overrides the detector's default (tracking keeps low-confidence detections for continuity). */
  detect(img: RgbaImage, opts?: { scoreThreshold?: number }): Promise<Face[]>;
}

const STRIDES = [8, 16, 32] as const;
const pad32 = (n: number) => Math.ceil(n / 32) * 32;

/** RGBA/RGBX/BGRA/BGRX (any stride) -> planar BGR float32 padded to multiples of 32. */
export function toBgrPlanar(img: RgbaImage): { data: Float32Array; padW: number; padH: number } {
  const { width: w, height: h } = img;
  const stride = img.stride ?? w * 4;
  const bgr = img.fourcc?.startsWith('BGR') ?? false;
  const [ri, bi] = bgr ? [2, 0] : [0, 2];
  const padW = pad32(w);
  const padH = pad32(h);
  const plane = padW * padH;
  const out = new Float32Array(3 * plane);
  const src = img.data;
  for (let y = 0; y < h; y++) {
    let p = y * stride;
    let o = y * padW;
    for (let x = 0; x < w; x++, p += 4, o++) {
      out[o] = src[p + bi]!;
      out[plane + o] = src[p + 1]!;
      out[2 * plane + o] = src[p + ri]!;
    }
  }
  return { data: out, padW, padH };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export type YunetOutputs = Record<string, { data: ArrayLike<number> }>;

/** Decode raw YuNet outputs into faces (before NMS), clipped to the unpadded image. */
export function decodeYunet(out: YunetOutputs, padW: number, padH: number, scoreThreshold: number): Face[] {
  const faces: Face[] = [];
  for (const s of STRIDES) {
    const cols = padW / s;
    const rows = padH / s;
    const cls = out[`cls_${s}`]!.data;
    const obj = out[`obj_${s}`]!.data;
    const bbox = out[`bbox_${s}`]!.data;
    const kps = out[`kps_${s}`]!.data;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(clamp01(cls[i]!) * clamp01(obj[i]!));
        if (score < scoreThreshold) continue;
        const cx = (c + bbox[i * 4]!) * s;
        const cy = (r + bbox[i * 4 + 1]!) * s;
        const w = Math.exp(bbox[i * 4 + 2]!) * s;
        const h = Math.exp(bbox[i * 4 + 3]!) * s;
        const landmarks: Array<[number, number]> = [];
        for (let n = 0; n < 5; n++) landmarks.push([(kps[i * 10 + 2 * n]! + c) * s, (kps[i * 10 + 2 * n + 1]! + r) * s]);
        faces.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, landmarks });
      }
    }
  }
  return faces;
}

function iou(a: Face, b: Face): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

export function nms(faces: Face[], iouThreshold = 0.3, topK = 50): Face[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const keep: Face[] = [];
  for (const f of sorted) {
    if (keep.length >= topK) break;
    if (keep.every((k) => iou(k, f) <= iouThreshold)) keep.push(f);
  }
  return keep;
}

export interface YunetOptions {
  modelPath: string;
  scoreThreshold?: number;
  nmsThreshold?: number;
  /** onnxruntime intra-op threads (default 2: keep the event loop host responsive). */
  threads?: number;
}

type Ort = typeof import('onnxruntime-node');

export class YunetDetector implements FaceDetector {
  private session: Promise<{ ort: Ort; s: import('onnxruntime-node').InferenceSession }> | null = null;

  constructor(private o: YunetOptions) {}

  private load() {
    this.session ??= (async () => {
      const ort = (await import('onnxruntime-node')) as Ort;
      const s = await ort.InferenceSession.create(this.o.modelPath, {
        executionProviders: ['cpu'],
        intraOpNumThreads: this.o.threads ?? 2,
        graphOptimizationLevel: 'all',
      });
      return { ort, s };
    })().catch((e) => {
      this.session = null;
      throw e;
    });
    return this.session;
  }

  /** Load the model and run one dummy inference (the first run is several times slower). */
  async warmup(width = 640, height = 360): Promise<void> {
    await this.detect({ width, height, data: new Uint8Array(width * height * 4) });
  }

  async detect(img: RgbaImage, opts: { scoreThreshold?: number } = {}): Promise<Face[]> {
    const { ort, s } = await this.load();
    const { data, padW, padH } = toBgrPlanar(img);
    const input = new ort.Tensor('float32', data, [1, 3, padH, padW]);
    const out = (await s.run({ [s.inputNames[0]!]: input })) as unknown as YunetOutputs;
    const faces = nms(decodeYunet(out, padW, padH, opts.scoreThreshold ?? this.o.scoreThreshold ?? 0.6), this.o.nmsThreshold ?? 0.3);
    // drop detections centred in the zero padding
    return faces.filter((f) => f.x + f.w / 2 < img.width && f.y + f.h / 2 < img.height);
  }
}
