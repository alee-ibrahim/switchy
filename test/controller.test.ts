import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DUMP_WINDOW_MS, RoomController, type RoomEvent, type ShotRefiner } from '../src/engine/room/controller.js';
import { parseLine } from '../src/engine/dcen/parser.js';
import type { CameraDriver } from '../src/engine/cameras/types.js';
import type { ProgramOutput } from '../src/engine/output/program.js';
import { policySchema, type RoomConfig } from '../src/engine/types.js';

const WIDE = 'BIRDDOG (CAM)';
const PTZ = 'BIRDDOG-X1 (CAM)';

/** A two-camera committee room as configured for a live test. */
function roomA(policy: Partial<RoomConfig['policy']> = {}): RoomConfig {
  return {
    id: 'room-a',
    name: 'Committee Room A',
    enabled: true,
    dcenHost: '',
    dcenPort: 3225,
    outputName: 'Switchy (Committee Room A Program)',
    outputMode: 'route',
    cameras: [
      { id: 'wide', name: 'P100 wide', driver: 'birddog', host: '', port: null, role: 'wide', ndiSource: WIDE, settleMs: 0, homePreset: null, credentialsRef: null, options: {} },
      { id: 'ptz', name: 'X1 Ultra', driver: 'birddog', host: '', port: null, role: 'ptz', ndiSource: PTZ, settleMs: 2000, homePreset: null, credentialsRef: null, options: {} },
    ],
    seats: [
      { unit: 3, label: 'Chair', cameraId: 'ptz', preset: '1' },
      { unit: 2, label: 'Right of chair', cameraId: 'ptz', preset: '2' },
      { unit: 4, label: 'Left of chair', cameraId: 'ptz', preset: '3' },
      { unit: 26, label: 'End', cameraId: 'ptz', preset: '4' },
      { unit: 1, label: 'Seat 1', cameraId: 'ptz', preset: '5' },
    ],
    policy: policySchema.parse({ debounceMs: 300, returnToWideMs: 3000, ...policy }),
  };
}

function harness(
  cfg: RoomConfig,
  opts: { failPresets?: Set<string>; refiner?: ShotRefiner; saved?: string[]; prepared?: string[] } = {},
) {
  const shows: Array<{ t: number; src: string | null }> = [];
  const recalls: Array<{ t: number; cam: string; preset: string }> = [];
  const events: RoomEvent[] = [];
  const output: ProgramOutput = {
    name: cfg.outputName,
    mode: 'route',
    current: null,
    show(src) {
      shows.push({ t: Date.now(), src });
      return { ok: true };
    },
    connections: () => 0,
    close() {},
  };
  const drivers = new Map<string, CameraDriver>();
  for (const c of cfg.cameras) {
    drivers.set(c.id, {
      kind: 'fake',
      async recallPreset(p) {
        recalls.push({ t: Date.now(), cam: c.id, preset: p });
        if (opts.failPresets?.has(p)) throw new Error('camera unreachable');
      },
      async probe() {
        return { ok: true };
      },
      ptz: {
        getPosition: async () => ({ pan: 0, tilt: 0, zoom: 0 }),
        moveAbsolute: async () => {},
        moveRelative: async () => {},
        zoomTo: async () => {},
        savePreset: async (p) => {
          opts.saved?.push(p);
        },
        drive: async () => {},
        zoomDrive: async () => {},
        stop: async () => {},
      },
    });
  }
  const ctl = new RoomController(cfg, {
    drivers,
    output,
    refiner: opts.refiner,
    refinePrepare: (cam) => opts.prepared?.push(`${Date.now()}:${cam.id}`),
    now: () => Date.now(),
  });
  ctl.on('event', (e) => events.push(e));
  const feed = (line: string) => ctl.handleDcen(parseLine(line));
  const adv = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const program = () => shows.at(-1)?.src ?? null;
  return { ctl, shows, recalls, events, feed, adv, program };
}

const DUMP = ['MICMODE;AUT-NEXT', 'MAXDEL;2;', 'PRIOMODE;OFF', 'MIC-OFF;FFFF;FFFF;', 'LANG;1;ENG;', 'READY;'];

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RoomController - two-camera room', () => {
  it('starts on wide after the connect dump', async () => {
    const h = harness(roomA());
    DUMP.forEach(h.feed);
    await h.adv(3000);
    expect(h.program()).toBe(WIDE);
    expect(h.recalls).toEqual([]);
  });

  it('mic on: wide -> recall preset -> settle -> PTZ', async () => {
    const h = harness(roomA());
    DUMP.forEach(h.feed);
    await h.adv(3000);
    h.feed('KEYS;0003;;00000;');
    h.feed('MIC-ON;0003;;');
    await h.adv(299);
    expect(h.recalls).toEqual([]); // debounce
    await h.adv(1);
    expect(h.recalls).toMatchObject([{ cam: 'ptz', preset: '1' }]);
    expect(h.program()).toBe(WIDE);
    await h.adv(1999);
    expect(h.program()).toBe(WIDE); // still settling
    await h.adv(1);
    expect(h.program()).toBe(PTZ);
  });

  it('PTZ on air, another seat speaks: cut to wide before moving', async () => {
    const h = harness(roomA());
    DUMP.forEach(h.feed);
    await h.adv(3000);
    h.feed('MIC-ON;0003;;');
    await h.adv(2300);
    expect(h.program()).toBe(PTZ);
    h.feed('MIC-ON;0002;;');
    await h.adv(300);
    expect(h.recalls.map((r) => r.preset)).toEqual(['1', '2']);
    expect(h.program()).toBe(WIDE);
    await h.adv(2000);
    expect(h.program()).toBe(PTZ);
  });

  it('debounces a mic flick (on/off < 300 ms)', async () => {
    const h = harness(roomA());
    DUMP.forEach(h.feed);
    await h.adv(3000);
    h.feed('MIC-ON;0002;;');
    await h.adv(150);
    h.feed('MIC-OFF;0002;;');
    await h.adv(5000);
    expect(h.recalls).toEqual([]);
    expect(h.program()).toBe(WIDE);
  });

  it('new speaker mid-move cancels and restarts', async () => {
    const h = harness(roomA());
    DUMP.forEach(h.feed);
    await h.adv(3000);
    h.feed('MIC-ON;0003;;');
    await h.adv(300 + 1000); // moving to preset 1
    h.feed('MIC-ON;0002;;');
    await h.adv(1500); // old move would have finished here
    expect(h.program()).toBe(WIDE);
    await h.adv(800); // 300 debounce + 2000 settle after mic 2
    expect(h.recalls.map((r) => r.preset)).toEqual(['1', '2']);
    expect(h.program()).toBe(PTZ);
    expect(h.shows.filter((s) => s.src === PTZ)).toHaveLength(1);
  });

  it('never re-sends the same preset twice in a row', async () => {
    const h = harness(roomA());
    DUMP.forEach(h.feed);
    await h.adv(3000);
    h.feed('MIC-ON;0003;;');
    await h.adv(2300);
    h.feed('MIC-OFF;0003;;');
    await h.adv(3000);
    expect(h.program()).toBe(WIDE);
    h.feed('MIC-ON;0003;;');
    await h.adv(300);
    expect(h.recalls).toHaveLength(1);
    expect(h.program()).toBe(PTZ); // camera already there: straight cut
  });

  it('speaker goes off while others are on: most recent remaining speaker', async () => {
    const h = harness(roomA());
    DUMP.forEach(h.feed);
    await h.adv(3000);
    h.feed('MIC-ON;0004;;');
    h.feed('MIC-ON;0002;;');
    h.feed('MIC-ON;0001;;');
    await h.adv(2300);
    expect(h.recalls.map((r) => r.preset)).toEqual(['5']);
    h.feed('MIC-OFF;0001;;');
    await h.adv(2300);
    expect(h.recalls.map((r) => r.preset)).toEqual(['5', '2']);
    expect(h.program()).toBe(PTZ);
  });

  it('returns to wide after the configured delay when nobody is on', async () => {
    const h = harness(roomA({ returnToWideMs: 5000 }));
    DUMP.forEach(h.feed);
    await h.adv(5000);
    h.feed('MIC-ON;001A;;'); // unit 26 = 0x1A
    await h.adv(2300);
    expect(h.recalls.map((r) => r.preset)).toEqual(['4']);
    expect(h.program()).toBe(PTZ);
    h.feed('MIC-OFF;001A;;');
    await h.adv(4999);
    expect(h.program()).toBe(PTZ);
    await h.adv(1);
    expect(h.program()).toBe(WIDE);
  });

  it('chair priority keeps the chair on camera', async () => {
    const h = harness(roomA({ chairPriority: true, chairUnit: 3 }));
    DUMP.forEach(h.feed);
    await h.adv(3000);
    h.feed('MIC-ON;0003;;');
    await h.adv(2300);
    h.feed('MIC-ON;0002;;');
    await h.adv(3000);
    expect(h.recalls.map((r) => r.preset)).toEqual(['1']);
    h.feed('MIC-OFF;0003;;');
    await h.adv(2300);
    expect(h.recalls.map((r) => r.preset)).toEqual(['1', '2']);
  });

  it('a failed recall stays on wide and retries on the next trigger', async () => {
    const h = harness(roomA(), { failPresets: new Set(['1']) });
    DUMP.forEach(h.feed);
    await h.adv(3000);
    h.feed('MIC-ON;0003;;');
    await h.adv(3000);
    expect(h.program()).toBe(WIDE);
    expect(h.events.some((e) => e.type === 'log' && e.level === 'error')).toBe(true);
    h.feed('MIC-OFF;0003;;');
    await h.adv(3000);
    h.feed('MIC-ON;0003;;');
    await h.adv(300);
    expect(h.recalls.filter((r) => r.preset === '1')).toHaveLength(2);
  });

  it('pause stops automation; resume acts on the current speaker', async () => {
    const h = harness(roomA());
    DUMP.forEach(h.feed);
    await h.adv(3000);
    h.ctl.setPaused(true);
    h.feed('MIC-ON;0002;;');
    await h.adv(3000);
    expect(h.recalls).toEqual([]);
    h.ctl.setPaused(false);
    await h.adv(2300);
    expect(h.recalls.map((r) => r.preset)).toEqual(['2']);
    expect(h.program()).toBe(PTZ);
  });

  it('learn captures the next MIC-ON unit', async () => {
    const h = harness(roomA());
    const p = h.ctl.learnNext(10000);
    h.feed('MIC-ON;001A;;');
    await expect(p).resolves.toBe(26);
  });

  it('DCen disconnect forgets mics and keeps the program where it is', async () => {
    const h = harness(roomA());
    DUMP.forEach(h.feed);
    await h.adv(3000);
    h.feed('MIC-ON;0003;;');
    await h.adv(2300);
    h.ctl.setDcenConnected(false, 'test');
    await h.adv(10000);
    expect(h.program()).toBe(PTZ);
    expect(h.ctl.snapshot().micsOn).toEqual([]);
    DUMP.forEach(h.feed); // reconnect dump: all off -> wide after delay
    await h.adv(3000);
    expect(h.program()).toBe(WIDE);
  });
});

describe('RoomController - spurious MIC-OFF;FFFF after READY', () => {
  /** The test room with unit 8 mapped, as in the live test. */
  const withUnit8 = () => {
    const cfg = roomA();
    cfg.seats.push({ unit: 8, label: 'Seat 8', cameraId: 'ptz', preset: '8' });
    return cfg;
  };

  it('ignores FFFF while unit 8 is still on (real 19:54:51 / 19:55:15 / 19:55:40 sequence)', async () => {
    const h = harness(withUnit8());
    h.ctl.setDcenConnected(true, 'test');
    DUMP.forEach(h.feed);
    await h.adv(3000);
    expect(h.program()).toBe(WIDE);
    h.feed('MIC-ON;0008;;'); // 19:54:51
    await h.adv(2300);
    expect(h.program()).toBe(PTZ);
    await h.adv(24000 - 2300);
    h.feed('MIC-OFF;FFFF;FFFF;'); // 19:55:15, unit 8 still talking
    expect(h.ctl.snapshot().micsOn).toEqual([8]);
    expect(h.ctl.snapshot().speaker).toBe(8);
    await h.adv(25000); // no return-to-wide
    expect(h.program()).toBe(PTZ);
    expect(h.shows.at(-1)!.src).toBe(PTZ);
    expect(
      h.events.some((e) => e.type === 'log' && e.level === 'warn' && e.msg.includes('outside the connect dump')),
    ).toBe(true);
    h.feed('MIC-OFF;0008;;'); // 19:55:40, the real mic off
    expect(h.ctl.snapshot().micsOn).toEqual([]);
    await h.adv(3000);
    expect(h.program()).toBe(WIDE);
  });

  it('still honours FFFF in the dump after a reconnect', async () => {
    const h = harness(withUnit8());
    h.ctl.setDcenConnected(true, 'test');
    DUMP.forEach(h.feed);
    await h.adv(3000);
    h.feed('MIC-ON;0008;;');
    await h.adv(2300);
    h.ctl.setDcenConnected(false, 'test');
    h.ctl.setDcenConnected(true, 'test');
    h.feed('MIC-ON;0008;;'); // pretend stale state survived
    h.feed('MIC-OFF;FFFF;FFFF;');
    expect(h.ctl.snapshot().micsOn).toEqual([]);
    h.feed('READY;');
    await h.adv(3000);
    expect(h.program()).toBe(WIDE);
  });

  it('closes the dump window after a timeout if READY never arrives', async () => {
    const h = harness(withUnit8());
    h.ctl.setDcenConnected(true, 'test');
    DUMP.slice(0, -1).forEach(h.feed); // no READY
    await h.adv(DUMP_WINDOW_MS);
    h.feed('MIC-ON;0008;;');
    await h.adv(2300);
    h.feed('MIC-OFF;FFFF;FFFF;');
    await h.adv(5000);
    expect(h.ctl.snapshot().micsOn).toEqual([8]);
    expect(h.program()).toBe(PTZ);
  });
});

describe('RoomController - refine step (auto-framing seam)', () => {
  it('runs between PTZ arrival and the cut, and can save the preset', async () => {
    const saved: string[] = [];
    const calls: number[] = [];
    const h = harness(roomA({ refine: 'auto-frame', refineSavePreset: true }), {
      saved,
      refiner: async () => {
        calls.push(Date.now());
        await new Promise((r) => setTimeout(r, 500));
        return { adjusted: true };
      },
    });
    DUMP.forEach(h.feed);
    await h.adv(3000);
    h.feed('MIC-ON;0003;;');
    await h.adv(2300);
    expect(calls).toEqual([5300]); // after debounce + settle
    expect(h.program()).toBe(WIDE);
    await h.adv(500);
    expect(h.program()).toBe(PTZ);
    expect(saved).toEqual(['1']);
  });

  it('prepares the refiner (e.g. opens the NDI receiver) when the seat move starts', async () => {
    const prepared: string[] = [];
    const h = harness(roomA({ refine: 'auto-frame' }), { prepared, refiner: async () => ({ adjusted: false, detail: 'x' }) });
    DUMP.forEach(h.feed);
    await h.adv(3000);
    expect(prepared).toEqual([]); // wide shot: no refine
    h.feed('MIC-ON;0003;;');
    await h.adv(300);
    expect(prepared).toEqual([`3300:${h.ctl.config.cameras.find((c) => c.role === 'ptz')!.id}`]);
    await h.adv(2500);
    expect(h.program()).toBe(PTZ);
    expect(h.events.some((e) => e.type === 'log' && /refine kept preset framing \(x\)/.test(e.msg))).toBe(true);
  });

  it('times out: shows the preset only with fallback "preset"; by default (no face seen) stays on wide', async () => {
    for (const [fallback, want] of [['preset', PTZ], ['preset-if-face', WIDE], ['wide', WIDE]] as const) {
      const h = harness(roomA({ refine: 'auto-frame', refineTimeoutMs: 1000, autoFrameFallback: fallback }), {
        refiner: () => new Promise(() => {}),
      });
      DUMP.forEach(h.feed);
      await h.adv(3000);
      h.feed('MIC-ON;0003;;');
      await h.adv(2300 + 999);
      expect(h.program()).toBe(WIDE);
      await h.adv(1);
      expect(h.program()).toBe(want);
      await h.adv(5000);
      expect(h.program()).toBe(want);
    }
  });

  it('timeout with fallback "preset-if-face": the preset only if a face was seen with headroom', async () => {
    for (const [headroom, want] of [[true, PTZ], [false, WIDE]] as const) {
      const h = harness(roomA({ refine: 'auto-frame', refineTimeoutMs: 1000 }), {
        refiner: (ctx) => {
          ctx.onCheck?.({ good: false, faceWithHeadroom: headroom, reason: headroom ? 'eye line low (52%)' : 'head cut off at the top (-3%)' });
          return new Promise(() => {});
        },
      });
      DUMP.forEach(h.feed);
      await h.adv(3000);
      h.feed('MIC-ON;0003;;');
      await h.adv(2300 + 1000);
      expect(h.program()).toBe(want);
    }
  });

  it('auto-frame: cuts only if the verify picture passes the shot gate', async () => {
    for (const [gate, want] of [
      [{ good: true, faceWithHeadroom: true, reason: 'headroom 9%, face 22%' }, PTZ],
      [{ good: false, faceWithHeadroom: false, reason: 'no face found (0 detections)' }, WIDE],
      [{ good: false, faceWithHeadroom: true, reason: 'eye line low (55%)' }, PTZ], // default fallback: face with headroom
    ] as const) {
      const h = harness(roomA({ refine: 'auto-frame' }), { refiner: async () => ({ adjusted: false, gate }) });
      DUMP.forEach(h.feed);
      await h.adv(3000);
      h.feed('MIC-ON;0003;;');
      await h.adv(2300 + 100);
      expect(h.program()).toBe(want);
      if (want === WIDE) expect(h.events.some((e) => e.type === 'log' && /program stays on wide \(fallback preset-if-face\)/.test(e.msg))).toBe(true);
    }
  });

  it('is skipped when refine is off', async () => {
    let called = false;
    const h = harness(roomA(), {
      refiner: async () => {
        called = true;
        return { adjusted: false };
      },
    });
    DUMP.forEach(h.feed);
    await h.adv(3000);
    h.feed('MIC-ON;0003;;');
    await h.adv(2300);
    expect(called).toBe(false);
    expect(h.program()).toBe(PTZ);
  });
});

describe('RoomController - one-camera room', () => {
  function oneCam(policy: Partial<RoomConfig['policy']>): RoomConfig {
    const r = roomA(policy);
    return {
      ...r,
      cameras: [{ ...r.cameras[1]!, role: 'both', homePreset: '9' }],
    };
  }

  it('live mode shows the move', async () => {
    const h = harness(oneCam({ oneCameraMove: 'live' }));
    DUMP.forEach(h.feed);
    await h.adv(3000);
    expect(h.recalls.map((r) => r.preset)).toEqual(['9']); // home preset = wide shot
    await h.adv(2000);
    expect(h.program()).toBe(PTZ);
    h.feed('MIC-ON;0003;;');
    await h.adv(300);
    expect(h.recalls.map((r) => r.preset)).toEqual(['9', '1']);
    expect(h.shows.map((s) => s.src)).toEqual([PTZ]); // never left the camera
  });

  it('holding mode routes to the holding source while moving', async () => {
    const h = harness(oneCam({ oneCameraMove: 'holding', holdingSource: 'GFX (Room A slate)' }));
    DUMP.forEach(h.feed);
    await h.adv(5000);
    h.feed('MIC-ON;0003;;');
    await h.adv(300);
    expect(h.program()).toBe('GFX (Room A slate)');
    await h.adv(2000);
    expect(h.program()).toBe(PTZ);
  });
});

describe('RoomController - replay a recorded DCen session', () => {
  it('replays the prototype log without re-sending presets or cutting mid-move', async () => {
    const file = path.join(import.meta.dirname, 'fixtures', 'dcen-session-2026-11-11.txt');
    const entries = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const [time, ...rest] = l.split(' ');
        const [hh, mm, ss] = time!.split(':');
        return { t: (Number(hh) * 3600 + Number(mm) * 60 + Number(ss)) * 1000, line: rest.join(' ') };
      });
    const h = harness(roomA());
    const t0 = entries[0]!.t;
    let now = t0;
    vi.setSystemTime(0);
    for (const e of entries) {
      await h.adv(e.t - now);
      now = e.t;
      if (e.line === 'MICMODE;AUT-NEXT') h.ctl.setDcenConnected(true, 'replay'); // new connection
      h.feed(e.line);
    }
    await h.adv(10000);

    // no identical consecutive recall
    for (let i = 1; i < h.recalls.length; i++) expect(h.recalls[i]!.preset).not.toBe(h.recalls[i - 1]!.preset);
    // every cut to the PTZ happens >= settle time after the last recall
    for (const s of h.shows.filter((x) => x.src === PTZ)) {
      const last = h.recalls.filter((r) => r.t <= s.t).at(-1);
      expect(last).toBeDefined();
      expect(s.t - last!.t).toBeGreaterThanOrEqual(2000);
    }
    // the session ends with all mics off -> wide
    expect(h.program()).toBe(WIDE);
    // unit 26 (001A) was recognised this time (the prototype could not parse it)
    expect(h.recalls.some((r) => r.preset === '4')).toBe(true);
    expect(h.recalls.length).toBeGreaterThan(5);
  });
});
