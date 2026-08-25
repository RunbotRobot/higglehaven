import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function api(path, options = {}) {
  const response = await SELF.fetch(`https://higglehaven.test/api${path}`, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  });

  return { response, body: await response.json() };
}

async function createGreenbeltLandlet(landletId) {
  return api('/landlets', {
    method: 'POST',
    body: JSON.stringify({
      landletId,
      name: `Test ${landletId}`,
      areaM2: 1000,
      status: 'greenbelt',
    }),
  });
}

function glbFile({ version = 2, declaredLength, json = '{}' } = {}) {
  const encoded = new TextEncoder().encode(json);
  const chunkLength = Math.ceil(encoded.length / 4) * 4;
  const bytes = new Uint8Array(20 + chunkLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, version, true);
  view.setUint32(8, declaredLength ?? bytes.length, true);
  view.setUint32(12, chunkLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(encoded, 20);
  bytes.fill(0x20, 20 + encoded.length);
  return new File([bytes], 'chair.glb', { type: 'model/gltf-binary' });
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
    const listing = await api('/models?limit=100');
    expect(listing.response.status).toBe(200);
    expect(listing.body.models).toContainEqual(expect.objectContaining({
      modelUrl: uploaded.modelUrl,
      sizeBytes: uploaded.sizeBytes,
      referencedByTemplateIds: [],
      deletable: true,
    }));
    expect(listing.body.nextCursor).toBeNull();
    expect((await api('/models?limit=101')).response.status).toBe(400);
    expect((await api('/models?cursor=')).response.status).toBe(400);
    const storage = await api('/models/storage');
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

    const referencedListing = await api('/models');
    expect(referencedListing.body.models).toContainEqual(expect.objectContaining({
      modelUrl: uploaded.modelUrl,
      referencedByTemplateIds: ['uploaded-delete-test'],
      deletable: false,
    }));

    const referenced = await SELF.fetch(`https://higglehaven.test${uploaded.modelUrl}`, { method: 'DELETE' });
    expect(referenced.status).toBe(409);
    expect(await referenced.json()).toEqual({ error: 'Uploaded model is still referenced by a catalog template' });

    expect((await api('/catalog/uploaded-delete-test', { method: 'DELETE' })).response.status).toBe(200);
    const removed = await SELF.fetch(`https://higglehaven.test${uploaded.modelUrl}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: true });
    expect((await SELF.fetch(`https://higglehaven.test${uploaded.modelUrl}`)).status).toBe(404);
    expect((await SELF.fetch(`https://higglehaven.test${uploaded.modelUrl}`, { method: 'DELETE' })).status).toBe(404);
    const afterRemoval = await api('/models');
    expect(afterRemoval.body.models.some((model) => model.modelUrl === uploaded.modelUrl)).toBe(false);
    const storageAfterRemoval = await api('/models/storage');
    expect(storageAfterRemoval.body.usedBytes).toBe(storage.body.usedBytes - uploaded.sizeBytes);
    expect(storageAfterRemoval.body.objectCount).toBe(storage.body.objectCount - 1);

    const orphanForm = new FormData();
    orphanForm.set('file', glbFile({ json: '{"orphan":true}' }));
    const orphanUpload = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: orphanForm });
    const orphan = await orphanUpload.json();
    const preview = await api('/models/cleanup', {
      method: 'POST',
      body: JSON.stringify({ maxDeletes: 1, dryRun: true }),
    });
    expect(preview.response.status).toBe(200);
    expect(preview.body).toEqual({
      targetModelUrls: [orphan.modelUrl],
      targetCount: 1,
      reclaimedBytes: orphan.sizeBytes,
      completeScan: true,
      dryRun: true,
    });
    expect((await SELF.fetch(`https://higglehaven.test${orphan.modelUrl}`)).status).toBe(200);
    const cleanup = await api('/models/cleanup', {
      method: 'POST',
      body: JSON.stringify({ maxDeletes: 1 }),
    });
    expect(cleanup.response.status).toBe(200);
    expect(cleanup.body).toEqual({
      targetModelUrls: [orphan.modelUrl],
      targetCount: 1,
      reclaimedBytes: orphan.sizeBytes,
      completeScan: true,
      dryRun: false,
    });
    expect((await SELF.fetch(`https://higglehaven.test${orphan.modelUrl}`)).status).toBe(404);
    expect((await api('/models/cleanup', {
      method: 'POST', body: JSON.stringify({ maxDeletes: 101 }),
    })).response.status).toBe(400);
    expect((await api('/models/cleanup', {
      method: 'POST', body: JSON.stringify({ dryRun: 'yes' }),
    })).response.status).toBe(400);
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
    for (const sellerId of ['seller-a', 'seller-b']) {
      await api('/sellers', { method: 'POST', body: JSON.stringify({ label: sellerId, sellerId }) });
    }
    for (const [templateId, name, subcategory, sellerId, priceCents, color, dimensions] of [
      ['catalog-page-b', 'Catalog same name', 'seating', 'seller-b', 200, '#123456', { width: 1, depth: 1, height: 1 }],
      ['catalog-page-a', 'Catalog same name', 'seating', 'seller-a', 100, '#123456', { width: 1, depth: 1, height: 1 }],
      ['catalog-page-c', 'Catalog trailing name', 'lighting', 'seller-a', 300, '#abcdef', { width: 3, depth: 2, height: 4 }],
    ]) {
      const created = await api('/catalog', {
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
      });
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
    const seller = await api('/catalog?category=pagination-test&sellerId=seller-a');
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
          { templateId: 'placeholder-chair', name: 'Conflict', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 } },
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

    const reference = await api('/instances', {
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'catalog-batch-delete-reference', landletId: 'starter-landlet',
        templateId: 'placeholder-chair', x: 0, y: 0,
      }),
    });
    expect(reference.response.status).toBe(201);
    const deleteConflict = await api('/catalog/batch', {
      method: 'DELETE',
      body: JSON.stringify({ templateIds: ['catalog-batch-b', 'placeholder-chair'] }),
    });
    expect(deleteConflict.response.status).toBe(409);
    expect((await api('/catalog/catalog-batch-b')).response.status).toBe(200);
    expect((await api('/instances/catalog-batch-delete-reference', { method: 'DELETE' })).response.status).toBe(200);
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

  it('cursor-paginates placed instances within one landlet', async () => {
    await api('/landlets', {
      method: 'POST',
      body: JSON.stringify({ landletId: 'instance-page-landlet', name: 'Instance page landlet', areaM2: 4 }),
    });
    for (const instanceId of ['instance-page-b', 'instance-page-a']) {
      const created = await api('/instances', {
        method: 'POST',
        body: JSON.stringify({
          instanceId,
          landletId: 'instance-page-landlet',
          templateId: 'placeholder-chair',
          x: 0,
          y: 0,
        }),
      });
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
    await createGreenbeltLandlet('instance-batch-landlet');
    const created = await api('/instances/batch', {
      method: 'POST',
      body: JSON.stringify({ instances: [
        { instanceId: 'instance-batch-a', landletId: 'instance-batch-landlet', templateId: 'placeholder-chair', x: 1, y: 2 },
        { instanceId: 'instance-batch-b', landletId: 'instance-batch-landlet', templateId: 'placeholder-tree', x: 3, y: 4 },
      ] }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.instances.map((instance) => instance.instanceId)).toEqual([
      'instance-batch-a', 'instance-batch-b',
    ]);
    expect(created.body.instances.every((instance) => instance.createdAt && instance.updatedAt)).toBe(true);

    const replaced = await api('/instances/batch', {
      method: 'PUT',
      body: JSON.stringify({ instances: [
        { instanceId: 'instance-batch-a', landletId: 'instance-batch-landlet', templateId: 'placeholder-tree', x: 10, y: 20 },
        { instanceId: 'instance-batch-c', landletId: 'instance-batch-landlet', templateId: 'placeholder-chair', x: 5, y: 6 },
      ] }),
    });
    expect(replaced.response.status).toBe(200);
    expect(replaced.body.instances.every((instance) => instance.createdAt && instance.updatedAt)).toBe(true);
    expect((await api('/instances/instance-batch-a')).body.instance).toMatchObject({
      templateId: 'placeholder-tree', x: 10, y: 20,
    });
    expect((await api('/instances/instance-batch-c')).response.status).toBe(200);

    const missingReference = await api('/instances/batch', {
      method: 'PUT',
      body: JSON.stringify({ instances: [
        { instanceId: 'instance-batch-a', landletId: 'instance-batch-landlet', templateId: 'placeholder-chair', x: 99, y: 99 },
        { instanceId: 'instance-batch-never-inserted', landletId: 'instance-batch-landlet', templateId: 'missing-template', x: 0, y: 0 },
      ] }),
    });
    expect(missingReference.response.status).toBe(400);
    expect((await api('/instances/instance-batch-never-inserted')).response.status).toBe(404);
    expect((await api('/instances/instance-batch-a')).body.instance.x).toBe(10);

    const conflict = await api('/instances/batch', {
      method: 'POST',
      body: JSON.stringify({ instances: [
        { instanceId: 'instance-batch-new', landletId: 'instance-batch-landlet', templateId: 'placeholder-chair', x: 0, y: 0 },
        { instanceId: 'instance-batch-a', landletId: 'instance-batch-landlet', templateId: 'placeholder-chair', x: 0, y: 0 },
      ] }),
    });
    expect(conflict.response.status).toBe(409);
    expect((await api('/instances/instance-batch-new')).response.status).toBe(404);
    expect((await api('/instances/batch', {
      method: 'POST', body: JSON.stringify({ instances: [] }),
    })).response.status).toBe(400);
    expect((await api('/instances/batch', {
      method: 'POST',
      body: JSON.stringify({ instances: Array.from({ length: 101 }, (_, index) => ({
        instanceId: `too-many-${index}`, templateId: 'placeholder-chair', x: 0, y: 0,
      })) }),
    })).response.status).toBe(400);
    expect((await api('/instances/batch', {
      method: 'POST',
      body: JSON.stringify({ instances: [
        { instanceId: 'duplicate-batch-id', templateId: 'placeholder-chair', x: 0, y: 0 },
        { instanceId: 'duplicate-batch-id', templateId: 'placeholder-tree', x: 0, y: 0 },
      ] }),
    })).response.status).toBe(400);

    const missingDelete = await api('/instances/batch', {
      method: 'DELETE',
      body: JSON.stringify({ instanceIds: ['instance-batch-a', 'missing-instance'] }),
    });
    expect(missingDelete.response.status).toBe(404);
    expect((await api('/instances/instance-batch-a')).response.status).toBe(200);
    const removed = await api('/instances/batch', {
      method: 'DELETE',
      body: JSON.stringify({ instanceIds: ['instance-batch-b', 'instance-batch-c'] }),
    });
    expect(removed.response.status).toBe(200);
    expect(removed.body.deletedInstanceIds).toEqual(['instance-batch-b', 'instance-batch-c']);
    expect((await api('/instances/instance-batch-b')).response.status).toBe(404);
    expect((await api('/instances/instance-batch-c')).response.status).toBe(404);
    expect((await api('/instances/batch', {
      method: 'DELETE', body: JSON.stringify({ instanceIds: ['instance-batch-a', 'instance-batch-a'] }),
    })).response.status).toBe(400);
    expect((await api('/instances/batch', {
      method: 'DELETE', body: JSON.stringify({ instanceIds: [] }),
    })).response.status).toBe(400);
    expect((await api('/instances/batch', {
      method: 'DELETE', body: JSON.stringify({ instanceIds: Array.from({ length: 101 }, (_, index) => `delete-${index}`) }),
    })).response.status).toBe(400);
  });

  it('claims an available greenbelt landlet', async () => {
    const created = await createGreenbeltLandlet('claimable-landlet');
    expect(created.response.status).toBe(201);

    const claimed = await api('/landlets/claimable-landlet/claim', {
      method: 'POST',
      body: JSON.stringify({ builderId: 'builder-one' }),
    });

    expect(claimed.response.status).toBe(200);
    expect(claimed.body.landlet).toMatchObject({
      landletId: 'claimable-landlet',
      status: 'claimed',
      ownerBuilderId: 'builder-one',
    });
    expect(claimed.body.landlet.claimableAt).not.toBeNull();
  });

  it('rejects a second starter claim by the same builder', async () => {
    await createGreenbeltLandlet('first-landlet');
    await createGreenbeltLandlet('second-landlet');

    const first = await api('/landlets/first-landlet/claim', {
      method: 'POST',
      body: JSON.stringify({ builderId: 'single-landlet-builder' }),
    });
    expect(first.response.status).toBe(200);

    const second = await api('/landlets/second-landlet/claim', {
      method: 'POST',
      body: JSON.stringify({ builderId: 'single-landlet-builder' }),
    });
    expect(second.response.status).toBe(409);
    expect(second.body).toEqual({ error: 'Builder already owns a claimed landlet' });
  });

  it('rejects unavailable, missing, and malformed claims', async () => {
    await createGreenbeltLandlet('contested-landlet');
    await api('/landlets/contested-landlet/claim', {
      method: 'POST',
      body: JSON.stringify({ builderId: 'winning-builder' }),
    });

    const unavailable = await api('/landlets/contested-landlet/claim', {
      method: 'POST',
      body: JSON.stringify({ builderId: 'other-builder' }),
    });
    expect(unavailable.response.status).toBe(409);
    expect(unavailable.body).toEqual({ error: 'Landlet is not available to claim' });

    const missing = await api('/landlets/does-not-exist/claim', {
      method: 'POST',
      body: JSON.stringify({ builderId: 'other-builder' }),
    });
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Landlet not found' });

    const malformed = await api('/landlets/contested-landlet/claim', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(malformed.response.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'builderId is required' });
  });

  it('returns useful client errors for malformed JSON and D1 conflicts', async () => {
    const malformedJson = await api('/landlets', {
      method: 'POST',
      body: '{',
    });
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

    const missingReference = await api('/instances', {
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'invalid-reference-instance',
        landletId: 'starter-landlet',
        templateId: 'missing-template',
        x: 0,
        y: 0,
      }),
    });
    // /api/instances pre-checks references explicitly (assertReferenceExists
    // in worker/index.js) for a precise 400 instead of relying on the
    // generic FK-constraint fallback other routes use.
    expect(missingReference.response.status).toBe(400);
    expect(missingReference.body).toEqual({
      error: 'templateId "missing-template" does not exist',
    });
  });

  it('atomically replaces a landlet draft', async () => {
    await api('/landlets', {
      method: 'POST',
      body: JSON.stringify({ landletId: 'draft-landlet', name: 'Draft landlet', areaM2: 1000 }),
    });

    const replaced = await api('/landlets/draft-landlet/draft', {
      method: 'PUT',
      body: JSON.stringify({
        versionName: 'Initial furnished draft',
        instances: [
          { instanceId: 'draft-tree', templateId: 'placeholder-tree', x: 1, y: 2, z: 0, rotationZ: 0.25 },
          { instanceId: 'draft-chair', templateId: 'placeholder-chair', x: 3, y: 4, z: 0, rotationZ: 0.5 },
        ],
      }),
    });
    expect(replaced.response.status).toBe(200);
    expect(replaced.body.instances).toHaveLength(2);
    expect(replaced.body.instances.map((instance) => instance.instanceId).sort()).toEqual(['draft-chair', 'draft-tree']);
    expect(replaced.body.instances.every((instance) => instance.landletId === 'draft-landlet')).toBe(true);
    expect(replaced.body.version).toMatchObject({
      versionNumber: 1,
      name: 'Initial furnished draft',
      instanceCount: 2,
    });

    const failed = await api('/landlets/draft-landlet/draft', {
      method: 'PUT',
      body: JSON.stringify({
        instances: [
          { instanceId: 'broken-instance', templateId: 'missing-template', x: 0, y: 0 },
        ],
      }),
    });
    expect(failed.response.status).toBe(409);

    const preserved = await api('/landlets/draft-landlet/draft');
    expect(preserved.response.status).toBe(200);
    expect(preserved.body.instances.map((instance) => instance.instanceId).sort()).toEqual(['draft-chair', 'draft-tree']);

    const duplicates = await api('/landlets/draft-landlet/draft', {
      method: 'PUT',
      body: JSON.stringify({
        instances: [
          { instanceId: 'same-id', templateId: 'placeholder-tree', x: 0, y: 0 },
          { instanceId: 'same-id', templateId: 'placeholder-chair', x: 1, y: 1 },
        ],
      }),
    });
    expect(duplicates.response.status).toBe(400);
    expect(duplicates.body).toEqual({ error: 'instanceId values must be unique' });

    const cleared = await api('/landlets/draft-landlet/draft', {
      method: 'PUT',
      body: JSON.stringify({ instances: [] }),
    });
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

  it('saves immutable landlet versions and activates a selected snapshot', async () => {
    const instance = await api('/instances', {
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'versioned-tree',
        landletId: 'starter-landlet',
        templateId: 'placeholder-tree',
        x: 3,
        y: 4,
        z: 0,
        rotationZ: 0.5,
      }),
    });
    expect(instance.response.status).toBe(201);

    const saved = await api('/landlets/starter-landlet/versions', {
      method: 'POST',
      body: JSON.stringify({ name: 'Tree by the entrance' }),
    });
    expect(saved.response.status).toBe(201);
    expect(saved.body.version).toMatchObject({
      landletId: 'starter-landlet',
      versionNumber: 1,
      name: 'Tree by the entrance',
      instanceCount: 1,
    });

    const unpublished = await api('/landlets/starter-landlet/live');
    expect(unpublished.response.status).toBe(200);
    expect(unpublished.body).toMatchObject({
      published: false,
      version: null,
      instances: [],
    });

    await api('/instances/versioned-tree', {
      method: 'PATCH',
      body: JSON.stringify({ x: 99 }),
    });

    const versionId = saved.body.version.versionId;
    const snapshot = await api(`/landlets/starter-landlet/versions/${versionId}`);
    expect(snapshot.response.status).toBe(200);
    expect(snapshot.body.version.instances).toHaveLength(1);
    expect(snapshot.body.version.instances[0]).toMatchObject({
      instanceId: 'versioned-tree',
      templateId: 'placeholder-tree',
      x: 3,
      y: 4,
      rotationZ: 0.5,
    });

    const activated = await api(`/landlets/starter-landlet/versions/${versionId}/activate`, {
      method: 'POST',
    });
    expect(activated.response.status).toBe(200);
    expect(activated.body.landlet.activeVersionId).toBe(versionId);

    const live = await api('/landlets/starter-landlet/live');
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

    const versions = await api('/landlets/starter-landlet/versions');
    expect(versions.response.status).toBe(200);
    expect(versions.body.versions).toHaveLength(1);
    expect(versions.body.versions[0].versionId).toBe(versionId);
  });

  it('allocates distinct sequential numbers to concurrent version saves', async () => {
    await api('/landlets', {
      method: 'POST',
      body: JSON.stringify({ landletId: 'concurrent-versions', name: 'Concurrent versions', areaM2: 1000 }),
    });

    const saves = await Promise.all([
      api('/landlets/concurrent-versions/versions', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      api('/landlets/concurrent-versions/versions', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    ]);

    expect(saves.every(({ response }) => response.status === 201)).toBe(true);
    expect(saves.map(({ body }) => body.version.versionNumber).sort()).toEqual([1, 2]);
    expect(saves.map(({ body }) => body.version.name).sort()).toEqual(['Version 1', 'Version 2']);
  });

  it('makes completed enclosed generation claimable and handles retries', async () => {
    await api('/landlets', {
      method: 'POST',
      body: JSON.stringify({
        landletId: 'enclosed-generation',
        name: 'Enclosed generation',
        areaM2: 4,
        center: { x: 0, y: 0 },
        status: 'generating',
      }),
    });

    const completed = await api('/landlets/enclosed-generation/generation-complete', { method: 'POST' });
    expect(completed.response.status).toBe(200);
    expect(completed.body.landlet.status).toBe('greenbelt');
    expect(completed.body.landlet.generatedAt).not.toBeNull();
    expect(completed.body.landlet.claimableAt).not.toBeNull();

    const retried = await api('/landlets/enclosed-generation/generation-complete', { method: 'POST' });
    expect(retried.response.status).toBe(200);
    expect(retried.body.landlet.generatedAt).toBe(completed.body.landlet.generatedAt);

    await api('/landlets', {
      method: 'POST',
      body: JSON.stringify({
        landletId: 'not-generating-landlet', name: 'Not generating', areaM2: 4,
        status: 'claimed', ownerBuilderId: 'some-owner',
      }),
    });
    const invalid = await api('/landlets/not-generating-landlet/generation-complete', { method: 'POST' });
    expect(invalid.response.status).toBe(409);
    expect(invalid.body).toEqual({ error: 'Landlet is not currently generating' });
  });

  it('filters and cursor-paginates landlets in stable order', async () => {
    for (const landletId of ['landlet-page-b', 'landlet-page-a']) {
      await api('/landlets', {
        method: 'POST',
        body: JSON.stringify({ landletId, name: landletId, areaM2: 4, status: 'generating' }),
      });
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

    await api('/landlets', {
      method: 'POST',
      body: JSON.stringify({
        landletId: 'owned-page-landlet',
        name: 'Owned page landlet',
        areaM2: 4,
        status: 'claimed',
        ownerBuilderId: 'page-builder',
      }),
    });
    const owned = await api('/landlets?status=claimed&ownerBuilderId=%20page-builder%20');
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
    const created = await api('/land-candidates', {
      method: 'POST',
      body: JSON.stringify({
        landletId: 'inside-candidate',
        name: 'Inside candidate',
        areaM2: 4,
        center: { x: 0, y: 0 },
      }),
    });
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
    await api('/land-candidates', {
      method: 'POST',
      body: JSON.stringify({
        landletId: 'cancelled-candidate',
        name: 'Cancelled candidate',
        areaM2: 4,
        center: { x: 200, y: 0 },
      }),
    });
    const deleted = await api('/land-candidates/cancelled-candidate', { method: 'DELETE' });
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });
    const absent = await api('/land-candidates/cancelled-candidate');
    expect(absent.response.status).toBe(404);

    const materialized = await api('/land-candidates/inside-candidate', { method: 'DELETE' });
    expect(materialized.response.status).toBe(409);
    expect(materialized.body).toEqual({ error: 'Materialized land candidates cannot be deleted' });
    const landlet = await api('/landlets/inside-candidate');
    expect(landlet.response.status).toBe(200);

    const missing = await api('/land-candidates/missing-candidate', { method: 'DELETE' });
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Land candidate not found' });
  });

  it('procedurally queues an exact-area ring outside the world boundary', async () => {
    const generated = await api('/land-candidates/generate-ring', {
      method: 'POST',
      body: JSON.stringify({ prefix: 'generated-ring', count: 6, innerRadiusM: 200 }),
    });
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

    const deleteMember = await api('/land-candidates/generated-ring-001', { method: 'DELETE' });
    expect(deleteMember.response.status).toBe(409);
    expect(deleteMember.body.error).toBe('Generated ring candidates cannot be deleted individually');
    const updateMember = await api('/land-candidates/generated-ring-001', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Detached member' }),
    });
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

    const conflict = await api('/land-candidates/generate-ring', {
      method: 'POST',
      body: JSON.stringify({ prefix: 'overlapping-ring', count: 6, innerRadiusM: 200 }),
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error).toBe('Generated ring would overlap existing land candidates');

    const mismatchedAdjacent = await api('/land-candidates/generate-ring', {
      method: 'POST',
      body: JSON.stringify({ prefix: 'mismatched-adjacent-ring', count: 5, innerRadiusM: generated.body.outerRadiusM }),
    });
    expect(mismatchedAdjacent.response.status).toBe(409);
    expect(mismatchedAdjacent.body.error).toBe('Adjacent generated rings must use matching boundary seams');

    const adjacent = await api('/land-candidates/generate-ring', {
      method: 'POST',
      body: JSON.stringify({ prefix: 'adjacent-ring', count: 6, adjacentToRingId: 'generated-ring' }),
    });
    expect(adjacent.response.status).toBe(201);
    expect(adjacent.body.innerRadiusM).toBe(generated.body.outerRadiusM);

    const conflictingDerivedInput = await api('/land-candidates/generate-ring', {
      method: 'POST',
      body: JSON.stringify({
        prefix: 'invalid-derived-ring', count: 6, adjacentToRingId: 'adjacent-ring', innerRadiusM: 300,
      }),
    });
    expect(conflictingDerivedInput.response.status).toBe(400);
    const missingAdjacent = await api('/land-candidates/generate-ring', {
      method: 'POST',
      body: JSON.stringify({ prefix: 'missing-adjacent-ring', count: 6, adjacentToRingId: 'missing-ring' }),
    });
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

    const invalid = await api('/land-candidates/generate-ring', {
      method: 'POST',
      body: JSON.stringify({ prefix: 'Bad prefix', count: 2 }),
    });
    expect(invalid.response.status).toBe(400);
  });

  it('queues a deterministic organic mosaic, folding the origin cell into starter-landlet', async () => {
    const generated = await api('/land-candidates/generate-mosaic', {
      method: 'POST',
      body: JSON.stringify({ prefix: 'organic-patch', count: 16 }),
    });
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

    const starterClaim = await api('/landlets/starter-landlet/claim', {
      method: 'POST',
      body: JSON.stringify({ builderId: 'center-plot-builder' }),
    });
    expect(starterClaim.response.status).toBe(200);
    expect(starterClaim.body.landlet).toMatchObject({
      landletId: 'starter-landlet', status: 'claimed', ownerBuilderId: 'center-plot-builder',
    });

    const duplicate = await api('/land-candidates/generate-mosaic', {
      method: 'POST', body: JSON.stringify({ prefix: 'organic-patch', count: 16 }),
    });
    expect(duplicate.response.status).toBe(409);
    expect((await api('/land-candidates/generate-mosaic', {
      method: 'POST', body: JSON.stringify({ prefix: 'bad mosaic', count: 8 }),
    })).response.status).toBe(400);

    // A second, differently-seeded mosaic still covers the same disc around
    // the origin (only the rotation differs) — must be rejected as spatial
    // overlap, not silently allowed to double-stamp the same land.
    const second = await api('/land-candidates/generate-mosaic', {
      method: 'POST', body: JSON.stringify({ prefix: 'organic-patch-2', count: 16 }),
    });
    expect(second.response.status).toBe(409);
    expect(second.body.error).toMatch(/overlap/i);

    await env.DB.prepare("DELETE FROM landlet_candidates WHERE landlet_id LIKE 'organic-patch-%'").run();
    await env.DB.prepare("DELETE FROM landlets WHERE landlet_id LIKE 'organic-patch-%'").run();
  });

  it('generates the authoritative power-law mix on request', async () => {
    const generated = await api('/land-candidates/generate-ring', {
      method: 'POST',
      body: JSON.stringify({
        prefix: 'power-law-ring',
        count: 100,
        innerRadiusM: 500,
        distribution: 'power-law',
      }),
    });
    expect(generated.response.status).toBe(201);
    expect(generated.body.candidates.filter((candidate) => candidate.landClass === 1)).toHaveLength(91);
    expect(generated.body.candidates.filter((candidate) => candidate.landClass === 2)).toHaveLength(9);
    expect(generated.body.candidates.find((candidate) => candidate.landClass === 2).areaM2).toBeGreaterThanOrEqual(1001);

  });

  it('completes generation for a fully materialized ring in one request', async () => {
    const generated = await api('/land-candidates/generate-ring', {
      method: 'POST',
      body: JSON.stringify({ prefix: 'completion-ring', count: 3 }),
    });
    expect(generated.response.status).toBe(201);
    expect(generated.body.materializedLandletIds).toHaveLength(3);
    expect(generated.body.readyForGenerationCompletion).toBe(true);

    const completed = await api('/land-candidate-rings/completion-ring/generation-complete', { method: 'POST' });
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

    const retry = await api('/land-candidate-rings/completion-ring/generation-complete', { method: 'POST' });
    expect(retry.response.status).toBe(200);
    expect(retry.body.landlets.map((landlet) => landlet.generatedAt)).toEqual(
      completed.body.landlets.map((landlet) => landlet.generatedAt),
    );

    const pending = await api('/land-candidates/generate-ring', {
      method: 'POST',
      body: JSON.stringify({ prefix: 'pending-completion-ring', count: 3, innerRadiusM: 1000 }),
    });
    expect(pending.response.status).toBe(201);
    const premature = await api('/land-candidate-rings/pending-completion-ring/generation-complete', { method: 'POST' });
    expect(premature.response.status).toBe(409);
    const missing = await api('/land-candidate-rings/missing-completion-ring/generation-complete', { method: 'POST' });
    expect(missing.response.status).toBe(404);
  });

  it('updates only pending land candidates', async () => {
    await api('/land-candidates', {
      method: 'POST',
      body: JSON.stringify({
        landletId: 'corrected-candidate',
        name: 'Before correction',
        areaM2: 4,
        center: { x: 210, y: 0 },
        metadata: { revision: 1 },
      }),
    });
    const updated = await api('/land-candidates/corrected-candidate', {
      method: 'PATCH',
      body: JSON.stringify({
        landletId: 'ignored-id-change',
        name: 'After correction',
        center: { x: 220, y: 5 },
        metadata: { revision: 2 },
      }),
    });
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

    const started = await api('/land-candidates/corrected-candidate', {
      method: 'PATCH',
      body: JSON.stringify({ center: { x: 0, y: 0 } }),
    });
    expect(started.response.status).toBe(200);
    expect(started.body.candidate.materializedAt).not.toBeNull();
    expect(started.body.landlet).toMatchObject({
      landletId: 'corrected-candidate',
      name: 'After correction',
      status: 'generating',
      center: { x: 0, y: 0 },
    });
    const startedAgain = await api('/land-candidates/corrected-candidate', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Too late too' }),
    });
    expect(startedAgain.response.status).toBe(409);

    const materialized = await api('/land-candidates/inside-candidate', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Too late' }),
    });
    expect(materialized.response.status).toBe(409);
    expect(materialized.body).toEqual({ error: 'Materialized land candidates cannot be updated' });

    const missing = await api('/land-candidates/missing-update', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Missing' }),
    });
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Land candidate not found' });
  });

  it('atomically queues candidate batches and materializes overlapping plots', async () => {
    const created = await api('/land-candidates/batch', {
      method: 'POST',
      body: JSON.stringify({
        candidates: [
          { landletId: 'batch-inside', name: 'Batch inside', areaM2: 4, center: { x: 0, y: 0 } },
          { landletId: 'batch-outside', name: 'Batch outside', areaM2: 4, center: { x: 100, y: 0 } },
        ],
      }),
    });

    expect(created.response.status).toBe(201);
    expect(created.body.candidates.map(({ landletId }) => landletId).sort()).toEqual(['batch-inside', 'batch-outside']);
    expect(created.body.landlets).toHaveLength(1);
    expect(created.body.landlets[0]).toMatchObject({ landletId: 'batch-inside', status: 'generating' });
    expect(created.body.candidates.find(({ landletId }) => landletId === 'batch-inside').materializedAt).not.toBeNull();
    expect(created.body.candidates.find(({ landletId }) => landletId === 'batch-outside').materializedAt).toBeNull();

    const invalid = await api('/land-candidates/batch', {
      method: 'POST',
      body: JSON.stringify({
        candidates: [
          { landletId: 'batch-duplicate', name: 'First', areaM2: 4 },
          { landletId: 'batch-duplicate', name: 'Second', areaM2: 4 },
        ],
      }),
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'landletId values must be unique' });

    const absent = await api('/land-candidates/batch', {
      method: 'POST',
      body: JSON.stringify({ candidates: [] }),
    });
    expect(absent.response.status).toBe(400);
    expect(absent.body).toEqual({ error: 'candidates must contain at least one item' });

    const conflict = await api('/land-candidates/batch', {
      method: 'POST',
      body: JSON.stringify({
        candidates: [
          { landletId: 'batch-rolled-back', name: 'Should roll back', areaM2: 4 },
          { landletId: 'batch-inside', name: 'Already exists', areaM2: 4 },
        ],
      }),
    });
    expect(conflict.response.status).toBe(409);
    const rolledBack = await api('/land-candidates/batch-rolled-back');
    expect(rolledBack.response.status).toBe(404);
  });

  it('filters and cursor-paginates the candidate generation queue', async () => {
    await api('/land-candidates/batch', {
      method: 'POST',
      body: JSON.stringify({
        candidates: [
          { landletId: 'page-inside', name: 'Page inside', areaM2: 4, center: { x: 0, y: 0 } },
          { landletId: 'page-outside-a', name: 'Page outside A', areaM2: 4, center: { x: 100, y: 0 } },
          { landletId: 'page-outside-b', name: 'Page outside B', areaM2: 4, center: { x: 110, y: 0 } },
        ],
      }),
    });

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
    const candidate = await api('/landlets', {
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
    });
    expect(candidate.response.status).toBe(201);
    const storedRadius = await env.DB.prepare(`
      SELECT max_world_radius_m FROM landlets WHERE landlet_id = 'edge-candidate'
    `).first();
    expect(storedRadius.max_world_radius_m).toBeCloseTo(Math.hypot(36, 1));

    const incompleteCandidate = await api('/landlets', {
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
    });
    expect(incompleteCandidate.response.status).toBe(201);

    const queuedCandidate = await api('/land-candidates', {
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
    });
    expect(queuedCandidate.response.status).toBe(201);
    expect(queuedCandidate.body.candidate.materializedAt).toBeNull();
    expect(queuedCandidate.body.landlet).toBeNull();

    const completed = await api('/landlets/edge-candidate/generation-complete', { method: 'POST' });
    expect(completed.response.status).toBe(200);
    expect(completed.body.landlet.status).toBe('generating');
    expect(completed.body.landlet.generatedAt).not.toBeNull();
    expect(completed.body.landlet.claimableAt).toBeNull();

    const configured = await api('/world', {
      method: 'PATCH',
      body: JSON.stringify({ greenbeltMinRatio: 1 }),
    });
    const previousRadiusM = configured.body.world.radiusM;

    const expanded = await api('/world/expand', { method: 'POST' });
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

    await api('/world', {
      method: 'PATCH',
      body: JSON.stringify({
        greenbeltMinRatio: expanded.body.world.landletCounts.greenbeltRatio,
      }),
    });

    const blocked = await api('/world/expand', { method: 'POST' });
    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toEqual({
      error: 'Greenbelt reserve is at or above the expansion threshold',
    });
  });
});

describe('Community signs', () => {
  it('toggles isCommunitySign on a placed instance and round-trips it', async () => {
    const created = await api('/instances', {
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-toggle-instance',
        landletId: 'starter-landlet',
        templateId: 'placeholder-tree',
        x: 1,
        y: 1,
      }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.instance.isCommunitySign).toBe(false);

    const toggled = await api('/instances/sign-toggle-instance', {
      method: 'PATCH',
      body: JSON.stringify({ isCommunitySign: true }),
    });
    expect(toggled.response.status).toBe(200);
    expect(toggled.body.instance.isCommunitySign).toBe(true);

    const fetched = await api('/instances/sign-toggle-instance');
    expect(fetched.body.instance.isCommunitySign).toBe(true);
  });

  it('rejects a post on an instance not marked as a community sign', async () => {
    await api('/instances', {
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'not-a-sign-instance',
        landletId: 'starter-landlet',
        templateId: 'placeholder-tree',
        x: 2,
        y: 2,
      }),
    });

    const rejected = await api('/instances/not-a-sign-instance/posts', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', text: 'Hello!' }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/not marked as a community sign/);
  });

  it('creates, lists, and moderates posts on a community sign', async () => {
    await api('/instances', {
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-with-posts',
        landletId: 'starter-landlet',
        templateId: 'placeholder-tree',
        x: 3,
        y: 3,
        isCommunitySign: true,
      }),
    });

    const emptyList = await api('/instances/sign-with-posts/posts');
    expect(emptyList.response.status).toBe(200);
    expect(emptyList.body.posts).toEqual([]);

    const missingText = await api('/instances/sign-with-posts/posts', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper' }),
    });
    expect(missingText.response.status).toBe(400);

    const tooLong = await api('/instances/sign-with-posts/posts', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', text: 'x'.repeat(281) }),
    });
    expect(tooLong.response.status).toBe(400);

    const posted = await api('/instances/sign-with-posts/posts', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', text: 'Great little shop!' }),
    });
    expect(posted.response.status).toBe(201);
    expect(posted.body.post).toMatchObject({
      instanceId: 'sign-with-posts',
      authorLabel: 'A Shopper',
      text: 'Great little shop!',
    });
    expect(posted.body.post.postId).toMatch(/^post-/);

    const listed = await api('/instances/sign-with-posts/posts');
    expect(listed.body.posts).toHaveLength(1);
    expect(listed.body.posts[0].postId).toBe(posted.body.post.postId);

    const deleted = await api(`/instances/sign-with-posts/posts/${posted.body.post.postId}`, { method: 'DELETE' });
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const listedAfterDelete = await api('/instances/sign-with-posts/posts');
    expect(listedAfterDelete.body.posts).toEqual([]);

    const deleteMissing = await api(`/instances/sign-with-posts/posts/${posted.body.post.postId}`, { method: 'DELETE' });
    expect(deleteMissing.response.status).toBe(404);
  });

  it('cascades post deletion when the sign instance itself is deleted', async () => {
    await api('/instances', {
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-to-delete',
        landletId: 'starter-landlet',
        templateId: 'placeholder-tree',
        x: 4,
        y: 4,
        isCommunitySign: true,
      }),
    });
    await api('/instances/sign-to-delete/posts', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', text: 'Nice place' }),
    });
    await api('/instances/sign-to-delete', { method: 'DELETE' });

    const afterDelete = await api('/instances/sign-to-delete/posts');
    expect(afterDelete.response.status).toBe(404);
  });
});

describe('Community calendar', () => {
  it('toggles isCommunityCalendar on a placed instance and round-trips it', async () => {
    const created = await api('/instances', {
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-toggle-instance',
        landletId: 'starter-landlet',
        templateId: 'placeholder-tree',
        x: 5,
        y: 5,
      }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.instance.isCommunityCalendar).toBe(false);

    const toggled = await api('/instances/calendar-toggle-instance', {
      method: 'PATCH',
      body: JSON.stringify({ isCommunityCalendar: true }),
    });
    expect(toggled.response.status).toBe(200);
    expect(toggled.body.instance.isCommunityCalendar).toBe(true);

    const fetched = await api('/instances/calendar-toggle-instance');
    expect(fetched.body.instance.isCommunityCalendar).toBe(true);
  });

  it('is independent of isCommunitySign on the same instance', async () => {
    const created = await api('/instances', {
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'both-flags-instance',
        landletId: 'starter-landlet',
        templateId: 'placeholder-tree',
        x: 6,
        y: 6,
        isCommunitySign: true,
        isCommunityCalendar: true,
      }),
    });
    expect(created.body.instance.isCommunitySign).toBe(true);
    expect(created.body.instance.isCommunityCalendar).toBe(true);

    const unsetSignOnly = await api('/instances/both-flags-instance', {
      method: 'PATCH',
      body: JSON.stringify({ isCommunitySign: false }),
    });
    expect(unsetSignOnly.body.instance.isCommunitySign).toBe(false);
    expect(unsetSignOnly.body.instance.isCommunityCalendar).toBe(true);
  });

  it('rejects an event on an instance not marked as a community calendar', async () => {
    await api('/instances', {
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'not-a-calendar-instance',
        landletId: 'starter-landlet',
        templateId: 'placeholder-tree',
        x: 7,
        y: 7,
      }),
    });

    const rejected = await api('/instances/not-a-calendar-instance/events', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Builder', text: 'Bonfire night, Friday 8pm!' }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/not marked as a community calendar/);
  });

  it('creates, lists, and moderates events on a community calendar', async () => {
    await api('/instances', {
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-with-events',
        landletId: 'starter-landlet',
        templateId: 'placeholder-tree',
        x: 8,
        y: 8,
        isCommunityCalendar: true,
      }),
    });

    const emptyList = await api('/instances/calendar-with-events/events');
    expect(emptyList.response.status).toBe(200);
    expect(emptyList.body.events).toEqual([]);

    const missingText = await api('/instances/calendar-with-events/events', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Builder' }),
    });
    expect(missingText.response.status).toBe(400);

    const tooLong = await api('/instances/calendar-with-events/events', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Builder', text: 'x'.repeat(281) }),
    });
    expect(tooLong.response.status).toBe(400);

    const posted = await api('/instances/calendar-with-events/events', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Builder', text: 'Bonfire night, Friday 8pm!' }),
    });
    expect(posted.response.status).toBe(201);
    expect(posted.body.event).toMatchObject({
      instanceId: 'calendar-with-events',
      authorLabel: 'A Builder',
      text: 'Bonfire night, Friday 8pm!',
    });
    expect(posted.body.event.eventId).toMatch(/^event-/);

    const listed = await api('/instances/calendar-with-events/events');
    expect(listed.body.events).toHaveLength(1);
    expect(listed.body.events[0].eventId).toBe(posted.body.event.eventId);

    const deleted = await api(`/instances/calendar-with-events/events/${posted.body.event.eventId}`, { method: 'DELETE' });
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const listedAfterDelete = await api('/instances/calendar-with-events/events');
    expect(listedAfterDelete.body.events).toEqual([]);

    const deleteMissing = await api(`/instances/calendar-with-events/events/${posted.body.event.eventId}`, { method: 'DELETE' });
    expect(deleteMissing.response.status).toBe(404);
  });

  it('cascades event deletion when the calendar instance itself is deleted', async () => {
    await api('/instances', {
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-to-delete',
        landletId: 'starter-landlet',
        templateId: 'placeholder-tree',
        x: 9,
        y: 9,
        isCommunityCalendar: true,
      }),
    });
    await api('/instances/calendar-to-delete/events', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Builder', text: 'Market day' }),
    });
    await api('/instances/calendar-to-delete', { method: 'DELETE' });

    const afterDelete = await api('/instances/calendar-to-delete/events');
    expect(afterDelete.response.status).toBe(404);
  });

  it('accepts an optional scheduledAt and validates it', async () => {
    await api('/instances', {
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-scheduled-instance',
        landletId: 'starter-landlet',
        templateId: 'placeholder-tree',
        x: 10,
        y: 10,
        isCommunityCalendar: true,
      }),
    });

    const plain = await api('/instances/calendar-scheduled-instance/events', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Builder', text: 'Just a note' }),
    });
    expect(plain.body.event.scheduledAt).toBeNull();
    expect(plain.body.event.triggeredAt).toBeNull();

    const invalid = await api('/instances/calendar-scheduled-instance/events', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Builder', text: 'Bad date', scheduledAt: 'not a date' }),
    });
    expect(invalid.response.status).toBe(400);

    const scheduled = await api('/instances/calendar-scheduled-instance/events', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Builder', text: 'Bonfire!', scheduledAt: '2026-08-26T20:00:00.000Z' }),
    });
    expect(scheduled.response.status).toBe(201);
    expect(scheduled.body.event.scheduledAt).toBe('2026-08-26T20:00:00.000Z');
    expect(scheduled.body.event.triggeredAt).toBeNull();
  });

  it('only triggers the creative-tool effect once it is actually due, and only once ever', async () => {
    await api('/instances', {
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-trigger-instance',
        landletId: 'starter-landlet',
        templateId: 'placeholder-tree',
        x: 11,
        y: 11,
        isCommunityCalendar: true,
      }),
    });

    const future = await api('/instances/calendar-trigger-instance/events', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Builder', text: 'Future event', scheduledAt: '2099-01-01T00:00:00.000Z' }),
    });
    const futureEventId = future.body.event.eventId;
    const notDueYet = await api(`/instances/calendar-trigger-instance/events/${futureEventId}/trigger`, { method: 'POST' });
    expect(notDueYet.response.status).toBe(200);
    expect(notDueYet.body.triggered).toBe(false);
    expect(notDueYet.body.event.triggeredAt).toBeNull();

    const noSchedule = await api('/instances/calendar-trigger-instance/events', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Builder', text: 'Just a note' }),
    });
    const noScheduleTrigger = await api(`/instances/calendar-trigger-instance/events/${noSchedule.body.event.eventId}/trigger`, { method: 'POST' });
    expect(noScheduleTrigger.body.triggered).toBe(false);

    // Force it into the past directly via the DB, the same test-only
    // escape hatch used throughout this file (see the Auctions describe
    // block's own comment) rather than waiting a real moment or mocking
    // Date globally.
    await env.DB.prepare(`UPDATE calendar_events SET scheduled_at = '2000-01-01T00:00:00.000Z' WHERE event_id = ?`).bind(futureEventId).run();

    const firstTrigger = await api(`/instances/calendar-trigger-instance/events/${futureEventId}/trigger`, { method: 'POST' });
    expect(firstTrigger.response.status).toBe(200);
    expect(firstTrigger.body.triggered).toBe(true);
    expect(firstTrigger.body.event.triggeredAt).not.toBeNull();

    // A second call — e.g. a later visitor's Shop-mode session noticing
    // the same due event — is a harmless no-op, not a second effect.
    const secondTrigger = await api(`/instances/calendar-trigger-instance/events/${futureEventId}/trigger`, { method: 'POST' });
    expect(secondTrigger.response.status).toBe(200);
    expect(secondTrigger.body.triggered).toBe(false);
    expect(secondTrigger.body.event.triggeredAt).toBe(firstTrigger.body.event.triggeredAt);

    const triggerOnMissing = await api('/instances/calendar-trigger-instance/events/event-does-not-exist/trigger', { method: 'POST' });
    expect(triggerOnMissing.response.status).toBe(404);
  });
});

describe('Product reviews', () => {
  async function createTemplate(templateId) {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId,
        name: `Reviewable product ${templateId}`,
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(created.response.status).toBe(201);
    return templateId;
  }

  it('rejects a review on a catalog template that does not exist', async () => {
    const rejected = await api('/catalog/template-does-not-exist/reviews', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5 }),
    });
    expect(rejected.response.status).toBe(404);
  });

  it('creates, lists (with an average), and moderates reviews on a catalog template — no opt-in required', async () => {
    const templateId = await createTemplate('reviewable-product');

    const emptyList = await api(`/catalog/${templateId}/reviews`);
    expect(emptyList.response.status).toBe(200);
    expect(emptyList.body.reviews).toEqual([]);
    expect(emptyList.body.averageRating).toBeNull();
    expect(emptyList.body.count).toBe(0);

    const missingRating = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper' }),
    });
    expect(missingRating.response.status).toBe(400);

    for (const badRating of [0, 6, 3.5, 'five']) {
      const rejected = await api(`/catalog/${templateId}/reviews`, {
        method: 'POST',
        body: JSON.stringify({ authorLabel: 'A Shopper', rating: badRating }),
      });
      expect(rejected.response.status).toBe(400);
    }

    const tooLong = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 4, text: 'x'.repeat(281) }),
    });
    expect(tooLong.response.status).toBe(400);

    const firstReview = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5, text: 'Lovely product!' }),
    });
    expect(firstReview.response.status).toBe(201);
    expect(firstReview.body.review).toMatchObject({
      templateId,
      authorLabel: 'A Shopper',
      rating: 5,
      text: 'Lovely product!',
    });
    expect(firstReview.body.review.reviewId).toMatch(/^review-/);

    // text is genuinely optional — a bare star rating is still a real review.
    const secondReview = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'Another Shopper', rating: 3 }),
    });
    expect(secondReview.response.status).toBe(201);
    expect(secondReview.body.review.text).toBeNull();

    const listed = await api(`/catalog/${templateId}/reviews`);
    expect(listed.body.reviews).toHaveLength(2);
    expect(listed.body.count).toBe(2);
    expect(listed.body.averageRating).toBe(4); // (5 + 3) / 2

    const deleted = await api(`/catalog/${templateId}/reviews/${secondReview.body.review.reviewId}`, { method: 'DELETE' });
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const listedAfterDelete = await api(`/catalog/${templateId}/reviews`);
    expect(listedAfterDelete.body.reviews).toHaveLength(1);
    expect(listedAfterDelete.body.averageRating).toBe(5);

    const deleteMissing = await api(`/catalog/${templateId}/reviews/${secondReview.body.review.reviewId}`, { method: 'DELETE' });
    expect(deleteMissing.response.status).toBe(404);
  });

  it('keeps reviews independent between two different catalog templates', async () => {
    const templateA = await createTemplate('reviewable-product-a');
    const templateB = await createTemplate('reviewable-product-b');
    await api(`/catalog/${templateA}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5 }),
    });

    const listA = await api(`/catalog/${templateA}/reviews`);
    const listB = await api(`/catalog/${templateB}/reviews`);
    expect(listA.body.reviews).toHaveLength(1);
    expect(listB.body.reviews).toEqual([]);
  });

  it('cascades review deletion when the catalog template itself is deleted', async () => {
    const templateId = await createTemplate('reviewable-product-to-delete');
    await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 4 }),
    });
    await api(`/catalog/${templateId}`, { method: 'DELETE' });

    const afterDelete = await api(`/catalog/${templateId}/reviews`);
    expect(afterDelete.response.status).toBe(404);
  });
});

describe('Builders', () => {
  it('creates, lists, renames, and validates builders', async () => {
    const created = await api('/builders', { method: 'POST', body: JSON.stringify({ label: 'Ada' }) });
    expect(created.response.status).toBe(201);
    expect(created.body.builder.label).toBe('Ada');
    expect(created.body.builder.builderId).toMatch(/^builder-/);

    const withId = await api('/builders', {
      method: 'POST', body: JSON.stringify({ builderId: 'builder-explicit-1', label: 'Grace' }),
    });
    expect(withId.response.status).toBe(201);
    expect(withId.body.builder.builderId).toBe('builder-explicit-1');

    const duplicate = await api('/builders', {
      method: 'POST', body: JSON.stringify({ builderId: 'builder-explicit-1', label: 'Grace again' }),
    });
    expect(duplicate.response.status).toBe(409);

    const list = await api('/builders');
    expect(list.response.status).toBe(200);
    expect(list.body.builders.map((b) => b.builderId)).toEqual(
      expect.arrayContaining([created.body.builder.builderId, 'builder-explicit-1']),
    );

    const renamed = await api(`/builders/${created.body.builder.builderId}`, {
      method: 'PATCH', body: JSON.stringify({ label: 'Ada Lovelace' }),
    });
    expect(renamed.response.status).toBe(200);
    expect(renamed.body.builder.label).toBe('Ada Lovelace');

    const renameMissing = await api('/builders/builder-does-not-exist', {
      method: 'PATCH', body: JSON.stringify({ label: 'x' }),
    });
    expect(renameMissing.response.status).toBe(404);
  });

  it('deleting a builder releases their claimed landlet and clears its build, keeping the shape', async () => {
    const builder = await api('/builders', { method: 'POST', body: JSON.stringify({ label: 'Temp' }) });
    const builderId = builder.body.builder.builderId;

    await createGreenbeltLandlet('release-test-landlet');
    const claimed = await api('/landlets/release-test-landlet/claim', {
      method: 'POST', body: JSON.stringify({ builderId }),
    });
    expect(claimed.response.status).toBe(200);
    const originalPolygon = claimed.body.landlet.polygon;

    await api('/instances', {
      method: 'POST',
      body: JSON.stringify({ landletId: 'release-test-landlet', templateId: 'placeholder-tree', x: 1, y: 1 }),
    });
    await api('/landlets/release-test-landlet/versions', {
      method: 'POST', body: JSON.stringify({ name: 'A build worth keeping' }),
    });

    const deleted = await api(`/builders/${builderId}`, { method: 'DELETE' });
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.releasedLandletIds).toEqual(['release-test-landlet']);

    const released = await api('/landlets/release-test-landlet');
    expect(released.body.landlet.status).toBe('greenbelt');
    expect(released.body.landlet.ownerBuilderId).toBeNull();
    expect(released.body.landlet.activeVersionId).toBeNull();
    expect(released.body.landlet.polygon).toEqual(originalPolygon);

    const instances = await api('/instances?landletId=release-test-landlet');
    expect(instances.body.instances).toEqual([]);
    const versions = await api('/landlets/release-test-landlet/versions');
    expect(versions.body.versions).toEqual([]);

    const gone = await api(`/builders/${builderId}`);
    expect(gone.response.status).toBe(404);

    const reclaimed = await api('/landlets/release-test-landlet/claim', {
      method: 'POST', body: JSON.stringify({ builderId: 'builder-someone-else' }),
    });
    expect(reclaimed.response.status).toBe(200);
  });

  it('deleting a builder who owns nothing just removes them', async () => {
    const builder = await api('/builders', { method: 'POST', body: JSON.stringify({ label: 'Owns nothing' }) });
    const deleted = await api(`/builders/${builder.body.builder.builderId}`, { method: 'DELETE' });
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.releasedLandletIds).toEqual([]);
  });

  it('assigns sequential pioneer ranks to successive first-time claimers', async () => {
    // Earlier tests in this file already claimed landlets, so some
    // builders very likely already hold ranks by this point — reset
    // directly via the DB (not exposed over the HTTP API on purpose; a
    // test-only escape hatch) so this test's own outcome is deterministic
    // regardless of execution order.
    await env.DB.prepare('UPDATE builders SET pioneer_rank = NULL').run();

    const first = await api('/builders', { method: 'POST', body: JSON.stringify({ label: 'First Claimer' }) });
    const second = await api('/builders', { method: 'POST', body: JSON.stringify({ label: 'Second Claimer' }) });
    await createGreenbeltLandlet('pioneer-first-landlet');
    await createGreenbeltLandlet('pioneer-second-landlet');

    await api('/landlets/pioneer-first-landlet/claim', {
      method: 'POST', body: JSON.stringify({ builderId: first.body.builder.builderId }),
    });
    await api('/landlets/pioneer-second-landlet/claim', {
      method: 'POST', body: JSON.stringify({ builderId: second.body.builder.builderId }),
    });

    const list = await api('/builders');
    const firstAfter = list.body.builders.find((b) => b.builderId === first.body.builder.builderId);
    const secondAfter = list.body.builders.find((b) => b.builderId === second.body.builder.builderId);
    expect(firstAfter.isPioneer).toBe(true);
    expect(firstAfter.pioneerRank).toBe(1);
    expect(secondAfter.isPioneer).toBe(true);
    expect(secondAfter.pioneerRank).toBe(2);

    // A second claim (after releasing the first, so no rank was granted
    // the first time around) still gets one, since it's this builder's
    // first landing in the ranked cohort — the rule is "not yet ranked,"
    // not "this exact claim is chronologically their first ever."
    const third = await api('/builders', { method: 'POST', body: JSON.stringify({ label: 'Third Claimer' }) });
    await createGreenbeltLandlet('pioneer-third-landlet');
    await api('/landlets/pioneer-third-landlet/claim', {
      method: 'POST', body: JSON.stringify({ builderId: third.body.builder.builderId }),
    });
    const thirdList = await api('/builders');
    const thirdAfter = thirdList.body.builders.find((b) => b.builderId === third.body.builder.builderId);
    expect(thirdAfter.pioneerRank).toBe(3);
  });

  it('stops assigning pioneer ranks once the founding cohort is full', async () => {
    await env.DB.prepare('UPDATE builders SET pioneer_rank = NULL').run();
    // Fill the cohort with throwaway rows directly via the DB — cheap and
    // exact, versus actually claiming 100 real landlets through the API.
    const fillerValues = Array.from({ length: 100 }, (_, i) => `('builder-cohort-filler-${i}', 'Filler ${i}', ${i + 1})`).join(', ');
    await env.DB.prepare(`INSERT INTO builders (builder_id, label, pioneer_rank) VALUES ${fillerValues}`).run();

    const late = await api('/builders', { method: 'POST', body: JSON.stringify({ label: 'Late Claimer' }) });
    await createGreenbeltLandlet('pioneer-late-landlet');
    await api('/landlets/pioneer-late-landlet/claim', {
      method: 'POST', body: JSON.stringify({ builderId: late.body.builder.builderId }),
    });

    const list = await api('/builders');
    const lateAfter = list.body.builders.find((b) => b.builderId === late.body.builder.builderId);
    expect(lateAfter.isPioneer).toBe(false);
    expect(lateAfter.pioneerRank).toBeNull();
  });
});

describe('Auctions', () => {
  async function createBuilder(label) {
    const res = await api('/builders', { method: 'POST', body: JSON.stringify({ label }) });
    return res.body.builder.builderId;
  }

  async function claim(landletId, builderId) {
    return api(`/landlets/${landletId}/claim`, { method: 'POST', body: JSON.stringify({ builderId }) });
  }

  it('only lets the current owner start an auction on their own claimed landlet', async () => {
    const owner = await createBuilder('Auction Owner');
    const stranger = await createBuilder('Auction Stranger');
    await createGreenbeltLandlet('auction-ownership-landlet');
    await claim('auction-ownership-landlet', owner);

    const byStranger = await api('/landlets/auction-ownership-landlet/auction', {
      method: 'POST', body: JSON.stringify({ builderId: stranger }),
    });
    expect(byStranger.response.status).toBe(400);

    const onUnclaimed = await api('/landlets/does-not-exist/auction', {
      method: 'POST', body: JSON.stringify({ builderId: owner }),
    });
    expect(onUnclaimed.response.status).toBe(404);

    const started = await api('/landlets/auction-ownership-landlet/auction', {
      method: 'POST', body: JSON.stringify({ builderId: owner }),
    });
    expect(started.response.status).toBe(201);
    expect(started.body.auction).toMatchObject({
      landletId: 'auction-ownership-landlet',
      sellerBuilderId: owner,
      startingBidCents: 0,
      status: 'active',
      highestBidCents: null,
      bidCount: 0,
    });

    const secondAttempt = await api('/landlets/auction-ownership-landlet/auction', {
      method: 'POST', body: JSON.stringify({ builderId: owner }),
    });
    expect(secondAttempt.response.status).toBe(409);
  });

  it('accepts a custom starting bid and duration', async () => {
    const owner = await createBuilder('Custom Auction Owner');
    await createGreenbeltLandlet('auction-custom-landlet');
    await claim('auction-custom-landlet', owner);

    const started = await api('/landlets/auction-custom-landlet/auction', {
      method: 'POST', body: JSON.stringify({ builderId: owner, startingBidCents: 500, durationHours: 1 }),
    });
    expect(started.response.status).toBe(201);
    expect(started.body.auction.startingBidCents).toBe(500);
    const endsAt = new Date(started.body.auction.endsAt).getTime();
    const createdAt = new Date(started.body.auction.createdAt).getTime();
    expect(endsAt - createdAt).toBeGreaterThan(59 * 60 * 1000);
    expect(endsAt - createdAt).toBeLessThan(61 * 60 * 1000);
  });

  it('enforces increasing bids and rejects the seller bidding on their own auction', async () => {
    const owner = await createBuilder('Bid Rules Owner');
    const bidderA = await createBuilder('Bidder A');
    const bidderB = await createBuilder('Bidder B');
    await createGreenbeltLandlet('auction-bid-rules-landlet');
    await claim('auction-bid-rules-landlet', owner);
    const started = await api('/landlets/auction-bid-rules-landlet/auction', {
      method: 'POST', body: JSON.stringify({ builderId: owner, startingBidCents: 1000 }),
    });
    const auctionId = started.body.auction.auctionId;

    const sellerBid = await api(`/auctions/${auctionId}/bids`, {
      method: 'POST', body: JSON.stringify({ builderId: owner, amountCents: 2000 }),
    });
    expect(sellerBid.response.status).toBe(400);

    const tooLow = await api(`/auctions/${auctionId}/bids`, {
      method: 'POST', body: JSON.stringify({ builderId: bidderA, amountCents: 500 }),
    });
    expect(tooLow.response.status).toBe(400);

    const firstBid = await api(`/auctions/${auctionId}/bids`, {
      method: 'POST', body: JSON.stringify({ builderId: bidderA, amountCents: 1000 }),
    });
    expect(firstBid.response.status).toBe(201);

    const notHigherEnough = await api(`/auctions/${auctionId}/bids`, {
      method: 'POST', body: JSON.stringify({ builderId: bidderB, amountCents: 1000 }),
    });
    expect(notHigherEnough.response.status).toBe(400);

    const secondBid = await api(`/auctions/${auctionId}/bids`, {
      method: 'POST', body: JSON.stringify({ builderId: bidderB, amountCents: 1500 }),
    });
    expect(secondBid.response.status).toBe(201);

    const fetched = await api(`/auctions/${auctionId}`);
    expect(fetched.body.auction.highestBidCents).toBe(1500);
    expect(fetched.body.auction.bidCount).toBe(2);

    const bids = await api(`/auctions/${auctionId}/bids`);
    expect(bids.body.bids.map((b) => b.amountCents)).toEqual([1500, 1000]);
  });

  it('resolves a winning auction: ownership transfers, build clears, seller is paid in dállers', async () => {
    const owner = await createBuilder('Resolve Winner Owner');
    const bidder = await createBuilder('Resolve Winner Bidder');
    await createGreenbeltLandlet('auction-resolve-win-landlet');
    await claim('auction-resolve-win-landlet', owner);
    await api('/instances', {
      method: 'POST',
      body: JSON.stringify({ landletId: 'auction-resolve-win-landlet', templateId: 'placeholder-tree', x: 1, y: 1 }),
    });
    const started = await api('/landlets/auction-resolve-win-landlet/auction', {
      method: 'POST', body: JSON.stringify({ builderId: owner, startingBidCents: 0 }),
    });
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, {
      method: 'POST', body: JSON.stringify({ builderId: bidder, amountCents: 2500 }),
    });

    // Force it into the past directly via the DB, the same test-only
    // escape hatch used elsewhere in this file, rather than waiting a real
    // hour or mocking Date globally.
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const resolved = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
    expect(resolved.response.status).toBe(200);
    expect(resolved.body.auction.status).toBe('ended');
    expect(resolved.body.auction.winningBidId).not.toBeNull();

    const landlet = await api('/landlets/auction-resolve-win-landlet');
    expect(landlet.body.landlet.ownerBuilderId).toBe(bidder);
    expect(landlet.body.landlet.status).toBe('claimed');
    expect(landlet.body.landlet.activeVersionId).toBeNull();

    const instances = await api('/instances?landletId=auction-resolve-win-landlet');
    expect(instances.body.instances).toEqual([]);

    const builders = await api('/builders');
    const sellerAfter = builders.body.builders.find((b) => b.builderId === owner);
    expect(sellerAfter.dallersBalanceCents).toBe(2500);

    const sellerNotices = await api(`/notifications?builderId=${owner}`);
    expect(sellerNotices.body.notifications.some((n) => n.message.includes('sold for $25.00'))).toBe(true);
    const bidderNotices = await api(`/notifications?builderId=${bidder}`);
    expect(bidderNotices.body.notifications.some((n) => n.message.includes('You won the auction'))).toBe(true);

    // Resolving again is a harmless no-op, not an error — it just returns
    // the already-ended auction's current (unchanged) state. The 409 case
    // is specifically "not due yet," covered by the next test.
    const resolveAgain = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
    expect(resolveAgain.response.status).toBe(200);
    expect(resolveAgain.body.auction.winningBidId).toBe(resolved.body.auction.winningBidId);
  });

  it('rejects resolving an auction that is not due yet', async () => {
    const owner = await createBuilder('Not Due Owner');
    await createGreenbeltLandlet('auction-not-due-landlet');
    await claim('auction-not-due-landlet', owner);
    const started = await api('/landlets/auction-not-due-landlet/auction', {
      method: 'POST', body: JSON.stringify({ builderId: owner, durationHours: 24 }),
    });
    const notDue = await api(`/auctions/${started.body.auction.auctionId}/resolve`, { method: 'POST' });
    expect(notDue.response.status).toBe(409);
  });

  it('releases an unsold $0-starting-bid auction to greenbelt', async () => {
    const owner = await createBuilder('Relinquish Owner');
    await createGreenbeltLandlet('auction-relinquish-landlet');
    await claim('auction-relinquish-landlet', owner);
    const started = await api('/landlets/auction-relinquish-landlet/auction', {
      method: 'POST', body: JSON.stringify({ builderId: owner, startingBidCents: 0, durationHours: 1 }),
    });
    const auctionId = started.body.auction.auctionId;
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const resolved = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
    expect(resolved.response.status).toBe(200);
    expect(resolved.body.auction.status).toBe('ended');
    expect(resolved.body.auction.winningBidId).toBeNull();

    const landlet = await api('/landlets/auction-relinquish-landlet');
    expect(landlet.body.landlet.status).toBe('greenbelt');
    expect(landlet.body.landlet.ownerBuilderId).toBeNull();

    const notices = await api(`/notifications?builderId=${owner}`);
    expect(notices.body.notifications.some((n) => n.message.includes('released to greenbelt'))).toBe(true);
  });

  it('keeps an unsold reserved (>$0 starting bid) auction with its seller', async () => {
    const owner = await createBuilder('Reserved Owner');
    await createGreenbeltLandlet('auction-reserved-landlet');
    await claim('auction-reserved-landlet', owner);
    const started = await api('/landlets/auction-reserved-landlet/auction', {
      method: 'POST', body: JSON.stringify({ builderId: owner, startingBidCents: 5000, durationHours: 1 }),
    });
    const auctionId = started.body.auction.auctionId;
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const resolved = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
    expect(resolved.response.status).toBe(200);

    const landlet = await api('/landlets/auction-reserved-landlet');
    expect(landlet.body.landlet.status).toBe('claimed');
    expect(landlet.body.landlet.ownerBuilderId).toBe(owner);

    const notices = await api(`/notifications?builderId=${owner}`);
    expect(notices.body.notifications.some((n) => n.message.includes('you keep the land'))).toBe(true);
  });

  it('notifies the seller of each new bid and the previous highest bidder of being outbid', async () => {
    const owner = await createBuilder('Bid Notice Owner');
    const bidderA = await createBuilder('Bid Notice Bidder A');
    const bidderB = await createBuilder('Bid Notice Bidder B');
    await createGreenbeltLandlet('auction-bid-notice-landlet');
    await claim('auction-bid-notice-landlet', owner);
    const started = await api('/landlets/auction-bid-notice-landlet/auction', {
      method: 'POST', body: JSON.stringify({ builderId: owner, startingBidCents: 1000 }),
    });
    const auctionId = started.body.auction.auctionId;

    await api(`/auctions/${auctionId}/bids`, {
      method: 'POST', body: JSON.stringify({ builderId: bidderA, amountCents: 1000 }),
    });
    const ownerAfterFirstBid = await api(`/notifications?builderId=${owner}`);
    expect(ownerAfterFirstBid.body.notifications.some((n) => n.message.includes('New bid of $10.00'))).toBe(true);
    // No previous bidder to outbid yet.
    const bidderAAfterFirstBid = await api(`/notifications?builderId=${bidderA}`);
    expect(bidderAAfterFirstBid.body.notifications).toHaveLength(0);

    await api(`/auctions/${auctionId}/bids`, {
      method: 'POST', body: JSON.stringify({ builderId: bidderB, amountCents: 1500 }),
    });
    const ownerAfterSecondBid = await api(`/notifications?builderId=${owner}`);
    expect(ownerAfterSecondBid.body.notifications.filter((n) => n.message.includes('New bid'))).toHaveLength(2);
    const bidderANotified = await api(`/notifications?builderId=${bidderA}`);
    expect(bidderANotified.body.notifications.some((n) => n.message.includes('outbid') && n.message.includes('$15.00'))).toBe(true);
  });

  it('auto-resolves an expired auction when the list endpoint is read, without an explicit resolve call', async () => {
    const owner = await createBuilder('Auto Resolve Owner');
    await createGreenbeltLandlet('auction-auto-resolve-landlet');
    await claim('auction-auto-resolve-landlet', owner);
    const started = await api('/landlets/auction-auto-resolve-landlet/auction', {
      method: 'POST', body: JSON.stringify({ builderId: owner, startingBidCents: 0, durationHours: 1 }),
    });
    const auctionId = started.body.auction.auctionId;
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const list = await api('/auctions?status=active');
    expect(list.body.auctions.some((a) => a.auctionId === auctionId)).toBe(false);

    const fetched = await api(`/auctions/${auctionId}`);
    expect(fetched.body.auction.status).toBe('ended');
  });

  it('rejects bids on an auction that has already ended', async () => {
    const owner = await createBuilder('Ended Bid Owner');
    const bidder = await createBuilder('Ended Bid Bidder');
    await createGreenbeltLandlet('auction-ended-bid-landlet');
    await claim('auction-ended-bid-landlet', owner);
    const started = await api('/landlets/auction-ended-bid-landlet/auction', {
      method: 'POST', body: JSON.stringify({ builderId: owner, startingBidCents: 0, durationHours: 1 }),
    });
    const auctionId = started.body.auction.auctionId;
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const bid = await api(`/auctions/${auctionId}/bids`, {
      method: 'POST', body: JSON.stringify({ builderId: bidder, amountCents: 100 }),
    });
    expect(bid.response.status).toBe(409);
  });
});

describe('Friendships', () => {
  async function createBuilder(label) {
    const res = await api('/builders', { method: 'POST', body: JSON.stringify({ label }) });
    return res.body.builder.builderId;
  }

  async function claim(landletId, builderId) {
    return api(`/landlets/${landletId}/claim`, { method: 'POST', body: JSON.stringify({ builderId }) });
  }

  it('rejects a request between a builder and themselves', async () => {
    const solo = await createBuilder('Solo Builder');
    const rejected = await api('/friendships', {
      method: 'POST', body: JSON.stringify({ requesterBuilderId: solo, recipientBuilderId: solo }),
    });
    expect(rejected.response.status).toBe(400);
  });

  it('rejects a request referencing a builder that does not exist', async () => {
    const real = await createBuilder('Real Builder');
    const rejected = await api('/friendships', {
      method: 'POST', body: JSON.stringify({ requesterBuilderId: real, recipientBuilderId: 'builder-does-not-exist' }),
    });
    expect(rejected.response.status).toBe(400);
  });

  it('sends, lists (with direction), accepts, and shows the accepted friend on both sides', async () => {
    const alice = await createBuilder('Friendship Alice');
    const bob = await createBuilder('Friendship Bob');
    await createGreenbeltLandlet('friendship-bob-landlet');
    await claim('friendship-bob-landlet', bob);

    const sent = await api('/friendships', {
      method: 'POST', body: JSON.stringify({ requesterBuilderId: alice, recipientBuilderId: bob }),
    });
    expect(sent.response.status).toBe(201);
    expect(sent.body.friendship).toMatchObject({
      requesterBuilderId: alice,
      recipientBuilderId: bob,
      status: 'pending',
      otherBuilderId: bob,
      otherLabel: 'Friendship Bob',
      direction: 'outgoing',
    });
    const friendshipId = sent.body.friendship.friendshipId;

    // Alice's own list shows it outgoing; Bob's shows the same row incoming.
    const aliceList = await api(`/friendships?builderId=${alice}`);
    expect(aliceList.body.friendships).toHaveLength(1);
    expect(aliceList.body.friendships[0].direction).toBe('outgoing');
    expect(aliceList.body.friendships[0].status).toBe('pending');

    const bobList = await api(`/friendships?builderId=${bob}`);
    expect(bobList.body.friendships).toHaveLength(1);
    expect(bobList.body.friendships[0].direction).toBe('incoming');
    expect(bobList.body.friendships[0].otherLabel).toBe('Friendship Alice');
    // Bob hasn't claimed anything yet at this point in the test — Alice
    // (the one being looked up from Bob's list) has no lándlet.
    expect(bobList.body.friendships[0].otherLandlet).toBeNull();

    const accepted = await api(`/friendships/${friendshipId}`, {
      method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
    });
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.friendship.status).toBe('accepted');

    // From Alice's side, the "approximate location" is Bob's claimed lándlet.
    const aliceListAfter = await api(`/friendships?builderId=${alice}`);
    expect(aliceListAfter.body.friendships[0].status).toBe('accepted');
    expect(aliceListAfter.body.friendships[0].otherLandlet).toMatchObject({
      landletId: 'friendship-bob-landlet',
    });
  });

  it('rejects a second request between the same pair in either direction', async () => {
    const a = await createBuilder('Duplicate A');
    const b = await createBuilder('Duplicate B');
    await api('/friendships', { method: 'POST', body: JSON.stringify({ requesterBuilderId: a, recipientBuilderId: b }) });

    const sameDirection = await api('/friendships', {
      method: 'POST', body: JSON.stringify({ requesterBuilderId: a, recipientBuilderId: b }),
    });
    expect(sameDirection.response.status).toBe(409);

    const reverseDirection = await api('/friendships', {
      method: 'POST', body: JSON.stringify({ requesterBuilderId: b, recipientBuilderId: a }),
    });
    expect(reverseDirection.response.status).toBe(409);
  });

  it('lets a request be declined (deleted while pending) or an accepted friendship removed', async () => {
    const a = await createBuilder('Decline A');
    const b = await createBuilder('Decline B');
    const sent = await api('/friendships', {
      method: 'POST', body: JSON.stringify({ requesterBuilderId: a, recipientBuilderId: b }),
    });
    const friendshipId = sent.body.friendship.friendshipId;

    const declined = await api(`/friendships/${friendshipId}`, { method: 'DELETE' });
    expect(declined.response.status).toBe(200);
    expect(declined.body).toEqual({ deleted: true });

    // Declining frees the pair up to request again — proves the DELETE
    // really removed the row rather than just marking it something else.
    const resent = await api('/friendships', {
      method: 'POST', body: JSON.stringify({ requesterBuilderId: a, recipientBuilderId: b }),
    });
    expect(resent.response.status).toBe(201);

    const deleteMissing = await api('/friendships/friendship-does-not-exist', { method: 'DELETE' });
    expect(deleteMissing.response.status).toBe(404);

    const patchMissing = await api('/friendships/friendship-does-not-exist', {
      method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
    });
    expect(patchMissing.response.status).toBe(404);
  });

  it('rejects an invalid status transition', async () => {
    const a = await createBuilder('Invalid Status A');
    const b = await createBuilder('Invalid Status B');
    const sent = await api('/friendships', {
      method: 'POST', body: JSON.stringify({ requesterBuilderId: a, recipientBuilderId: b }),
    });
    const rejected = await api(`/friendships/${sent.body.friendship.friendshipId}`, {
      method: 'PATCH', body: JSON.stringify({ status: 'pending' }),
    });
    expect(rejected.response.status).toBe(400);
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

    const valid = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'digital-good-valid',
        name: 'Downloadable Gift Card',
        color: '#111111',
        dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
        metadata: { digitalGoodDisclaimer: 'gift-card' },
      }),
    });
    expect(valid.response.status).toBe(201);
    expect(valid.body.template.metadata.digitalGoodDisclaimer).toBe('gift-card');

    const fetched = await api('/catalog/digital-good-valid');
    expect(fetched.body.template.metadata.digitalGoodDisclaimer).toBe('gift-card');
  });

  it('lets a digital-good flag be cleared by omitting it from a metadata replace', async () => {
    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'digital-good-to-clear',
        name: 'Temporary Digital Good',
        color: '#111111',
        dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
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

// Land cap (docs/SPEC.md §3) is deliberately TRACKING-ONLY here, not
// enforced against auction bids — see worker/index.js's own long comment
// on recomputeLandCap for why a hard block was tried and reverted (claiming
// is mandatory to use Build mode at all, the default cap exactly equals the
// mandatory starter lándlet's own size, and this dev-mode backend has no
// real commerce/commission system — spec's actual PRIMARY earning path —
// so auction sale proceeds are the only dáller source that exists; hard-
// enforcing against that one source alone would make growing past your
// starter lándlet structurally impossible for every builder). These tests
// cover the formula, the ratchet, and the per-event ledger — all real and
// correctly implemented — without asserting anything is blocked.
describe('Land cap', () => {
  async function createBuilder(label) {
    const res = await api('/builders', { method: 'POST', body: JSON.stringify({ label }) });
    return res.body.builder.builderId;
  }

  async function createGreenbeltLandletWithArea(landletId, areaM2) {
    return api('/landlets', {
      method: 'POST',
      body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2, status: 'greenbelt' }),
    });
  }

  async function claim(landletId, builderId) {
    return api(`/landlets/${landletId}/claim`, { method: 'POST', body: JSON.stringify({ builderId }) });
  }

  async function startAuction(landletId, sellerBuilderId) {
    return api(`/landlets/${landletId}/auction`, {
      method: 'POST',
      body: JSON.stringify({ builderId: sellerBuilderId, startingBidCents: 0, durationHours: 1 }),
    });
  }

  function landCapOf(listResponse, builderId) {
    return listResponse.body.builders.find((b) => b.builderId === builderId).landCapM2;
  }

  it('defaults every new builder to a 1000 m² land cap', async () => {
    const builderId = await createBuilder('Land Cap Default Builder');
    expect(landCapOf(await api('/builders'), builderId)).toBe(1000);
  });

  it('does not block a bid that would exceed the bidder\'s cap — tracking only, not enforced', async () => {
    const seller = await createBuilder('Land Cap Seller A');
    const bidder = await createBuilder('Land Cap Bidder A');
    await createGreenbeltLandletWithArea('land-cap-big-landlet', 5000);
    await claim('land-cap-big-landlet', seller);
    const started = await startAuction('land-cap-big-landlet', seller);
    const bid = await api(`/auctions/${started.body.auction.auctionId}/bids`, {
      method: 'POST', body: JSON.stringify({ builderId: bidder, amountCents: 100 }),
    });
    expect(bid.response.status).toBe(201);
  });

  it('grows a builder\'s land cap from trailing dáller earnings, normalized per 1000 m² owned', async () => {
    const builderId = await createBuilder('Land Cap Formula Builder');
    // $40 of trailing earnings, normalized against zero owned (floored to
    // the 1000 m² baseline), at 100 m² per dollar per 1000 m² owned =>
    // +4000 m² -> candidate cap 5000.
    await env.DB.prepare(`
      INSERT INTO daller_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
    `).bind('land-cap-formula-earning', builderId, 4000).run();
    expect(landCapOf(await api('/builders'), builderId)).toBe(5000);
  });

  it('ratchets — a cap increase never reverts even after the earnings that produced it age out of the trailing window', async () => {
    const builderId = await createBuilder('Land Cap Ratchet Builder');
    await env.DB.prepare(`
      INSERT INTO daller_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
    `).bind('land-cap-ratchet-earning', builderId, 4000).run();
    expect(landCapOf(await api('/builders'), builderId)).toBe(5000);

    // Age the earning out of the 30-day trailing window, then force another
    // recompute (any GET /builders does this) — the cap must NOT drop back
    // down even though the earnings that grew it are now stale, matching
    // docs/SPEC.md §3's "ratcheting: once increased, never decreases."
    await env.DB.prepare(`
      UPDATE daller_earnings_events SET created_at = '2000-01-01T00:00:00.000Z' WHERE event_id = ?
    `).bind('land-cap-ratchet-earning').run();
    expect(landCapOf(await api('/builders'), builderId)).toBe(5000);
  });

  it('credits a real per-event earnings ledger entry when an auction actually sells', async () => {
    const seller = await createBuilder('Land Cap Ledger Seller');
    const bidder = await createBuilder('Land Cap Ledger Bidder');
    await createGreenbeltLandletWithArea('land-cap-ledger-landlet', 1000);
    await claim('land-cap-ledger-landlet', seller);
    const started = await startAuction('land-cap-ledger-landlet', seller);
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, {
      method: 'POST', body: JSON.stringify({ builderId: bidder, amountCents: 500 }),
    });
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();
    await api(`/auctions/${auctionId}`); // GET resolves a due auction lazily

    const { results } = await env.DB.prepare(
      'SELECT * FROM daller_earnings_events WHERE builder_id = ?',
    ).bind(seller).all();
    expect(results).toHaveLength(1);
    expect(results[0].amount_cents).toBe(500);
  });

  it('lets a builder claim their one free starter lándlet regardless of the land cap', async () => {
    // The claim endpoint's own NOT EXISTS guard already limits a builder to
    // exactly one claimed lándlet at a time regardless of land cap, so a
    // fresh builder's default 1000 m² cap claiming a 1000 m² starter
    // lándlet is unaffected by this feature at all.
    const builderId = await createBuilder('Land Cap Claim Builder');
    await createGreenbeltLandletWithArea('land-cap-starter-landlet', 1000);
    const claimed = await claim('land-cap-starter-landlet', builderId);
    expect(claimed.response.status).toBe(200);
    expect(claimed.body.landlet.ownerBuilderId).toBe(builderId);
  });
});
