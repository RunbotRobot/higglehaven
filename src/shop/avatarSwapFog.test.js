import { describe, it, expect, vi } from 'vitest';
import { avatarSwapLevels, beginAvatarSwapFog, beginAvatarFogHold, AVATAR_SWAP_FOG_RISE_S, AVATAR_SWAP_FOG_CLEAR_S, AVATAR_SWAP_TOTAL_S } from './avatarSwapFog.js';

function fakeFog() {
  const fog = { object: { position: { set: vi.fn() } }, setLevel: vi.fn(), dispose: vi.fn() };
  return fog;
}

describe('avatarSwapLevels (#3905)', () => {
  it('rises from nothing, swaps at the peak, then clears', () => {
    expect(avatarSwapLevels(0)).toEqual({ fog: 0, swap: false, done: false });
    const mid = avatarSwapLevels(AVATAR_SWAP_FOG_RISE_S / 2);
    expect(mid.fog).toBeGreaterThan(0);
    expect(mid.fog).toBeLessThan(1);
    expect(mid.swap).toBe(false);
    expect(avatarSwapLevels(AVATAR_SWAP_FOG_RISE_S)).toEqual({ fog: 1, swap: true, done: false });
    const end = avatarSwapLevels(AVATAR_SWAP_TOTAL_S);
    expect(end.fog).toBe(0);
    expect(end.done).toBe(true);
  });

  it('treats a bad age as zero', () => {
    expect(avatarSwapLevels(NaN).fog).toBe(0);
    expect(avatarSwapLevels(-5).swap).toBe(false);
  });
});

describe('beginAvatarSwapFog (#3905)', () => {
  const pos = { x: 1, y: 2, z: 3 };

  it('swaps once at the fog peak, follows the avatar, and releases the fog at the end', async () => {
    const fog = fakeFog();
    const parent = { add: vi.fn() };
    const commit = vi.fn();
    const swap = beginAvatarSwapFog({ createFog: () => fog, parent, getPosition: () => pos, commit, nowMs: 1000 });
    expect(parent.add).toHaveBeenCalledWith(fog.object);
    expect(swap.step(1000 + 100)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(swap.step(1000 + AVATAR_SWAP_FOG_RISE_S * 1000 + 10)).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(fog.object.position.set).toHaveBeenLastCalledWith(1, 2, 3.2);
    await swap.done;
    expect(swap.step(1000 + AVATAR_SWAP_TOTAL_S * 1000 + 10)).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(fog.dispose).toHaveBeenCalledTimes(1);
  });

  it('swaps at once, with no fog, under reduced motion', async () => {
    const createFog = vi.fn();
    const commit = vi.fn();
    const swap = beginAvatarSwapFog({ createFog, parent: {}, getPosition: () => pos, commit, nowMs: 0, reducedMotion: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(createFog).not.toHaveBeenCalled();
    await swap.done;
    expect(swap.step(5)).toBe(true);
  });

  it('a cancelled swap still puts the real body in place and releases the fog', async () => {
    const fog = fakeFog();
    const commit = vi.fn();
    const swap = beginAvatarSwapFog({ createFog: () => fog, parent: { add: vi.fn() }, getPosition: () => pos, commit, nowMs: 0 });
    swap.cancel();
    await swap.done;
    expect(commit).toHaveBeenCalledTimes(1);
    expect(fog.dispose).toHaveBeenCalledTimes(1);
    swap.cancel();
    expect(fog.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('beginAvatarFogHold (#4067)', () => {
  const pos = { x: 1, y: 2, z: 3 };

  it('rises, holds at the peak while nothing is known, and puts no body in place until resolved', () => {
    const fog = fakeFog();
    const hold = beginAvatarFogHold({ createFog: () => fog, parent: { add: vi.fn() }, getPosition: () => pos, nowMs: 0 });
    expect(hold.step(AVATAR_SWAP_FOG_RISE_S * 500)).toBe(false);
    expect(fog.setLevel.mock.calls.at(-1)[0]).toBeGreaterThan(0);
    expect(hold.step(AVATAR_SWAP_FOG_RISE_S * 1000)).toBe(false);
    expect(fog.setLevel.mock.calls.at(-1)[0]).toBe(1);
    expect(hold.step(10_000)).toBe(false); // still holding, however long it takes
    expect(fog.setLevel.mock.calls.at(-1)[0]).toBe(1);
    expect(fog.dispose).not.toHaveBeenCalled();
  });

  it('follows the avatar while it waits', () => {
    const fog = fakeFog();
    const moving = { x: 0, y: 0, z: 0 };
    const hold = beginAvatarFogHold({ createFog: () => fog, parent: { add: vi.fn() }, getPosition: () => moving, nowMs: 0 });
    moving.x = 9;
    hold.step(2000);
    expect(fog.object.position.set).toHaveBeenLastCalledWith(9, 0, 0.2);
  });

  it('puts the right body in place at the peak once resolved, then thins the fog away', () => {
    const fog = fakeFog();
    const commit = vi.fn();
    const hold = beginAvatarFogHold({ createFog: () => fog, parent: { add: vi.fn() }, getPosition: () => pos, nowMs: 0 });
    hold.step(1000);
    hold.resolve(commit);
    const resolvedAt = performance.now();
    expect(commit).not.toHaveBeenCalled(); // not until the next frame at the peak
    hold.step(resolvedAt + 1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(hold.step(resolvedAt + AVATAR_SWAP_FOG_CLEAR_S * 1000 + 5)).toBe(true);
    expect(fog.dispose).toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('resolved before the fog has risen: the body waits for the peak', () => {
    const fog = fakeFog();
    const commit = vi.fn();
    const hold = beginAvatarFogHold({ createFog: () => fog, parent: { add: vi.fn() }, getPosition: () => pos, nowMs: performance.now() });
    hold.resolve(commit);
    hold.step(performance.now() + 50); // 0.05 s in: the fog is still rising
    expect(commit).not.toHaveBeenCalled();
    hold.step(performance.now() + AVATAR_SWAP_FOG_RISE_S * 1000 + 10);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('with reduced motion (no fog) resolve puts the body in place at once', async () => {
    const commit = vi.fn();
    const hold = beginAvatarFogHold({ createFog: null, parent: {}, getPosition: () => pos, nowMs: 0, reducedMotion: true });
    hold.resolve(commit);
    expect(commit).toHaveBeenCalledTimes(1);
    await hold.done;
  });

  it('a cancelled hold still runs a later commit, so a body is never lost', () => {
    const fog = fakeFog();
    const commit = vi.fn();
    const hold = beginAvatarFogHold({ createFog: () => fog, parent: { add: vi.fn() }, getPosition: () => pos, nowMs: 0 });
    hold.cancel();
    expect(fog.dispose).toHaveBeenCalled();
    hold.resolve(commit);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
