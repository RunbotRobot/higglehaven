import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllLandlets } from './api.js';

// fetchAllLandlets makes real fetch() calls against /api/... — mock the
// global rather than spinning up a worker, since this only needs to prove
// the pagination/param-threading logic itself, not the backend (that's
// worker/index.test.js's job). See vitest.config.js's own note on why
// src/**/*.test.js is for dependency-free modules like this one.
afterEach(() => {
  vi.unstubAllGlobals();
});

function mockPaginatedFetch(pages) {
  let call = 0;
  const requestedUrls = [];
  vi.stubGlobal('fetch', vi.fn((url) => {
    requestedUrls.push(url);
    const page = pages[call];
    call += 1;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(page),
    });
  }));
  return requestedUrls;
}

describe('fetchAllLandlets', () => {
  it('returns every landlet from a single page with no params', async () => {
    mockPaginatedFetch([{ landlets: [{ landletId: 'a' }, { landletId: 'b' }], nextCursor: null }]);
    const all = await fetchAllLandlets();
    expect(all).toEqual([{ landletId: 'a' }, { landletId: 'b' }]);
  });

  it('follows nextCursor across multiple pages, accumulating every result', async () => {
    const urls = mockPaginatedFetch([
      { landlets: [{ landletId: 'a' }], nextCursor: 'cursor-1' },
      { landlets: [{ landletId: 'b' }], nextCursor: 'cursor-2' },
      { landlets: [{ landletId: 'c' }], nextCursor: null },
    ]);
    const all = await fetchAllLandlets();
    expect(all).toEqual([{ landletId: 'a' }, { landletId: 'b' }, { landletId: 'c' }]);
    expect(urls[0]).not.toContain('cursor=');
    expect(urls[1]).toContain('cursor=cursor-1');
    expect(urls[2]).toContain('cursor=cursor-2');
  });

  // #186: the Land Cap panel undercounted a builder's owned area past 100
  // landlets because its call site used the single-page fetchLandlets
  // instead of this function — this is the fix, proving the filter params
  // survive every page of the walk, not just the first.
  it('threads filter params (status, ownerBuilderId) onto every page, not just the first', async () => {
    const urls = mockPaginatedFetch([
      { landlets: [{ landletId: 'a' }], nextCursor: 'cursor-1' },
      { landlets: [{ landletId: 'b' }], nextCursor: null },
    ]);
    const all = await fetchAllLandlets({ status: 'claimed', ownerBuilderId: 'builder-1' });
    expect(all).toEqual([{ landletId: 'a' }, { landletId: 'b' }]);
    for (const url of urls) {
      expect(url).toContain('status=claimed');
      expect(url).toContain('ownerBuilderId=builder-1');
    }
  });

  it('omits null/undefined params instead of sending the literal string', async () => {
    const urls = mockPaginatedFetch([{ landlets: [], nextCursor: null }]);
    await fetchAllLandlets({ status: 'claimed', ownerBuilderId: undefined });
    expect(urls[0]).not.toContain('ownerBuilderId');
  });
});
