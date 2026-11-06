import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmCard, createInstancesRemote, createVideoGenerationJob, deleteInstancesRemote, deleteLandletLevel, fetchAllAuctions, fetchAllLandlets,
  fetchBundles, fetchCatalog, fetchCurrentUser, fetchSharedBundles, replaceLandletDraft, submitFeedbackBugReport,
  uploadModelFile, upsertInstancesRemote,
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

// #1380: upsertInstancesRemote/deleteInstancesRemote never attached
// succeededCount on a mid-chunk failure, unlike their sibling
// createInstancesRemote (#903 above) — so syncBatchUpdate/syncBatchDelete
// (src/main.js) overstated how much a large group-move/multi-delete lost
// when a later chunk failed after an earlier one already committed.
describe('upsertInstancesRemote', () => {
  it('attaches how many instances succeeded before a chunk failure', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      call += 1;
      if (call === 1) {
        const sent = JSON.parse(options.body).instances;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ instances: sent }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Internal server error' }),
      });
    }));

    const instances = Array.from({ length: 150 }, (_, i) => ({ instanceId: `item-${i}`, x: i, y: 0, z: 0 }));
    const error = await upsertInstancesRemote(instances).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.succeededCount).toBe(100); // the first 100-item chunk
  });

  it('never sets succeededCount when every chunk succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      const sent = JSON.parse(options.body).instances;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ instances: sent }),
      });
    }));
    const instances = [{ instanceId: 'a', x: 0, y: 0, z: 0 }];
    const updated = await upsertInstancesRemote(instances);
    expect(updated).toEqual(instances);
  });
});

describe('upsertInstancesRemote updateOnly (#3101)', () => {
  it('asks the server not to create missing ids and reports the ones it skipped', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          instances: body.instances.filter((i) => i.instanceId !== 'gone'),
          rejectedInstanceIds: [],
          missingInstanceIds: ['gone'],
        }),
      });
    }));
    const updated = await upsertInstancesRemote([
      { instanceId: 'kept', x: 0, y: 0, z: 0 }, { instanceId: 'gone', x: 1, y: 0, z: 0 },
    ], { updateOnly: true });
    expect(bodies[0].updateOnly).toBe(true);
    expect(updated.map((i) => i.instanceId)).toEqual(['kept']);
    expect(updated.missingInstanceIds).toEqual(['gone']);
  });

  it('does not send updateOnly unless asked', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      bodies.push(JSON.parse(options.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ instances: [] }) });
    }));
    await upsertInstancesRemote([{ instanceId: 'a', x: 0, y: 0, z: 0 }]);
    expect('updateOnly' in bodies[0]).toBe(false);
  });
});

describe('upsertInstancesRemote stale-version reporting (#1062)', () => {
  it('sends expectedUpdatedAt through, reports the stale instances, and hands each chunk to onChunkStored', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          instances: body.instances.filter((i) => i.instanceId !== 'old').map((i) => ({ ...i, updatedAt: 'v2' })),
          rejectedInstanceIds: [],
          staleInstanceIds: ['old'],
          staleInstances: [{ instanceId: 'old', x: 9, updatedAt: 'v9' }],
        }),
      });
    }));
    const adopted = [];
    const updated = await upsertInstancesRemote([
      { instanceId: 'fresh', x: 0, y: 0, z: 0, expectedUpdatedAt: 'v1' },
      { instanceId: 'old', x: 1, y: 0, z: 0, expectedUpdatedAt: 'v1' },
    ], { updateOnly: true, onChunkStored: (stored) => adopted.push(...stored.map((i) => i.instanceId)) });
    expect(bodies[0].instances.map((i) => i.expectedUpdatedAt)).toEqual(['v1', 'v1']);
    expect(updated.map((i) => i.instanceId)).toEqual(['fresh']);
    expect(updated.staleInstances).toEqual([{ instanceId: 'old', x: 9, updatedAt: 'v9' }]);
    expect(adopted).toEqual(['fresh']);
  });

  it('adds no staleInstances property when nothing was stale', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ instances: [{ instanceId: 'a' }], rejectedInstanceIds: [], staleInstanceIds: [], staleInstances: [] }),
    })));
    const updated = await upsertInstancesRemote([{ instanceId: 'a', x: 0, y: 0, z: 0 }]);
    expect('staleInstances' in updated).toBe(false);
  });
});

describe('deleteInstancesRemote', () => {
  it('attaches how many instances succeeded before a chunk failure', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ deletedInstanceIds: [] }) });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Internal server error' }),
      });
    }));

    const instanceIds = Array.from({ length: 150 }, (_, i) => `item-${i}`);
    const error = await deleteInstancesRemote(instanceIds).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.succeededCount).toBe(100); // the first 100-item chunk
  });

  it('never sets succeededCount when every chunk succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ deletedInstanceIds: [] }) })));
    await expect(deleteInstancesRemote(['a'])).resolves.toBeUndefined();
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
    // #1756: an older server omits the kept-content counts; they read as 0.
    await expect(deleteLandletLevel('landlet-1', 2)).resolves.toEqual({
      sweptInstanceIds: ['a', 'b'], savedSignPostCount: 0, savedCalendarEventCount: 0,
    });
  });

  it('returns how many sign posts and calendar events the saved layout kept (#1756)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ deleted: true, sweptInstanceIds: ['a'], savedSignPostCount: 3, savedCalendarEventCount: 1 }),
    })));
    await expect(deleteLandletLevel('landlet-1', 2)).resolves.toEqual({
      sweptInstanceIds: ['a'], savedSignPostCount: 3, savedCalendarEventCount: 1,
    });
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

// #2249: PUT /landlets/:id/draft's own auto-version side effect already
// dedupes on a client-supplied idempotencyKey (#1726/#2184) -- a dropped-
// response retry of a "Restore to Editor" click should no-op server-side
// instead of minting a duplicate version -- but replaceLandletDraft never
// sent one at all, so that protection was never reachable from its only
// caller. This proves the field is now sent and is a non-empty string
// (matching saveLandletVersion's own already-covered idempotencyKey
// shape); persistence/dedup-across-retries isn't exercisable here since
// this suite's pool has no localStorage, same limitation noted on
// versionIdempotencyKey's own definition in api.js.
describe('replaceLandletDraft', () => {
  it('sends a non-empty idempotencyKey alongside instances/versionName/versionMetadata', async () => {
    let sentBody;
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      sentBody = JSON.parse(options.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));
    await replaceLandletDraft('landlet-1', { instances: [{ instanceId: 'i1' }], versionName: 'Restored from "V1"' });
    expect(sentBody.instances).toEqual([{ instanceId: 'i1' }]);
    expect(sentBody.versionName).toBe('Restored from "V1"');
    expect(typeof sentBody.idempotencyKey).toBe('string');
    expect(sentBody.idempotencyKey.length).toBeGreaterThan(0);
  });
});

// #1757: a template renamed mid-fetch can be skipped by the keyset cursor;
// fetchCatalog notices via the first page's totalCount and re-runs the pass.
describe('fetchCatalog (#1757)', () => {
  it('makes one pass when the collected rows reach totalCount', async () => {
    const urls = mockPaginatedFetch([
      { templates: [{ templateId: 'a' }], nextCursor: 'c1', totalCount: 2 },
      { templates: [{ templateId: 'b' }], nextCursor: null },
    ]);
    const all = await fetchCatalog();
    expect(all.map((t) => t.templateId)).toEqual(['a', 'b']);
    expect(urls).toHaveLength(2);
  });

  it('re-runs the pass and merges by templateId when a renamed row was skipped', async () => {
    const urls = mockPaginatedFetch([
      // pass 1: "c" was renamed behind the cursor and never returned
      { templates: [{ templateId: 'a' }], nextCursor: 'c1', totalCount: 3 },
      { templates: [{ templateId: 'b' }], nextCursor: null },
      // pass 2: everything is in order now; "a"/"b" are de-duplicated
      { templates: [{ templateId: 'c' }, { templateId: 'a' }], nextCursor: 'c2', totalCount: 3 },
      { templates: [{ templateId: 'b' }], nextCursor: null },
    ]);
    const all = await fetchCatalog();
    expect(all.map((t) => t.templateId).sort()).toEqual(['a', 'b', 'c']);
    expect(urls).toHaveLength(4);
  });

  it('stops after three passes even if the total never settles', async () => {
    const page = { templates: [{ templateId: 'a' }], nextCursor: null, totalCount: 5 };
    const urls = mockPaginatedFetch([page, page, page, page]);
    const all = await fetchCatalog();
    expect(all).toHaveLength(1);
    expect(urls).toHaveLength(3);
  });

  it('does not loop when the server sends no totalCount', async () => {
    const urls = mockPaginatedFetch([{ templates: [{ templateId: 'a' }], nextCursor: null }]);
    await fetchCatalog();
    expect(urls).toHaveLength(1);
  });
});

// #1954: a response carrying a known stable `code` shows player copy instead of
// the server's developer-facing message; anything else keeps its own message.
describe('server error codes reach the player as copy, not raw server text (#1954)', () => {
  const failWith = (status, body) => vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok: false, status, json: () => Promise.resolve(body),
  })));

  it('replaces the message for a known code but keeps the server text, code and status for diagnostics', async () => {
    failWith(409, { error: 'Landlet changed concurrently — refetch and retry', code: 'changed_concurrently' });
    const error = await fetchCurrentUser().catch((e) => e);
    expect(error.message).toBe('That changed while you were working on it. Please try again.');
    expect(error.serverMessage).toBe('Landlet changed concurrently — refetch and retry');
    expect(error.code).toBe('changed_concurrently');
    expect(error.status).toBe(409);
  });

  it('keeps a validation message that is already written for players when it has no code', async () => {
    failWith(400, { error: 'Password must be at least 8 characters.' });
    const error = await fetchCurrentUser().catch((e) => e);
    expect(error.message).toBe('Password must be at least 8 characters.');
    expect(error.code).toBeUndefined();
  });

  it('keeps the server message for a code this client does not know yet', async () => {
    failWith(409, { error: 'Something new', code: 'a_code_added_later' });
    const error = await fetchCurrentUser().catch((e) => e);
    expect(error.message).toBe('Something new');
  });

  // src/build/scene.js recognises a suspended seller's rejected save by this
  // code (falling back to the original text), not by the player copy that
  // replaces `message`, so both must survive on the error.
  it('keeps the code and the original server text that the suspended-seller reconcile relies on', async () => {
    failWith(400, { error: 'This product is currently unavailable because its seller is suspended.', code: 'seller_suspended' });
    const error = await fetchCurrentUser().catch((e) => e);
    expect(error.message).toBe("That product isn't available right now.");
    expect(error.code).toBe('seller_suspended');
    expect(error.serverMessage).toMatch(/seller is suspended/);
    expect(error.status).toBe(400);
  });

  // The upload, feedback and video requests build their errors from the response
  // by hand (they send multipart bodies), so they must carry the same fields.
  it.each([
    ['uploadModelFile', () => uploadModelFile(new Blob(['x']))],
    ['submitFeedbackBugReport', () => submitFeedbackBugReport(new FormData())],
    ['createVideoGenerationJob', () => createVideoGenerationJob(new FormData())],
  ])('%s shows player copy and keeps the server text, code and status', async (_name, call) => {
    failWith(503, { error: 'Video-to-3D generation is not configured on this server yet.', code: 'service_unavailable' });
    const error = await call().catch((e) => e);
    expect(error.message).toBe("That isn't available right now. Please try again later.");
    expect(error.serverMessage).toBe('Video-to-3D generation is not configured on this server yet.');
    expect(error.code).toBe('service_unavailable');
    expect(error.status).toBe(503);
  });

  it('maps the server catch-all 500 to a calm line instead of "Internal server error"', async () => {
    failWith(500, { error: 'Internal server error', code: 'internal_error' });
    const error = await fetchCurrentUser().catch((e) => e);
    expect(error.message).toBe('Something went wrong on our end. Please try again in a moment.');
    expect(error.status).toBe(500);
  });
});
