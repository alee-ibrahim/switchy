import { pgTable, text, integer, boolean, jsonb, timestamp, primaryKey, index, customType } from 'drizzle-orm/pg-core';
import type { RoomPolicy } from '../engine/types.js';

export const rooms = pgTable('rooms', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  dcenHost: text('dcen_host').notNull().default(''),
  dcenPort: integer('dcen_port').notNull().default(3225),
  outputName: text('output_name').notNull(),
  outputMode: text('output_mode').notNull().default('route'),
  policy: jsonb('policy').$type<RoomPolicy>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const cameras = pgTable(
  'cameras',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    name: text('name').notNull(),
    driver: text('driver').notNull(),
    host: text('host').notNull().default(''),
    port: integer('port'),
    role: text('role').notNull(),
    ndiSource: text('ndi_source').notNull().default(''),
    settleMs: integer('settle_ms').notNull().default(2500),
    homePreset: text('home_preset'),
    credentialsRef: text('credentials_ref'),
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('cameras_room_idx').on(t.roomId)],
);

export const seats = pgTable(
  'seats',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    unit: integer('unit').notNull(),
    label: text('label').notNull().default(''),
    cameraId: text('camera_id')
      .notNull()
      .references(() => cameras.id, { onDelete: 'cascade' }),
    preset: text('preset'),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.unit] })],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Small JPEG (about 320x180, 10-20 KB) of each seat's PTZ framing, shown in the seat lists.
 * Kept apart from `seats` because a room save rewrites the seat rows. Lives in
 * Postgres so it is covered by the normal DB backups (no extra volume to back up).
 */
export const seatThumbnails = pgTable(
  'seat_thumbnails',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    unit: integer('unit').notNull(),
    jpeg: bytea('jpeg').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.unit] })],
);

/**
 * Per-seat learned correction samples (track mode, src/engine/autoframe/learn.ts):
 * the last few good turns' offsets of the delegate from the seat preset's aim.
 * In Postgres so the normal DB backup covers them. The camera preset itself is
 * never changed by learning.
 */
export const seatCorrections = pgTable(
  'seat_corrections',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    unit: integer('unit').notNull(),
    cameraId: text('camera_id').notNull(),
    preset: text('preset').notNull(),
    presetPos: jsonb('preset_pos').$type<{ pan: number; tilt: number; zoom: number } | null>(),
    samples: jsonb('samples').$type<Array<{ pan: number; tilt: number; x: number; y: number; ticks: number; at: string }>>().notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.unit] })],
);
