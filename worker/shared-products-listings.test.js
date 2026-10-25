// #2747 (sub-issue of #2745's shared-products redesign): POST /api/catalog/
// listings -- lets a seller attach their own listing to a product someone
// else originally uploaded, using the `products` table + catalog_templates.
// product_id groundwork #2746 shipped. See worker/shared-products-schema.
// test.js for the schema itself.
import {
  applyD1Migrations, env,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import { api, signupSeller } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function createProduct(overrides = {}) {
  const productId = overrides.productId ?? `listings-fixture-product-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO products (product_id, name, category, subcategory, color, width_m, depth_m, height_m, model_url, original_seller_id, flagged_hidden_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    productId,
    overrides.name ?? 'Shared Lamp',
    overrides.category ?? 'lighting',
    overrides.subcategory ?? 'table lamp',
    overrides.color ?? '#ddeeff',
    overrides.width ?? 0.3, overrides.depth ?? 0.3, overrides.height ?? 1.1,
    overrides.modelUrl ?? '/uploads/shared-lamp.glb',
    overrides.originalSellerId ?? null,
    overrides.flaggedHiddenAt ?? null,
  ).run();
  return productId;
}

describe('POST /api/catalog/listings (#2747)', () => {
  it('requires a session', async () => {
    const productId = await createProduct();
    const anon = await api('/catalog/listings', {
      method: 'POST',
      body: JSON.stringify({ productId, priceCents: 500 }),
    });
    expect(anon.response.status).toBe(401);
  });

  it('requires productId', async () => {
    const seller = await signupSeller('listings-missing-product-id');
    const result = await api('/catalog/listings', seller.session({
      method: 'POST',
      body: JSON.stringify({ priceCents: 500 }),
    }));
    expect(result.response.status).toBe(400);
  });

  it('requires priceCents', async () => {
    const seller = await signupSeller('listings-missing-price');
    const productId = await createProduct();
    const result = await api('/catalog/listings', seller.session({
      method: 'POST',
      body: JSON.stringify({ productId }),
    }));
    expect(result.response.status).toBe(400);
  });

  it('404s when productId does not reference an existing product', async () => {
    const seller = await signupSeller('listings-no-such-product');
    const result = await api('/catalog/listings', seller.session({
      method: 'POST',
      body: JSON.stringify({ productId: 'no-such-product', priceCents: 500 }),
    }));
    expect(result.response.status).toBe(404);
  });

  it('refuses to attach a new listing to a product an admin has already hidden', async () => {
    const seller = await signupSeller('listings-hidden-product');
    const productId = await createProduct({ flaggedHiddenAt: '2026-10-25T00:00:00.000Z' });
    const result = await api('/catalog/listings', seller.session({
      method: 'POST',
      body: JSON.stringify({ productId, priceCents: 500 }),
    }));
    expect(result.response.status).toBe(400);
    expect(result.body.error).toMatch(/temporarily unavailable pending review/);
  });

  it('creates a listing with every shared field copied from the product, and the caller as its seller', async () => {
    const seller = await signupSeller('listings-happy-path');
    const productId = await createProduct({
      name: 'Shared Lamp Deluxe', category: 'lighting', subcategory: 'floor lamp',
      color: '#112233', width: 0.4, depth: 0.4, height: 1.6, modelUrl: '/uploads/deluxe-lamp.glb',
    });

    const result = await api('/catalog/listings', seller.session({
      method: 'POST',
      body: JSON.stringify({ productId, priceCents: 2500, stockQuantity: 10 }),
    }));

    expect(result.response.status).toBe(201);
    const { template } = result.body;
    expect(template.templateId).toBeTruthy();
    expect(template.templateId).not.toBe(productId); // a fresh listing id, not reusing the product's own id
    expect(template).toMatchObject({
      name: 'Shared Lamp Deluxe',
      category: 'lighting',
      subcategory: 'floor lamp',
      color: '#112233',
      dimensions: { width: 0.4, depth: 0.4, height: 1.6 },
      modelUrl: '/uploads/deluxe-lamp.glb',
      sellerId: seller.sellerId,
      priceCents: 2500,
      stockQuantity: 10,
    });

    // The listing is visible through the ordinary GET /api/catalog/:templateId
    // path too, with no special-casing needed -- confirms templateFromRow's
    // explicit-object shape really does carry every copied field through.
    const fetched = await api(`/catalog/${template.templateId}`);
    expect(fetched.response.status).toBe(200);
    expect(fetched.body.template).toEqual(template);
  });

  it('lets two different sellers each attach their own listing to the same product', async () => {
    const sellerA = await signupSeller('listings-multi-seller-a');
    const sellerB = await signupSeller('listings-multi-seller-b');
    const productId = await createProduct({ name: 'Popular Chair' });

    const listingA = await api('/catalog/listings', sellerA.session({
      method: 'POST',
      body: JSON.stringify({ productId, priceCents: 1000 }),
    }));
    const listingB = await api('/catalog/listings', sellerB.session({
      method: 'POST',
      body: JSON.stringify({ productId, priceCents: 1200 }),
    }));

    expect(listingA.response.status).toBe(201);
    expect(listingB.response.status).toBe(201);
    expect(listingA.body.template.templateId).not.toBe(listingB.body.template.templateId);
    expect(listingA.body.template.sellerId).toBe(sellerA.sellerId);
    expect(listingB.body.template.sellerId).toBe(sellerB.sellerId);
    expect(listingA.body.template.priceCents).toBe(1000);
    expect(listingB.body.template.priceCents).toBe(1200);

    const rows = await env.DB.prepare('SELECT template_id, product_id FROM catalog_templates WHERE product_id = ? ORDER BY template_id')
      .bind(productId).all();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((row) => row.product_id === productId)).toBe(true);
  });
});
