import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { roomInputSchema, cameraSchema } from '../engine/types.js';
import { createDriver } from '../engine/cameras/index.js';
import type { Engine, EngineEvent } from '../engine/engine.js';
import type { RoomRepo } from '../db/repo.js';

function bad(reply: import('fastify').FastifyReply, e: unknown) {
  if (e instanceof z.ZodError) return reply.code(400).send({ error: 'invalid input', issues: e.issues });
  return reply.code(400).send({ error: (e as Error).message });
}

export function registerRoutes(app: FastifyInstance, engine: Engine, repo: RoomRepo) {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/ndi', async () => engine.ndi.status());

  // ------------------------------------------------------------ rooms CRUD
  app.get('/api/rooms', async () => repo.list());

  app.get<{ Params: { id: string } }>('/api/rooms/:id', async (req, reply) => {
    const r = await repo.get(req.params.id);
    return r ?? reply.code(404).send({ error: 'not found' });
  });

  app.post('/api/rooms', async (req, reply) => {
    try {
      const input = roomInputSchema.parse(req.body);
      const room = await repo.create(input);
      engine.upsertRoom(room);
      return reply.code(201).send(room);
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.put<{ Params: { id: string } }>('/api/rooms/:id', async (req, reply) => {
    try {
      const input = roomInputSchema.parse(req.body);
      const room = await repo.update(req.params.id, input);
      if (!room) return reply.code(404).send({ error: 'not found' });
      engine.upsertRoom(room);
      return room;
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/rooms/:id', async (req, reply) => {
    engine.removeRoom(req.params.id);
    const ok = await repo.delete(req.params.id);
    return ok ? reply.code(204).send() : reply.code(404).send({ error: 'not found' });
  });

  // ------------------------------------------------------------ live state
  app.get<{ Params: { id: string } }>('/api/rooms/:id/state', async (req, reply) => {
    const s = engine.snapshot(req.params.id);
    return s ?? reply.code(404).send({ error: 'room not running (disabled or unknown)' });
  });

  const ctl = (id: string) => {
    const c = engine.room(id);
    if (!c) throw new Error('room not running (disabled or unknown)');
    return c;
  };

  app.post<{ Params: { id: string }; Body: { timeoutMs?: number } }>('/api/rooms/:id/learn', async (req, reply) => {
    try {
      const timeout = Math.min(Math.max(req.body?.timeoutMs ?? 30000, 1000), 120000);
      const unit = await ctl(req.params.id).learnNext(timeout);
      return { unit };
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>('/api/rooms/:id/take', async (req, reply) => {
    try {
      const b = z.object({ cameraId: z.string().optional(), holding: z.boolean().optional() }).parse(req.body);
      if (b.holding) ctl(req.params.id).takeHolding();
      else ctl(req.params.id).takeCamera(b.cameraId ?? '');
      return { ok: true };
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>('/api/rooms/:id/recall', async (req, reply) => {
    try {
      const b = z.object({ cameraId: z.string(), preset: z.string().min(1) }).parse(req.body);
      await ctl(req.params.id).recallPreset(b.cameraId, b.preset);
      return { ok: true };
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>('/api/rooms/:id/pause', async (req, reply) => {
    try {
      const b = z.object({ paused: z.boolean() }).parse(req.body);
      ctl(req.params.id).setPaused(b.paused);
      return { ok: true };
    } catch (e) {
      return bad(reply, e);
    }
  });

  /** Test a camera's control connection from the room editor (does not move it). */
  app.post('/api/cameras/probe', async (req, reply) => {
    try {
      const cam = cameraSchema.parse(req.body);
      const d = createDriver(cam);
      try {
        return await d.probe();
      } finally {
        d.close?.();
      }
    } catch (e) {
      return bad(reply, e);
    }
  });

  // ------------------------------------------------------------ SSE
  app.get<{ Querystring: { room?: string } }>('/api/events', (req, reply) => {
    const roomFilter = req.query.room;
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const send = (ev: EngineEvent) => {
      if (roomFilter && ev.roomId !== roomFilter) return;
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    const sendSources = () => reply.raw.write(`event: ndi\ndata: ${JSON.stringify(engine.ndi.sources)}\n\n`);
    engine.on('event', send);
    engine.ndi.on('sources', sendSources);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    req.raw.on('close', () => {
      clearInterval(ping);
      engine.off('event', send);
      engine.ndi.off('sources', sendSources);
    });
    reply.hijack();
  });
}
