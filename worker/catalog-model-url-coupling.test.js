// #1753: modelUrl, modelSizeBytes and skeletonSignature describe one file. A
// PATCH that moves modelUrl alone used to leave the size and rig signature
// describing the old model. Now a modelUrl change must bring its own size
// (400 otherwise), and an omitted signature is cleared rather than kept stale.
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, glbFile, signupSeller } from './test-helpers.js';

const SIGNATURE = 'a'.repeat(64);
const OTHER_SIGNATURE = 'b'.repeat(64);

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function uploadModel(marker) {
  const form = new FormData();
  form.set('file', glbFile({ json: `{"catalogModelUrlCoupling":"${marker}"}` }));
  const uploaded = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form });
  expect(uploaded.status).toBe(201);
  return uploaded.json();
}

async function createTemplate(seller, templateId, upload, extra = {}) {
  const created = await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({
      templateId,
      sellerId: seller.sellerId,
      name: `Coupling ${templateId}`,
      color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents: 500,
      modelUrl: upload.modelUrl,
      modelSizeBytes: upload.sizeBytes,
      ...extra,
    }),
  }));
  expect(created.response.status).toBe(201);
}

function patch(seller, templateId, body) {
  return api(`/catalog/${templateId}`, seller.session({ method: 'PATCH', body: JSON.stringify(body) }));
}

async function storedModelFields(templateId) {
  return env.DB.prepare('SELECT model_url, model_size_bytes, skeleton_signature FROM catalog_templates WHERE template_id = ?')
    .bind(templateId).first();
}

describe('PATCH /catalog/:templateId keeps modelUrl, modelSizeBytes and skeletonSignature together (#1753)', () => {
  it('rejects a modelUrl change that does not carry its modelSizeBytes, and writes nothing', async () => {
    const seller = await signupSeller('cmuc-reject-seller');
    const first = await uploadModel('reject-first');
    const second = await uploadModel('reject-second');
    await createTemplate(seller, 'cmuc-reject-template', first);

    const rejected = await patch(seller, 'cmuc-reject-template', { modelUrl: second.modelUrl });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toBe('modelSizeBytes is required when modelUrl changes');
    const stored = await storedModelFields('cmuc-reject-template');
    expect(stored.model_url).toBe(first.modelUrl);
    expect(stored.model_size_bytes).toBe(first.sizeBytes);
  });

  it('clears a stale skeletonSignature when the modelUrl changes without a new one', async () => {
    const seller = await signupSeller('cmuc-clear-seller');
    const first = await uploadModel('clear-first');
    const second = await uploadModel('clear-second');
    await createTemplate(seller, 'cmuc-clear-template', first, { skeletonSignature: SIGNATURE });

    const swapped = await patch(seller, 'cmuc-clear-template', { modelUrl: second.modelUrl, modelSizeBytes: second.sizeBytes });
    expect(swapped.response.status).toBe(200);
    expect(swapped.body.template.skeletonSignature).toBeNull();
    const stored = await storedModelFields('cmuc-clear-template');
    expect(stored).toEqual({ model_url: second.modelUrl, model_size_bytes: second.sizeBytes, skeleton_signature: null });
  });

  it('keeps a skeletonSignature that is sent together with the new modelUrl', async () => {
    const seller = await signupSeller('cmuc-keep-seller');
    const first = await uploadModel('keep-first');
    const second = await uploadModel('keep-second');
    await createTemplate(seller, 'cmuc-keep-template', first, { skeletonSignature: SIGNATURE });

    const swapped = await patch(seller, 'cmuc-keep-template', {
      modelUrl: second.modelUrl, modelSizeBytes: second.sizeBytes, skeletonSignature: OTHER_SIGNATURE,
    });
    expect(swapped.response.status).toBe(200);
    expect((await storedModelFields('cmuc-keep-template')).skeleton_signature).toBe(OTHER_SIGNATURE);
  });

  it('leaves size and signature alone for edits that do not change modelUrl, including re-sending the same one', async () => {
    const seller = await signupSeller('cmuc-same-seller');
    const first = await uploadModel('same-first');
    await createTemplate(seller, 'cmuc-same-template', first, { skeletonSignature: SIGNATURE });

    const renamed = await patch(seller, 'cmuc-same-template', { name: 'Renamed' });
    expect(renamed.response.status).toBe(200);
    const resent = await patch(seller, 'cmuc-same-template', { modelUrl: first.modelUrl });
    expect(resent.response.status).toBe(200);
    expect(await storedModelFields('cmuc-same-template')).toEqual({
      model_url: first.modelUrl, model_size_bytes: first.sizeBytes, skeleton_signature: SIGNATURE,
    });
  });
});
