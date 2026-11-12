/**
 * Model downloads. No weights are committed: they are fetched once into the
 * models directory (Docker build, `npm run models`, or lazily on first use) and
 * verified by SHA-256.
 *
 * - YuNet face detector (OpenCV Zoo, MIT, ~230 KB).
 *   face_detection_yunet_2026may.onnx is face_detection_yunet_2023mar.onnx
 *   re-exported by OpenCV with dynamic height/width, so a 640x360 frame runs at
 *   640x384 instead of being letterboxed to 640x640.
 * - Head/upper-body fallback (OpenMMLab RTMDet-nano person detector + RTMPose-t
 *   body keypoints, Apache-2.0; the official ONNX SDK zips). The zip and the
 *   extracted .onnx are both checksummed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export interface ModelSpec {
  /** File name in the models directory. */
  file: string;
  url: string;
  /** SHA-256 of the download. */
  sha256: string;
  /** The download is a zip: extract this entry (its SHA-256 is fileSha256). */
  zipEntry?: string;
  fileSha256?: string;
  /** Env var that overrides the URL (offline mirrors; checksums still enforced). */
  urlEnv: string;
  licence: string;
}

export const YUNET = {
  file: 'face_detection_yunet_2026may.onnx',
  url: 'https://github.com/opencv/opencv_zoo/raw/26cc381e4d2594bb9f47a26eb8fd96c94a13660d/models/face_detection_yunet/face_detection_yunet_2026may.onnx',
  sha256: 'ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0',
  urlEnv: 'SWITCHY_YUNET_URL',
  licence: 'MIT (Copyright (c) 2020 Shiqi Yu), https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet',
} as const satisfies ModelSpec;

const OMM = 'https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk';

/** RTMDet-nano person detector, 320x320 (OpenMMLab, Apache-2.0). */
export const RTMDET_PERSON = {
  file: 'rtmdet_nano_person_320.onnx',
  url: `${OMM}/rtmdet_nano_8xb32-100e_coco-obj365-person-05d8511e.zip`,
  sha256: 'cb8f6d545a963167acb5a7c98307dcf8a46f7b451ee7e1d8abf2a1f81c26f59d',
  zipEntry: '20230831/rtmdet_onnx/rtmdet_nano_8xb32-100e_coco-obj365-person-05d8511e/end2end.onnx',
  fileSha256: '8297e829ccc5590c8e2d32d5a211f322a0585fb7467eec85eb12c9525b0b95d6',
  urlEnv: 'SWITCHY_RTMDET_URL',
  licence: 'Apache-2.0 (OpenMMLab mmpose/mmdet), https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose',
} as const satisfies ModelSpec;

/** RTMPose-t body keypoints (COCO-17), 256x192 SimCC (OpenMMLab, Apache-2.0). */
export const RTMPOSE_T = {
  file: 'rtmpose_t_body7_256x192.onnx',
  url: `${OMM}/rtmpose-t_simcc-body7_pt-body7_420e-256x192-026a1439_20230504.zip`,
  sha256: '937003a70832d9cc34ea16927f504792f3133e92dda1b9c626236bbbe9e805cb',
  zipEntry: '20230831/rtmpose_onnx/rtmpose-t_simcc-body7_pt-body7_420e-256x192-026a1439_20230504/end2end.onnx',
  fileSha256: 'a6c2f6a3896a4d51131d14d7a80a3d08b50f559af5a58a45d5b098aef510a70f',
  urlEnv: 'SWITCHY_RTMPOSE_URL',
  licence: 'Apache-2.0 (OpenMMLab mmpose), https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose',
} as const satisfies ModelSpec;

export function modelsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.SWITCHY_MODELS_DIR || 'models');
}

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Extract one entry (stored or deflated) from a zip buffer, via the central directory. */
export function unzipEntry(zip: Buffer, name: string): Buffer {
  // end of central directory record (no zip64: the model zips are small)
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entry = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (entry !== name) continue;
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt zip local header');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + csize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error(`unsupported zip compression method ${method}`);
  }
  throw new Error(`zip entry ${name} not found`);
}

const inflight = new Map<string, Promise<string>>();

/** Path of a verified model file, downloading (and extracting) it first if needed. */
export function ensureModel(spec: ModelSpec, dir = modelsDir(), fetchImpl: typeof fetch = fetch): Promise<string> {
  const key = `${dir}|${spec.file}`;
  let p = inflight.get(key);
  if (p) return p;
  p = (async () => {
    const file = path.join(dir, spec.file);
    const want = spec.fileSha256 ?? spec.sha256;
    if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === want) return file;
    const url = process.env[spec.urlEnv] || spec.url;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`model download failed: HTTP ${res.status} (${url})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha256(buf);
    if (got !== spec.sha256) throw new Error(`model checksum mismatch for ${spec.file}: got ${got}, expected ${spec.sha256}`);
    const body = spec.zipEntry ? unzipEntry(buf, spec.zipEntry) : buf;
    if (spec.zipEntry && sha256(body) !== want) throw new Error(`extracted model checksum mismatch for ${spec.file}`);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    return file;
  })().catch((e) => {
    inflight.delete(key);
    throw e;
  });
  inflight.set(key, p);
  return p;
}

/** Path of the verified YuNet model, downloading it first if needed. */
export function ensureYunetModel(dir = modelsDir(), fetchImpl: typeof fetch = fetch): Promise<string> {
  return ensureModel(YUNET, dir, fetchImpl);
}

/** Paths of the verified person + pose models (head/upper-body fallback). */
export async function ensurePersonModels(dir = modelsDir(), fetchImpl: typeof fetch = fetch): Promise<{ det: string; pose: string }> {
  const [det, pose] = await Promise.all([ensureModel(RTMDET_PERSON, dir, fetchImpl), ensureModel(RTMPOSE_T, dir, fetchImpl)]);
  return { det, pose };
}
