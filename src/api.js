// Thin wrapper around the backend Worker API (worker/index.js). Every call
// here can fail — network down, Worker not deployed yet, etc. Callers are
// expected to catch and fall back to layoutStorage.js's localStorage
// functions, not this module; nothing in here retries or caches.
const API_BASE = '/api';

async function requestJson(path, options) {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `${path} failed with HTTP ${response.status}`);
  }
  return response.json();
}

// Paginated server-side (100 per request, same as instances/landlets) —
// pages through everything rather than silently keeping only the first
// 100 templates once the catalog grows past that.
export async function fetchCatalog() {
  const all = [];
  let cursor;
  for (;;) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const { templates, nextCursor } = await requestJson(`/catalog?${query.toString()}`);
    all.push(...templates);
    if (!nextCursor) return all;
    cursor = nextCursor;
  }
}

export async function fetchBuilders() {
  const { builders } = await requestJson('/builders');
  return builders;
}

export async function createBuilder(label, builderId) {
  const { builder } = await requestJson('/builders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(builderId ? { label, builderId } : { label }),
  });
  return builder;
}

export async function renameBuilder(builderId, label) {
  const { builder } = await requestJson(`/builders/${encodeURIComponent(builderId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  return builder;
}

// Releases whatever this builder currently owns back to greenbelt
// server-side (see docs/API.md) — the caller doesn't need to separately
// reset the landlet.
export async function deleteBuilder(builderId) {
  const result = await requestJson(`/builders/${encodeURIComponent(builderId)}`, { method: 'DELETE' });
  return result.releasedLandletIds;
}

// Pages through every instance on a landlet rather than returning just the
// first 100 (the server's per-request cap) — a landlet with a large build
// (a brick wall hundreds of pieces deep, say) silently lost everything
// past the first page otherwise, without so much as a sign anything was
// missing. Same pattern as fetchAllLandlets() below.
export async function fetchInstances(landletId) {
  const all = [];
  let cursor;
  for (;;) {
    const query = new URLSearchParams({ landletId, limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const { instances, nextCursor } = await requestJson(`/instances?${query.toString()}`);
    all.push(...instances);
    if (!nextCursor) return all;
    cursor = nextCursor;
  }
}

export async function fetchWorld() {
  const { world } = await requestJson('/world');
  return world;
}

// params is a plain object of query string keys (status, ownerBuilderId,
// limit, ...) — only non-null/undefined ones are included, so callers can
// pass `{ status, ownerBuilderId }` without worrying about either being
// unset.
export async function fetchLandlets(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) query.set(key, value);
  }
  const suffix = query.toString();
  const { landlets } = await requestJson(`/landlets${suffix ? `?${suffix}` : ''}`);
  return landlets;
}

export async function fetchLandlet(landletId) {
  const { landlet } = await requestJson(`/landlets/${encodeURIComponent(landletId)}`);
  return landlet;
}

// Pages through every landlet regardless of world size — unlike
// fetchLandlets above (which returns one page and drops nextCursor), Shop
// mode needs the whole world's ground shapes up front, not just the first
// 100.
export async function fetchAllLandlets() {
  const all = [];
  let cursor;
  for (;;) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const { landlets, nextCursor } = await requestJson(`/landlets?${query.toString()}`);
    all.push(...landlets);
    if (!nextCursor) return all;
    cursor = nextCursor;
  }
}

export async function claimLandlet(landletId, builderId) {
  const { landlet } = await requestJson(`/landlets/${encodeURIComponent(landletId)}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ builderId }),
  });
  return landlet;
}

// Grows the world circle by one configured increment, promoting any
// generation-complete landlets it now fully encloses to greenbelt. Throws
// (409, surfaced as a normal Error) if the greenbelt reserve is already at
// or above the configured minimum ratio.
export async function expandWorld() {
  const { world } = await requestJson('/world/expand', { method: 'POST' });
  return world;
}

// Procedurally creates one gap-free band of wedge-shaped land candidates —
// see docs/API.md's "POST /api/land-candidates/generate-ring". Candidates
// whose inner edge already touches the current world boundary (the default
// when innerRadiusM is omitted) materialize immediately as 'generating'
// landlets; they still need completeRingGeneration + enough expandWorld()
// calls before they can become claimable.
export async function generateLandRing(params) {
  return requestJson('/land-candidates/generate-ring', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export async function fetchLandCandidateRing(ringId) {
  const { ring } = await requestJson(`/land-candidate-rings/${encodeURIComponent(ringId)}`);
  return ring;
}

// Marks every (already-materialized) landlet in a generated ring as
// generation-complete, making it eligible to promote to greenbelt the next
// time the world encloses it. Throws if any ring member hasn't materialized
// yet — see generateLandRing's doc comment.
export async function completeRingGeneration(ringId) {
  return requestJson(`/land-candidate-rings/${encodeURIComponent(ringId)}/generation-complete`, {
    method: 'POST',
  });
}

export async function createInstanceRemote(instance) {
  const { instance: created } = await requestJson('/instances', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(instance),
  });
  return created;
}

export async function updateInstanceRemote(instanceId, patch) {
  const { instance: updated } = await requestJson(`/instances/${encodeURIComponent(instanceId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return updated;
}

export async function deleteInstanceRemote(instanceId) {
  await requestJson(`/instances/${encodeURIComponent(instanceId)}`, { method: 'DELETE' });
}

const INSTANCE_BATCH_CHUNK_SIZE = 100; // matches the worker's own per-request cap

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

// Bulk create/update/delete, used anywhere many instances change at once
// (paste, a multi-item group move, multi-delete, and undo/redo restoring a
// snapshot that touches several). Chunks sequentially (never all at once)
// rather than firing one request per item: hundreds of simultaneous
// fire-and-forget single-instance requests is exactly the load pattern that
// let some quietly never reach the server while the rest succeeded, with
// nothing to tell the builder anything had gone wrong until their next
// reload silently came back short.
export async function createInstancesRemote(instances) {
  const created = [];
  for (const batch of chunk(instances, INSTANCE_BATCH_CHUNK_SIZE)) {
    const { instances: stored } = await requestJson('/instances/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instances: batch }),
    });
    created.push(...stored);
  }
  return created;
}

export async function upsertInstancesRemote(instances) {
  const updated = [];
  for (const batch of chunk(instances, INSTANCE_BATCH_CHUNK_SIZE)) {
    const { instances: stored } = await requestJson('/instances/batch', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instances: batch }),
    });
    updated.push(...stored);
  }
  return updated;
}

export async function deleteInstancesRemote(instanceIds) {
  for (const batch of chunk(instanceIds, INSTANCE_BATCH_CHUNK_SIZE)) {
    await requestJson('/instances/batch', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceIds: batch }),
    });
  }
}

// Uploads a .glb file directly. Distinct from requestJson above since this
// needs a raw multipart body, not a JSON one.
export async function uploadModelFile(file) {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(`${API_BASE}/models`, { method: 'POST', body: form });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Model upload failed with HTTP ${response.status}`);
  }
  return response.json(); // { modelUrl, sourceName, sizeBytes }
}

export async function createCatalogTemplate(template) {
  const { template: created } = await requestJson('/catalog', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(template),
  });
  return created;
}

export async function updateCatalogTemplate(templateId, patch) {
  const { template: updated } = await requestJson(`/catalog/${encodeURIComponent(templateId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return updated;
}

export async function deleteCatalogTemplate(templateId) {
  await requestJson(`/catalog/${encodeURIComponent(templateId)}`, { method: 'DELETE' });
}
