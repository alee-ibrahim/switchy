/**
 * Shot-quality gate (live evaluation round 2): the program shows the
 * PTZ only while its shot is good, else the wide camera; no "cut anyway on
 * timeout". Plus the head/upper-body fallback detector and the acquisition
 * changes (seat-region confidence, stale P100 position reads).
 * No images of people in the repo: synthetic boxes; the recorded frames are in
 * test/fixtures/private (git-ignored) and only used where present.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import os from 'node:os';
import jpeg from 'jpeg-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GATE_DEFAULTS,
  gateThresholds,
  headTop,
  judgeShot,
  ProgramGate,
  type ShotObservation,
} from '../src/engine/autoframe/shot-gate.js';
import { TrackController } from '../src/engine/autoframe/track-controller.js';
import { createTracker } from '../src/engine/autoframe/tracker.js';
import { decodeSimcc, headFromKeypoints, KP, poseCrop, RtmHeadDetector, type Keypoint } from '../src/engine/autoframe/person.js';
import { ensureModel, RTMDET_PERSON, RTMPOSE_T, unzipEntry, YUNET } from '../src/engine/autoframe/model.js';
import { YunetDetector, type Face } from '../src/engine/autoframe/yunet.js';
import { gatePicture } from '../src/engine/autoframe/refiner.js';
import type { CameraDriver, PtzControl } from '../src/engine/cameras/types.js';
import type { ProgramOutput } from '../src/engine/output/program.js';
import { RoomController, type RoomEvent, type ShotTracker, type TrackContext, type TrackSession } from '../src/engine/room/controller.js';
import { parseLine } from '../src/engine/dcen/parser.js';
import { cameraSchema, policySchema, type RoomConfig, type RoomPolicy } from '../src/engine/types.js';

const W = 640;
const H = 360;
const EYE = 1 / 3;
const policy = policySchema.parse({});

/** A face with its eye point at (x, y) frame fractions, h = face height fraction (YuNet-like box: eyes at 40%). */
function face(x: number, y: number, h: number, score = 0.9, source?: Face['source']): Face {
  const hp = h * H;
  const cx = x * W;
  const ey = y * H;
  return {
    x: cx - hp * 0.4,
    y: ey - hp * 0.4,
    w: hp * 0.8,
    h: hp,
    score,
    landmarks: source && source !== 'face' ? [] : [
      [cx - hp * 0.18, ey],
      [cx + hp * 0.18, ey],
    ],
    source,
  };
}

/** Observation for a face box given by its eye point (frame fractions). */
function obs(t: number, eyeX: number, eyeY: number, h: number, extra: Partial<ShotObservation> = {}): ShotObservation {
  const w = (h * 0.8 * H) / W;
  return {
    t,
    state: 'locked',
    lostMs: 0,
    box: { x: eyeX - w / 2, y: eyeY - 0.4 * h, w, h },
    eye: { x: eyeX, y: eyeY },
    source: 'face',
    speed: 0,
    ...extra,
  };
}

// ------------------------------------------------------------------ gate maths

describe('shot gate: maths', () => {
  const strict = gateThresholds(policy, false);
  const loose = gateThresholds(policy, true);

  it('head top = face box top - 0.3 face heights; headroom must be >= 5% of the frame', () => {
    expect(headTop({ x: 0.4, y: 0.2, w: 0.1, h: 0.2 })).toBeCloseTo(0.14);
    // eyes on the eye line, face 22%: top of head at 33.3 - 8.8 - 6.6 = 17.9%
    const ok = judgeShot(obs(0, 0.5, EYE, 0.22), strict);
    expect(ok.good).toBe(true);
    expect(ok.reason).toBe('headroom 18%, face 22%');
    // stood up: eyes at 18% of the frame -> head top 2.9%
    const up = judgeShot(obs(0, 0.5, 0.18, 0.22), strict);
    expect(up).toMatchObject({ good: false, reason: 'no headroom (3% < 5%)' });
    // forehead cut off by the top edge
    expect(judgeShot(obs(0, 0.5, 0.08, 0.22), strict).reason).toMatch(/^head cut off at the top/);
  });

  it('face cut at the sides or the bottom, size band, eye line, camera speed', () => {
    expect(judgeShot(obs(0, 0.04, EYE, 0.22), strict).reason).toBe('face cut at the side');
    expect(judgeShot(obs(0, 0.97, EYE, 0.22), strict).reason).toBe('face cut at the side');
    expect(judgeShot(obs(0, 0.5, 0.85, 0.3), { ...strict, eyeTol: 1 }).reason).toBe('face cut at the bottom');
    expect(judgeShot(obs(0, 0.5, EYE, 0.06), strict).reason).toBe('face too small (6%)');
    expect(judgeShot(obs(0, 0.5, 0.4, 0.4), strict).reason).toBe('face too big (40%)');
    expect(judgeShot(obs(0, 0.5, 0.52, 0.2), strict).reason).toBe('eye line low (52%)');
    expect(judgeShot(obs(0, 0.5, EYE, 0.22, { speed: 0.39 }), strict).reason).toBe('camera moving fast');
    // slow tracking moves are fine (P100 pan level 4 ~ 0.18 frame/s)
    expect(judgeShot(obs(0, 0.5, EYE, 0.22, { speed: 0.18 }), strict).good).toBe(true);
  });

  it('not locked, or only a person box: never good; a head from body keypoints is', () => {
    expect(judgeShot(obs(0, 0.5, EYE, 0.22, { state: 'lost' }), strict).reason).toBe('target lost');
    expect(judgeShot({ ...obs(0, 0.5, EYE, 0.22), state: 'acquiring', box: null }, strict).reason).toBe('searching for the speaker');
    expect(judgeShot(obs(0, 0.5, EYE, 0.22, { source: 'person' }), strict).good).toBe(false);
    expect(judgeShot(obs(0, 0.5, EYE, 0.22, { source: 'pose' }), strict)).toMatchObject({ good: true, reason: 'headroom 18%, face 22%, head from body keypoints' });
  });

  it('staying on the PTZ uses looser thresholds than cutting to it', () => {
    // head top at 4%: not enough to cut to, enough to stay on
    const o = obs(0, 0.5, 0.2, 0.2); // top = 0.2 - 0.08 - 0.06 = 0.06... adjust eye to get 4%
    const o4 = obs(0, 0.5, 0.18, 0.2); // 0.18 - 0.08 - 0.06 = 0.04
    expect(judgeShot(o, strict).good).toBe(true);
    expect(judgeShot(o4, strict).good).toBe(false);
    expect(judgeShot(o4, loose).good).toBe(true);
    expect(loose.headroom).toBeCloseTo(strict.headroom - 0.02);
    expect(loose.maxSpeed).toBeGreaterThan(strict.maxSpeed);
    expect(gateThresholds({ ...policy, trackHeadroomPct: 9 }, false).headroom).toBeCloseTo(0.09);
    expect(GATE_DEFAULTS.faceMin).toBe(0.08);
  });

  it('auto-frame verify picture: same gate; "face with headroom" for the fallback', () => {
    const size = { width: W, height: H };
    const p = { ...policy };
    expect(gatePicture([], null, size, p)).toMatchObject({ good: false, faceWithHeadroom: false });
    const f = face(0.5, EYE, 0.22);
    expect(gatePicture([f], f, size, p)).toMatchObject({ good: true, faceWithHeadroom: true });
    const low = face(0.5, 0.56, 0.22); // eye line far too low, headroom fine
    expect(gatePicture([low], low, size, p)).toMatchObject({ good: false, faceWithHeadroom: true });
    const up = face(0.5, 0.12, 0.22);
    expect(gatePicture([up], up, size, p)).toMatchObject({ good: false, faceWithHeadroom: false });
  });
});

// ------------------------------------------------------------------ gate timing

describe('shot gate: program decisions', () => {
  const timing = { lostToWideMs: 700, badToWideMs: 700, holdMs: 400, minDwellMs: 2000 };
  const mk = (lastSwitch = -10_000) => new ProgramGate(timing, gateThresholds(policy, false), gateThresholds(policy, true), lastSwitch);

  /** Run the gate over [t0, t1) at 10 Hz; cuts are applied like the controller does. */
  function run(g: ProgramGate, t0: number, t1: number, f: (t: number) => ShotObservation, cuts: Array<{ t: number; to: string; reason: string }>) {
    for (let t = t0; t < t1; t += 100) {
      const a = g.update(f(t));
      if (a) {
        cuts.push({ t, to: a.to, reason: a.reason });
        g.switched(a.to === 'ptz', t);
      }
    }
  }

  it('cuts to the PTZ only after the shot was good for the hold time, and only after the minimum dwell on wide', () => {
    const cuts: Array<{ t: number; to: string; reason: string }> = [];
    const g = mk(0); // wide since t=0 (cover cut)
    run(g, 0, 3000, (t) => obs(t, 0.5, EYE, 0.22), cuts);
    expect(cuts).toEqual([{ t: 2000, to: 'ptz', reason: 'shot good: headroom 18%, face 22%' }]);
    const cuts2: Array<{ t: number; to: string; reason: string }> = [];
    const g2 = mk(-5000);
    run(g2, 0, 1000, (t) => obs(t, 0.5, EYE, 0.22), cuts2);
    expect(cuts2[0]!.t).toBe(400);
  });

  it('lost -> wide after 700 ms (even inside the dwell) -> reacquired -> PTZ after hold and dwell', () => {
    const cuts: Array<{ t: number; to: string; reason: string }> = [];
    const g = mk(-5000);
    // good 0-1000 (cut at 400), lost from 1000 (last match 1000), back at 3000
    run(g, 0, 6000, (t) => {
      if (t < 1000 || t >= 3000) return obs(t, 0.5, EYE, 0.22);
      return { ...obs(t, 0.5, EYE, 0.22), state: t - 1000 > 250 ? 'lost' : 'locked', lostMs: t - 1000 };
    }, cuts);
    expect(cuts.map((c) => [c.t, c.to])).toEqual([
      [400, 'ptz'],
      [1700, 'wide'], // 700 ms lost; only 1.3 s after the cut to the PTZ (a lost target ignores the dwell)
      [3700, 'ptz'], // good from 3000, hold 400 -> 3400, dwell 2 s from 1700 -> 3700
    ]);
    expect(cuts[1]!.reason).toBe('target lost 700 ms');
  });

  it('person stands up (no headroom) -> wide after 700 ms bad; sits down -> PTZ again', () => {
    const cuts: Array<{ t: number; to: string; reason: string }> = [];
    const g = mk(-5000);
    run(g, 0, 9000, (t) => obs(t, 0.5, t >= 3000 && t < 5000 ? 0.15 : EYE, 0.22), cuts);
    expect(cuts.map((c) => [c.t, c.to])).toEqual([
      [400, 'ptz'],
      [3700, 'wide'],
      [5700, 'ptz'], // good from 5000: hold until 5400, dwell from 3700 until 5700
    ]);
    expect(cuts[1]!.reason).toMatch(/^shot bad for 700 ms: (no headroom|head cut off)/);
  });

  it('flip-flop suppression: a shot that is good/bad every 600 ms never switches more often than every 2 s', () => {
    const cuts: Array<{ t: number; to: string; reason: string }> = [];
    const g = mk(-5000);
    run(g, 0, 20_000, (t) => obs(t, 0.5, Math.floor(t / 600) % 2 ? 0.12 : EYE, 0.22), cuts);
    for (let i = 1; i < cuts.length; i++) expect(cuts[i]!.t - cuts[i - 1]!.t).toBeGreaterThanOrEqual(2000);
    expect(cuts.length).toBeLessThanOrEqual(10);
  });

  it('hysteresis: borderline headroom (4%) keeps the PTZ but does not cut to it', () => {
    const border = (t: number) => obs(t, 0.5, 0.18, 0.2); // head top 4%
    const a: Array<{ t: number; to: string; reason: string }> = [];
    const g = mk(-5000);
    run(g, 0, 5000, border, a);
    expect(a).toEqual([]);
    const b: Array<{ t: number; to: string; reason: string }> = [];
    const g2 = mk(-5000);
    run(g2, 0, 1000, (t) => obs(t, 0.5, EYE, 0.22), b);
    run(g2, 1000, 6000, border, b);
    expect(b.map((c) => c.to)).toEqual(['ptz']);
  });
});

// ------------------------------------------------------------------ pipeline replay: TrackController + gate

describe('replay: tracker + gate on round-2-like sequences (static camera, synthetic faces)', () => {
  /**
   * Feed the controller 10 Hz detections and run the gate on its observation.
   * `scene(t)` returns the detections of that tick.
   */
  function replay(scene: (t: number) => Face[], ms: number, settings: Partial<ConstructorParameters<typeof TrackController>[0]> = {}) {
    const ctl = new TrackController({ deadzoneX: 0.5, deadzoneY: 0.5, headroomTrigger: 0, ...settings }); // a static camera: never drive
    const gate = new ProgramGate(
      { lostToWideMs: 700, badToWideMs: 700, holdMs: 400, minDwellMs: 2000 },
      gateThresholds(policy, false),
      gateThresholds(policy, true),
      0,
    );
    const cuts: Array<{ t: number; to: string; reason: string }> = [];
    for (let t = 0; t < ms; t += 100) {
      ctl.step({ t, width: W, height: H, faces: scene(t), shift: null });
      const a = gate.update(ctl.observe(t));
      if (a) {
        cuts.push({ t, to: a.to, reason: a.reason });
        gate.switched(a.to === 'ptz', t);
      }
    }
    return cuts;
  }

  it('acquisition never good (forehead cut off all turn) -> the program stays wide the whole turn', () => {
    const cuts = replay(() => [face(0.52, 0.1, 0.24)], 30_000);
    expect(cuts).toEqual([]);
  });

  it('YuNet misses the turned head; the fallback head box (score 0.55, in the seat) still acquires and gets the PTZ', () => {
    // round 2 seat 11: only the body-keypoint head is found for the first 4 s
    const cuts = replay((t) => (t < 4000 ? [face(0.55, 0.3, 0.24, 0.55, 'pose')] : [face(0.55, 0.3, 0.24, 0.9)]), 6000);
    expect(cuts[0]).toMatchObject({ to: 'ptz' });
    expect(cuts[0]!.t).toBeLessThanOrEqual(2100); // dwell from the cover cut at t=0
    expect(cuts[0]!.reason).toMatch(/head from body keypoints/);
    // the same box at 0.55 outside the seat region is never taken
    expect(replay(() => [face(0.95, 0.3, 0.24, 0.55, 'pose')], 6000)).toEqual([]);
    // a bare person box is never a target on its own
    expect(replay(() => [face(0.5, 0.3, 0.24, 0.9, 'person')], 6000)).toEqual([]);
  });

  it('lost -> wide after 700 ms -> reacquired -> PTZ after the hold (and dwell)', () => {
    const cuts = replay((t) => (t >= 5000 && t < 7000 ? [] : [face(0.5, EYE, 0.22)]), 12_000);
    expect(cuts.map((c) => c.to)).toEqual(['ptz', 'wide', 'ptz']);
    expect(cuts[1]!.t).toBeGreaterThanOrEqual(5600);
    expect(cuts[1]!.t).toBeLessThanOrEqual(5800);
    expect(cuts[1]!.reason).toMatch(/^target lost 7\d\d ms$/);
    expect(cuts[2]!.t).toBeGreaterThanOrEqual(7400);
  });

  it('person stands up out of the headroom -> wide; sits down -> PTZ', () => {
    // stands over 1 s (eyes 33% -> 12%), stays up 4 s, sits down again
    const eyeY = (t: number) => (t < 5000 ? EYE : t < 6000 ? EYE - ((t - 5000) / 1000) * 0.21 : t < 10_000 ? 0.12 : EYE);
    const cuts = replay((t) => [face(0.5, eyeY(t), 0.22)], 15_000);
    expect(cuts.map((c) => c.to)).toEqual(['ptz', 'wide', 'ptz']);
    expect(cuts[1]!.reason).toMatch(/no headroom|head cut off/);
    expect(cuts[1]!.t).toBeLessThanOrEqual(6600); // head top under 5% at ~5.6 s, + 700 ms bad
  });
});

// ------------------------------------------------------------------ room controller replay

describe('RoomController: gate-driven program (fake tracker)', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  function setup(p: Partial<RoomPolicy> = {}) {
    const shows: string[] = [];
    const events: RoomEvent[] = [];
    const sessions: Array<{ ctx: TrackContext; air: string[] }> = [];
    const tracker: ShotTracker = (ctx) => {
      const rec = { ctx, air: [] as string[] };
      sessions.push(rec);
      let end!: () => void;
      const done = new Promise<void>((r) => (end = r));
      const s: TrackSession = {
        ready: new Promise(() => {}),
        onAir: () => rec.air.push('on'),
        offAir: () => rec.air.push('off'),
        moved: true,
        stop: async () => end(),
        done,
      };
      return s;
    };
    const cfg: RoomConfig = {
      id: 'r',
      name: 'Committee Room A',
      enabled: true,
      dcenHost: '',
      dcenPort: 3225,
      outputName: 'o',
      outputMode: 'route',
      cameras: [
        cameraSchema.parse({ id: 'wide', name: 'X1 Ultra wide', driver: 'birddog', role: 'wide', ndiSource: 'WIDE', settleMs: 0 }),
        cameraSchema.parse({ id: 'ptz', name: 'P100 PTZ', driver: 'birddog', role: 'ptz', ndiSource: 'PTZ', settleMs: 2000 }),
      ],
      seats: [
        { unit: 11, label: 'Seat 11', cameraId: 'ptz', preset: '11' },
        { unit: 5, label: 'Right of door', cameraId: 'ptz', preset: '5' },
      ],
      policy: policySchema.parse({ refine: 'track', returnToWideMs: 0, ...p }),
    };
    const output: ProgramOutput = { name: 'o', mode: 'route', current: null, show: (s) => (shows.push(s ?? ''), { ok: true }), connections: () => 0, close() {} };
    const ptz: PtzControl = {
      getPosition: async () => ({ pan: 0, tilt: 0, zoom: 0 }),
      moveAbsolute: async () => {},
      moveRelative: async () => {},
      zoomTo: async () => {},
      savePreset: async () => {},
      drive: async () => {},
      zoomDrive: async () => {},
      stop: async () => {},
    };
    const drivers = new Map<string, CameraDriver>();
    drivers.set('wide', { kind: 'fake', recallPreset: async () => {}, probe: async () => ({ ok: true }) });
    drivers.set('ptz', { kind: 'fake', ptz, recallPreset: async () => {}, probe: async () => ({ ok: true }) });
    const ctl = new RoomController(cfg, { drivers, output, tracker });
    ctl.on('event', (e) => events.push(e));
    const feed = (l: string) => ctl.handleDcen(parseLine(l));
    ['MIC-OFF;FFFF;FFFF;', 'READY;'].forEach(feed);
    const logs = () => events.filter((e) => e.type === 'log').map((e) => (e as { msg: string }).msg);
    /** Tick the session at 10 Hz for ms with the observation function. */
    const tick = async (ms: number, f: (t: number) => Omit<ShotObservation, 't'>) => {
      for (let i = 0; i < ms / 100; i++) {
        sessions.at(-1)!.ctx.onShot!({ ...f(Date.now()), t: Date.now() });
        await vi.advanceTimersByTimeAsync(100);
      }
    };
    return { ctl, shows, sessions, feed, logs, tick };
  }

  const good = () => obs(0, 0.5, EYE, 0.22);

  it('round 2 seat 11: lost -> wide after 700 ms, logged with the reason; reacquired -> PTZ after the hold', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(100);
    h.feed('MIC-ON;000B;;');
    await vi.advanceTimersByTimeAsync(2300);
    expect(h.shows.at(-1)).toBe('WIDE');
    await h.tick(3000, good);
    expect(h.shows.at(-1)).toBe('PTZ');
    expect(h.logs()).toContainEqual(expect.stringMatching(/^program -> P100 PTZ "PTZ" \(seat Seat 11; shot good: headroom 18%, face 22%\)$/));
    let lostAt = Date.now();
    await h.tick(1500, (t) => ({ ...good(), state: t - lostAt > 250 ? 'lost' : 'locked', lostMs: t - lostAt }));
    expect(h.shows.at(-1)).toBe('WIDE');
    expect(h.logs()).toContainEqual(expect.stringMatching(/^program -> X1 Ultra wide "WIDE" \(target lost 7\d\d ms\)$/));
    expect(h.sessions[0]!.air).toEqual(['on', 'off']);
    expect(h.ctl.snapshot().tracking?.gate).toMatchObject({ state: 'lost', onPtz: false });
    await h.tick(3000, good);
    expect(h.shows.at(-1)).toBe('PTZ');
    expect(h.shows.filter((s) => s === 'PTZ')).toHaveLength(2);
    lostAt = 0;
  });

  it('person stands up (no headroom) while on air -> wide; the next speaker still gets the normal cover/recall', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(100);
    h.feed('MIC-ON;000B;;');
    await vi.advanceTimersByTimeAsync(2300);
    await h.tick(3000, good);
    expect(h.shows.at(-1)).toBe('PTZ');
    await h.tick(1000, () => obs(0, 0.5, 0.15, 0.22));
    expect(h.shows.at(-1)).toBe('WIDE');
    expect(h.logs()).toContainEqual(expect.stringMatching(/\(shot bad for 7\d\d ms: (no headroom|head cut off)/));
    h.feed('MIC-ON;0005;;');
    await vi.advanceTimersByTimeAsync(2300);
    expect(h.sessions).toHaveLength(2);
    expect(h.shows.at(-1)).toBe('WIDE');
  });

  it('acquisition never good: wide all turn (no "cutting anyway"), the badge says why', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(100);
    h.feed('MIC-ON;0005;;');
    await vi.advanceTimersByTimeAsync(2300);
    await h.tick(20_000, () => obs(0, 0.5, 0.1, 0.27));
    expect(h.shows).not.toContain('PTZ');
    expect(h.logs().some((l) => /cutting anyway/.test(l))).toBe(false);
    expect(h.ctl.snapshot().tracking?.gate?.reason).toMatch(/head cut off|no headroom/);
  });

  it('gate cuts never happen for a speaker who is no longer on, nor while paused', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(100);
    h.feed('MIC-ON;000B;;');
    await vi.advanceTimersByTimeAsync(2300);
    const ctx = h.sessions[0]!.ctx;
    h.ctl.setPaused(true);
    for (let i = 0; i < 30; i++) {
      ctx.onShot!({ ...good(), t: Date.now() });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(h.shows).not.toContain('PTZ');
  });
});

// ------------------------------------------------------------------ head from keypoints, model files

describe('head/upper-body fallback: maths and model files', () => {
  const person = { x: 200, y: 60, w: 240, h: 300, score: 0.8 };
  function kps(over: Partial<Record<keyof typeof KP, Keypoint>>): Keypoint[] {
    const k: Keypoint[] = Array.from({ length: 17 }, () => [0, 0, 0] as Keypoint);
    for (const [name, v] of Object.entries(over)) k[KP[name as keyof typeof KP]] = v!;
    return k;
  }

  it('frontal head: eyes, ears and shoulders give a YuNet-like box (eyes at 40% of it)', () => {
    const h = headFromKeypoints(
      kps({ nose: [320, 140, 0.9], lEye: [335, 125, 0.9], rEye: [305, 125, 0.9], lEar: [355, 130, 0.8], rEar: [285, 130, 0.8], lShoulder: [400, 230, 0.9], rShoulder: [240, 230, 0.9] }),
      person,
    )!;
    expect(h.source).toBe('pose');
    expect(h.x + h.w / 2).toBeCloseTo(320);
    expect(h.y + 0.4 * h.h).toBeCloseTo(125);
    // head width from the ears: 70 * 1.15 = 80.5 (inside the shoulder band 53-99)
    expect(h.h).toBeCloseTo(80.5 * 1.2);
    expect(h.score).toBeGreaterThan(0.8);
  });

  it('turned head (one eye, nose) still gives a head; shoulders keep its size sane', () => {
    const h = headFromKeypoints(kps({ nose: [300, 140, 0.8], lEye: [312, 126, 0.7], lEar: [345, 130, 0.6], lShoulder: [400, 230, 0.9], rShoulder: [240, 230, 0.9] }), person)!;
    expect(h.source).toBe('pose');
    expect(h.h / 1.2).toBeGreaterThanOrEqual(160 * 0.33 - 1e-9);
    expect(h.y + 0.4 * h.h).toBeCloseTo(126);
  });

  it('no face keypoint: top of the person box, marked "person" (continuity only)', () => {
    const h = headFromKeypoints(kps({ lShoulder: [400, 230, 0.9], rShoulder: [240, 230, 0.9] }), person)!;
    expect(h.source).toBe('person');
    expect(headTop(h)).toBeCloseTo(person.y);
  });

  it('SimCC decode maps the argmax back through the crop', () => {
    const crop = poseCrop({ x: 100, y: 50, w: 150, h: 200, score: 1 });
    expect(crop.w / crop.h).toBeCloseTo(192 / 256);
    const sx = new Float32Array(2 * 384);
    const sy = new Float32Array(2 * 512);
    sx[192] = 0.9; // kp 0: x bin 192 -> input x 96 -> crop centre
    sy[256] = 0.7;
    sx[384 + 0] = 0.5;
    sy[512 + 511] = 0.6;
    const [a, b] = decodeSimcc(sx, sy, 2, crop);
    expect(a![0]).toBeCloseTo(175);
    expect(a![1]).toBeCloseTo(150);
    expect(a![2]).toBeCloseTo(0.7);
    expect(b![0]).toBeCloseTo(crop.cx - crop.w / 2);
    expect(b![2]).toBeCloseTo(0.5);
  });

  /** Minimal zip writer (one deflated entry) for the extraction test. */
  function zipOf(name: string, body: Buffer): Buffer {
    const data = zlib.deflateRawSync(body);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(0, 42);
    const cdOff = local.length + n.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + n.length, 12);
    eocd.writeUInt32LE(cdOff, 16);
    return Buffer.concat([local, n, data, central, n, eocd]);
  }

  it('model download: zip checksum, entry extraction and extracted-file checksum are all enforced', async () => {
    const body = Buffer.from('fake onnx '.repeat(1000));
    const zip = zipOf('a/b/end2end.onnx', body);
    expect(unzipEntry(zip, 'a/b/end2end.onnx').equals(body)).toBe(true);
    expect(() => unzipEntry(zip, 'nope')).toThrow(/not found/);
    const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchy-models-'));
    const spec = { file: 'x.onnx', url: 'http://example.invalid/x.zip', sha256: sha(zip), zipEntry: 'a/b/end2end.onnx', fileSha256: sha(body), urlEnv: 'SWITCHY_TEST_URL', licence: 'test' };
    const fetchOk = (async () => new Response(zip)) as unknown as typeof fetch;
    const f = await ensureModel(spec, dir, fetchOk);
    expect(fs.readFileSync(f).equals(body)).toBe(true);
    const bad = { ...spec, file: 'y.onnx', sha256: sha(Buffer.from('other')) };
    await expect(ensureModel(bad, dir, fetchOk)).rejects.toThrow(/checksum mismatch/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------ session: stale P100 position reads

describe('tracking session: stale pan/tilt reads after a recall (round 2)', () => {
  const P11 = { pan: 1443, tilt: -67, zoom: 5872 };
  const CAL = { points: [{ zoom: 0, dxPerPan: -1.119e-3, dyPerTilt: 1.866e-3 }, { zoom: 8202, dxPerPan: -3.416e-3, dyPerTilt: 5.048e-3 }] };
  const img = { width: 64, height: 36, data: new Uint8Array(64 * 36 * 4).map((_, i) => (i * 37) % 251) };

  function ctxFor(ptz: PtzControl, log: string[], recalls: string[]): TrackContext {
    const camera = cameraSchema.parse({
      id: 'ptz',
      name: 'P100',
      driver: 'birddog',
      role: 'ptz',
      ndiSource: 'CAM',
      options: { autoframe: { calibration: CAL, presets: { '11': P11 } } },
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
      seats: [{ unit: 11, label: 'Seat 11', cameraId: 'ptz', preset: '11' }],
      policy: policySchema.parse({ refine: 'track' }),
    };
    return {
      room,
      camera,
      driver: { kind: 'fake', ptz, recallPreset: async (p) => void recalls.push(p), probe: async () => ({ ok: true }) },
      shot: { cameraId: 'ptz', preset: '11', reason: 'seat Seat 11', unit: 11 },
      signal: new AbortController().signal,
      onState: () => {},
      log: (_l, m) => log.push(m),
    };
  }

  const ptzWith = (pos: () => { pan: number; tilt: number; zoom: number }): PtzControl => ({
    getPosition: async () => pos(),
    moveAbsolute: async () => {},
    moveRelative: async () => {},
    zoomTo: async () => {},
    savePreset: async () => {},
    drive: async () => {},
    zoomDrive: async () => {},
    stop: async () => {},
  });

  it('pan/tilt still showing the previous preset (zoom right): no recall loop, acquisition at once', async () => {
    const log: string[] = [];
    const recalls: string[] = [];
    const stale = { pan: 265, tilt: -32, zoom: 5872 }; // "camera at 265/-32/z5872" = preset 5's pan, preset 11's zoom
    const tracker = createTracker({
      frames: { grab: async () => img as never },
      detector: async () => ({ detect: async () => [{ ...face(0.5, EYE, 0.24), x: 0.5 * 64 - 3.5, y: EYE * 36 - 3.5, w: 7, h: 8.6, landmarks: [] }] }),
      periodMs: 20,
      positionCheckMs: 100,
      idleReadAfterMs: 50,
      recallStillMinMs: 0,
    });
    const s = tracker(ctxFor(ptzWith(() => stale), log, recalls));
    await new Promise((r) => setTimeout(r, 1200));
    await s.stop('test');
    expect(recalls).toEqual([]);
    expect(log.some((l) => /target acquired/.test(l))).toBe(true);
    expect(log.filter((l) => /treated as a stale reply/.test(l))).toHaveLength(1);
  });

  it('a zoom far off still recalls (the recall really did not take)', async () => {
    const log: string[] = [];
    const recalls: string[] = [];
    const tracker = createTracker({
      frames: { grab: async () => img as never },
      detector: async () => ({ detect: async () => [] }),
      periodMs: 20,
      positionCheckMs: 100,
      recallStillMinMs: 0,
    });
    const s = tracker(ctxFor(ptzWith(() => (recalls.length ? P11 : { pan: 265, tilt: -32, zoom: 16384 })), log, recalls));
    await new Promise((r) => setTimeout(r, 800));
    await s.stop('test');
    expect(recalls).toEqual(['11']);
  });

  it('garbage replies (pan = zoom value) are ignored', async () => {
    const log: string[] = [];
    const recalls: string[] = [];
    const tracker = createTracker({
      frames: { grab: async () => img as never },
      detector: async () => ({ detect: async () => [] }),
      periodMs: 20,
      positionCheckMs: 100,
      recallStillMinMs: 0,
    });
    const s = tracker(ctxFor(ptzWith(() => ({ pan: 8202, tilt: -4065, zoom: 8202 })), log, recalls));
    await new Promise((r) => setTimeout(r, 600));
    await s.stop('test');
    expect(recalls).toEqual([]);
  });
});

// ------------------------------------------------------------------ real models: speed (and recorded frames, local only)

const MODELS = path.join(process.cwd(), 'models');
const haveModels = [YUNET.file, RTMDET_PERSON.file, RTMPOSE_T.file].every((f) => fs.existsSync(path.join(MODELS, f)));
const PRIVATE = path.join(__dirname, 'fixtures', 'private');
const load = (f: string) => jpeg.decode(fs.readFileSync(f), { useTArray: true });

describe.skipIf(!haveModels)('head/upper-body fallback on the real models (downloaded on demand)', () => {
  it('benchmark: YuNet + fallback keeps the tracking loop well above 8 Hz on 640x360', async () => {
    const y = new YunetDetector({ modelPath: path.join(MODELS, YUNET.file) });
    const r = new RtmHeadDetector({ detPath: path.join(MODELS, RTMDET_PERSON.file), posePath: path.join(MODELS, RTMPOSE_T.file) });
    await y.warmup();
    await r.warmup();
    // a textured synthetic frame (no people needed for timing)
    const data = new Uint8Array(W * H * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 24;
    const img = { width: W, height: H, data };
    const tY: number[] = [];
    const tR: number[] = [];
    for (let i = 0; i < 15; i++) {
      let t0 = performance.now();
      await y.detect(img, { scoreThreshold: 0.35 });
      tY.push(performance.now() - t0);
      t0 = performance.now();
      await r.persons(img);
      await r.keypoints(img, { x: 200, y: 40, w: 240, h: 300, score: 1 });
      tR.push(performance.now() - t0);
    }
    const med = (a: number[]) => a.sort((x, z) => x - z)[a.length >> 1]!;
    console.log(`detector benchmark 640x360: YuNet ${med(tY).toFixed(1)} ms, RTMDet-nano + RTMPose-t (1 person) ${med(tR).toFixed(1)} ms`);
    // budget: 125 ms per tick at 8 Hz, with grab + motion (~10 ms) on top
    expect(med(tY) + med(tR)).toBeLessThan(80);
  }, 60_000);

  const frames = ['r2-motion-blur-edge.jpg', 'r2-edge-top.jpg', 'r2-hand-on-chin.jpg', 'r2-looking-up.jpg'].map((f) => path.join(PRIVATE, f));
  const empty = path.join(PRIVATE, 'r2-empty-seat.jpg');
  it.skipIf(![...frames, empty].every((f) => fs.existsSync(f)))(
    'recorded round-2 frames (local only): the keypoint head matches the YuNet face (same association gate); nothing on an empty seat',
    async () => {
      const y = new YunetDetector({ modelPath: path.join(MODELS, YUNET.file) });
      const r = new RtmHeadDetector({ detPath: path.join(MODELS, RTMDET_PERSON.file), posePath: path.join(MODELS, RTMPOSE_T.file) });
      for (const f of frames) {
        const img = load(f);
        const [fy] = await y.detect(img);
        const [hd] = await r.detect(img);
        expect(hd?.source).toBe('pose');
        expect(hd!.score).toBeGreaterThan(0.6);
        // close enough to be taken over by the tracker's identity gate (centre within 0.5 face heights, size 0.7-1.43x)
        const c = (b: Face) => [b.x + b.w / 2, b.y + b.h * 0.4];
        const [ax, ay] = c(fy!);
        const [bx, by] = c(hd!);
        expect(Math.hypot(ax! - bx!, ay! - by!) / fy!.h).toBeLessThan(0.5);
        expect(hd!.h / fy!.h).toBeGreaterThan(0.7);
        expect(hd!.h / fy!.h).toBeLessThan(1.43);
      }
      expect(await r.detect(load(empty))).toEqual([]);
    },
    60_000,
  );
});
