/**
 * PTZ aiming and seat-preset routes: jog, live-ish preview, save preset for a
 * seat, seat thumbnails. Lets an operator aim and store every seat from the
 * browser (phone included) instead of NDI Studio Monitor (presets 1-9 only).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Engine } from '../engine/engine.js';
import type { CameraConfig, SeatConfig } from '../engine/types.js';
import type { CameraDriver } from '../engine/cameras/types.js';
import { Jogger } from '../engine/cameras/jog.js';
import type { FrameSource } from '../engine/ndi/frames.js';
import { encodeJpeg, jpegSize, resizeJpeg, THUMB_WIDTH } from '../engine/image/jpeg.js';
import type { RoomRepo } from '../db/repo.js';
import { calibrate, calibrationFromOptions, coefficientsAt } from '../engine/autoframe/calibration.js';
import { autoFrameOnce, describeRun, type AutoFrameDeps } from '../engine/autoframe/refiner.js';
import { waitVideoStill } from '../engine/autoframe/phase.js';
import { idlePosition } from '../engine/autoframe/presets.js';
import { storePresetPosition } from '../engine/autoframe/store.js';
import { presetPosition } from '../engine/autoframe/presets.js';
import { learnedCorrection, type SeatLearning } from '../engine/autoframe/learn.js';

export type SeatStore = Pick<RoomRepo, 'upsertSeat' | 'putThumbnail' | 'getThumbnail' | 'listThumbnails'>;
export type RoomStore = Pick<RoomRepo, 'get' | 'update'>;

export interface PtzRouteDeps {
  engine: Engine;
  repo: SeatStore;
  frames: FrameSource;
  /** Deadman for hold-to-move (ms). */
  jogDeadmanMs?: number;
  /** Auto-framing (face detector); enables the calibrate/autoframe routes. */
  autoframe?: AutoFrameDeps;
  /** Needed to store calibration in the camera options. */
  rooms?: RoomStore;
  /** Per-seat learned corrections (track mode). */
  learning?: SeatLearning;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof z.ZodError) return reply.code(400).send({ error: 'invalid input', issues: e.issues });
  const status = e instanceof HttpError ? e.status : 400;
  return reply.code(status).send({ error: (e as Error).message });
}

const dir = z.union([z.literal(-1), z.literal(0), z.literal(1)]);
const jogSchema = z.object({
  pan: dir.default(0),
  tilt: dir.default(0),
  zoom: dir.default(0),
  speed: z.number().min(1).max(100).default(40),
});
const presetSchema = z.string().regex(/^\d{1,3}$/, 'preset must be a number').refine((p) => {
  const n = parseInt(p, 10);
  return n >= 1 && n <= 255;
}, 'preset must be 1-255');
const saveSchema = z.object({
  cameraId: z.string().min(1),
  /** Omit to use the single mic that is on right now. */
  unit: z.number().int().min(0).max(0xfffe).optional(),
  /** Omit to use preset = unit number. */
  preset: presetSchema.optional(),
  label: z.string().max(80).optional(),
});
const seatPutSchema = z.object({
  cameraId: z.string().min(1),
  label: z.string().max(80).optional(),
  preset: z.string().nullable().optional(),
});

export function registerPtzRoutes(app: FastifyInstance, deps: PtzRouteDeps) {
  const { engine, repo, frames } = deps;
  const joggers = new Map<string, Jogger>();

  app.addContentTypeParser(['image/jpeg', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  const roomOf = (roomId: string) => {
    const cfg = engine.roomConfig(roomId);
    const ctl = engine.room(roomId);
    if (!cfg || !ctl) throw new HttpError(404, 'room not running (disabled or unknown)');
    return { cfg, ctl };
  };

  const cameraOf = (roomId: string, cameraId: string): { cam: CameraConfig; driver: CameraDriver } => {
    const { cfg } = roomOf(roomId);
    const cam = cfg.cameras.find((c) => c.id === cameraId);
    const driver = engine.driver(roomId, cameraId);
    if (!cam || !driver) throw new HttpError(404, 'unknown camera');
    return { cam, driver };
  };

  const jogger = (roomId: string, cameraId: string): Jogger => {
    const { cam, driver } = cameraOf(roomId, cameraId);
    if (!driver.ptz) throw new HttpError(409, `${cam.name} has no pan/tilt control (driver ${driver.kind})`);
    const key = `${roomId}/${cameraId}`;
    let j = joggers.get(key);
    // drivers are recreated when a room restarts: rebuild the jogger with the new one
    if (!j || j.ptz !== driver.ptz) {
      j?.dispose();
      j = new Jogger(driver.ptz, { deadmanMs: deps.jogDeadmanMs ?? 800 });
      joggers.set(key, j);
    }
    return j;
  };

  const grabJpeg = async (cam: CameraConfig, maxWidth: number, quality: number): Promise<Buffer> => {
    if (!cam.ndiSource) throw new HttpError(409, `${cam.name} has no NDI source configured`);
    let frame;
    try {
      frame = await frames.grab(cam.ndiSource);
    } catch (e) {
      throw new HttpError(503, (e as Error).message);
    }
    if (!frame) throw new HttpError(504, `no video from "${cam.ndiSource}"`);
    return encodeJpeg(frame, { maxWidth, quality });
  };

  // ------------------------------------------------------------ jog + position
  app.post<{ Params: { id: string; cam: string } }>('/api/rooms/:id/cameras/:cam/jog', async (req, reply) => {
    try {
      const s = jogSchema.parse(req.body ?? {});
      const j = jogger(req.params.id, req.params.cam);
      const moving = s.pan !== 0 || s.tilt !== 0 || s.zoom !== 0;
      if (moving && !j.active) engine.room(req.params.id)?.cameraMovedManually(req.params.cam, null);
      await j.set(s);
      return { ok: true };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string; cam: string } }>('/api/rooms/:id/cameras/:cam/stop', async (req, reply) => {
    try {
      await jogger(req.params.id, req.params.cam).stop();
      return { ok: true };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { id: string; cam: string } }>('/api/rooms/:id/cameras/:cam/position', async (req, reply) => {
    try {
      const { cam, driver } = cameraOf(req.params.id, req.params.cam);
      if (!driver.ptz) throw new HttpError(409, `${cam.name} has no pan/tilt control`);
      return await driver.ptz.getPosition();
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ------------------------------------------------------------ preview
  app.get<{ Params: { id: string; cam: string }; Querystring: { w?: string } }>(
    '/api/rooms/:id/cameras/:cam/snapshot.jpg',
    async (req, reply) => {
      try {
        const { cam } = cameraOf(req.params.id, req.params.cam);
        const w = Math.min(Math.max(parseInt(req.query.w ?? '640', 10) || 640, 80), 1920);
        const jpg = await grabJpeg(cam, w, 70);
        return reply.header('content-type', 'image/jpeg').header('cache-control', 'no-store').send(jpg);
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  /**
   * Record a preset's pan/tilt/zoom while the camera is idle: wait for a still
   * picture, then require 3 agreeing position reads. On failure the stored
   * coordinates for that preset are dropped (they would be stale).
   */
  const recordPresetPosition = async (roomId: string, cam: CameraConfig, driver: CameraDriver, preset: string) => {
    if (!deps.rooms || !driver.ptz) return null;
    const ctl = engine.room(roomId);
    try {
      if (cam.ndiSource) {
        const s = await waitVideoStill(() => frames.grab(cam.ndiSource), { minMs: 300, maxMs: 8000, stable: 4 });
        if (!s.still) throw new Error('picture did not settle');
      }
      const pos = await idlePosition(driver.ptz, { reads: 10, need: 3, gapMs: 50 });
      await storePresetPosition(engine, deps.rooms, roomId, cam.id, preset, pos);
      ctl?.log('info', `${cam.name}: preset ${preset} stored at ${pos.pan}/${pos.tilt}/z${pos.zoom}`);
      return pos;
    } catch (e) {
      ctl?.log('warn', `${cam.name}: preset ${preset} position not recorded: ${(e as Error).message}`);
      await storePresetPosition(engine, deps.rooms, roomId, cam.id, preset, null).catch(() => undefined);
      return null;
    }
  };

  // ------------------------------------------------------------ seats
  const storeSeat = async (roomId: string, seat: SeatConfig) => {
    const seats = await repo.upsertSeat(roomId, seat);
    engine.updateSeats(roomId, seats);
    return seats;
  };

  /**
   * Save the PTZ's current position as a preset for a seat:
   * unit = the single mic that is on (or body.unit), preset = unit (or body.preset).
   * Then upsert the seat mapping and store a thumbnail.
   */
  app.post<{ Params: { id: string } }>('/api/rooms/:id/seats/save-preset', async (req, reply) => {
    try {
      const b = saveSchema.parse(req.body ?? {});
      const { cfg, ctl } = roomOf(req.params.id);
      const { cam, driver } = cameraOf(req.params.id, b.cameraId);
      let unit = b.unit;
      if (unit === undefined) {
        const on = ctl.snapshot().micsOn;
        if (on.length !== 1) {
          throw new HttpError(
            409,
            on.length === 0
              ? 'no mic is on: switch on the seat mic, or pick the unit from the list'
              : `${on.length} mics are on (${on.join(', ')}): leave only one on, or pick the unit from the list`,
          );
        }
        unit = on[0]!;
      }
      const preset = b.preset ?? String(unit);
      presetSchema.parse(preset);
      const save = driver.savePreset?.bind(driver) ?? driver.ptz?.savePreset;
      if (!save) throw new HttpError(409, `${cam.name} (${driver.kind}) cannot store presets`);

      const j = joggers.get(`${req.params.id}/${cam.id}`);
      if (j?.active) await j.stop();
      await save(preset);
      ctl.cameraMovedManually(cam.id, preset);

      const existing = cfg.seats.find((s) => s.unit === unit);
      const label = (b.label ?? '').trim() || existing?.label || `Seat ${unit}`;
      const seat: SeatConfig = { unit, label, cameraId: cam.id, preset };
      await storeSeat(req.params.id, seat);
      ctl.log('info', `${cam.name}: saved current position as preset ${preset} for unit ${unit} (${label})`);
      // a re-aimed preset makes the seat's learned offsets meaningless
      if (deps.learning?.reset(req.params.id, unit)) ctl.log('info', `learned correction for seat ${unit} cleared (preset saved again)`);
      const position = await recordPresetPosition(req.params.id, cam, driver, preset);

      let thumbnail = false;
      let thumbnailError: string | undefined;
      try {
        const jpeg = await grabJpeg(cam, THUMB_WIDTH, 75);
        const size = jpegSize(jpeg) ?? { width: THUMB_WIDTH, height: 0 };
        await repo.putThumbnail(req.params.id, unit, { jpeg, ...size });
        thumbnail = true;
      } catch (e) {
        thumbnailError = (e as Error).message;
        ctl.log('warn', `${cam.name}: no thumbnail for unit ${unit}: ${thumbnailError}`);
      }
      return { ok: true, unit, preset, seat, thumbnail, thumbnailError, position };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** Upsert one seat (label / camera / preset) without restarting the room. */
  app.put<{ Params: { id: string; unit: string } }>('/api/rooms/:id/seats/:unit', async (req, reply) => {
    try {
      const unit = z.coerce.number().int().min(0).max(0xfffe).parse(req.params.unit);
      const b = seatPutSchema.parse(req.body ?? {});
      const { cfg } = roomOf(req.params.id);
      const existing = cfg.seats.find((s) => s.unit === unit);
      const seat: SeatConfig = {
        unit,
        label: b.label ?? existing?.label ?? '',
        cameraId: b.cameraId,
        preset: b.preset === undefined ? (existing?.preset ?? null) : b.preset || null,
      };
      const seats = await storeSeat(req.params.id, seat);
      return { ok: true, seat, seats };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>('/api/rooms/:id/thumbnails', async (req) => {
    const list = await repo.listThumbnails(req.params.id);
    return list.map((t) => ({ unit: t.unit, updatedAt: t.updatedAt.getTime() }));
  });

  app.get<{ Params: { id: string; unit: string } }>('/api/rooms/:id/seats/:unit/thumbnail.jpg', async (req, reply) => {
    const unit = parseInt(req.params.unit, 10);
    const t = Number.isFinite(unit) ? await repo.getThumbnail(req.params.id, unit) : null;
    if (!t) return reply.code(404).send({ error: 'no thumbnail' });
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'private, max-age=300')
      .header('last-modified', t.updatedAt.toUTCString())
      .send(t.jpeg);
  });

  /** Upload a seat thumbnail (any JPEG; stored at most THUMB_WIDTH wide). */
  app.put<{ Params: { id: string; unit: string } }>('/api/rooms/:id/seats/:unit/thumbnail', async (req, reply) => {
    try {
      const unit = z.coerce.number().int().min(0).max(0xfffe).parse(req.params.unit);
      roomOf(req.params.id);
      if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'send the JPEG as the body (content-type image/jpeg)');
      let jpeg: Buffer;
      try {
        jpeg = resizeJpeg(req.body, { maxWidth: THUMB_WIDTH, quality: 75 });
      } catch (e) {
        throw new HttpError(400, `not a readable JPEG: ${(e as Error).message}`);
      }
      const size = jpegSize(jpeg)!;
      const updatedAt = await repo.putThumbnail(req.params.id, unit, { jpeg, ...size });
      return { ok: true, unit, bytes: jpeg.length, ...size, updatedAt: updatedAt.getTime() };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ------------------------------------------------------------ auto-framing
  const calibrating = new Set<string>();
  const calibrateSchema = z.object({
    zooms: z.array(z.number().int().min(0).max(0xffff)).min(1).max(8).optional(),
  });

  /**
   * Measure pan/tilt image shift per VISCA unit at a few zoom levels (moves the
   * camera around its current position; about a minute) and store it in the
   * camera's options.autoframe.calibration. Pause the room first.
   */
  app.post<{ Params: { id: string; cam: string } }>('/api/rooms/:id/cameras/:cam/calibrate', async (req, reply) => {
    const key = `${req.params.id}/${req.params.cam}`;
    let mine = false;
    try {
      const b = calibrateSchema.parse(req.body ?? {});
      const { ctl } = roomOf(req.params.id);
      const { cam, driver } = cameraOf(req.params.id, req.params.cam);
      if (!driver.ptz) throw new HttpError(409, `${cam.name} has no pan/tilt control`);
      if (!deps.rooms) throw new HttpError(501, 'calibration storage not available');
      if (!cam.ndiSource) throw new HttpError(409, `${cam.name} has no NDI source configured`);
      if (!ctl.snapshot().paused) throw new HttpError(409, 'pause the room automation first');
      if (calibrating.has(key)) throw new HttpError(409, 'calibration already running');
      calibrating.add(key);
      mine = true;
      ctl.cameraMovedManually(cam.id, null);
      ctl.log('info', `${cam.name}: calibration started`);
      const t0 = Date.now();
      const { calibration, samples } = await calibrate(
        { ptz: driver.ptz, grab: () => frames.grab(cam.ndiSource), log: (m) => ctl.log('debug', `${cam.name}: calibrate ${m}`) },
        { zooms: b.zooms },
      );
      const room = await deps.rooms.get(req.params.id);
      if (!room) throw new HttpError(404, 'room not found');
      const cameras = room.cameras.map((c) =>
        c.id === cam.id
          ? { ...c, options: { ...c.options, autoframe: { ...((c.options.autoframe as object | undefined) ?? {}), calibration } } }
          : c,
      );
      const { id: _id, ...input } = room;
      const updated = await deps.rooms.update(req.params.id, { ...input, cameras });
      if (updated) engine.upsertRoom(updated);
      const fw = calibration.frameWidth ?? 1;
      const fh = calibration.frameHeight ?? 1;
      const summary = calibration.points
        .map((p) => `zoom ${p.zoom}: ${(p.dxPerPan * fw).toFixed(2)} px/pan, ${(p.dyPerTilt * fh).toFixed(2)} px/tilt`)
        .join('; ');
      engine.room(req.params.id)?.log('info', `${cam.name}: calibration stored after ${Date.now() - t0} ms (${summary}; at ${fw}x${fh})`);
      return { ok: true, ms: Date.now() - t0, calibration, samples };
    } catch (e) {
      return fail(reply, e);
    } finally {
      if (mine) calibrating.delete(key);
    }
  });

  /** Run the auto-frame step now on the camera's current shot ({dryRun:true}: detect only, no move). */
  app.post<{ Params: { id: string; cam: string } }>('/api/rooms/:id/cameras/:cam/autoframe', async (req, reply) => {
    try {
      const b = z.object({ dryRun: z.boolean().default(false) }).parse(req.body ?? {});
      const { cfg, ctl } = roomOf(req.params.id);
      const { cam, driver } = cameraOf(req.params.id, req.params.cam);
      if (!deps.autoframe) throw new HttpError(501, 'auto-framing not available');
      if (!calibrationFromOptions(cam.options)) throw new HttpError(409, `${cam.name} is not calibrated yet`);
      // a manual auto-frame overrides tracking on this camera
      if (ctl.snapshot().tracking?.cameraId === cam.id) ctl.stopTracking('manual auto-frame');
      const preset = ctl.snapshot().cameras[cam.id]?.lastPreset ?? null;
      const r = await autoFrameOnce(deps.autoframe, { camera: cam, driver, policy: cfg.policy, preset, dryRun: b.dryRun });
      if (r.adjusted) ctl.cameraMovedManually(cam.id, null);
      const detail = describeRun(r);
      ctl.log('info', `${cam.name}: auto-frame (manual${b.dryRun ? ', dry run' : ''}): ${detail}`);
      return { ...r, detail };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * Tracking test hook: {action:'start', durationMs} tracks on the camera's
   * current shot (only while the room is quiet: no mic on, automation running,
   * camera not on program) and answers when it ends with the session log line;
   * {action:'stop'} stops any tracking on the room.
   */
  app.post<{ Params: { id: string; cam: string } }>('/api/rooms/:id/cameras/:cam/track', async (req, reply) => {
    try {
      const b = z
        .object({ action: z.enum(['start', 'stop']).default('start'), durationMs: z.number().int().min(1000).max(300_000).default(20_000) })
        .parse(req.body ?? {});
      const { ctl } = roomOf(req.params.id);
      const { cam } = cameraOf(req.params.id, req.params.cam);
      if (b.action === 'stop') {
        ctl.stopTracking('stopped from the API');
        return { ok: true };
      }
      if (!calibrationFromOptions(cam.options)) throw new HttpError(409, `${cam.name} is not calibrated yet`);
      const before = ctl.snapshot().tracking;
      if (before) throw new HttpError(409, 'tracking already running');
      const t0 = Date.now();
      try {
        await ctl.startManualTracking(cam.id, b.durationMs);
      } catch (e) {
        throw new HttpError(409, (e as Error).message);
      }
      const log = engine.snapshot(req.params.id)?.log ?? [];
      const lines = log.filter((e) => e.type === 'log' && e.at >= t0 && /tracking/.test(e.msg)).map((e) => (e as { msg: string }).msg);
      return { ok: true, ms: Date.now() - t0, log: lines };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * Back-fill stored coordinates for existing presets: recall each one, wait
   * for a still picture, read the position several times while idle. Only while
   * the room is quiet (no mic on, nothing moving, program not on this camera);
   * stops as soon as that changes. Never saves or overwrites a camera preset.
   */
  app.post<{ Params: { id: string; cam: string } }>('/api/rooms/:id/cameras/:cam/preset-positions', async (req, reply) => {
    try {
      const b = z
        .object({ presets: z.array(presetSchema).min(1).max(64).optional(), forget: z.array(presetSchema).max(64).default([]) })
        .parse(req.body ?? {});
      const { cfg, ctl } = roomOf(req.params.id);
      const { cam, driver } = cameraOf(req.params.id, req.params.cam);
      if (!driver.ptz) throw new HttpError(409, `${cam.name} has no pan/tilt control`);
      if (!deps.rooms) throw new HttpError(501, 'storage not available');
      const presets =
        b.presets ?? [...new Set(cfg.seats.filter((s) => s.cameraId === cam.id && s.preset).map((s) => s.preset!))];
      const quiet = () => {
        const s = ctl.snapshot();
        if (s.micsOn.length) return `mic ${s.micsOn.join(', ')} on`;
        if (s.moving) return 'a camera move is running';
        if (s.program?.kind === 'camera' && s.program.cameraId === cam.id) return `${cam.name} is on program`;
        return null;
      };
      const results: Array<{ preset: string; position?: { pan: number; tilt: number; zoom: number } | null; error?: string }> = [];
      for (const preset of b.forget) await storePresetPosition(engine, deps.rooms, req.params.id, cam.id, preset, null);
      let stopped: string | null = null;
      for (const preset of presets) {
        stopped = quiet();
        if (stopped) break;
        await driver.recallPreset(preset);
        ctl.cameraMovedManually(cam.id, preset);
        // the P100 starts moving 1-1.5 s after a REST recall: don't mistake "not started yet" for "arrived"
        const s = cam.ndiSource ? await waitVideoStill(() => frames.grab(cam.ndiSource), { minMs: 2500, maxMs: 12_000, stable: 4 }) : null;
        stopped = quiet();
        if (stopped) break;
        if (s && !s.still) {
          results.push({ preset, error: 'picture did not settle' });
          continue;
        }
        try {
          // two idle rounds half a second apart must agree
          const a = await idlePosition(driver.ptz, { reads: 10, need: 3, gapMs: 50 });
          await new Promise((r) => setTimeout(r, 500));
          const c = await idlePosition(driver.ptz, { reads: 10, need: 3, gapMs: 50 });
          if (a.pan !== c.pan || a.tilt !== c.tilt || a.zoom !== c.zoom) {
            throw new Error(`position still changing (${a.pan}/${a.tilt}/z${a.zoom} then ${c.pan}/${c.tilt}/z${c.zoom})`);
          }
          await storePresetPosition(engine, deps.rooms, req.params.id, cam.id, preset, c);
          results.push({ preset, position: c });
        } catch (e) {
          await storePresetPosition(engine, deps.rooms, req.params.id, cam.id, preset, null).catch(() => undefined);
          results.push({ preset, error: (e as Error).message });
        }
      }
      const summary = results.map((r) => `${r.preset}=${r.position ? `${r.position.pan}/${r.position.tilt}/z${r.position.zoom}` : `failed (${r.error})`}`).join(', ');
      ctl.log('info', `${cam.name}: preset positions back-filled: ${summary || 'none'}${stopped ? `; stopped: ${stopped}` : ''}`);
      return { ok: !stopped, stopped, results };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ------------------------------------------------------------ learned seat corrections

  /** Learned correction per seat (frame % at the preset zoom, VISCA units, turns), for the UI. */
  app.get<{ Params: { id: string } }>('/api/rooms/:id/learned', async (req, reply) => {
    try {
      const { cfg } = roomOf(req.params.id);
      const l = deps.learning;
      if (!l) return [];
      const cap = cfg.policy.trackLearnCapPct / 100;
      return l.list(cfg.id).map((r) => {
        const seat = cfg.seats.find((s) => s.unit === r.unit);
        const cam = cfg.cameras.find((c) => c.id === r.cameraId);
        const pos = cam ? presetPosition(cam.options, r.preset) : null;
        const cal = cam ? calibrationFromOptions(cam.options) : null;
        const current = !!seat && !!cam && seat.cameraId === r.cameraId && seat.preset === r.preset && !!l.get(cfg.id, r.unit, r.cameraId, r.preset, pos);
        const coef = cal && pos ? coefficientsAt(cal, pos.zoom) : null;
        return {
          unit: r.unit,
          label: seat?.label ?? '',
          cameraId: r.cameraId,
          preset: r.preset,
          turns: r.samples.length,
          correction: learnedCorrection(r.samples, { cap, coef }),
          /** false: the seat's camera/preset/stored position changed since; the samples are not used. */
          current,
          updatedAt: r.updatedAt,
        };
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** Forget one seat's learned correction (the camera preset is not touched). */
  app.delete<{ Params: { id: string; unit: string } }>('/api/rooms/:id/learned/:unit', async (req, reply) => {
    try {
      const { ctl } = roomOf(req.params.id);
      const unit = z.coerce.number().int().min(0).max(0xfffe).parse(req.params.unit);
      const n = deps.learning?.reset(req.params.id, unit) ?? 0;
      await deps.learning?.flush();
      ctl.log('info', `learned correction for seat ${unit} reset`);
      return { ok: true, removed: n };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** Forget every learned correction of the room. */
  app.delete<{ Params: { id: string } }>('/api/rooms/:id/learned', async (req, reply) => {
    try {
      const { ctl } = roomOf(req.params.id);
      const n = deps.learning?.reset(req.params.id) ?? 0;
      await deps.learning?.flush();
      ctl.log('info', `learned corrections reset for all seats (${n})`);
      return { ok: true, removed: n };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.addHook('onClose', async () => {
    for (const j of joggers.values()) j.dispose();
    joggers.clear();
  });
}
