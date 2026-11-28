// #4648 (Disputes 1/3): a Stripe dispute on a purchase is recorded from the funds_withdrawn and funds_reinstated
// events the webhook already receives, once per dispute, in event order, and without ever getting in the way of the
// clawback and its reversal.
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin } from './test-helpers.js';
import { disputeRowFromEvent } from './lib/purchase-disputes.js';

let adminSession;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.STRIPE_WEBHOOK_SECRET = 'test-stripe-webhook-secret';
  adminSession = (await signupAdmin('dispute-record-admin')).session;
});
afterAll(() => { env.STRIPE_WEBHOOK_SECRET = undefined; });

async function postStripeWebhook(eventObject) {
  const rawBody = JSON.stringify(eventObject);
  const ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${rawBody}`)));
  const hex = [...sig].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return SELF.fetch('https://higglehaven.test/api/auth/stripe-webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${hex}` },
    body: rawBody,
  });
}

async function createRealMoneyPurchase(label, paymentIntentId) {
  const builder = await signupAdmin(`${label}-builder`);
  const landletId = `${label}-landlet`;
  await api('/landlets', adminSession({ method: 'POST', body: JSON.stringify({ landletId, name: label, areaM2: 1000, status: 'greenbelt' }) }));
  await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  await api('/catalog', { method: 'POST', body: JSON.stringify({ templateId: `${label}-template`, name: `Product ${label}`, color: '#123456', dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 10000 }) });
  await api('/instances', builder.session({ method: 'POST', body: JSON.stringify({ instanceId: `${label}-instance`, landletId, templateId: `${label}-template`, x: 0, y: 0 }) }));
  const purchased = await api(`/instances/${label}-instance/purchase`, builder.session({ method: 'POST' }));
  const { purchaseId } = purchased.body.purchase;
  await env.DB.prepare('UPDATE purchases SET payment_intent_id = ? WHERE purchase_id = ?').bind(paymentIntentId, purchaseId).run();
  return { builder, purchaseId };
}

const event = (type, created, object) => ({ id: `evt_${type}_${created}`, type, created, data: { object } });
const DISPUTE = { id: 'dp_one', reason: 'product_not_received', amount: 10000, status: 'needs_response', evidence_details: { due_by: 1_800_000_000 } };
const rows = (purchaseId) => env.DB.prepare('SELECT * FROM purchase_disputes WHERE purchase_id = ?').bind(purchaseId).all().then((r) => r.results);

describe('disputeRowFromEvent (#4648)', () => {
  it('reads the dispute the event carries, and nothing when it names none', () => {
    const row = disputeRowFromEvent(event('charge.dispute.funds_withdrawn', 1000, DISPUTE));
    expect(row).toMatchObject({ disputeId: 'dp_one', reason: 'product_not_received', amountCents: 10000, status: 'needs_response', outcome: 'open', lastEventAt: 1000 });
    expect(row.evidenceDueBy).toBe(new Date(1_800_000_000 * 1000).toISOString());
    expect(disputeRowFromEvent(event('charge.dispute.funds_reinstated', 2000, DISPUTE)).outcome).toBe('won');
    expect(disputeRowFromEvent(event('charge.dispute.funds_withdrawn', 1000, {}))).toBeNull();
    expect(disputeRowFromEvent({ type: 'charge.dispute.funds_withdrawn' })).toBeNull();
  });

  it('tolerates a sparse dispute (a missing reason, amount or due date is just empty)', () => {
    expect(disputeRowFromEvent(event('charge.dispute.funds_withdrawn', 1, { id: 'dp_sparse' }))).toMatchObject({ disputeId: 'dp_sparse', reason: null, amountCents: null, evidenceDueBy: null });
  });
});

describe('recording a dispute (#4648)', () => {
  it('writes one row when funds are withdrawn, once however often the event is delivered, and the clawback still happens', async () => {
    const { purchaseId } = await createRealMoneyPurchase('rec', 'pi_rec');
    const withdrawn = event('charge.dispute.funds_withdrawn', 1000, { ...DISPUTE, payment_intent: 'pi_rec' });
    expect((await postStripeWebhook(withdrawn)).status).toBe(200);
    expect((await postStripeWebhook(withdrawn)).status).toBe(200);
    const [row, ...rest] = await rows(purchaseId);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ dispute_id: 'dp_one', reason: 'product_not_received', amount_cents: 10000, outcome: 'open', last_event_at: 1000, evidence_submitted_at: null });
    const purchase = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(purchase.refunded_at).not.toBeNull();
  });

  it('marks it won when the funds come back, and a late older withdrawal never reopens it', async () => {
    const { purchaseId } = await createRealMoneyPurchase('won', 'pi_won');
    const object = { ...DISPUTE, id: 'dp_won', payment_intent: 'pi_won' };
    await postStripeWebhook(event('charge.dispute.funds_withdrawn', 1000, object));
    await postStripeWebhook(event('charge.dispute.funds_reinstated', 2000, object));
    expect((await rows(purchaseId))[0]).toMatchObject({ outcome: 'won', last_event_at: 2000 });
    await postStripeWebhook(event('charge.dispute.funds_withdrawn', 1000, object));
    expect((await rows(purchaseId))[0]).toMatchObject({ outcome: 'won', last_event_at: 2000 });
  });

  it('keeps each dispute of a purchase as its own row (a second cycle)', async () => {
    const { purchaseId } = await createRealMoneyPurchase('two', 'pi_two');
    await postStripeWebhook(event('charge.dispute.funds_withdrawn', 1000, { ...DISPUTE, id: 'dp_a', payment_intent: 'pi_two' }));
    await postStripeWebhook(event('charge.dispute.funds_reinstated', 2000, { ...DISPUTE, id: 'dp_a', payment_intent: 'pi_two' }));
    await postStripeWebhook(event('charge.dispute.funds_withdrawn', 3000, { ...DISPUTE, id: 'dp_b', payment_intent: 'pi_two' }));
    const found = await rows(purchaseId);
    expect(found.map((r) => [r.dispute_id, r.outcome]).sort()).toEqual([['dp_a', 'won'], ['dp_b', 'open']]);
  });

  it('records nothing for a charge that is not one of ours, and the webhook still answers 200', async () => {
    expect((await postStripeWebhook(event('charge.dispute.funds_withdrawn', 1000, { ...DISPUTE, id: 'dp_unknown', payment_intent: 'pi_not_ours' }))).status).toBe(200);
    const none = await env.DB.prepare("SELECT COUNT(*) AS n FROM purchase_disputes WHERE dispute_id = 'dp_unknown'").first();
    expect(none.n).toBe(0);
  });
});
