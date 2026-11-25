import { describe, expect, it } from 'vitest';
import { loadWhileInScene } from './loadWhileInScene.js';

function harness() {
  const timers = [];
  return { timers, setTimer: (fn, ms) => timers.push({ fn, ms }) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('loadWhileInScene', () => {
  it('asks again after a failure, with growing waits, and delivers the result', async () => {
    const h = harness();
    let calls = 0;
    const got = [];
    loadWhileInScene({
      fetch: async () => { if (++calls < 3) throw new Error('x'); return 'ok'; },
      isInScene: () => true,
      onResult: (r) => got.push(r),
      delays: [10, 20, 30],
      setTimer: h.setTimer,
    });
    await flush();
    expect(h.timers.map((t) => t.ms)).toEqual([10]);
    h.timers[0].fn(); await flush();
    expect(h.timers.map((t) => t.ms)).toEqual([10, 20]);
    h.timers[1].fn(); await flush();
    expect(got).toEqual(['ok']);
    expect(calls).toBe(3);
  });

  it('stops after the last delay', async () => {
    const h = harness();
    let calls = 0;
    loadWhileInScene({ fetch: async () => { calls++; throw new Error('x'); }, isInScene: () => true, onResult: () => {}, delays: [1], setTimer: h.setTimer });
    await flush();
    h.timers[0].fn(); await flush();
    expect(calls).toBe(2);
    expect(h.timers.length).toBe(1);
  });

  it('does not ask again, or deliver, once the item left the scene', async () => {
    const h = harness();
    let inScene = true;
    let calls = 0;
    const got = [];
    loadWhileInScene({ fetch: async () => { calls++; throw new Error('x'); }, isInScene: () => inScene, onResult: (r) => got.push(r), delays: [1, 1], setTimer: h.setTimer });
    await flush();
    inScene = false;
    h.timers[0].fn(); await flush();
    expect(calls).toBe(1);
    expect(got).toEqual([]);
  });
});
