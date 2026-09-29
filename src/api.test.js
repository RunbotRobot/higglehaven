import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmCard, createInstancesRemote, deleteLandletLevel, fetchAllAuctions, fetchAllLandlets, fetchBundles,
  fetchCurrentUser, fetchSharedBundles,
} from './api.js';

// fetchAllLandlets makes real fetch() calls against /api/... — mock the
// global rather than spinning up a worker, since this only needs to prove
// the pagination/param-threading logic itself, not the backend (that's
// worker/*.test.js's job). See vitest.config.js's own note on why
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

describe('fetchAllAuctions', () => {
  // #190: same silent-truncation shape #186 fixed for fetchAllLandlets —
  // the browse-auctions panel used the single-page fetchAuctions instead
  // of a paginating fetch, so this proves the fix follows nextCursor and
  // threads filter params onto every page.
  it('follows nextCursor across multiple pages, accumulating every result', async () => {
    const urls = mockPaginatedFetch([
      { auctions: [{ auctionId: 'a' }], nextCursor: 'cursor-1' },
      { auctions: [{ auctionId: 'b' }], nextCursor: null },
    ]);
    const all = await fetchAllAuctions({ status: 'active' });
    expect(all).toEqual([{ auctionId: 'a' }, { auctionId: 'b' }]);
    expect(urls[0]).toContain('status=active');
    expect(urls[1]).toContain('status=active');
    expect(urls[1]).toContain('cursor=cursor-1');
  });

  it('returns every auction from a single page with no params', async () => {
    mockPaginatedFetch([{ auctions: [{ auctionId: 'a' }], nextCursor: null }]);
    const all = await fetchAllAuctions();
    expect(all).toEqual([{ auctionId: 'a' }]);
  });
});

// #1035: same silent-truncation shape #186/#190 fixed for landlets/
// auctions — fetchBundles()/fetchSharedBundles() used to do a single-page
// fetch and drop nextCursor entirely, even though GET /api/bundles has
// been cursor-paginated since #751.
describe('fetchBundles', () => {
  it('returns every bundle from a single page with no params', async () => {
    mockPaginatedFetch([{ bundles: [{ bundleId: 'a' }, { bundleId: 'b' }], nextCursor: null }]);
    const all = await fetchBundles();
    expect(all).toEqual([{ bundleId: 'a' }, { bundleId: 'b' }]);
  });

  it('follows nextCursor across multiple pages, accumulating every result', async () => {
    const urls = mockPaginatedFetch([
      { bundles: [{ bundleId: 'a' }], nextCursor: 'cursor-1' },
      { bundles: [{ bundleId: 'b' }], nextCursor: 'cursor-2' },
      { bundles: [{ bundleId: 'c' }], nextCursor: null },
    ]);
    const all = await fetchBundles();
    expect(all).toEqual([{ bundleId: 'a' }, { bundleId: 'b' }, { bundleId: 'c' }]);
    expect(urls[0]).not.toContain('cursor=');
    expect(urls[1]).toContain('cursor=cursor-1');
    expect(urls[2]).toContain('cursor=cursor-2');
  });
});

describe('fetchSharedBundles', () => {
  it('follows nextCursor across multiple pages, always requesting shared=true', async () => {
    const urls = mockPaginatedFetch([
      { bundles: [{ bundleId: 'a' }], nextCursor: 'cursor-1' },
      { bundles: [{ bundleId: 'b' }], nextCursor: null },
    ]);
    const all = await fetchSharedBundles();
    expect(all).toEqual([{ bundleId: 'a' }, { bundleId: 'b' }]);
    for (const url of urls) {
      expect(url).toContain('shared=true');
    }
    expect(urls[1]).toContain('cursor=cursor-1');
  });
});

describe('createInstancesRemote', () => {
  // #903: a later chunk failing after an earlier one already succeeded must
  // not look like "nothing was saved" to the caller (syncBatchCreate uses
  // this to avoid telling the builder their whole placement failed when
  // most of it actually made it to the server).
  it('attaches how many instances succeeded before a chunk failure', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      call += 1;
      if (call === 1) {
        const sent = JSON.parse(options.body).instances;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ instances: sent.map((i) => ({ ...i, instanceId: `${i.templateId}-saved` })) }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Internal server error' }),
      });
    }));

    const instances = Array.from({ length: 150 }, (_, i) => ({ templateId: `item-${i}`, x: i, y: 0, z: 0 }));
    const error = await createInstancesRemote(instances).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.succeededCount).toBe(100); // the first 100-item chunk
  });

  it('never sets succeededCount when every chunk succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      const sent = JSON.parse(options.body).instances;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ instances: sent.map((i) => ({ ...i, instanceId: `${i.templateId}-saved` })) }),
      });
    }));
    const instances = [{ templateId: 'a', x: 0, y: 0, z: 0 }];
    const created = await createInstancesRemote(instances);
    expect(created).toEqual([{ templateId: 'a', x: 0, y: 0, z: 0, instanceId: 'a-saved' }]);
  });
});

describe('deleteLandletLevel', () => {
  // #901: without surfacing this, nothing tells the caller which instances
  // the server just swept out of active space, so their meshes go stale.
  it('returns the server\'s sweptInstanceIds', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ deleted: true, sweptInstanceIds: ['a', 'b'] }),
    })));
    await expect(deleteLandletLevel('landlet-1', 2)).resolves.toEqual(['a', 'b']);
  });
});

describe('fetchCurrentUser', () => {
  it('resolves the user on a normal 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ user: { userId: 'user-1' } }),
    })));
    await expect(fetchCurrentUser()).resolves.toEqual({ userId: 'user-1' });
  });

  it('resolves null when nobody is logged in (the real 200/{user: null} case)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ user: null }),
    })));
    await expect(fetchCurrentUser()).resolves.toBeNull();
  });

  // A genuine backend error must not collapse into the same result as
  // "nobody is logged in" (handleMe's own 200/{user: null}) — that
  // conflation is exactly what silently signed out an already-logged-in
  // visitor on a transient 500. This module's own top comment says
  // nothing in here retries or swallows errors; refreshCurrentUser
  // (src/main.js) is the one responsible for deciding what to do with
  // a thrown error, not this function.
  it('rejects (does not swallow) a real HTTP error instead of returning null for it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Internal server error' }),
    })));
    await expect(fetchCurrentUser()).rejects.toThrow('Internal server error');
  });
});

// #1072: handleConfirmCard (worker/index.js) used to trust a client-supplied
// paymentMethodId directly, letting a replayed id from anywhere grant
// credit_card trust tier with no real verification. The fix moved to
// deriving the PaymentMethod server-side off a SetupIntent this app itself
// created for the current user -- this only proves the client-side half:
// confirmCard sends the SetupIntent's own id, not a PaymentMethod id, since
// that's the one piece worker/*.test.js can't see (this suite never
// configures STRIPE_SECRET_KEY, so the real Stripe-calling branch itself
// has no automated coverage at all, consistent with every other
// real-Stripe-API branch in this file).
describe('confirmCard', () => {
  it('sends the SetupIntent id as setupIntentId, not a PaymentMethod id', async () => {
    let sentBody;
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      sentBody = JSON.parse(options.body);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ user: { userId: 'user-1', trustTier: 'credit_card' } }),
      });
    }));
    await confirmCard('seti_abc123');
    expect(sentBody).toEqual({ setupIntentId: 'seti_abc123' });
  });
});
