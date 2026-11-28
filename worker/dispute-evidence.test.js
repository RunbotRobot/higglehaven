import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './test-helpers.js';
import { buildDisputeEvidence, submitDueDisputeEvidence } from './lib/dispute-evidence.js';

// #4650: the evidence is built from the order alone, sent once with submit, and a failure is recorded and retried.
const ADDRESS = JSON.stringify({ name: 'A Buyer', line1: '1 St', city: 'Portland', region: 'OR', postalCode: '97201', country: 'US' });
const NOW = Date.parse('2026-12-01T00:00:00Z');
let builderId;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  builderId = (await api('/builders', { method: 'POST', body: JSON.stringify({ label: `Host ${crypto.randomUUID()}` }) })).body.builder.builderId;
});

async function dispute(tag, { purchase = {}, due = '2026-12-10T00:00:00Z', outcome = 'open' } = {}) {
  await env.DB.prepare(`
    INSERT INTO purchases (purchase_id, instance_id, template_id, builder_id, seller_id, buyer_label, unit_price_cents, quantity, total_cents,
      commission_cents, builder_share_cents, platform_share_cents, product_name, is_digital_good, shipping_address_json, shipping_carrier,
      tracking_number, shipped_at, delivery_confirmed_at, created_at)
    VALUES (?, ?, 't', ?, 's', 'x', 500, 1, 500, 10, 5, 5, 'Oak Chair', ?, ?, 'UPS', '1Z999', '2026-11-20T10:00:00Z', ?, '2026-11-19T10:00:00Z')
  `).bind(`dp-${tag}`, `dpi-${tag}`, builderId, purchase.digital ? 1 : 0, purchase.noAddress ? null : ADDRESS, purchase.delivered ?? null).run();
  await env.DB.prepare('INSERT INTO purchase_disputes (dispute_id, purchase_id, evidence_due_by, outcome) VALUES (?, ?, ?, ?)')
    .bind(`dp_${tag}`, `dp-${tag}`, due, outcome).run();
}
const row = (tag) => env.DB.prepare('SELECT * FROM purchase_disputes WHERE dispute_id = ?').bind(`dp_${tag}`).first();
const fake = (impl) => { const calls = []; return { calls, stripeRequest: async (e, m, path, params) => { calls.push({ m, path, params }); return impl ? impl(path, params) : {}; } }; };

describe('buildDisputeEvidence', () => {
  it('uses the order record: product, address, carrier, tracking, shipped date, delivery confirmation', () => {
    const e = buildDisputeEvidence({ product_name: 'Oak Chair', shipping_address_json: ADDRESS, shipping_carrier: 'UPS', tracking_number: '1Z999',
      shipped_at: '2026-11-20T10:00:00Z', delivery_confirmed_at: '2026-11-25T09:00:00Z', created_at: '2026-11-19T10:00:00Z' });
    expect(e).toEqual({
      product_description: 'Oak Chair', shipping_address: 'A Buyer, 1 St, Portland, OR 97201, US', shipping_carrier: 'UPS',
      shipping_tracking_number: '1Z999', shipping_date: '2026-11-20',
      uncategorized_text: 'Bought on 2026-11-19. The buyer confirmed delivery on 2026-11-25.',
    });
  });
  it('leaves out what the order does not hold, and sends no shipping fields for a digital good', () => {
    expect(buildDisputeEvidence({ product_name: 'Oak Chair', shipping_address_json: null })).toEqual({ product_description: 'Oak Chair' });
    const digital = buildDisputeEvidence({ product_name: 'Avatar', is_digital_good: 1, shipping_carrier: 'UPS', shipping_address_json: ADDRESS, created_at: '2026-11-19T10:00:00Z' });
    expect(Object.keys(digital).sort()).toEqual(['product_description', 'uncategorized_text']);
  });
});

describe('submitDueDisputeEvidence', () => {
  it('sends the evidence once with submit, and never a second time', async () => {
    await dispute('once');
    const s = fake();
    expect(await submitDueDisputeEvidence(env, env.DB, { stripeRequest: s.stripeRequest, nowMs: NOW })).toBe(1);
    const sent = s.calls.filter((c) => c.path === 'disputes/dp_once');
    expect(sent).toHaveLength(1);
    expect(sent[0].m).toBe('POST');
    expect(sent[0].params.submit).toBe('true');
    expect(sent[0].params.evidence.shipping_tracking_number).toBe('1Z999');
    expect((await row('once')).evidence_submitted_at).not.toBeNull();
    await submitDueDisputeEvidence(env, env.DB, { stripeRequest: s.stripeRequest, nowMs: NOW });
    expect(s.calls.filter((c) => c.path === 'disputes/dp_once')).toHaveLength(1);
  });
  it('records a failure on the row and sends again on the next run', async () => {
    await dispute('retry');
    let fail = true;
    const s = fake(() => { if (fail) throw new Error('Stripe is down'); return {}; });
    await submitDueDisputeEvidence(env, env.DB, { stripeRequest: s.stripeRequest, nowMs: NOW });
    let r = await row('retry');
    expect(r.evidence_submitted_at).toBeNull();
    expect(r.evidence_error).toBe('Stripe is down');
    fail = false;
    await submitDueDisputeEvidence(env, env.DB, { stripeRequest: s.stripeRequest, nowMs: NOW });
    r = await row('retry');
    expect(r.evidence_submitted_at).not.toBeNull();
    expect(r.evidence_error).toBeNull();
  });
  it('treats a refused second submit as done, and leaves won and overdue disputes alone', async () => {
    await dispute('dup');
    await dispute('won', { outcome: 'won' });
    await dispute('late', { due: '2026-11-30T00:00:00Z' });
    const s = fake(() => { throw new Error('This dispute has already been submitted'); });
    await submitDueDisputeEvidence(env, env.DB, { stripeRequest: s.stripeRequest, nowMs: NOW });
    expect((await row('dup')).evidence_submitted_at).not.toBeNull();
    expect((await row('won')).evidence_submitted_at).toBeNull();
    const late = await row('late');
    expect(late.evidence_submitted_at).toBeNull();
    expect(late.evidence_error).toMatch(/^due date passed/);
    expect(s.calls.map((c) => c.path).filter((p) => /won|late/.test(p))).toEqual([]);
  });
});
