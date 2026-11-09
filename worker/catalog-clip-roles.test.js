// #3312 (part of #3301): the seller's own choice of which clip of an avatar
// model plays as idle / walk / fly, stored with the product. A Mixamo export
// names every clip "mixamo.com", so the file cannot say what motion it is.
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, glbFile, signupSeller } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function uploadModel(marker) {
  const form = new FormData();
  form.set('file', glbFile({ json: `{"catalogClipRoles":"${marker}"}` }));
  const uploaded = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form });
  expect(uploaded.status).toBe(201);
  return uploaded.json();
}

function create(seller, templateId, upload, extra = {}) {
  return api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({
      templateId,
      sellerId: seller.sellerId,
      name: `Clip roles ${templateId}`,
      category: 'avatar',
      color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents: 500,
      modelUrl: upload.modelUrl,
      modelSizeBytes: upload.sizeBytes,
      ...extra,
    }),
  }));
}

function patch(seller, templateId, body) {
  return api(`/catalog/${templateId}`, seller.session({ method: 'PATCH', body: JSON.stringify(body) }));
}

async function storedRoles(table, idColumn, id) {
  const row = await env.DB.prepare(`SELECT clip_roles FROM ${table} WHERE ${idColumn} = ?`).bind(id).first();
  return row.clip_roles;
}

describe('clipRoles on a catalog template (#3312)', () => {
  it('is null until a seller chooses, and a template created without it stays null', async () => {
    const seller = await signupSeller('ccr-default-seller');
    const upload = await uploadModel('default');
    const created = await create(seller, 'ccr-default', upload);
    expect(created.response.status).toBe(201);
    expect(created.body.template.clipRoles).toBeNull();
    expect(await storedRoles('catalog_templates', 'template_id', 'ccr-default')).toBeNull();
  });

  it('stores a choice on create, normalised to all three roles in a fixed order', async () => {
    const seller = await signupSeller('ccr-create-seller');
    const upload = await uploadModel('create');
    const created = await create(seller, 'ccr-create', upload, { clipRoles: { walk: 'mixamo.com' } });
    expect(created.response.status).toBe(201);
    expect(created.body.template.clipRoles).toEqual({ idle: null, walk: 'mixamo.com', fly: null });
    // Same text whichever order the keys arrived in, so stored values compare as text.
    expect(await storedRoles('catalog_templates', 'template_id', 'ccr-create'))
      .toBe('{"idle":null,"walk":"mixamo.com","fly":null}');
    // and the shared product behind the first listing carries it too
    expect(await storedRoles('products', 'product_id', 'ccr-create'))
      .toBe('{"idle":null,"walk":"mixamo.com","fly":null}');
  });

  it('rejects anything that is not idle/walk/fly mapped to a clip name or null', async () => {
    const seller = await signupSeller('ccr-invalid-seller');
    const upload = await uploadModel('invalid');
    const bad = [
      ['an array', ['idle']],
      ['a string', 'walk'],
      ['an unknown role', { run: 'Running' }],
      ['a non-string clip name', { idle: 5 }],
      ['an empty clip name', { idle: '  ' }],
      ['an over-long clip name', { idle: 'x'.repeat(201) }],
      ['one clip given to two roles', { idle: 'Clip', walk: 'Clip' }],
    ];
    for (const [label, clipRoles] of bad) {
      const rejected = await create(seller, `ccr-invalid-${label.replace(/\W+/g, '-')}`, upload, { clipRoles });
      expect(rejected.response.status, label).toBe(400);
      expect(rejected.body.error, label).toMatch(/clipRoles/);
    }
  });

  it('is only accepted for a product in the avatar category', async () => {
    const seller = await signupSeller('ccr-category-seller');
    const upload = await uploadModel('category');
    const rejected = await create(seller, 'ccr-chair', upload, { category: 'furniture', clipRoles: { idle: 'Idle' } });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toBe('clipRoles only applies to a product in the avatar category');
  });
});

describe('PATCH /catalog/:templateId and clipRoles (#3312)', () => {
  it('sets, replaces and clears the choice, and leaves it alone when not mentioned', async () => {
    const seller = await signupSeller('ccr-patch-seller');
    const upload = await uploadModel('patch');
    await create(seller, 'ccr-patch', upload);

    const set = await patch(seller, 'ccr-patch', { clipRoles: { idle: 'Standing', walk: 'Walking' } });
    expect(set.response.status).toBe(200);
    expect(set.body.template.clipRoles).toEqual({ idle: 'Standing', walk: 'Walking', fly: null });

    const renamed = await patch(seller, 'ccr-patch', { name: 'Renamed avatar' });
    expect(renamed.body.template.clipRoles).toEqual({ idle: 'Standing', walk: 'Walking', fly: null });

    const replaced = await patch(seller, 'ccr-patch', { clipRoles: { fly: 'Flying' } });
    expect(replaced.body.template.clipRoles).toEqual({ idle: null, walk: null, fly: 'Flying' });

    const cleared = await patch(seller, 'ccr-patch', { clipRoles: null });
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.template.clipRoles).toBeNull();
    expect(await storedRoles('catalog_templates', 'template_id', 'ccr-patch')).toBeNull();
  });

  it('drops the choice when the model file changes without a new one, since it names the old file\'s clips', async () => {
    const seller = await signupSeller('ccr-swap-seller');
    const first = await uploadModel('swap-first');
    const second = await uploadModel('swap-second');
    await create(seller, 'ccr-swap', first, { clipRoles: { walk: 'mixamo.com' } });

    const swapped = await patch(seller, 'ccr-swap', { modelUrl: second.modelUrl, modelSizeBytes: second.sizeBytes });
    expect(swapped.response.status).toBe(200);
    expect(swapped.body.template.clipRoles).toBeNull();
  });

  it('keeps a choice sent together with the new model file', async () => {
    const seller = await signupSeller('ccr-swapkeep-seller');
    const first = await uploadModel('swapkeep-first');
    const second = await uploadModel('swapkeep-second');
    await create(seller, 'ccr-swapkeep', first, { clipRoles: { walk: 'Old' } });

    const swapped = await patch(seller, 'ccr-swapkeep', {
      modelUrl: second.modelUrl, modelSizeBytes: second.sizeBytes, clipRoles: { idle: 'New idle' },
    });
    expect(swapped.response.status).toBe(200);
    expect(swapped.body.template.clipRoles).toEqual({ idle: 'New idle', walk: null, fly: null });
  });

  it('drops the choice when the product stops being an avatar, instead of refusing the edit', async () => {
    const seller = await signupSeller('ccr-recat-seller');
    const upload = await uploadModel('recat');
    await create(seller, 'ccr-recat', upload, { clipRoles: { idle: 'Idle' } });

    const recategorised = await patch(seller, 'ccr-recat', { category: 'furniture' });
    expect(recategorised.response.status).toBe(200);
    expect(recategorised.body.template.category).toBe('furniture');
    expect(recategorised.body.template.clipRoles).toBeNull();
  });

  it('refuses a choice for a product that is not an avatar', async () => {
    const seller = await signupSeller('ccr-notavatar-seller');
    const upload = await uploadModel('notavatar');
    await create(seller, 'ccr-notavatar', upload, { category: 'furniture' });
    const rejected = await patch(seller, 'ccr-notavatar', { clipRoles: { idle: 'Idle' } });
    expect(rejected.response.status).toBe(400);
  });
});

describe('clipRoles and shared products (#3312)', () => {
  it('a second seller attaching their own listing inherits the product\'s clip choice', async () => {
    const first = await signupSeller('ccr-share-first');
    const second = await signupSeller('ccr-share-second');
    const upload = await uploadModel('share');
    await create(first, 'ccr-share', upload, { clipRoles: { walk: 'mixamo.com' } });

    const listed = await api('/catalog/listings', second.session({
      method: 'POST',
      body: JSON.stringify({ productId: 'ccr-share', priceCents: 700 }),
    }));
    expect(listed.response.status).toBe(201);
    expect(listed.body.template.clipRoles).toEqual({ idle: null, walk: 'mixamo.com', fly: null });
  });
});
