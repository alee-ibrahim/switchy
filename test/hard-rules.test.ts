/**
 * Hard rules for tracking (live evaluation in a test room):
 *  - every speaker turn in track mode recalls the seat preset (the same seat on
 *    and off four times, with the camera moved in between, must recall 4 times);
 *  - the start-of-session position check recalls a preset that did not take
 *    (P100 found at 1061/-46/z16384 while preset 6 is 439/-59/z8202);
 *  - lost -> holding -> reacquired (near the last position or the preset aim,
 *    never a neighbour outside the seat region);
 *  - zoom only as bounded absolute steps within the preset zoom +/- tolerance;
 *  - a too-tight face recalls the preset;
 *  - the excursion limit holds in VISCA units even if the picture says nothing moved;
 *  - start-up stop, idle sanity check and explicit stops on room stop.
 * No images of people: faces are synthetic boxes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackController, type TrackEvent } from '../src/engine/autoframe/track-controller.js';
import { createTracker } from '../src/engine/autoframe/tracker.js';
import { checkAgainstPreset, clampZoom, excursionUnits, zoomWithin } from '../src/engine/autoframe/limits.js';
import type { Face } from '../src/engine/autoframe/yunet.js';
import type { CameraDriver, PtzControl, PtzPosition } from '../src/engine/cameras/types.js';
import type { ProgramOutput } from '../src/engine/output/program.js';
import { RoomController, type RoomEvent, type ShotTracker, type TrackContext, type TrackSession } from '../src/engine/room/controller.js';
import { parseLine } from '../src/engine/dcen/parser.js';
import { cameraSchema, policySchema, type RoomConfig, type RoomPolicy } from '../src/engine/types.js';

const W = 640;
const H = 360;
const EYE = 1 / 3;

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

/** A face with its eye point at (x, y) frame fractions, h = face height fraction. */
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

// ------------------------------------------------------------------ pure limits

describe('limits in camera units', () => {
  it('zoom tolerance and clamp around the preset zoom', () => {
    expect(zoomWithin(8202 * 1.14, 8202, 15)).toBe(true);
    expect(zoomWithin(16384, 8202, 15)).toBe(false);
    expect(clampZoom(20000, 8202, 15)).toBe(Math.round(8202 * 1.15));
    expect(clampZoom(0, 8202, 15)).toBe(Math.round(8202 * 0.85));
  });
  it('excursion % of the frame -> VISCA units from the calibration at the preset zoom', () => {
    const u = excursionUnits(CAL, 8202, 0.35);
    expect(u.pan).toBe(Math.round(0.35 / 3.416e-3)); // ~102 pan units
    expect(u.tilt).toBe(Math.round(0.35 / 5.048e-3));
    // the eval state is far off preset 6 (pan and zoom)
    const c = checkAgainstPreset({ pan: 1061, tilt: -46, zoom: 16384 }, P6, { zoomTolPct: 15, units: u });
    expect(c.ok).toBe(false);
    expect(c.why).toMatch(/zoom 16384/);
    expect(c.why).toMatch(/pan 1061/);
    expect(checkAgainstPreset({ pan: 493, tilt: -59, zoom: 8202 }, P6, { zoomTolPct: 15, units: u }).ok).toBe(true);
  });
});

// ------------------------------------------------------------------ controller: loss and reacquisition

/** Static camera, wide deadzone (no moves): only the target logic is exercised. */
function run(ctl: TrackController, from: number, to: number, faces: (t: number) => Face[]) {
  const events: TrackEvent[] = [];
  const states: string[] = [];
  for (let t = from; t <= to; t += 100) {
    const out = ctl.step({ t, width: W, height: H, faces: faces(t), shift: { dx: 0, dy: 0, peak: 30 } });
    events.push(...out.events);
    if (states.at(-1) !== out.state) states.push(out.state);
  }
  return { events, states };
}
const quiet = () => new TrackController({ deadzoneX: 0.3, deadzoneY: 0.3 });

describe('track controller: lost -> holding -> reacquire', () => {
  it('reacquires the delegate near the last known position after a long loss (beyond the strict gate)', () => {
    const ctl = quiet();
    run(ctl, 0, 1000, () => [face(0.55, EYE, 0.2)]);
    expect(ctl.state).toBe('locked');
    const lost = run(ctl, 1100, 7000, () => []);
    expect(lost.states).toEqual(['locked', 'lost', 'holding']);
    // back 1.8 face heights to the right of where they were (the strict gate allows ~1.2)
    const back = run(ctl, 7100, 8000, () => [face(0.75, EYE, 0.21)]);
    expect(back.states).toContain('locked');
    expect(back.events.find((e) => e.kind === 'reacquired')?.msg).toMatch(/reacquired after \d+ ms/);
  });

  it('reacquires near the preset aim even far from the last known position', () => {
    const ctl = quiet();
    run(ctl, 0, 1000, () => [face(0.76, EYE, 0.2)]);
    expect(ctl.state).toBe('locked');
    run(ctl, 1100, 4000, () => []);
    expect(ctl.state).toBe('holding');
    run(ctl, 4100, 5000, () => [face(0.47, EYE + 0.03, 0.19)]);
    expect(ctl.state).toBe('locked');
  });

  it('never takes a face outside the seat region (a neighbour), even with the widened gate', () => {
    const ctl = quiet();
    run(ctl, 0, 1000, () => [face(0.78, EYE, 0.2)]);
    expect(ctl.state).toBe('locked');
    run(ctl, 1100, 6000, () => []);
    // 0.40 from the preset aim: outside the seat region (35%)
    const r = run(ctl, 6100, 9000, () => [face(0.9, EYE, 0.2)]);
    expect(r.states).toEqual(['holding']);
  });

  it('reacquisition can be switched off', () => {
    const ctl = new TrackController({ deadzoneX: 0.3, deadzoneY: 0.3, reacquire: false });
    run(ctl, 0, 1000, () => [face(0.55, EYE, 0.2)]);
    run(ctl, 1100, 7000, () => []);
    run(ctl, 7100, 8000, () => [face(0.75, EYE, 0.21)]);
    expect(ctl.state).toBe('holding');
  });

  it('a face taller than the limit is reported as too tight (locked and at acquisition)', () => {
    const ctl = quiet();
    run(ctl, 0, 1000, () => [face(0.5, EYE, 0.2)]);
    const r = run(ctl, 1100, 2500, (t) => [face(0.5, EYE, t < 1500 ? 0.25 : 0.42)]);
    expect(r.events.some((e) => e.kind === 'too-tight')).toBe(true);
    const fresh = quiet();
    const a = run(fresh, 0, 1000, () => [face(0.5, EYE, 0.45)]);
    expect(a.states).toEqual(['acquiring']); // never locks on it
    expect(a.events.some((e) => e.kind === 'too-tight')).toBe(true);
  });

  it('a blocked drive direction (VISCA limit) is never driven; moving back is allowed', () => {
    const ctl = new TrackController();
    ctl.block = { pan: 1, tilt: 0 };
    const r = run(ctl, 0, 2000, () => [face(0.75, EYE, 0.2)]); // wants to pan right
    expect(ctl.command().pan.dir).toBe(0);
    expect(r.events.some((e) => e.kind === 'limit')).toBe(true);
    const back = new TrackController();
    back.block = { pan: 1, tilt: 0 };
    run(back, 0, 1000, () => [face(0.25, EYE, 0.2)]); // pan left: allowed
    expect(back.command().pan.dir).toBe(-1);
  });
});

// ------------------------------------------------------------------ session against a fake P100

interface FakeCam {
  pos: PtzPosition;
  log: string[];
  ptz: PtzControl;
  driver: CameraDriver;
}

/**
 * Pan/tilt follow the drive commands in real time (unitsPerSecPerLevel), zoom
 * follows zoomTo. recallPreset puts it on the preset (unless ignoreRecalls).
 */
function fakeCam(start: PtzPosition, o: { unitsPerSec?: (level: number) => number; ignoreRecalls?: number } = {}): FakeCam {
  const pos = { ...start };
  const log: string[] = [];
  let drive = { pan: 0, tilt: 0, lp: 0, lt: 0, at: Date.now() };
  let ignore = o.ignoreRecalls ?? 0;
  const ups = o.unitsPerSec ?? ((l: number) => 30 * l);
  const integrate = () => {
    const now = Date.now();
    const dt = (now - drive.at) / 1000;
    if (drive.pan) pos.pan += drive.pan * ups(drive.lp) * dt;
    if (drive.tilt) pos.tilt += drive.tilt * ups(drive.lt) * dt;
    drive.at = now;
  };
  const ptz: PtzControl = {
    getPosition: async () => {
      integrate();
      return { pan: Math.round(pos.pan), tilt: Math.round(pos.tilt), zoom: Math.round(pos.zoom) };
    },
    moveAbsolute: async () => {},
    moveRelative: async () => {},
    zoomTo: async (z) => {
      log.push(`zoomTo ${z}`);
      pos.zoom = z;
    },
    savePreset: async () => {},
    drive: async (d, s) => {
      integrate();
      drive = { pan: d.pan, tilt: d.tilt, lp: s?.pan ?? 8, lt: s?.tilt ?? 8, at: Date.now() };
      log.push(d.pan || d.tilt ? `drive ${d.pan},${d.tilt}` : 'stop');
    },
    zoomDrive: async (d) => {
      log.push(`zoom ${d}`);
    },
    stop: async () => {
      integrate();
      drive = { pan: 0, tilt: 0, lp: 0, lt: 0, at: Date.now() };
      log.push('stop-all');
    },
  };
  const driver: CameraDriver = {
    kind: 'fake',
    ptz,
    recallPreset: async (p) => {
      log.push(`recall ${p}`);
      if (ignore > 0) {
        ignore--;
        return;
      }
      integrate();
      Object.assign(pos, P6);
    },
    probe: async () => ({ ok: true }),
  };
  return { pos, log, ptz, driver };
}

/** identical textured frames: the picture never shows motion (worst case for image-based estimates) */
function frame() {
  const w = 128;
  const h = 72;
  const data = new Uint8Array(w * h * 4);
  let s = 7;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const v = s >>> 24;
    data.set([v, v, v, 255], i * 4);
  }
  return { width: w, height: h, data };
}

function sessionCtx(cam: FakeCam, policy: Partial<RoomPolicy> = {}, logs: string[] = []): TrackContext {
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
    policy: policySchema.parse({ refine: 'track', ...policy }),
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

describe('tracking session: hard rules against a fake P100', () => {
  const img = frame();
  const frames = { grab: async () => img as never };
  const fast = { periodMs: 20, recallStillMinMs: 0, positionCheckMs: 200, idleReadAfterMs: 100 };

  it('eval 22:26: preset recall did not take (zoom 16384, pan 1061): the start check stops and recalls preset 6', async () => {
    const cam = fakeCam({ pan: 1061, tilt: -46, zoom: 16384 });
    const logs: string[] = [];
    let after = false;
    const tracker = createTracker({
      frames,
      // the face only shows once the camera is back on the preset
      detector: async () => ({ detect: async () => (cam.pos.zoom === P6.zoom ? ((after = true), [face(0.5, EYE, 0.22, 128, 72)]) : []) }),
      ...fast,
    });
    const s = tracker(sessionCtx(cam, {}, logs));
    await waitFor(() => after && logs.some((l) => /acquired/.test(l)));
    await s.stop('test');
    expect(logs.find((l) => /start: camera at 1061\/-46\/z16384, preset 6 is at 439\/-59\/z8202/.test(l))).toMatch(/stop \+ recall preset 6/);
    const i = cam.log.indexOf('recall 6');
    expect(i).toBeGreaterThan(0);
    expect(cam.log.slice(0, i)).toEqual(expect.arrayContaining(['stop', 'zoom 0'])); // explicit pan/tilt and zoom stop first
    expect(logs.some((l) => /target acquired/.test(l))).toBe(true);
  });

  it('pan never goes beyond the excursion limit in VISCA units, even when the picture shows no motion', async () => {
    const cam = fakeCam({ ...P6 }, { unitsPerSec: (l) => (1.0 * [0, 0.006, 0.091, 0.157, 0.179, 0.25, 0.324, 0.39, 0.45, 0.51, 0.57, 0.63, 0.69][l] ?? 0.69) / 3.416e-3 });
    const logs: string[] = [];
    let maxOff = 0;
    const tracker = createTracker({
      frames,
      // the face stays right of centre whatever the camera does (image estimate useless)
      detector: async () => ({
        detect: async () => {
          maxOff = Math.max(maxOff, Math.abs(cam.pos.pan - P6.pan));
          return [face(0.75, EYE, 0.2, 128, 72)];
        },
      }),
      ...fast,
    });
    const s = tracker(sessionCtx(cam, { trackMaxExcursionPct: 35 }, logs));
    await new Promise((r) => setTimeout(r, 3500));
    await s.stop('test');
    const limit = excursionUnits(CAL, P6.zoom, 0.35).pan;
    expect(cam.log.some((l) => l.startsWith('drive 1'))).toBe(true);
    expect(maxOff).toBeGreaterThan(20);
    expect(maxOff).toBeLessThanOrEqual(limit + 5);
    expect(Math.abs(cam.pos.pan - P6.pan)).toBeLessThanOrEqual(limit + 5);
    expect(logs.some((l) => /excursion limit \(camera position, VISCA units\)/.test(l))).toBe(true);
    // no start/stop chatter at the edge
    expect(Number(logs.find((l) => / ended: /.test(l))!.match(/(\d+) moves/)![1])).toBeLessThanOrEqual(6);
  }, 10_000);

  it('zoom (when enabled) only as absolute steps inside the preset zoom +/- 15%, never a zoom drive', async () => {
    const cam = fakeCam({ ...P6 });
    const tracker = createTracker({
      frames,
      detector: async () => ({ detect: async () => [face(0.5, EYE, 0.09, 128, 72)] }), // small face: wants to zoom in
      ...fast,
    });
    const s = tracker(sessionCtx(cam, { trackZoom: true }));
    await new Promise((r) => setTimeout(r, 7000));
    await s.stop('test');
    const steps = cam.log.filter((l) => l.startsWith('zoomTo')).map((l) => Number(l.split(' ')[1]));
    expect(steps.length).toBeGreaterThan(1);
    expect(Math.max(...steps)).toBeLessThanOrEqual(Math.round(P6.zoom * 1.15));
    expect(steps.at(-1)).toBe(Math.round(P6.zoom * 1.15)); // reached the limit and stayed there
    expect(cam.log.filter((l) => /^zoom [-]?1$/.test(l))).toEqual([]);
  }, 12_000);

  it('zoom is never touched when trackZoom is off', async () => {
    const cam = fakeCam({ ...P6 });
    const tracker = createTracker({ frames, detector: async () => ({ detect: async () => [face(0.5, EYE, 0.09, 128, 72)] }), ...fast });
    const s = tracker(sessionCtx(cam));
    await new Promise((r) => setTimeout(r, 1500));
    await s.stop('test');
    expect(cam.log.filter((l) => l.startsWith('zoomTo') || /^zoom [-]?1$/.test(l))).toEqual([]);
  });

  it('a face far too big recalls the preset (once)', async () => {
    const cam = fakeCam({ ...P6 });
    const logs: string[] = [];
    const tracker = createTracker({ frames, detector: async () => ({ detect: async () => [face(0.5, EYE, 0.5, 128, 72)] }), ...fast });
    const s = tracker(sessionCtx(cam, {}, logs));
    await waitFor(() => cam.log.includes('recall 6'));
    await new Promise((r) => setTimeout(r, 800));
    await s.stop('test');
    expect(cam.log.filter((l) => l === 'recall 6')).toHaveLength(1);
    expect(logs.some((l) => /face too big in the frame; stop \+ recall preset 6/.test(l))).toBe(true);
  });

  it('no face for a long time and the camera is off the preset: recall once', async () => {
    const cam = fakeCam({ ...P6 });
    let reads = 0;
    const getPosition = cam.ptz.getPosition;
    // unreadable at the start, then reads show a zoom far off (someone zoomed it in)
    cam.ptz.getPosition = async () => {
      reads++;
      if (reads <= 5) throw new Error('VISCA timeout');
      const p = await getPosition();
      return cam.log.includes('recall 6') ? p : { ...p, zoom: 14000 };
    };
    const logs: string[] = [];
    const tracker = createTracker({ frames, detector: async () => ({ detect: async () => [] }), ...fast, noFaceCheckMs: 300, positionCheckMs: 100_000 });
    const s = tracker(sessionCtx(cam, {}, logs));
    await waitFor(() => cam.log.includes('recall 6'));
    await new Promise((r) => setTimeout(r, 600));
    await s.stop('test');
    expect(logs.some((l) => /no face found: camera at .*z14000/.test(l))).toBe(true);
    expect(cam.log.filter((l) => l === 'recall 6')).toHaveLength(1);
  });

  it('every stop is pan/tilt AND zoom, retried once when the camera does not answer', async () => {
    const cam = fakeCam({ ...P6 });
    let fails = 1;
    const drive = cam.ptz.drive;
    cam.ptz.drive = async (d, s) => {
      if (!d.pan && !d.tilt && fails-- > 0) {
        cam.log.push('stop-timeout');
        throw new Error('VISCA timeout');
      }
      return drive(d, s);
    };
    const tracker = createTracker({ frames, detector: async () => ({ detect: async () => [face(0.75, EYE, 0.2, 128, 72)] }), ...fast, positionCheckMs: 100_000 });
    const s = tracker(sessionCtx(cam));
    await waitFor(() => cam.log.some((l) => l.startsWith('drive')));
    const n = cam.log.length;
    await s.stop('speaker changed');
    const tail = cam.log.slice(n);
    expect(tail).toEqual(expect.arrayContaining(['stop-timeout', 'stop', 'zoom 0']));
  });
});

// ------------------------------------------------------------------ room controller

describe('RoomController - hard rules', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  function setup(policy: Partial<RoomPolicy>, opts: { pos?: PtzPosition; stored?: boolean } = {}) {
    const order: string[] = [];
    const shows: string[] = [];
    const events: RoomEvent[] = [];
    const pos = { ...(opts.pos ?? P6) };
    const tracker: ShotTracker = (ctx) => {
      order.push(`track ${ctx.shot.preset}`);
      let end!: () => void;
      const done = new Promise<void>((r) => (end = r));
      const s: TrackSession = {
        ready: new Promise(() => {}), // never framed (the shot gate never says good)
        onAir: () => {},
        moved: false, // the session itself never moved (0 moves), yet the camera may be elsewhere
        stop: async () => end(),
        done,
      };
      return s;
    };
    const ptzCam = cameraSchema.parse({
      id: 'ptz',
      name: 'P100',
      driver: 'birddog',
      role: 'ptz',
      ndiSource: 'PTZ',
      settleMs: 2000,
      options: opts.stored === false ? {} : { autoframe: { calibration: CAL, presets: { '6': P6, '7': { pan: 621, tilt: -50, zoom: 8202 } } } },
    });
    const cfg: RoomConfig = {
      id: 'r',
      name: 'r',
      enabled: true,
      dcenHost: '',
      dcenPort: 3225,
      outputName: 'o',
      outputMode: 'route',
      cameras: [cameraSchema.parse({ id: 'wide', name: 'wide', driver: 'birddog', role: 'wide', ndiSource: 'WIDE', settleMs: 0 }), ptzCam],
      seats: [
        { unit: 6, label: 'Seat 6', cameraId: 'ptz', preset: '6' },
        { unit: 7, label: 'Seat 7', cameraId: 'ptz', preset: '7' },
      ],
      policy: policySchema.parse({ refineTimeoutMs: 4000, returnToWideMs: 0, ...policy }),
    };
    const output: ProgramOutput = { name: 'o', mode: 'route', current: null, show: (s) => (shows.push(s ?? ''), { ok: true }), connections: () => 0, close() {} };
    const drivers = new Map<string, CameraDriver>();
    drivers.set('wide', { kind: 'fake', recallPreset: async (p) => void order.push(`wide recall ${p}`), probe: async () => ({ ok: true }) });
    const ptz: PtzControl = {
      getPosition: async () => ({ ...pos }),
      moveAbsolute: async () => {},
      moveRelative: async () => {},
      zoomTo: async () => {},
      savePreset: async () => {},
      drive: async () => {},
      zoomDrive: async () => {},
      stop: async () => void order.push('stop-all'),
    };
    drivers.set('ptz', {
      kind: 'fake',
      ptz,
      recallPreset: async (p) => {
        order.push(`recall ${p}`);
        Object.assign(pos, p === '7' ? { pan: 621, tilt: -50, zoom: 8202 } : P6);
      },
      probe: async () => ({ ok: true }),
    });
    const ctl = new RoomController(cfg, { drivers, output, tracker });
    ctl.on('event', (e) => events.push(e));
    const feed = (l: string) => ctl.handleDcen(parseLine(l));
    ['MIC-OFF;FFFF;FFFF;', 'READY;'].forEach(feed);
    const logs = () => events.filter((e) => e.type === 'log').map((e) => (e as { msg: string }).msg);
    return { ctl, order, shows, feed, pos, logs };
  }

  it('eval replay: seat 6 on/off four times with the camera moved in between -> the preset is recalled every time', async () => {
    const h = setup({ refine: 'track' });
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 4; i++) {
      h.feed('MIC-ON;0006;;');
      await vi.advanceTimersByTimeAsync(300 + 2000 + 4000 + 10);
      // never a good shot: no cut on a timeout any more, the program stays on wide all turn
      expect(h.shows.at(-1)).toBe('WIDE');
      expect(h.shows).not.toContain('PTZ');
      h.feed('MIC-OFF;0006;');
      await vi.advanceTimersByTimeAsync(50);
      expect(h.shows.at(-1)).toBe('WIDE');
      // something moves the camera to max zoom on a chair back (not logged by Switchy)
      Object.assign(h.pos, { pan: 1061, tilt: -46, zoom: 16384 });
    }
    expect(h.order.filter((o) => o === 'recall 6')).toHaveLength(4);
    expect(h.logs().filter((l) => /recall preset 6 \(seat Seat 6; again: track mode\)/.test(l))).toHaveLength(3);
  });

  it('auto-frame mode recalls on every turn too', async () => {
    const h = setup({ refine: 'auto-frame' });
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 2; i++) {
      h.feed('MIC-ON;0006;;');
      await vi.advanceTimersByTimeAsync(2400);
      h.feed('MIC-OFF;0006;');
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(h.order.filter((o) => o === 'recall 6')).toHaveLength(2);
  });

  it('plain preset mode keeps the de-duplication only while nothing moved the camera', async () => {
    const h = setup({ refine: 'off', returnToWideMs: 600_000 });
    await vi.advanceTimersByTimeAsync(100);
    h.feed('MIC-ON;0006;;');
    await vi.advanceTimersByTimeAsync(2400);
    h.feed('MIC-OFF;0006;');
    h.feed('MIC-ON;0006;;');
    await vi.advanceTimersByTimeAsync(2400);
    h.feed('MIC-ON;0007;;');
    await vi.advanceTimersByTimeAsync(2400);
    h.feed('MIC-ON;0006;;');
    await vi.advanceTimersByTimeAsync(2400);
    expect(h.order.filter((o) => o.startsWith('recall'))).toEqual(['recall 6', 'recall 7', 'recall 6']);
    h.ctl.cameraMovedManually('ptz', null); // jog
    h.feed('MIC-ON;0007;;');
    await vi.advanceTimersByTimeAsync(2400);
    h.feed('MIC-ON;0006;;');
    await vi.advanceTimersByTimeAsync(2400);
    expect(h.order.filter((o) => o.startsWith('recall'))).toEqual(['recall 6', 'recall 7', 'recall 6', 'recall 7', 'recall 6']);
  });

  it('start-up: explicit stop to every PTZ before the first recall', async () => {
    const h = setup({ refine: 'track' });
    h.ctl.startSafety(0);
    expect(h.order[0]).toBe('stop-all');
    h.feed('MIC-ON;0006;;');
    await vi.advanceTimersByTimeAsync(400);
    expect(h.order.indexOf('recall 6')).toBeGreaterThan(h.order.indexOf('stop-all'));
  });

  it('idle sanity check: PTZ idle off program, far from every preset -> stop + recall its last preset', async () => {
    const h = setup({ refine: 'track' });
    await vi.advanceTimersByTimeAsync(100);
    h.feed('MIC-ON;0006;;');
    await vi.advanceTimersByTimeAsync(6400);
    h.feed('MIC-OFF;0006;');
    await vi.advanceTimersByTimeAsync(50);
    Object.assign(h.pos, { pan: 1061, tilt: -46, zoom: 16384 });
    const n = h.order.length;
    const p = h.ctl.sanityCheck();
    await vi.advanceTimersByTimeAsync(600);
    await p;
    expect(h.order.slice(n)).toEqual(['stop-all', 'recall 6']);
    expect(h.logs().some((l) => /idle at 1061\/-46\/z16384, far from every stored preset; stop \+ recall preset 6/.test(l))).toBe(true);
    // in a sane place (a tracked offset within the limits): nothing is sent
    Object.assign(h.pos, { pan: 480, tilt: -59, zoom: 8202 });
    const m = h.order.length;
    const q = h.ctl.sanityCheck();
    await vi.advanceTimersByTimeAsync(600);
    await q;
    expect(h.order.length).toBe(m);
  });

  it('idle sanity check leaves the camera alone while it is on program, after manual control, or paused', async () => {
    const h = setup({ refine: 'track' }, { pos: { pan: 1061, tilt: -46, zoom: 16384 } });
    await vi.advanceTimersByTimeAsync(100);
    h.ctl.takeCamera('ptz');
    let p = h.ctl.sanityCheck();
    await vi.advanceTimersByTimeAsync(600);
    await p;
    h.ctl.takeCamera('wide');
    h.ctl.cameraMovedManually('ptz', null);
    p = h.ctl.sanityCheck();
    await vi.advanceTimersByTimeAsync(600);
    await p;
    expect(h.order.filter((o) => o.startsWith('recall') || o === 'stop-all')).toEqual([]);
  });

  it('room stop (restart/shutdown) sends an explicit stop to every PTZ', async () => {
    const h = setup({ refine: 'track' });
    await h.ctl.dispose();
    expect(h.order).toContain('stop-all');
  });
});
