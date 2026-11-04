// #2988 (sub-issue 4/5 of #2305): when a suspended seller's suspension
// escalates into a permanent account closure (escalateExpiredSuspensions),
// every builder holding a pending-restoration slot for that seller's
// products is told restoration is no longer coming -- and the slot, with
// the product's name/category/image, stays queryable indefinitely (the
// owner's "never left wondering what did I used to have here" decision)
// until the builder clears it themselves. Also covers the retained copy
// itself surviving the template being deleted.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { escalateExpiredSuspensions } from './index.js';
import { recordSellerClosure } from './lib/account-moderation.js';
import {
  api, signupAdmin, signupSeller,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('spc-admin');
  adminSession = admin.session;
});

async function createGreenbeltLandlet(landletId, areaM2 = 1000) {
  const created = await api('/landlets', adminSession({
    method: 'POST',
    body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2, status: 'greenbelt' }),
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
      name: `Closure fixture ${templateId}`,
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

async function suspend(email) {
  const result = await api('/auth/suspend-account', adminSession({
    method: 'POST', body: JSON.stringify({ email, reason: 'test suspension (#2988)' }),
  }));
  expect(result.response.status).toBe(200);
  return result.body;
}

async function expireGracePeriod(email) {
  await env.DB.prepare(`
    UPDATE account_suspensions SET grace_period_ends_at = ?
    WHERE lifted_at IS NULL AND user_id = (SELECT user_id FROM users WHERE email = ?)
  `).bind(new Date(Date.now() - 1000).toISOString(), email).run();
}

async function listPending(builder) {
  const listed = await api('/instances/pending-restoration', builder.session());
  expect(listed.response.status).toBe(200);
  return listed.body.pendingRestorations;
}

describe('Permanent closure of a suspended seller (#2988)', () => {
  it('tells the builder restoration is not coming, keeps the slot and its product info, and never restores it', async () => {
    const seller = await signupSeller('spc-close-seller');
    const builder = await signupAdmin('spc-close-builder');
    await createGreenbeltLandlet('spc-close-landlet');
    await claim('spc-close-landlet', builder);
    const templateId = await createSellerTemplate(seller, 'spc-close-template');
    await place('spc-close-instance', 'spc-close-landlet', templateId, builder);

    await suspend(seller.email);
    const before = await listPending(builder);
    expect(before).toHaveLength(1);
    expect(before[0].permanentAt).toBeNull();
    expect(before[0].sellerSuspended).toBe(true);

    await expireGracePeriod(seller.email);
    await escalateExpiredSuspensions(env.DB);

    // The account really is gone...
    const sellerRow = await env.DB.prepare('SELECT seller_id FROM sellers WHERE seller_id = ?').bind(seller.sellerId).first();
    expect(sellerRow).toBeNull();

    // ...the builder was told, in plain words naming the product...
    const notices = await api('/notifications', builder.session());
    const notice = notices.body.notifications.find((n) => n.message.includes('permanently closed'));
    expect(notice).toBeTruthy();
    expect(notice.message).toContain(`Closure fixture ${templateId}`);
    expect(notice.message).not.toMatch(/#\d+|snapshot|escalat/i);

    // ...and the slot is still there, flagged permanent, with its info.
    const after = await listPending(builder);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      templateId,
      templateName: `Closure fixture ${templateId}`,
      sellerSuspended: false,
    });
    expect(after[0].permanentAt).toBeTruthy();

    // Nothing was restored onto the land.
    const instances = await api('/instances?landletId=spc-close-landlet', builder.session());
    expect(instances.body.instances.map((i) => i.templateId)).not.toContain(templateId);

    // Only the builder's own explicit clear removes it from their view.
    const cleared = await api(`/instances/pending-restoration/${after[0].snapshotId}`, builder.session({ method: 'DELETE' }));
    expect(cleared.response.status).toBe(200);
    expect(await listPending(builder)).toEqual([]);
  });

  it('keeps showing what used to be there after the product\'s template is deleted outright', async () => {
    const seller = await signupSeller('spc-gone-seller');
    const builder = await signupAdmin('spc-gone-builder');
    await createGreenbeltLandlet('spc-gone-landlet');
    await claim('spc-gone-landlet', builder);
    const templateId = await createSellerTemplate(seller, 'spc-gone-template');
    await place('spc-gone-instance', 'spc-gone-landlet', templateId, builder);

    await suspend(seller.email);
    // The instance was removed by the suspension, so nothing references the
    // template any more and it can be deleted outright.
    await env.DB.prepare('DELETE FROM catalog_templates WHERE template_id = ?').bind(templateId).run();

    const pending = await listPending(builder);
    expect(pending).toHaveLength(1);
    expect(pending[0].templateName).toBe(`Closure fixture ${templateId}`);
    expect(pending[0].templateId).toBe(templateId);
  });

  it('does not notify or touch anything for a seller with no pending slots', async () => {
    const seller = await signupSeller('spc-none-seller');
    const bystander = await signupAdmin('spc-none-bystander');
    await suspend(seller.email);
    await expireGracePeriod(seller.email);

    await escalateExpiredSuspensions(env.DB);

    const notices = await api('/notifications', bystander.session());
    expect(notices.body.notifications.some((n) => n.message.includes('permanently closed'))).toBe(false);
  });

  // #3057: closing the account deletes the sellers row every suspended-seller
  // predicate reaches the seller through, so without a closure record the
  // products came straight back for sale the moment the closure completed.
  it('keeps a permanently closed seller\'s products hidden and unplaceable after the account is gone', async () => {
    const seller = await signupSeller('spc-hide-seller');
    const builder = await signupAdmin('spc-hide-builder');
    await createGreenbeltLandlet('spc-hide-landlet');
    await claim('spc-hide-landlet', builder);
    const templateId = await createSellerTemplate(seller, 'spc-hide-template');

    await suspend(seller.email);
    await expireGracePeriod(seller.email);
    await escalateExpiredSuspensions(env.DB);

    const sellerRow = await env.DB.prepare('SELECT seller_id FROM sellers WHERE seller_id = ?').bind(seller.sellerId).first();
    expect(sellerRow).toBeNull();

    const catalog = await api('/catalog?limit=100', builder.session());
    expect(catalog.response.status).toBe(200);
    expect(catalog.body.templates.map((t) => t.templateId)).not.toContain(templateId);

    const placed = await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'spc-hide-instance', landletId: 'spc-hide-landlet', templateId, x: 1, y: 1 }),
    }));
    expect(placed.response.status).toBe(400);
    expect(placed.body.error).toMatch(/seller is suspended/);
  });

  it('only forgets the closure record when the seller row still exists (a failed cascade that will be retried)', async () => {
    const seller = await signupSeller('spc-rb-seller');
    const row = await env.DB.prepare('SELECT user_id FROM sellers WHERE seller_id = ?').bind(seller.sellerId).first();

    const record = await recordSellerClosure(env.DB, row.user_id);
    expect(await env.DB.prepare('SELECT 1 FROM closed_sellers WHERE seller_id = ?').bind(seller.sellerId).first()).toBeTruthy();
    await record.rollback();
    expect(await env.DB.prepare('SELECT 1 FROM closed_sellers WHERE seller_id = ?').bind(seller.sellerId).first()).toBeNull();

    // Once the seller row is gone (cascade got that far), the record must stay.
    const again = await recordSellerClosure(env.DB, row.user_id);
    await env.DB.prepare('DELETE FROM sellers WHERE seller_id = ?').bind(seller.sellerId).run();
    await again.rollback();
    expect(await env.DB.prepare('SELECT 1 FROM closed_sellers WHERE seller_id = ?').bind(seller.sellerId).first()).toBeTruthy();
  });
});
