// #3217 (sibling of #3214): a product review is authorised by the buyer's
// ACCOUNT (purchases.buyer_user_id, #3195), not the resettable builder profile.
// purchases.buyer_builder_id is ON DELETE SET NULL (migration 0099), so
// matching only on it stranded a buyer's right to review after a profile reset.
// Purchases are inserted directly (permanent receipts, migrations/0051).
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function createTemplate(templateId) {
  const created = await api('/catalog', {
    method: 'POST',
    body: JSON.stringify({ templateId, name: `Product ${templateId}`, color: '#123456', dimensions: { width: 1, depth: 1, height: 1 } }),
  });
  expect(created.response.status).toBe(201);
  return templateId;
}

// buyerUserId/buyerBuilderId are set independently so a test can model a
// reset (builder link cleared, account kept) or a legacy row (no user id).
async function addPurchase(templateId, { buyerUserId = null, buyerBuilderId = null } = {}) {
  const host = (await api('/builders', { method: 'POST', body: JSON.stringify({ label: `Host ${crypto.randomUUID()}` }) })).body.builder;
  const purchaseId = `purchase-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO purchases
      (purchase_id, instance_id, template_id, builder_id, buyer_label, buyer_builder_id, buyer_user_id,
       unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents)
    VALUES (?, ?, ?, ?, 'someone', ?, ?, 500, 1, 500, 10, 5, 5)
  `).bind(purchaseId, `instance-${crypto.randomUUID()}`, templateId, host.builderId, buyerBuilderId, buyerUserId).run();
  return purchaseId;
}

const userIdOf = async (buyer) => (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?').bind(buyer.builderId).first()).user_id;
const review = (templateId, who, body = { rating: 5, text: 'Great' }) =>
  api(`/catalog/${templateId}/reviews`, who.session({ method: 'POST', body: JSON.stringify(body) }));

describe('product review eligibility keys on the account (#3217)', () => {
  it('lets a buyer whose builder profile was reset review, edit and delete a product they bought', async () => {
    const templateId = await createTemplate('review-acct-reset');
    const buyer = await signupBuilder('review-acct-reset-buyer');
    const purchaseId = await addPurchase(templateId, { buyerUserId: await userIdOf(buyer), buyerBuilderId: buyer.builderId });

    // The reset: the builder row goes (buyer_builder_id -> NULL), the account stays.
    await env.DB.prepare('DELETE FROM builders WHERE builder_id = ?').bind(buyer.builderId).run();
    expect((await env.DB.prepare('SELECT buyer_builder_id FROM purchases WHERE purchase_id = ?').bind(purchaseId).first()).buyer_builder_id).toBeNull();
    // /builders/me lazily recreates a fresh profile for the same account.
    expect((await api('/builders/me', buyer.session())).response.status).toBe(200);

    const created = await review(templateId, buyer);
    expect(created.response.status).toBe(201);
    expect(created.body.review.purchaseId).toBe(purchaseId);

    const reviewId = created.body.review.reviewId;
    const edited = await api(`/catalog/${templateId}/reviews/${reviewId}`, buyer.session({ method: 'PATCH', body: JSON.stringify({ rating: 4 }) }));
    expect(edited.response.status).toBe(200);
    const deleted = await api(`/catalog/${templateId}/reviews/${reviewId}`, buyer.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
  });

  it('still refuses another account, including one holding the old builder id\'s purchase', async () => {
    const templateId = await createTemplate('review-acct-stranger');
    const buyer = await signupBuilder('review-acct-stranger-buyer');
    const stranger = await signupBuilder('review-acct-stranger-other');
    await addPurchase(templateId, { buyerUserId: await userIdOf(buyer), buyerBuilderId: null });
    expect((await review(templateId, stranger)).response.status).toBe(400);
    expect((await review(templateId, buyer)).response.status).toBe(201);
  });

  it('keeps the builder match for a legacy purchase with no buyer_user_id, and never lets a user-keyed purchase be claimed by builder id alone', async () => {
    const legacyTemplate = await createTemplate('review-acct-legacy');
    const legacyBuyer = await signupBuilder('review-acct-legacy-buyer');
    await addPurchase(legacyTemplate, { buyerUserId: null, buyerBuilderId: legacyBuyer.builderId });
    expect((await review(legacyTemplate, legacyBuyer)).response.status).toBe(201);

    // A purchase that belongs to another account must not become reviewable
    // just because its (stale) buyer_builder_id points at this builder.
    const templateId = await createTemplate('review-acct-mismatch');
    const owner = await signupBuilder('review-acct-mismatch-owner');
    const other = await signupBuilder('review-acct-mismatch-other');
    await addPurchase(templateId, { buyerUserId: await userIdOf(owner), buyerBuilderId: other.builderId });
    expect((await review(templateId, other)).response.status).toBe(400);
  });

  it('still allows one review per purchase after a reset', async () => {
    const templateId = await createTemplate('review-acct-once');
    const buyer = await signupBuilder('review-acct-once-buyer');
    await addPurchase(templateId, { buyerUserId: await userIdOf(buyer), buyerBuilderId: null });
    expect((await review(templateId, buyer)).response.status).toBe(201);
    expect((await review(templateId, buyer)).response.status).toBe(400);
  });
});
