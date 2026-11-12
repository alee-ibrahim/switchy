import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { openDb, RoomRepo } from './db/repo.js';
import { Engine } from './engine/engine.js';
import { NdiService } from './engine/ndi/service.js';
import { authConfigFromEnv, registerAuth } from './api/auth.js';
import { registerRoutes } from './api/routes.js';
import { registerPtzRoutes } from './api/ptz-routes.js';
import { NdiFrameGrabber } from './engine/ndi/frames.js';
import type { RoomEvent } from './engine/room/controller.js';
import { ensurePersonModels, ensureYunetModel } from './engine/autoframe/model.js';
import { RtmHeadDetector, type HeadDetector } from './engine/autoframe/person.js';
import { YunetDetector, type FaceDetector } from './engine/autoframe/yunet.js';
import { createAutoFrameRefiner, prewarm, type AutoFrameDeps, type AutoFrameRun } from './engine/autoframe/refiner.js';
import { presetPosition } from './engine/autoframe/presets.js';
import { storePresetPosition } from './engine/autoframe/store.js';
import { createTracker } from './engine/autoframe/tracker.js';
import { SeatLearning } from './engine/autoframe/learn.js';
import type { RefineContext } from './engine/room/controller.js';

const env = process.env;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

async function main() {
  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required (see .env.example)');
  const port = Number(env.PORT ?? 8090);
  const host = env.HOST ?? '0.0.0.0';
  const minLevel = LEVELS[(env.LOG_LEVEL as keyof typeof LEVELS) ?? 'info'] ?? LEVELS.info;

  const app = Fastify({ logger: { level: env.HTTP_LOG_LEVEL ?? 'warn' } });
  const { db, pool } = await openDb(dbUrl);
  const repo = new RoomRepo(db);

  const ndi = new NdiService({
    extraIps: (env.NDI_EXTRA_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    groups: env.NDI_GROUPS || null,
    autoExtraIps: env.NDI_AUTO_EXTRA_IPS !== 'false',
  });
  const st = ndi.status();
  if (st.available) console.log(`[ndi] runtime ${st.version} from ${st.libraryPath}`);
  else console.warn(`[ndi] ${st.error} - program outputs disabled, camera control still works`);

  const frames = new NdiFrameGrabber(ndi);
  // face detector: model fetched (sha256-checked) and loaded on first use
  let detector: Promise<FaceDetector> | null = null;
  const loadDetector = () =>
    (detector ??= (async () => {
      const d = new YunetDetector({ modelPath: await ensureYunetModel() });
      await d.warmup();
      return d;
    })().catch((e) => {
      detector = null;
      throw e;
    }));
  const autoframe: AutoFrameDeps = { frames, detector: loadDetector };
  // head/upper-body fallback for tracking (RTMDet person + RTMPose keypoints): loaded on first use; failure = YuNet only
  let heads: Promise<HeadDetector | null> | null = null;
  const loadHeads = () =>
    (heads ??= (async () => {
      const m = await ensurePersonModels();
      const d = new RtmHeadDetector({ detPath: m.det, posePath: m.pose });
      await d.warmup();
      return d as HeadDetector;
    })().catch((e) => {
      console.warn(`[autoframe] head/body fallback unavailable: ${(e as Error).message}`);
      heads = null;
      return null;
    }));

  // with "save the refined position as the preset" on, keep the stored preset coordinates in step
  const onRefineRun = (ctx: RefineContext, r: AutoFrameRun) => {
    const preset = ctx.shot.preset;
    if (!r.adjusted || !ctx.room.policy.refineSavePreset || !preset) return;
    const old = presetPosition(ctx.camera.options, preset);
    const zoomed = r.passes.some((p) => p.moved && p.correction?.zoomStep);
    const moved = r.passes.filter((p) => p.moved && p.correction);
    const pos =
      old && !zoomed
        ? {
            pan: old.pan + moved.reduce((a, p) => a + p.correction!.delta.pan, 0),
            tilt: old.tilt + moved.reduce((a, p) => a + p.correction!.delta.tilt, 0),
            zoom: old.zoom,
          }
        : null;
    storePresetPosition(engine, repo, ctx.room.id, ctx.camera.id, preset, pos).catch((e) =>
      console.warn(`[autoframe] could not update stored preset ${preset}: ${(e as Error).message}`),
    );
  };

  // per-seat learned corrections (track mode): loaded once, written through to Postgres
  const learning = new SeatLearning(
    { load: () => repo.listCorrections(), save: (r) => repo.putCorrection(r), remove: (id, unit) => repo.deleteCorrections(id, unit) },
    (msg) => console.warn(`[learn] ${msg}`),
  );
  await learning.init().catch((e) => console.warn(`[learn] could not load learned corrections: ${(e as Error).message}`));

  const engine = new Engine(
    ndi,
    (room: string, e: RoomEvent) => {
      if (e.type !== 'log' || LEVELS[e.level] < minLevel) return;
      const line = `${new Date(e.at).toISOString()} [${room}] ${e.level.toUpperCase()} ${e.msg}`;
      (e.level === 'error' ? console.error : e.level === 'warn' ? console.warn : console.log)(line);
    },
    {
      refiner: createAutoFrameRefiner(autoframe, onRefineRun),
      tracker: createTracker({ frames, detector: loadDetector, heads: loadHeads, learning }),
      refinePrepare: (cam) => prewarm(frames, cam),
    },
  );

  registerAuth(app, authConfigFromEnv(env));
  registerRoutes(app, engine, repo);
  registerPtzRoutes(app, { engine, repo, frames, autoframe, rooms: repo, learning });

  // Serve the built UI (web/dist) with SPA fallback.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(here, '../web/dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  const rooms = await repo.list();
  engine.start(rooms);
  if (rooms.some((r) => r.enabled && r.policy.refine !== 'off')) {
    loadDetector().then(
      () => console.log('[autoframe] face detector ready'),
      (e) => console.warn(`[autoframe] face detector unavailable: ${(e as Error).message}`),
    );
    if (rooms.some((r) => r.enabled && r.policy.refine === 'track' && r.policy.trackFallbackDetector)) {
      void loadHeads().then((d) => d && console.log('[autoframe] head/body fallback detector ready'));
    }
  }
  await app.listen({ port, host });
  console.log(`Switchy listening on http://${host}:${port}`);

  const shutdown = async () => {
    console.log('shutting down');
    // explicit pan/tilt/zoom stops go out before the drivers close
    await engine.stop().catch(() => undefined);
    frames.close();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
