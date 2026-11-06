// #3214 (follow-up to #3195): a purchase's buyer-side actions (seller feedback
// create/edit/delete, and raising a dispute) authorise on the account
// (purchases.buyer_user_id), not on buyer_builder_id, which is ON DELETE SET NULL
// and goes NULL when a builder profile is reset or deleted (#3121). Own file
// (own D1 isolate): it writes purchases and feedback rows directly.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const userIdOf = async (account) => (await api('/auth/me', account.session())).body.user.userId;

// seller_id and template_id need no real rows (migrations/0051: a permanent
// receipt, not tied to a live reference); only the hosting builder's id needs
// to exist. The default is a purchase from before #3195's backfill could resolve
// the buyer's account: buyer_user_id set, buyer_builder_id already NULL, i.e.
// exactly the state a builder-profile reset leaves behind.
async function createPurchase(buyer, { buyerUserId, buyerBuilderId = null, totalCents = 500 } = {}) {
  const host = (await api('/builders', { method: 'POST', body: JSON.stringify({ label: `Host ${crypto.randomUUID()}` }) })).body.builder;
  const purchaseId = `purchase-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO purchases
      (purchase_id, instance_id, template_id, builder_id, seller_id, buyer_label, buyer_builder_id, buyer_user_id,
       unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents)
    VALUES (?, ?, ?, ?, 'seller-no-real-row', ?, ?, ?, ?, 1, ?, 10, 5, 5)
  `).bind(purchaseId, `instance-${crypto.randomUUID()}`, `template-${crypto.randomUUID()}`, host.builderId,
    buyer.builder.label, buyerBuilderId, buyerUserId ?? null, totalCents, totalCents).run();
  return purchaseId;
}

const postFeedback = (purchaseId, account, body = { rating: 4, text: 'Fast and accurate.' }) => api(
  `/purchases/${purchaseId}/feedback`, account.session({ method: 'POST', body: JSON.stringify(body) }),
);

describe('Buyer actions after a builder-profile reset (#3214)', () => {
  it('lets the buyer leave, edit and delete seller feedback on a purchase whose buyer_builder_id is gone', async () => {
    const buyer = await signupBuilder('buyer-actions-feedback-buyer');
    const purchaseId = await createPurchase(buyer, { buyerUserId: await userIdOf(buyer) });

    const created = await postFeedback(purchaseId, buyer);
    expect(created.response.status).toBe(201);

    const edited = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
      method: 'PATCH', body: JSON.stringify({ rating: 2, text: 'Changed my mind.' }),
    }));
    expect(edited.response.status).toBe(200);
    expect(edited.body.feedback.rating).toBe(2);

    const deleted = await api(`/purchases/${purchaseId}/feedback`, buyer.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
  });

  it('still refuses another account, on feedback and on a dispute, for the same purchase', async () => {
    const buyer = await signupBuilder('buyer-actions-owner-buyer');
    const stranger = await signupBuilder('buyer-actions-stranger');
    const purchaseId = await createPurchase(buyer, { buyerUserId: await userIdOf(buyer) });
    await postFeedback(purchaseId, buyer);

    expect((await postFeedback(purchaseId, stranger)).response.status).toBe(400);
    const edit = await api(`/purchases/${purchaseId}/feedback`, stranger.session({
      method: 'PATCH', body: JSON.stringify({ rating: 1 }),
    }));
    expect(edit.response.status).toBe(403);
    const del = await api(`/purchases/${purchaseId}/feedback`, stranger.session({ method: 'DELETE' }));
    expect(del.response.status).toBe(403);
    const dispute = await api(`/purchases/${purchaseId}/dispute`, stranger.session({ method: 'POST' }));
    expect(dispute.response.status).toBe(400);
  });

  it('lets the buyer raise a dispute on a purchase whose buyer_builder_id is gone', async () => {
    const buyer = await signupBuilder('buyer-actions-dispute-buyer');
    const purchaseId = await createPurchase(buyer, { buyerUserId: await userIdOf(buyer) });

    const dispute = await api(`/purchases/${purchaseId}/dispute`, buyer.session({ method: 'POST' }));
    expect(dispute.response.status).toBe(200);
    // A first-ever purchase has no history to be "established" on: it is
    // accepted, not auto-resolved.
    expect(dispute.body.autoResolved).toBe(false);
  });

  it('counts the buyer\'s earlier purchases by account, so a reset does not make a long-time buyer look new', async () => {
    const buyer = await signupBuilder('buyer-actions-established-buyer');
    const userId = await userIdOf(buyer);
    // Earlier completed purchase: its builder link is gone (reset), the account link remains.
    await createPurchase(buyer, { buyerUserId: userId });
    // The one being disputed: also reset, low value, so an established buyer is auto-refunded.
    const disputed = await createPurchase(buyer, { buyerUserId: userId, totalCents: 500 });

    const dispute = await api(`/purchases/${disputed}/dispute`, buyer.session({ method: 'POST' }));
    expect(dispute.response.status).toBe(200);
    expect(dispute.body.autoResolved).toBe(true);
  });

  it('still accepts the old buyer_builder_id match for a purchase with no buyer_user_id (recorded before #3195)', async () => {
    const buyer = await signupBuilder('buyer-actions-legacy-buyer');
    const stranger = await signupBuilder('buyer-actions-legacy-stranger');
    const purchaseId = await createPurchase(buyer, { buyerBuilderId: buyer.builderId });

    expect((await postFeedback(purchaseId, stranger)).response.status).toBe(400);
    expect((await postFeedback(purchaseId, buyer)).response.status).toBe(201);
    const dispute = await api(`/purchases/${purchaseId}/dispute`, buyer.session({ method: 'POST' }));
    expect(dispute.response.status).toBe(200);
  });

  it('gives nobody standing on a purchase with neither a buyer account nor a buyer builder', async () => {
    const someone = await signupBuilder('buyer-actions-orphan-someone');
    const purchaseId = await createPurchase(someone);

    expect((await postFeedback(purchaseId, someone)).response.status).toBe(400);
    const dispute = await api(`/purchases/${purchaseId}/dispute`, someone.session({ method: 'POST' }));
    expect(dispute.response.status).toBe(400);
  });
});
