import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupAdmin } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('dispute-shared-admin');
  adminSession = admin.session;
});

describe('Buyer-initiated purchase disputes (#2020)', () => {
  async function createGreenbeltLandlet(landletId) {
    await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId, name: `Dispute landlet ${landletId}`, areaM2: 1000, status: 'greenbelt' }),
    }));
  }

  async function claim(landletId, builder) {
    return api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  }

  async function createTemplate(templateId, { priceCents = 500, metadata } = {}) {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId,
        name: `Dispute fixture ${templateId}`,
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents,
        metadata,
      }),
    });
    expect(created.response.status).toBe(201);
    return templateId;
  }

  async function placeAndBuy(buyer, landletId, templateId, instanceId) {
    const placed = await api('/instances', buyer.session({
      method: 'POST',
      body: JSON.stringify({ instanceId, landletId, templateId, x: 0, y: 0 }),
    }));
    expect(placed.response.status).toBe(201);
    const purchased = await api(`/instances/${instanceId}/purchase`, buyer.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(201);
    return purchased.body.purchase;
  }

  it('requires a session to dispute a purchase', async () => {
    const buyer = await signupBuilder('dispute-auth-buyer');
    await createGreenbeltLandlet('dispute-auth-landlet');
    await claim('dispute-auth-landlet', buyer);
    await createTemplate('dispute-auth-template');
    const purchase = await placeAndBuy(buyer, 'dispute-auth-landlet', 'dispute-auth-template', 'dispute-auth-instance');
    const result = await api(`/purchases/${purchase.purchaseId}/dispute`, { method: 'POST' });
    expect(result.response.status).toBe(401);
  });

  it('404s disputing a nonexistent purchase', async () => {
    const buyer = await signupBuilder('dispute-404-buyer');
    const result = await api('/purchases/does-not-exist/dispute', buyer.session({ method: 'POST' }));
    expect(result.response.status).toBe(404);
  });

  it('rejects disputing a purchase that is not your own', async () => {
    const buyer = await signupBuilder('dispute-notmine-buyer');
    const stranger = await signupBuilder('dispute-notmine-stranger');
    await createGreenbeltLandlet('dispute-notmine-landlet');
    await claim('dispute-notmine-landlet', buyer);
    await createTemplate('dispute-notmine-template');
    const purchase = await placeAndBuy(buyer, 'dispute-notmine-landlet', 'dispute-notmine-template', 'dispute-notmine-instance');
    const result = await api(`/purchases/${purchase.purchaseId}/dispute`, stranger.session({ method: 'POST' }));
    expect(result.response.status).toBe(400);
  });

  it('does not auto-resolve a brand-new buyer\'s first-ever purchase (no prior purchase to count)', async () => {
    const buyer = await signupBuilder('dispute-new-buyer');
    await createGreenbeltLandlet('dispute-new-landlet');
    await claim('dispute-new-landlet', buyer);
    await createTemplate('dispute-new-template');
    const purchase = await placeAndBuy(buyer, 'dispute-new-landlet', 'dispute-new-template', 'dispute-new-instance');

    const result = await api(`/purchases/${purchase.purchaseId}/dispute`, buyer.session({ method: 'POST' }));
    expect(result.response.status).toBe(200);
    expect(result.body.autoResolved).toBe(false);
    expect(result.body.purchase.refundedAt).toBeNull();
  });

  it('auto-resolves a low-value dispute in the buyer\'s favor for an established buyer', async () => {
    const buyer = await signupBuilder('dispute-established-buyer');
    await createGreenbeltLandlet('dispute-established-landlet');
    await claim('dispute-established-landlet', buyer);
    await createTemplate('dispute-established-template-a');
    await createTemplate('dispute-established-template-b');
    // A prior, unrefunded purchase is what makes this buyer "established."
    await placeAndBuy(buyer, 'dispute-established-landlet', 'dispute-established-template-a', 'dispute-established-instance-a');
    const purchaseB = await placeAndBuy(buyer, 'dispute-established-landlet', 'dispute-established-template-b', 'dispute-established-instance-b');

    const builderBefore = await api('/builders/me', buyer.session());
    const balanceBefore = builderBefore.body.builder.higglesBalanceCents;

    const result = await api(`/purchases/${purchaseB.purchaseId}/dispute`, buyer.session({ method: 'POST' }));
    expect(result.response.status).toBe(200);
    expect(result.body.autoResolved).toBe(true);
    expect(result.body.purchase.refundedAt).toBeTruthy();

    const builderAfter = await api('/builders/me', buyer.session());
    expect(builderAfter.body.builder.higglesBalanceCents).toBe(balanceBefore - purchaseB.builderShareCents);

    const { results: logEntries } = await env.DB.prepare(
      "SELECT * FROM admin_action_log WHERE target_id = ? AND action_type = 'dispute_auto_resolved'",
    ).bind(purchaseB.purchaseId).all();
    expect(logEntries.length).toBe(1);
    expect(logEntries[0].admin_user_id).toBeNull();
  });

  it('does not auto-resolve a high-value dispute even from an established buyer', async () => {
    const buyer = await signupBuilder('dispute-highvalue-buyer');
    await createGreenbeltLandlet('dispute-highvalue-landlet');
    await claim('dispute-highvalue-landlet', buyer);
    await createTemplate('dispute-highvalue-template-a');
    await createTemplate('dispute-highvalue-template-b', { priceCents: 5000 });
    await placeAndBuy(buyer, 'dispute-highvalue-landlet', 'dispute-highvalue-template-a', 'dispute-highvalue-instance-a');
    const purchaseB = await placeAndBuy(buyer, 'dispute-highvalue-landlet', 'dispute-highvalue-template-b', 'dispute-highvalue-instance-b');

    const result = await api(`/purchases/${purchaseB.purchaseId}/dispute`, buyer.session({ method: 'POST' }));
    expect(result.response.status).toBe(200);
    expect(result.body.autoResolved).toBe(false);
    expect(result.body.purchase.refundedAt).toBeNull();
  });

  it('does not auto-resolve for a buyer with prior refund/dispute history', async () => {
    const buyer = await signupBuilder('dispute-history-buyer');
    await createGreenbeltLandlet('dispute-history-landlet');
    await claim('dispute-history-landlet', buyer);
    await createTemplate('dispute-history-template-a');
    await createTemplate('dispute-history-template-b');
    const purchaseA = await placeAndBuy(buyer, 'dispute-history-landlet', 'dispute-history-template-a', 'dispute-history-instance-a');
    // An admin-issued refund on this buyer's earlier purchase is enough
    // refund/dispute history to disqualify them, same as a prior
    // auto-resolved dispute of their own would.
    await api(`/purchases/${purchaseA.purchaseId}/refund`, adminSession({ method: 'POST' }));

    const purchaseB = await placeAndBuy(buyer, 'dispute-history-landlet', 'dispute-history-template-b', 'dispute-history-instance-b');
    const result = await api(`/purchases/${purchaseB.purchaseId}/dispute`, buyer.session({ method: 'POST' }));
    expect(result.response.status).toBe(200);
    expect(result.body.autoResolved).toBe(false);
    expect(result.body.purchase.refundedAt).toBeNull();
  });

  it('400s disputing an already-refunded purchase', async () => {
    const buyer = await signupBuilder('dispute-alreadyrefunded-buyer');
    await createGreenbeltLandlet('dispute-alreadyrefunded-landlet');
    await claim('dispute-alreadyrefunded-landlet', buyer);
    await createTemplate('dispute-alreadyrefunded-template');
    const purchase = await placeAndBuy(buyer, 'dispute-alreadyrefunded-landlet', 'dispute-alreadyrefunded-template', 'dispute-alreadyrefunded-instance');
    await api(`/purchases/${purchase.purchaseId}/refund`, adminSession({ method: 'POST' }));

    const result = await api(`/purchases/${purchase.purchaseId}/dispute`, buyer.session({ method: 'POST' }));
    expect(result.response.status).toBe(400);
  });

  it('409s disputing a purchase that has already been paid out', async () => {
    const buyer = await signupBuilder('dispute-paidout-buyer');
    await createGreenbeltLandlet('dispute-paidout-landlet');
    await claim('dispute-paidout-landlet', buyer);
    await createTemplate('dispute-paidout-template-a');
    await createTemplate('dispute-paidout-template-b');
    await placeAndBuy(buyer, 'dispute-paidout-landlet', 'dispute-paidout-template-a', 'dispute-paidout-instance-a');
    const purchaseB = await placeAndBuy(buyer, 'dispute-paidout-landlet', 'dispute-paidout-template-b', 'dispute-paidout-instance-b');
    await env.DB.prepare('UPDATE purchases SET paid_out_at = ? WHERE purchase_id = ?')
      .bind(new Date().toISOString(), purchaseB.purchaseId).run();

    const result = await api(`/purchases/${purchaseB.purchaseId}/dispute`, buyer.session({ method: 'POST' }));
    expect(result.response.status).toBe(409);
  });

  it('does not auto-resolve when the seller has opted into no returns', async () => {
    const buyer = await signupBuilder('dispute-noreturns-buyer');
    await createGreenbeltLandlet('dispute-noreturns-landlet');
    await claim('dispute-noreturns-landlet', buyer);
    await createTemplate('dispute-noreturns-template-a');
    await createTemplate('dispute-noreturns-template-b', { metadata: { noReturns: true } });
    await placeAndBuy(buyer, 'dispute-noreturns-landlet', 'dispute-noreturns-template-a', 'dispute-noreturns-instance-a');
    const purchaseB = await placeAndBuy(buyer, 'dispute-noreturns-landlet', 'dispute-noreturns-template-b', 'dispute-noreturns-instance-b');

    const result = await api(`/purchases/${purchaseB.purchaseId}/dispute`, buyer.session({ method: 'POST' }));
    expect(result.response.status).toBe(200);
    expect(result.body.autoResolved).toBe(false);
    expect(result.body.purchase.refundedAt).toBeNull();
  });
});
