import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { clawBackPurchaseCommission } from './lib/purchase-lifecycle.js';
import { api, signupBuilder, signupSeller, signupAdmin } from './test-helpers.js';

// #4376: "Refund buyers" on an approved counterfeit flag. Stripe is never configured in this suite, so these purchases
// carry no payment intent: the reversal is the local row plus the commission clawback, the same as a no-card refund.
let admin;
let viewer;
let host;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  admin = await signupAdmin('cfr-admin');
  viewer = await signupBuilder('cfr-viewer');
  await env.DB.prepare('UPDATE users SET is_admin_viewer = 1 WHERE email = ?').bind(viewer.email).run();
  host = await signupBuilder('cfr-host');
});

async function makeListing(id, seller) {
  const created = await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({ templateId: id, name: `Fake ${id}`, color: '#123456', dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 1000, sellerId: seller.sellerId }),
  }));
  expect(created.response.status).toBe(201);
}
async function approveFlag(id) {
  const flagger = await signupBuilder(`cfr-flagger-${id}`);
  await api(`/catalog/${id}/flags`, flagger.session({ method: 'POST', body: JSON.stringify({}) }));
  const resolved = await api(`/catalog/${id}/flags/resolve`, admin.session({ method: 'POST', body: JSON.stringify({ action: 'approve' }) }));
  expect(resolved.response.status).toBe(200);
}
async function buy(id, n, { totalCents = 1000, buyer, paidOut = false, refundedPart = 0 } = {}) {
  await env.DB.prepare(`
    INSERT INTO purchases (purchase_id, instance_id, template_id, builder_id, buyer_builder_id, unit_price_cents, quantity,
      total_cents, commission_cents, builder_share_cents, platform_share_cents, paid_out_at, refunded_amount_cents)
    VALUES (?, 'cfr-instance', ?, ?, ?, ?, 1, ?, 20, 10, 10, ?, ?)
  `).bind(`${id}-p${n}`, id, host.builderId, buyer?.builderId ?? null, totalCents, totalCents, paidOut ? '2026-01-01T00:00:00Z' : null, refundedPart).run();
}
const post = (id, body, who = admin) => api(`/product-flags/${id}/refund-buyers`, who.session({ method: 'POST', body: JSON.stringify(body) }));

describe('Refund buyers on an approved counterfeit flag (#4376)', () => {
  it('is refused before the flag is approved, and for anyone who is not a full admin', async () => {
    const seller = await signupSeller('cfr-seller-a');
    await makeListing('cfr-a', seller);
    expect((await api('/product-flags/cfr-a/refund-buyers', admin.session())).response.status).toBe(409);
    await approveFlag('cfr-a');
    const person = await signupBuilder('cfr-person-a');
    expect((await api('/product-flags/cfr-a/refund-buyers', person.session())).response.status).toBe(403);
    expect((await post('cfr-a', { expectedCount: 0, expectedRefundCents: 0 }, person)).response.status).toBe(403);
    // A look-only admin sees what it would do, and the server refuses the action.
    expect((await api('/product-flags/cfr-a/refund-buyers', viewer.session())).response.status).toBe(200);
    expect((await post('cfr-a', { expectedCount: 0, expectedRefundCents: 0 }, viewer)).response.status).toBe(403);
    expect((await api('/product-flags/nope/refund-buyers', admin.session())).response.status).toBe(404);
  });

  it('names the count and total, keeps paid-out and part-refunded orders apart, and refuses a stale confirmation', async () => {
    const seller = await signupSeller('cfr-seller-b');
    await makeListing('cfr-b', seller);
    const b1 = await signupBuilder('cfr-buyer-b1');
    await buy('cfr-b', 1, { buyer: b1, totalCents: 1000 });
    await buy('cfr-b', 2, { totalCents: 500 });
    await buy('cfr-b', 3, { totalCents: 700, paidOut: true });
    await buy('cfr-b', 4, { totalCents: 800, refundedPart: 100 });
    await approveFlag('cfr-b');

    const looked = await api('/product-flags/cfr-b/refund-buyers', admin.session());
    expect(looked.body.refundBuyers).toMatchObject({
      refundCount: 2, orderTotalCents: 1500, refundCents: 990 + 495, notRefundableCount: 2, notRefundableCents: 1500, productName: 'Fake cfr-b',
    });

    const missing = await post('cfr-b', {});
    expect(missing.response.status).toBe(400);
    const stale = await post('cfr-b', { expectedCount: 3, expectedRefundCents: 1485 });
    expect(stale.response.status).toBe(409);
    const untouched = await env.DB.prepare("SELECT COUNT(*) AS n FROM purchases WHERE template_id = 'cfr-b' AND refunded_at IS NOT NULL").first();
    expect(untouched.n).toBe(0);
  });

  it('refunds the listed buyers once, claws back the commission, tells the buyer why, and logs it', async () => {
    const seller = await signupSeller('cfr-seller-c');
    await makeListing('cfr-c', seller);
    const buyer = await signupBuilder('cfr-buyer-c');
    await buy('cfr-c', 1, { buyer, totalCents: 1000 });
    await buy('cfr-c', 2, { totalCents: 600, paidOut: true });
    await approveFlag('cfr-c');
    const before = await env.DB.prepare('SELECT higgles_balance_cents AS b FROM builders WHERE builder_id = ?').bind(host.builderId).first();

    const done = await post('cfr-c', { expectedCount: 1, expectedRefundCents: 990 });
    expect(done.response.status).toBe(200);
    expect(done.body).toMatchObject({ refunded: 1, refundedCents: 990, failed: 0 });
    expect(done.body.refundBuyers).toMatchObject({ refundCount: 0, notRefundableCount: 1, notRefundableCents: 600 });

    const rows = await env.DB.prepare('SELECT purchase_id, refunded_at FROM purchases WHERE template_id = ?').bind('cfr-c').all();
    expect(rows.results.find((r) => r.purchase_id === 'cfr-c-p1').refunded_at).toBeTruthy();
    expect(rows.results.find((r) => r.purchase_id === 'cfr-c-p2').refunded_at).toBeNull();
    const after = await env.DB.prepare('SELECT higgles_balance_cents AS b FROM builders WHERE builder_id = ?').bind(host.builderId).first();
    expect(before.b - after.b).toBe(10);
    const note = await env.DB.prepare("SELECT message FROM notifications WHERE builder_id = ? AND message LIKE '%was refunded%'").bind(buyer.builderId).first();
    expect(note.message).toContain('$10.00');
    expect(note.message).toContain('confirmed counterfeit report');
    const log = await env.DB.prepare("SELECT detail_json FROM admin_action_log WHERE action_type = 'counterfeit_refund_buyers' AND target_id = 'cfr-c'").first();
    expect(JSON.parse(log.detail_json)).toMatchObject({ refunded: 1, refundedCents: 990, remaining: 0, notRefundableCount: 1 });

    // Pressing it again changes nothing: nothing is left to refund and nobody is refunded twice.
    const again = await post('cfr-c', { expectedCount: 0, expectedRefundCents: 0 });
    expect(again.body).toMatchObject({ refunded: 0, failed: 0 });
    const clawback = await env.DB.prepare('SELECT higgles_balance_cents AS b FROM builders WHERE builder_id = ?').bind(host.builderId).first();
    expect(clawback.b).toBe(after.b);
  });

  it('does a bounded batch and says how many are left, so pressing again carries on', async () => {
    const seller = await signupSeller('cfr-seller-d');
    await makeListing('cfr-d', seller);
    for (let n = 1; n <= 10; n += 1) await buy('cfr-d', n, { totalCents: 1000 });
    await approveFlag('cfr-d');
    const first = await post('cfr-d', { expectedCount: 10, expectedRefundCents: 9900 });
    expect(first.body.refunded).toBe(8);
    expect(first.body.refundBuyers).toMatchObject({ refundCount: 2, refundCents: 1980 });
    const second = await post('cfr-d', { expectedCount: 2, expectedRefundCents: 1980 });
    expect(second.body).toMatchObject({ refunded: 2, failed: 0 });
    expect(second.body.refundBuyers.refundCount).toBe(0);
  });

  it('tells a card buyer the 99% that actually goes back, not the order total', async () => {
    const buyer = await signupBuilder('cfr-buyer-e');
    await clawBackPurchaseCommission(env.DB, {
      purchase_id: 'cfr-e-p1', builder_id: null, buyer_builder_id: buyer.builderId, seller_id: null, template_id: 'cfr-e',
      product_name: 'Card thing', total_cents: 1000, builder_share_cents: 0, refunded_amount_cents: 0, payment_intent_id: 'pi_test',
    }, 'Card thing');
    const note = await env.DB.prepare("SELECT message FROM notifications WHERE builder_id = ? AND message LIKE '%was refunded%'").bind(buyer.builderId).first();
    expect(note.message).toContain('$9.90');
  });
});
