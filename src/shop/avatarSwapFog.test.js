import { describe, expect, it, vi } from 'vitest';
import {
  avatarSwapLevels, startAvatarSwapTransition, cancelAvatarSwapTransition, stepAvatarSwapTransition,
  SWAP_FOG_RISE_S, SWAP_TOTAL_S,
} from './avatarSwapFog.js';

function fakes() {
  const log = [];
  const fog = {
    object: { position: { set: vi.fn((x, y, z) => log.push(['fog-at', x, y, z])) } },
    setLevel: vi.fn((v) => log.push(['fog', v])), dispose: vi.fn(() => log.push(['fog-dispose'])),
  };
  const dissolve = { setLevel: vi.fn((v) => log.push(['item', v])), restore: vi.fn(() => log.push(['restore'])) };
  const effects = { createFog: vi.fn(() => fog), createDissolve: vi.fn(() => dissolve) };
  const parent = { add: vi.fn(), remove: vi.fn() };
  let avatar = { group: { position: { x: 1, y: 2, z: 3 } } };
  const incoming = { group: { position: { x: 1, y: 2, z: 3 } } };
  const swap = vi.fn(() => { log.push(['swap']); avatar = incoming; });
  const abort = vi.fn(() => log.push(['abort']));
  return { log, fog, dissolve, effects, parent, swap, abort, getAvatar: () => avatar };
}

describe('the avatar swap through fog (#3905)', () => {
  it('fog thickens over the old body first, the models change at its peak, then the new body resolves as the fog thins', () => {
    expect(avatarSwapLevels(0)).toMatchObject({ fog: 0, item: 0, swap: false, done: false });
    const mid = avatarSwapLevels(SWAP_FOG_RISE_S / 2);
    expect(mid.fog).toBeGreaterThan(0);
    expect(mid.swap).toBe(false);
    expect(avatarSwapLevels(SWAP_FOG_RISE_S)).toMatchObject({ fog: 1, item: 0, swap: true, done: false });
    const later = avatarSwapLevels(SWAP_FOG_RISE_S + 0.3);
    expect(later.fog).toBeLessThan(1);
    expect(later.item).toBeGreaterThan(0);
    expect(avatarSwapLevels(SWAP_TOTAL_S)).toMatchObject({ fog: 0, item: 1, swap: true, done: true });
  });

  it('with reduced motion there is no fog and the swap is immediate', () => {
    expect(avatarSwapLevels(0, { reducedMotion: true })).toEqual({ fog: 0, item: 1, swap: true, done: true });
    const t = fakes();
    const result = startAvatarSwapTransition({ ...t, startedAtMs: 0, reducedMotion: true });
    expect(result).toBeNull();
    expect(t.swap).toHaveBeenCalledTimes(1);
    expect(t.effects.createFog).not.toHaveBeenCalled();
  });

  it('swaps once, at the peak, never before; the fog follows the avatar and everything is released at the end', () => {
    const t = fakes();
    startAvatarSwapTransition({ ...t, startedAtMs: 1000 });
    stepAvatarSwapTransition(1000 + 100);
    expect(t.swap).not.toHaveBeenCalled();
    stepAvatarSwapTransition(1000 + SWAP_FOG_RISE_S * 1000 + 10);
    expect(t.swap).toHaveBeenCalledTimes(1);
    expect(t.effects.createDissolve).toHaveBeenCalledTimes(1); // on the incoming body
    stepAvatarSwapTransition(1000 + 700);
    expect(t.swap).toHaveBeenCalledTimes(1);
    expect(t.fog.object.position.set).toHaveBeenCalled();
    stepAvatarSwapTransition(1000 + SWAP_TOTAL_S * 1000 + 50);
    expect(t.fog.dispose).toHaveBeenCalledTimes(1);
    expect(t.dissolve.restore).toHaveBeenCalledTimes(1);
    stepAvatarSwapTransition(1000 + 5000); // nothing playing any more
    expect(t.swap).toHaveBeenCalledTimes(1);
  });

  it('cancelled before the swap it drops the incoming body and releases the fog; after the swap it leaves the new body whole', () => {
    const before = fakes();
    startAvatarSwapTransition({ ...before, startedAtMs: 0 });
    cancelAvatarSwapTransition();
    expect(before.abort).toHaveBeenCalledTimes(1);
    expect(before.swap).not.toHaveBeenCalled();
    expect(before.fog.dispose).toHaveBeenCalledTimes(1);

    const after = fakes();
    startAvatarSwapTransition({ ...after, startedAtMs: 0 });
    stepAvatarSwapTransition(SWAP_FOG_RISE_S * 1000 + 20);
    cancelAvatarSwapTransition();
    expect(after.abort).not.toHaveBeenCalled();
    expect(after.dissolve.restore).toHaveBeenCalledTimes(1);
    expect(after.fog.dispose).toHaveBeenCalledTimes(1);
  });

  it('a new transition cancels the one still playing', () => {
    const first = fakes();
    startAvatarSwapTransition({ ...first, startedAtMs: 0 });
    const second = fakes();
    startAvatarSwapTransition({ ...second, startedAtMs: 0 });
    expect(first.abort).toHaveBeenCalledTimes(1);
    expect(first.fog.dispose).toHaveBeenCalledTimes(1);
    cancelAvatarSwapTransition();
  });
});
