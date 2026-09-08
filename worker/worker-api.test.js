import {
  applyD1Migrations, env, SELF, createExecutionContext, createScheduledController, waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import {
  api, extractSessionCookie, withSession, signup, signupBuilder, signupSeller, glbFile, signupAdmin,
  createGreenbeltLandletAs,
} from './test-helpers.js';

// Shared across every test that needs to act as an admin (world/land-
// candidate tooling — see requireAdmin in worker/index.js) — one admin
// account for the whole file rather than a fresh one per test, since
// admin status carries no per-test state of its own to isolate.
let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('shared-admin');
  adminSession = admin.session;
});

function createGreenbeltLandlet(landletId) {
  return createGreenbeltLandletAs(adminSession, landletId);
}

describe('Worker API', () => {
  it('validates, stores, and serves complete glTF 2.0 binary models', async () => {
    const form = new FormData();
    form.set('file', glbFile());
    const response = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ sourceName: 'chair.glb', sizeBytes: 24, deduplicated: false });
    expect(body.modelUrl).toMatch(/^\/uploads\/models\/[0-9a-f]{64}\.glb$/);

    const duplicateForm = new FormData();
    duplicateForm.set('file', glbFile());
    const duplicate = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: duplicateForm });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      modelUrl: body.modelUrl,
      sizeBytes: 24,
      deduplicated: true,
    });

    const uploaded = await SELF.fetch(`https://higglehaven.test${body.modelUrl}`);
    expect(uploaded.status).toBe(200);
    expect(uploaded.headers.get('content-type')).toBe('model/gltf-binary');
    expect(uploaded.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await uploaded.arrayBuffer()).byteLength).toBe(24);

    const head = await SELF.fetch(`https://higglehaven.test${body.modelUrl}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(uploaded.headers.get('etag'));
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const cached = await SELF.fetch(`https://higglehaven.test${body.modelUrl}`, {
      headers: { 'if-none-match': uploaded.headers.get('etag') },
    });
    expect(cached.status).toBe(304);
    expect((await cached.arrayBuffer()).byteLength).toBe(0);

    const rejected = await SELF.fetch(`https://higglehaven.test${body.modelUrl}`, { method: 'POST' });
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get('allow')).toBe('GET, HEAD, DELETE');
  });

  it('rate-limits repeated model uploads from the same client', async () => {
    // POST /api/models is unauthenticated on purpose (see the removed-URL-
    // import comment in handleModelUpload), but each call can burn shared
    // R2 storage headroom, so it gets the same per-client throttle as
    // signup/password-reset. A synthetic cf-connecting-ip keeps this
    // test's bucket from colliding with every other model-upload test in
    // this file, which otherwise all share the same "unknown" IP bucket
    // (mirrors how the signup rate-limit test uses a unique email instead).
    // 20 succeed (as either a fresh 201 or a deduplicated 200 — both still
    // count against the limit); the 21st is rejected before it ever
    // touches R2.
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const form = new FormData();
      form.set('file', glbFile());
      const attempt = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form, headers });
      expect(attempt.status).not.toBe(429);
    }
    const form = new FormData();
    form.set('file', glbFile());
    const limited = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form, headers });
    expect(limited.status).toBe(429);
  });

  it('accepts only one of two concurrent uploads that would jointly overrun the storage cap, not both', async () => {
    const storage = await api('/models/storage', adminSession());
    const usedBytes = storage.body.usedBytes;
    const capBytes = 8 * 1024 * 1024 * 1024;
    // Seed a fake in-flight reservation directly (mirrors how the
    // vertical-construction-levels tests seed landlet_levels directly —
    // actually filling the real 8GB cap via uploads would take hundreds
    // of requests) so only a sliver of real headroom remains: room for
    // one 28-byte test upload, not two fired concurrently.
    const headroomBytes = 30;
    await env.DB.prepare(`
      INSERT INTO model_upload_reservations (reservation_id, size_bytes, created_at) VALUES (?, ?, ?)
    `).bind(`test-reservation-${crypto.randomUUID()}`, capBytes - usedBytes - headroomBytes, Date.now()).run();

    const headers = { 'cf-connecting-ip': `storage-race-${crypto.randomUUID()}` };
    // Fired together, not awaited one at a time — a read-then-insert
    // implementation could let both requests read "usage is under the
    // cap" before either R2 put lands, jointly overrunning the cap
    // (#264). Each file has distinct content so neither short-circuits
    // via the dedup-by-hash path before ever reaching the reservation
    // check.
    const formA = new FormData();
    formA.set('file', glbFile({ json: '{"a":1}' }));
    const formB = new FormData();
    formB.set('file', glbFile({ json: '{"b":1}' }));
    const [first, second] = await Promise.all([
      SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: formA, headers }),
      SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: formB, headers }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 507]);

    // The rejected upload's would-be reservation must not linger —
    // otherwise the storage cap would ratchet down permanently every time
    // a race (or any ordinary rejection) occurs. Only the fake row seeded
    // above should remain; the winner's own reservation is freed once its
    // R2 put lands.
    const remaining = await env.DB.prepare('SELECT COUNT(*) AS count FROM model_upload_reservations').first();
    expect(remaining.count).toBe(1);

    // Clean up both the fake reservation and the winning upload itself —
    // otherwise this test would leave a permanent, unreferenced model
    // sitting in R2 that later tests (e.g. the orphan-cleanup one below)
    // don't expect to find.
    await env.DB.prepare('DELETE FROM model_upload_reservations').run();
    const winner = first.status === 201 ? first : second;
    const { modelUrl } = await winner.json();
    await SELF.fetch(`https://higglehaven.test${modelUrl}`, adminSession({ method: 'DELETE' }));
  });

  it('deletes only unreferenced uploaded models', async () => {
    const missingModel = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'missing-upload-test',
        name: 'Missing upload test',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        modelUrl: '/uploads/models/missing.glb',
      }),
    });
    expect(missingModel.response.status).toBe(400);
    expect(missingModel.body).toEqual({ error: 'modelUrl does not reference an existing uploaded model' });

    const form = new FormData();
    form.set('file', glbFile());
    const upload = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form });
    const uploaded = await upload.json();

    // Admin-only, same "cleanup tooling" bar as POST /api/models/cleanup
    // and DELETE /uploads/:key below: no session, and a logged-in-but-
    // not-admin session, are both rejected before either handler touches
    // R2 or D1.
    expect((await api('/models?limit=100')).response.status).toBe(401);
    expect((await api('/models/storage')).response.status).toBe(401);
    const nonAdminModels = await signupBuilder('non-admin-model-listing');
    expect((await api('/models?limit=100', nonAdminModels.session())).response.status).toBe(403);
    expect((await api('/models/storage', nonAdminModels.session())).response.status).toBe(403);

    const listing = await api('/models?limit=100', adminSession());
    expect(listing.response.status).toBe(200);
    expect(listing.body.models).toContainEqual(expect.objectContaining({
      modelUrl: uploaded.modelUrl,
      sizeBytes: uploaded.sizeBytes,
      referencedByTemplateIds: [],
      deletable: true,
    }));
    expect(listing.body.nextCursor).toBeNull();
    expect((await api('/models?limit=101', adminSession())).response.status).toBe(400);
    expect((await api('/models?cursor=', adminSession())).response.status).toBe(400);
    const storage = await api('/models/storage', adminSession());
    expect(storage.response.status).toBe(200);
    expect(storage.body).toMatchObject({
      capBytes: 8 * 1024 * 1024 * 1024,
      availableBytes: 8 * 1024 * 1024 * 1024 - storage.body.usedBytes,
    });
    expect(storage.body.objectCount).toBe(listing.body.models.length);
    expect(storage.body.usedBytes).toBe(listing.body.models.reduce((sum, model) => sum + model.sizeBytes, 0));
    expect(storage.body.utilizationRatio).toBe(storage.body.usedBytes / storage.body.capBytes);
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'uploaded-delete-test',
        name: 'Uploaded delete test',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        modelUrl: uploaded.modelUrl,
      }),
    });
    expect(created.response.status).toBe(201);
    const invalidUpdate = await api('/catalog/uploaded-delete-test', {
      method: 'PATCH',
      body: JSON.stringify({ modelUrl: '/uploads/models/missing.glb' }),
    });
    expect(invalidUpdate.response.status).toBe(400);
    expect((await api('/catalog/uploaded-delete-test')).body.template.modelUrl).toBe(uploaded.modelUrl);

    const referencedListing = await api('/models', adminSession());
    expect(referencedListing.body.models).toContainEqual(expect.objectContaining({
      modelUrl: uploaded.modelUrl,
      referencedByTemplateIds: ['uploaded-delete-test'],
      deletable: false,
    }));

    // Admin-only, same as /api/models/cleanup below: no session, and a
    // logged-in-but-not-admin session, are both rejected before the
    // referenced-model check ever runs.
    const unauthedDelete = await SELF.fetch(`https://higglehaven.test${uploaded.modelUrl}`, { method: 'DELETE' });
    expect(unauthedDelete.status).toBe(401);
    const nonAdmin = await signupBuilder('non-admin-model-delete');
    const nonAdminDelete = await SELF.fetch(`https://higglehaven.test${uploaded.modelUrl}`, nonAdmin.session({ method: 'DELETE' }));
    expect(nonAdminDelete.status).toBe(403);

    const referenced = await SELF.fetch(`https://higglehaven.test${uploaded.modelUrl}`, adminSession({ method: 'DELETE' }));
    expect(referenced.status).toBe(409);
    expect(await referenced.json()).toEqual({ error: 'Uploaded model is still referenced by a catalog template' });

    expect((await api('/catalog/uploaded-delete-test', { method: 'DELETE' })).response.status).toBe(200);
    const removed = await SELF.fetch(`https://higglehaven.test${uploaded.modelUrl}`, adminSession({ method: 'DELETE' }));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: true });
    expect((await SELF.fetch(`https://higglehaven.test${uploaded.modelUrl}`)).status).toBe(404);
    expect((await SELF.fetch(`https://higglehaven.test${uploaded.modelUrl}`, adminSession({ method: 'DELETE' }))).status).toBe(404);
    const afterRemoval = await api('/models', adminSession());
    expect(afterRemoval.body.models.some((model) => model.modelUrl === uploaded.modelUrl)).toBe(false);
    const storageAfterRemoval = await api('/models/storage', adminSession());
    expect(storageAfterRemoval.body.usedBytes).toBe(storage.body.usedBytes - uploaded.sizeBytes);
    expect(storageAfterRemoval.body.objectCount).toBe(storage.body.objectCount - 1);

    const orphanForm = new FormData();
    orphanForm.set('file', glbFile({ json: '{"orphan":true}' }));
    const orphanUpload = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: orphanForm });
    const orphan = await orphanUpload.json();

    // Admin-only: rejected before it ever touches R2, same bar as the
    // DELETE-a-single-upload endpoint above.
    expect((await api('/models/cleanup', { method: 'POST', body: JSON.stringify({ maxDeletes: 1 }) })).response.status).toBe(401);
    expect((await api('/models/cleanup', nonAdmin.session({
      method: 'POST', body: JSON.stringify({ maxDeletes: 1 }),
    }))).response.status).toBe(403);

    const preview = await api('/models/cleanup', adminSession({
      method: 'POST',
      body: JSON.stringify({ maxDeletes: 1, dryRun: true }),
    }));
    expect(preview.response.status).toBe(200);
    expect(preview.body).toEqual({
      targetModelUrls: [orphan.modelUrl],
      targetCount: 1,
      reclaimedBytes: orphan.sizeBytes,
      completeScan: true,
      dryRun: true,
    });
    expect((await SELF.fetch(`https://higglehaven.test${orphan.modelUrl}`)).status).toBe(200);
    const cleanup = await api('/models/cleanup', adminSession({
      method: 'POST',
      body: JSON.stringify({ maxDeletes: 1 }),
    }));
    expect(cleanup.response.status).toBe(200);
    expect(cleanup.body).toEqual({
      targetModelUrls: [orphan.modelUrl],
      targetCount: 1,
      reclaimedBytes: orphan.sizeBytes,
      completeScan: true,
      dryRun: false,
    });
    expect((await SELF.fetch(`https://higglehaven.test${orphan.modelUrl}`)).status).toBe(404);
    expect((await api('/models/cleanup', adminSession({
      method: 'POST', body: JSON.stringify({ maxDeletes: 101 }),
    }))).response.status).toBe(400);
    expect((await api('/models/cleanup', adminSession({
      method: 'POST', body: JSON.stringify({ dryRun: 'yes' }),
    }))).response.status).toBe(400);
  });

  // #417: completeScan used to be derived purely from R2's listing.truncated
  // flag, which only says whether a *further page* exists — not whether the
  // inner loop actually finished examining every object already fetched on
  // this (single, untruncated) page before it broke out early on hitting
  // maxDeletes. Three orphans fit on one R2 list() page (well under its
  // 100-object page size), so with maxDeletes=2 the loop must stop after
  // examining only 2 of the 3 objects on that single, non-truncated page.
  it('reports an incomplete scan when maxDeletes is hit partway through the final (non-truncated) R2 page', async () => {
    const orphanUrls = [];
    for (let i = 0; i < 3; i++) {
      const form = new FormData();
      form.set('file', glbFile({ json: `{"completeScanRegression":${i}}` }));
      const uploaded = await (await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form })).json();
      orphanUrls.push(uploaded.modelUrl);
    }

    const partial = await api('/models/cleanup', adminSession({
      method: 'POST',
      body: JSON.stringify({ maxDeletes: 2, dryRun: true }),
    }));
    expect(partial.response.status).toBe(200);
    expect(partial.body.targetCount).toBe(2);
    expect(partial.body.completeScan).toBe(false);

    const full = await api('/models/cleanup', adminSession({
      method: 'POST',
      body: JSON.stringify({ maxDeletes: 100 }),
    }));
    expect(full.response.status).toBe(200);
    expect(full.body.completeScan).toBe(true);
    for (const url of orphanUrls) {
      expect(full.body.targetModelUrls).toContain(url);
      expect((await SELF.fetch(`https://higglehaven.test${url}`)).status).toBe(404);
    }
  });

  it('rejects invalid uploaded-model paths', async () => {
    const missingKey = await SELF.fetch('https://higglehaven.test/uploads/');
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toEqual({ error: 'Uploaded model key is required' });

    const malformed = await SELF.fetch('https://higglehaven.test/uploads/%E0%A4%A');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'Invalid upload path encoding' });
  });

  it('rejects unsupported or structurally incomplete GLB uploads', async () => {
    for (const [file, error] of [
      [glbFile({ version: 1 }), 'Only glTF 2.0 .glb models are supported'],
      [glbFile({ declaredLength: 999 }), 'GLB header length does not match the uploaded file'],
      [glbFile({ json: '{]' }), 'GLB contains invalid JSON metadata'],
    ]) {
      const form = new FormData();
      form.set('file', file);
      const response = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    }
  });

  it('reports health and serves migrated seed data', async () => {
    const health = await api('/health');
    expect(health.response.status).toBe(200);
    expect(health.body).toEqual({ ok: true, service: 'higglehaven-api' });

    const catalog = await api('/catalog');
    expect(catalog.response.status).toBe(200);
    expect(catalog.body.templates.length).toBeGreaterThan(0);
    expect(catalog.body.nextCursor).toBeNull();

    const world = await api('/world');
    expect(world.response.status).toBe(200);
    expect(world.body.world).toMatchObject({
      worldId: 'default-world',
      expansionIncrementM: 10,
      greenbeltMinRatio: 0.1,
      coordinateRotationDeg: 210,
      dayCycleHours: 4,
    });
  });

  it('filters and cursor-paginates catalog templates in stable name order', async () => {
    const sellerA = await signupSeller('catalog-page-seller-a');
    const sellerB = await signupSeller('catalog-page-seller-b');
    const sellersById = { [sellerA.sellerId]: sellerA, [sellerB.sellerId]: sellerB };
    for (const [templateId, name, subcategory, sellerId, priceCents, color, dimensions] of [
      ['catalog-page-b', 'Catalog same name', 'seating', sellerB.sellerId, 200, '#123456', { width: 1, depth: 1, height: 1 }],
      ['catalog-page-a', 'Catalog same name', 'seating', sellerA.sellerId, 100, '#123456', { width: 1, depth: 1, height: 1 }],
      ['catalog-page-c', 'Catalog trailing name', 'lighting', sellerA.sellerId, 300, '#abcdef', { width: 3, depth: 2, height: 4 }],
    ]) {
      const created = await api('/catalog', sellersById[sellerId].session({
        method: 'POST',
        body: JSON.stringify({
          templateId,
          name,
          category: 'pagination-test',
          subcategory,
          sellerId,
          priceCents,
          color,
          dimensions,
        }),
      }));
      expect(created.response.status).toBe(201);
    }

    const templateIds = [];
    let cursor = null;
    do {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page = await api(`/catalog?category=%20pagination-test%20&limit=1${suffix}`);
      expect(page.response.status).toBe(200);
      expect(page.body.templates).toHaveLength(1);
      templateIds.push(page.body.templates[0].templateId);
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(templateIds).toEqual(['catalog-page-a', 'catalog-page-b', 'catalog-page-c']);

    const subcategory = await api('/catalog?category=pagination-test&subcategory=seating');
    expect(subcategory.response.status).toBe(200);
    expect(subcategory.body.templates.map((template) => template.templateId)).toEqual([
      'catalog-page-a', 'catalog-page-b',
    ]);
    const seller = await api(`/catalog?category=pagination-test&sellerId=${sellerA.sellerId}`);
    expect(seller.response.status).toBe(200);
    expect(seller.body.templates.map((template) => template.templateId)).toEqual([
      'catalog-page-a', 'catalog-page-c',
    ]);
    const colored = await api('/catalog?category=pagination-test&color=%23123456');
    expect(colored.response.status).toBe(200);
    expect(colored.body.templates.map((template) => template.templateId)).toEqual([
      'catalog-page-a', 'catalog-page-b',
    ]);
    const priced = await api('/catalog?category=pagination-test&minPriceCents=100&maxPriceCents=200');
    expect(priced.response.status).toBe(200);
    expect(priced.body.templates.map((template) => template.templateId)).toEqual([
      'catalog-page-a', 'catalog-page-b',
    ]);
    const fitting = await api('/catalog?category=pagination-test&maxWidthM=2&maxDepthM=1&maxHeightM=2');
    expect(fitting.response.status).toBe(200);
    expect(fitting.body.templates.map((template) => template.templateId)).toEqual([
      'catalog-page-a', 'catalog-page-b',
    ]);
    const dimensionRange = await api('/catalog?category=pagination-test&minWidthM=2&maxWidthM=4&minDepthM=1.5&minHeightM=3');
    expect(dimensionRange.response.status).toBe(200);
    expect(dimensionRange.body.templates.map((template) => template.templateId)).toEqual(['catalog-page-c']);
    const ascendingPriceIds = [];
    let priceCursor = null;
    do {
      const suffix = priceCursor ? `&cursor=${encodeURIComponent(priceCursor)}` : '';
      const page = await api(`/catalog?category=pagination-test&sort=price-asc&limit=1${suffix}`);
      ascendingPriceIds.push(page.body.templates[0].templateId);
      priceCursor = page.body.nextCursor;
    } while (priceCursor);
    expect(ascendingPriceIds).toEqual(['catalog-page-a', 'catalog-page-b', 'catalog-page-c']);
    const descending = await api('/catalog?category=pagination-test&sort=price-desc');
    expect(descending.body.templates.map((template) => template.templateId)).toEqual([
      'catalog-page-c', 'catalog-page-b', 'catalog-page-a',
    ]);
    const namePage = await api('/catalog?category=pagination-test&limit=1');
    const mismatchedCursor = await api(
      `/catalog?category=pagination-test&sort=price-asc&cursor=${encodeURIComponent(namePage.body.nextCursor)}`,
    );
    expect(mismatchedCursor.response.status).toBe(400);

    const searched = await api('/catalog?q=TRAILING');
    expect(searched.response.status).toBe(200);
    expect(searched.body.templates.map((template) => template.templateId)).toEqual(['catalog-page-c']);
    const noWildcardExpansion = await api('/catalog?q=%25');
    expect(noWildcardExpansion.response.status).toBe(200);
    expect(noWildcardExpansion.body.templates).toEqual([]);

    const invalidCategory = await api('/catalog?category=');
    expect(invalidCategory.response.status).toBe(400);
    expect((await api('/catalog?subcategory=')).response.status).toBe(400);
    expect((await api('/catalog?sellerId=')).response.status).toBe(400);
    expect((await api('/catalog?color=')).response.status).toBe(400);
    expect((await api('/catalog?minPriceCents=-1')).response.status).toBe(400);
    expect((await api('/catalog?maxPriceCents=1.5')).response.status).toBe(400);
    expect((await api('/catalog?minPriceCents=2&maxPriceCents=1')).response.status).toBe(400);
    expect((await api('/catalog?maxWidthM=0')).response.status).toBe(400);
    expect((await api('/catalog?maxDepthM=nope')).response.status).toBe(400);
    expect((await api('/catalog?minWidthM=3&maxWidthM=2')).response.status).toBe(400);
    expect((await api('/catalog?minHeightM=-1')).response.status).toBe(400);
    expect((await api('/catalog?sort=popular')).response.status).toBe(400);
    const invalidLimit = await api('/catalog?limit=101');
    expect(invalidLimit.response.status).toBe(400);
    const invalidCursor = await api('/catalog?cursor=invalid');
    expect(invalidCursor.response.status).toBe(400);
    expect(invalidCursor.body).toEqual({ error: 'cursor is invalid' });
    expect((await api('/catalog?q=')).response.status).toBe(400);
    expect((await api(`/catalog?q=${'a'.repeat(101)}`)).response.status).toBe(400);
  });

  it('atomically creates catalog template batches', async () => {
    const created = await api('/catalog/batch', {
      method: 'POST',
      body: JSON.stringify({
        templates: ['a', 'b'].map((suffix) => ({
          templateId: `catalog-batch-${suffix}`,
          name: `Catalog batch ${suffix}`,
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
        })),
      }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.templates.map((template) => template.templateId)).toEqual([
      'catalog-batch-a', 'catalog-batch-b',
    ]);

    const conflict = await api('/catalog/batch', {
      method: 'POST',
      body: JSON.stringify({
        templates: [
          { templateId: 'catalog-batch-rolled-back', name: 'Rollback', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 } },
          // Reuses 'catalog-batch-a', an unowned template created above, so
          // the conflict here is a plain primary-key collision rather than
          // tripping the seller-ownership check (that's covered separately
          // by seller-scoped tests, and seed templates all have a fixed
          // 'dev-seller' owner no real session can ever authenticate as).
          { templateId: 'catalog-batch-a', name: 'Conflict', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 } },
        ],
      }),
    });
    expect(conflict.response.status).toBe(409);
    expect((await api('/catalog/catalog-batch-rolled-back')).response.status).toBe(404);

    const replaced = await api('/catalog/batch', {
      method: 'PUT',
      body: JSON.stringify({ templates: [
        { templateId: 'catalog-batch-a', name: 'Catalog batch A replaced', color: '#abcdef', dimensions: { width: 2, depth: 2, height: 2 } },
        { templateId: 'catalog-batch-c', name: 'Catalog batch c', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 } },
      ] }),
    });
    expect(replaced.response.status).toBe(200);
    expect(replaced.body.templates.map((template) => template.templateId)).toEqual([
      'catalog-batch-a', 'catalog-batch-c',
    ]);
    expect((await api('/catalog/catalog-batch-a')).body.template).toMatchObject({
      name: 'Catalog batch A replaced', color: '#abcdef',
      dimensions: { width: 2, depth: 2, height: 2 },
    });

    // An unowned template (rather than a seed 'placeholder-*' one, whose
    // fixed 'dev-seller' owner no real session can authenticate as) referenced
    // by a placed instance, so the DELETE below conflicts on the reference
    // rather than on ownership. Placing the instance itself now needs a real
    // owned landlet + session, so a fresh one is created just for this.
    const referencedTemplate = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'catalog-batch-referenced', name: 'Catalog batch referenced',
        color: '#123456', dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(referencedTemplate.response.status).toBe(201);
    const referenceBuilder = await signupBuilder('catalog-batch-reference-builder');
    await api('/landlets', referenceBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'catalog-batch-reference-landlet', name: 'Catalog batch reference landlet', areaM2: 100,
        status: 'claimed', ownerBuilderId: referenceBuilder.builderId,
      }),
    }));
    const reference = await api('/instances', referenceBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'catalog-batch-delete-reference', landletId: 'catalog-batch-reference-landlet',
        templateId: 'catalog-batch-referenced', x: 0, y: 0,
      }),
    }));
    expect(reference.response.status).toBe(201);
    const deleteConflict = await api('/catalog/batch', {
      method: 'DELETE',
      body: JSON.stringify({ templateIds: ['catalog-batch-b', 'catalog-batch-referenced'] }),
    });
    expect(deleteConflict.response.status).toBe(409);
    expect((await api('/catalog/catalog-batch-b')).response.status).toBe(200);
    expect((await api('/instances/catalog-batch-delete-reference', referenceBuilder.session({ method: 'DELETE' }))).response.status).toBe(200);
    const deleted = await api('/catalog/batch', {
      method: 'DELETE',
      body: JSON.stringify({ templateIds: ['catalog-batch-b', 'catalog-batch-c'] }),
    });
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.deletedTemplateIds).toEqual(['catalog-batch-b', 'catalog-batch-c']);
    expect((await api('/catalog/catalog-batch-b')).response.status).toBe(404);
    expect((await api('/catalog/batch', {
      method: 'DELETE', body: JSON.stringify({ templateIds: ['missing-template'] }),
    })).response.status).toBe(404);

    expect((await api('/catalog/batch', {
      method: 'POST', body: JSON.stringify({ templates: [] }),
    })).response.status).toBe(400);
    expect((await api('/catalog/batch', {
      method: 'POST',
      body: JSON.stringify({ templates: [
        { templateId: 'duplicate', name: 'One', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 } },
        { templateId: 'duplicate', name: 'Two', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 } },
      ] }),
    })).response.status).toBe(400);
  });

  // Found via backlog audit (#407): the single-item catalog PATCH/DELETE
  // (and review moderation, refunds) already treat a dangling seller_id —
  // left behind by DELETE /api/sellers/:sellerId, per that handler's own
  // comment — as unowned, same as docs/API.md's "same as null seller_id"
  // promise (see sellerExists' own comment in worker/index.js). The batch
  // catalog endpoints did a plain `if (row.seller_id)` truthiness check
  // instead, so a template a self-deleted seller once owned became
  // permanently un-deletable/un-upsertable via these routes for everyone,
  // since no live session's seller_id can ever match one that no longer
  // exists.
  it('treats a batch template\'s dangling seller_id as unowned once its seller has self-deleted', async () => {
    const seller = await signupSeller('catalog-batch-deleted-seller');
    const created = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'catalog-batch-deleted-seller-template',
        name: 'Product whose seller later deletes their account',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        sellerId: seller.sellerId,
      }),
    }));
    expect(created.response.status).toBe(201);

    expect((await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }))).response.status).toBe(200);

    // No session on either call below — a dangling seller_id now falls
    // through to the same unrestricted path a genuinely null one already
    // takes, matching the single-item PATCH/DELETE endpoints.
    const upserted = await api('/catalog/batch', {
      method: 'PUT',
      body: JSON.stringify({ templates: [
        { templateId: 'catalog-batch-deleted-seller-template', name: 'Renamed after seller deletion', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 } },
      ] }),
    });
    expect(upserted.response.status).toBe(200);
    expect(upserted.body.templates[0].name).toBe('Renamed after seller deletion');

    const deleted = await api('/catalog/batch', {
      method: 'DELETE',
      body: JSON.stringify({ templateIds: ['catalog-batch-deleted-seller-template'] }),
    });
    expect(deleted.response.status).toBe(200);
    expect((await api('/catalog/catalog-batch-deleted-seller-template')).response.status).toBe(404);
  });

  it('cursor-paginates placed instances within one landlet', async () => {
    // Owned directly at creation (POST /landlets allows creating a landlet
    // already claimed by yourself — see that route's own comment) rather
    // than going through the full claim flow, so the instance placements
    // below can authenticate as its real owner.
    const pageBuilder = await signupBuilder('instance-page-builder');
    await api('/landlets', pageBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'instance-page-landlet', name: 'Instance page landlet', areaM2: 4,
        status: 'claimed', ownerBuilderId: pageBuilder.builderId,
      }),
    }));
    for (const instanceId of ['instance-page-b', 'instance-page-a']) {
      const created = await api('/instances', pageBuilder.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId,
          landletId: 'instance-page-landlet',
          templateId: 'placeholder-chair',
          x: 0,
          y: 0,
        }),
      }));
      expect(created.response.status).toBe(201);
      expect(created.body.instance.createdAt).toBeTruthy();
      expect(created.body.instance.updatedAt).toBeTruthy();
    }
    await env.DB.prepare(`
      UPDATE placed_instances SET created_at = '2026-08-01T00:00:00.000Z'
      WHERE landlet_id = 'instance-page-landlet'
    `).run();

    const ids = [];
    let cursor = null;
    do {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page = await api(`/instances?landletId=%20instance-page-landlet%20&limit=1${suffix}`);
      expect(page.response.status).toBe(200);
      expect(page.body.instances).toHaveLength(1);
      ids.push(page.body.instances[0].instanceId);
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(ids).toEqual(['instance-page-a', 'instance-page-b']);

    const filtered = await api('/instances?landletId=instance-page-landlet&templateId=placeholder-chair');
    expect(filtered.response.status).toBe(200);
    expect(filtered.body.instances.map((instance) => instance.instanceId)).toEqual([
      'instance-page-a', 'instance-page-b',
    ]);
    expect((await api('/instances?templateId=')).response.status).toBe(400);

    const invalidLandlet = await api('/instances?landletId=');
    expect(invalidLandlet.response.status).toBe(400);
    const invalidLimit = await api('/instances?limit=0');
    expect(invalidLimit.response.status).toBe(400);
    const invalidCursor = await api('/instances?cursor=invalid');
    expect(invalidCursor.response.status).toBe(400);
    expect(invalidCursor.body).toEqual({ error: 'cursor is invalid' });
  });

  it('atomically creates bounded instance batches', async () => {
    const batchBuilder = await signupBuilder('instance-batch-builder');
    await createGreenbeltLandlet('instance-batch-landlet');
    const claimed = await api('/landlets/instance-batch-landlet/claim', batchBuilder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);
    const created = await api('/instances/batch', batchBuilder.session({
      method: 'POST',
      body: JSON.stringify({ instances: [
        { instanceId: 'instance-batch-a', landletId: 'instance-batch-landlet', templateId: 'placeholder-chair', x: 1, y: 2 },
        { instanceId: 'instance-batch-b', landletId: 'instance-batch-landlet', templateId: 'placeholder-tree', x: 3, y: 4 },
      ] }),
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.instances.map((instance) => instance.instanceId)).toEqual([
      'instance-batch-a', 'instance-batch-b',
    ]);
    expect(created.body.instances.every((instance) => instance.createdAt && instance.updatedAt)).toBe(true);

    const replaced = await api('/instances/batch', batchBuilder.session({
      method: 'PUT',
      body: JSON.stringify({ instances: [
        { instanceId: 'instance-batch-a', landletId: 'instance-batch-landlet', templateId: 'placeholder-tree', x: 10, y: 20 },
        { instanceId: 'instance-batch-c', landletId: 'instance-batch-landlet', templateId: 'placeholder-chair', x: 5, y: 6 },
      ] }),
    }));
    expect(replaced.response.status).toBe(200);
    expect(replaced.body.instances.every((instance) => instance.createdAt && instance.updatedAt)).toBe(true);
    expect((await api('/instances/instance-batch-a')).body.instance).toMatchObject({
      templateId: 'placeholder-tree', x: 10, y: 20,
    });
    expect((await api('/instances/instance-batch-c')).response.status).toBe(200);

    const missingReference = await api('/instances/batch', batchBuilder.session({
      method: 'PUT',
      body: JSON.stringify({ instances: [
        { instanceId: 'instance-batch-a', landletId: 'instance-batch-landlet', templateId: 'placeholder-chair', x: 99, y: 99 },
        { instanceId: 'instance-batch-never-inserted', landletId: 'instance-batch-landlet', templateId: 'missing-template', x: 0, y: 0 },
      ] }),
    }));
    expect(missingReference.response.status).toBe(400);
    expect((await api('/instances/instance-batch-never-inserted')).response.status).toBe(404);
    expect((await api('/instances/instance-batch-a')).body.instance.x).toBe(10);

    const conflict = await api('/instances/batch', batchBuilder.session({
      method: 'POST',
      body: JSON.stringify({ instances: [
        { instanceId: 'instance-batch-new', landletId: 'instance-batch-landlet', templateId: 'placeholder-chair', x: 0, y: 0 },
        { instanceId: 'instance-batch-a', landletId: 'instance-batch-landlet', templateId: 'placeholder-chair', x: 0, y: 0 },
      ] }),
    }));
    expect(conflict.response.status).toBe(409);
    expect((await api('/instances/instance-batch-new')).response.status).toBe(404);
    expect((await api('/instances/batch', batchBuilder.session({
      method: 'POST', body: JSON.stringify({ instances: [] }),
    }))).response.status).toBe(400);
    expect((await api('/instances/batch', batchBuilder.session({
      method: 'POST',
      body: JSON.stringify({ instances: Array.from({ length: 101 }, (_, index) => ({
        instanceId: `too-many-${index}`, templateId: 'placeholder-chair', x: 0, y: 0,
      })) }),
    }))).response.status).toBe(400);
    expect((await api('/instances/batch', batchBuilder.session({
      method: 'POST',
      body: JSON.stringify({ instances: [
        { instanceId: 'duplicate-batch-id', templateId: 'placeholder-chair', x: 0, y: 0 },
        { instanceId: 'duplicate-batch-id', templateId: 'placeholder-tree', x: 0, y: 0 },
      ] }),
    }))).response.status).toBe(400);

    const missingDelete = await api('/instances/batch', batchBuilder.session({
      method: 'DELETE',
      body: JSON.stringify({ instanceIds: ['instance-batch-a', 'missing-instance'] }),
    }));
    expect(missingDelete.response.status).toBe(404);
    expect((await api('/instances/instance-batch-a')).response.status).toBe(200);
    const removed = await api('/instances/batch', batchBuilder.session({
      method: 'DELETE',
      body: JSON.stringify({ instanceIds: ['instance-batch-b', 'instance-batch-c'] }),
    }));
    expect(removed.response.status).toBe(200);
    expect(removed.body.deletedInstanceIds).toEqual(['instance-batch-b', 'instance-batch-c']);
    expect((await api('/instances/instance-batch-b')).response.status).toBe(404);
    expect((await api('/instances/instance-batch-c')).response.status).toBe(404);
    expect((await api('/instances/batch', batchBuilder.session({
      method: 'DELETE', body: JSON.stringify({ instanceIds: ['instance-batch-a', 'instance-batch-a'] }),
    }))).response.status).toBe(400);
    expect((await api('/instances/batch', batchBuilder.session({
      method: 'DELETE', body: JSON.stringify({ instanceIds: [] }),
    }))).response.status).toBe(400);
    expect((await api('/instances/batch', {
      method: 'DELETE', body: JSON.stringify({ instanceIds: Array.from({ length: 101 }, (_, index) => `delete-${index}`) }),
    })).response.status).toBe(400);
  });

  it('checks ownership of every distinct landlet in an instance batch, not just one of them', async () => {
    const ownerBuilder = await signupBuilder('instance-batch-owner');
    const otherBuilder = await signupBuilder('instance-batch-other');
    await createGreenbeltLandlet('instance-batch-owned-landlet');
    await createGreenbeltLandlet('instance-batch-other-landlet');
    expect((await api('/landlets/instance-batch-owned-landlet/claim', ownerBuilder.session({ method: 'POST' }))).response.status).toBe(200);
    expect((await api('/landlets/instance-batch-other-landlet/claim', otherBuilder.session({ method: 'POST' }))).response.status).toBe(200);

    const seeded = await api('/instances/batch', ownerBuilder.session({
      method: 'POST',
      body: JSON.stringify({ instances: [
        { instanceId: 'instance-batch-owned-seed', landletId: 'instance-batch-owned-landlet', templateId: 'placeholder-chair', x: 0, y: 0 },
      ] }),
    }));
    expect(seeded.response.status).toBe(201);

    // otherBuilder owns instance-batch-other-landlet but not
    // instance-batch-owned-landlet — a batch spanning both must be rejected
    // even though otherBuilder does own one of the two landlets involved.
    const mixedCreate = await api('/instances/batch', otherBuilder.session({
      method: 'POST',
      body: JSON.stringify({ instances: [
        { instanceId: 'instance-batch-other-new', landletId: 'instance-batch-other-landlet', templateId: 'placeholder-chair', x: 0, y: 0 },
        { instanceId: 'instance-batch-owned-new', landletId: 'instance-batch-owned-landlet', templateId: 'placeholder-chair', x: 0, y: 0 },
      ] }),
    }));
    expect(mixedCreate.response.status).toBe(403);
    expect((await api('/instances/instance-batch-other-new')).response.status).toBe(404);
    expect((await api('/instances/instance-batch-owned-new')).response.status).toBe(404);

    const mixedDelete = await api('/instances/batch', otherBuilder.session({
      method: 'DELETE',
      body: JSON.stringify({ instanceIds: ['instance-batch-owned-seed'] }),
    }));
    expect(mixedDelete.response.status).toBe(403);
    expect((await api('/instances/instance-batch-owned-seed')).response.status).toBe(200);
  });

  it('claims an available greenbelt landlet', async () => {
    const created = await createGreenbeltLandlet('claimable-landlet');
    expect(created.response.status).toBe(201);

    const builder = await signupBuilder('claimable-landlet-builder');
    const claimed = await api('/landlets/claimable-landlet/claim', builder.session({ method: 'POST' }));

    expect(claimed.response.status).toBe(200);
    expect(claimed.body.landlet).toMatchObject({
      landletId: 'claimable-landlet',
      status: 'claimed',
      ownerBuilderId: builder.builderId,
    });
    expect(claimed.body.landlet.claimableAt).not.toBeNull();
  });

  it('rejects a second starter claim by the same builder', async () => {
    await createGreenbeltLandlet('first-landlet');
    await createGreenbeltLandlet('second-landlet');
    const builder = await signupBuilder('single-landlet-builder');

    const first = await api('/landlets/first-landlet/claim', builder.session({ method: 'POST' }));
    expect(first.response.status).toBe(200);

    const second = await api('/landlets/second-landlet/claim', builder.session({ method: 'POST' }));
    expect(second.response.status).toBe(409);
    expect(second.body).toEqual({ error: 'Builder already owns a claimed landlet' });
  });

  it('rejects unavailable, missing, and malformed claims', async () => {
    await createGreenbeltLandlet('contested-landlet');
    const winningBuilder = await signupBuilder('winning-builder');
    const otherBuilder = await signupBuilder('other-builder');
    await api('/landlets/contested-landlet/claim', winningBuilder.session({ method: 'POST' }));

    const unavailable = await api('/landlets/contested-landlet/claim', otherBuilder.session({ method: 'POST' }));
    expect(unavailable.response.status).toBe(409);
    expect(unavailable.body).toEqual({ error: 'Landlet is not available to claim' });

    const missing = await api('/landlets/does-not-exist/claim', otherBuilder.session({ method: 'POST' }));
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Landlet not found' });

    // builderId is no longer a client-suppliable field at all — claiming
    // always acts as whoever is logged in — so the "malformed claim" case
    // this sub-test used to cover (a missing builderId in the body) no
    // longer exists. What replaces it: claiming with no session at all.
    const unauthenticated = await api('/landlets/contested-landlet/claim', { method: 'POST' });
    expect(unauthenticated.response.status).toBe(401);
  });

  // #218 (docs/SPEC.md §1's "Water cannot be owned"): a landlet's landType
  // is a separate, orthogonal concept from its lifecycle status — this
  // confirms the claim endpoint actually enforces it, not just that the
  // field round-trips.
  it('rejects claiming a water landlet even while it is otherwise greenbelt and unowned', async () => {
    const created = await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'water-landlet',
        name: 'Test water landlet',
        areaM2: 1000,
        status: 'greenbelt',
        landType: 'water',
      }),
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.landlet.landType).toBe('water');

    const builder = await signupBuilder('water-claim-builder');
    const claimed = await api('/landlets/water-landlet/claim', builder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(409);
    expect(claimed.body).toEqual({ error: 'Water cannot be claimed' });
  });

  it('defaults landType to buildable and rejects an invalid value', async () => {
    const defaulted = await createGreenbeltLandlet('default-land-type-landlet');
    expect(defaulted.body.landlet.landType).toBe('buildable');

    const invalid = await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'invalid-land-type-landlet',
        name: 'Invalid land type',
        areaM2: 1000,
        landType: 'lava',
      }),
    }));
    expect(invalid.response.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'landType must be buildable or water' });
  });

  it('excludes water landlets from the greenbelt count/ratio but includes them in total', async () => {
    const before = (await api('/world')).body.world.landletCounts;

    await createGreenbeltLandlet('water-count-buildable-landlet');
    await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'water-count-water-landlet',
        name: 'Water count water landlet',
        areaM2: 1000,
        status: 'greenbelt',
        landType: 'water',
      }),
    }));

    const after = (await api('/world')).body.world.landletCounts;
    expect(after.total).toBe(before.total + 2);
    expect(after.greenbelt).toBe(before.greenbelt + 1);
    expect(after.water).toBe((before.water || 0) + 1);
  });

  it('returns useful client errors for malformed JSON and D1 conflicts', async () => {
    const malformedJson = await api('/landlets', adminSession({
      method: 'POST',
      body: '{',
    }));
    expect(malformedJson.response.status).toBe(400);
    expect(malformedJson.body).toEqual({ error: 'Request body is not valid JSON' });

    const duplicateTemplate = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'placeholder-tree',
        name: 'Duplicate tree',
        color: '#008000',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(duplicateTemplate.response.status).toBe(409);
    expect(duplicateTemplate.body).toEqual({ error: 'Resource already exists' });

    const instanceBody = JSON.stringify({
      instanceId: 'invalid-reference-instance',
      landletId: 'starter-landlet',
      templateId: 'missing-template',
      x: 0,
      y: 0,
    });

    // Auth is checked before the templateId/landletId reference assertions
    // below (#86) — an unauthenticated caller gets 401, not a 400 that
    // would let them enumerate which reference IDs exist without logging in.
    const unauthenticated = await api('/instances', { method: 'POST', body: instanceBody });
    expect(unauthenticated.response.status).toBe(401);

    const instanceBuilder = await signupBuilder('missing-reference-builder');
    const missingReference = await api('/instances', instanceBuilder.session({ method: 'POST', body: instanceBody }));
    // /api/instances pre-checks references explicitly (assertReferenceExists
    // in worker/index.js) for a precise 400 instead of relying on the
    // generic FK-constraint fallback other routes use.
    expect(missingReference.response.status).toBe(400);
    expect(missingReference.body).toEqual({
      error: 'templateId "missing-template" does not exist',
    });
  });

  // Found via backlog audit (#318): priceCents had no upper bound and used
  // Number.isInteger rather than Number.isSafeInteger, letting a value past
  // MAX_MONEY_CENTS (or past safe-integer range entirely) through — a
  // seller could set an astronomical priceCents on their own template and
  // self-purchase it once to mint an outsized higgles_balance_cents credit.
  it('rejects a priceCents over the money-field cap, and a non-safe-integer value', async () => {
    const overCap = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'price-cap-over-test',
        name: 'Price cap over test',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents: 100_000_001,
      }),
    });
    expect(overCap.response.status).toBe(400);

    const notSafe = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'price-cap-unsafe-test',
        name: 'Price cap unsafe test',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents: Number.MAX_SAFE_INTEGER + 1,
      }),
    });
    expect(notSafe.response.status).toBe(400);

    const atCap = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'price-cap-at-test',
        name: 'Price cap at test',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents: 100_000_000,
      }),
    });
    expect(atCap.response.status).toBe(201);
    expect(atCap.body.template.priceCents).toBe(100_000_000);
  });

  // Found via backlog audit (#375): modelUrl had no format check at all —
  // assertUploadedModelExists only validates a `/uploads/`-prefixed value
  // and silently no-ops for anything else, so an arbitrary external URL
  // sailed straight through into a stored template. src/main.js's model
  // loader then fetches template.modelUrl unconditionally from the browser
  // of every shopper/builder who loads a lándlet with that template placed
  // on it — a real SSRF-shaped hole. Only "absent" and a real /uploads/
  // reference are legitimate.
  it('rejects a modelUrl that does not reference an uploaded model', async () => {
    const externalUrl = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'model-url-external-test',
        name: 'External model URL test',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        modelUrl: 'https://attacker.example/track.glb',
      }),
    });
    expect(externalUrl.response.status).toBe(400);

    const nonString = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'model-url-non-string-test',
        name: 'Non-string model URL test',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        modelUrl: 12345,
      }),
    });
    expect(nonString.response.status).toBe(400);

    const omitted = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'model-url-omitted-test',
        name: 'Omitted model URL test',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(omitted.response.status).toBe(201);
    expect(omitted.body.template.modelUrl).toBeNull();

    // An update to an existing (omitted-modelUrl) template is checked the
    // same way — the vulnerability applied equally to PATCH.
    const patchedExternal = await api('/catalog/model-url-omitted-test', {
      method: 'PATCH',
      body: JSON.stringify({ modelUrl: 'https://attacker.example/track.glb' }),
    });
    expect(patchedExternal.response.status).toBe(400);
  });

  it('atomically replaces a landlet draft', async () => {
    const draftBuilder = await signupBuilder('draft-landlet-builder');
    await api('/landlets', draftBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'draft-landlet', name: 'Draft landlet', areaM2: 1000,
        status: 'claimed', ownerBuilderId: draftBuilder.builderId,
      }),
    }));

    const replaced = await api('/landlets/draft-landlet/draft', draftBuilder.session({
      method: 'PUT',
      body: JSON.stringify({
        versionName: 'Initial furnished draft',
        instances: [
          { instanceId: 'draft-tree', templateId: 'placeholder-tree', x: 1, y: 2, z: 0, rotationZ: 0.25 },
          { instanceId: 'draft-chair', templateId: 'placeholder-chair', x: 3, y: 4, z: 0, rotationZ: 0.5 },
        ],
      }),
    }));
    expect(replaced.response.status).toBe(200);
    expect(replaced.body.instances).toHaveLength(2);
    expect(replaced.body.instances.map((instance) => instance.instanceId).sort()).toEqual(['draft-chair', 'draft-tree']);
    expect(replaced.body.instances.every((instance) => instance.landletId === 'draft-landlet')).toBe(true);
    expect(replaced.body.version).toMatchObject({
      versionNumber: 1,
      name: 'Initial furnished draft',
      instanceCount: 2,
    });

    const failed = await api('/landlets/draft-landlet/draft', draftBuilder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [
          { instanceId: 'broken-instance', templateId: 'missing-template', x: 0, y: 0 },
        ],
      }),
    }));
    expect(failed.response.status).toBe(409);

    const preserved = await api('/landlets/draft-landlet/draft');
    expect(preserved.response.status).toBe(200);
    expect(preserved.body.instances.map((instance) => instance.instanceId).sort()).toEqual(['draft-chair', 'draft-tree']);

    const duplicates = await api('/landlets/draft-landlet/draft', draftBuilder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [
          { instanceId: 'same-id', templateId: 'placeholder-tree', x: 0, y: 0 },
          { instanceId: 'same-id', templateId: 'placeholder-chair', x: 1, y: 1 },
        ],
      }),
    }));
    expect(duplicates.response.status).toBe(400);
    expect(duplicates.body).toEqual({ error: 'instanceId values must be unique' });

    const cleared = await api('/landlets/draft-landlet/draft', draftBuilder.session({
      method: 'PUT',
      body: JSON.stringify({ instances: [] }),
    }));
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.instances).toEqual([]);
    expect(cleared.body.version).toMatchObject({
      versionNumber: 2,
      name: 'Version 2',
      instanceCount: 0,
    });

    const versions = await api('/landlets/draft-landlet/versions');
    expect(versions.body.versions.map((version) => version.versionNumber)).toEqual([2, 1]);
    expect(versions.body.nextCursor).toBeNull();

    const newest = await api('/landlets/draft-landlet/versions?limit=1');
    expect(newest.body.versions.map((version) => version.versionNumber)).toEqual([2]);
    expect(newest.body.nextCursor).not.toBeNull();
    const oldest = await api(`/landlets/draft-landlet/versions?limit=1&cursor=${encodeURIComponent(newest.body.nextCursor)}`);
    expect(oldest.body.versions.map((version) => version.versionNumber)).toEqual([1]);
    expect(oldest.body.nextCursor).toBeNull();

    const invalidLimit = await api('/landlets/draft-landlet/versions?limit=101');
    expect(invalidLimit.response.status).toBe(400);
    const invalidCursor = await api('/landlets/draft-landlet/versions?cursor=invalid');
    expect(invalidCursor.response.status).toBe(400);
    expect(invalidCursor.body).toEqual({ error: 'cursor is invalid' });
  });

  // A draft save used to DELETE FROM placed_instances WHERE landlet_id = ?
  // then re-INSERT fresh rows — sign_posts/calendar_events both cascade-
  // delete on their own instance_id (migrations/0041/0042), so even
  // re-saving the *same* instance_id wiped every post/event on it, and the
  // re-insert never carried is_community_sign/is_community_calendar at all
  // (silently resetting both to false). Now an upsert-by-instance_id, with
  // a real DELETE only for instances genuinely dropped from the new set.
  it('preserves community sign posts and flags across a draft save, and only removes genuinely-dropped instances', async () => {
    const draftSignBuilder = await signupBuilder('draft-sign-builder');
    await api('/landlets', draftSignBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'draft-sign-landlet', name: 'Draft sign landlet', areaM2: 1000,
        status: 'claimed', ownerBuilderId: draftSignBuilder.builderId,
      }),
    }));

    const firstSave = await api('/landlets/draft-sign-landlet/draft', draftSignBuilder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [
          { instanceId: 'draft-sign-a', templateId: 'placeholder-tree', x: 1, y: 1, isCommunitySign: true },
        ],
      }),
    }));
    expect(firstSave.response.status).toBe(200);
    expect(firstSave.body.instances[0].isCommunitySign).toBe(true);

    const posted = await api('/instances/draft-sign-a/posts', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', text: 'Great spot!' }),
    });
    expect(posted.response.status).toBe(201);

    // Re-save the same instance (still flagged) alongside a new one.
    const secondSave = await api('/landlets/draft-sign-landlet/draft', draftSignBuilder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [
          { instanceId: 'draft-sign-a', templateId: 'placeholder-tree', x: 1, y: 1, isCommunitySign: true },
          { instanceId: 'draft-sign-b', templateId: 'placeholder-chair', x: 2, y: 2 },
        ],
      }),
    }));
    expect(secondSave.response.status).toBe(200);
    expect(secondSave.body.instances.map((instance) => instance.instanceId).sort()).toEqual(['draft-sign-a', 'draft-sign-b']);
    const savedA = secondSave.body.instances.find((instance) => instance.instanceId === 'draft-sign-a');
    expect(savedA.isCommunitySign).toBe(true);

    // The post survives — it was never actually deleted, since the
    // instance never really went away.
    const postsAfterResave = await api('/instances/draft-sign-a/posts');
    expect(postsAfterResave.response.status).toBe(200);
    expect(postsAfterResave.body.posts).toHaveLength(1);
    expect(postsAfterResave.body.posts[0].text).toBe('Great spot!');

    // Now genuinely drop draft-sign-a from the set — it should actually be
    // deleted this time, posts and all.
    const thirdSave = await api('/landlets/draft-sign-landlet/draft', draftSignBuilder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [
          { instanceId: 'draft-sign-b', templateId: 'placeholder-chair', x: 2, y: 2 },
        ],
      }),
    }));
    expect(thirdSave.response.status).toBe(200);
    expect(thirdSave.body.instances.map((instance) => instance.instanceId)).toEqual(['draft-sign-b']);

    const droppedInstance = await api('/instances/draft-sign-a');
    expect(droppedInstance.response.status).toBe(404);
    const postsAfterDrop = await api('/instances/draft-sign-a/posts');
    expect(postsAfterDrop.response.status).toBe(404);
  });

  it('saves immutable landlet versions and activates a selected snapshot', async () => {
    // A dedicated owned landlet rather than 'starter-landlet' itself — the
    // mosaic/world-gen test later in this file relies on starter-landlet
    // staying unclaimed until it runs, so version/activate calls (which now
    // require session-authenticated ownership) go against a landlet made
    // just for this test instead.
    const versionBuilder = await signupBuilder('versioned-landlet-builder');
    await api('/landlets', versionBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'versioned-landlet', name: 'Versioned landlet', areaM2: 1000,
        status: 'claimed', ownerBuilderId: versionBuilder.builderId,
      }),
    }));

    const instance = await api('/instances', versionBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'versioned-tree',
        landletId: 'versioned-landlet',
        templateId: 'placeholder-tree',
        x: 3,
        y: 4,
        z: 0,
        rotationZ: 0.5,
      }),
    }));
    expect(instance.response.status).toBe(201);

    const saved = await api('/landlets/versioned-landlet/versions', versionBuilder.session({
      method: 'POST',
      body: JSON.stringify({ name: 'Tree by the entrance' }),
    }));
    expect(saved.response.status).toBe(201);
    expect(saved.body.version).toMatchObject({
      landletId: 'versioned-landlet',
      versionNumber: 1,
      name: 'Tree by the entrance',
      instanceCount: 1,
    });

    const unpublished = await api('/landlets/versioned-landlet/live');
    expect(unpublished.response.status).toBe(200);
    expect(unpublished.body).toMatchObject({
      published: false,
      version: null,
      instances: [],
    });

    await api('/instances/versioned-tree', versionBuilder.session({
      method: 'PATCH',
      body: JSON.stringify({ x: 99 }),
    }));

    const versionId = saved.body.version.versionId;
    const snapshot = await api(`/landlets/versioned-landlet/versions/${versionId}`);
    expect(snapshot.response.status).toBe(200);
    expect(snapshot.body.version.instances).toHaveLength(1);
    expect(snapshot.body.version.instances[0]).toMatchObject({
      instanceId: 'versioned-tree',
      templateId: 'placeholder-tree',
      x: 3,
      y: 4,
      rotationZ: 0.5,
    });

    const activated = await api(`/landlets/versioned-landlet/versions/${versionId}/activate`, versionBuilder.session({
      method: 'POST',
    }));
    expect(activated.response.status).toBe(200);
    expect(activated.body.landlet.activeVersionId).toBe(versionId);

    const live = await api('/landlets/versioned-landlet/live');
    expect(live.response.status).toBe(200);
    expect(live.body.published).toBe(true);
    expect(live.body.version).toMatchObject({
      versionId,
      name: 'Tree by the entrance',
      instanceCount: 1,
    });
    expect(live.body.instances).toHaveLength(1);
    expect(live.body.instances[0]).toMatchObject({
      instanceId: 'versioned-tree',
      x: 3,
      y: 4,
    });

    const versions = await api('/landlets/versioned-landlet/versions');
    expect(versions.response.status).toBe(200);
    expect(versions.body.versions).toHaveLength(1);
    expect(versions.body.versions[0].versionId).toBe(versionId);
  });

  // #480: `name`/`versionName` on a landlet version used plain stringValue
  // (no upper bound), unlike every other free-text label field in this
  // codebase (authorLabel/buyerLabel #337, bundle name #358) — the same
  // gap, just two different endpoints that both create a version.
  it('rejects a landlet version name over the length cap, on both the Publish endpoint and a draft save', async () => {
    const builder = await signupBuilder('version-name-too-long-builder');
    await api('/landlets', builder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'version-name-too-long-landlet', name: 'Version name cap landlet', areaM2: 1000,
        status: 'claimed', ownerBuilderId: builder.builderId,
      }),
    }));

    const rejectedPublish = await api('/landlets/version-name-too-long-landlet/versions', builder.session({
      method: 'POST', body: JSON.stringify({ name: 'x'.repeat(101) }),
    }));
    expect(rejectedPublish.response.status).toBe(400);

    const acceptedPublish = await api('/landlets/version-name-too-long-landlet/versions', builder.session({
      method: 'POST', body: JSON.stringify({ name: 'x'.repeat(100) }),
    }));
    expect(acceptedPublish.response.status).toBe(201);

    const rejectedDraft = await api('/landlets/version-name-too-long-landlet/draft', builder.session({
      method: 'PUT',
      body: JSON.stringify({ instances: [], versionName: 'x'.repeat(101) }),
    }));
    expect(rejectedDraft.response.status).toBe(400);

    const acceptedDraft = await api('/landlets/version-name-too-long-landlet/draft', builder.session({
      method: 'PUT',
      body: JSON.stringify({ instances: [], versionName: 'x'.repeat(100) }),
    }));
    expect(acceptedDraft.response.status).toBe(200);
  });

  // migrations/0060: version_instances never got is_community_sign/
  // is_community_calendar when 0041/0042 added them to placed_instances
  // (unlike crop_json/scale, which 0034/0036 added to both tables) — a
  // published/live lándlet lost every community sign and calendar entirely.
  it('carries isCommunitySign/isCommunityCalendar into a saved version and the live landlet', async () => {
    const flagBuilder = await signupBuilder('versioned-flags-builder');
    await api('/landlets', flagBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'versioned-flags-landlet', name: 'Versioned flags landlet', areaM2: 1000,
        status: 'claimed', ownerBuilderId: flagBuilder.builderId,
      }),
    }));
    await api('/instances', flagBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'versioned-flags-sign',
        landletId: 'versioned-flags-landlet',
        templateId: 'placeholder-tree',
        x: 1,
        y: 1,
        isCommunitySign: true,
        isCommunityCalendar: true,
      }),
    }));

    const saved = await api('/landlets/versioned-flags-landlet/versions', flagBuilder.session({
      method: 'POST',
      body: JSON.stringify({}),
    }));
    expect(saved.response.status).toBe(201);
    const versionId = saved.body.version.versionId;

    const snapshot = await api(`/landlets/versioned-flags-landlet/versions/${versionId}`);
    expect(snapshot.body.version.instances[0]).toMatchObject({
      instanceId: 'versioned-flags-sign',
      isCommunitySign: true,
      isCommunityCalendar: true,
    });

    await api(`/landlets/versioned-flags-landlet/versions/${versionId}/activate`, flagBuilder.session({
      method: 'POST',
    }));
    const live = await api('/landlets/versioned-flags-landlet/live');
    expect(live.body.instances[0]).toMatchObject({
      instanceId: 'versioned-flags-sign',
      isCommunitySign: true,
      isCommunityCalendar: true,
    });
  });

  it('allocates distinct sequential numbers to concurrent version saves', async () => {
    const concurrentBuilder = await signupBuilder('concurrent-versions-builder');
    await api('/landlets', concurrentBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'concurrent-versions', name: 'Concurrent versions', areaM2: 1000,
        status: 'claimed', ownerBuilderId: concurrentBuilder.builderId,
      }),
    }));

    const saves = await Promise.all([
      api('/landlets/concurrent-versions/versions', concurrentBuilder.session({
        method: 'POST',
        body: JSON.stringify({}),
      })),
      api('/landlets/concurrent-versions/versions', concurrentBuilder.session({
        method: 'POST',
        body: JSON.stringify({}),
      })),
    ]);

    expect(saves.every(({ response }) => response.status === 201)).toBe(true);
    expect(saves.map(({ body }) => body.version.versionNumber).sort()).toEqual([1, 2]);
    expect(saves.map(({ body }) => body.version.name).sort()).toEqual(['Version 1', 'Version 2']);
  });

  it('makes completed enclosed generation claimable and handles retries', async () => {
    await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'enclosed-generation',
        name: 'Enclosed generation',
        areaM2: 4,
        center: { x: 0, y: 0 },
        status: 'generating',
      }),
    }));

    const completed = await api('/landlets/enclosed-generation/generation-complete', adminSession({ method: 'POST' }));
    expect(completed.response.status).toBe(200);
    expect(completed.body.landlet.status).toBe('greenbelt');
    expect(completed.body.landlet.generatedAt).not.toBeNull();
    expect(completed.body.landlet.claimableAt).not.toBeNull();

    const retried = await api('/landlets/enclosed-generation/generation-complete', adminSession({ method: 'POST' }));
    expect(retried.response.status).toBe(200);
    expect(retried.body.landlet.generatedAt).toBe(completed.body.landlet.generatedAt);

    const notGeneratingBuilder = await signupBuilder('not-generating-owner');
    await api('/landlets', notGeneratingBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'not-generating-landlet', name: 'Not generating', areaM2: 4,
        status: 'claimed', ownerBuilderId: notGeneratingBuilder.builderId,
      }),
    }));
    const invalid = await api('/landlets/not-generating-landlet/generation-complete', adminSession({ method: 'POST' }));
    expect(invalid.response.status).toBe(409);
    expect(invalid.body).toEqual({ error: 'Landlet is not currently generating' });
  });

  it('filters and cursor-paginates landlets in stable order', async () => {
    for (const landletId of ['landlet-page-b', 'landlet-page-a']) {
      await api('/landlets', adminSession({
        method: 'POST',
        body: JSON.stringify({ landletId, name: landletId, areaM2: 4, status: 'generating' }),
      }));
    }

    const ids = [];
    let cursor = null;
    do {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page = await api(`/landlets?status=generating&limit=1${suffix}`);
      expect(page.response.status).toBe(200);
      expect(page.body.landlets).toHaveLength(1);
      expect(page.body.landlets[0].status).toBe('generating');
      ids.push(page.body.landlets[0].landletId);
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(ids).toEqual(['landlet-page-b', 'landlet-page-a']);

    const pageOwnerBuilder = await signupBuilder('owned-page-owner');
    await api('/landlets', pageOwnerBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'owned-page-landlet',
        name: 'Owned page landlet',
        areaM2: 4,
        status: 'claimed',
        ownerBuilderId: pageOwnerBuilder.builderId,
      }),
    }));
    // Padded with spaces to confirm the query param is trimmed before
    // filtering, same as the original literal-id version of this test.
    const owned = await api(`/landlets?status=claimed&ownerBuilderId=${encodeURIComponent(`  ${pageOwnerBuilder.builderId}  `)}`);
    expect(owned.body.landlets.map(({ landletId }) => landletId)).toEqual(['owned-page-landlet']);
    expect(owned.body.nextCursor).toBeNull();

    const invalidStatus = await api('/landlets?status=available');
    expect(invalidStatus.response.status).toBe(400);
    expect(invalidStatus.body).toEqual({ error: 'status must be greenbelt, claimed, or generating' });
    const invalidOwner = await api('/landlets?ownerBuilderId=');
    expect(invalidOwner.response.status).toBe(400);
    const invalidLimit = await api('/landlets?limit=0');
    expect(invalidLimit.response.status).toBe(400);
    const invalidCursor = await api('/landlets?cursor=not-base64');
    expect(invalidCursor.response.status).toBe(400);
    expect(invalidCursor.body).toEqual({ error: 'cursor is invalid' });
  });

  it('starts generation immediately for candidates already overlapping the world', async () => {
    const created = await api('/land-candidates', adminSession({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'inside-candidate',
        name: 'Inside candidate',
        areaM2: 4,
        center: { x: 0, y: 0 },
      }),
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.candidate.materializedAt).not.toBeNull();
    expect(created.body.landlet).toMatchObject({
      landletId: 'inside-candidate',
      status: 'generating',
      generatedAt: null,
      claimableAt: null,
    });
    const stored = await env.DB.prepare(`
      SELECT min_world_radius_m FROM landlet_candidates WHERE landlet_id = 'inside-candidate'
    `).first();
    expect(stored.min_world_radius_m).toBe(0);
  });

  it('deletes only pending land candidates', async () => {
    await api('/land-candidates', adminSession({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'cancelled-candidate',
        name: 'Cancelled candidate',
        areaM2: 4,
        center: { x: 200, y: 0 },
      }),
    }));
    const deleted = await api('/land-candidates/cancelled-candidate', adminSession({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });
    const absent = await api('/land-candidates/cancelled-candidate');
    expect(absent.response.status).toBe(404);

    const materialized = await api('/land-candidates/inside-candidate', adminSession({ method: 'DELETE' }));
    expect(materialized.response.status).toBe(409);
    expect(materialized.body).toEqual({ error: 'Materialized land candidates cannot be deleted' });
    const landlet = await api('/landlets/inside-candidate');
    expect(landlet.response.status).toBe(200);

    const missing = await api('/land-candidates/missing-candidate', adminSession({ method: 'DELETE' }));
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Land candidate not found' });
  });

  it('procedurally queues an exact-area ring outside the world boundary', async () => {
    const generated = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'generated-ring', count: 6, innerRadiusM: 200 }),
    }));
    expect(generated.response.status).toBe(201);
    expect(generated.body.candidates).toHaveLength(6);
    expect(generated.body.materializedLandletIds).toEqual([]);
    expect(generated.body.readyForGenerationCompletion).toBe(false);
    expect(generated.body.outerRadiusM).toBeGreaterThan(200);
    expect(generated.body.candidates[0]).toMatchObject({
      landletId: 'generated-ring-001',
      areaM2: 1000,
      landClass: 1,
      ringId: 'generated-ring',
      materializedAt: null,
      metadata: { generated: true, generator: 'annular-ring-v1', ringIndex: 0 },
    });

    const listed = await api('/land-candidates/generated-ring-006');
    expect(listed.response.status).toBe(200);
    expect(listed.body.candidate.materializedAt).toBeNull();
    expect(listed.body.candidate.ringId).toBe('generated-ring');

    const ringCandidates = await api('/land-candidates?ringId=generated-ring&limit=100');
    expect(ringCandidates.response.status).toBe(200);
    expect(ringCandidates.body.candidates).toHaveLength(6);
    expect(ringCandidates.body.candidates.every((candidate) => candidate.ringId === 'generated-ring')).toBe(true);
    expect((await api('/land-candidates?ringId=')).response.status).toBe(400);

    const deleteMember = await api('/land-candidates/generated-ring-001', adminSession({ method: 'DELETE' }));
    expect(deleteMember.response.status).toBe(409);
    expect(deleteMember.body.error).toBe('Generated ring candidates cannot be deleted individually');
    const updateMember = await api('/land-candidates/generated-ring-001', adminSession({
      method: 'PATCH',
      body: JSON.stringify({ name: 'Detached member' }),
    }));
    expect(updateMember.response.status).toBe(409);
    expect(updateMember.body.error).toBe('Generated ring candidates cannot be updated individually');

    await expect(env.DB.prepare(`
      UPDATE landlet_candidates SET center_x_m = center_x_m + 1
      WHERE landlet_id = 'generated-ring-001'
    `).run()).rejects.toThrow(/generated ring candidates are immutable/);
    const lifecycleUpdate = await env.DB.prepare(`
      UPDATE landlet_candidates SET materialized_at = materialized_at
      WHERE landlet_id = 'generated-ring-001'
    `).run();
    expect(lifecycleUpdate.meta.changes).toBe(1);

    const conflict = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'overlapping-ring', count: 6, innerRadiusM: 200 }),
    }));
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error).toBe('Generated ring would overlap existing land candidates');

    const mismatchedAdjacent = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'mismatched-adjacent-ring', count: 5, innerRadiusM: generated.body.outerRadiusM }),
    }));
    expect(mismatchedAdjacent.response.status).toBe(409);
    expect(mismatchedAdjacent.body.error).toBe('Adjacent generated rings must use matching boundary seams');

    const adjacent = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'adjacent-ring', count: 6, adjacentToRingId: 'generated-ring' }),
    }));
    expect(adjacent.response.status).toBe(201);
    expect(adjacent.body.innerRadiusM).toBe(generated.body.outerRadiusM);

    const conflictingDerivedInput = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({
        prefix: 'invalid-derived-ring', count: 6, adjacentToRingId: 'adjacent-ring', innerRadiusM: 300,
      }),
    }));
    expect(conflictingDerivedInput.response.status).toBe(400);
    const missingAdjacent = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'missing-adjacent-ring', count: 6, adjacentToRingId: 'missing-ring' }),
    }));
    expect(missingAdjacent.response.status).toBe(404);

    const rings = await env.DB.prepare(`
      SELECT ring_id, candidate_count FROM land_candidate_rings ORDER BY inner_radius_m
    `).all();
    expect(rings.results).toEqual([
      { ring_id: 'generated-ring', candidate_count: 6 },
      { ring_id: 'adjacent-ring', candidate_count: 6 },
    ]);

    const firstPage = await api('/land-candidate-rings?limit=1');
    expect(firstPage.response.status).toBe(200);
    expect(firstPage.body.rings).toHaveLength(1);
    expect(firstPage.body.rings[0]).toMatchObject({ ringId: 'generated-ring', candidateCount: 6 });
    expect(firstPage.body.nextCursor).not.toBeNull();
    const secondPage = await api(`/land-candidate-rings?limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`);
    expect(secondPage.body.rings).toHaveLength(1);
    expect(secondPage.body.rings[0].ringId).toBe('adjacent-ring');
    expect(secondPage.body.nextCursor).toBeNull();
    const childListing = await api('/land-candidate-rings?adjacentToRingId=generated-ring');
    expect(childListing.response.status).toBe(200);
    expect(childListing.body.rings.map((ring) => ring.ringId)).toEqual(['adjacent-ring']);
    expect((await api('/land-candidate-rings?adjacentToRingId=')).response.status).toBe(400);

    const fetchedRing = await api('/land-candidate-rings/adjacent-ring');
    expect(fetchedRing.response.status).toBe(200);
    expect(fetchedRing.body.ring.innerRadiusM).toBe(generated.body.outerRadiusM);
    expect(fetchedRing.body.ring.adjacentToRingId).toBe('generated-ring');
    expect(fetchedRing.body.ring.adjacentChildRingId).toBeNull();
    expect(fetchedRing.body.ring.lifecycle).toEqual({
      storedCandidates: 6,
      pendingCandidates: 6,
      materializedCandidates: 0,
      completedLandlets: 0,
      greenbeltLandlets: 0,
    });
    const fetchedParent = await api('/land-candidate-rings/generated-ring');
    expect(fetchedParent.body.ring.adjacentChildRingId).toBe('adjacent-ring');
    const missingRing = await api('/land-candidate-rings/missing-ring');
    expect(missingRing.response.status).toBe(404);
    expect((await api('/land-candidate-rings?limit=101')).response.status).toBe(400);
    expect((await api('/land-candidate-rings?cursor=invalid')).response.status).toBe(400);

    await expect(env.DB.prepare(`
      INSERT INTO land_candidate_rings
        (ring_id, inner_radius_m, outer_radius_m, candidate_count, distribution, start_angle_rad)
      VALUES ('concurrent-overlap', 201, 202, 3, NULL, 0)
    `).run()).rejects.toThrow(/generated ring radial overlap/);

    await expect(env.DB.prepare(`
      INSERT INTO land_candidate_rings
        (ring_id, inner_radius_m, outer_radius_m, candidate_count, distribution, start_angle_rad,
         boundary_signature, adjacent_to_ring_id)
      VALUES ('bad-parent-ring', 300, 301, 3, NULL, 0, 'bad-signature', 'generated-ring')
    `).run()).rejects.toThrow(/generated ring adjacency parent mismatch/);

    const invalid = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'Bad prefix', count: 2 }),
    }));
    expect(invalid.response.status).toBe(400);
  });

  it('queues a deterministic organic mosaic, folding the origin cell into starter-landlet', async () => {
    const generated = await api('/land-candidates/generate-mosaic', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'organic-patch', count: 16 }),
    }));
    expect(generated.response.status).toBe(201);
    // One of the 16 template cells always covers the world origin — the same
    // point starter-landlet sits on — so it's folded into starter-landlet
    // directly instead of becoming a 16th competing candidate there.
    expect(generated.body.candidates).toHaveLength(15);
    expect(generated.body.candidates.every((candidate) => candidate.areaM2 === 1000)).toBe(true);
    expect(generated.body.candidates.every((candidate) => candidate.polygon.length >= 12)).toBe(true);
    expect(generated.body.candidates.every((candidate) => candidate.metadata.generator === 'organic-mosaic-v1')).toBe(true);
    expect(generated.body.materializedLandletIds.length).toBeGreaterThan(0);
    expect(generated.body.starterLandletId).toBe('starter-landlet');

    const mosaicIndices = generated.body.candidates.map((candidate) => candidate.metadata.mosaicIndex);
    expect(new Set(mosaicIndices).size).toBe(15);

    const starter = await api('/landlets/starter-landlet');
    expect(starter.body.landlet.polygon.length).toBeGreaterThanOrEqual(12);
    expect(starter.body.landlet.metadata.generator).toBe('organic-mosaic-v1');
    expect(mosaicIndices).not.toContain(starter.body.landlet.metadata.mosaicIndex);
    // starter-landlet already existed as a row before this call (unlike its
    // 15 siblings, which are freshly inserted) -- it must still come out
    // the other side greenbelt and claimable just like them, not stuck at
    // whatever status it happened to have before generation.
    expect(starter.body.landlet.status).toBe('greenbelt');
    expect(starter.body.landlet.ownerBuilderId).toBeNull();
    expect(starter.body.landlet.claimableAt).not.toBeNull();

    const centerPlotBuilder = await signupBuilder('center-plot-builder');
    const starterClaim = await api('/landlets/starter-landlet/claim', centerPlotBuilder.session({ method: 'POST' }));
    expect(starterClaim.response.status).toBe(200);
    expect(starterClaim.body.landlet).toMatchObject({
      landletId: 'starter-landlet', status: 'claimed', ownerBuilderId: centerPlotBuilder.builderId,
    });

    const duplicate = await api('/land-candidates/generate-mosaic', adminSession({
      method: 'POST', body: JSON.stringify({ prefix: 'organic-patch', count: 16 }),
    }));
    expect(duplicate.response.status).toBe(409);
    expect((await api('/land-candidates/generate-mosaic', adminSession({
      method: 'POST', body: JSON.stringify({ prefix: 'bad mosaic', count: 8 }),
    }))).response.status).toBe(400);

    // A second, differently-seeded mosaic still covers the same disc around
    // the origin (only the rotation differs) — must be rejected as spatial
    // overlap, not silently allowed to double-stamp the same land.
    const second = await api('/land-candidates/generate-mosaic', adminSession({
      method: 'POST', body: JSON.stringify({ prefix: 'organic-patch-2', count: 16 }),
    }));
    expect(second.response.status).toBe(409);
    expect(second.body.error).toMatch(/overlap/i);

    await env.DB.prepare("DELETE FROM landlet_candidates WHERE landlet_id LIKE 'organic-patch-%'").run();
    await env.DB.prepare("DELETE FROM landlets WHERE landlet_id LIKE 'organic-patch-%'").run();
  });

  it('generates the authoritative power-law mix on request', async () => {
    const generated = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({
        prefix: 'power-law-ring',
        count: 100,
        innerRadiusM: 500,
        distribution: 'power-law',
      }),
    }));
    expect(generated.response.status).toBe(201);
    expect(generated.body.candidates.filter((candidate) => candidate.landClass === 1)).toHaveLength(91);
    expect(generated.body.candidates.filter((candidate) => candidate.landClass === 2)).toHaveLength(9);
    expect(generated.body.candidates.find((candidate) => candidate.landClass === 2).areaM2).toBeGreaterThanOrEqual(1001);

  });

  it('completes generation for a fully materialized ring in one request', async () => {
    const generated = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'completion-ring', count: 3 }),
    }));
    expect(generated.response.status).toBe(201);
    expect(generated.body.materializedLandletIds).toHaveLength(3);
    expect(generated.body.readyForGenerationCompletion).toBe(true);

    const completed = await api('/land-candidate-rings/completion-ring/generation-complete', adminSession({ method: 'POST' }));
    expect(completed.response.status).toBe(200);
    expect(completed.body.landlets).toHaveLength(3);
    expect(completed.body.landlets.every((landlet) => landlet.generatedAt && landlet.status === 'generating')).toBe(true);
    expect(completed.body.ring.lifecycle).toEqual({
      storedCandidates: 3,
      pendingCandidates: 0,
      materializedCandidates: 3,
      completedLandlets: 3,
      greenbeltLandlets: 0,
    });

    const retry = await api('/land-candidate-rings/completion-ring/generation-complete', adminSession({ method: 'POST' }));
    expect(retry.response.status).toBe(200);
    expect(retry.body.landlets.map((landlet) => landlet.generatedAt)).toEqual(
      completed.body.landlets.map((landlet) => landlet.generatedAt),
    );

    const pending = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'pending-completion-ring', count: 3, innerRadiusM: 1000 }),
    }));
    expect(pending.response.status).toBe(201);
    const premature = await api('/land-candidate-rings/pending-completion-ring/generation-complete', adminSession({ method: 'POST' }));
    expect(premature.response.status).toBe(409);
    const missing = await api('/land-candidate-rings/missing-completion-ring/generation-complete', adminSession({ method: 'POST' }));
    expect(missing.response.status).toBe(404);
  });

  it('updates only pending land candidates', async () => {
    await api('/land-candidates', adminSession({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'corrected-candidate',
        name: 'Before correction',
        areaM2: 4,
        center: { x: 210, y: 0 },
        metadata: { revision: 1 },
      }),
    }));
    const updated = await api('/land-candidates/corrected-candidate', adminSession({
      method: 'PATCH',
      body: JSON.stringify({
        landletId: 'ignored-id-change',
        name: 'After correction',
        center: { x: 220, y: 5 },
        metadata: { revision: 2 },
      }),
    }));
    expect(updated.response.status).toBe(200);
    expect(updated.body.candidate).toMatchObject({
      landletId: 'corrected-candidate',
      name: 'After correction',
      areaM2: 4,
      center: { x: 220, y: 5 },
      metadata: { revision: 2 },
      materializedAt: null,
    });
    expect(updated.body.landlet).toBeNull();
    const queuedRadius = await env.DB.prepare(`
      SELECT min_world_radius_m FROM landlet_candidates WHERE landlet_id = 'corrected-candidate'
    `).first();
    expect(queuedRadius.min_world_radius_m).toBeGreaterThan(200);

    const started = await api('/land-candidates/corrected-candidate', adminSession({
      method: 'PATCH',
      body: JSON.stringify({ center: { x: 0, y: 0 } }),
    }));
    expect(started.response.status).toBe(200);
    expect(started.body.candidate.materializedAt).not.toBeNull();
    expect(started.body.landlet).toMatchObject({
      landletId: 'corrected-candidate',
      name: 'After correction',
      status: 'generating',
      center: { x: 0, y: 0 },
    });
    const startedAgain = await api('/land-candidates/corrected-candidate', adminSession({
      method: 'PATCH',
      body: JSON.stringify({ name: 'Too late too' }),
    }));
    expect(startedAgain.response.status).toBe(409);

    const materialized = await api('/land-candidates/inside-candidate', adminSession({
      method: 'PATCH',
      body: JSON.stringify({ name: 'Too late' }),
    }));
    expect(materialized.response.status).toBe(409);
    expect(materialized.body).toEqual({ error: 'Materialized land candidates cannot be updated' });

    const missing = await api('/land-candidates/missing-update', adminSession({
      method: 'PATCH',
      body: JSON.stringify({ name: 'Missing' }),
    }));
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Land candidate not found' });
  });

  it('atomically queues candidate batches and materializes overlapping plots', async () => {
    const created = await api('/land-candidates/batch', adminSession({
      method: 'POST',
      body: JSON.stringify({
        candidates: [
          { landletId: 'batch-inside', name: 'Batch inside', areaM2: 4, center: { x: 0, y: 0 } },
          { landletId: 'batch-outside', name: 'Batch outside', areaM2: 4, center: { x: 100, y: 0 } },
        ],
      }),
    }));

    expect(created.response.status).toBe(201);
    expect(created.body.candidates.map(({ landletId }) => landletId).sort()).toEqual(['batch-inside', 'batch-outside']);
    expect(created.body.landlets).toHaveLength(1);
    expect(created.body.landlets[0]).toMatchObject({ landletId: 'batch-inside', status: 'generating' });
    expect(created.body.candidates.find(({ landletId }) => landletId === 'batch-inside').materializedAt).not.toBeNull();
    expect(created.body.candidates.find(({ landletId }) => landletId === 'batch-outside').materializedAt).toBeNull();

    const invalid = await api('/land-candidates/batch', adminSession({
      method: 'POST',
      body: JSON.stringify({
        candidates: [
          { landletId: 'batch-duplicate', name: 'First', areaM2: 4 },
          { landletId: 'batch-duplicate', name: 'Second', areaM2: 4 },
        ],
      }),
    }));
    expect(invalid.response.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'landletId values must be unique' });

    const absent = await api('/land-candidates/batch', adminSession({
      method: 'POST',
      body: JSON.stringify({ candidates: [] }),
    }));
    expect(absent.response.status).toBe(400);
    expect(absent.body).toEqual({ error: 'candidates must contain at least one item' });

    const conflict = await api('/land-candidates/batch', adminSession({
      method: 'POST',
      body: JSON.stringify({
        candidates: [
          { landletId: 'batch-rolled-back', name: 'Should roll back', areaM2: 4 },
          { landletId: 'batch-inside', name: 'Already exists', areaM2: 4 },
        ],
      }),
    }));
    expect(conflict.response.status).toBe(409);
    const rolledBack = await api('/land-candidates/batch-rolled-back');
    expect(rolledBack.response.status).toBe(404);
  });

  it('filters and cursor-paginates the candidate generation queue', async () => {
    await api('/land-candidates/batch', adminSession({
      method: 'POST',
      body: JSON.stringify({
        candidates: [
          { landletId: 'page-inside', name: 'Page inside', areaM2: 4, center: { x: 0, y: 0 } },
          { landletId: 'page-outside-a', name: 'Page outside A', areaM2: 4, center: { x: 100, y: 0 } },
          { landletId: 'page-outside-b', name: 'Page outside B', areaM2: 4, center: { x: 110, y: 0 } },
        ],
      }),
    }));

    const materialized = await api('/land-candidates?state=materialized');
    expect(materialized.body.candidates.map(({ landletId }) => landletId)).toContain('page-inside');
    expect(materialized.body.candidates.every(({ materializedAt }) => materializedAt !== null)).toBe(true);
    expect(materialized.body.nextCursor).toBeNull();

    const pendingIds = [];
    let cursor = null;
    do {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page = await api(`/land-candidates?state=pending&limit=1${suffix}`);
      expect(page.body.candidates).toHaveLength(1);
      expect(page.body.candidates[0].materializedAt).toBeNull();
      pendingIds.push(page.body.candidates[0].landletId);
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(new Set(pendingIds).size).toBe(pendingIds.length);
    expect(pendingIds).toEqual(expect.arrayContaining(['page-outside-a', 'page-outside-b']));

    const badState = await api('/land-candidates?state=waiting');
    expect(badState.response.status).toBe(400);
    expect(badState.body).toEqual({ error: 'state must be pending or materialized' });
    const badLimit = await api('/land-candidates?limit=101');
    expect(badLimit.response.status).toBe(400);
    const badCursor = await api('/land-candidates?cursor=not-base64');
    expect(badCursor.response.status).toBe(400);
    expect(badCursor.body).toEqual({ error: 'cursor is invalid' });
  }, 15000);

  it('expands the world by one increment and promotes enclosed landlets', async () => {
    const candidate = await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'edge-candidate',
        name: 'Edge candidate',
        areaM2: 4,
        center: { x: 35, y: 0 },
        status: 'generating',
        polygon: [
          { x: -1, y: -1 },
          { x: 1, y: -1 },
          { x: 1, y: 1 },
          { x: -1, y: 1 },
        ],
      }),
    }));
    expect(candidate.response.status).toBe(201);
    const storedRadius = await env.DB.prepare(`
      SELECT max_world_radius_m FROM landlets WHERE landlet_id = 'edge-candidate'
    `).first();
    expect(storedRadius.max_world_radius_m).toBeCloseTo(Math.hypot(36, 1));

    const incompleteCandidate = await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'unfinished-edge-candidate',
        name: 'Unfinished edge candidate',
        areaM2: 4,
        center: { x: 35, y: 5 },
        status: 'generating',
        polygon: [
          { x: -1, y: -1 },
          { x: 1, y: -1 },
          { x: 1, y: 1 },
          { x: -1, y: 1 },
        ],
      }),
    }));
    expect(incompleteCandidate.response.status).toBe(201);

    const queuedCandidate = await api('/land-candidates', adminSession({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'queued-edge-candidate',
        name: 'Queued edge candidate',
        areaM2: 4,
        center: { x: 39, y: 0 },
        polygon: [
          { x: -1, y: -1 },
          { x: 1, y: -1 },
          { x: 1, y: 1 },
          { x: -1, y: 1 },
        ],
      }),
    }));
    expect(queuedCandidate.response.status).toBe(201);
    expect(queuedCandidate.body.candidate.materializedAt).toBeNull();
    expect(queuedCandidate.body.landlet).toBeNull();

    const completed = await api('/landlets/edge-candidate/generation-complete', adminSession({ method: 'POST' }));
    expect(completed.response.status).toBe(200);
    expect(completed.body.landlet.status).toBe('generating');
    expect(completed.body.landlet.generatedAt).not.toBeNull();
    expect(completed.body.landlet.claimableAt).toBeNull();

    const noSession = await api('/world/expand', { method: 'POST' });
    expect(noSession.response.status).toBe(401);
    const nonAdmin = await signupBuilder('non-admin-expander');
    const notAdmin = await api('/world/expand', nonAdmin.session({ method: 'POST' }));
    expect(notAdmin.response.status).toBe(403);

    const configured = await api('/world', adminSession({
      method: 'PATCH',
      body: JSON.stringify({ greenbeltMinRatio: 1 }),
    }));
    const previousRadiusM = configured.body.world.radiusM;

    const expanded = await api('/world/expand', adminSession({ method: 'POST' }));
    expect(expanded.response.status).toBe(200);
    expect(expanded.body.expansion).toMatchObject({
      previousRadiusM,
      newRadiusM: previousRadiusM + 10,
      incrementM: 10,
      promotedLandletIds: ['edge-candidate'],
      startedGeneratingLandletIds: ['queued-edge-candidate'],
      readyRingIds: [],
    });

    const promoted = await api('/landlets/edge-candidate');
    expect(promoted.body.landlet.status).toBe('greenbelt');
    expect(promoted.body.landlet.generatedAt).not.toBeNull();
    expect(promoted.body.landlet.claimableAt).not.toBeNull();

    const unfinished = await api('/landlets/unfinished-edge-candidate');
    expect(unfinished.body.landlet.status).toBe('generating');
    expect(unfinished.body.landlet.generatedAt).toBeNull();
    expect(unfinished.body.landlet.claimableAt).toBeNull();

    const started = await api('/landlets/queued-edge-candidate');
    expect(started.response.status).toBe(200);
    expect(started.body.landlet.status).toBe('generating');
    expect(started.body.landlet.generatedAt).toBeNull();
    expect(started.body.landlet.claimableAt).toBeNull();

    await api('/world', adminSession({
      method: 'PATCH',
      body: JSON.stringify({
        greenbeltMinRatio: expanded.body.world.landletCounts.greenbeltRatio,
      }),
    }));

    const blocked = await api('/world/expand', adminSession({ method: 'POST' }));
    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toEqual({
      error: 'Greenbelt reserve is at or above the expansion threshold',
    });
  });

  // The scheduled() export (see wrangler.jsonc's triggers.crons) is what
  // actually keeps the world growing now — the old player-triggered "Grow
  // the world" button is gone. Invoked directly against the worker module
  // rather than through SELF (which only exposes fetch()), matching
  // Cloudflare's own documented pattern for testing scheduled handlers.
  it('scheduled() is a no-op once the greenbelt reserve already meets its minimum ratio', async () => {
    // The previous test leaves greenbelt_min_ratio set to exactly the
    // world's current ratio (see its own last PATCH) — already "healthy"
    // by definition, so nothing here should change.
    const before = await api('/world');
    const controller = createScheduledController();
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);
    const after = await api('/world');
    expect(after.body.world.radiusM).toBe(before.body.world.radiusM);
  });

  it('scheduled() automatically expands the world to enclose due land when the greenbelt reserve is low', async () => {
    const worldBefore = (await api('/world')).body.world;
    // Placed just past the current boundary, comfortably within one
    // expansion increment — same recipe as "expands the world by one
    // increment" above, just enclosed by the automatic grower instead of
    // a manual /world/expand call.
    const candidateId = 'auto-grow-candidate';
    const created = await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({
        landletId: candidateId,
        name: 'Auto grow candidate',
        areaM2: 4,
        center: { x: worldBefore.radiusM + worldBefore.expansionIncrementM / 2, y: 0 },
        status: 'generating',
        polygon: [
          { x: -1, y: -1 },
          { x: 1, y: -1 },
          { x: 1, y: 1 },
          { x: -1, y: 1 },
        ],
      }),
    }));
    expect(created.response.status).toBe(201);
    const completed = await api(`/landlets/${candidateId}/generation-complete`, adminSession({ method: 'POST' }));
    expect(completed.response.status).toBe(200);
    expect(completed.body.landlet.status).toBe('generating'); // not enclosed yet

    // A ratio of 1 can never actually be satisfied (it would require every
    // landlet in the table to be greenbelt), so this guarantees
    // worldNeedsGrowth sees "needs growth" regardless of whatever other
    // tests in this file have left lying around.
    await env.DB.prepare(
      `UPDATE world_settings SET greenbelt_min_ratio = 1 WHERE world_id = 'default-world'`,
    ).run();

    const controller = createScheduledController();
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const promoted = await api(`/landlets/${candidateId}`);
    expect(promoted.body.landlet.status).toBe('greenbelt');
    expect(promoted.body.landlet.claimableAt).not.toBeNull();
    const worldAfter = (await api('/world')).body.world;
    expect(worldAfter.radiusM).toBeGreaterThan(worldBefore.radiusM);

    // Restore a sane ratio so no later test in this file sees a world
    // that thinks it always needs to grow.
    await env.DB.prepare(
      `UPDATE world_settings SET greenbelt_min_ratio = 0.1 WHERE world_id = 'default-world'`,
    ).run();
  }, 15000);

  it('scheduled() sweeps expired sessions, verification/reset tokens, and stale rate-limit rows', async () => {
    // Two separate accounts so the sweep's selectivity is actually proven —
    // only the expired one's session should disappear, not every session in
    // the table (which would also silently log out the file's shared
    // adminSession and every other builder created so far).
    const expired = await signupBuilder('prune-sweep-expired');
    const stillValid = await signupBuilder('prune-sweep-valid');

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'
         WHERE user_id = (SELECT user_id FROM users WHERE email = ?)`,
      ).bind(expired.email),
      env.DB.prepare(
        `INSERT INTO email_verification_tokens (token_hash, user_id, expires_at)
         SELECT 'prune-sweep-expired-verification', user_id, '2000-01-01T00:00:00.000Z'
         FROM users WHERE email = ?`,
      ).bind(expired.email),
      env.DB.prepare(
        `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at)
         SELECT 'prune-sweep-expired-reset', user_id, '2000-01-01T00:00:00.000Z'
         FROM users WHERE email = ?`,
      ).bind(expired.email),
      env.DB.prepare(
        `INSERT INTO rate_limit_events (bucket_key, created_at) VALUES ('prune-sweep-stale-bucket', 1)`,
      ),
    ]);

    const controller = createScheduledController();
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    expect((await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM sessions WHERE user_id = (SELECT user_id FROM users WHERE email = ?)`,
    ).bind(expired.email).first()).count).toBe(0);
    expect((await api('/builders/me', stillValid.session())).response.status).toBe(200);
    expect((await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM email_verification_tokens WHERE token_hash = 'prune-sweep-expired-verification'`,
    ).first()).count).toBe(0);
    expect((await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM password_reset_tokens WHERE token_hash = 'prune-sweep-expired-reset'`,
    ).first()).count).toBe(0);
    expect((await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM rate_limit_events WHERE bucket_key = 'prune-sweep-stale-bucket'`,
    ).first()).count).toBe(0);
  });
});
