// #3065: a seller who deletes their own seller profile or whole account
// (no suspension involved) used to leave their catalog_templates behind:
// still browsable, still placeable, still on published landlets, and at
// purchase time createPurchaseCheckout found no sellers row and treated the
// product like a system/placeholder template, so the sale went ahead with
// nobody to pay. Self-deletion now records the seller in closed_sellers
// (the same record #3057 uses for a suspension-ladder closure) in the same
// batch as the delete, and removes + snapshots their placed products with
// a plain notice to each affected builder.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupSeller } from './test-helpers.js';

let adminSession;
const PASSWORD = 'a fine long password here';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('sds-admin');
  adminSession = admin.session;
});

async function createGreenbeltLandlet(landletId) {
  const created = await api('/landlets', adminSession({
    method: 'POST',
    body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2: 1000, status: 'greenbelt' }),
  }));
  expect(created.response.status).toBe(201);
}

async function claim(landletId, builder) {
  const claimed = await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  expect(claimed.response.status).toBe(200);
}

async function createSellerTemplate(seller, templateId) {
  const created = await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({
      templateId,
      sellerId: seller.sellerId,
      name: `Self-delete fixture ${templateId}`,
      color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents: 500,
    }),
  }));
  expect(created.response.status).toBe(201);
  return templateId;
}

async function place(instanceId, landletId, templateId, builder) {
  const placed = await api('/instances', builder.session({
    method: 'POST',
    body: JSON.stringify({ instanceId, landletId, templateId, x: 1, y: 1 }),
  }));
  expect(placed.response.status).toBe(201);
}

async function noticesFor(builder) {
  const { results } = await env.DB.prepare(
    'SELECT message FROM notifications WHERE builder_id = ? ORDER BY created_at, notification_id',
  ).bind(builder.builderId).all();
  return results.map((row) => row.message);
}

async function expectListingsClosed({ seller, builder, landletId, templateId, instanceId }) {
  expect(await env.DB.prepare('SELECT 1 FROM sellers WHERE seller_id = ?').bind(seller.sellerId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT 1 FROM closed_sellers WHERE seller_id = ?').bind(seller.sellerId).first()).toBeTruthy();

  // Hidden from browsing.
  const catalog = await api('/catalog?limit=100', builder.session());
  expect(catalog.body.templates.map((t) => t.templateId)).not.toContain(templateId);

  // Unplaceable.
  const replaced = await api('/instances', builder.session({
    method: 'POST',
    body: JSON.stringify({ instanceId: `${instanceId}-again`, landletId, templateId, x: 2, y: 2 }),
  }));
  expect(replaced.response.status).toBe(400);

  // Off the builder's land, but kept under Removed Items with its info,
  // born permanent (nothing can come back).
  expect(await env.DB.prepare('SELECT 1 FROM placed_instances WHERE instance_id = ?').bind(instanceId).first()).toBeNull();
  const pending = await api('/instances/pending-restoration', builder.session());
  expect(pending.response.status).toBe(200);
  expect(pending.body.pendingRestorations).toHaveLength(1);
  expect(pending.body.pendingRestorations[0].templateName).toBe(`Self-delete fixture ${templateId}`);
  const snapshot = await env.DB.prepare(
    'SELECT permanent_at FROM suspended_seller_instance_snapshots WHERE seller_id = ?',
  ).bind(seller.sellerId).first();
  expect(snapshot.permanent_at).toBeTruthy();

  // The builder is told exactly once, in plain words.
  const notices = (await noticesFor(builder)).filter((m) => m.includes('stopped selling'));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain(`"Self-delete fixture ${templateId}"`);
  expect(notices[0]).not.toMatch(/#\d|docs\/|closed_sellers|snapshot/i);
}

describe('A seller deleting themselves takes their products out of circulation (#3065)', () => {
  it('DELETE /sellers/:id hides, unplaces, snapshots and notifies', async () => {
    const seller = await signupSeller('sds-profile-seller');
    const builder = await signupAdmin('sds-profile-builder');
    await createGreenbeltLandlet('sds-profile-landlet');
    await claim('sds-profile-landlet', builder);
    const templateId = await createSellerTemplate(seller, 'sds-profile-template');
    await place('sds-profile-instance', 'sds-profile-landlet', templateId, builder);

    const deleted = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);

    await expectListingsClosed({
      seller, builder, landletId: 'sds-profile-landlet', templateId, instanceId: 'sds-profile-instance',
    });
  });

  it('POST /auth/delete-account does the same', async () => {
    const seller = await signupSeller('sds-account-seller');
    const builder = await signupAdmin('sds-account-builder');
    await createGreenbeltLandlet('sds-account-landlet');
    await claim('sds-account-landlet', builder);
    const templateId = await createSellerTemplate(seller, 'sds-account-template');
    await place('sds-account-instance', 'sds-account-landlet', templateId, builder);

    const deleted = await api('/auth/delete-account', seller.session({
      method: 'POST', body: JSON.stringify({ password: PASSWORD }),
    }));
    expect(deleted.response.status).toBe(200);

    await expectListingsClosed({
      seller, builder, landletId: 'sds-account-landlet', templateId, instanceId: 'sds-account-instance',
    });
  });

  it('blocks purchasing a product whose seller is gone, even one that slipped onto land', async () => {
    const seller = await signupSeller('sds-purchase-seller');
    const buyer = await signupAdmin('sds-purchase-buyer');
    await createGreenbeltLandlet('sds-purchase-landlet');
    await claim('sds-purchase-landlet', buyer);
    const templateId = await createSellerTemplate(seller, 'sds-purchase-template');
    const deleted = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);

    // Inserted directly: the placement API now (correctly) refuses it.
    await env.DB.prepare(`
      INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m)
      VALUES ('sds-purchase-instance', 'sds-purchase-landlet', ?, 1, 1)
    `).bind(templateId).run();
    const attempt = await api('/instances/sds-purchase-instance/purchase', buyer.session({ method: 'POST' }));
    expect(attempt.response.status).toBe(400);
    expect(attempt.body.error).toMatch(/unavailable/i);
    expect(attempt.body.error).not.toMatch(/#\d|docs\//);
  });

  it('blocks a legacy listing whose seller was deleted before closed_sellers recorded it', async () => {
    const seller = await signupSeller('sds-legacy-seller');
    const buyer = await signupAdmin('sds-legacy-buyer');
    await createGreenbeltLandlet('sds-legacy-landlet');
    await claim('sds-legacy-landlet', buyer);
    const templateId = await createSellerTemplate(seller, 'sds-legacy-template');
    await env.DB.prepare(`
      INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m)
      VALUES ('sds-legacy-instance', 'sds-legacy-landlet', ?, 1, 1)
    `).bind(templateId).run();
    // The old behavior: seller row gone, no closed_sellers record.
    await env.DB.prepare('DELETE FROM sellers WHERE seller_id = ?').bind(seller.sellerId).run();

    const attempt = await api('/instances/sds-legacy-instance/purchase', buyer.session({ method: 'POST' }));
    expect(attempt.response.status).toBe(400);
    expect(attempt.body.error).toMatch(/no longer available/i);
  });

  it('records nothing and leaves the listings up when the deletion is blocked by unpaid proceeds', async () => {
    const seller = await signupSeller('sds-blocked-seller');
    const builder = await signupAdmin('sds-blocked-builder');
    await createGreenbeltLandlet('sds-blocked-landlet');
    await claim('sds-blocked-landlet', builder);
    const templateId = await createSellerTemplate(seller, 'sds-blocked-template');
    await place('sds-blocked-instance', 'sds-blocked-landlet', templateId, builder);
    await env.DB.prepare(`
      INSERT INTO purchases (
        purchase_id, instance_id, template_id, builder_id, seller_id, unit_price_cents, quantity,
        total_cents, commission_cents, builder_share_cents, platform_share_cents, payment_intent_id
      ) VALUES ('sds-blocked-purchase', 'sds-blocked-purchase-instance', ?, ?, ?, 5000, 1, 5000, 100, 4900, 100, 'pi_sds_blocked')
    `).bind(templateId, builder.builderId, seller.sellerId).run();

    const blocked = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
    expect(blocked.response.status).toBe(409);

    expect(await env.DB.prepare('SELECT 1 FROM sellers WHERE seller_id = ?').bind(seller.sellerId).first()).toBeTruthy();
    expect(await env.DB.prepare('SELECT 1 FROM closed_sellers WHERE seller_id = ?').bind(seller.sellerId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM placed_instances WHERE instance_id = ?').bind('sds-blocked-instance').first()).toBeTruthy();
    expect((await noticesFor(builder)).filter((m) => m.includes('stopped selling'))).toHaveLength(0);
    const catalog = await api('/catalog?limit=100', builder.session());
    expect(catalog.body.templates.map((t) => t.templateId)).toContain(templateId);
  });
});
