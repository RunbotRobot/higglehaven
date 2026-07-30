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

export async function fetchCatalog() {
  const { templates } = await requestJson('/catalog');
  return templates;
}

export async function fetchInstances() {
  const { instances } = await requestJson('/instances');
  return instances;
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
