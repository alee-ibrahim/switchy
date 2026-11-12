/**
 * Persist stored preset coordinates (camera.options.autoframe.presets) in the
 * DB and in the running room, without restarting the room.
 */
import type { RoomRepo } from '../../db/repo.js';
import type { PtzPosition } from '../cameras/types.js';
import type { Engine } from '../engine.js';
import { withPresetPosition } from './presets.js';

export type RoomStore = Pick<RoomRepo, 'get' | 'update'>;

let chain: Promise<unknown> = Promise.resolve();

/** Set (or with null, forget) one preset's coordinates. Writes are serialised. */
export function storePresetPosition(
  engine: Pick<Engine, 'updateCameraOptions'>,
  rooms: RoomStore,
  roomId: string,
  cameraId: string,
  preset: string,
  pos: PtzPosition | null,
): Promise<void> {
  const run = async () => {
    const room = await rooms.get(roomId);
    if (!room) throw new Error('room not found');
    const cam = room.cameras.find((c) => c.id === cameraId);
    if (!cam) throw new Error('unknown camera');
    const options = withPresetPosition(cam.options ?? {}, preset, pos);
    const cameras = room.cameras.map((c) => (c.id === cameraId ? { ...c, options } : c));
    const { id: _id, ...input } = room;
    await rooms.update(roomId, { ...input, cameras });
    engine.updateCameraOptions(roomId, cameraId, options);
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}
