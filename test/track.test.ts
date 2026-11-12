/**
 * Active tracking: the controller against a simulated PTZ camera (command
 * latency, acceleration, NDI frame latency, detection noise, a second face,
 * target loss), the session's watchdog/stop, and the room controller wiring.
 * No images of people: faces are synthetic boxes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kalman1D, levelFor, P100_RATES, TrackController, usableLevels, type TrackCommand, type TrackSettings } from '../src/engine/autoframe/track-controller.js';
import { createTracker, trackSettings } from '../src/engine/autoframe/tracker.js';
import type { Face } from '../src/engine/autoframe/yunet.js';
import type { PtzControl } from '../src/engine/cameras/types.js';
import type { CameraDriver } from '../src/engine/cameras/types.js';
import type { ProgramOutput } from '../src/engine/output/program.js';
import { RoomController, type RoomEvent, type ShotTracker, type TrackContext, type TrackSession } from '../src/engine/room/controller.js';
import { parseLine } from '../src/engine/dcen/parser.js';
import { cameraSchema, policySchema, type RoomConfig } from '../src/engine/types.js';

const W = 640;
const H = 360;

/** Deterministic noise. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Person {
  /** Eye point in preset-view frame fractions, as a function of time (ms). */
  x: (t: number) => number;
  y: (t: number) => number;
  h: number;
  visible?: (t: number) => boolean;
  score?: number;
}

interface SimOptions {
  persons: Person[];
  durationMs: number;
  settings?: Partial<TrackSettings>;
  /** true camera speed / table speed */
  trueScale?: number;
  cmdLatencyMs?: number;
  frameLatencyMs?: number;
  noise?: number;
  seed?: number;
}

/**
 * Camera: view offset (cx right, cy down) in preset-frame fractions; a person
 * at world (x, y) shows at (x - cx, y - cy). Pan +1 moves the view right,
 * tilt +1 (up) moves it up. A command takes effect cmdLatencyMs later, speed
 * follows with an 80 ms time constant; the controller sees frames
 * frameLatencyMs old.
 */
function simulate(o: SimOptions) {
  const ctl = new TrackController({ ...o.settings });
  const rand = rng(o.seed ?? 1);
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * 0.87;
  const cmdLat = o.cmdLatencyMs ?? 200;
  const frameLat = o.frameLatencyMs ?? 100;
  const scale = o.trueScale ?? 1;
  const noise = o.noise ?? 0.003;
  const dtSim = 10;
  const cam = { cx: 0, cy: 0, vx: 0, vy: 0 };
  const history: Array<{ t: number; cx: number; cy: number }> = [];
  const pending: Array<{ at: number; cmd: TrackCommand }> = [];
  let active: TrackCommand = { pan: { dir: 0, level: 0 }, tilt: { dir: 0, level: 0 }, zoom: 0 };
  const states: string[] = [];
  const trace: Array<{ t: number; ex: number; ey: number; cx: number; pan: number; tilt: number }> = [];
  let lastFrameCam: { cx: number; cy: number } | null = null;
  let nextTick = 0;
  const camAt = (t: number) => {
    for (let i = history.length - 1; i >= 0; i--) if (history[i]!.t <= t) return history[i]!;
    return { t: 0, cx: 0, cy: 0 };
  };
  for (let t = 0; t <= o.durationMs; t += dtSim) {
    while (pending.length && pending[0]!.at <= t) active = pending.shift()!.cmd;
    const tvx = active.pan.dir * (o.settings?.ratesPan ?? P100_RATES.pan)[active.pan.level]! * scale || 0;
    const tvy = -active.tilt.dir * (o.settings?.ratesTilt ?? P100_RATES.tilt)[active.tilt.level]! * scale || 0;
    const k = 1 - Math.exp(-dtSim / 80);
    cam.vx += (tvx - cam.vx) * k;
    cam.vy += (tvy - cam.vy) * k;
    cam.cx += (cam.vx * dtSim) / 1000;
    cam.cy += (cam.vy * dtSim) / 1000;
    history.push({ t, cx: cam.cx, cy: cam.cy });
    if (t < nextTick) continue;
    nextTick = t + 100 + Math.floor(rand() * 15);
    // the frame the controller gets now was captured frameLat ago
    const ft = t - frameLat;
    const fc = camAt(ft);
    const faces: Face[] = [];
    for (const p of o.persons) {
      if (p.visible && !p.visible(ft)) continue;
      const ex = p.x(ft) - fc.cx + gauss() * noise;
      const ey = p.y(ft) - fc.cy + gauss() * noise;
      if (ex < 0 || ex > 1 || ey < 0 || ey > 1) continue;
      const hpx = p.h * H;
      const cxp = ex * W;
      const eyp = ey * H;
      faces.push({
        x: cxp - hpx * 0.4,
        y: eyp - hpx * 0.4,
        w: hpx * 0.8,
        h: hpx,
        score: p.score ?? 0.9,
        landmarks: [
          [cxp - hpx * 0.18, eyp],
          [cxp + hpx * 0.18, eyp],
          [cxp, eyp + hpx * 0.2],
          [cxp - hpx * 0.15, eyp + hpx * 0.4],
          [cxp + hpx * 0.15, eyp + hpx * 0.4],
        ],
      });
    }
    const shift = lastFrameCam
      ? { dx: -(fc.cx - lastFrameCam.cx) + gauss() * 0.0005, dy: -(fc.cy - lastFrameCam.cy) + gauss() * 0.0005, peak: 20 }
      : null;
    lastFrameCam = { cx: fc.cx, cy: fc.cy };
    const out = ctl.step({ t, width: W, height: H, faces, shift });
    pending.push({ at: t + cmdLat, cmd: out.cmd });
    if (states[states.length - 1] !== out.state) states.push(out.state);
    const p0 = o.persons[0]!;
    trace.push({ t, ex: p0.x(t) - cam.cx - 0.5, ey: p0.y(t) - cam.cy - 1 / 3, cx: cam.cx, pan: out.cmd.pan.dir * out.cmd.pan.level, tilt: out.cmd.tilt.dir * out.cmd.tilt.level });
  }
  const last = trace[trace.length - 1]!;
  if (process.env.TRACK_SIM_REPORT) {
    const settled = trace.findIndex((p, i) => trace.slice(i).every((q) => q.pan === 0 && q.tilt === 0));
    console.log(
      `sim: settled at ${trace[settled]?.t ?? -1} ms, final ex ${(last.ex * 100).toFixed(1)}% ey ${(last.ey * 100).toFixed(1)}%, ` +
        `starts ${ctl.stats.starts}, reversals ${ctl.stats.reversals}, min ex ${(Math.min(...trace.map((p) => p.ex)) * 100).toFixed(1)}%, scale ${ctl.stats.scale.pan.toFixed(2)}, states ${states.join('>')}`,
    );
  }
  return { ctl, cam, states, trace, last, stats: ctl.stats };
}

const still = (v: number) => () => v;
const EYE = 1 / 3;

describe('track controller: speed mapping', () => {
  it('skips P100 levels that are no faster than a lower one', () => {
    expect(usableLevels(P100_RATES.pan, 6)).toEqual([2, 3, 4, 5, 6]); // pan 1 barely moves
    expect(usableLevels(P100_RATES.tilt, 6)).toEqual([1, 3, 4, 5, 6]); // tilt 2 is slower than tilt 1
  });
  it('maps a desired speed to the nearest level, at least the slowest usable one', () => {
    const u = usableLevels(P100_RATES.pan, 8);
    expect(levelFor(0.01, P100_RATES.pan, u, 1)).toBe(2);
    expect(levelFor(0.16, P100_RATES.pan, u, 1)).toBe(3);
    expect(levelFor(0.33, P100_RATES.pan, u, 1)).toBe(6);
    expect(levelFor(0.33, P100_RATES.pan, u, 2)).toBe(3); // camera runs twice as fast as the table
  });
  it('Kalman filter smooths noise and estimates velocity', () => {
    const k = new Kalman1D(0, 0.02, 0.004 ** 2);
    const r = rng(3);
    for (let i = 1; i <= 50; i++) {
      k.predict(0.1);
      k.update(0.05 * i * 0.1 + (r() - 0.5) * 0.01);
    }
    expect(k.v).toBeGreaterThan(0.03);
    expect(k.v).toBeLessThan(0.07);
  });
});

describe('track controller: simulated camera', () => {
  it('centres a delegate sitting off-centre: calm, no oscillation', () => {
    const r = simulate({ persons: [{ x: still(0.5 + 0.2), y: still(EYE + 0.15), h: 0.2 }], durationMs: 6000 });
    expect(r.states).toEqual(['acquiring', 'locked']);
    expect(Math.abs(r.last.ex)).toBeLessThan(0.06);
    expect(Math.abs(r.last.ey)).toBeLessThan(0.07);
    expect(r.stats.reversals).toBe(0);
    expect(r.stats.starts).toBeLessThanOrEqual(3);
    expect(r.ctl.moving).toBe(false);
    // never overshoots past the centre by more than the inner band
    expect(Math.min(...r.trace.map((x) => x.ex))).toBeGreaterThan(-0.04);
    // slow: never faster than the speed cap
    expect(Math.max(...r.trace.map((x) => Math.abs(x.pan)))).toBeLessThanOrEqual(5);
  });

  it('does not move while the face is inside the deadzone', () => {
    const r = simulate({ persons: [{ x: still(0.57), y: still(EYE - 0.08), h: 0.2 }], durationMs: 5000, noise: 0.006 });
    expect(r.stats.starts).toBe(0);
    expect(r.cam.cx).toBe(0);
  });

  it('stays stable with 200 ms command latency, 150 ms frame latency and a camera 1.7x faster than its table', () => {
    const r = simulate({
      persons: [{ x: still(0.5 - 0.28), y: still(EYE), h: 0.2 }],
      durationMs: 7000,
      trueScale: 1.7,
      frameLatencyMs: 150,
    });
    expect(Math.abs(r.last.ex)).toBeLessThan(0.07);
    expect(r.stats.reversals).toBeLessThanOrEqual(1);
    expect(r.stats.scale.pan).toBeGreaterThan(1.2); // learnt from the measured ego-motion
  });

  it('follows a delegate who leans over slowly', () => {
    const x = (t: number) => 0.5 + 0.22 * Math.min(1, Math.max(0, (t - 2000) / 3000));
    const r = simulate({ persons: [{ x, y: still(EYE), h: 0.2 }], durationMs: 9000 });
    expect(Math.abs(r.last.ex)).toBeLessThan(0.07);
    expect(r.last.cx).toBeGreaterThan(0.12);
    expect(r.stats.reversals).toBeLessThanOrEqual(1);
  });

  it('keeps its target when a second person appears next to them', () => {
    const r = simulate({
      persons: [
        { x: still(0.62), y: still(EYE + 0.05), h: 0.2 },
        { x: still(0.28), y: still(EYE + 0.02), h: 0.21, visible: (t) => t > 1500 },
      ],
      durationMs: 6000,
    });
    expect(r.states).toEqual(['acquiring', 'locked']);
    expect(Math.abs(r.last.ex)).toBeLessThan(0.06);
  });

  it('never jumps to a neighbour (outside the seat region) when the target is lost; holds after the loss timeout', () => {
    const r = simulate({
      persons: [
        { x: still(0.66), y: still(EYE), h: 0.2, visible: (t) => t < 2500 },
        // the next seat: about 0.55 of a frame width from this seat's preset aim
        { x: still(1.05), y: still(EYE), h: 0.2, visible: (t) => t > 2600 },
      ],
      durationMs: 7000,
    });
    expect(r.states).toEqual(['acquiring', 'locked', 'lost', 'holding']);
    expect(r.ctl.moving).toBe(false);
    // camera stopped where it was tracking the first person (it never turned towards the second)
    const atLoss = r.trace.find((x) => x.t >= 2800)!.cx;
    expect(Math.abs(r.last.cx - atLoss)).toBeLessThan(0.02);
    expect(r.last.cx).toBeGreaterThan(0.05);
  });

  it('stops within a few hundred ms of a loss and reacquires the same person', () => {
    const r = simulate({
      persons: [{ x: (t) => (t < 1500 ? 0.75 : 0.72), y: still(EYE), h: 0.2, visible: (t) => t < 1500 || t > 2600 }],
      durationMs: 7000,
    });
    expect(r.states).toEqual(['acquiring', 'locked', 'lost', 'locked']);
    const moving = r.trace.filter((x) => x.t > 1500 + 100 + 250 + 120 && x.t < 2600 + 100).every((x) => x.pan === 0);
    expect(moving).toBe(true);
    expect(Math.abs(r.last.ex)).toBeLessThan(0.07);
  });

  it('never goes beyond the excursion limit (someone walking away)', () => {
    const x = (t: number) => 0.5 + 0.9 * Math.min(1, t / 8000);
    const r = simulate({ persons: [{ x, y: still(EYE), h: 0.2 }], durationMs: 12000, settings: { maxExcursionX: 0.3 } });
    expect(Math.max(...r.trace.map((p) => p.cx))).toBeLessThan(0.36);
    expect(r.stats.limitHits).toBeGreaterThan(0);
  });

  it('ignores small background faces and faces far from the preset aim', () => {
    const r = simulate({
      persons: [
        { x: still(0.52), y: still(EYE), h: 0.06 },
        { x: still(0.92), y: still(EYE), h: 0.2, score: 0.9 },
      ],
      durationMs: 3000,
    });
    // the big face is far off (42%): not the delegate; the small one is ignored next to it
    expect(r.states).toEqual(['acquiring']);
    expect(r.stats.starts).toBe(0);
  });

  it('optional zoom: slow zoom-in when the face is too small, within limits', () => {
    const r = simulate({ persons: [{ x: still(0.5), y: still(EYE), h: 0.1 }], durationMs: 1500, settings: { zoom: true } });
    expect(r.ctl.command().zoom).toBe(1);
    const off = simulate({ persons: [{ x: still(0.5), y: still(EYE), h: 0.1 }], durationMs: 1500 });
    expect(off.ctl.command().zoom).toBe(0);
  });
});

// ------------------------------------------------------------------ session

function fakePtz(log: string[]): PtzControl {
  return {
    getPosition: async () => ({ pan: 0, tilt: 0, zoom: 0 }),
    moveAbsolute: async () => {},
    moveRelative: async () => {},
    zoomTo: async () => {},
    savePreset: async () => {},
    drive: async (d, s) => {
      log.push(d.pan || d.tilt ? `drive ${d.pan},${d.tilt} @${s?.pan},${s?.tilt}` : 'stop');
    },
    zoomDrive: async (d) => {
      log.push(`zoom ${d}`);
    },
    stop: async () => {
      log.push('stop-all');
    },
  };
}

/** Textured synthetic frame (no people). */
function frame(): { width: number; height: number; data: Uint8Array } {
  const w = 128;
  const h = 72;
  const data = new Uint8Array(w * h * 4);
  const r = rng(9);
  for (let i = 0; i < w * h; i++) {
    const v = Math.floor(r() * 255);
    data.set([v, v, v, 255], i * 4);
  }
  return { width: w, height: h, data };
}

function trackCtx(ptzLog: string[], over: Partial<TrackContext> = {}): TrackContext {
  const camera = cameraSchema.parse({ id: 'ptz', name: 'PTZ', driver: 'birddog', role: 'ptz', ndiSource: 'CAM' });
  const room = {
    id: 'r',
    name: 'r',
    enabled: true,
    dcenHost: '',
    dcenPort: 3225,
    outputName: 'o',
    outputMode: 'route' as const,
    cameras: [camera],
    seats: [],
    policy: policySchema.parse({ refine: 'track' }),
  };
  const driver: CameraDriver = { kind: 'fake', ptz: fakePtz(ptzLog), recallPreset: async () => {}, probe: async () => ({ ok: true }) };
  return {
    room,
    camera,
    driver,
    shot: { cameraId: 'ptz', preset: '5', reason: 'seat 5', unit: 5 },
    signal: new AbortController().signal,
    onState: () => {},
    log: () => {},
    ...over,
  };
}

/** A face at eye offset x from the centre (frame fraction) on the 128x72 frame. */
function faceAt(ox: number): Face {
  const ex = (0.5 + ox) * 128;
  const ey = 72 / 3;
  const h = 18;
  return { x: ex - 7, y: ey - 7, w: 14, h, score: 0.9, landmarks: [[ex - 3, ey], [ex + 3, ey], [ex, ey + 4], [ex - 3, ey + 7], [ex + 3, ey + 7]] };
}

describe('tracking session (I/O)', () => {
  it('watchdog stops the camera when the loop stalls while moving', async () => {
    const ptzLog: string[] = [];
    const img = frame();
    let grabs = 0;
    let hang = false;
    const tracker = createTracker({
      frames: {
        grab: () => {
          grabs++;
          if (hang) return new Promise(() => {});
          return Promise.resolve(img as never);
        },
      },
      detector: async () => ({
        detect: async () => {
          return [faceAt(0.25)];
        },
      }),
      periodMs: 20,
      watchdogMs: 150,
    });
    const s = tracker(trackCtx(ptzLog));
    for (let i = 0; i < 200 && !ptzLog.some((l) => l.startsWith('drive')); i++) await new Promise((r) => setTimeout(r, 10));
    expect(ptzLog.some((l) => l.startsWith('drive 1,0'))).toBe(true); // face right of centre: pan right
    hang = true;
    await new Promise((r) => setTimeout(r, 400));
    // explicit pan/tilt stop AND zoom stop
    expect(ptzLog.slice(-2)).toEqual(['stop', 'zoom 0']);
    expect(s.moved).toBe(true);
    void s.stop('test');
    expect(grabs).toBeGreaterThan(3);
  });

  it('stop() queues an explicit stop and nothing after it', async () => {
    const ptzLog: string[] = [];
    const img = frame();
    const tracker = createTracker({
      frames: { grab: () => new Promise((r) => setTimeout(() => r(img as never), 5)) },
      detector: async () => ({ detect: async () => [faceAt(-0.25)] }),
      periodMs: 20,
    });
    const s = tracker(trackCtx(ptzLog));
    for (let i = 0; i < 200 && !ptzLog.some((l) => l.startsWith('drive')); i++) await new Promise((r) => setTimeout(r, 10));
    expect(ptzLog.some((l) => l.startsWith('drive -1,0'))).toBe(true);
    const n = ptzLog.length;
    const p = s.stop('speaker changed');
    expect(ptzLog[n]).toBe('stop'); // synchronously queued
    await p;
    expect(ptzLog.slice(n).every((l) => l === 'stop' || l === 'zoom 0')).toBe(true);
  });

  it('settings come from the policy and the calibration sign', () => {
    const camera = cameraSchema.parse({
      id: 'p',
      name: 'p',
      driver: 'birddog',
      role: 'ptz',
      options: { autoframe: { calibration: { points: [{ zoom: 0, dxPerPan: -0.001, dyPerTilt: 0.002 }] } } },
    });
    const s = trackSettings(policySchema.parse({ trackDeadzoneXPct: 8, trackMaxSpeed: 4, trackMaxExcursionPct: 20 }), camera);
    expect(s).toMatchObject({ deadzoneX: 0.08, deadzoneY: 0.12, maxLevel: 4, maxExcursionX: 0.2, panSign: 1, tiltSign: -1 });
  });
});

// ------------------------------------------------------------------ room controller wiring

describe('RoomController - track mode', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  function setup() {
    const order: string[] = [];
    const shows: string[] = [];
    const events: RoomEvent[] = [];
    const sessions: Array<{ ctx: TrackContext; stopped: string | null }> = [];
    let readyNow: ((v: { adjusted: boolean; detail: string }) => void) | null = null;
    const tracker: ShotTracker = (ctx) => {
      const rec = { ctx, stopped: null as string | null };
      sessions.push(rec);
      order.push(`track ${ctx.shot.preset}`);
      let end!: () => void;
      const done = new Promise<void>((r) => (end = r));
      const s: TrackSession = {
        ready: new Promise((r) => (readyNow = r)),
        onAir: () => order.push('onAir'),
        moved: true,
        stop: async (why) => {
          rec.stopped = why;
          order.push(`stop (${why})`);
          end();
        },
        done,
      };
      return s;
    };
    const cfg: RoomConfig = {
      id: 'r',
      name: 'r',
      enabled: true,
      dcenHost: '',
      dcenPort: 3225,
      outputName: 'o',
      outputMode: 'route',
      cameras: [
        cameraSchema.parse({ id: 'wide', name: 'wide', driver: 'birddog', role: 'wide', ndiSource: 'WIDE', settleMs: 0 }),
        cameraSchema.parse({ id: 'ptz', name: 'ptz', driver: 'birddog', role: 'ptz', ndiSource: 'PTZ', settleMs: 2000 }),
      ],
      seats: [
        { unit: 1, label: 'One', cameraId: 'ptz', preset: '1' },
        { unit: 2, label: 'Two', cameraId: 'ptz', preset: '2' },
      ],
      policy: policySchema.parse({ refine: 'track', refineTimeoutMs: 3000, returnToWideMs: 0 }),
    };
    const output: ProgramOutput = { name: 'o', mode: 'route', current: null, show: (s) => (shows.push(s ?? ''), { ok: true }), connections: () => 0, close() {} };
    const drivers = new Map<string, CameraDriver>();
    for (const c of cfg.cameras)
      drivers.set(c.id, {
        kind: 'fake',
        recallPreset: async (p) => {
          order.push(`recall ${p}`);
        },
        probe: async () => ({ ok: true }),
        ptz: fakePtz([]),
      });
    const ctl = new RoomController(cfg, { drivers, output, tracker });
    ctl.on('event', (e) => events.push(e));
    const feed = (l: string) => ctl.handleDcen(parseLine(l));
    ['MIC-OFF;FFFF;FFFF;', 'READY;'].forEach(feed);
    return { ctl, order, shows, sessions, feed, ready: (d = 'framed') => readyNow?.({ adjusted: true, detail: d }), events };
  }

  /** A good seated shot (eyes on the eye line, headroom ~14%). */
  const GOOD = { state: 'locked' as const, lostMs: 0, box: { x: 0.43, y: 0.22, w: 0.14, h: 0.25 }, eye: { x: 0.5, y: 0.32 }, source: 'face' as const, speed: 0 };

  it('mic on: recall, settle, track; the program goes to the PTZ only after the shot is good for the hold time', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(100);
    h.feed('MIC-ON;0001;;');
    await vi.advanceTimersByTimeAsync(300 + 2000);
    expect(h.order).toEqual(['recall 1', 'track 1']);
    expect(h.shows.at(-1)).toBe('WIDE');
    expect(h.ctl.snapshot().tracking).toMatchObject({ cameraId: 'ptz', unit: 1, state: 'acquiring', gate: { state: 'searching', onPtz: false } });
    const ctx = h.sessions[0]!.ctx;
    // 'framed' alone no longer cuts: the gate does
    h.ready();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.shows.at(-1)).toBe('WIDE');
    for (let i = 0; i <= 3; i++) {
      ctx.onShot!({ ...GOOD, t: Date.now() });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(h.shows.at(-1)).toBe('WIDE'); // 300 ms good < 400 ms hold
    ctx.onShot!({ ...GOOD, t: Date.now() });
    expect(h.shows.at(-1)).toBe('PTZ');
    expect(h.order.at(-1)).toBe('onAir');
    expect(h.sessions[0]!.stopped).toBeNull();
    expect(h.events.some((e) => e.type === 'log' && /program -> ptz "PTZ" \(seat One; shot good: headroom 1[45]%, face 25%\)/.test(e.msg))).toBe(true);
    expect(h.ctl.snapshot().tracking?.gate).toMatchObject({ state: 'good', onPtz: true });
  });

  it('never a good shot: no cut on a timeout, the program stays on wide all turn', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(100);
    h.feed('MIC-ON;0001;;');
    await vi.advanceTimersByTimeAsync(2300);
    const ctx = h.sessions[0]!.ctx;
    // round 2: acquired late, face cut off at the top (no headroom) for the whole turn
    for (let i = 0; i < 150; i++) {
      ctx.onShot!({ ...GOOD, t: Date.now(), state: i < 40 ? 'acquiring' : 'locked', lostMs: i < 40 ? Infinity : 0, box: i < 40 ? null : { x: 0.4, y: 0.02, w: 0.15, h: 0.27 } });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(h.shows).not.toContain('PTZ');
    expect(h.ctl.snapshot().tracking?.gate).toMatchObject({ state: 'bad', onPtz: false });
    expect(h.events.some((e) => e.type === 'log' && /shot not good after 3000 ms .*program stays on wide/.test(e.msg))).toBe(true);
  });

  it('speaker change: tracking stops (explicit stop) before wide cover and the next recall', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(100);
    h.feed('MIC-ON;0001;;');
    await vi.advanceTimersByTimeAsync(2300);
    h.ready();
    await vi.advanceTimersByTimeAsync(1);
    h.feed('MIC-ON;0002;;');
    expect(h.sessions[0]!.stopped).toBe('speaker changed');
    await vi.advanceTimersByTimeAsync(300);
    expect(h.shows.at(-1)).toBe('WIDE');
    expect(h.order.slice(-2)).toEqual(['stop (speaker changed)', 'recall 2']);
  });

  it('pause, manual jog and manual recall stop tracking; it moved, so the same seat is recalled again', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(100);
    h.feed('MIC-ON;0001;;');
    await vi.advanceTimersByTimeAsync(2300);
    h.ctl.cameraMovedManually('ptz', null);
    expect(h.sessions[0]!.stopped).toBe('manual control');
    expect(h.ctl.snapshot().tracking).toBeNull();
    h.ctl.setPaused(true);
    h.ctl.setPaused(false);
    await vi.advanceTimersByTimeAsync(2300);
    expect(h.order.filter((o) => o === 'recall 1')).toHaveLength(2);
    expect(h.sessions).toHaveLength(2);
    h.ctl.setPaused(true);
    expect(h.sessions[1]!.stopped).toBe('paused');
  });

  it('manual test hook refuses while a mic is on or the camera is on program', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(100);
    h.feed('MIC-ON;0001;;');
    await expect(h.ctl.startManualTracking('ptz', 2000)).rejects.toThrow(/quiet/);
    h.feed('MIC-OFF;0001;');
    await vi.advanceTimersByTimeAsync(100);
    h.ctl.takeCamera('ptz');
    await expect(h.ctl.startManualTracking('ptz', 2000)).rejects.toThrow(/on program/);
    h.ctl.takeCamera('wide');
    const p = h.ctl.startManualTracking('ptz', 2000);
    expect(h.ctl.snapshot().tracking).toMatchObject({ manual: true });
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(h.sessions.at(-1)!.stopped).toBe('test duration over');
  });
});
