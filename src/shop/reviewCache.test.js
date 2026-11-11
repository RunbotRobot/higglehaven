import { describe, expect, it } from 'vitest';
import { createReviewCache, REVIEW_CACHE_TTL_MS, REVIEW_FAILURE_BACKOFF_MS } from './reviewCache.js';

function harness(fetchImpl) {
  let clock = 1000;
  const calls = [];
  const cache = createReviewCache({
    now: () => clock,
    fetchReviews: (id) => {
      calls.push(id);
      return fetchImpl(id, calls.length);
    },
  });
  return { cache, calls, advance: (ms) => { clock += ms; } };
}

describe('reviewCache (#3463)', () => {
  it('829 placements of one product make one request and all get the answer', async () => {
    const h = harness(async () => ({ reviews: [{ reviewId: 'r1' }] }));
    const results = await Promise.all(Array.from({ length: 829 }, () => h.cache.get('brick')));
    expect(h.calls).toEqual(['brick']);
    expect(h.cache.requestCount()).toBe(1);
    expect(results.every((r) => r.reviews[0].reviewId === 'r1')).toBe(true);
  });

  it('different products each get their own request', async () => {
    const h = harness(async (id) => ({ reviews: [id] }));
    await Promise.all([h.cache.get('a'), h.cache.get('b'), h.cache.get('a')]);
    expect(h.calls.sort()).toEqual(['a', 'b']);
  });

  it('reuses a settled answer until it expires, then asks again', async () => {
    const h = harness(async (id, n) => ({ reviews: [n] }));
    expect((await h.cache.get('a')).reviews).toEqual([1]);
    h.advance(REVIEW_CACHE_TTL_MS - 1);
    expect((await h.cache.get('a')).reviews).toEqual([1]);
    h.advance(2);
    expect((await h.cache.get('a')).reviews).toEqual([2]);
    expect(h.calls).toHaveLength(2);
  });

  it('a post, edit or delete invalidates, so the next placement sees the change', async () => {
    const h = harness(async (id, n) => ({ reviews: [n] }));
    await h.cache.get('a');
    h.cache.invalidate('a');
    expect((await h.cache.get('a')).reviews).toEqual([2]);
  });

  it('shares a failure with everyone waiting, backs off, then retries and recovers', async () => {
    let failing = true;
    const h = harness(async () => {
      if (failing) throw new Error('offline');
      return { reviews: [] };
    });
    const waiting = await Promise.allSettled([h.cache.get('a'), h.cache.get('a'), h.cache.get('a')]);
    expect(waiting.every((r) => r.status === 'rejected')).toBe(true);
    expect(h.calls).toHaveLength(1);

    // Inside the backoff window a new placement does not hit the server again.
    h.advance(REVIEW_FAILURE_BACKOFF_MS - 1);
    await expect(h.cache.get('a')).rejects.toThrow('offline');
    expect(h.calls).toHaveLength(1);

    // After it, the next placement tries again, and the failure did not stick.
    failing = false;
    h.advance(2);
    await expect(h.cache.get('a')).resolves.toEqual({ reviews: [] });
    expect(h.calls).toHaveLength(2);
  });

  it('an invalidate during a request does not let the old answer stand as current', async () => {
    let release;
    const h = harness((id, n) => (n === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ reviews: ['fresh'] })));
    const stale = h.cache.get('a');
    h.cache.invalidate('a');
    const fresh = await h.cache.get('a');
    expect(fresh.reviews).toEqual(['fresh']);
    release({ reviews: ['old'] });
    await stale;
    // The late old answer must not overwrite the fresh entry's life.
    expect((await h.cache.get('a')).reviews).toEqual(['fresh']);
    expect(h.calls).toHaveLength(2);
  });

  it('a synchronous throw in the fetch is a failure, not a crash', async () => {
    const cache = createReviewCache({ fetchReviews: () => { throw new Error('boom'); } });
    await expect(cache.get('a')).rejects.toThrow('boom');
  });
});
