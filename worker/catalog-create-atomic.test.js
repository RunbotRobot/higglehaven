// #3109: creating a catalog template inserts a backing products row and the
// template's own row. They used to be two awaited statements, so a failure
// on the second left a products row behind and every retry with the same
// template id failed on a primary-key conflict. Now they commit or fail
// together, and a row orphaned by the old behaviour is healed on retry.
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, glbFile, signupSeller } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function uploadModel(marker) {
  const form = new FormData();
  form.set('file', glbFile({ json: `{"catalogCreateAtomic":"${marker}"}` }));
  const uploaded = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form });
  expect(uploaded.status).toBe(201);
  return uploaded.json();
}

function createBody(seller, upload, templateId, name) {
  return JSON.stringify({
    templateId,
    sellerId: seller.sellerId,
    name,
    color: '#123456',
    dimensions: { width: 1, depth: 1, height: 1 },
    priceCents: 500,
    modelUrl: upload.modelUrl,
    modelSizeBytes: upload.sizeBytes,
  });
}

async function counts(templateId) {
  const product = await env.DB.prepare('SELECT COUNT(*) AS n FROM products WHERE product_id = ?').bind(templateId).first();
  const template = await env.DB.prepare('SELECT COUNT(*) AS n FROM catalog_templates WHERE template_id = ?').bind(templateId).first();
  return { products: product.n, templates: template.n };
}

describe('catalog template creation is atomic (#3109)', () => {
  it('leaves no products row behind when the template insert fails, so a retry with the same id succeeds', async () => {
    const seller = await signupSeller('cca-atomic-seller');
    const upload = await uploadModel('atomic');
    const templateId = 'cca-atomic-template';

    await env.DB.prepare(
      `CREATE TRIGGER cca_fail_template BEFORE INSERT ON catalog_templates WHEN NEW.template_id = '${templateId}' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`,
    ).run();
    try {
      const failed = await api('/catalog', seller.session({ method: 'POST', body: createBody(seller, upload, templateId, 'Atomic product') }));
      expect(failed.response.status).toBeGreaterThanOrEqual(400);
    } finally {
      await env.DB.prepare('DROP TRIGGER cca_fail_template').run();
    }
    expect(await counts(templateId)).toEqual({ products: 0, templates: 0 });

    const retried = await api('/catalog', seller.session({ method: 'POST', body: createBody(seller, upload, templateId, 'Atomic product') }));
    expect(retried.response.status).toBe(201);
    expect(await counts(templateId)).toEqual({ products: 1, templates: 1 });
  });

  it('heals a products row orphaned by the old two-statement behaviour on retry, refreshing it to the new content', async () => {
    const seller = await signupSeller('cca-heal-seller');
    const upload = await uploadModel('heal');
    const templateId = 'cca-heal-template';

    await env.DB.prepare(`
      INSERT INTO products (product_id, name, category, color, width_m, depth_m, height_m, model_url, metadata_json)
      VALUES (?, 'Stale orphan name', 'placeholder', '#000000', 1, 1, 1, ?, '{}')
    `).bind(templateId, upload.modelUrl).run();

    const created = await api('/catalog', seller.session({ method: 'POST', body: createBody(seller, upload, templateId, 'Fresh name') }));
    expect(created.response.status).toBe(201);
    expect(await counts(templateId)).toEqual({ products: 1, templates: 1 });
    const product = await env.DB.prepare('SELECT name FROM products WHERE product_id = ?').bind(templateId).first();
    expect(product.name).toBe('Fresh name');
  });
});
