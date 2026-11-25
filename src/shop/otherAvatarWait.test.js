import { describe, expect, it } from 'vitest';
import { beginOtherAvatarWait, waitFogLevel, WAIT_FOG_HOLD, WAIT_FOG_CLEAR_S } from './otherAvatarWait.js';

const fakeFog = () => {
  const log = { levels: [], disposed: false, added: false, removed: false };
  const object = { position: { set() {} } };
  return {
    log,
    createFog: () => ({ object, setLevel: (l) => log.levels.push(l), dispose: () => { log.disposed = true; } }),
    parent: { add: () => { log.added = true; } },
  };
};
const standing = () => ({ x: 1, y: 2, z: 0 });

describe('waitFogLevel', () => {
  it('thickens and holds while the model is still loading, however long that takes', () => {
    expect(waitFogLevel(0).fog).toBe(0);
    expect(waitFogLevel(0.2).fog).toBeGreaterThan(0);
    expect(waitFogLevel(0.4).fog).toBeCloseTo(WAIT_FOG_HOLD, 5);
    expect(waitFogLevel(30).fog).toBeCloseTo(WAIT_FOG_HOLD, 5);
    expect(waitFogLevel(30).done).toBe(false);
  });
  it('thins away from where it was once the model is ready, and is done after the clear time', () => {
    const mid = waitFogLevel(5 + WAIT_FOG_CLEAR_S / 2, 5);
    expect(mid.fog).toBeGreaterThan(0);
    expect(mid.fog).toBeLessThan(WAIT_FOG_HOLD);
    expect(waitFogLevel(5 + WAIT_FOG_CLEAR_S, 5)).toEqual({ fog: 0, done: true });
  });
  it('thins from a thin fog when the model is ready almost at once, never jumping up first', () => {
    expect(waitFogLevel(0.1, 0.1).fog).toBeLessThan(0.2);
  });
});

describe('beginOtherAvatarWait', () => {
  it('puts fog where they stand, holds it, and releases it only after the model is ready and the fog has thinned', () => {
    const f = fakeFog();
    const wait = beginOtherAvatarWait({ ...f, getPosition: standing, nowMs: 0 });
    expect(f.log.added).toBe(true);
    expect(wait.step(200)).toBe(false);
    expect(wait.step(20000)).toBe(false);
    wait.ready(20000);
    expect(wait.step(20300)).toBe(false);
    expect(wait.step(20000 + WAIT_FOG_CLEAR_S * 1000 + 10)).toBe(true);
    expect(f.log.disposed).toBe(true);
  });
  it('cancel releases the fog at once', () => {
    const f = fakeFog();
    const wait = beginOtherAvatarWait({ ...f, getPosition: standing, nowMs: 0 });
    wait.cancel();
    expect(f.log.disposed).toBe(true);
    expect(wait.step(100)).toBe(true);
  });
  it('with reduced motion draws no fog and is released as soon as the model is ready', () => {
    const f = fakeFog();
    const wait = beginOtherAvatarWait({ ...f, getPosition: standing, nowMs: 0, reducedMotion: true });
    expect(f.log.added).toBe(false);
    expect(wait.step(100)).toBe(false);
    wait.ready(200);
    expect(wait.step(300)).toBe(true);
  });
});
