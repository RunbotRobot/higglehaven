import {
  applyD1Migrations, env, SELF,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
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

  it('rejects an empty items array, more than 250 items, and a nonexistent templateId', async () => {
    const builder = await signupBuilder('bundle-validate');
    const empty = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify(bundleBody({ items: [] })),
    }));
    expect(empty.response.status).toBe(400);

    const tooMany = await api('/bundles', builder.session({
      method: 'POST',
      body: JSON.stringify(bundleBody({
        items: Array.from({ length: 251 }, () => ({ templateId: 'placeholder-chair', dx: 0, dy: 0, dz: 0 })),
      })),
    }));
    expect(tooMany.response.status).toBe(400);

    const badTemplate = await api('/bundles', builder.session({
      method: 'POST',
      body: JSON.stringify(bundleBody({ items: [{ templateId: 'template-does-not-exist', dx: 0, dy: 0, dz: 0 }] })),
    }));
    expect(badTemplate.response.status).toBe(400);
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
