// #3110: nothing ever wrote products.image_url, so a listing attached to an
// existing product (POST /api/catalog/listings) always started with no
// thumbnail. The thumbnail route now writes through to the backing product
// (never overwriting an image it already has), and the attach path falls
// back to the product's earliest imaged listing for products that predate
// the write-through.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupSeller } from './test-helpers.js';

const ONE_PIXEL_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const OTHER_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function createListing(seller, templateId) {
  const created = await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({
      templateId,
      name: 'Image write-through product',
      color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 },
      sellerId: seller.sellerId,
      priceCents: 500,
    }),
  }));
  expect(created.response.status).toBe(201);
  return templateId;
}

async function uploadThumbnail(seller, templateId, dataUrl = ONE_PIXEL_PNG_DATA_URL) {
  const uploaded = await api(`/catalog/${templateId}/thumbnail`, seller.session({
    method: 'POST',
    body: JSON.stringify({ imageDataUrl: dataUrl }),
  }));
  expect(uploaded.response.status).toBe(200);
  return uploaded.body.imageUrl;
}

async function attach(seller, productId) {
  const attached = await api('/catalog/listings', seller.session({
    method: 'POST',
    body: JSON.stringify({ productId, priceCents: 700 }),
  }));
  expect(attached.response.status).toBe(201);
  return attached.body.template;
}

describe('products.image_url follows the first thumbnail (#3110)', () => {
  it('writes a generated thumbnail through to the backing product, and an attached listing carries it', async () => {
    const owner = await signupSeller('wt-owner');
    const second = await signupSeller('wt-second');
    const templateId = await createListing(owner, 'wt-product');
    const imageUrl = await uploadThumbnail(owner, templateId);

    const product = await env.DB.prepare('SELECT image_url FROM products WHERE product_id = ?').bind('wt-product').first();
    expect(product.image_url).toBe(imageUrl);

    const attached = await attach(second, 'wt-product');
    expect(attached.imageUrl).toBe(imageUrl);
  });

  it('does not overwrite the product image when a later listing re-renders its own thumbnail', async () => {
    const owner = await signupSeller('wt-keep-owner');
    const second = await signupSeller('wt-keep-second');
    const templateId = await createListing(owner, 'wt-keep-product');
    const firstUrl = await uploadThumbnail(owner, templateId);
    const attached = await attach(second, 'wt-keep-product');

    const rerendered = await uploadThumbnail(second, attached.templateId, OTHER_PNG_DATA_URL);
    expect(rerendered).not.toBe(firstUrl);
    const product = await env.DB.prepare('SELECT image_url FROM products WHERE product_id = ?').bind('wt-keep-product').first();
    expect(product.image_url).toBe(firstUrl);
  });

  it('gives an attached listing the earliest imaged sibling listing for a product with no image of its own', async () => {
    const owner = await signupSeller('wt-legacy-owner');
    const second = await signupSeller('wt-legacy-second');
    const templateId = await createListing(owner, 'wt-legacy-product');
    const imageUrl = await uploadThumbnail(owner, templateId);
    // A product that predates the write-through: image only on the listing.
    await env.DB.prepare('UPDATE products SET image_url = NULL, image_embedding = NULL WHERE product_id = ?')
      .bind('wt-legacy-product').run();

    const attached = await attach(second, 'wt-legacy-product');
    expect(attached.imageUrl).toBe(imageUrl);
  });
});
