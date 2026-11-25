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

// #4313: the review cache hands every caller the remembered failure until its
// backoff has passed, so the first retry has to wait longer than that.
import { createReviewCache, REVIEW_FAILURE_BACKOFF_MS } from './reviewCache.js';

describe('loadWhileInScene with the review cache', () => {
  it('a retry after the backoff reaches the server again and delivers the reviews', async () => {
    let clock = 0;
    let requests = 0;
    const cache = createReviewCache({
      now: () => clock,
      fetchReviews: async () => { if (++requests === 1) throw new Error('x'); return { reviews: ['r'] }; },
    });
    const timers = [];
    const got = [];
    loadWhileInScene({
      fetch: () => cache.get('t'),
      isInScene: () => true,
      onResult: (r) => got.push(r),
      delays: [REVIEW_FAILURE_BACKOFF_MS + 1000],
      setTimer: (fn, ms) => timers.push({ fn, ms }),
    });
    await flush();
    expect(timers[0].ms).toBeGreaterThan(REVIEW_FAILURE_BACKOFF_MS);
    clock += timers[0].ms;
    timers[0].fn(); await flush();
    expect(requests).toBe(2);
    expect(got).toEqual([{ reviews: ['r'] }]);
  });
});
