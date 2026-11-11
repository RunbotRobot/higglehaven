// #3414 (Model tiers 2/7, part of #3412): a product names a mid and a far
// version of its own model (migrations/0220). They are stored objects in the
// shared MODELS bucket, so they get the same validation as modelUrl, follow
// the replace/duplicate rules, and are protected from the orphan sweep.
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupUnreferencedModels } from './lib/models.js';
import { api, glbFile, signupAdmin, signupSeller } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('catalog-model-tiers-admin');
  adminSession = admin.session;
});

// `weight` pads the JSON chunk, so a "full" model is genuinely bigger than the
// tiers a test stores beside it.
async function uploadModel(marker, { weight = 0, tier, ip } = {}) {
  const form = new FormData();
  form.set('file', glbFile({ json: JSON.stringify({ catalogModelTiers: marker, pad: 'x'.repeat(weight) }) }));
  const headers = ip ? { 'cf-connecting-ip': ip } : {};
  const response = await SELF.fetch(`https://higglehaven.test/api/models${tier ? `?tier=${tier}` : ''}`, {
    method: 'POST', body: form, headers,
  });
  return { status: response.status, ...(await response.json()) };
}

async function uploadSet(marker) {
  const full = await uploadModel(`${marker}-full`, { weight: 4000 });
  const mid = await uploadModel(`${marker}-mid`, { weight: 1000, tier: 'mid' });
  const far = await uploadModel(`${marker}-far`, { weight: 10, tier: 'far' });
  expect([full.status, mid.status, far.status]).toEqual([201, 201, 201]);
  return { full, mid, far };
}

function createBody(seller, templateId, full, extra = {}) {
  return {
    templateId,
    sellerId: seller.sellerId,
    name: `Tiers ${templateId}`,
    color: '#123456',
    dimensions: { width: 1, depth: 1, height: 1 },
    priceCents: 500,
    modelUrl: full.modelUrl,
    modelSizeBytes: full.sizeBytes,
    ...extra,
  };
}

function create(seller, templateId, full, extra) {
  return api('/catalog', seller.session({ method: 'POST', body: JSON.stringify(createBody(seller, templateId, full, extra)) }));
}

function patch(seller, templateId, body) {
  return api(`/catalog/${templateId}`, seller.session({ method: 'PATCH', body: JSON.stringify(body) }));
}

const storedTemplate = (id) => env.DB.prepare('SELECT model_url, model_mid_url, model_far_url FROM catalog_templates WHERE template_id = ?').bind(id).first();
const storedProduct = (id) => env.DB.prepare('SELECT model_url, model_mid_url, model_far_url FROM products WHERE product_id = ?').bind(id).first();

describe('creating a product with model tiers', () => {
  it('stores the tier URLs on the listing and its product, and returns them', async () => {
    const seller = await signupSeller('cmt-create-seller');
    const { full, mid, far } = await uploadSet('create');
    const created = await create(seller, 'cmt-create', full, { modelMidUrl: mid.modelUrl, modelFarUrl: far.modelUrl });
    expect(created.response.status).toBe(201);
    expect(created.body.template).toMatchObject({ modelUrl: full.modelUrl, modelMidUrl: mid.modelUrl, modelFarUrl: far.modelUrl });
    expect(await storedTemplate('cmt-create')).toEqual({ model_url: full.modelUrl, model_mid_url: mid.modelUrl, model_far_url: far.modelUrl });
    expect(await storedProduct('cmt-create')).toEqual({ model_url: full.modelUrl, model_mid_url: mid.modelUrl, model_far_url: far.modelUrl });
  });

  it('returns null tiers for a product that has none, and accepts just one of the two', async () => {
    const seller = await signupSeller('cmt-none-seller');
    const { full, mid } = await uploadSet('none');
    const plain = await create(seller, 'cmt-plain', full);
    expect(plain.response.status).toBe(201);
    expect(plain.body.template).toMatchObject({ modelMidUrl: null, modelFarUrl: null });
    const midOnly = await create(seller, 'cmt-mid-only', full, { modelMidUrl: mid.modelUrl });
    expect(midOnly.response.status).toBe(201);
    expect(midOnly.body.template).toMatchObject({ modelMidUrl: mid.modelUrl, modelFarUrl: null });
  });

  it('applies the same validation as modelUrl', async () => {
    const seller = await signupSeller('cmt-validate-seller');
    const { full, mid, far } = await uploadSet('validate');

    const external = await create(seller, 'cmt-external', full, { modelMidUrl: 'https://example.com/m.glb' });
    expect(external.response.status).toBe(400);
    expect(external.body.error).toMatch(/modelMidUrl must reference an uploaded model/);

    const missing = await create(seller, 'cmt-missing', full, { modelFarUrl: '/uploads/models/not-there.glb' });
    expect(missing.response.status).toBe(400);
    expect(missing.body.error).toBe('modelFarUrl does not reference an existing uploaded model');

    // A thumbnail lives in the same bucket under another prefix; it is not a model.
    await env.MODELS.put('thumbnails/cmt.png', new Uint8Array([1, 2, 3]));
    const notAModel = await create(seller, 'cmt-thumb', full, { modelMidUrl: '/uploads/thumbnails/cmt.png' });
    expect(notAModel.response.status).toBe(400);

    const orphanTier = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'cmt-no-model', sellerId: seller.sellerId, name: 'No model', color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500, modelMidUrl: mid.modelUrl,
      }),
    }));
    expect(orphanTier.response.status).toBe(400);
    expect(orphanTier.body.error).toMatch(/modelMidUrl needs a modelUrl/);

    // A reduction must be smaller than what it reduces; the far set is, so it is accepted.
    expect((await create(seller, 'cmt-ok', full, { modelFarUrl: far.modelUrl })).response.status).toBe(201);
  });

  it('rejects a tier that is not smaller than the full model', async () => {
    const seller = await signupSeller('cmt-size-seller');
    const small = await uploadModel('size-small', { weight: 10 });
    const big = await uploadModel('size-big', { weight: 4000 });

    const larger = await create(seller, 'cmt-larger', small, { modelMidUrl: big.modelUrl });
    expect(larger.response.status).toBe(400);
    expect(larger.body.error).toBe('modelMidUrl must be smaller than the full model');
    const same = await create(seller, 'cmt-same', small, { modelFarUrl: small.modelUrl });
    expect(same.response.status).toBe(400);
    expect(same.body.error).toBe('modelFarUrl must be smaller than the full model');
    expect(await storedTemplate('cmt-larger')).toBeNull();
  });
});

describe('PATCH /catalog/:templateId and the tiers', () => {
  it('keeps the tiers on an edit that does not touch the model', async () => {
    const seller = await signupSeller('cmt-keep-seller');
    const { full, mid, far } = await uploadSet('keep');
    await create(seller, 'cmt-keep', full, { modelMidUrl: mid.modelUrl, modelFarUrl: far.modelUrl });
    const renamed = await patch(seller, 'cmt-keep', { name: 'Renamed' });
    expect(renamed.response.status).toBe(200);
    expect(renamed.body.template).toMatchObject({ modelMidUrl: mid.modelUrl, modelFarUrl: far.modelUrl });
    const resent = await patch(seller, 'cmt-keep', { modelUrl: full.modelUrl });
    expect(resent.response.status).toBe(200);
    expect(await storedTemplate('cmt-keep')).toEqual({ model_url: full.modelUrl, model_mid_url: mid.modelUrl, model_far_url: far.modelUrl });
  });

  it('drops the tiers when the model is replaced without new ones, so a reduction of the old file never stands in for the new', async () => {
    const seller = await signupSeller('cmt-replace-seller');
    const { full, mid, far } = await uploadSet('replace');
    const replacement = await uploadModel('replace-new', { weight: 3000 });
    await create(seller, 'cmt-replace', full, { modelMidUrl: mid.modelUrl, modelFarUrl: far.modelUrl });
    const swapped = await patch(seller, 'cmt-replace', { modelUrl: replacement.modelUrl, modelSizeBytes: replacement.sizeBytes });
    expect(swapped.response.status).toBe(200);
    expect(swapped.body.template).toMatchObject({ modelUrl: replacement.modelUrl, modelMidUrl: null, modelFarUrl: null });
    expect(await storedTemplate('cmt-replace')).toEqual({ model_url: replacement.modelUrl, model_mid_url: null, model_far_url: null });
  });

  it('takes new tiers sent with the replacement, and replaces just one when only one is sent', async () => {
    const seller = await signupSeller('cmt-newtier-seller');
    const { full, mid, far } = await uploadSet('newtier');
    const next = await uploadSet('newtier-next');
    await create(seller, 'cmt-newtier', full, { modelMidUrl: mid.modelUrl, modelFarUrl: far.modelUrl });
    const swapped = await patch(seller, 'cmt-newtier', {
      modelUrl: next.full.modelUrl, modelSizeBytes: next.full.sizeBytes,
      modelMidUrl: next.mid.modelUrl, modelFarUrl: next.far.modelUrl,
    });
    expect(swapped.response.status).toBe(200);
    expect(await storedTemplate('cmt-newtier')).toEqual({
      model_url: next.full.modelUrl, model_mid_url: next.mid.modelUrl, model_far_url: next.far.modelUrl,
    });
    const onlyFar = await patch(seller, 'cmt-newtier', { modelFarUrl: far.modelUrl });
    expect(onlyFar.response.status).toBe(200);
    expect(await storedTemplate('cmt-newtier')).toEqual({
      model_url: next.full.modelUrl, model_mid_url: next.mid.modelUrl, model_far_url: far.modelUrl,
    });
  });

  it('rejects a replacement tier that is larger than the new full model', async () => {
    const seller = await signupSeller('cmt-patchsize-seller');
    const { full, mid } = await uploadSet('patchsize');
    const tiny = await uploadModel('patchsize-tiny', { weight: 10 });
    await create(seller, 'cmt-patchsize', full, { modelMidUrl: mid.modelUrl });
    const rejected = await patch(seller, 'cmt-patchsize', {
      modelUrl: tiny.modelUrl, modelSizeBytes: tiny.sizeBytes, modelMidUrl: mid.modelUrl,
    });
    expect(rejected.response.status).toBe(400);
    expect((await storedTemplate('cmt-patchsize')).model_url).toBe(full.modelUrl);
  });
});

describe('copying a product (Sell this too and Duplicate)', () => {
  it('copies the product\'s tiers onto a new listing by another seller', async () => {
    const first = await signupSeller('cmt-share-first');
    const second = await signupSeller('cmt-share-second');
    const { full, mid, far } = await uploadSet('share');
    await create(first, 'cmt-share', full, { modelMidUrl: mid.modelUrl, modelFarUrl: far.modelUrl });
    const listed = await api('/catalog/listings', second.session({
      method: 'POST', body: JSON.stringify({ productId: 'cmt-share', priceCents: 700 }),
    }));
    expect(listed.response.status).toBe(201);
    expect(listed.body.template).toMatchObject({ modelUrl: full.modelUrl, modelMidUrl: mid.modelUrl, modelFarUrl: far.modelUrl });
  });

  it('drops a tier that has since disappeared rather than failing the listing', async () => {
    const first = await signupSeller('cmt-gone-first');
    const second = await signupSeller('cmt-gone-second');
    const { full, mid, far } = await uploadSet('gone');
    await create(first, 'cmt-gone', full, { modelMidUrl: mid.modelUrl, modelFarUrl: far.modelUrl });
    await env.MODELS.delete(mid.modelUrl.replace('/uploads/', ''));
    const listed = await api('/catalog/listings', second.session({
      method: 'POST', body: JSON.stringify({ productId: 'cmt-gone', priceCents: 700 }),
    }));
    expect(listed.response.status).toBe(201);
    expect(listed.body.template).toMatchObject({ modelUrl: full.modelUrl, modelMidUrl: null, modelFarUrl: null });
  });

  it('copies by reference when the Duplicate button sends the source tiers with a new listing', async () => {
    const seller = await signupSeller('cmt-dup-seller');
    const { full, mid, far } = await uploadSet('dup');
    await create(seller, 'cmt-dup-source', full, { modelMidUrl: mid.modelUrl, modelFarUrl: far.modelUrl });
    const copy = await create(seller, 'cmt-dup-copy', full, { modelMidUrl: mid.modelUrl, modelFarUrl: far.modelUrl });
    expect(copy.response.status).toBe(201);
    expect(copy.body.template).toMatchObject({ modelMidUrl: mid.modelUrl, modelFarUrl: far.modelUrl });
  });
});

describe('tiers and the R2 orphan sweep', () => {
  it('keeps a tier that is only named as a tier out of the sweep, the listing delete flag, and the direct delete', async () => {
    const seller = await signupSeller('cmt-sweep-seller');
    const { full, mid, far } = await uploadSet('sweep');
    await create(seller, 'cmt-sweep', full, { modelMidUrl: mid.modelUrl, modelFarUrl: far.modelUrl });

    const cleanup = await cleanupUnreferencedModels(env, { maxDeletes: 100, dryRun: true, minAgeMs: 0 });
    expect(cleanup.targetModelUrls).not.toContain(mid.modelUrl);
    expect(cleanup.targetModelUrls).not.toContain(far.modelUrl);

    const listing = await api('/models?limit=100', adminSession());
    expect(listing.body.models).toContainEqual(expect.objectContaining({
      modelUrl: mid.modelUrl,
      referencedAsTierBy: expect.arrayContaining(['template cmt-sweep mid', 'product cmt-sweep mid']),
      deletable: false,
    }));
    expect(listing.body.models).toContainEqual(expect.objectContaining({
      modelUrl: far.modelUrl,
      referencedAsTierBy: expect.arrayContaining(['template cmt-sweep far']),
      deletable: false,
    }));

    const directDelete = await SELF.fetch(`https://higglehaven.test${mid.modelUrl}`, adminSession({ method: 'DELETE' }));
    expect(directDelete.status).toBe(409);
    expect((await SELF.fetch(`https://higglehaven.test${mid.modelUrl}`)).status).toBe(200);
  });

  it('sweeps a tier once nothing names it', async () => {
    const orphan = await uploadModel('orphan-tier', { weight: 10, tier: 'far' });
    const cleanup = await cleanupUnreferencedModels(env, { maxDeletes: 100, dryRun: true, minAgeMs: 0 });
    expect(cleanup.targetModelUrls).toContain(orphan.modelUrl);
  });
});

describe('POST /api/models?tier=', () => {
  it('rejects an unknown tier', async () => {
    const response = await uploadModel('bad-tier', { tier: 'huge' });
    expect(response.status).toBe(400);
    expect(response.error).toBe('tier must be "mid" or "far" when given');
  });

  it('counts a tier upload against its own rate-limit bucket, not the full-model one', async () => {
    const ip = `cmt-rate-${crypto.randomUUID()}`;
    for (let i = 0; i < 20; i++) {
      expect((await uploadModel(`rate-full-${i}`, { weight: i, ip })).status).toBe(201);
    }
    expect((await uploadModel('rate-full-over', { weight: 99, ip })).status).toBe(429);
    const tier = await uploadModel('rate-tier', { weight: 5, tier: 'mid', ip });
    expect(tier.status).toBe(201);
  });
});
