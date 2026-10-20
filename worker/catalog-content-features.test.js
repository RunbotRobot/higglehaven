import {
  applyD1Migrations, env, SELF,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  cosineSimilarity, writePurchaseRow, escapeHtml,
} from './index.js';
import {
  api, signupBuilder, signupSeller, signupAdmin, glbFile,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('shared-admin');
  adminSession = admin.session;
});

describe('Bundles', () => {
  function bundleBody(overrides = {}) {
    return {
      name: 'Starter set',
      items: [
        { templateId: 'placeholder-chair', dx: 0, dy: 0, dz: 0 },
        { templateId: 'placeholder-tree', dx: 1, dy: 0, dz: 1 },
      ],
      ...overrides,
    };
  }

  it('creates a bundle owned by the session builder, ignoring any builderId in the body', async () => {
    const builder = await signupBuilder('bundle-create');
    const created = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify(bundleBody({ builderId: 'someone-else' })),
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.bundle).toMatchObject({
      builderId: builder.builderId,
      name: 'Starter set',
      shared: false,
    });
    expect(created.body.bundle.items).toHaveLength(2);
    expect(created.body.bundle.createdAt).toBeTruthy();
  });

  // Found via backlog audit (#791): unlike every other repeatable write in
  // this file — sign posts (#337), calendar events, friend requests —
  // creating a bundle had no checkRateLimit call at all.
  it('rate-limits repeated bundle creations from the same builder', async () => {
    const builder = await signupBuilder('bundle-rate-limit');
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/bundles', builder.session({
        method: 'POST', body: JSON.stringify(bundleBody({ name: `Bundle ${i}` })),
      }));
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify(bundleBody({ name: 'One too many' })),
    }));
    expect(limited.response.status).toBe(429);
  });

  // #892: unlike POST above (#791), PATCH/PUT and DELETE never got a
  // checkRateLimit call at all -- a single already-created bundle could be
  // mutated or deleted an unbounded number of times per second by its own
  // owner's session. Both actions share one bucket (BUNDLE_MUTATE_RATE_LIMIT_MAX),
  // so this exercises PATCH calls against the same bundle up to the limit,
  // then confirms DELETE against that same bucket is what finally 429s.
  it('rate-limits repeated bundle mutations (PATCH/DELETE) from the same builder', async () => {
    const builder = await signupBuilder('bundle-mutate-rate-limit');
    const created = await api('/bundles', builder.session({ method: 'POST', body: JSON.stringify(bundleBody()) }));
    const bundleId = created.body.bundle.bundleId;
    for (let i = 0; i < 20; i++) {
      const attempt = await api(`/bundles/${bundleId}`, builder.session({
        method: 'PATCH', body: JSON.stringify({ name: `Renamed ${i}` }),
      }));
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api(`/bundles/${bundleId}`, builder.session({ method: 'DELETE' }));
    expect(limited.response.status).toBe(429);
  });

  it('rejects an empty items array, more than 2000 items, and a nonexistent templateId', async () => {
    const builder = await signupBuilder('bundle-validate');
    const empty = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify(bundleBody({ items: [] })),
    }));
    expect(empty.response.status).toBe(400);

    const tooMany = await api('/bundles', builder.session({
      method: 'POST',
      body: JSON.stringify(bundleBody({
        items: Array.from({ length: 2001 }, () => ({ templateId: 'placeholder-chair', dx: 0, dy: 0, dz: 0 })),
      })),
    }));
    expect(tooMany.response.status).toBe(400);

    const badTemplate = await api('/bundles', builder.session({
      method: 'POST',
      body: JSON.stringify(bundleBody({ items: [{ templateId: 'template-does-not-exist', dx: 0, dy: 0, dz: 0 }] })),
    }));
    expect(badTemplate.response.status).toBe(400);
  });

  // #1974 (owner report): the old 250-item cap rejected a real, ordinary
  // build (a 32-foot brick wall with a door) saved as one bundle -- well
  // under the new 2000-item cap, but well over the old one, so this is the
  // actual regression case for the bug report, not just a boundary probe.
  it('accepts a large, legitimate bundle that the old 250-item cap would have rejected', async () => {
    const builder = await signupBuilder('bundle-large-legitimate');
    const wall = await api('/bundles', builder.session({
      method: 'POST',
      body: JSON.stringify(bundleBody({
        name: 'Brick wall with door',
        items: Array.from({ length: 400 }, (_, i) => ({ templateId: 'placeholder-chair', dx: i, dy: 0, dz: 0 })),
      })),
    }));
    expect(wall.response.status).toBe(201);
    expect(wall.body.bundle.items).toHaveLength(400);
  });

  // Found during a broader backlog-exploration pass (#358): name had no
  // length cap at all, unlike authorLabel/buyerLabel (#337).
  it('rejects a bundle name over the length cap, on both create and rename', async () => {
    const builder = await signupBuilder('bundle-name-too-long');
    const rejectedCreate = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify(bundleBody({ name: 'x'.repeat(101) })),
    }));
    expect(rejectedCreate.response.status).toBe(400);

    const created = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify(bundleBody()),
    }));
    const rejectedRename = await api(`/bundles/${created.body.bundle.bundleId}`, builder.session({
      method: 'PATCH', body: JSON.stringify({ name: 'x'.repeat(101) }),
    }));
    expect(rejectedRename.response.status).toBe(400);
  });

  // #1720: createBundle (src/api.js) always sends a stable idempotencyKey
  // it keeps reusing until the save actually succeeds — same "network
  // blip, then a retry with the same key" scenario the purchase flow's own
  // idempotencyKey (#473/#877) already handles.
  it('does not create a duplicate bundle when the same idempotencyKey is retried', async () => {
    const builder = await signupBuilder('bundle-idempotency');

    const first = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify({ ...bundleBody(), idempotencyKey: 'retry-test-key' }),
    }));
    expect(first.response.status).toBe(201);

    const retried = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify({ ...bundleBody(), idempotencyKey: 'retry-test-key' }),
    }));
    expect(retried.response.status).toBe(200);
    expect(retried.body.bundle.bundleId).toBe(first.body.bundle.bundleId);

    const bundleCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM bundles WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(bundleCount.n).toBe(1);

    // A different idempotencyKey (or none at all) is a genuinely separate
    // bundle, still created normally — this isn't a dedup-everything guard,
    // only same-key retries.
    const separate = await api('/bundles', builder.session({ method: 'POST', body: JSON.stringify(bundleBody()) }));
    expect(separate.response.status).toBe(201);
    expect(separate.body.bundle.bundleId).not.toBe(first.body.bundle.bundleId);
  });

  // #974-style cross-account guard, applied to bundles' own idempotency key:
  // two different builders submitting the same client-supplied key (e.g. a
  // stale localStorage value surviving on a shared browser) must never
  // collide on one shared bundle row.
  it('does not let two different builders collide on the same client-supplied idempotencyKey', async () => {
    const builderA = await signupBuilder('bundle-idempotency-cross-a');
    const builderB = await signupBuilder('bundle-idempotency-cross-b');
    const sharedKey = 'shared-stale-key';

    const createdByA = await api('/bundles', builderA.session({
      method: 'POST', body: JSON.stringify({ ...bundleBody(), idempotencyKey: sharedKey }),
    }));
    expect(createdByA.response.status).toBe(201);

    const createdByB = await api('/bundles', builderB.session({
      method: 'POST', body: JSON.stringify({ ...bundleBody(), idempotencyKey: sharedKey }),
    }));
    expect(createdByB.response.status).toBe(201);
    expect(createdByB.body.bundle.bundleId).not.toBe(createdByA.body.bundle.bundleId);

    const retriedByA = await api('/bundles', builderA.session({
      method: 'POST', body: JSON.stringify({ ...bundleBody(), idempotencyKey: sharedKey }),
    }));
    expect(retriedByA.response.status).toBe(200);
    expect(retriedByA.body.bundle.bundleId).toBe(createdByA.body.bundle.bundleId);
  });

  // #1873: the dedup check above only matches on bundle_id -- it never
  // compared the existing row's own content against the new request.
  // Save Bundle's prompt()/confirm() pair can legitimately produce a
  // different `shared` answer on a same-key resubmit after a lost
  // response (the client's own key, src/api.js's bundleIdempotencyKey,
  // is deliberately not namespaced by `shared`) -- a resubmit asking to
  // share must not be silently handed back the stale, unshared row.
  it('treats a same-key resubmit with different content as a genuinely new bundle', async () => {
    const builder = await signupBuilder('bundle-idempotency-edited');
    const key = 'edited-retry-key';

    const first = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify({ ...bundleBody(), shared: false, idempotencyKey: key }),
    }));
    expect(first.response.status).toBe(201);
    expect(first.body.bundle.shared).toBe(false);

    // Same key, but this resubmit answers "yes" to sharing -- must land
    // as a real, separate row with shared: true, not the stale
    // shared: false row handed back as success.
    const edited = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify({ ...bundleBody(), shared: true, idempotencyKey: key }),
    }));
    expect(edited.response.status).toBe(201);
    expect(edited.body.bundle.bundleId).not.toBe(first.body.bundle.bundleId);
    expect(edited.body.bundle.shared).toBe(true);

    const bundleCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM bundles WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(bundleCount.n).toBe(2);

    // The original, unedited content's own key is still honored as a
    // genuine retry.
    const unedited = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify({ ...bundleBody(), shared: false, idempotencyKey: key }),
    }));
    expect(unedited.response.status).toBe(200);
    expect(unedited.body.bundle.bundleId).toBe(first.body.bundle.bundleId);
  });

  it('lists only the session builder\'s own bundles by default, defaulting builderId to the session', async () => {
    const owner = await signupBuilder('bundle-list-owner');
    const other = await signupBuilder('bundle-list-other');
    await api('/bundles', owner.session({ method: 'POST', body: JSON.stringify(bundleBody({ name: 'Owner bundle' })) }));
    await api('/bundles', other.session({ method: 'POST', body: JSON.stringify(bundleBody({ name: 'Other bundle' })) }));

    const ownerList = await api('/bundles', owner.session());
    expect(ownerList.body.bundles.map((b) => b.name)).toEqual(['Owner bundle']);

    const spoofed = await api(`/bundles?builderId=${other.builderId}`, owner.session());
    expect(spoofed.response.status).toBe(403);
  });

  it('lists every shared bundle across builders, unauthenticated, without leaking private ones', async () => {
    const alice = await signupBuilder('bundle-shared-alice');
    const bob = await signupBuilder('bundle-shared-bob');
    await api('/bundles', alice.session({
      method: 'POST', body: JSON.stringify(bundleBody({ name: 'Alice private', shared: false })),
    }));
    const aliceShared = await api('/bundles', alice.session({
      method: 'POST', body: JSON.stringify(bundleBody({ name: 'Alice shared', shared: true })),
    }));
    const bobShared = await api('/bundles', bob.session({
      method: 'POST', body: JSON.stringify(bundleBody({ name: 'Bob shared', shared: true })),
    }));

    // No session attached at all — the community tab is intentionally public.
    const shared = await api('/bundles?shared=true');
    expect(shared.response.status).toBe(200);
    const sharedIds = shared.body.bundles.map((b) => b.bundleId);
    expect(sharedIds).toContain(aliceShared.body.bundle.bundleId);
    expect(sharedIds).toContain(bobShared.body.bundle.bundleId);
    expect(shared.body.bundles.every((b) => b.shared === true)).toBe(true);

    // Alice's own private bundle still shows in her private list, alongside
    // the shared one — sharing doesn't move a bundle out of "my bundles".
    const aliceOwn = await api('/bundles', alice.session());
    expect(aliceOwn.body.bundles.map((b) => b.name).sort()).toEqual(['Alice private', 'Alice shared']);
  });

  // #751: GET /api/bundles used to be a bare, unpaginated LIMIT 100 with no
  // cursor and no nextCursor in the response — anything past the cap was
  // silently invisible with zero indication anything was cut off. Both the
  // "mine" and "shared" branches now cursor-paginate the same way
  // GET /api/notifications already does (see that endpoint's own test,
  // worker/profiles.test.js) — this covers both branches.
  it('cursor-paginates both the "mine" and "shared" bundle listings', async () => {
    const owner = await signupBuilder('bundle-page-owner');
    for (const name of ['First', 'Second', 'Third']) {
      await api('/bundles', owner.session({
        method: 'POST', body: JSON.stringify(bundleBody({ name, shared: true })),
      }));
    }

    const wholeOwn = await api('/bundles', owner.session());
    expect(wholeOwn.body.bundles).toHaveLength(3);
    expect(wholeOwn.body.nextCursor).toBeNull(); // under the default limit — nothing more to page to

    const seenOwnIds = [];
    let ownCursor = null;
    for (let i = 0; i < wholeOwn.body.bundles.length; i++) {
      const page = await api(
        `/bundles?limit=1${ownCursor ? `&cursor=${encodeURIComponent(ownCursor)}` : ''}`,
        owner.session(),
      );
      expect(page.body.bundles).toHaveLength(1);
      seenOwnIds.push(page.body.bundles[0].bundleId);
      ownCursor = page.body.nextCursor;
    }
    expect(ownCursor).toBeNull(); // exhausted after exactly as many pages as there are rows
    expect(seenOwnIds).toEqual(wholeOwn.body.bundles.map((b) => b.bundleId)); // same order, one row at a time

    const wholeShared = await api('/bundles?shared=true');
    expect(wholeShared.body.bundles.length).toBeGreaterThanOrEqual(3);
    const seenSharedIds = [];
    let sharedCursor = null;
    for (let i = 0; i < wholeShared.body.bundles.length; i++) {
      const page = await api(
        `/bundles?shared=true&limit=1${sharedCursor ? `&cursor=${encodeURIComponent(sharedCursor)}` : ''}`,
      );
      expect(page.body.bundles).toHaveLength(1);
      seenSharedIds.push(page.body.bundles[0].bundleId);
      sharedCursor = page.body.nextCursor;
    }
    expect(sharedCursor).toBeNull();
    expect(seenSharedIds).toEqual(wholeShared.body.bundles.map((b) => b.bundleId));

    const invalidCursor = await api('/bundles?cursor=not-base64', owner.session());
    expect(invalidCursor.response.status).toBe(400);
    expect(invalidCursor.body).toEqual({ error: 'cursor is invalid' });
  });

  it('updates name and shared independently on PATCH, and rejects another builder\'s bundle', async () => {
    const owner = await signupBuilder('bundle-patch-owner');
    const other = await signupBuilder('bundle-patch-other');
    const created = await api('/bundles', owner.session({ method: 'POST', body: JSON.stringify(bundleBody()) }));
    const bundleId = created.body.bundle.bundleId;

    const renamed = await api(`/bundles/${bundleId}`, owner.session({
      method: 'PATCH', body: JSON.stringify({ name: 'Renamed set' }),
    }));
    expect(renamed.response.status).toBe(200);
    expect(renamed.body.bundle).toMatchObject({ name: 'Renamed set', shared: false });

    const shared = await api(`/bundles/${bundleId}`, owner.session({
      method: 'PATCH', body: JSON.stringify({ shared: true }),
    }));
    expect(shared.response.status).toBe(200);
    // Renaming didn't get clobbered by a share-only PATCH, and vice versa.
    expect(shared.body.bundle).toMatchObject({ name: 'Renamed set', shared: true });

    const spoofed = await api(`/bundles/${bundleId}`, other.session({
      method: 'PATCH', body: JSON.stringify({ name: 'Hijacked' }),
    }));
    expect(spoofed.response.status).toBe(403);

    const missing = await api('/bundles/bundle-does-not-exist', owner.session({
      method: 'PATCH', body: JSON.stringify({ name: 'Whatever' }),
    }));
    expect(missing.response.status).toBe(404);
  });

  // #468: unlike the sequential test above, this fires a rename and a
  // share-toggle PATCH genuinely concurrently (Promise.all) — the actual
  // shape of the race, since the old code merged the omitted field in
  // from a snapshot read at the top of each request, so whichever request
  // resolved that read *last* still overwrote the other's just-written
  // field with a stale value once its own UPDATE landed. Both edits must
  // survive regardless of which request's DB read/write happens to
  // interleave first.
  it('does not let a concurrent rename and share-toggle clobber each other', async () => {
    const owner = await signupBuilder('bundle-patch-race-owner');
    const created = await api('/bundles', owner.session({ method: 'POST', body: JSON.stringify(bundleBody()) }));
    const bundleId = created.body.bundle.bundleId;

    const [renamed, shared] = await Promise.all([
      api(`/bundles/${bundleId}`, owner.session({
        method: 'PATCH', body: JSON.stringify({ name: 'Raced rename' }),
      })),
      api(`/bundles/${bundleId}`, owner.session({
        method: 'PATCH', body: JSON.stringify({ shared: true }),
      })),
    ]);
    expect(renamed.response.status).toBe(200);
    expect(shared.response.status).toBe(200);

    const list = await api('/bundles', owner.session());
    const final = list.body.bundles.find((b) => b.bundleId === bundleId);
    expect(final).toMatchObject({ name: 'Raced rename', shared: true });
  });

  // #2426: #310/#315 only guarded the UPDATE itself (via meta.changes) against
  // a concurrent DELETE landing between the initial existence check and the
  // UPDATE -- it never covered the second gap, between that UPDATE committing
  // and the follow-up re-SELECT used to build the response. A DELETE landing
  // in *that* gap used to feed undefined into bundleFromRow(), throwing an
  // uncaught 500 instead of a clean 404 -- same bug class as #2334/#2354/#2364.
  it('does not crash with a raw 500 if a concurrent delete removes the bundle between the update and its re-SELECT', async () => {
    const owner = await signupBuilder('bundle-patch-delete-race-owner');
    const created = await api('/bundles', owner.session({ method: 'POST', body: JSON.stringify(bundleBody()) }));
    const bundleId = created.body.bundle.bundleId;

    const [renamed, deleted] = await Promise.all([
      api(`/bundles/${bundleId}`, owner.session({
        method: 'PATCH', body: JSON.stringify({ name: 'Raced away' }),
      })),
      api(`/bundles/${bundleId}`, owner.session({ method: 'DELETE' })),
    ]);
    // The real regression this guards against is a 500 -- either the PATCH's
    // re-SELECT won the race (200) or the DELETE did (404), depending on
    // interleaving, and both are legitimate outcomes.
    expect([200, 404]).toContain(renamed.response.status);
    expect(deleted.response.status).toBe(200);

    const list = await api('/bundles', owner.session());
    expect(list.body.bundles.find((b) => b.bundleId === bundleId)).toBeUndefined();
  });

  it('deletes a bundle only for its owner, and 404s a nonexistent one', async () => {
    const owner = await signupBuilder('bundle-delete-owner');
    const other = await signupBuilder('bundle-delete-other');
    const created = await api('/bundles', owner.session({ method: 'POST', body: JSON.stringify(bundleBody()) }));
    const bundleId = created.body.bundle.bundleId;

    const spoofed = await api(`/bundles/${bundleId}`, other.session({ method: 'DELETE' }));
    expect(spoofed.response.status).toBe(403);

    const deleted = await api(`/bundles/${bundleId}`, owner.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });
    expect((await api(`/bundles/${bundleId}`, owner.session({ method: 'DELETE' }))).response.status).toBe(404);
  });

  // #1441: both GET /api/bundles branches (the "my bundles" builder_id
  // filter and the shared=true community tab) sort by
  // `created_at DESC, bundle_id DESC`, but neither of this table's old
  // indexes covered that sort — same "schema-only change, check the index
  // exists" shape as #1004's auctions/auction_bids test above. The old
  // indexes are dropped in the same migration (now a strict leftmost-prefix
  // subset of the composite ones), so this also confirms that drop didn't
  // silently no-op.
  it('indexes bundles on both the builder_id filter and the shared partial filter, covering the sort', async () => {
    const indexes = (await env.DB.prepare('PRAGMA index_list(bundles)').all()).results;
    expect(indexes.some((idx) => idx.name === 'idx_bundles_builder_created')).toBe(true);
    expect(indexes.some((idx) => idx.name === 'idx_bundles_shared_created')).toBe(true);
    expect(indexes.some((idx) => idx.name === 'idx_bundles_builder_id')).toBe(false);
    expect(indexes.some((idx) => idx.name === 'idx_bundles_shared')).toBe(false);
  });
});

describe('Prohibited categories and digital goods', () => {
  it('rejects a listing whose name matches a prohibited phrase', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'prohibited-name-listing',
        name: 'Realistic Handgun Replica',
        color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/prohibited-categories policy/);
  });

  it('rejects a listing whose category or subcategory matches a prohibited phrase', async () => {
    const byCategory = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'prohibited-category-listing',
        name: 'Ordinary Sounding Item',
        category: 'illegal drug paraphernalia',
        color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(byCategory.response.status).toBe(400);

    const bySubcategory = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'prohibited-subcategory-listing',
        name: 'Ordinary Sounding Item Two',
        subcategory: 'counterfeit goods',
        color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(bySubcategory.response.status).toBe(400);
  });

  it('does not false-positive on ordinary placeholder/furniture names', async () => {
    const allowed = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'ordinary-oak-chair',
        name: 'Oak Chair',
        category: 'furniture',
        subcategory: 'seating',
        color: '#8b5a2b',
        dimensions: { width: 0.5, depth: 0.5, height: 0.9 },
      }),
    });
    expect(allowed.response.status).toBe(201);
  });

  it('also rejects a prohibited rename via PATCH and a prohibited entry via batch create', async () => {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'renamed-to-prohibited',
        name: 'Plain Table',
        color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(created.response.status).toBe(201);
    const renamed = await api('/catalog/renamed-to-prohibited', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Illegal Drug Table' }),
    });
    expect(renamed.response.status).toBe(400);

    const batch = await api('/catalog/batch', {
      method: 'POST',
      body: JSON.stringify({
        templates: [{
          templateId: 'batch-prohibited-listing',
          name: 'Ammunition Box',
          color: '#111111',
          dimensions: { width: 1, depth: 1, height: 1 },
        }],
      }),
    });
    expect(batch.response.status).toBe(400);
  });

  async function uploadTestModel() {
    const form = new FormData();
    form.set('file', glbFile());
    const response = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form });
    return (await response.json()).modelUrl;
  }

  it('rejects an invalid digitalGoodDisclaimer key and accepts a valid one', async () => {
    const invalid = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'digital-good-invalid',
        name: 'Mystery Download',
        color: '#111111',
        dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
        metadata: { digitalGoodDisclaimer: 'seller-made-up-wording' },
      }),
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.error).toMatch(/digitalGoodDisclaimer must be one of/);

    const modelUrl = await uploadTestModel();
    const valid = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'digital-good-valid',
        name: 'Downloadable Gift Card',
        color: '#111111',
        dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
        modelUrl,
        metadata: { digitalGoodDisclaimer: 'gift-card' },
      }),
    });
    expect(valid.response.status).toBe(201);
    expect(valid.body.template.metadata.digitalGoodDisclaimer).toBe('gift-card');

    const fetched = await api('/catalog/digital-good-valid');
    expect(fetched.body.template.metadata.digitalGoodDisclaimer).toBe('gift-card');
  });

  // Found via backlog audit: docs/SPEC.md §4's digital-goods exception is
  // conditional on *both* (a) a representative 3D model and (b) a clear
  // disclaimer — modelUrl is optional for an ordinary template (a plain
  // colored box is a normal fallback look), so without this guard a
  // disclaimer alone was silently sufficient, satisfying only condition (b).
  it('rejects a digital-good listing with no representative 3D model', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'digital-good-no-model',
        name: 'Modelless Download',
        color: '#111111',
        dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
        metadata: { digitalGoodDisclaimer: 'art-file' },
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/must include modelUrl/);

    // Also enforced on update — flagging an existing modelUrl-less listing
    // as a digital good after the fact shouldn't be possible either.
    const plainListing = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'digital-good-retrofit',
        name: 'Plain Product',
        color: '#111111',
        dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
      }),
    });
    expect(plainListing.response.status).toBe(201);
    const retrofitted = await api('/catalog/digital-good-retrofit', {
      method: 'PATCH',
      body: JSON.stringify({ metadata: { digitalGoodDisclaimer: 'art-file' } }),
    });
    expect(retrofitted.response.status).toBe(400);
  });

  // #1569: sellerId went through with no type check at all, so a non-string
  // value (an object/array) reached assertReferenceExists'/
  // assertReferencesExist's raw D1 bind and crashed with an unhandled 500
  // instead of a clean, validation-shaped 400 -- unlike every other field in
  // validateTemplate, which is strictly type-checked before use.
  it('rejects a non-string sellerId with a clean 400 rather than crashing, on both single and batch create', async () => {
    const singleObject = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'sellerid-object-single',
        name: 'Bad SellerId Object',
        color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 },
        sellerId: { foo: 1 },
      }),
    });
    expect(singleObject.response.status).toBe(400);
    expect(singleObject.body.error).toMatch(/sellerId/);

    const singleArray = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'sellerid-array-single',
        name: 'Bad SellerId Array',
        color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 },
        sellerId: [1, 2, 3],
      }),
    });
    expect(singleArray.response.status).toBe(400);
    expect(singleArray.body.error).toMatch(/sellerId/);

    const batch = await api('/catalog/batch', {
      method: 'POST',
      body: JSON.stringify({
        templates: [{
          templateId: 'sellerid-object-batch',
          name: 'Bad SellerId Batch',
          color: '#111111',
          dimensions: { width: 1, depth: 1, height: 1 },
          sellerId: { foo: 1 },
        }],
      }),
    });
    expect(batch.response.status).toBe(400);
    expect(batch.body.error).toMatch(/sellerId/);
  });

  it('lets a digital-good flag be cleared by omitting it from a metadata replace', async () => {
    const modelUrl = await uploadTestModel();
    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'digital-good-to-clear',
        name: 'Temporary Digital Good',
        color: '#111111',
        dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
        modelUrl,
        metadata: { digitalGoodDisclaimer: 'art-file' },
      }),
    });
    const cleared = await api('/catalog/digital-good-to-clear', {
      method: 'PATCH',
      body: JSON.stringify({ metadata: {} }),
    });
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.template.metadata.digitalGoodDisclaimer).toBeUndefined();
  });
});

describe('Shipping', () => {
  it('rejects a non-boolean metadata.domesticOnly', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'shipping-bad-domestic-only-template',
        name: 'Bad domestic-only product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        metadata: { domesticOnly: 'yes' },
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/domesticOnly must be a boolean/);
  });

  it('accepts a valid metadata.domesticOnly and round-trips it through GET', async () => {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'shipping-domestic-only-template',
        name: 'US-only product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        metadata: { domesticOnly: true },
      }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.template.metadata.domesticOnly).toBe(true);

    const fetched = await api('/catalog/shipping-domestic-only-template');
    expect(fetched.body.template.metadata.domesticOnly).toBe(true);
  });

  it('defaults to shipping internationally when metadata.domesticOnly is absent', async () => {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'shipping-default-template',
        name: 'Default-shipping product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.template.metadata.domesticOnly).toBeUndefined();
  });

  it('lets a domestic-only flag be cleared by omitting it from a metadata replace', async () => {
    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'shipping-domestic-only-to-clear',
        name: 'Temporary US-only product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        metadata: { domesticOnly: true },
      }),
    });
    const cleared = await api('/catalog/shipping-domestic-only-to-clear', {
      method: 'PATCH',
      body: JSON.stringify({ metadata: {} }),
    });
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.template.metadata.domesticOnly).toBeUndefined();
  });
});

// #2476 (sub-issue of #2475's "[Tracking] Furniture interaction-target
// system"): docs/SPEC.md §2's "sit, lean, stand" idle state machine --
// this covers only the data model (metadata.sitTarget/leanTarget), not the
// targeting/pose logic itself (later sub-issues).
describe('Sit/lean interaction targets', () => {
  function templateBody(overrides = {}) {
    return {
      name: 'Sit/lean test product',
      color: '#123456',
      dimensions: { width: 2, depth: 1, height: 0.8 },
      ...overrides,
    };
  }

  it('rejects a non-object metadata.sitTarget', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'sit-lean-bad-object-template',
        ...templateBody({ metadata: { sitTarget: 'yes' } }),
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/sitTarget must be an object/);
  });

  it('rejects an offsetXM outside the template\'s own footprint', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'sit-lean-bad-offset-template',
        ...templateBody({
          metadata: { sitTarget: { offsetXM: 5, offsetYM: 0, heightM: 0.4, facingRad: 0 } },
        }),
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/sitTarget\.offsetXM must be a number within \+\/- half/);
  });

  it('rejects a heightM outside the template\'s own height range', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'sit-lean-bad-height-template',
        ...templateBody({
          metadata: { leanTarget: { offsetXM: 0, offsetYM: 0, heightM: 5, facingRad: 0 } },
        }),
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/leanTarget\.heightM must be a number between 0 and/);
  });

  it('rejects a non-finite facingRad', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'sit-lean-bad-facing-template',
        ...templateBody({
          metadata: { sitTarget: { offsetXM: 0, offsetYM: 0, heightM: 0.4, facingRad: 'north' } },
        }),
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/sitTarget\.facingRad must be a finite number/);
  });

  it('accepts valid sitTarget and leanTarget values and round-trips them through GET, independently', async () => {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'sit-lean-valid-template',
        ...templateBody({
          metadata: {
            sitTarget: { offsetXM: 0, offsetYM: -0.3, heightM: 0.45, facingRad: 3.14 },
            leanTarget: { offsetXM: 0.9, offsetYM: 0, heightM: 0.8, facingRad: -1.57 },
          },
        }),
      }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.template.metadata.sitTarget).toEqual({ offsetXM: 0, offsetYM: -0.3, heightM: 0.45, facingRad: 3.14 });
    expect(created.body.template.metadata.leanTarget).toEqual({ offsetXM: 0.9, offsetYM: 0, heightM: 0.8, facingRad: -1.57 });

    const fetched = await api('/catalog/sit-lean-valid-template');
    expect(fetched.body.template.metadata.sitTarget.heightM).toBe(0.45);
    expect(fetched.body.template.metadata.leanTarget.offsetXM).toBe(0.9);
  });

  it('defaults to neither sittable nor leanable when both are absent', async () => {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({ templateId: 'sit-lean-default-template', ...templateBody() }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.template.metadata.sitTarget).toBeUndefined();
    expect(created.body.template.metadata.leanTarget).toBeUndefined();
  });

  it('lets a sitTarget be cleared by omitting it from a metadata replace, without touching leanTarget', async () => {
    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'sit-lean-clear-template',
        ...templateBody({
          metadata: {
            sitTarget: { offsetXM: 0, offsetYM: 0, heightM: 0.4, facingRad: 0 },
            leanTarget: { offsetXM: 0.9, offsetYM: 0, heightM: 0.8, facingRad: 0 },
          },
        }),
      }),
    });
    const cleared = await api('/catalog/sit-lean-clear-template', {
      method: 'PATCH',
      body: JSON.stringify({
        metadata: { leanTarget: { offsetXM: 0.9, offsetYM: 0, heightM: 0.8, facingRad: 0 } },
      }),
    });
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.template.metadata.sitTarget).toBeUndefined();
    expect(cleared.body.template.metadata.leanTarget).toEqual({ offsetXM: 0.9, offsetYM: 0, heightM: 0.8, facingRad: 0 });
  });
});

// #327 ("build the 3D Model > Flat image creation pathway") — a minimal,
// real 1x1 transparent PNG, same idiom as glbFile's synthetic-but-valid
// binary fixture, so these tests exercise the real base64-decode/R2-put
// path rather than mocking it away.
const ONE_PIXEL_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Product-image thumbnail (#327)', () => {
  async function createOwnedTemplate(templateId, seller) {
    return api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId,
        name: 'Thumbnail test product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        sellerId: seller.sellerId,
        priceCents: 500,
      }),
    }));
  }

  it('requires a session, and requires it to be the owning seller', async () => {
    const owner = await signupSeller('thumbnail-owner');
    const stranger = await signupSeller('thumbnail-stranger');
    const created = await createOwnedTemplate('thumbnail-auth-template', owner);
    expect(created.response.status).toBe(201);

    const noSession = await api('/catalog/thumbnail-auth-template/thumbnail', {
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    });
    expect(noSession.response.status).toBe(401);

    const wrongSeller = await api('/catalog/thumbnail-auth-template/thumbnail', stranger.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    }));
    expect(wrongSeller.response.status).toBe(403);
  });

  it('rejects a thumbnail for a template with no owning seller', async () => {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'thumbnail-unowned-template',
        name: 'Unowned thumbnail test product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(created.response.status).toBe(201);

    const owner = await signupSeller('thumbnail-unowned-attempt-seller');
    const rejected = await api('/catalog/thumbnail-unowned-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    }));
    expect(rejected.response.status).toBe(403);
    expect(rejected.body.error).toMatch(/no owning seller/);
  });

  it('returns 404 for a nonexistent template', async () => {
    const owner = await signupSeller('thumbnail-404-seller');
    const missing = await api('/catalog/thumbnail-does-not-exist/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    }));
    expect(missing.response.status).toBe(404);
  });

  it('rejects a malformed or oversized imageDataUrl', async () => {
    const owner = await signupSeller('thumbnail-validation-seller');
    await createOwnedTemplate('thumbnail-validation-template', owner);

    const notADataUrl = await api('/catalog/thumbnail-validation-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: 'https://example.com/cat.png' }),
    }));
    expect(notADataUrl.response.status).toBe(400);
    expect(notADataUrl.body.error).toMatch(/data URL/);

    const notBase64 = await api('/catalog/thumbnail-validation-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: 'data:image/png;base64,not-valid-base64!!!' }),
    }));
    expect(notBase64.response.status).toBe(400);

    // ~440KB of base64, comfortably over the 300KB decoded-byte cap.
    const huge = 'data:image/png;base64,' + 'A'.repeat(600000);
    const tooBig = await api('/catalog/thumbnail-validation-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: huge }),
    }));
    expect(tooBig.response.status).toBe(413);

    // #823: well-formed base64 under the size cap, but not actually a PNG
    // (wrong magic bytes) — must be rejected before ever reaching R2.
    const notActuallyPng = await api('/catalog/thumbnail-validation-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: `data:image/png;base64,${btoa('not a real png file')}` }),
    }));
    expect(notActuallyPng.response.status).toBe(400);
    expect(notActuallyPng.body.error).toMatch(/not a valid PNG/);
  });

  it('rejects a malformed embedding', async () => {
    const owner = await signupSeller('thumbnail-embedding-validation-seller');
    await createOwnedTemplate('thumbnail-embedding-validation-template', owner);

    const notAnArray = await api('/catalog/thumbnail-embedding-validation-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL, embedding: 'not-an-array' }),
    }));
    expect(notAnArray.response.status).toBe(400);

    const nonNumeric = await api('/catalog/thumbnail-embedding-validation-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL, embedding: [0.1, 'x', 0.3] }),
    }));
    expect(nonNumeric.response.status).toBe(400);
  });

  it('stores the image and embedding, and serves the image back from /uploads/', async () => {
    const owner = await signupSeller('thumbnail-success-seller');
    await createOwnedTemplate('thumbnail-success-template', owner);
    const embedding = [0.1, 0.2, 0.3, 0.4];

    const uploaded = await api('/catalog/thumbnail-success-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL, embedding }),
    }));
    expect(uploaded.response.status).toBe(200);
    expect(uploaded.body.imageUrl).toMatch(/^\/uploads\/thumbnails\/.+\.png$/);

    const fetched = await api('/catalog/thumbnail-success-template');
    expect(fetched.body.template.imageUrl).toBe(uploaded.body.imageUrl);
    expect(fetched.body.template.imageEmbedding).toEqual(embedding);

    const served = await SELF.fetch(`https://higglehaven.test${uploaded.body.imageUrl}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
  });

  it('does not persist an embedding when none is sent', async () => {
    const owner = await signupSeller('thumbnail-no-embedding-seller');
    await createOwnedTemplate('thumbnail-no-embedding-template', owner);

    const uploaded = await api('/catalog/thumbnail-no-embedding-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    }));
    expect(uploaded.response.status).toBe(200);

    const fetched = await api('/catalog/thumbnail-no-embedding-template');
    expect(fetched.body.template.imageEmbedding).toBeNull();
  });

  it('deduplicates identical thumbnail bytes under the same content-addressed key', async () => {
    const owner = await signupSeller('thumbnail-dedup-seller');
    await createOwnedTemplate('thumbnail-dedup-template-a', owner);
    await createOwnedTemplate('thumbnail-dedup-template-b', owner);

    const first = await api('/catalog/thumbnail-dedup-template-a/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    }));
    const second = await api('/catalog/thumbnail-dedup-template-b/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    }));
    expect(first.body.imageUrl).toBe(second.body.imageUrl);
  });

  // #775: this endpoint had no rate limit at all — a seller session could
  // loop it indefinitely, each call hashing to a distinct R2 key (unlike
  // the dedup test above) since the whole point here is real-looking
  // rendered output, not identical bytes.
  it('rate-limits thumbnail uploads per seller', async () => {
    const owner = await signupSeller('thumbnail-rate-limit-seller');
    await createOwnedTemplate('thumbnail-rate-limit-template', owner);

    for (let i = 0; i < 20; i++) {
      const response = await api('/catalog/thumbnail-rate-limit-template/thumbnail', owner.session({
        method: 'POST',
        body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
      }));
      expect(response.response.status).toBe(200);
    }
    const limited = await api('/catalog/thumbnail-rate-limit-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    }));
    expect(limited.response.status).toBe(429);
  });

  // #775: this endpoint wrote straight to R2 with no reservation against
  // MAX_TOTAL_STORAGE_BYTES — same race/cap-overrun exposure the
  // model-upload and concept-image paths already guard against (see
  // worker-api.test.js's own "accepts only one of two concurrent uploads"
  // test for the sibling case on the model-upload path).
  it('enforces the shared storage cap on thumbnail uploads', async () => {
    const owner = await signupSeller('thumbnail-storage-cap-seller');
    await createOwnedTemplate('thumbnail-storage-cap-template', owner);

    const storage = await api('/models/storage', adminSession());
    const usedBytes = storage.body.usedBytes;
    const capBytes = 8 * 1024 * 1024 * 1024;
    // Seed a fake in-flight reservation so effectively no headroom remains.
    await env.DB.prepare(`
      INSERT INTO model_upload_reservations (reservation_id, size_bytes, created_at) VALUES (?, ?, ?)
    `).bind(`test-reservation-${crypto.randomUUID()}`, capBytes - usedBytes, Date.now()).run();

    // Unique bytes, so this doesn't dedup against an object some other
    // test already put at this content-addressed key — a dedup hit would
    // skip the reservation check entirely (see the "if (!(await
    // models.head(key)))" guard in the handler) and this test would pass
    // for the wrong reason.
    const uniqueImageDataUrl = `data:image/png;base64,${btoa(`\x89PNG\r\n\x1a\nthumbnail-cap-test-${crypto.randomUUID()}`)}`;
    const rejected = await api('/catalog/thumbnail-storage-cap-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: uniqueImageDataUrl }),
    }));
    expect(rejected.response.status).toBe(507);

    // The rejected attempt's own reservation must not linger — only the
    // fake row seeded above should remain.
    const remaining = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM model_upload_reservations WHERE size_bytes = ?
    `).bind(capBytes - usedBytes).first();
    expect(remaining.count).toBe(1);

    await env.DB.prepare('DELETE FROM model_upload_reservations').run();
  });
});

// #329 (backend half only — see docs/API.md for the frontend-scope note).
describe('Embedding similarity search (#329)', () => {
  async function createTemplateWithEmbedding(templateId, embedding) {
    const seller = await signupSeller(`similarity-owner-${templateId}`);
    await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId,
        name: `Similarity test product ${templateId}`,
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        sellerId: seller.sellerId,
        priceCents: 500,
      }),
    }));
    if (embedding !== undefined) {
      await api(`/catalog/${templateId}/thumbnail`, seller.session({
        method: 'POST',
        body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL, embedding }),
      }));
    }
    return seller;
  }

  it('rejects a missing or malformed embedding', async () => {
    const missing = await api('/catalog/similarity-search', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(missing.response.status).toBe(400);

    const malformed = await api('/catalog/similarity-search', {
      method: 'POST',
      body: JSON.stringify({ embedding: 'not-an-array' }),
    });
    expect(malformed.response.status).toBe(400);
  });

  it('rejects an out-of-range limit', async () => {
    const tooMany = await api('/catalog/similarity-search', {
      method: 'POST',
      body: JSON.stringify({ embedding: [1, 0, 0], limit: 51 }),
    });
    expect(tooMany.response.status).toBe(400);

    const notAnInteger = await api('/catalog/similarity-search', {
      method: 'POST',
      body: JSON.stringify({ embedding: [1, 0, 0], limit: 1.5 }),
    });
    expect(notAnInteger.response.status).toBe(400);
  });

  it('ranks exact and close matches above a dissimilar one, and excludes templates with no embedding', async () => {
    await createTemplateWithEmbedding('similarity-exact-match', [1, 0, 0]);
    await createTemplateWithEmbedding('similarity-close-match', [0.9, 0.1, 0]);
    await createTemplateWithEmbedding('similarity-opposite', [-1, 0, 0]);
    await createTemplateWithEmbedding('similarity-no-embedding', undefined);

    const searched = await api('/catalog/similarity-search', {
      method: 'POST',
      body: JSON.stringify({ embedding: [1, 0, 0], limit: 10 }),
    });
    expect(searched.response.status).toBe(200);
    const ids = searched.body.templates.map((t) => t.templateId);
    expect(ids).not.toContain('similarity-no-embedding');
    expect(ids.indexOf('similarity-exact-match')).toBeLessThan(ids.indexOf('similarity-close-match'));
    expect(ids.indexOf('similarity-close-match')).toBeLessThan(ids.indexOf('similarity-opposite'));
    const exactMatch = searched.body.templates.find((t) => t.templateId === 'similarity-exact-match');
    expect(exactMatch.similarity).toBeCloseTo(1, 5);
  });

  it('excludes a stored embedding whose length no longer matches the query embedding', async () => {
    await createTemplateWithEmbedding('similarity-wrong-length', [1, 0, 0, 0]);
    const searched = await api('/catalog/similarity-search', {
      method: 'POST',
      body: JSON.stringify({ embedding: [1, 0, 0] }),
    });
    expect(searched.response.status).toBe(200);
    expect(searched.body.templates.map((t) => t.templateId)).not.toContain('similarity-wrong-length');
  });

  it('respects the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await createTemplateWithEmbedding(`similarity-limit-${i}`, [1, 0, 0]);
    }
    const searched = await api('/catalog/similarity-search', {
      method: 'POST',
      body: JSON.stringify({ embedding: [1, 0, 0], limit: 3 }),
    });
    expect(searched.body.templates.length).toBe(3);
  });

  // Backlog audit: unauthenticated + a real per-call cost (full scan +
  // cosine-similarity over every embedded template) is exactly the shape
  // every other unauthenticated, non-trivial-cost endpoint in this file
  // is IP-rate-limited for (catalog delete/patch, sign-post, purchase,
  // builder/seller create) — this one wasn't. Same style as the
  // concept-image rate-limit test just below: spend the budget, then
  // assert the next call 429s. All these calls share one IP on purpose
  // (an explicit cf-connecting-ip header) so they land in the same
  // rate-limit bucket — every other call in this describe block gets its
  // own random IP by default (see api()'s own comment in test-helpers.js)
  // specifically so it's unaffected by this test spending its budget.
  it('rate-limits similarity-search by IP', async () => {
    const ip = `similarity-search-rate-limit-${crypto.randomUUID()}`;
    for (let i = 0; i < 30; i++) {
      const attempt = await api('/catalog/similarity-search', {
        method: 'POST',
        headers: { 'cf-connecting-ip': ip },
        body: JSON.stringify({ embedding: [1, 0, 0] }),
      });
      expect(attempt.response.status).toBe(200);
    }
    const limited = await api('/catalog/similarity-search', {
      method: 'POST',
      headers: { 'cf-connecting-ip': ip },
      body: JSON.stringify({ embedding: [1, 0, 0] }),
    });
    expect(limited.response.status).toBe(429);
  });

  // #1244: cosineSimilarity's own length guard, exercised directly since
  // the one live call site above already pre-filters to matching lengths
  // and so can never reach it.
  it('cosineSimilarity throws on mismatched vector lengths', () => {
    expect(() => cosineSimilarity([1, 0, 0], [1, 0])).toThrow('vector length mismatch');
  });
});

// #328: OPENAI_API_KEY is never configured in this test environment (see
// worker/index.js's own comment on openaiConfigured, matching the
// established RESEND_API_KEY/STRIPE_SECRET_KEY testing convention), so a
// real generation call is never attempted here — these tests cover
// everything reachable without one: auth gating, validation, ordering,
// rate limiting, and the 503 path itself.
describe('Prompt-mode concept-image generation (#328)', () => {
  it('requires a session', async () => {
    const rejected = await api('/catalog/concept-image', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'a cozy wooden bench' }),
    });
    expect(rejected.response.status).toBe(401);
  });

  it('rejects a missing or oversized prompt before checking configuration', async () => {
    const builder = await signupBuilder('concept-image-validation-builder');

    const missing = await api('/catalog/concept-image', builder.session({
      method: 'POST',
      body: JSON.stringify({}),
    }));
    expect(missing.response.status).toBe(400);

    const oversized = await api('/catalog/concept-image', builder.session({
      method: 'POST',
      body: JSON.stringify({ prompt: 'x'.repeat(2001) }),
    }));
    expect(oversized.response.status).toBe(400);
  });

  it('returns 503 once past validation, since OPENAI_API_KEY is never configured in tests', async () => {
    const builder = await signupBuilder('concept-image-503-builder');
    const rejected = await api('/catalog/concept-image', builder.session({
      method: 'POST',
      body: JSON.stringify({ prompt: 'a cozy wooden bench' }),
    }));
    expect(rejected.response.status).toBe(503);
  });

  it('rate-limits repeated requests from the same builder', async () => {
    const builder = await signupBuilder('concept-image-rate-limit-builder');
    for (let i = 0; i < 10; i++) {
      const attempt = await api('/catalog/concept-image', builder.session({
        method: 'POST',
        body: JSON.stringify({ prompt: `attempt ${i}` }),
      }));
      // Every attempt still 503s (no key configured) rather than 429 —
      // this loop is only spending the rate-limit budget, not asserting
      // success.
      expect(attempt.response.status).toBe(503);
    }
    const limited = await api('/catalog/concept-image', builder.session({
      method: 'POST',
      body: JSON.stringify({ prompt: 'one more' }),
    }));
    expect(limited.response.status).toBe(429);
  });
});

// #1946: is_test_model has no ordinary self-service write path (same
// "not folded into the generic create/update merge" treatment as
// users.is_admin) -- these tests flip it directly via SQL, mirroring the
// migration's own backfill, since there's no API call that can set it.
describe('Test-model designation (#1946)', () => {
  async function createTemplate(templateId, overrides = {}) {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId,
        name: `Test-model fixture ${templateId}`,
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents: 500,
        ...overrides,
      }),
    });
    expect(created.response.status).toBe(201);
    return created.body.template;
  }

  async function markAsTestModel(templateId) {
    await env.DB.prepare('UPDATE catalog_templates SET is_test_model = 1 WHERE template_id = ?').bind(templateId).run();
  }

  it('defaults a newly created template to isTestModel: false, not settable via POST', async () => {
    const template = await createTemplate('test-model-create-ignores-flag', { isTestModel: true });
    expect(template.isTestModel).toBe(false);
  });

  it('is not settable via PATCH either', async () => {
    await createTemplate('test-model-patch-ignores-flag');
    const patched = await api('/catalog/test-model-patch-ignores-flag', {
      method: 'PATCH',
      body: JSON.stringify({ isTestModel: true }),
    });
    expect(patched.response.status).toBe(200);
    expect(patched.body.template.isTestModel).toBe(false);
    const row = await env.DB.prepare('SELECT is_test_model FROM catalog_templates WHERE template_id = ?')
      .bind('test-model-patch-ignores-flag').first();
    expect(row.is_test_model).toBe(0);
  });

  // Tried hiding these rows from GET /api/catalog for a non-admin caller
  // in an earlier version of this change -- reverted after CI caught it
  // breaking ordinary (non-admin) Build mode's own "Add Item" picker,
  // which fetches this exact same endpoint with no separate code path:
  // every pre-existing template (including core, non-commerce feature
  // fixtures like community-sign/calendar-event/flooring templates) got
  // backfilled to isTestModel, so every ordinary builder lost Build-mode
  // access to them. These tests lock in the corrected, non-filtering
  // behavior so it doesn't regress back.
  it('does not exclude a test-model row from GET /api/catalog for any caller', async () => {
    await createTemplate('test-model-list-visibility');
    await markAsTestModel('test-model-list-visibility');

    const anonymous = await api('/catalog?limit=100');
    expect(anonymous.response.status).toBe(200);
    expect(anonymous.body.templates.map((t) => t.templateId)).toContain('test-model-list-visibility');

    const builder = await signupBuilder('test-model-list-visibility-builder');
    const nonAdmin = await api('/catalog?limit=100', builder.session());
    expect(nonAdmin.response.status).toBe(200);
    const nonAdminHit = nonAdmin.body.templates.find((t) => t.templateId === 'test-model-list-visibility');
    expect(nonAdminHit).toBeTruthy();
    expect(nonAdminHit.isTestModel).toBe(true);
  });

  it('does not 404 GET /api/catalog/:templateId for a test-model row for any caller', async () => {
    await createTemplate('test-model-single-fetch-visibility');
    await markAsTestModel('test-model-single-fetch-visibility');

    const anonymous = await api('/catalog/test-model-single-fetch-visibility');
    expect(anonymous.response.status).toBe(200);
    expect(anonymous.body.template.isTestModel).toBe(true);
  });

  it('rejects purchasing an instance backed by a test-model template', async () => {
    const builder = await signupBuilder('test-model-purchase-builder');
    await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId: 'test-model-purchase-landlet', name: 'Test-model purchase landlet', areaM2: 1000, status: 'greenbelt' }),
    }));
    await api('/landlets/test-model-purchase-landlet/claim', builder.session({ method: 'POST' }));
    await createTemplate('test-model-purchase-template');
    await markAsTestModel('test-model-purchase-template');
    const placed = await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'test-model-purchase-instance', landletId: 'test-model-purchase-landlet', templateId: 'test-model-purchase-template', x: 0, y: 0 }),
    }));
    expect(placed.response.status).toBe(201);

    const purchased = await api('/instances/test-model-purchase-instance/purchase', builder.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(400);
    expect(purchased.body.error).toMatch(/test\/demo product/);
  });
});

describe('Finite stock tracking (#1948)', () => {
  async function createTemplateWithStock(templateId, overrides = {}) {
    return api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId,
        name: `Finite-stock fixture ${templateId}`,
        color: '#654321',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents: 500,
        ...overrides,
      }),
    });
  }

  async function createLandletAndClaim(landletId, builder) {
    await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2: 1000, status: 'greenbelt' }),
    }));
    await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  }

  async function placeInstance(instanceId, landletId, templateId, builder) {
    const placed = await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId, landletId, templateId, x: 0, y: 0 }),
    }));
    expect(placed.response.status).toBe(201);
    return instanceId;
  }

  it('defaults to unlimited (null) and is a freely settable field via POST/PATCH, unlike isTestModel', async () => {
    const defaultTemplate = await createTemplateWithStock('stock-default-template');
    expect(defaultTemplate.response.status).toBe(201);
    expect(defaultTemplate.body.template.stockQuantity).toBe(null);

    const created = await createTemplateWithStock('stock-create-template', { stockQuantity: 5 });
    expect(created.response.status).toBe(201);
    expect(created.body.template.stockQuantity).toBe(5);

    const patched = await api('/catalog/stock-create-template', {
      method: 'PATCH',
      body: JSON.stringify({ stockQuantity: 10 }),
    });
    expect(patched.response.status).toBe(200);
    expect(patched.body.template.stockQuantity).toBe(10);
  });

  it('rejects a negative or over-cap stockQuantity', async () => {
    const negative = await createTemplateWithStock('stock-negative-template', { stockQuantity: -1 });
    expect(negative.response.status).toBe(400);

    const overCap = await createTemplateWithStock('stock-over-cap-template', { stockQuantity: 1_000_001 });
    expect(overCap.response.status).toBe(400);
  });

  it('never touches stock_quantity for the default (unlimited) template', async () => {
    const builder = await signupBuilder('stock-unlimited-builder');
    await createLandletAndClaim('stock-unlimited-landlet', builder);
    await createTemplateWithStock('stock-unlimited-template');
    await placeInstance('stock-unlimited-instance', 'stock-unlimited-landlet', 'stock-unlimited-template', builder);

    const purchased = await api('/instances/stock-unlimited-instance/purchase', builder.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(201);

    const row = await env.DB.prepare('SELECT stock_quantity FROM catalog_templates WHERE template_id = ?')
      .bind('stock-unlimited-template').first();
    expect(row.stock_quantity).toBe(null);
  });

  it('decrements remaining stock by the purchased quantity without exhausting it', async () => {
    const builder = await signupBuilder('stock-decrement-builder');
    await createLandletAndClaim('stock-decrement-landlet', builder);
    await createTemplateWithStock('stock-decrement-template', { stockQuantity: 5 });
    await placeInstance('stock-decrement-instance', 'stock-decrement-landlet', 'stock-decrement-template', builder);

    const purchased = await api('/instances/stock-decrement-instance/purchase', builder.session({
      method: 'POST', body: JSON.stringify({ quantity: 2 }),
    }));
    expect(purchased.response.status).toBe(201);

    const fetched = await api('/catalog/stock-decrement-template');
    expect(fetched.body.template.stockQuantity).toBe(3);

    // Stock isn't exhausted yet -- the instance must still be placed.
    const listed = await api('/instances?landletId=stock-decrement-landlet');
    expect(listed.body.instances.map((i) => i.instanceId)).toContain('stock-decrement-instance');
  });

  it('rejects a purchase once stock_quantity is exactly 0, via the pre-check', async () => {
    const builder = await signupBuilder('stock-exhausted-builder');
    await createLandletAndClaim('stock-exhausted-landlet', builder);
    await createTemplateWithStock('stock-exhausted-template', { stockQuantity: 0 });
    await placeInstance('stock-exhausted-instance', 'stock-exhausted-landlet', 'stock-exhausted-template', builder);

    const purchased = await api('/instances/stock-exhausted-instance/purchase', builder.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(400);
    expect(purchased.body.error).toMatch(/sold out/);
  });

  // The pre-check above only catches an already-zero template -- this
  // exercises the real atomic guard instead, the one that actually matters
  // once two near-simultaneous buyers could otherwise both succeed against
  // the last unit: a request for more than what remains must be rejected
  // without partially decrementing.
  it('atomically rejects an over-quantity purchase without touching remaining stock', async () => {
    const builder = await signupBuilder('stock-overbuy-builder');
    await createLandletAndClaim('stock-overbuy-landlet', builder);
    await createTemplateWithStock('stock-overbuy-template', { stockQuantity: 2 });
    await placeInstance('stock-overbuy-instance', 'stock-overbuy-landlet', 'stock-overbuy-template', builder);

    const purchased = await api('/instances/stock-overbuy-instance/purchase', builder.session({
      method: 'POST', body: JSON.stringify({ quantity: 3 }),
    }));
    expect(purchased.response.status).toBe(400);
    expect(purchased.body.error).toMatch(/sold out/);

    const row = await env.DB.prepare('SELECT stock_quantity FROM catalog_templates WHERE template_id = ?')
      .bind('stock-overbuy-template').first();
    expect(row.stock_quantity).toBe(2);
  });

  it('on hitting exactly zero, removes every placed instance of the template and notifies each landlet owner', async () => {
    const ownerA = await signupBuilder('stock-soldout-owner-a');
    const ownerB = await signupBuilder('stock-soldout-owner-b');
    await createLandletAndClaim('stock-soldout-landlet-a', ownerA);
    await createLandletAndClaim('stock-soldout-landlet-b', ownerB);
    await createTemplateWithStock('stock-soldout-template', { stockQuantity: 1 });
    await placeInstance('stock-soldout-instance-a', 'stock-soldout-landlet-a', 'stock-soldout-template', ownerA);
    await placeInstance('stock-soldout-instance-b', 'stock-soldout-landlet-b', 'stock-soldout-template', ownerB);

    const purchased = await api('/instances/stock-soldout-instance-a/purchase', ownerA.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(201);

    const fetched = await api('/catalog/stock-soldout-template');
    expect(fetched.body.template.stockQuantity).toBe(0);

    const listedA = await api('/instances?landletId=stock-soldout-landlet-a');
    expect(listedA.body.instances).toEqual([]);
    const listedB = await api('/instances?landletId=stock-soldout-landlet-b');
    expect(listedB.body.instances).toEqual([]);

    const noticesA = await api('/notifications', ownerA.session());
    expect(noticesA.body.notifications.some((n) => n.message.includes('just sold out'))).toBe(true);
    const noticesB = await api('/notifications', ownerB.session());
    expect(noticesB.body.notifications.some((n) => n.message.includes('just sold out'))).toBe(true);
  });

  it('allows purchasing again after restocking a sold-out template via PATCH', async () => {
    const builder = await signupBuilder('stock-restock-builder');
    await createLandletAndClaim('stock-restock-landlet', builder);
    await createTemplateWithStock('stock-restock-template', { stockQuantity: 1 });
    await placeInstance('stock-restock-instance-1', 'stock-restock-landlet', 'stock-restock-template', builder);

    const firstPurchase = await api('/instances/stock-restock-instance-1/purchase', builder.session({ method: 'POST' }));
    expect(firstPurchase.response.status).toBe(201);

    const patched = await api('/catalog/stock-restock-template', {
      method: 'PATCH',
      body: JSON.stringify({ stockQuantity: 2 }),
    });
    expect(patched.response.status).toBe(200);
    expect(patched.body.template.stockQuantity).toBe(2);

    // Restocking the template doesn't resurrect what the earlier sweep
    // already removed -- a fresh instance is needed to purchase against.
    await placeInstance('stock-restock-instance-2', 'stock-restock-landlet', 'stock-restock-template', builder);
    const secondPurchase = await api('/instances/stock-restock-instance-2/purchase', builder.session({ method: 'POST' }));
    expect(secondPurchase.response.status).toBe(201);

    const fetched = await api('/catalog/stock-restock-template');
    expect(fetched.body.template.stockQuantity).toBe(1);
  });

  // handlePurchaseFinalize's own real-money path can't be driven over HTTP
  // in this suite (STRIPE_SECRET_KEY is never configured here -- see
  // stripeConfigured's own comment), so this calls writePurchaseRow
  // directly with allowOversell=true, the same way this file's sibling
  // test files already unit-test other exported pieces of the purchase
  // flow (resolveFinalizeBuilderId, refundIdempotencyKey) that are
  // otherwise unreachable through the HTTP surface in this environment.
  it('on the real-money path (allowOversell=true), floors remaining stock at zero instead of rejecting an oversell', async () => {
    const builder = await signupBuilder('stock-oversell-floor-builder');
    await createLandletAndClaim('stock-oversell-floor-landlet', builder);
    await createTemplateWithStock('stock-oversell-floor-template', { stockQuantity: 2 });
    await placeInstance('stock-oversell-floor-instance', 'stock-oversell-floor-landlet', 'stock-oversell-floor-template', builder);

    const instance = await env.DB.prepare('SELECT * FROM placed_instances WHERE instance_id = ?')
      .bind('stock-oversell-floor-instance').first();
    const template = await env.DB.prepare('SELECT * FROM catalog_templates WHERE template_id = ?')
      .bind('stock-oversell-floor-template').first();
    const landlet = await env.DB.prepare('SELECT * FROM landlets WHERE landlet_id = ?')
      .bind('stock-oversell-floor-landlet').first();

    const amounts = {
      quantity: 3, buyerLabel: 'Oversell tester', unitPriceCents: 500, totalCents: 1500,
      commissionCents: 30, builderShareCents: 15, platformShareCents: 15,
    };
    const result = await writePurchaseRow(
      { DB: env.DB }, instance, template, landlet, amounts,
      'test-pi-oversell-floor', false, builder.builderId, false, undefined, false, true,
    );
    expect(result.status).toBe(201);

    const fetched = await api('/catalog/stock-oversell-floor-template');
    expect(fetched.body.template.stockQuantity).toBe(0);

    // Hitting zero still sweeps every placed instance of the template, the
    // same as the simulated path.
    const listed = await api('/instances?landletId=stock-oversell-floor-landlet');
    expect(listed.body.instances).toEqual([]);
  });

  // #2068 (leaf sub-issue of #1973/#1947): sweepSoldOutTemplateInstances
  // used to just discard each removed instance's own position -- now it
  // snapshots one sold_out_markers row per instance first, so Build mode
  // can later show a builder a grayed-out "something used to be here"
  // placeholder.
  describe('Sold-out markers (#2068)', () => {
    it('creates one marker per removed instance, capturing its own landlet/position/template snapshot', async () => {
      const ownerA = await signupBuilder('marker-soldout-owner-a');
      const ownerB = await signupBuilder('marker-soldout-owner-b');
      await createLandletAndClaim('marker-soldout-landlet-a', ownerA);
      await createLandletAndClaim('marker-soldout-landlet-b', ownerB);
      await createTemplateWithStock('marker-soldout-template', { stockQuantity: 1, name: 'Marker Fixture Product' });
      await api('/instances', ownerA.session({
        method: 'POST',
        body: JSON.stringify({ instanceId: 'marker-soldout-instance-a', landletId: 'marker-soldout-landlet-a', templateId: 'marker-soldout-template', x: 3, y: 4 }),
      }));
      await api('/instances', ownerB.session({
        method: 'POST',
        body: JSON.stringify({ instanceId: 'marker-soldout-instance-b', landletId: 'marker-soldout-landlet-b', templateId: 'marker-soldout-template', x: -2, y: 5 }),
      }));

      const purchased = await api('/instances/marker-soldout-instance-a/purchase', ownerA.session({ method: 'POST' }));
      expect(purchased.response.status).toBe(201);

      const markersA = await api('/landlets/marker-soldout-landlet-a/sold-out-markers', ownerA.session());
      expect(markersA.response.status).toBe(200);
      expect(markersA.body.markers).toHaveLength(1);
      expect(markersA.body.markers[0]).toMatchObject({
        landletId: 'marker-soldout-landlet-a', x: 3, y: 4, templateId: 'marker-soldout-template', templateName: 'Marker Fixture Product',
      });
      expect(markersA.body.markers[0].soldOutAt).toEqual(expect.any(String));

      const markersB = await api('/landlets/marker-soldout-landlet-b/sold-out-markers', ownerB.session());
      expect(markersB.response.status).toBe(200);
      expect(markersB.body.markers).toHaveLength(1);
      expect(markersB.body.markers[0]).toMatchObject({ landletId: 'marker-soldout-landlet-b', x: -2, y: 5 });
    });

    it('scopes the list to the given landlet only, requires its own owner\'s session, and 404s a nonexistent landlet', async () => {
      const owner = await signupBuilder('marker-list-owner');
      const stranger = await signupBuilder('marker-list-stranger');
      await createLandletAndClaim('marker-list-landlet', owner);
      await createTemplateWithStock('marker-list-template', { stockQuantity: 1 });
      await placeInstance('marker-list-instance', 'marker-list-landlet', 'marker-list-template', owner);
      await api('/instances/marker-list-instance/purchase', owner.session({ method: 'POST' }));

      const unauthenticated = await api('/landlets/marker-list-landlet/sold-out-markers');
      expect(unauthenticated.response.status).toBe(401);

      const wrongOwner = await api('/landlets/marker-list-landlet/sold-out-markers', stranger.session());
      expect(wrongOwner.response.status).toBe(403);

      const missingLandlet = await api('/landlets/marker-list-does-not-exist/sold-out-markers', owner.session());
      expect(missingLandlet.response.status).toBe(404);

      const ok = await api('/landlets/marker-list-landlet/sold-out-markers', owner.session());
      expect(ok.response.status).toBe(200);
      expect(ok.body.markers).toHaveLength(1);
    });

    it('dismisses a marker so it no longer appears in the list, 404ing a repeat dismiss or a marker from a different landlet', async () => {
      const owner = await signupBuilder('marker-dismiss-owner');
      const stranger = await signupBuilder('marker-dismiss-stranger');
      await createLandletAndClaim('marker-dismiss-landlet', owner);
      // POST .../claim enforces a hard one-claimed-landlet-per-builder
      // invariant regardless of land cap (worker/index.js's own comment on
      // that route: "nothing else in this file... is built to handle a
      // builder legitimately owning two claimed landlets at once") -- there
      // is no real path to a second claimed landlet for the same builder,
      // so this sets it up directly, same as this suite's own direct
      // higgles_earnings_events/purchases row manipulation elsewhere for
      // state no API call can produce.
      await api('/landlets', adminSession({
        method: 'POST',
        body: JSON.stringify({ landletId: 'marker-dismiss-other-landlet', name: 'Test marker-dismiss-other-landlet', areaM2: 1000, status: 'greenbelt' }),
      }));
      await env.DB.prepare(
        'UPDATE landlets SET status = \'claimed\', owner_builder_id = ? WHERE landlet_id = ?',
      ).bind(owner.builderId, 'marker-dismiss-other-landlet').run();
      await createTemplateWithStock('marker-dismiss-template', { stockQuantity: 1 });
      await placeInstance('marker-dismiss-instance', 'marker-dismiss-landlet', 'marker-dismiss-template', owner);
      await api('/instances/marker-dismiss-instance/purchase', owner.session({ method: 'POST' }));

      const listed = await api('/landlets/marker-dismiss-landlet/sold-out-markers', owner.session());
      const markerId = listed.body.markers[0].markerId;

      const unauthenticated = await api(`/landlets/marker-dismiss-landlet/sold-out-markers/${markerId}/dismiss`, { method: 'POST' });
      expect(unauthenticated.response.status).toBe(401);

      const wrongOwner = await api(`/landlets/marker-dismiss-landlet/sold-out-markers/${markerId}/dismiss`, stranger.session({ method: 'POST' }));
      expect(wrongOwner.response.status).toBe(403);

      // The marker genuinely belongs to a different landlet owned by the
      // same builder -- the dismiss route's own landletId segment must
      // still gate it, not just marker_id alone.
      const wrongLandlet = await api(`/landlets/marker-dismiss-other-landlet/sold-out-markers/${markerId}/dismiss`, owner.session({ method: 'POST' }));
      expect(wrongLandlet.response.status).toBe(404);

      const dismissed = await api(`/landlets/marker-dismiss-landlet/sold-out-markers/${markerId}/dismiss`, owner.session({ method: 'POST' }));
      expect(dismissed.response.status).toBe(200);
      expect(dismissed.body).toEqual({ dismissed: true });

      const afterList = await api('/landlets/marker-dismiss-landlet/sold-out-markers', owner.session());
      expect(afterList.body.markers).toEqual([]);

      const repeatDismiss = await api(`/landlets/marker-dismiss-landlet/sold-out-markers/${markerId}/dismiss`, owner.session({ method: 'POST' }));
      expect(repeatDismiss.response.status).toBe(404);
    });

    it('rate-limits repeated dismiss attempts from the same builder', async () => {
      const owner = await signupBuilder('marker-dismiss-rate-limit-owner');
      await createLandletAndClaim('marker-dismiss-rate-limit-landlet', owner);
      await createTemplateWithStock('marker-dismiss-rate-limit-template', { stockQuantity: 20 });
      for (let i = 0; i < 20; i++) {
        await placeInstance(`marker-dismiss-rate-limit-instance-${i}`, 'marker-dismiss-rate-limit-landlet', 'marker-dismiss-rate-limit-template', owner);
      }
      await api('/instances/marker-dismiss-rate-limit-instance-0/purchase', owner.session({
        method: 'POST', body: JSON.stringify({ quantity: 20 }),
      }));

      const listed = await api('/landlets/marker-dismiss-rate-limit-landlet/sold-out-markers', owner.session());
      expect(listed.body.markers).toHaveLength(20);

      for (const marker of listed.body.markers) {
        const attempt = await api(`/landlets/marker-dismiss-rate-limit-landlet/sold-out-markers/${marker.markerId}/dismiss`, owner.session({ method: 'POST' }));
        expect(attempt.response.status).not.toBe(429);
      }
      // One more marker, created fresh, to dismiss past the limit.
      await placeInstance('marker-dismiss-rate-limit-instance-extra', 'marker-dismiss-rate-limit-landlet', 'marker-dismiss-rate-limit-template', owner);
      await api('/catalog/marker-dismiss-rate-limit-template', { method: 'PATCH', body: JSON.stringify({ stockQuantity: 1 }) });
      await api('/instances/marker-dismiss-rate-limit-instance-extra/purchase', owner.session({ method: 'POST' }));
      const listedAgain = await api('/landlets/marker-dismiss-rate-limit-landlet/sold-out-markers', owner.session());
      const extraMarkerId = listedAgain.body.markers[0].markerId;
      const limited = await api(`/landlets/marker-dismiss-rate-limit-landlet/sold-out-markers/${extraMarkerId}/dismiss`, owner.session({ method: 'POST' }));
      expect(limited.response.status).toBe(429);
    });

    // #2098: requireOwnedLandlet above is a point-in-time check, and
    // checkRateLimit is a real awaited gap since then -- same test idiom
    // as land.test.js's/placed-instance-backups.test.js's own ownership-
    // race tests, hijacking env.DB.prepare to transfer ownership away
    // right as checkRateLimit's own INSERT INTO rate_limit_events runs.
    it('rejects a dismiss on a landlet that was transferred to a new owner mid-request', async () => {
      const owner = await signupBuilder('marker-dismiss-race-owner');
      const newOwner = await signupBuilder('marker-dismiss-race-new-owner');
      await createLandletAndClaim('marker-dismiss-race-landlet', owner);
      await createTemplateWithStock('marker-dismiss-race-template', { stockQuantity: 1 });
      await placeInstance('marker-dismiss-race-instance', 'marker-dismiss-race-landlet', 'marker-dismiss-race-template', owner);
      await api('/instances/marker-dismiss-race-instance/purchase', owner.session({ method: 'POST' }));

      const listed = await api('/landlets/marker-dismiss-race-landlet/sold-out-markers', owner.session());
      const markerId = listed.body.markers[0].markerId;

      const originalPrepare = env.DB.prepare.bind(env.DB);
      let armed = true;
      env.DB.prepare = (sql) => {
        if (armed && sql.includes('INSERT INTO rate_limit_events')) {
          armed = false;
          originalPrepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
            .bind(newOwner.builderId, 'marker-dismiss-race-landlet').run();
        }
        return originalPrepare(sql);
      };
      let rejected;
      try {
        rejected = await api(`/landlets/marker-dismiss-race-landlet/sold-out-markers/${markerId}/dismiss`, owner.session({ method: 'POST' }));
      } finally {
        env.DB.prepare = originalPrepare;
      }
      expect(rejected.response.status).toBe(409);
      expect(rejected.body.error).toMatch(/Landlet changed concurrently/);

      const stillUndismissed = await env.DB.prepare('SELECT dismissed_at FROM sold_out_markers WHERE marker_id = ?')
        .bind(markerId).first();
      expect(stillUndismissed.dismissed_at).toBe(null);
    });

    it('does not remove or resurrect markers when the sold-out template is later restocked', async () => {
      const owner = await signupBuilder('marker-restock-owner');
      await createLandletAndClaim('marker-restock-landlet', owner);
      await createTemplateWithStock('marker-restock-template', { stockQuantity: 1 });
      await placeInstance('marker-restock-instance', 'marker-restock-landlet', 'marker-restock-template', owner);
      await api('/instances/marker-restock-instance/purchase', owner.session({ method: 'POST' }));

      const beforeRestock = await api('/landlets/marker-restock-landlet/sold-out-markers', owner.session());
      expect(beforeRestock.body.markers).toHaveLength(1);

      await api('/catalog/marker-restock-template', { method: 'PATCH', body: JSON.stringify({ stockQuantity: 5 }) });

      const afterRestock = await api('/landlets/marker-restock-landlet/sold-out-markers', owner.session());
      expect(afterRestock.body.markers).toHaveLength(1);
    });
  });
});

// #2067 (leaf sub-issue of #1973, part of #1947): RESEND_API_KEY is never
// configured in this test environment (same established convention as the
// Prompt-mode concept-image describe block's own comment above), so
// sendEmail always silently no-ops here regardless of this preference --
// these tests cover everything reachable without a real send: auth
// gating, validation, persistence, and that the sweep's existing
// dashboard notification is unaffected either way.
describe('Sold-out notifications: dashboard + opt-in email (#2067)', () => {
  async function createTemplateWithStock(templateId, overrides = {}) {
    return api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId,
        name: `Notify fixture ${templateId}`,
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents: 500,
        ...overrides,
      }),
    });
  }

  async function createLandletAndClaim(landletId, builder) {
    await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2: 1000, status: 'greenbelt' }),
    }));
    await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  }

  it('GET and PUT both require a session', async () => {
    const get = await api('/builders/me/notification-preferences');
    expect(get.response.status).toBe(401);
    const put = await api('/builders/me/notification-preferences', {
      method: 'PUT',
      body: JSON.stringify({ notifySoldOutEmail: true }),
    });
    expect(put.response.status).toBe(401);
  });

  it('defaults to false and is reflected on the builder object', async () => {
    const builder = await signupBuilder('notify-default-builder');
    expect(builder.builder.notifySoldOutEmail).toBe(false);
    const prefs = await api('/builders/me/notification-preferences', builder.session());
    expect(prefs.response.status).toBe(200);
    expect(prefs.body.notifySoldOutEmail).toBe(false);
  });

  it('rejects a non-boolean notifySoldOutEmail', async () => {
    const builder = await signupBuilder('notify-invalid-builder');
    const invalid = await api('/builders/me/notification-preferences', builder.session({
      method: 'PUT',
      body: JSON.stringify({ notifySoldOutEmail: 'yes' }),
    }));
    expect(invalid.response.status).toBe(400);
  });

  it('PUT persists the preference, reflected by both GET endpoints', async () => {
    const builder = await signupBuilder('notify-persist-builder');
    const updated = await api('/builders/me/notification-preferences', builder.session({
      method: 'PUT',
      body: JSON.stringify({ notifySoldOutEmail: true }),
    }));
    expect(updated.response.status).toBe(200);
    expect(updated.body.notifySoldOutEmail).toBe(true);

    const prefs = await api('/builders/me/notification-preferences', builder.session());
    expect(prefs.body.notifySoldOutEmail).toBe(true);
    const me = await api('/builders/me', builder.session());
    expect(me.body.builder.notifySoldOutEmail).toBe(true);
  });

  // #2103: PUT had no rate limit at all, unlike handleMyAvatar's own PUT
  // (#1057) -- same test shape as avatar-ownership.test.js's own
  // "rate-limits repeated equip attempts from the same account".
  it('rate-limits repeated PUT attempts from the same account', async () => {
    const builder = await signupBuilder('notify-rate-limit-builder');
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/builders/me/notification-preferences', builder.session({
        method: 'PUT',
        body: JSON.stringify({ notifySoldOutEmail: i % 2 === 0 }),
      }));
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/builders/me/notification-preferences', builder.session({
      method: 'PUT',
      body: JSON.stringify({ notifySoldOutEmail: true }),
    }));
    expect(limited.response.status).toBe(429);
  });

  it('sold-out sweep still fires the dashboard notification for an opted-in builder (email itself is unverifiable without RESEND_API_KEY)', async () => {
    const owner = await signupBuilder('notify-soldout-owner');
    await api('/builders/me/notification-preferences', owner.session({
      method: 'PUT',
      body: JSON.stringify({ notifySoldOutEmail: true }),
    }));
    await createLandletAndClaim('notify-soldout-landlet', owner);
    await createTemplateWithStock('notify-soldout-template', { stockQuantity: 1 });
    const placed = await api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'notify-soldout-instance', landletId: 'notify-soldout-landlet', templateId: 'notify-soldout-template', x: 0, y: 0 }),
    }));
    expect(placed.response.status).toBe(201);

    const purchased = await api('/instances/notify-soldout-instance/purchase', owner.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(201);

    const notices = await api('/notifications', owner.session());
    expect(notices.body.notifications.some((n) => n.message.includes('just sold out'))).toBe(true);
  });

  // #2212: the sold-out notification email interpolates a seller-supplied
  // catalog_templates.name into its html body -- RESEND_API_KEY is never
  // set in tests (see the comment above), so the actual email send can't
  // be asserted on end to end. This exercises escapeHtml() directly, the
  // helper that call site now applies to that name before it reaches the
  // html body, since that's the part of the fix a test here actually can
  // verify.
  it('escapeHtml neutralizes HTML-special characters without double-escaping', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml(`"Builder's Best" & Co.`)).toBe('&quot;Builder&#39;s Best&quot; &amp; Co.');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('Low-stock / days-remaining list (#1949)', () => {
  async function createTemplateWithStock(templateId, overrides = {}) {
    return api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId,
        name: `Low-stock fixture ${templateId}`,
        color: '#987654',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents: 500,
        ...overrides,
      }),
    });
  }

  async function createLandletAndClaim(landletId, builder) {
    await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2: 1000, status: 'greenbelt' }),
    }));
    await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  }

  async function placeInstance(instanceId, landletId, templateId, builder) {
    const placed = await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId, landletId, templateId, x: 0, y: 0 }),
    }));
    expect(placed.response.status).toBe(201);
    return instanceId;
  }

  // Backdates a purchase's own created_at (no column in the public API ever
  // sets this) so the sales-velocity math has a controlled, exact span to
  // compute against instead of depending on real wall-clock time elapsing
  // during the test run.
  async function setPurchaseCreatedAt(purchaseId, isoTimestamp) {
    await env.DB.prepare('UPDATE purchases SET created_at = ? WHERE purchase_id = ?')
      .bind(isoTimestamp, purchaseId).run();
  }

  it('requires a session', async () => {
    const rejected = await api('/builders/me/low-stock');
    expect(rejected.response.status).toBe(401);
  });

  it('lists only the session builder\'s own placed templates with finite stock, excluding unlimited-stock ones', async () => {
    const builder = await signupBuilder('low-stock-filter-builder');
    await createLandletAndClaim('low-stock-filter-landlet', builder);
    await createTemplateWithStock('low-stock-filter-finite', { stockQuantity: 10 });
    await createTemplateWithStock('low-stock-filter-unlimited');
    await placeInstance('low-stock-filter-finite-instance', 'low-stock-filter-landlet', 'low-stock-filter-finite', builder);
    await placeInstance('low-stock-filter-unlimited-instance', 'low-stock-filter-landlet', 'low-stock-filter-unlimited', builder);

    const listed = await api('/builders/me/low-stock', builder.session());
    expect(listed.response.status).toBe(200);
    expect(listed.body.templates.map((t) => t.templateId)).toEqual(['low-stock-filter-finite']);
    expect(listed.body.templates[0]).toMatchObject({ stockQuantity: 10, placedInstanceCount: 1 });
  });

  it('counts multiple placed instances of the same template once, with the right placedInstanceCount', async () => {
    const builder = await signupBuilder('low-stock-count-builder');
    await createLandletAndClaim('low-stock-count-landlet', builder);
    await createTemplateWithStock('low-stock-count-template', { stockQuantity: 10 });
    await placeInstance('low-stock-count-instance-1', 'low-stock-count-landlet', 'low-stock-count-template', builder);
    await placeInstance('low-stock-count-instance-2', 'low-stock-count-landlet', 'low-stock-count-template', builder);

    const listed = await api('/builders/me/low-stock', builder.session());
    expect(listed.body.templates).toHaveLength(1);
    expect(listed.body.templates[0].placedInstanceCount).toBe(2);
  });

  it('reports "unpredictable" for a one-of-a-kind item regardless of its own sales history', async () => {
    const builder = await signupBuilder('low-stock-unpredictable-builder');
    await createLandletAndClaim('low-stock-unpredictable-landlet', builder);
    // Starts at 5 so a purchase can bring it down to exactly 1 (the
    // one-of-a-kind threshold) while the instance stays placed (only
    // hitting exactly 0 triggers the sold-out sweep) -- this gives the
    // template real sales history while it's still showing stockQuantity 1,
    // confirming the "always unpredictable at 1" rule overrides any data.
    await createTemplateWithStock('low-stock-unpredictable-template', { stockQuantity: 5 });
    await placeInstance('low-stock-unpredictable-instance', 'low-stock-unpredictable-landlet', 'low-stock-unpredictable-template', builder);
    const purchased = await api('/instances/low-stock-unpredictable-instance/purchase', builder.session({
      method: 'POST', body: JSON.stringify({ quantity: 4 }),
    }));
    expect(purchased.response.status).toBe(201);

    const listed = await api('/builders/me/low-stock', builder.session());
    const row = listed.body.templates.find((t) => t.templateId === 'low-stock-unpredictable-template');
    expect(row).toMatchObject({ stockQuantity: 1, daysRemaining: null, predictability: 'unpredictable' });
  });

  it('computes a dynamic days-remaining estimate from the template\'s own sales history', async () => {
    const builder = await signupBuilder('low-stock-velocity-builder');
    await createLandletAndClaim('low-stock-velocity-landlet', builder);
    await createTemplateWithStock('low-stock-velocity-template', { stockQuantity: 30 });
    await placeInstance('low-stock-velocity-instance', 'low-stock-velocity-landlet', 'low-stock-velocity-template', builder);

    const firstPurchase = await api('/instances/low-stock-velocity-instance/purchase', builder.session({
      method: 'POST', body: JSON.stringify({ quantity: 2 }),
    }));
    const secondPurchase = await api('/instances/low-stock-velocity-instance/purchase', builder.session({
      method: 'POST', body: JSON.stringify({ quantity: 8 }),
    }));
    expect(firstPurchase.response.status).toBe(201);
    expect(secondPurchase.response.status).toBe(201);

    // Exact 10-day span, 10 total units sold -- 1 unit/day, so the
    // remaining 20 units should read as exactly 20 days.
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date(t0.getTime() + 10 * 24 * 60 * 60 * 1000);
    await setPurchaseCreatedAt(firstPurchase.body.purchase.purchaseId, t0.toISOString());
    await setPurchaseCreatedAt(secondPurchase.body.purchase.purchaseId, t1.toISOString());

    const listed = await api('/builders/me/low-stock', builder.session());
    const row = listed.body.templates.find((t) => t.templateId === 'low-stock-velocity-template');
    expect(row).toMatchObject({ stockQuantity: 20, daysRemaining: 20, predictability: 'estimated' });
  });

  it('computes velocity across every builder selling the same template, not just the session builder\'s own sales', async () => {
    const hostA = await signupBuilder('low-stock-shared-pool-host-a');
    const hostB = await signupBuilder('low-stock-shared-pool-host-b');
    await createLandletAndClaim('low-stock-shared-pool-landlet-a', hostA);
    await createLandletAndClaim('low-stock-shared-pool-landlet-b', hostB);
    await createTemplateWithStock('low-stock-shared-pool-template', { stockQuantity: 20 });
    await placeInstance('low-stock-shared-pool-instance-a', 'low-stock-shared-pool-landlet-a', 'low-stock-shared-pool-template', hostA);
    await placeInstance('low-stock-shared-pool-instance-b', 'low-stock-shared-pool-landlet-b', 'low-stock-shared-pool-template', hostB);

    // hostB alone sells enough to establish a real rate -- hostA's own
    // listing should still see that velocity, since it's the same shared
    // stock pool.
    const purchase = await api('/instances/low-stock-shared-pool-instance-b/purchase', hostB.session({
      method: 'POST', body: JSON.stringify({ quantity: 10 }),
    }));
    expect(purchase.response.status).toBe(201);
    const t0 = new Date('2026-02-01T00:00:00.000Z');
    await setPurchaseCreatedAt(purchase.body.purchase.purchaseId, t0.toISOString());
    // A single sale: span floors at 1 day, so the rate is 10 units/day.

    const listedA = await api('/builders/me/low-stock', hostA.session());
    const rowA = listedA.body.templates.find((t) => t.templateId === 'low-stock-shared-pool-template');
    expect(rowA).toMatchObject({ predictability: 'estimated' });
    // 10 remaining (20 - 10 sold) / 10 units-per-day = exactly 1 day.
    expect(rowA.daysRemaining).toBe(1);
  });

  it('falls back to same-category velocity when the template has no sales history of its own', async () => {
    const seedBuilder = await signupBuilder('low-stock-category-seed-builder');
    await createLandletAndClaim('low-stock-category-seed-landlet', seedBuilder);
    await createTemplateWithStock('low-stock-category-seed-template', { stockQuantity: 50, category: 'low-stock-test-category' });
    await placeInstance('low-stock-category-seed-instance', 'low-stock-category-seed-landlet', 'low-stock-category-seed-template', seedBuilder);
    const seedPurchase = await api('/instances/low-stock-category-seed-instance/purchase', seedBuilder.session({
      method: 'POST', body: JSON.stringify({ quantity: 5 }),
    }));
    expect(seedPurchase.response.status).toBe(201);
    const t0 = new Date('2026-03-01T00:00:00.000Z');
    const t1 = new Date(t0.getTime() + 5 * 24 * 60 * 60 * 1000);
    // A second, backdated purchase on the seed template to establish a real
    // multi-point span (5 units over 5 days = 1 unit/day) for the category
    // fallback to average.
    await setPurchaseCreatedAt(seedPurchase.body.purchase.purchaseId, t0.toISOString());
    await env.DB.prepare(`
      INSERT INTO purchases (purchase_id, instance_id, template_id, builder_id, unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents, created_at)
      VALUES (?, ?, ?, ?, 500, ?, 2500, 50, 25, 25, ?)
    `).bind('low-stock-category-seed-purchase-2', 'low-stock-category-seed-instance', 'low-stock-category-seed-template', seedBuilder.builderId, 5, t1.toISOString()).run();

    const builder = await signupBuilder('low-stock-category-builder');
    await createLandletAndClaim('low-stock-category-landlet', builder);
    await createTemplateWithStock('low-stock-category-template', { stockQuantity: 10, category: 'low-stock-test-category' });
    await placeInstance('low-stock-category-instance', 'low-stock-category-landlet', 'low-stock-category-template', builder);

    const listed = await api('/builders/me/low-stock', builder.session());
    const row = listed.body.templates.find((t) => t.templateId === 'low-stock-category-template');
    // Category rate is 2 units/day (5 + 5 = 10 units sold over the 5-day
    // span above), so 10 remaining reads as exactly 5 days.
    expect(row).toMatchObject({ stockQuantity: 10, daysRemaining: 5, predictability: 'estimatedFromCategory' });
  });

  it('reports "notEnoughData" when there is no sales history at all, for the template or its category', async () => {
    const builder = await signupBuilder('low-stock-no-data-builder');
    await createLandletAndClaim('low-stock-no-data-landlet', builder);
    await createTemplateWithStock('low-stock-no-data-template', { stockQuantity: 15, category: 'low-stock-never-sold-category' });
    await placeInstance('low-stock-no-data-instance', 'low-stock-no-data-landlet', 'low-stock-no-data-template', builder);

    const listed = await api('/builders/me/low-stock', builder.session());
    const row = listed.body.templates.find((t) => t.templateId === 'low-stock-no-data-template');
    expect(row).toMatchObject({ stockQuantity: 15, daysRemaining: null, predictability: 'notEnoughData' });
  });

  // #2321: templateSalesVelocity bound every id from the (unbounded) list of
  // this builder's own finite-stock templates in a single unchunked IN (...)
  // query -- D1 caps a single query at 100 bound parameters, so a builder
  // with more than 100 distinct finite-stock templates placed threw a raw
  // D1 error instead of returning the list. Seeds 101 templates/instances
  // directly via D1 -- same shape as #2038's own >100-id regression test --
  // rather than the real create/place flows, since 101 round trips through
  // the real API would be far slower and the test only cares that the real
  // endpoint responds cleanly either way.
  it('does not throw a raw D1 error for a builder with more than 100 distinct finite-stock templates placed', async () => {
    const builder = await signupBuilder('low-stock-chunk-builder');
    await createLandletAndClaim('low-stock-chunk-landlet', builder);

    const templateIds = Array.from({ length: 101 }, (_, i) => `low-stock-chunk-template-${i}`);
    await env.DB.batch(templateIds.map((templateId) => env.DB.prepare(
      "INSERT INTO catalog_templates (template_id, name, category, color, width_m, depth_m, height_m, stock_quantity) VALUES (?, ?, 'low-stock-chunk-category', '#123456', 1, 1, 1, 10)",
    ).bind(templateId, `Low-stock chunk fixture ${templateId}`)));
    await env.DB.batch(templateIds.map((templateId, i) => env.DB.prepare(
      'INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m) VALUES (?, ?, ?, 1, 1)',
    ).bind(`low-stock-chunk-instance-${i}`, 'low-stock-chunk-landlet', templateId)));

    const listed = await api('/builders/me/low-stock', builder.session());
    // The real bug was a raw 500 (D1_ERROR: too many SQL variables) from
    // inside this exact call.
    expect(listed.response.status).toBe(200);
    expect(listed.body.templates).toHaveLength(101);
    expect(listed.body.templates.every((t) => t.predictability === 'notEnoughData')).toBe(true);
  });
});
