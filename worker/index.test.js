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

describe('Worker API', () => {
  it('reports health and serves migrated seed data', async () => {
    const health = await api('/health');
    expect(health.response.status).toBe(200);
    expect(health.body).toEqual({ ok: true, service: 'higglehaven-api' });

    const catalog = await api('/catalog');
    expect(catalog.response.status).toBe(200);
    expect(catalog.body.templates.length).toBeGreaterThan(0);

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
    expect(malformedJson.body).toEqual({ error: 'Request body must contain valid JSON' });

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
    expect(missingReference.response.status).toBe(409);
    expect(missingReference.body).toEqual({
      error: 'Referenced resource does not exist or is still in use',
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
