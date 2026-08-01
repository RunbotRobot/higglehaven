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
    expect(body).toMatchObject({ sourceName: 'chair.glb', sizeBytes: 24 });
    expect(body.modelUrl).toMatch(/^\/uploads\/models\/[0-9a-f-]+\.glb$/);

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
    expect(rejected.headers.get('allow')).toBe('GET, HEAD');
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
    for (const [templateId, name] of [
      ['catalog-page-b', 'Catalog same name'],
      ['catalog-page-a', 'Catalog same name'],
      ['catalog-page-c', 'Catalog trailing name'],
    ]) {
      const created = await api('/catalog', {
        method: 'POST',
        body: JSON.stringify({
          templateId,
          name,
          category: 'pagination-test',
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
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

    const invalidCategory = await api('/catalog?category=');
    expect(invalidCategory.response.status).toBe(400);
    const invalidLimit = await api('/catalog?limit=101');
    expect(invalidLimit.response.status).toBe(400);
    const invalidCursor = await api('/catalog?cursor=invalid');
    expect(invalidCursor.response.status).toBe(400);
    expect(invalidCursor.body).toEqual({ error: 'cursor is invalid' });
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

    const invalidLandlet = await api('/instances?landletId=');
    expect(invalidLandlet.response.status).toBe(400);
    const invalidLimit = await api('/instances?limit=0');
    expect(invalidLimit.response.status).toBe(400);
    const invalidCursor = await api('/instances?cursor=invalid');
    expect(invalidCursor.response.status).toBe(400);
    expect(invalidCursor.body).toEqual({ error: 'cursor is invalid' });
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

    const invalid = await api('/landlets/starter-landlet/generation-complete', { method: 'POST' });
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
  });

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
