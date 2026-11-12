import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';
import { policySchema, type RoomConfig, type RoomInput, type SeatConfig } from '../engine/types.js';
import type { SeatLearnRecord } from '../engine/autoframe/learn.js';

export type Db = NodePgDatabase<typeof schema>;

export async function openDb(url: string): Promise<{ db: Db; pool: pg.Pool }> {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const db = drizzle(pool, { schema });
  const here = path.dirname(fileURLToPath(import.meta.url));
  // works from src/db (tsx) and dist/db (built)
  await migrate(db, { migrationsFolder: path.resolve(here, '../../drizzle') });
  return { db, pool };
}

export class RoomRepo {
  constructor(private db: Db) {}

  async list(): Promise<RoomConfig[]> {
    const rs = await this.db.select().from(schema.rooms).orderBy(asc(schema.rooms.name));
    const cs = await this.db.select().from(schema.cameras).orderBy(asc(schema.cameras.position));
    const ss = await this.db.select().from(schema.seats).orderBy(asc(schema.seats.unit));
    return rs.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      dcenHost: r.dcenHost,
      dcenPort: r.dcenPort,
      outputName: r.outputName,
      outputMode: 'route' as const,
      policy: policySchema.parse(r.policy ?? {}),
      cameras: cs
        .filter((c) => c.roomId === r.id)
        .map((c) => ({
          id: c.id,
          name: c.name,
          driver: c.driver as RoomConfig['cameras'][number]['driver'],
          host: c.host,
          port: c.port,
          role: c.role as RoomConfig['cameras'][number]['role'],
          ndiSource: c.ndiSource,
          settleMs: c.settleMs,
          homePreset: c.homePreset,
          credentialsRef: c.credentialsRef,
          options: c.options ?? {},
        })),
      seats: ss
        .filter((s) => s.roomId === r.id)
        .map((s) => ({ unit: s.unit, label: s.label, cameraId: s.cameraId, preset: s.preset })),
    }));
  }

  async get(id: string): Promise<RoomConfig | null> {
    return (await this.list()).find((r) => r.id === id) ?? null;
  }

  async create(input: RoomInput): Promise<RoomConfig> {
    const id = randomUUID();
    await this.write(id, input, true);
    return (await this.get(id))!;
  }

  async update(id: string, input: RoomInput): Promise<RoomConfig | null> {
    const exists = await this.db.select({ id: schema.rooms.id }).from(schema.rooms).where(eq(schema.rooms.id, id));
    if (!exists.length) return null;
    await this.write(id, input, false);
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.db.delete(schema.rooms).where(eq(schema.rooms.id, id)).returning({ id: schema.rooms.id });
    return r.length > 0;
  }

  /** Seats of one room, ordered by unit. */
  async seats(roomId: string): Promise<SeatConfig[]> {
    const ss = await this.db.select().from(schema.seats).where(eq(schema.seats.roomId, roomId)).orderBy(asc(schema.seats.unit));
    return ss.map((s) => ({ unit: s.unit, label: s.label, cameraId: s.cameraId, preset: s.preset }));
  }

  /** Insert or update one seat mapping without touching the rest of the room. Returns the room's seats. */
  async upsertSeat(roomId: string, seat: SeatConfig): Promise<SeatConfig[]> {
    const cam = await this.db
      .select({ id: schema.cameras.id })
      .from(schema.cameras)
      .where(and(eq(schema.cameras.roomId, roomId), eq(schema.cameras.id, seat.cameraId)));
    if (!cam.length) throw new Error(`seat ${seat.unit} references an unknown camera`);
    await this.db
      .insert(schema.seats)
      .values({ roomId, ...seat })
      .onConflictDoUpdate({
        target: [schema.seats.roomId, schema.seats.unit],
        set: { label: seat.label, cameraId: seat.cameraId, preset: seat.preset },
      });
    await this.db.update(schema.rooms).set({ updatedAt: new Date() }).where(eq(schema.rooms.id, roomId));
    return this.seats(roomId);
  }

  async putThumbnail(roomId: string, unit: number, t: { jpeg: Buffer; width: number; height: number }): Promise<Date> {
    const updatedAt = new Date();
    await this.db
      .insert(schema.seatThumbnails)
      .values({ roomId, unit, ...t, updatedAt })
      .onConflictDoUpdate({
        target: [schema.seatThumbnails.roomId, schema.seatThumbnails.unit],
        set: { ...t, updatedAt },
      });
    return updatedAt;
  }

  async getThumbnail(roomId: string, unit: number): Promise<{ jpeg: Buffer; updatedAt: Date } | null> {
    const r = await this.db
      .select({ jpeg: schema.seatThumbnails.jpeg, updatedAt: schema.seatThumbnails.updatedAt })
      .from(schema.seatThumbnails)
      .where(and(eq(schema.seatThumbnails.roomId, roomId), eq(schema.seatThumbnails.unit, unit)));
    return r[0] ?? null;
  }

  async listThumbnails(roomId: string): Promise<Array<{ unit: number; updatedAt: Date }>> {
    return this.db
      .select({ unit: schema.seatThumbnails.unit, updatedAt: schema.seatThumbnails.updatedAt })
      .from(schema.seatThumbnails)
      .where(eq(schema.seatThumbnails.roomId, roomId))
      .orderBy(asc(schema.seatThumbnails.unit));
  }

  // ---------------------------------------------------- learned seat corrections (learn.ts)

  async listCorrections(): Promise<SeatLearnRecord[]> {
    const rs = await this.db.select().from(schema.seatCorrections);
    return rs.map((r) => ({
      roomId: r.roomId,
      unit: r.unit,
      cameraId: r.cameraId,
      preset: r.preset,
      presetPos: r.presetPos ?? null,
      samples: r.samples ?? [],
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async putCorrection(r: SeatLearnRecord): Promise<void> {
    const row = {
      cameraId: r.cameraId,
      preset: r.preset,
      presetPos: r.presetPos,
      samples: r.samples,
      updatedAt: new Date(r.updatedAt),
    };
    await this.db
      .insert(schema.seatCorrections)
      .values({ roomId: r.roomId, unit: r.unit, ...row })
      .onConflictDoUpdate({ target: [schema.seatCorrections.roomId, schema.seatCorrections.unit], set: row });
  }

  async deleteCorrections(roomId: string, unit?: number): Promise<void> {
    const where =
      unit === undefined
        ? eq(schema.seatCorrections.roomId, roomId)
        : and(eq(schema.seatCorrections.roomId, roomId), eq(schema.seatCorrections.unit, unit));
    await this.db.delete(schema.seatCorrections).where(where);
  }

  private async write(id: string, input: RoomInput, isNew: boolean) {
    const camIds = new Set(input.cameras.map((c) => c.id));
    for (const s of input.seats) {
      if (!camIds.has(s.cameraId)) throw new Error(`seat ${s.unit} references an unknown camera`);
    }
    const units = input.seats.map((s) => s.unit);
    if (new Set(units).size !== units.length) throw new Error('each DCen unit can be mapped to only one seat');

    await this.db.transaction(async (tx) => {
      const row = {
        name: input.name,
        enabled: input.enabled,
        dcenHost: input.dcenHost,
        dcenPort: input.dcenPort,
        outputName: input.outputName,
        outputMode: input.outputMode,
        policy: input.policy,
        updatedAt: new Date(),
      };
      if (isNew) await tx.insert(schema.rooms).values({ id, ...row });
      else await tx.update(schema.rooms).set(row).where(eq(schema.rooms.id, id));
      // replace cameras + seats (seats cascade with cameras)
      await tx.delete(schema.seats).where(eq(schema.seats.roomId, id));
      await tx.delete(schema.cameras).where(eq(schema.cameras.roomId, id));
      if (input.cameras.length) {
        await tx.insert(schema.cameras).values(
          input.cameras.map((c, i) => ({
            id: c.id,
            roomId: id,
            position: i,
            name: c.name,
            driver: c.driver,
            host: c.host,
            port: c.port,
            role: c.role,
            ndiSource: c.ndiSource,
            settleMs: c.settleMs,
            homePreset: c.homePreset,
            credentialsRef: c.credentialsRef,
            options: c.options,
          })),
        );
      }
      if (input.seats.length) {
        await tx.insert(schema.seats).values(input.seats.map((s) => ({ roomId: id, ...s })));
      }
    });
  }
}
