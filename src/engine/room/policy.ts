import type { RoomPolicy } from '../types.js';

/**
 * Decide who should be on camera.
 * @param onList units with mic on, in the order they switched on (oldest first)
 * @param current the unit currently selected (or null)
 */
export function selectSpeaker(
  onList: readonly number[],
  current: number | null,
  policy: Pick<RoomPolicy, 'chairPriority' | 'chairUnit' | 'mode'>,
): number | null {
  if (onList.length === 0) return null;
  if (policy.chairPriority && policy.chairUnit !== null && onList.includes(policy.chairUnit)) {
    return policy.chairUnit;
  }
  if (policy.mode === 'first') {
    if (current !== null && onList.includes(current)) return current;
    // current speaker finished (or nobody yet): first-speaker mode starts with
    // the oldest mic, but after a speaker leaves we follow the most recent one.
    if (current === null) return onList[0]!;
  }
  return onList[onList.length - 1]!;
}
