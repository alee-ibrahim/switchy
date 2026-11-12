/**
 * Round 3 (live test room) follow-ups:
 *  1. per-seat learned correction (median of the last good turns, capped,
 *     used from 2 samples, reset; the camera preset is never touched);
 *  2. headroom-aware tilt: seat 10 flipped wide/PTZ with "head cut off at the
 *     top" while the eyes sat inside the vertical deadzone (big face, eyes
 *     ~12% above the eye line, headroom 3-5% around the gate thresholds);
 *  3. sharpness gate: no cut to the PTZ while the head region is blurry
 *     relative to the seat's recent sharp baseline.
 * No images of people: faces are synthetic boxes, frames are synthetic texture.
 */
import { describe, expect, it } from 'vitest';
import {
  describeCorrection,
  iqr,
  learnedCorrection,
  offsetToUnits,
  SeatLearning,
  type LearnPersistence,
  type LearnSample,
  type SeatLearnRecord,
} from '../src/engine/autoframe/learn.js';
import { headSharpness, SharpnessBaselines } from '../src/engine/autoframe/sharpness.js';
import { gateThresholds, judgeShot, ProgramGate, type ShotObservation } from '../src/engine/autoframe/shot-gate.js';
import { P100_RATES, TrackController, type TrackCommand } from '../src/engine/autoframe/track-controller.js';
import { createTracker, trackSettings } from '../src/engine/autoframe/tracker.js';
import { coefficientsAt } from '../src/engine/autoframe/calibration.js';
import type { Face } from '../src/engine/autoframe/yunet.js';
import type { CameraDriver, PtzControl, PtzPosition } from '../src/engine/cameras/types.js';
import type { TrackContext } from '../src/engine/room/controller.js';
import { cameraSchema, policySchema, type RoomConfig, type RoomPolicy } from '../src/engine/types.js';

const W = 640;
const H = 360;
const EYE = 1 / 3;
const policy = policySchema.parse({});

/** test-room P100 calibration and stored preset 6 */
const CAL = {
  points: [
    { zoom: 0, dxPerPan: -1.119e-3, dyPerTilt: 1.866e-3 },
    { zoom: 4000, dxPerPan: -1.759e-3, dyPerTilt: 2.984e-3 },
    { zoom: 8202, dxPerPan: -3.416e-3, dyPerTilt: 5.048e-3 },
    { zoom: 12000, dxPerPan: -6.604e-3, dyPerTilt: 8.961e-3 },
  ],
};
const P6 = { pan: 439, tilt: -59, zoom: 8202 };
const COEF = coefficientsAt(CAL, P6.zoom);

function face(x: number, y: number, h: number, w = W, hh = H, score = 0.9): Face {
  const hp = h * hh;
  const cx = x * w;
  const ey = y * hh;
  return {
    x: cx - hp * 0.4,
    y: ey - hp * 0.4,
    w: hp * 0.8,
    h: hp,
    score,
    landmarks: [
      [cx - hp * 0.18, ey],
      [cx + hp * 0.18, ey],
      [cx, ey + hp * 0.2],
      [cx - hp * 0.15, ey + hp * 0.4],
      [cx + hp * 0.15, ey + hp * 0.4],
    ],
  };
}

const sample = (x: number, y: number): LearnSample => {
  const u = offsetToUnits(CAL, P6.zoom, x, y);
  return { ...u, x, y, ticks: 50, at: '2026-11-11T00:00:00Z' };
};

// ------------------------------------------------------------------ 1. learning maths and store

describe('learned correction: maths', () => {
  it('units: aiming right/down converts through the calibration at the preset zoom (signs as the auto-frame correction)', () => {
    const u = offsetToUnits(CAL, P6.zoom, 0.05, -0.03);
    // scene must move left by 5%: dxPerPan < 0 -> pan +
    expect(u.pan).toBe(Math.round(0.05 / 3.416e-3));
    // aim up 3%: scene moves down by 3%: dyPerTilt > 0 -> tilt +
    expect(u.tilt).toBe(Math.round(0.03 / 5.048e-3));
  });

  it('nothing below 2 samples; then the median per axis', () => {
    expect(learnedCorrection([sample(0.04, 0.01)], { cap: 0.1, coef: COEF })).toBeNull();
    const c = learnedCorrection([sample(0.04, 0.01), sample(0.02, -0.02), sample(0.09, 0.0)], { cap: 0.1, coef: COEF })!;
    expect(c.n).toBe(3);
    expect(c.pan).toBe(sample(0.04, 0).pan); // median of 0.02, 0.04, 0.09
    expect(c.x).toBeCloseTo(0.04, 2);
    expect(c.y).toBeCloseTo(0, 2);
    expect(c.capped).toBe(false);
    // even count: mean of the middle two
    const d = learnedCorrection([sample(0.02, 0), sample(0.04, 0)], { cap: 0.1, coef: COEF })!;
    expect(d.x).toBeCloseTo(0.03, 2);
    expect(describeCorrection(d)).toMatch(/^\+3\.\d% x, [+-]0\.0% y \(pan \+9, tilt [+-]?0; 2 turns\)$/);
  });

  it('capped per axis at the cap % of the frame (units scaled with it)', () => {
    const c = learnedCorrection([sample(0.2, -0.15), sample(0.22, -0.16)], { cap: 0.1, coef: COEF })!;
    expect(c.capped).toBe(true);
    expect(c.x).toBeCloseTo(0.1, 5);
    expect(c.y).toBeCloseTo(-0.1, 5);
    expect(-c.pan * COEF.dxPerPan).toBeCloseTo(0.1, 2);
    expect(-c.tilt * COEF.dyPerTilt).toBeCloseTo(-0.1, 2);
  });

  it('a single wild turn does not move the median', () => {
    const c = learnedCorrection([sample(0.03, 0), sample(0.03, 0.01), sample(0.25, -0.2), sample(0.035, 0.0), sample(0.025, 0.005)], {
      cap: 0.1,
      coef: COEF,
    })!;
    expect(c.x).toBeCloseTo(0.03, 2);
  });
});

function memPersistence(): LearnPersistence & { rows: Map<string, SeatLearnRecord>; removed: string[] } {
  const rows = new Map<string, SeatLearnRecord>();
  const removed: string[] = [];
  return {
    rows,
    removed,
    load: async () => [...rows.values()],
    save: async (r) => void rows.set(`${r.roomId}|${r.unit}`, structuredClone(r)),
    remove: async (roomId, unit) => {
      removed.push(`${roomId}|${unit ?? '*'}`);
      for (const [k, r] of rows) if (r.roomId === roomId && (unit === undefined || r.unit === unit)) rows.delete(k);
    },
  };
}

describe('learned correction: store', () => {
  it('keeps the last N samples per seat, written through; reload restores them', async () => {
    const p = memPersistence();
    const l = new SeatLearning(p);
    for (let i = 0; i < 7; i++) l.add('r', 6, 'ptz', '6', P6, sample(0.01 * i, 0), 5);
    await l.flush();
    expect(l.get('r', 6, 'ptz', '6', P6)!.samples.map((s) => s.x)).toEqual([0.02, 0.03, 0.04, 0.05, 0.06].map((v) => expect.closeTo(v, 5)));
    const l2 = new SeatLearning(p);
    await l2.init();
    expect(l2.get('r', 6, 'ptz', '6', P6)!.samples).toHaveLength(5);
  });

  it('samples belong to a camera, preset and stored preset position: a re-saved preset starts over', () => {
    const l = new SeatLearning();
    l.add('r', 6, 'ptz', '6', P6, sample(0.05, 0), 5);
    l.add('r', 6, 'ptz', '6', P6, sample(0.05, 0), 5);
    expect(l.get('r', 6, 'ptz', '6', { ...P6, pan: 500 })).toBeNull();
    expect(l.get('r', 6, 'ptz', '7', P6)).toBeNull();
    l.add('r', 6, 'ptz', '6', { ...P6, pan: 500 }, sample(0.01, 0), 5);
    expect(l.get('r', 6, 'ptz', '6', { ...P6, pan: 500 })!.samples).toHaveLength(1);
  });

  it('reset one seat, or the whole room (other rooms untouched)', async () => {
    const p = memPersistence();
    const l = new SeatLearning(p);
    l.add('r', 6, 'ptz', '6', P6, sample(0.05, 0), 5);
    l.add('r', 7, 'ptz', '7', P6, sample(0.05, 0), 5);
    l.add('r', 8, 'ptz', '8', P6, sample(0.05, 0), 5);
    l.add('other', 6, 'ptz', '6', P6, sample(0.05, 0), 5);
    expect(l.reset('r', 6)).toBe(1);
    expect(l.get('r', 6, 'ptz', '6', P6)).toBeNull();
    expect(l.list('r').map((r) => r.unit)).toEqual([7, 8]);
    expect(l.reset('r')).toBe(2);
    expect(l.list('r')).toEqual([]);
    expect(l.list('other')).toHaveLength(1);
    await l.flush();
    expect(p.removed).toEqual(['r|6', 'r|*']);
    expect([...p.rows.keys()]).toEqual(['other|6']);
  });
});

// ------------------------------------------------------------------ 1b. learning in the tracking session

interface Cam {
  pos: PtzPosition;
  calls: string[];
  driver: CameraDriver;
}

/** Fake P100: records every command; moves follow at once (no motion in the synthetic picture). */
function fakeCam(): Cam {
  const pos = { ...P6 };
  const calls: string[] = [];
  const ptz: PtzControl = {
    getPosition: async () => ({ ...pos }),
    moveAbsolute: async (p) => {
      calls.push(`moveAbsolute ${p.pan},${p.tilt}`);
      Object.assign(pos, p);
    },
    moveRelative: async (d) => {
      calls.push(`moveRelative ${d.pan},${d.tilt}`);
      pos.pan += d.pan;
      pos.tilt += d.tilt;
    },
    zoomTo: async (z) => void calls.push(`zoomTo ${z}`),
    savePreset: async (p) => void calls.push(`ptz.savePreset ${p}`),
    drive: async (d) => void calls.push(d.pan || d.tilt ? `drive ${d.pan},${d.tilt}` : 'stop'),
    zoomDrive: async (d) => void calls.push(`zoom ${d}`),
    stop: async () => void calls.push('stop-all'),
  };
  const driver: CameraDriver = {
    kind: 'fake',
    ptz,
    recallPreset: async (p) => {
      calls.push(`recall ${p}`);
      Object.assign(pos, P6);
    },
    savePreset: async (p) => void calls.push(`savePreset ${p}`),
    probe: async () => ({ ok: true }),
  };
  return { pos, calls, driver };
}

function texture(w = 128, h = 72) {
  const data = new Uint8Array(w * h * 4);
  let s = 7;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const v = s >>> 24;
    data.set([v, v, v, 255], i * 4);
  }
  return { width: w, height: h, data };
}

function ctxFor(cam: Cam, policyOver: Partial<RoomPolicy>, logs: string[]): TrackContext {
  const camera = cameraSchema.parse({
    id: 'ptz',
    name: 'P100',
    driver: 'birddog',
    role: 'ptz',
    ndiSource: 'CAM',
    options: { autoframe: { calibration: CAL, presets: { '6': P6 } } },
  });
  const room: RoomConfig = {
    id: 'r',
    name: 'r',
    enabled: true,
    dcenHost: '',
    dcenPort: 3225,
    outputName: 'o',
    outputMode: 'route',
    cameras: [camera],
    seats: [{ unit: 6, label: 'Seat 6', cameraId: 'ptz', preset: '6' }],
    policy: policySchema.parse({ refine: 'track', ...policyOver }),
  };
  return {
    room,
    camera,
    driver: cam.driver,
    shot: { cameraId: 'ptz', preset: '6', reason: 'seat Seat 6', unit: 6 },
    signal: new AbortController().signal,
    onState: () => {},
    log: (_l, m) => logs.push(m),
  };
}

const waitFor = async (cond: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('learned correction: turn spread', () => {
  it('iqr: interquartile range, robust to a few outliers', () => {
    expect(iqr([])).toBe(0);
    expect(iqr([0.2])).toBe(0);
    expect(iqr([0.19, 0.2, 0.21, 0.2, 0.2])).toBeCloseTo(0, 6);
    expect(iqr([1, 2, 3, 4, 5])).toBe(2);
    // one standing-up spike does not widen the spread
    expect(iqr([0.2, 0.2, 0.21, 0.2, 0.19, 0.2, 0.2, 0.6])).toBeLessThan(0.02);
    // half the turn elsewhere does
    expect(iqr([0.05, 0.05, 0.05, 0.05, 0.25, 0.25, 0.25, 0.25])).toBeGreaterThan(0.15);
  });
});

describe('learned correction: tracking session', () => {
  const img = texture();
  const frames = { grab: async () => img as never };
  const fast = { periodMs: 20, recallStillMinMs: 0, positionCheckMs: 200, idleReadAfterMs: 100, learnMinGoodMs: 600 };
  /** the delegate sits 6% right of the preset aim, eyes on the eye line (inside the deadzone: no tracking move) */
  const seated = { detect: async () => [face(0.56, EYE, 0.22, 128, 72)] };

  async function turn(learning: SeatLearning, cam: Cam, opts: { reason?: string; ms?: number; detect?: typeof seated; policy?: Partial<RoomPolicy> } = {}) {
    const logs: string[] = [];
    const ctx = ctxFor(cam, opts.policy ?? {}, logs);
    const optionsBefore = structuredClone(ctx.camera.options);
    const tracker = createTracker({ frames, detector: async () => opts.detect ?? seated, ...fast, learning });
    const s = tracker(ctx);
    await waitFor(() => logs.some((l) => /target acquired/.test(l)));
    await sleep(opts.ms ?? 1400);
    await s.stop(opts.reason ?? 'speaker changed');
    await learning.flush();
    // the preset and its stored coordinates are never touched by learning
    expect(ctx.camera.options).toEqual(optionsBefore);
    expect(cam.calls.filter((c) => /savePreset/.test(c))).toEqual([]);
    return logs;
  }

  it('two good turns teach the seat; the third starts with one move by the median, then tracks', async () => {
    const learning = new SeatLearning(memPersistence());
    const cam = fakeCam();
    const l1 = await turn(learning, cam);
    expect(l1.some((l) => /learned correction for seat 6: turn sample \+6\.0% x, [+-]0\.0% y .* stored \(1 of 2 needed\)/.test(l))).toBe(true);
    expect(cam.calls.some((c) => c.startsWith('move'))).toBe(false); // nothing learnt yet: no correction move
    const l2 = await turn(learning, cam);
    expect(l2.some((l) => /learned correction for seat 6: \+6\.\d% x, [+-]0\.0% y \(pan \+18, tilt [+-]?0; 2 turns\)/.test(l))).toBe(true);
    cam.calls.length = 0;
    const l3 = await turn(learning, cam);
    expect(l3.some((l) => /learned correction for seat 6: \+6\.\d% x.*applied after the recall/.test(l))).toBe(true);
    // pan only: one RELATIVE move, before any tracking drive
    const moves = cam.calls.filter((c) => c.startsWith('move'));
    expect(moves).toEqual(['moveRelative 18,0']);
    const iMove = cam.calls.indexOf('moveRelative 18,0');
    const iDrive = cam.calls.findIndex((c) => c.startsWith('drive'));
    expect(iDrive === -1 || iDrive > iMove).toBe(true);
    expect(learning.get('r', 6, 'ptz', '6', P6)!.samples).toHaveLength(3);
  });

  it('a tilt correction is one ABSOLUTE move to the stored preset tilt + correction (P100 relative tilt is broken)', async () => {
    const learning = new SeatLearning();
    learning.add('r', 6, 'ptz', '6', P6, sample(0.04, -0.03), 5);
    learning.add('r', 6, 'ptz', '6', P6, sample(0.04, -0.03), 5);
    const cam = fakeCam();
    await turn(learning, cam, { ms: 300 });
    const u = offsetToUnits(CAL, P6.zoom, 0.04, -0.03);
    expect(cam.calls.filter((c) => c.startsWith('move'))).toEqual([`moveAbsolute ${P6.pan + u.pan},${P6.tilt + u.tilt}`]);
  });

  it('the cap applies to what is sent', async () => {
    const learning = new SeatLearning();
    learning.add('r', 6, 'ptz', '6', P6, sample(0.3, 0), 5);
    learning.add('r', 6, 'ptz', '6', P6, sample(0.3, 0), 5);
    const cam = fakeCam();
    await turn(learning, cam, { ms: 300, policy: { trackLearnCapPct: 5 } });
    expect(cam.calls.filter((c) => c.startsWith('move'))).toEqual([`moveRelative ${Math.round(0.05 / 3.416e-3)},0`]);
  });

  it('off, a manual stop, a turn too short, or a lost target at the end: nothing learnt, nothing applied', async () => {
    const off = new SeatLearning();
    off.add('r', 6, 'ptz', '6', P6, sample(0.05, 0), 5);
    off.add('r', 6, 'ptz', '6', P6, sample(0.05, 0), 5);
    const cam = fakeCam();
    await turn(off, cam, { policy: { trackLearn: false } });
    expect(cam.calls.some((c) => c.startsWith('move'))).toBe(false);
    expect(off.get('r', 6, 'ptz', '6', P6)!.samples).toHaveLength(2);

    const l = new SeatLearning();
    const logs = await turn(l, fakeCam(), { reason: 'paused' });
    expect(logs).toContain('P100: seat 6 turn not learned: ended: paused');
    await turn(l, fakeCam(), { ms: 100 });
    expect(l.list('r')).toEqual([]);
    // face gone 1.5 s before the end: target lost / holding
    let t0 = 0;
    const leaving = { detect: async () => ((t0 ||= Date.now()), Date.now() - t0 < 900 ? [face(0.56, EYE, 0.22, 128, 72)] : []) };
    const lg = await turn(l, fakeCam(), { detect: leaving, ms: 2500 });
    expect(lg.some((x) => /seat 6 turn not learned: target (lost|holding) at the end/.test(x))).toBe(true);
    expect(l.list('r')).toEqual([]);
  }, 20_000);

  it('a large but steady offset (23% right, beyond the old 20% rule) is learnt; the applied move stays capped', async () => {
    const l = new SeatLearning();
    const cam = fakeCam();
    // wide deadzone: the tracker does not move, the delegate stays 23% right of the preset aim
    const far = { detect: async () => [face(0.73, EYE, 0.22, 128, 72)] };
    const policy = { trackDeadzoneXPct: 30, trackLearnCapPct: 15 };
    const l1 = await turn(l, cam, { detect: far, policy });
    expect(l1.some((x) => /learned correction for seat 6: turn sample \+23\.0% x, [+-]0\.0% y over \d+ frames, spread x 0\.0% y 0\.0% stored/.test(x))).toBe(true);
    await turn(l, cam, { detect: far, policy });
    cam.calls.length = 0;
    const l3 = await turn(l, cam, { detect: far, policy, ms: 300 });
    expect(l3.some((x) => /learned correction for seat 6: \+15\.0% x.*capped\); applied after the recall/.test(x))).toBe(true);
    expect(cam.calls.filter((c) => c.startsWith('move'))).toEqual([`moveRelative ${Math.round(0.15 / 3.416e-3)},0`]);
  });

  it('a person beyond the outer limit (trackLearnMaxOffsetPct) is not sampled; one line says why', async () => {
    const l = new SeatLearning();
    const logs = await turn(l, fakeCam(), { policy: { trackLearnMaxOffsetPct: 5 } });
    expect(l.list('r')).toEqual([]);
    expect(logs).toContainEqual(
      expect.stringMatching(/^P100: seat 6 turn not learned: shot good for 0\.0 s < 0\.6 s \(\d\.\d s with offset beyond the 5% limit, up to x \+6\.0% y [+-]0\.0%\)$/),
    );
  });

  it('an offset that is not steady during the turn (spread above trackLearnMaxSpreadPct) is not learnt', async () => {
    const l = new SeatLearning();
    let t0 = 0;
    // half the turn 5% left, then 12% right (a swap / leaning out): IQR ~17%
    const moving = { detect: async () => ((t0 ||= Date.now()), [face(Date.now() - t0 < 1200 ? 0.45 : 0.62, EYE, 0.22, 128, 72)]) };
    const logs = await turn(l, fakeCam(), { detect: moving, ms: 2600, policy: { trackDeadzoneXPct: 30 } });
    expect(l.list('r')).toEqual([]);
    expect(logs).toContainEqual(expect.stringMatching(/seat 6 turn not learned: offset not steady: spread \(IQR\) x 1\d\.\d% y 0\.0% > 8% over \d+ frames/));
  }, 10_000);
});

// ------------------------------------------------------------------ 2. headroom-aware tilt

/**
 * Camera + controller + shot gate. Person eye at world (x, y(t)) in preset
 * frame fractions; the camera view offset follows the drive commands with
 * command latency and an 80 ms speed time constant; frames are frameLat old.
 */
function simulateGate(o: { y: (t: number) => number; x?: number; h: number; ms: number; settings?: Parameters<typeof trackSettings>[0] | null; headroom?: boolean }) {
  const settings = { ...trackSettings(policy, cameraSchema.parse({ id: 'p', name: 'p', driver: 'birddog', role: 'ptz' })) };
  if (o.headroom === false) settings.headroomTrigger = 0;
  const ctl = new TrackController(settings);
  ctl.setMaxLevel(policy.trackMaxSpeed);
  const gate = new ProgramGate(
    { lostToWideMs: 700, badToWideMs: 700, holdMs: 400, minDwellMs: 2000 },
    gateThresholds(policy, false),
    gateThresholds(policy, true),
    -10_000,
  );
  const cam = { cy: 0, vy: 0, cx: 0, vx: 0 };
  const hist: Array<{ t: number; cx: number; cy: number }> = [];
  const pending: Array<{ at: number; cmd: TrackCommand }> = [];
  let active: TrackCommand = { pan: { dir: 0, level: 0 }, tilt: { dir: 0, level: 0 }, zoom: 0 };
  const cuts: Array<{ t: number; to: string; reason: string }> = [];
  let prev: { cx: number; cy: number } | null = null;
  const headrooms: number[] = [];
  let next = 0;
  for (let t = 0; t <= o.ms; t += 10) {
    while (pending.length && pending[0]!.at <= t) active = pending.shift()!.cmd;
    const tvx = active.pan.dir * (P100_RATES.pan[active.pan.level] ?? 0);
    const tvy = -active.tilt.dir * (P100_RATES.tilt[active.tilt.level] ?? 0);
    const k = 1 - Math.exp(-10 / 80);
    cam.vx += (tvx - cam.vx) * k;
    cam.vy += (tvy - cam.vy) * k;
    cam.cx += cam.vx / 100;
    cam.cy += cam.vy / 100;
    hist.push({ t, cx: cam.cx, cy: cam.cy });
    if (t < next) continue;
    next = t + 100;
    const ft = t - 120;
    const fc = [...hist].reverse().find((p) => p.t <= ft) ?? { cx: 0, cy: 0 };
    const ex = (o.x ?? 0.5) - fc.cx;
    const ey = o.y(ft) - fc.cy;
    const f = face(ex, ey, o.h);
    const shift = prev ? { dx: -(fc.cx - prev.cx), dy: -(fc.cy - prev.cy), peak: 20 } : null;
    prev = { cx: fc.cx, cy: fc.cy };
    const out = ctl.step({ t, width: W, height: H, faces: [f], shift });
    pending.push({ at: t + 200, cmd: out.cmd });
    const ob = ctl.observe(t);
    if (ob.box && t > 3000) headrooms.push(ob.box.y - 0.3 * ob.box.h);
    const a = gate.update(ob);
    if (a) {
      cuts.push({ t, to: a.to, reason: a.reason });
      gate.switched(a.to === 'ptz', t);
    }
  }
  if (process.env.TRACK_SIM_REPORT) {
    console.log(`gate sim (headroom rule ${settings.headroomTrigger ? 'on' : 'off'}): ${cuts.length} cuts [${cuts.map((c) => `${(c.t / 1000).toFixed(1)}s ${c.to}`).join(', ')}], tilt starts ${ctl.stats.starts}, min headroom ${(Math.min(...headrooms) * 100).toFixed(1)}%`);
  }
  return { cuts, ctl, headrooms, minHeadroom: Math.min(...headrooms), cam };
}

describe('headroom-aware tilt (round 3 seat 10 flip-flop)', () => {
  /**
   * Round 3 seat 10 (eval run-r3 18:31:40-18:32:07, frames 941-985): face
   * 21-29% high, eyes at 19-24% of the frame (9-14% above the eye line, at or
   * inside the 12% vertical deadzone), headroom 3-5%: right at the gate's cut
   * (5%) and stay (3%) thresholds. Leaning a little moved it across them.
   * Here: face 29%, eyes 22-26% (7-11% high, inside the deadzone), headroom 2-6%.
   */
  const bob = (t: number) => 0.24 + 0.02 * Math.sin((2 * Math.PI * t) / 3500);

  it('old behaviour reproduced: eyes inside the deadzone, no tilt, the gate flips wide/PTZ', () => {
    const r = simulateGate({ y: bob, h: 0.29, ms: 40_000, headroom: false });
    expect(r.ctl.stats.starts).toBe(0); // never tilts: the eyes never leave the 12% band
    expect(r.cuts.length).toBeGreaterThanOrEqual(6);
    expect(r.cuts.filter((c) => c.to === 'wide').every((c) => /headroom|head cut off/.test(c.reason))).toBe(true);
    expect(r.minHeadroom).toBeLessThan(0.03);
  });

  it('fixed: the tracker tilts up as soon as the headroom gets short; one cut to the PTZ and it stays', () => {
    const r = simulateGate({ y: bob, h: 0.29, ms: 40_000 });
    expect(r.cuts.map((c) => c.to)).toEqual(['ptz']);
    expect(r.minHeadroom).toBeGreaterThan(0.04);
    expect(r.ctl.stats.reversals).toBeLessThanOrEqual(2);
    expect(r.ctl.stats.starts).toBeLessThanOrEqual(6); // calm: a few short tilts, no hunting
  });

  it('a static big face (29%) with eyes 11% high: tilts once to comfortable headroom, eyes stay above the lower band', () => {
    const r = simulateGate({ y: () => EYE - 0.11, h: 0.29, ms: 12_000 });
    expect(r.cuts.map((c) => c.to)).toEqual(['ptz']);
    const last = r.headrooms[r.headrooms.length - 1]!;
    expect(last).toBeGreaterThan(0.07);
    expect(last).toBeLessThan(0.14);
    // eye line never pushed below the inner band
    const eyeY = EYE - 0.11 - r.cam.cy;
    expect(eyeY).toBeLessThan(EYE + 0.12 * 0.4 + 0.02);
    expect(r.ctl.stats.starts).toBe(1);
  });

  it('too much headroom keeps the tolerant deadzone (no extra moves); normal seated shots are unchanged', () => {
    // eyes 10% low (lots of headroom): inside the deadzone, no move with or without the rule
    const low = simulateGate({ y: () => EYE + 0.1, h: 0.2, ms: 8000 });
    expect(low.ctl.stats.starts).toBe(0);
    // a typical seated delegate (face 22%, eyes 8% high, headroom 10%): no move either
    const typical = simulateGate({ y: () => EYE - 0.08, h: 0.22, ms: 8000 });
    expect(typical.ctl.stats.starts).toBe(0);
    expect(typical.cuts.map((c) => c.to)).toEqual(['ptz']);
  });

  it('settings follow the room headroom: trigger at the stay threshold + 2%, comfortable at the cut threshold + 5%', () => {
    const cam = cameraSchema.parse({ id: 'p', name: 'p', driver: 'birddog', role: 'ptz' });
    const s = trackSettings(policy, cam);
    expect(s.headroomTrigger).toBeCloseTo(0.05);
    expect(s.headroomComfort).toBeCloseTo(0.1);
    const s8 = trackSettings({ ...policy, trackHeadroomPct: 8 }, cam);
    expect(s8.headroomTrigger).toBeCloseTo(0.08);
    expect(s8.headroomComfort).toBeCloseTo(0.13);
  });
});

// ------------------------------------------------------------------ 3. sharpness gate

function checker(w: number, h: number, blur = 0) {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = ((x >> 2) + (y >> 2)) % 2 ? 220 : 30;
  let a = g;
  for (let i = 0; i < blur; i++) {
    const b = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += a[(y + dy) * w + x + dx]!;
        b[y * w + x] = s / 9;
      }
    a = b;
  }
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([a[i]!, a[i]!, a[i]!, 255], i * 4);
  return { width: w, height: h, data };
}

describe('sharpness gate', () => {
  const box = { x: 0.4, y: 0.25, w: 0.15, h: 0.25 };

  it('Laplacian variance of the head region drops with blur', () => {
    const sharp = headSharpness(checker(320, 180), box)!;
    const soft = headSharpness(checker(320, 180, 2), box)!;
    const softer = headSharpness(checker(320, 180, 4), box)!;
    expect(sharp).toBeGreaterThan(soft * 3);
    expect(soft).toBeGreaterThan(softer);
    expect(headSharpness(checker(320, 180), { x: 0.5, y: 0.5, w: 0.01, h: 0.01 })).toBeNull();
  });

  it('per-seat baseline: none until enough samples, then a high percentile of the recent values', () => {
    const b = new SharpnessBaselines({ minSamples: 5, keep: 10, percentile: 0.75 });
    for (let i = 1; i <= 4; i++) b.add('s', i * 100);
    expect(b.baseline('s')).toBeNull();
    b.add('s', 500);
    expect(b.baseline('s')).toBe(400);
    for (let i = 0; i < 20; i++) b.add('s', 50);
    expect(b.baseline('s')).toBe(50); // only the recent values count
    expect(b.baseline('other')).toBeNull();
  });

  const o = (t: number, value: number | null, baseline: number | null): ShotObservation => {
    const h = 0.22;
    const w = (h * 0.8 * H) / W;
    return {
      t,
      state: 'locked',
      lostMs: 0,
      box: { x: 0.5 - w / 2, y: EYE - 0.4 * h, w, h },
      eye: { x: 0.5, y: EYE },
      source: 'face',
      speed: 0,
      sharp: value === null ? null : { value, baseline },
    };
  };

  it('blocks the cut while the head is far softer than the seat usually is; never without a baseline', () => {
    const strict = gateThresholds(policy, false);
    expect(strict.minSharpRatio).toBeCloseTo(0.3);
    expect(judgeShot(o(0, 80, 400), strict)).toMatchObject({ good: false, reason: "head blurry (sharpness 20% of this seat's usual)" });
    expect(judgeShot(o(0, 130, 400), strict).good).toBe(true); // 33%: normal variation passes
    expect(judgeShot(o(0, 10, null), strict).good).toBe(true); // no baseline yet
    expect(judgeShot(o(0, null, null), strict).good).toBe(true);
    expect(gateThresholds({ ...policy, trackBlurRatioPct: 0 }, false).minSharpRatio).toBe(0);
  });

  it('a soft picture never takes the PTZ off program (loose thresholds ignore it); the cut waits for a sharp picture', () => {
    const loose = gateThresholds(policy, true);
    expect(judgeShot(o(0, 10, 400), loose).good).toBe(true);
    const g = new ProgramGate({ lostToWideMs: 700, badToWideMs: 700, holdMs: 400, minDwellMs: 2000 }, gateThresholds(policy, false), loose, -10_000);
    const cuts: string[] = [];
    // blurry after the move (0-1500 ms), then sharp
    for (let t = 0; t < 4000; t += 100) {
      const a = g.update(o(t, t < 1500 ? 60 : 420, 400));
      if (a) {
        cuts.push(`${t} ${a.to}`);
        g.switched(a.to === 'ptz', t);
      }
    }
    expect(cuts).toEqual(['1900 ptz']);
    // on the PTZ: blur again for 3 s -> stays
    for (let t = 4000; t < 7000; t += 100) {
      const a = g.update(o(t, 40, 400));
      if (a) cuts.push(`${t} ${a.to}`);
    }
    expect(cuts).toEqual(['1900 ptz']);
  });
});
