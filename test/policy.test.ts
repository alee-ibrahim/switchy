import { describe, expect, it } from 'vitest';
import { selectSpeaker } from '../src/engine/room/policy.js';

const base = { chairPriority: false, chairUnit: null, mode: 'last' as const };

describe('selectSpeaker', () => {
  it('nobody on -> null', () => expect(selectSpeaker([], 3, base)).toBeNull());
  it('last mode follows the newest mic', () => expect(selectSpeaker([2, 1], 2, base)).toBe(1));
  it('falls back to the most recent remaining speaker', () => expect(selectSpeaker([2, 4], 1, base)).toBe(4));
  it('chair priority wins while the chair mic is on', () => {
    const p = { ...base, chairPriority: true, chairUnit: 3 };
    expect(selectSpeaker([3, 2], 3, p)).toBe(3);
    expect(selectSpeaker([2], 3, p)).toBe(2);
    expect(selectSpeaker([3, 2], 3, { ...p, chairPriority: false })).toBe(2);
  });
  it('first mode keeps the current speaker while on', () => {
    const p = { ...base, mode: 'first' as const };
    expect(selectSpeaker([2], null, p)).toBe(2);
    expect(selectSpeaker([2, 1], 2, p)).toBe(2);
    expect(selectSpeaker([1, 4], 2, p)).toBe(4); // current left -> most recent remaining
    expect(selectSpeaker([1, 4], null, p)).toBe(1);
  });
});
