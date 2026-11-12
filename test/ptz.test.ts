import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dgram from 'node:dgram';
import Fastify, { type FastifyInstance } from 'fastify';
import jpeg from 'jpeg-js';
import { BirdDogDriver } from '../src/engine/cameras/birddog.js';
import { ViscaDriver, viscaPanTiltDrive, viscaZoomDrive, parseSonyFrame } from '../src/engine/cameras/visca.js';
import { Jogger, jogSpeeds } from '../src/engine/cameras/jog.js';
import type { CameraDriver, PtzControl } from '../src/engine/cameras/types.js';
import { Engine } from '../src/engine/engine.js';
import { NdiService } from '../src/engine/ndi/service.js';
import type { FrameSource } from '../src/engine/ndi/frames.js';
import { downscale, encodeJpeg, jpegSize, resizeJpeg } from '../src/engine/image/jpeg.js';
import { registerPtzRoutes, type SeatStore } from '../src/api/ptz-routes.js';
import { parseLine } from '../src/engine/dcen/parser.js';
import { policySchema, type RoomConfig, type SeatConfig } from '../src/engine/types.js';

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('BirdDog savePreset (REST /save)', () => {
  it('posts Preset-N to /save and accepts {"Save-Preset":"N"}, also above 9', async () => {
    const f = fakeFetch((url, init) => {
      const p = JSON.parse(init.body as string).Preset.replace('Preset-', '');
      return Response.json({ 'Save-Preset': p });
    });
    const d = new BirdDogDriver({ host: '192.0.2.50', fetchImpl: f.fetchImpl, viscaPtz: false });
    await d.savePreset('12');
    expect(f.calls).toEqual([{ url: 'http://192.0.2.50:8080/save', body: { Preset: 'Preset-12' } }]);
  });

  it('rejects a mismatching answer and HTTP errors', async () => {
    const wrong = fakeFetch(() => Response.json({ 'Save-Preset': '3' }));
    await expect(new BirdDogDriver({ host: 'x', fetchImpl: wrong.fetchImpl, viscaPtz: false }).savePreset('4')).rejects.toThrow(/expected 4/);
    const err = fakeFetch(() => new Response('', { status: 500 }));
    await expect(new BirdDogDriver({ host: 'x', fetchImpl: err.fetchImpl, viscaPtz: false }).savePreset('4')).rejects.toThrow(/\/save HTTP 500/);
  });

  it('accepts an empty 200 body', async () => {
    const f = fakeFetch(() => new Response('', { status: 200 }));
    await new BirdDogDriver({ host: 'x', fetchImpl: f.fetchImpl, viscaPtz: false }).savePreset('2');
  });

  it('has VISCA ptz by default, but ptz.savePreset still goes over REST', async () => {
    const f = fakeFetch(() => Response.json({ 'Save-Preset': '7' }));
    const d = new BirdDogDriver({ host: '192.0.2.9', fetchImpl: f.fetchImpl });
    expect(d.ptz).toBeDefined();
    await d.ptz!.savePreset('7');
    expect(f.calls[0]!.url).toBe('http://192.0.2.9:8080/save');
    d.close();
    expect(new BirdDogDriver({ host: 'x', viscaPtz: false }).ptz).toBeUndefined();
  });
});

describe('VISCA jog commands', () => {
  it('builds pan/tilt drive commands (pan right = 02, tilt up = 01)', () => {
    expect(viscaPanTiltDrive(-1, 0, 5, 4).toString('hex')).toBe('810106010504' + '0103ff');
    expect(viscaPanTiltDrive(1, 1, 0x18, 0x14).toString('hex')).toBe('810106011814' + '0201ff');
    expect(viscaPanTiltDrive(0, -1).toString('hex')).toBe('810106010808' + '0302ff');
    expect(viscaPanTiltDrive(0, 0, 99, 0).toString('hex')).toBe('810106011801' + '0303ff'); // clamped
  });

  it('builds zoom drive commands', () => {
    expect(viscaZoomDrive(1, 7).toString('hex')).toBe('8101040727ff');
    expect(viscaZoomDrive(-1, 0).toString('hex')).toBe('8101040730ff');
    expect(viscaZoomDrive(0).toString('hex')).toBe('8101040700ff');
  });

  it('VISCA savePreset uses memory set with the preset offset', async () => {
    const got: Buffer[] = [];
    const cam = dgram.createSocket('udp4');
    cam.on('message', (msg, rinfo) => {
      const f = parseSonyFrame(msg)!;
      if (f.type === 0x0200) return cam.send(Buffer.from('020100010000000001', 'hex'), rinfo.port, rinfo.address);
      got.push(f.payload);
      const ack = Buffer.alloc(8);
      ack.writeUInt16BE(0x0111, 0);
      ack.writeUInt16BE(3, 2);
      ack.writeUInt32BE(f.seq, 4);
      cam.send(Buffer.concat([ack, Buffer.from([0x90, 0x41, 0xff])]), rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => cam.bind(0, '127.0.0.1', r));
    const d = new ViscaDriver({ host: '127.0.0.1', port: cam.address().port });
    try {
      await d.savePreset('3');
      await d.ptz.drive({ pan: 1, tilt: 0 }, { pan: 4, tilt: 4 });
      await d.ptz.stop();
      expect(got.map((b) => b.toString('hex'))).toEqual([
        '8101043f0102ff', // preset 3 -> memory 2 (Sony 0-based)
        '8101060104040203ff',
        '8101060108080303ff',
        '8101040700ff',
      ]);
    } finally {
      d.close();
      cam.close();
    }
  });
});

function fakePtz(log: string[]): PtzControl {
  return {
    getPosition: async () => ({ pan: 120, tilt: -59, zoom: 4000 }),
    moveAbsolute: async () => {},
    moveRelative: async () => {},
    zoomTo: async () => {},
    savePreset: async (p) => void log.push(`ptz.save ${p}`),
    drive: async (d, s) => void log.push(`drive ${d.pan},${d.tilt} @${s?.pan},${s?.tilt}`),
    zoomDrive: async (d, s) => void log.push(`zoom ${d} @${s}`),
    stop: async () => void log.push('stop'),
  };
}

describe('Jogger', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  it('maps 1-100 speed onto VISCA ranges', () => {
    expect(jogSpeeds(1)).toEqual({ pan: 1, tilt: 1, zoom: 0 });
    expect(jogSpeeds(100)).toEqual({ pan: 0x18, tilt: 0x14, zoom: 7 });
  });

  it('sends only changes, keeps alive on repeats, stops on release', async () => {
    const log: string[] = [];
    const j = new Jogger(fakePtz(log), { deadmanMs: 800 });
    await j.set({ pan: 1, tilt: 0, zoom: 0, speed: 100 });
    await vi.advanceTimersByTimeAsync(500);
    await j.set({ pan: 1, tilt: 0, zoom: 0, speed: 100 }); // repeat
    await vi.advanceTimersByTimeAsync(500);
    expect(log).toEqual(['drive 1,0 @24,20']);
    await j.set({ pan: 0, tilt: 0, zoom: 0, speed: 100 });
    expect(log).toEqual(['drive 1,0 @24,20', 'stop']);
    expect(j.active).toBe(false);
  });

  it('deadman stops the camera when the browser goes quiet', async () => {
    const log: string[] = [];
    const j = new Jogger(fakePtz(log), { deadmanMs: 800 });
    await j.set({ pan: 0, tilt: 0, zoom: 1, speed: 1 });
    expect(log).toEqual(['zoom 1 @0']);
    await vi.advanceTimersByTimeAsync(799);
    expect(log).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toEqual(['zoom 1 @0', 'stop']);
    expect(j.active).toBe(false);
  });
});

describe('JPEG helpers', () => {
  it('downscales RGBX by an integer factor and swaps BGRA', () => {
    const w = 8;
    const h = 4;
    const stride = w * 4 + 8; // padded rows
    const data = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([10, 20, 30, 0], y * stride + x * 4);
    const s = downscale({ width: w, height: h, stride, data, fourcc: 'BGRX' }, 4);
    expect(s.width).toBe(4);
    expect(s.height).toBe(2);
    expect([...s.data.subarray(0, 4)]).toEqual([30, 20, 10, 255]);
  });

  it('encodes, reads the size, and resizes', () => {
    const big = encodeJpeg({ width: 1280, height: 720, data: Buffer.alloc(1280 * 720 * 4, 128) });
    expect(jpegSize(big)).toEqual({ width: 1280, height: 720 });
    const small = resizeJpeg(big, { maxWidth: 320 });
    expect(jpegSize(small)).toEqual({ width: 320, height: 180 });
    expect(jpeg.decode(small).width).toBe(320);
  });
});

// ---------------------------------------------------------------- routes

function room(): RoomConfig {
  return {
    id: 'room-a',
    name: 'Committee Room A',
    enabled: true,
    dcenHost: '',
    dcenPort: 3225,
    outputName: 'Switchy (Committee Room A Program)',
    outputMode: 'route',
    cameras: [
      { id: 'a-wide', name: 'X1 Ultra wide', driver: 'none', host: '', port: null, role: 'wide', ndiSource: 'BIRDDOG-X1 (CAM)', settleMs: 0, homePreset: null, credentialsRef: null, options: {} },
      { id: 'a-ptz', name: 'P100 PTZ', driver: 'birddog', host: '192.0.2.50', port: null, role: 'ptz', ndiSource: 'BIRDDOG (CAM)', settleMs: 2500, homePreset: null, credentialsRef: null, options: {} },
    ],
    seats: [{ unit: 3, label: 'Chair', cameraId: 'a-ptz', preset: '3' }],
    policy: policySchema.parse({}),
  };
}

async function setup(opts: { frame?: boolean } = {}) {
  const log: string[] = [];
  const recalls: string[] = [];
  const drivers: Record<string, CameraDriver> = {
    'a-ptz': {
      kind: 'birddog',
      ptz: fakePtz(log),
      recallPreset: async (p) => void recalls.push(p),
      savePreset: async (p) => void log.push(`rest.save ${p}`),
      probe: async () => ({ ok: true }),
    },
    'a-wide': { kind: 'none', recallPreset: async () => {}, probe: async () => ({ ok: true }) },
  };
  const engine = new Engine(new NdiService({}, null), undefined, { createDriver: (c) => drivers[c.id]!, sanityCheckMs: 0 });
  const cfg = room();
  engine.upsertRoom(cfg);
  // the room starts with an explicit pan/tilt/zoom stop to every PTZ (start-up safety)
  expect(log).toEqual(['stop']);
  log.length = 0;
  let seats: SeatConfig[] = [...cfg.seats];
  const thumbs = new Map<number, { jpeg: Buffer; width: number; height: number; updatedAt: Date }>();
  const repo: SeatStore = {
    upsertSeat: async (_roomId, seat) => {
      seats = [...seats.filter((s) => s.unit !== seat.unit), seat].sort((a, b) => a.unit - b.unit);
      return seats;
    },
    putThumbnail: async (_roomId, unit, t) => {
      const updatedAt = new Date();
      thumbs.set(unit, { ...t, updatedAt });
      return updatedAt;
    },
    getThumbnail: async (_roomId, unit) => thumbs.get(unit) ?? null,
    listThumbnails: async () => [...thumbs.entries()].map(([unit, t]) => ({ unit, updatedAt: t.updatedAt })),
  };
  const grabs: string[] = [];
  const frames: FrameSource = {
    grab: async (name) => {
      grabs.push(name);
      if (opts.frame === false) return null;
      return { width: 640, height: 360, fourcc: 'RGBX', stride: 640 * 4, data: Buffer.alloc(640 * 360 * 4, 90) };
    },
  };
  const app: FastifyInstance = Fastify();
  registerPtzRoutes(app, { engine, repo, frames, jogDeadmanMs: 800 });
  await app.ready();
  const ctl = engine.room('room-a')!;
  const feed = (line: string) => ctl.handleDcen(parseLine(line));
  feed('READY;');
  const close = async () => {
    await app.close();
    await engine.stop();
  };
  return { app, engine, ctl, log, recalls, thumbs, grabs, feed, close, seats: () => seats };
}

describe('PTZ routes', () => {
  it('save-preset: the single mic on -> preset = unit, seat upserted, thumbnail stored, no room restart', async () => {
    const h = await setup();
    try {
      h.ctl.setPaused(true);
      h.feed('MIC-ON;000C;;'); // unit 12
      const r = await h.app.inject({ method: 'POST', url: '/api/rooms/room-a/seats/save-preset', payload: { cameraId: 'a-ptz' } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ ok: true, unit: 12, preset: '12', thumbnail: true, seat: { unit: 12, label: 'Seat 12', cameraId: 'a-ptz', preset: '12' } });
      expect(h.log).toEqual(['rest.save 12']);
      expect(h.grabs).toEqual(['BIRDDOG (CAM)']);
      expect(jpegSize(h.thumbs.get(12)!.jpeg)).toEqual({ width: 320, height: 180 });
      // engine sees the new seat at once, still paused, same controller
      expect(h.engine.room('room-a')).toBe(h.ctl);
      expect(h.ctl.snapshot().paused).toBe(true);
      expect(h.ctl.config.seats.find((s) => s.unit === 12)?.preset).toBe('12');
      expect(h.ctl.snapshot().cameras['a-ptz']!.lastPreset).toBe('12');
    } finally {
      await h.close();
    }
  });

  it('save-preset: explicit unit, preset and label; keeps existing label when none given', async () => {
    const h = await setup();
    try {
      let r = await h.app.inject({ method: 'POST', url: '/api/rooms/room-a/seats/save-preset', payload: { cameraId: 'a-ptz', unit: 4, preset: '14', label: 'Left of chair' } });
      expect(r.json()).toMatchObject({ unit: 4, preset: '14', seat: { label: 'Left of chair' } });
      r = await h.app.inject({ method: 'POST', url: '/api/rooms/room-a/seats/save-preset', payload: { cameraId: 'a-ptz', unit: 3 } });
      expect(r.json()).toMatchObject({ unit: 3, preset: '3', seat: { label: 'Chair' } });
      expect(h.log).toEqual(['rest.save 14', 'rest.save 3']);
    } finally {
      await h.close();
    }
  });

  it('save-preset: refuses with zero or several mics on, and bad presets', async () => {
    const h = await setup();
    try {
      let r = await h.app.inject({ method: 'POST', url: '/api/rooms/room-a/seats/save-preset', payload: { cameraId: 'a-ptz' } });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatch(/no mic is on/);
      h.feed('MIC-ON;0004;;');
      h.feed('MIC-ON;0005;;');
      r = await h.app.inject({ method: 'POST', url: '/api/rooms/room-a/seats/save-preset', payload: { cameraId: 'a-ptz' } });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatch(/2 mics are on \(4, 5\)/);
      r = await h.app.inject({ method: 'POST', url: '/api/rooms/room-a/seats/save-preset', payload: { cameraId: 'a-ptz', unit: 4, preset: '0' } });
      expect(r.statusCode).toBe(400);
      r = await h.app.inject({ method: 'POST', url: '/api/rooms/room-a/seats/save-preset', payload: { cameraId: 'a-wide', unit: 4 } });
      expect(r.statusCode).toBe(409); // fixed camera cannot store presets
      expect(h.log).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('save-preset still saves when no frame arrives (thumbnail: false)', async () => {
    const h = await setup({ frame: false });
    try {
      const r = await h.app.inject({ method: 'POST', url: '/api/rooms/room-a/seats/save-preset', payload: { cameraId: 'a-ptz', unit: 6 } });
      expect(r.json()).toMatchObject({ ok: true, unit: 6, thumbnail: false });
      expect(h.log).toEqual(['rest.save 6']);
    } finally {
      await h.close();
    }
  });

  it('jog drives, stop stops, and jogging forgets the last recalled preset', async () => {
    const h = await setup();
    try {
      await h.ctl.recallPreset('a-ptz', '3');
      expect(h.ctl.snapshot().cameras['a-ptz']!.lastPreset).toBe('3');
      let r = await h.app.inject({ method: 'POST', url: '/api/rooms/room-a/cameras/a-ptz/jog', payload: { pan: -1, tilt: 1, speed: 100 } });
      expect(r.statusCode).toBe(200);
      expect(h.ctl.snapshot().cameras['a-ptz']!.lastPreset).toBeNull();
      r = await h.app.inject({ method: 'POST', url: '/api/rooms/room-a/cameras/a-ptz/jog', payload: { zoom: 1, speed: 100 } });
      r = await h.app.inject({ method: 'POST', url: '/api/rooms/room-a/cameras/a-ptz/stop' });
      expect(h.log).toEqual(['drive -1,1 @24,20', 'drive 0,0 @24,20', 'zoom 1 @7', 'stop']);
      r = await h.app.inject({ method: 'POST', url: '/api/rooms/room-a/cameras/a-ptz/jog', payload: { pan: 2 } });
      expect(r.statusCode).toBe(400);
      r = await h.app.inject({ method: 'POST', url: '/api/rooms/room-a/cameras/a-wide/jog', payload: { pan: 1 } });
      expect(r.statusCode).toBe(409);
      r = await h.app.inject({ method: 'GET', url: '/api/rooms/room-a/cameras/a-ptz/position' });
      expect(r.json()).toEqual({ pan: 120, tilt: -59, zoom: 4000 });
    } finally {
      await h.close();
    }
  });

  it('serves a JPEG snapshot, and 504 when there is no frame', async () => {
    let h = await setup();
    try {
      const r = await h.app.inject({ method: 'GET', url: '/api/rooms/room-a/cameras/a-ptz/snapshot.jpg?w=320' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toBe('image/jpeg');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(jpegSize(r.rawPayload)).toEqual({ width: 320, height: 180 });
    } finally {
      await h.close();
    }
    h = await setup({ frame: false });
    try {
      const r = await h.app.inject({ method: 'GET', url: '/api/rooms/room-a/cameras/a-ptz/snapshot.jpg' });
      expect(r.statusCode).toBe(504);
    } finally {
      await h.close();
    }
  });

  it('seat PUT, thumbnail upload, list and download', async () => {
    const h = await setup();
    try {
      let r = await h.app.inject({ method: 'PUT', url: '/api/rooms/room-a/seats/4', payload: { cameraId: 'a-ptz', label: 'Left of chair', preset: '4' } });
      expect(r.json()).toMatchObject({ ok: true, seat: { unit: 4, label: 'Left of chair', preset: '4' } });
      expect(h.ctl.config.seats.map((s) => s.unit)).toEqual([3, 4]);
      r = await h.app.inject({ method: 'PUT', url: '/api/rooms/room-a/seats/3', payload: { cameraId: 'a-ptz' } });
      expect(r.json().seat).toEqual({ unit: 3, label: 'Chair', cameraId: 'a-ptz', preset: '3' });

      const big = encodeJpeg({ width: 1280, height: 720, data: Buffer.alloc(1280 * 720 * 4, 200) });
      r = await h.app.inject({ method: 'PUT', url: '/api/rooms/room-a/seats/4/thumbnail', headers: { 'content-type': 'image/jpeg' }, payload: big });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ width: 320, height: 180 });
      r = await h.app.inject({ method: 'PUT', url: '/api/rooms/room-a/seats/4/thumbnail', headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from('nope') });
      expect(r.statusCode).toBe(400);

      r = await h.app.inject({ method: 'GET', url: '/api/rooms/room-a/thumbnails' });
      expect(r.json()).toEqual([{ unit: 4, updatedAt: expect.any(Number) }]);
      r = await h.app.inject({ method: 'GET', url: '/api/rooms/room-a/seats/4/thumbnail.jpg' });
      expect(r.statusCode).toBe(200);
      expect(jpegSize(r.rawPayload)).toEqual({ width: 320, height: 180 });
      r = await h.app.inject({ method: 'GET', url: '/api/rooms/room-a/seats/9/thumbnail.jpg' });
      expect(r.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });

  it('unknown room -> 404', async () => {
    const h = await setup();
    try {
      const r = await h.app.inject({ method: 'POST', url: '/api/rooms/nope/cameras/a-ptz/jog', payload: { pan: 1 } });
      expect(r.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });
});

describe('Engine', () => {
  it('keeps a paused room paused when its config is saved again', async () => {
    const engine = new Engine(new NdiService({}, null), undefined, {
      createDriver: () => ({ kind: 'none', recallPreset: async () => {}, probe: async () => ({ ok: true }) }),
    });
    engine.upsertRoom(room());
    engine.room('room-a')!.setPaused(true);
    engine.upsertRoom(room());
    expect(engine.room('room-a')!.snapshot().paused).toBe(true);
    await engine.stop();
  });
});
