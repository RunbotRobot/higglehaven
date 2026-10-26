// #2746 (leaf of #2745): the foundational `products` table + catalog_
// templates.product_id schema split, and its backfill. Purely additive --
// no existing endpoint reads or writes either new column yet (that's
// #2747/#2748/#2749's job), so these tests cover exactly what this issue
// actually ships: the schema shape, the backfill's own correctness, and
// that nothing about today's catalog behavior changed.
import {
  applyD1Migrations, env,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import { api } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function createCatalogTemplate(db, overrides = {}) {
  const row = {
    template_id: overrides.templateId ?? `shared-products-fixture-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? 'Fixture Chair',
    category: overrides.category ?? 'furniture',
    subcategory: overrides.subcategory ?? 'seating',
    color: overrides.color ?? '#aabbcc',
    width_m: overrides.width ?? 1,
    depth_m: overrides.depth ?? 1,
    height_m: overrides.height ?? 1,
    price_cents: overrides.priceCents ?? 500,
    seller_id: overrides.sellerId ?? null,
    model_url: overrides.modelUrl ?? 'https://example.test/model.glb',
  };
  await db.prepare(`
    INSERT INTO catalog_templates (template_id, name, category, subcategory, color, width_m, depth_m, height_m, price_cents, seller_id, model_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    row.template_id, row.name, row.category, row.subcategory, row.color,
    row.width_m, row.depth_m, row.height_m, row.price_cents, row.seller_id, row.model_url,
  ).run();
  return row;
}

describe('products table + catalog_templates.product_id schema (#2746)', () => {
  it('creates the products table with the expected shared columns', async () => {
    const info = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='products'").first();
    expect(info).toBeTruthy();
    for (const column of [
      'product_id', 'name', 'category', 'subcategory', 'color',
      'width_m', 'depth_m', 'height_m', 'model_url', 'metadata_json',
      'image_url', 'image_embedding', 'model_size_bytes', 'skeleton_signature',
      'is_test_model', 'flagged_hidden_at', 'original_seller_id', 'created_at', 'updated_at',
    ]) {
      expect(info.sql).toContain(column);
    }
  });

  it('adds a nullable product_id column to catalog_templates', async () => {
    const row = await createCatalogTemplate(env.DB, { templateId: 'shared-products-nullable-check' });
    const stored = await env.DB.prepare('SELECT product_id FROM catalog_templates WHERE template_id = ?')
      .bind(row.template_id).first();
    expect(stored.product_id).toBeNull();
  });

  it('enforces the product_id foreign key against products.product_id', async () => {
    const row = await createCatalogTemplate(env.DB, { templateId: 'shared-products-fk-check' });
    await expect(
      env.DB.prepare('UPDATE catalog_templates SET product_id = ? WHERE template_id = ?')
        .bind('no-such-product', row.template_id)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint/i);
  });

  // #2748: this used to assert the opposite (no product_id yet, "#2747/
  // #2748 still need to wire that up" per this test's own original name) --
  // #2748's own worker/lib/catalog.js change now backs every new template
  // created through this path with a 1:1 products row at creation time,
  // the same unconditional product_id=template_id convention the real
  // migrations/0153 backfill already used for every pre-existing row, so a
  // template created going forward is just as "sell this too"-able as a
  // backfilled historical one. See worker/shared-products-listings.test.js
  // for the actual attach-a-listing endpoint's own tests.
  it('a newly created catalog template (through the ordinary POST /catalog path) is backed by its own 1:1 products row', async () => {
    const create = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'shared-products-new-template-check',
        name: 'Brand New Lamp',
        category: 'lighting',
        color: '#ffffff',
        dimensions: { width: 0.3, depth: 0.3, height: 1.2 },
      }),
    });
    expect(create.response.status).toBe(201);
    const stored = await env.DB.prepare('SELECT product_id FROM catalog_templates WHERE template_id = ?')
      .bind('shared-products-new-template-check').first();
    expect(stored.product_id).toBe('shared-products-new-template-check');
    const product = await env.DB.prepare('SELECT * FROM products WHERE product_id = ?')
      .bind('shared-products-new-template-check').first();
    expect(product).toMatchObject({
      product_id: 'shared-products-new-template-check',
      name: 'Brand New Lamp',
      category: 'lighting',
      color: '#ffffff',
      width_m: 0.3, depth_m: 0.3, height_m: 1.2,
    });
  });

  // Mirrors the backfill statements in migrations/0153_shared_products.sql
  // -- migrations run once against an empty database in this test harness,
  // so there's no way to apply them a second time against pre-existing
  // rows the way production's one real backfill ran. Re-running the same
  // SQL text here against manually-inserted "pre-existing" rows is the
  // most faithful way to test the backfill's own correctness; keep the
  // SELECT/UPDATE column lists in sync by hand if that migration ever
  // changes. The `WHERE product_id IS NULL` filter on both statements is
  // NOT present in the real migration (every row has a NULL product_id at
  // the one real backfill's own run time, so it would be redundant there)
  // -- it's added only so this helper is safe to call from more than one
  // `it` block below without re-inserting an already-backfilled row's
  // product_id into `products` a second time and violating its primary
  // key, since every test in this file shares one `env.DB` for the whole
  // suite (one `beforeAll`), not a fresh database per test.
  async function runBackfill(db) {
    await db.prepare(`
      INSERT INTO products (
        product_id, name, category, subcategory, color, width_m, depth_m, height_m,
        model_url, metadata_json, image_url, image_embedding, model_size_bytes,
        skeleton_signature, is_test_model, flagged_hidden_at, original_seller_id,
        created_at, updated_at
      )
      SELECT
        template_id, name, category, subcategory, color, width_m, depth_m, height_m,
        model_url, metadata_json, image_url, image_embedding, model_size_bytes,
        skeleton_signature, is_test_model, flagged_hidden_at, seller_id,
        created_at, updated_at
      FROM catalog_templates
      WHERE product_id IS NULL
    `).run();
    await db.prepare(`
      UPDATE catalog_templates SET product_id = template_id WHERE product_id IS NULL
    `).run();
  }

  it('backfills a 1:1 products row for a pre-existing catalog_templates row, with every shared field copied exactly', async () => {
    const row = await createCatalogTemplate(env.DB, {
      templateId: 'shared-products-backfill-check',
      name: 'Backfilled Sofa',
      category: 'furniture',
      subcategory: 'seating',
      color: '#112233',
      width: 2, depth: 1, height: 0.8,
      sellerId: 'backfill-original-seller',
    });

    await runBackfill(env.DB);

    const listing = await env.DB.prepare('SELECT product_id FROM catalog_templates WHERE template_id = ?')
      .bind(row.template_id).first();
    expect(listing.product_id).toBe(row.template_id);

    const product = await env.DB.prepare('SELECT * FROM products WHERE product_id = ?')
      .bind(row.template_id).first();
    expect(product).toMatchObject({
      product_id: row.template_id,
      name: 'Backfilled Sofa',
      category: 'furniture',
      subcategory: 'seating',
      color: '#112233',
      width_m: 2, depth_m: 1, height_m: 0.8,
      original_seller_id: 'backfill-original-seller',
    });
  });

  it('backfills every pre-existing row independently, without colliding on product_id', async () => {
    const a = await createCatalogTemplate(env.DB, { templateId: 'shared-products-multi-a', name: 'Item A' });
    const b = await createCatalogTemplate(env.DB, { templateId: 'shared-products-multi-b', name: 'Item B' });

    await runBackfill(env.DB);

    const products = await env.DB.prepare('SELECT product_id, name FROM products WHERE product_id IN (?, ?) ORDER BY product_id')
      .bind(a.template_id, b.template_id).all();
    expect(products.results).toEqual([
      { product_id: a.template_id, name: 'Item A' },
      { product_id: b.template_id, name: 'Item B' },
    ]);
  });
});
