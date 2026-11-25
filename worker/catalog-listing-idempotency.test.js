// #4346: a resubmitted "sell this too" form (a lost response, then the same click again) must not create a second
// listing; a changed price is a genuinely new attempt.
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, glbFile, signupSeller } from './test-helpers.js';

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function uploadModel(marker) {
  const form = new FormData();
  form.set('file', glbFile({ json: `{"listingIdem":"${marker}"}` }));
  const uploaded = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form });
  expect(uploaded.status).toBe(201);
  return uploaded.json();
}

describe('POST /catalog/listings idempotency (#4346)', () => {
  it('returns the listing it already made for the same key, price and stock, and makes a new one for a changed price', async () => {
    const first = await signupSeller('listing-idem-first');
    const second = await signupSeller('listing-idem-second');
    const upload = await uploadModel('a');
    const created = await api('/catalog', first.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'listing-idem-product', sellerId: first.sellerId, name: 'Listing idem', category: 'furniture', color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500, modelUrl: upload.modelUrl,
      }),
    }));
    expect(created.response.status).toBe(201);

    const attach = (priceCents, key) => api('/catalog/listings', second.session({
      method: 'POST',
      body: JSON.stringify({ productId: 'listing-idem-product', priceCents, idempotencyKey: key }),
    }));
    const one = await attach(700, 'attempt-1');
    expect(one.response.status).toBe(201);
    const again = await attach(700, 'attempt-1');
    expect(again.response.status).toBe(200);
    expect(again.body.template.templateId).toBe(one.body.template.templateId);
    const changed = await attach(900, 'attempt-1');
    expect(changed.response.status).toBe(201);
    expect(changed.body.template.templateId).not.toBe(one.body.template.templateId);

    const mine = await env.DB.prepare('SELECT COUNT(*) AS n FROM catalog_templates WHERE seller_id = ? AND product_id = ?')
      .bind(second.sellerId, 'listing-idem-product').first();
    expect(mine.n).toBe(2);
  });

  it('still makes a separate listing when no key is sent', async () => {
    const first = await signupSeller('listing-nokey-first');
    const second = await signupSeller('listing-nokey-second');
    const upload = await uploadModel('b');
    await api('/catalog', first.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'listing-nokey-product', sellerId: first.sellerId, name: 'No key', category: 'furniture', color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500, modelUrl: upload.modelUrl,
      }),
    }));
    const attach = () => api('/catalog/listings', second.session({
      method: 'POST', body: JSON.stringify({ productId: 'listing-nokey-product', priceCents: 700 }),
    }));
    const a = await attach();
    const b = await attach();
    expect(a.response.status).toBe(201);
    expect(b.response.status).toBe(201);
    expect(a.body.template.templateId).not.toBe(b.body.template.templateId);
  });
});
