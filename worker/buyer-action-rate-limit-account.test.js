// #3238: the buyer-action create/dispute rate limits are keyed on the ACCOUNT
// (user_id), not the resettable builder profile. A builder profile can be reset
// to a new builder_id, so a builder-keyed quota handed the buyer a fresh one
// each time. Same standing decision as #3214/#3217: anything about a person as
// a person keys on user_id. The check runs before eligibility, so a stranger's
// rejected calls still count, which lets the test burn the quota cheaply.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const QUOTA = 20;

// The reset: the builder row goes, the account stays, and /builders/me lazily
// recreates a fresh profile (new builder_id) for the same account.
async function resetBuilderProfile(buyer) {
  await env.DB.prepare('DELETE FROM builders WHERE builder_id = ?').bind(buyer.builderId).run();
  expect((await api('/builders/me', buyer.session())).response.status).toBe(200);
}

async function burn(call, times = QUOTA) {
  for (let i = 0; i < times; i++) {
    expect((await call()).response.status).not.toBe(429);
  }
}

describe('buyer-action rate limits key on the account (#3238)', () => {
  it('carries the dispute quota across a builder-profile reset', async () => {
    const buyer = await signupBuilder('rl-acct-dispute');
    const dispute = () => api(`/purchases/missing-${crypto.randomUUID()}/dispute`, buyer.session({ method: 'POST', body: '{}' }));
    await burn(dispute);
    await resetBuilderProfile(buyer);
    expect((await dispute()).response.status).toBe(429);
  });

  it('carries the seller-feedback-create quota across a builder-profile reset', async () => {
    const buyer = await signupBuilder('rl-acct-feedback');
    const host = (await api('/builders', { method: 'POST', body: JSON.stringify({ label: `Host ${crypto.randomUUID()}` }) })).body.builder;
    const purchaseId = `purchase-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO purchases
        (purchase_id, instance_id, template_id, builder_id, seller_id, buyer_label,
         unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents)
      VALUES (?, ?, 'rl-acct-feedback-template', ?, ?, 'someone', 500, 1, 500, 10, 5, 5)
    `).bind(purchaseId, `instance-${crypto.randomUUID()}`, host.builderId, `seller-${crypto.randomUUID()}`).run();
    // Not this account's purchase, so every call is rejected after the limiter.
    const feedback = () => api(`/purchases/${purchaseId}/feedback`, buyer.session({ method: 'POST', body: JSON.stringify({ rating: 5 }) }));
    await burn(feedback);
    await resetBuilderProfile(buyer);
    expect((await feedback()).response.status).toBe(429);
  });

  it('carries the product-review-create quota across a builder-profile reset', async () => {
    const templateId = 'rl-acct-review';
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({ templateId, name: 'Rate limit product', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 } }),
    });
    expect(created.response.status).toBe(201);
    const buyer = await signupBuilder('rl-acct-review-buyer');
    const review = () => api(`/catalog/${templateId}/reviews`, buyer.session({ method: 'POST', body: JSON.stringify({ rating: 5, text: 'x' }) }));
    await burn(review);
    await resetBuilderProfile(buyer);
    expect((await review()).response.status).toBe(429);
  });

  it('does not let one account\'s spent quota block a different account', async () => {
    const spender = await signupBuilder('rl-acct-spender');
    const other = await signupBuilder('rl-acct-other');
    const dispute = (who) => api(`/purchases/missing-${crypto.randomUUID()}/dispute`, who.session({ method: 'POST', body: '{}' }));
    await burn(() => dispute(spender));
    expect((await dispute(spender)).response.status).toBe(429);
    expect((await dispute(other)).response.status).not.toBe(429);
  });
});
