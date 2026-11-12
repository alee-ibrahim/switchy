import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import { phaseCorrelate, waitVideoStill } from '../src/engine/autoframe/phase.js';
import { decodeYunet, nms, toBgrPlanar, YunetDetector, type Face, type YunetOutputs } from '../src/engine/autoframe/yunet.js';
import { computeCorrection, pickTarget } from '../src/engine/autoframe/framing.js';
import {
  calibrate,
  calibrationFromOptions,
  coefficientsAt,
  magnification,
  zoomForMagnification,
  type Calibration,
} from '../src/engine/autoframe/calibration.js';
import { autoFrameOnce, describeRun } from '../src/engine/autoframe/refiner.js';
import { idlePosition, presetPosition, referenceZoom, withPresetPosition } from '../src/engine/autoframe/presets.js';
import { YUNET } from '../src/engine/autoframe/model.js';
import type { CameraDriver, PtzControl, PtzPosition } from '../src/engine/cameras/types.js';
import type { RgbaImage } from '../src/engine/image/jpeg.js';
import { cameraSchema, policySchema } from '../src/engine/types.js';

const FX = path.join(__dirname, 'fixtures', 'autoframe');
const PRIVATE = path.join(__dirname, 'fixtures', 'private');

function load(file: string): RgbaImage & { data: Uint8Array } {
  const d = jpeg.decode(fs.readFileSync(file), { useTArray: true, formatAsRGBA: true });
  return { width: d.width, height: d.height, data: d.data };
}

/** Crop w x h at (x, y) (clamped) from an RGBA image. */
function crop(img: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
  const out = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) {
    const sy = Math.min(img.height - 1, Math.max(0, Math.round(y) + r));
    for (let c = 0; c < w; c++) {
      const sx = Math.min(img.width - 1, Math.max(0, Math.round(x) + c));
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (r * w + c) * 4);
    }
  }
  return { width: w, height: h, data: out };
}

/** 2x nearest-neighbour upscale (a bigger "room" for the virtual camera). */
function up2(img: RgbaImage): RgbaImage {
  const w = img.width * 2;
  const h = img.height * 2;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y >> 1) * img.width + (x >> 1)) * 4;
      out.set(img.data.subarray(s, s + 4), (y * w + x) * 4);
    }
  return { width: w, height: h, data: out };
}

describe('phase correlation', () => {
  const seat = load(path.join(FX, 'seat5.jpg'));

  it('recovers synthetic shifts exactly', () => {
    for (const [dx, dy] of [
      [0, 0],
      [12, 0],
      [-30, 7],
      [45, -20],
    ] as const) {
      const a = crop(seat, 40, 30, 560, 300);
      const b = crop(seat, 40 - dx, 30 - dy, 560, 300);
      const s = phaseCorrelate(a, b);
      expect(s.dx).toBeCloseTo(dx, 0);
      expect(s.dy).toBeCloseTo(dy, 0);
    }
  });

  it('measures real P100 moves (recorded: +9 pan, +9 tilt at zoom 8202)', () => {
    // calibration at zoom 8202: -2.19 px per pan unit, +1.82..1.87 px per tilt unit (640x360)
    const pan = phaseCorrelate(seat, load(path.join(FX, 'seat5-pan+9.jpg')));
    expect(pan.dx).toBeGreaterThan(-22);
    expect(pan.dx).toBeLessThan(-16);
    expect(Math.abs(pan.dy)).toBeLessThan(2);
    const tilt = phaseCorrelate(seat, load(path.join(FX, 'seat5-tilt+9.jpg')));
    expect(tilt.dy).toBeGreaterThan(14);
    expect(tilt.dy).toBeLessThan(22);
    expect(Math.abs(tilt.dx)).toBeLessThan(3);
  });

  it('waitVideoStill returns once consecutive frames stop moving', async () => {
    const offsets = [0, 20, 35, 44, 48, 50, 50, 50, 50, 50];
    let i = 0;
    const r = await waitVideoStill(async () => crop(seat, 40 + offsets[Math.min(i++, offsets.length - 1)]!, 30, 560, 300), {
      minMs: 0,
      maxMs: 5000,
    });
    expect(r.still).toBe(true);
    expect(i).toBeGreaterThanOrEqual(8); // 50,50,50 after the last move
    expect(i).toBeLessThanOrEqual(9);
  });
});

describe('YuNet decoding', () => {
  it('converts RGBA/BGRX to planar BGR padded to multiples of 32', () => {
    const img = { width: 2, height: 1, data: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]) };
    const { data, padW, padH } = toBgrPlanar(img);
    expect([padW, padH]).toEqual([32, 32]);
    const plane = 32 * 32;
    expect([data[0], data[plane], data[2 * plane]]).toEqual([30, 20, 10]);
    expect([data[1], data[plane + 1], data[2 * plane + 1]]).toEqual([60, 50, 40]);
    const bgr = toBgrPlanar({ ...img, fourcc: 'BGRX' });
    expect([bgr.data[0], bgr.data[2 * plane]]).toEqual([10, 30]);
  });

  it('decodes one anchor into a box + landmarks and applies NMS', () => {
    const padW = 64;
    const padH = 64;
    const out: YunetOutputs = {};
    for (const s of [8, 16, 32]) {
      const n = (padW / s) * (padH / s);
      out[`cls_${s}`] = { data: new Float32Array(n) };
      out[`obj_${s}`] = { data: new Float32Array(n) };
      out[`bbox_${s}`] = { data: new Float32Array(n * 4) };
      out[`kps_${s}`] = { data: new Float32Array(n * 10) };
    }
    // stride 16, row 1, col 2 -> idx 1*4+2 = 6
    const i = 6;
    (out.cls_16!.data as Float32Array)[i] = 0.9;
    (out.obj_16!.data as Float32Array)[i] = 0.9;
    (out.bbox_16!.data as Float32Array).set([0.5, 0.25, Math.log(2), Math.log(3)], i * 4);
    (out.kps_16!.data as Float32Array).set([0, 0, 1, 0, 0.5, 0.5, 0, 1, 1, 1], i * 10);
    // a weaker duplicate at stride 8 overlapping the same face
    const j = 3 * 8 + 5; // row 3, col 5 at stride 8
    (out.cls_8!.data as Float32Array)[j] = 0.7;
    (out.obj_8!.data as Float32Array)[j] = 0.7;
    (out.bbox_8!.data as Float32Array).set([0, 0, Math.log(4), Math.log(6)], j * 4);
    const faces = decodeYunet(out, padW, padH, 0.5);
    expect(faces).toHaveLength(2);
    const kept = nms(faces);
    expect(kept).toHaveLength(1);
    const f = kept[0]!;
    expect(f.score).toBeCloseTo(0.9, 5);
    // centre (2.5*16, 1.25*16) = (40, 20), size 32x48
    expect([f.x, f.y, f.w, f.h].map((v) => Math.round(v))).toEqual([24, -4, 32, 48]);
    expect(f.landmarks[0]).toEqual([32, 16]);
    expect(f.landmarks[1]).toEqual([48, 16]);
  });
});

const face = (cx: number, cy: number, h: number, score = 0.9): Face => ({
  x: cx - h * 0.4,
  y: cy - h / 2,
  w: h * 0.8,
  h,
  score,
  // eyes at 40% of the box height
  landmarks: [
    [cx - h * 0.2, cy - h * 0.1],
    [cx + h * 0.2, cy - h * 0.1],
    [cx, cy + h * 0.1],
    [cx - h * 0.15, cy + h * 0.25],
    [cx + h * 0.15, cy + h * 0.25],
  ],
});

// measured on the room-11 P100 (2026-11-11), 640x360
const P100_CAL: Calibration = {
  points: [
    { zoom: 0, dxPerPan: -1.119e-3, dyPerTilt: 1.866e-3 },
    { zoom: 4000, dxPerPan: -1.759e-3, dyPerTilt: 2.984e-3 },
    { zoom: 8202, dxPerPan: -3.416e-3, dyPerTilt: 5.048e-3 },
    { zoom: 12000, dxPerPan: -6.604e-3, dyPerTilt: 8.961e-3 },
  ],
};

describe('framing', () => {
  const F = { width: 640, height: 360 };
  // eyes at (ex, ey): face() puts the eyes 0.1 h above its centre
  const eyes = (ex: number, ey: number, h = 72, score = 0.9) => face(ex, ey + h * 0.1, h, score);

  it('picks the plausible-size face whose eyes are nearest the target point', () => {
    const delegate = eyes(330, 125, 75);
    const background = [eyes(80, 60, 30, 0.95), eyes(560, 70, 28, 0.95), eyes(330, 40, 30)];
    expect(pickTarget([...background, delegate], 640, 360)).toBe(delegate);
    // two similar faces: the one near the centre wins, even if slightly smaller
    const centre = eyes(335, 120, 66);
    expect(pickTarget([eyes(540, 120, 75), centre], 640, 360)).toBe(centre);
    expect(pickTarget([], 640, 360)).toBeNull();
  });

  it('does nothing inside the default 8% / 10% deadband', () => {
    // 7% right, 9% below the upper third
    const c = computeCorrection(eyes(320 + 0.07 * 640, 120 + 0.09 * 360), F, 8202, P100_CAL);
    expect(c.kind).toBe('in-deadband');
    expect(c.delta).toEqual({ pan: 0, tilt: 0 });
    expect(c.zoomStep).toBe(0);
  });

  it('centres horizontally with the calibrated sign and scale', () => {
    const c = computeCorrection(eyes(320 + 0.12 * 640, 120), F, 8202, P100_CAL);
    expect(c.kind).toBe('adjust');
    expect(c.offset.x).toBeCloseTo(0.12, 3);
    // content must move left 0.12 W: pan += 0.12 / 3.416e-3 = 35
    expect(c.delta).toEqual({ pan: 35, tilt: 0 });
  });

  it('only brings the eyes back just inside the vertical band, never onto the eye line', () => {
    // 13% below the upper third: shift up by 13% - 5% = 8% of the height = 16 tilt units
    const c = computeCorrection(eyes(320, 120 + 0.13 * 360), F, 8202, P100_CAL);
    expect(c.kind).toBe('adjust');
    expect(c.delta).toEqual({ pan: 0, tilt: -16 });
    const up = computeCorrection(eyes(320, 120 - 0.12 * 360), F, 8202, P100_CAL);
    expect(up.delta.tilt).toBe(Math.round(0.07 / 5.048e-3));
  });

  it('rejects corrections beyond the 15% limit (wrong person / pre-move frame)', () => {
    const c = computeCorrection(eyes(320 + 0.2 * 640, 120), F, 8202, P100_CAL);
    expect(c.kind).toBe('too-far');
    expect(c.delta).toEqual({ pan: 0, tilt: 0 });
    expect(c.why).toMatch(/exceeds the 15%\/15% limit/);
    expect(computeCorrection(eyes(320 + 0.2 * 640, 120), F, 8202, P100_CAL, { maxCorrectionX: 0.25 }).kind).toBe('adjust');
  });

  it('zoom: off by default; when allowed, one step only for a clearly tiny or huge face', () => {
    const tiny = eyes(320, 120, 0.08 * 360);
    expect(computeCorrection(tiny, F, 8202, P100_CAL).zoomStep).toBe(0);
    expect(computeCorrection(tiny, F, 8202, P100_CAL).kind).toBe('in-deadband');
    expect(computeCorrection(tiny, F, 8202, P100_CAL, { zoom: true }).zoomStep).toBe(1);
    expect(computeCorrection(eyes(320, 120, 0.36 * 360), F, 8202, P100_CAL, { zoom: true }).zoomStep).toBe(-1);
    // the hand-framed range (13-27% in the room-11 log) is left alone
    for (const h of [0.13, 0.2, 0.27]) expect(computeCorrection(eyes(320, 120, h * 360), F, 8202, P100_CAL, { zoom: true }).zoomStep).toBe(0);
  });
});

describe('preset coordinates', () => {
  it('stores, reads and forgets per-preset positions; referenceZoom falls back to the camera option', () => {
    let o: Record<string, unknown> = { autoframe: { calibration: P100_CAL } };
    expect(referenceZoom(o, '3')).toBeNull();
    o = withPresetPosition(o, '3', { pan: -56, tilt: -59, zoom: 8202 });
    expect(presetPosition(o, '3')).toMatchObject({ pan: -56, tilt: -59, zoom: 8202 });
    expect(calibrationFromOptions(o)).not.toBeNull(); // calibration kept
    expect(referenceZoom(o, '3')).toBe(8202);
    expect(referenceZoom({ autoframe: { referenceZoom: 8000 } }, '9')).toBe(8000);
    o = withPresetPosition(o, '3', null);
    expect(presetPosition(o, '3')).toBeNull();
  });

  it('idlePosition needs three agreeing, plausible reads', async () => {
    const seq = [
      { pan: 998, tilt: -59, zoom: 998 },
      { pan: -56, tilt: -59, zoom: 8202 },
      { pan: 6428, tilt: -4096, zoom: 6428 },
      { pan: -56, tilt: -59, zoom: 8202 },
      { pan: -56, tilt: -59, zoom: 8202 },
    ];
    let i = 0;
    expect(await idlePosition({ getPosition: async () => seq[i++]! })).toEqual({ pan: -56, tilt: -59, zoom: 8202 });
    let n = 0;
    await expect(idlePosition({ getPosition: async () => ({ pan: n++, tilt: 0, zoom: 0 }) })).rejects.toThrow(/disagree/);
  });
});

describe('calibration', () => {
  it('reads options and interpolates in log space', () => {
    expect(calibrationFromOptions({})).toBeNull();
    expect(calibrationFromOptions({ autoframe: { calibration: { points: [] } } })).toBeNull();
    const cal = calibrationFromOptions({ autoframe: { calibration: { points: [...P100_CAL.points].reverse() } } })!;
    expect(cal.points[0]!.zoom).toBe(0);
    expect(coefficientsAt(cal, 8202).dxPerPan).toBeCloseTo(-3.416e-3, 6);
    const mid = coefficientsAt(cal, 10101).dxPerPan;
    expect(mid).toBeCloseTo(-Math.sqrt(3.416e-3 * 6.604e-3), 5);
    expect(coefficientsAt(cal, 99999).dxPerPan).toBe(-6.604e-3); // clamped
    const z = zoomForMagnification(cal, magnification(cal, 8202) * 1.25);
    expect(magnification(cal, z) / magnification(cal, 8202)).toBeCloseTo(1.25, 2);
  });

  it('calibrate() recovers the scale of a virtual PTZ (person-free method)', async () => {
    const vc = virtualCamera(load(path.join(FX, 'seat5.jpg')), { pxPerPan: 2, pxPerTilt: 1.5 });
    const { calibration, samples } = await calibrate({ ptz: vc.ptz, grab: vc.grab, minSettleMs: 0 }, { zooms: [8202] });
    const p = calibration.points[0]!;
    expect(p.dxPerPan * 640).toBeCloseTo(-2, 1);
    expect(p.dyPerTilt * 360).toBeCloseTo(1.5, 1);
    expect(samples.length).toBeGreaterThanOrEqual(4);
    expect(vc.pos).toMatchObject({ pan: 0, tilt: 0 }); // back where it started
  });
});

/** A PTZ looking at a 2x-upscaled room frame: pan right moves content left, tilt up moves it down. */
function virtualCamera(
  scene: RgbaImage,
  o: { pxPerPan: number; pxPerTilt: number; relativeGain?: number; positionReads?: PtzPosition[]; origin?: { pan: number; tilt: number } },
) {
  const room = up2(scene);
  const org = o.origin ?? { pan: 0, tilt: 0 };
  const pos: PtzPosition = { pan: org.pan, tilt: org.tilt, zoom: 8202 };
  const view = () => crop(room, 320 + (pos.pan - org.pan) * o.pxPerPan, 180 - (pos.tilt - org.tilt) * o.pxPerTilt, 640, 360);
  const moves: Array<{ pan: number; tilt: number }> = [];
  const relMoves: Array<{ pan: number; tilt: number }> = [];
  const zoomSteps: number[] = [];
  let reads = 0;
  const ptz: PtzControl = {
    getPosition: async () => {
      // stale/garbage replies as logged on the P100 when given, else the truth
      const r = o.positionReads ? o.positionReads[reads % o.positionReads.length]! : { ...pos };
      reads++;
      return r;
    },
    moveAbsolute: async (p) => {
      moves.push(p);
      pos.pan = p.pan;
      pos.tilt = p.tilt;
    },
    moveRelative: async (d) => {
      relMoves.push(d);
      const g = o.relativeGain ?? 1;
      pos.pan += Math.round(d.pan * g);
      pos.tilt += Math.round(d.tilt * g);
    },
    zoomTo: async (z) => {
      pos.zoom = z;
    },
    savePreset: async () => {},
    drive: async () => {},
    zoomDrive: async (dir) => {
      if (dir) zoomSteps.push(dir);
    },
    stop: async () => {},
  };
  return { ptz, pos, moves, relMoves, zoomSteps, grab: async () => view(), view, reads: () => reads };
}

describe('autoFrameOnce', () => {
  const scene = load(path.join(FX, 'seat5.jpg'));
  const PX_PAN = 3.416e-3 * 640;
  const PX_TILT = 5.048e-3 * 360;
  type Opts = {
    calibrated?: boolean;
    faces?: boolean;
    stored?: boolean;
    referenceZoom?: number;
    relativeTilt?: boolean;
    relativeGain?: number;
    positionReads?: PtzPosition[];
    faceH?: number;
    /** frames that are still moving before the camera arrives */
    movingFrames?: number;
  };
  // the delegate's eyes sit at a fixed point of the room; the detector reports them in the current view
  const setup = (eyesPx: { x: number; y: number }, opts: Opts = {}) => {
    const vc = virtualCamera(scene, {
      pxPerPan: PX_PAN,
      pxPerTilt: PX_TILT,
      relativeGain: opts.relativeGain,
      positionReads: opts.positionReads,
      origin: { pan: 284, tilt: -59 }, // preset 5 as stored
    });
    const h = opts.faceH ?? 72;
    let grabs = 0;
    const detectedAt: number[] = [];
    const detector = {
      detect: async (): Promise<Face[]> => {
        detectedAt.push(grabs);
        if (opts.faces === false) return [];
        const ex = eyesPx.x - (vc.pos.pan - 284) * PX_PAN;
        const ey = eyesPx.y + (vc.pos.tilt + 59) * PX_TILT;
        return [face(ex, ey + h * 0.1, h)];
      },
    };
    const autoframe: Record<string, unknown> = {};
    if (opts.calibrated !== false) autoframe.calibration = P100_CAL;
    if (opts.stored !== false) autoframe.presets = { '5': { pan: 284, tilt: -59, zoom: 8202 } };
    if (opts.referenceZoom) autoframe.referenceZoom = opts.referenceZoom;
    if (opts.relativeTilt) autoframe.relativeTilt = true;
    const camera = cameraSchema.parse({ id: 'p', name: 'P100', driver: 'birddog', role: 'ptz', ndiSource: 'BIRDDOG (CAM)', options: { autoframe } });
    const driver = { kind: 'fake', ptz: vc.ptz, recallPreset: async () => {}, probe: async () => ({ ok: true }) } as CameraDriver;
    const grab = async () => {
      grabs++;
      // the preset move still running: the picture slides 6 px per frame
      if (opts.movingFrames && grabs <= opts.movingFrames) return crop(up2(scene), 320 + grabs * 6, 180, 640, 360) as never;
      return vc.view() as never;
    };
    const deps = { frames: { grab }, detector: async () => detector };
    return { vc, camera, driver, deps, policy: policySchema.parse({}), detectedAt, grabs: () => grabs };
  };
  const run = (s: ReturnType<typeof setup>, extra: Partial<Parameters<typeof autoFrameOnce>[1]> = {}) =>
    autoFrameOnce(s.deps, { camera: s.camera, driver: s.driver, policy: s.policy, preset: '5', stillMaxMs: 3000, ...extra });

  it('waits for a still picture, nudges with a RELATIVE move, verifies with a second picture', async () => {
    const s = setup({ x: 320 + 0.12 * 640, y: 120 });
    const r = await run(s);
    expect(r.reason).toBe('adjusted');
    expect(s.vc.relMoves).toEqual([{ pan: 35, tilt: 0 }]);
    expect(s.vc.moves).toHaveLength(0); // never absolute
    expect(s.vc.reads()).toBe(0); // never reads the position
    expect(r.passes).toHaveLength(2);
    expect(r.passes[1]!.correction!.kind).toBe('in-deadband');
    expect(Math.abs(r.passes[1]!.correction!.offset.x)).toBeLessThan(0.01);
    expect(r.settle?.still).toBe(true);
    expect(describeRun(r)).toMatch(/pass 1: face offset x \+12\.0% y \+0\.0%.*moved relative pan \+35 tilt \+0; pass 2: .*ok; .*total \d+ ms/);
  });

  it('tilt: absolute to the STORED preset position + correction (P100 relative tilt is broken), no position read', async () => {
    const s = setup({ x: 320 + 0.12 * 640, y: 120 + 0.14 * 360 });
    const r = await run(s);
    expect(r.reason).toBe('adjusted');
    // pan +35, tilt -(0.14 - 0.05) / 5.048e-3 = -18
    expect(s.vc.moves).toEqual([{ pan: 284 + 35, tilt: -59 - 18 }]);
    expect(s.vc.relMoves).toHaveLength(0);
    expect(s.vc.reads()).toBe(0);
    expect(r.passes[0]!.via).toBe('preset');
    expect(r.passes[1]!.correction!.kind).toBe('in-deadband');
    expect(describeRun(r)).toMatch(/moved to stored preset \+ pan \+35 tilt -18/);
  });

  it('tilt without stored coordinates: skipped (pan still nudged); tilt-only case keeps the preset', async () => {
    const both = setup({ x: 320 + 0.12 * 640, y: 120 + 0.14 * 360 }, { stored: false, referenceZoom: 8202 });
    const r = await run(both);
    expect(r.reason).toBe('adjusted');
    expect(both.vc.relMoves[0]).toEqual({ pan: 35, tilt: 0 });
    expect(both.vc.moves).toHaveLength(0);
    expect(r.passes[0]!.tiltSkipped).toBe(true);
    const tiltOnly = setup({ x: 320, y: 120 + 0.14 * 360 }, { stored: false, referenceZoom: 8202 });
    const t = await run(tiltOnly);
    expect(t.reason).toBe('tilt-unavailable');
    expect([...tiltOnly.vc.moves, ...tiltOnly.vc.relMoves]).toHaveLength(0);
    // a camera with working relative tilt uses it
    const rel = setup({ x: 320, y: 120 + 0.14 * 360 }, { stored: false, referenceZoom: 8202, relativeTilt: true });
    expect((await run(rel)).reason).toBe('adjusted');
    expect(rel.vc.relMoves[0]).toEqual({ pan: 0, tilt: -18 });
  });

  it('allows one more nudge when the first fell short, then cuts (max 2 moves)', async () => {
    const s = setup({ x: 320 + 0.14 * 640, y: 120 }, { relativeGain: 0.4 });
    const r = await run(s);
    expect(r.reason).toBe('adjusted');
    expect(r.moves).toBe(2);
    expect(s.vc.relMoves).toHaveLength(2);
    expect(s.vc.relMoves[1]!.pan).toBeGreaterThan(0);
    expect(s.vc.relMoves[1]!.pan).toBeLessThan(s.vc.relMoves[0]!.pan);
    expect(r.passes).toHaveLength(2);
  });

  it('detects only after the preset move has finished (no pre-move frames)', async () => {
    const s = setup({ x: 320, y: 120 }, { movingFrames: 5 });
    const r = await run(s);
    expect(r.reason).toBe('in-deadband');
    expect(s.detectedAt).toHaveLength(1);
    expect(s.detectedAt[0]).toBeGreaterThan(5);
  });

  it('a picture that never settles is left alone', async () => {
    const s = setup({ x: 320 + 0.12 * 640, y: 120 }, { movingFrames: 1e9 });
    const r = await run(s, { stillMaxMs: 300 });
    expect(r.reason).toBe('not-still');
    expect(s.detectedAt).toHaveLength(0);
    expect(s.vc.relMoves).toHaveLength(0);
  });

  it('dry run, no face, missing calibration or missing preset zoom never move the camera', async () => {
    const s = setup({ x: 320 + 0.12 * 640, y: 120 });
    expect((await run(s, { dryRun: true })).reason).toBe('dry-run');
    const nf = setup({ x: 0, y: 0 }, { faces: false });
    expect((await run(nf)).reason).toBe('no-face');
    const nc = setup({ x: 0, y: 0 }, { calibrated: false });
    expect((await run(nc)).reason).toBe('not-calibrated');
    const nr = setup({ x: 320 + 0.12 * 640, y: 120 }, { stored: false });
    expect((await run(nr)).reason).toBe('no-reference');
    for (const x of [s, nf, nc, nr]) expect([...x.vc.relMoves, ...x.vc.moves]).toHaveLength(0);
  });

  it('honours wider deadbands from the room policy', async () => {
    const s = setup({ x: 320 + 0.09 * 640, y: 120 }); // 9% right
    expect((await run(s, { policy: policySchema.parse({ refineDeadbandPct: 10 }) })).reason).toBe('in-deadband');
    expect((await run(s)).reason).toBe('adjusted');
  });

  it('zoom steps only when enabled in the room policy, as one bounded absolute target (never a zoom drive)', async () => {
    const s = setup({ x: 320, y: 120 }, { faceH: 0.08 * 360 });
    expect((await run(s)).reason).toBe('in-deadband');
    const r = await run(s, { policy: policySchema.parse({ refineZoom: true }) });
    expect(r.reason).toBe('adjusted');
    expect(s.vc.zoomSteps).toEqual([]); // no free-running zoom drive that could miss its stop
    expect(s.vc.pos.zoom).toBeGreaterThan(8202);
    expect(s.vc.pos.zoom).toBeLessThanOrEqual(Math.round(8202 * 1.15)); // within +/-15% of the preset zoom
    const t = setup({ x: 320, y: 120 }, { faceH: 0.08 * 360 });
    await run(t, { policy: policySchema.parse({ refineZoom: true, trackZoomTolerancePct: 5 }) });
    expect(t.vc.pos.zoom).toBeLessThanOrEqual(Math.round(8202 * 1.05));
  });
});

/**
 * Replay of the 2026-11-11 21:17-21:19 room-11 test (refine on, refineZoom on,
 * deadband 5%). The old code built absolute moves on position reads taken
 * around the preset move, which were stale or garbage, and changed zoom.
 */
describe('replay: room-11 live test failures', () => {
  const scene = load(path.join(FX, 'seat5.jpg'));
  const GARBAGE: PtzPosition[] = [
    { pan: 282, tilt: -56, zoom: 6428 },
    { pan: 998, tilt: -59, zoom: 998 },
    { pan: 6428, tilt: -4096, zoom: 6428 },
    { pan: 998, tilt: -59, zoom: 6428 },
  ];
  // the policy the user had: zoom on, 5% deadband -> now the new defaults except zoom
  const liveCase = async (offset: { x: number; y: number }, faceH: number, preset: string) => {
    const vc = virtualCamera(scene, { pxPerPan: 3.416e-3 * 640, pxPerTilt: 5.048e-3 * 360, positionReads: GARBAGE, origin: { pan: 0, tilt: -59 } });
    const h = faceH * 360;
    const ex0 = 320 + offset.x * 640;
    const ey0 = 120 + offset.y * 360;
    const detector = {
      detect: async (): Promise<Face[]> => [face(ex0 - vc.pos.pan * 3.416e-3 * 640, ey0 + (vc.pos.tilt + 59) * 5.048e-3 * 360 + h * 0.1, h)],
    };
    const camera = cameraSchema.parse({
      id: 'p',
      name: 'P100',
      driver: 'birddog',
      role: 'ptz',
      ndiSource: 'BIRDDOG (CAM)',
      options: { autoframe: { calibration: P100_CAL, presets: { [preset]: { pan: 0, tilt: -59, zoom: 8202 } } } },
    });
    const driver = { kind: 'fake', ptz: vc.ptz, recallPreset: async () => {}, probe: async () => ({ ok: true }) } as CameraDriver;
    const r = await autoFrameOnce(
      { frames: { grab: async () => vc.view() as never }, detector: async () => detector },
      { camera, driver, policy: policySchema.parse({ refine: 'auto-frame', refineZoom: true }), preset },
    );
    return { r, vc };
  };

  it('seat 8 (x -0.2%, y -4.9%, face 24%): already well framed, no move, no zoom (was zoom -1477)', async () => {
    const { r, vc } = await liveCase({ x: -0.002, y: -0.049 }, 0.24, '8');
    expect(r.reason).toBe('in-deadband');
    expect([...vc.relMoves, ...vc.moves, ...vc.zoomSteps]).toHaveLength(0);
    expect(vc.pos.zoom).toBe(8202);
  });

  it('seat 6 (x +35.5%): wrong person or pre-move frame, rejected (was pan +176 and zoom +1477)', async () => {
    const { r, vc } = await liveCase({ x: 0.355, y: -0.019 }, 0.13, '6');
    expect(r.reason).toBe('too-far');
    expect(describeRun(r)).toMatch(/exceeds the 15%\/15% limit: probably not the seated delegate, kept the preset/);
    expect([...vc.relMoves, ...vc.moves, ...vc.zoomSteps]).toHaveLength(0);
  });

  it('seat 9 (position reads disagree): no reads needed, a slightly-off delegate is nudged relatively', async () => {
    const { r, vc } = await liveCase({ x: 0.1, y: 0.02 }, 0.2, '9');
    expect(r.reason).toBe('adjusted');
    expect(vc.reads()).toBe(0);
    expect(vc.moves).toHaveLength(0);
    expect(vc.relMoves[0]).toEqual({ pan: Math.round(-0.1 / -3.416e-3), tilt: 0 });
  });

  it('chair (y -25.1%): rejected instead of tilting +41 from a stale pan 998', async () => {
    const { r, vc } = await liveCase({ x: -0.021, y: -0.251 }, 0.27, '3');
    expect(r.reason).toBe('too-far');
    expect([...vc.relMoves, ...vc.moves, ...vc.zoomSteps]).toHaveLength(0);
  });
});

// Real YuNet on recorded frames. Frames with people are not in the public repo
// (test/fixtures/private, git-ignored), and the model is downloaded on demand,
// so this only runs where both are present.
const modelFile = path.join(process.cwd(), 'models', YUNET.file);
const havePrivate = fs.existsSync(path.join(PRIVATE, 'seated-seat5.jpg')) && fs.existsSync(modelFile);
describe.skipIf(!havePrivate)('YuNet on recorded room-11 frames (local only)', () => {
  it('finds the seated delegate and is fast at 640x360', async () => {
    const d = new YunetDetector({ modelPath: modelFile });
    await d.warmup();
    const img = load(path.join(PRIVATE, 'seated-seat5.jpg'));
    const t: number[] = [];
    let faces: Face[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      faces = await d.detect(img);
      t.push(performance.now() - t0);
    }
    t.sort((a, b) => a - b);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.x).toBeGreaterThan(140);
    expect(faces[0]!.x).toBeLessThan(190);
    expect(t[5]).toBeLessThan(100);
    // empty room: no false positives
    expect(await d.detect(load(path.join(FX, 'seat5.jpg')))).toHaveLength(0);
  });

  it('picks the standing/near person, not the people at the desks behind', async () => {
    const d = new YunetDetector({ modelPath: modelFile });
    const img = load(path.join(PRIVATE, 'room-desks-1280.jpg'));
    const faces = await d.detect(img);
    expect(faces.length).toBeGreaterThanOrEqual(3);
    const t = pickTarget(faces, img.width, img.height)!;
    expect(t.h).toBe(Math.max(...faces.map((f) => f.h)));
  });
});
