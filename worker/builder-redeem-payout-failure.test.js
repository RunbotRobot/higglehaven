import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

// Own file (own D1/worker isolate): needs STRIPE_SECRET_KEY set and fetch
// mocked, which other suites rely on staying unset (see stripe-connect.test.js).
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  env.STRIPE_SECRET_KEY = undefined;
});

describe('Higgle redemption when the Stripe payout fails after the transfer succeeded (#3067)', () => {
  it('keeps the balance debited so the resumed payout does not hand out the cash twice over', async () => {
    const builder = await signupBuilder('redeem-payout-failure');
    await env.DB.prepare(`
      UPDATE builders SET stripe_account_id = 'acct_redeem_pf', stripe_onboarding_status = 'complete',
        higgles_balance_cents = 5000 WHERE builder_id = ?
    `).bind(builder.builderId).run();
    const balance = async () => (await env.DB.prepare('SELECT higgles_balance_cents FROM builders WHERE builder_id = ?')
      .bind(builder.builderId).first()).higgles_balance_cents;

    env.STRIPE_SECRET_KEY = 'test-stripe-key';
    const calls = [];
    let payoutAttempts = 0;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === 'https://api.stripe.com/v1/transfers' && init?.method === 'POST') {
        calls.push('transfer');
        return new Response(JSON.stringify({ id: 'tr_pf_1' }), { status: 200 });
      }
      if (url === 'https://api.stripe.com/v1/payouts' && init?.method === 'POST') {
        payoutAttempts += 1;
        calls.push('payout');
        if (payoutAttempts === 1) {
          return new Response(JSON.stringify({ error: { message: 'insufficient funds in connected account' } }), { status: 400 });
        }
        return new Response(JSON.stringify({ id: 'po_pf_1' }), { status: 200 });
      }
      return originalFetch(input, init);
    };

    const first = await api('/builders/me/redeem', builder.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(first.response.status).toBeGreaterThanOrEqual(400);
    // Real money already moved into the connected account, so the debit must stand.
    expect(await balance()).toBe(0);

    const second = await api('/builders/me/redeem', builder.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(second.response.status).toBe(200);
    expect(second.body.stripePayoutId).toBe('po_pf_1');
    expect(await balance()).toBe(0);
    expect(calls.filter((call) => call === 'transfer')).toHaveLength(1);
  });

  it('still refunds the balance and leaves no redemption row when the transfer itself fails', async () => {
    const builder = await signupBuilder('redeem-transfer-failure');
    await env.DB.prepare(`
      UPDATE builders SET stripe_account_id = 'acct_redeem_tf', stripe_onboarding_status = 'complete',
        higgles_balance_cents = 5000 WHERE builder_id = ?
    `).bind(builder.builderId).run();

    env.STRIPE_SECRET_KEY = 'test-stripe-key';
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === 'https://api.stripe.com/v1/transfers' && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: { message: 'transfer rejected' } }), { status: 400 });
      }
      return originalFetch(input, init);
    };

    const result = await api('/builders/me/redeem', builder.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(result.response.status).toBeGreaterThanOrEqual(400);
    const row = await env.DB.prepare('SELECT higgles_balance_cents FROM builders WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(row.higgles_balance_cents).toBe(5000);
    const leftover = await env.DB.prepare('SELECT COUNT(*) AS n FROM higgles_redemptions WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(leftover.n).toBe(0);
  });
});

// #3070: a Transfer whose outcome is unknown (network error, or a 5xx after
// Stripe may have executed it) must not release the claim, or the retry mints
// a new redemption id / idempotency key and can move the cash a second time.
describe('Higgle redemption when the Transfer outcome is ambiguous (#3070)', () => {
  for (const [label, fail] of [
    ['a network error', () => { throw new TypeError('fetch failed'); }],
    ['a 5xx', () => new Response(JSON.stringify({ error: { message: 'upstream' } }), { status: 500 })],
  ]) {
    it(`keeps the debit and row on ${label}, and the retry transfers once under the same idempotency key`, async () => {
      const builder = await signupBuilder(`redeem-ambiguous-${label.replace(/\W+/g, '-')}`);
      await env.DB.prepare(`
        UPDATE builders SET stripe_account_id = 'acct_redeem_amb', stripe_onboarding_status = 'complete',
          higgles_balance_cents = 5000 WHERE builder_id = ?
      `).bind(builder.builderId).run();
      const balance = async () => (await env.DB.prepare('SELECT higgles_balance_cents FROM builders WHERE builder_id = ?')
        .bind(builder.builderId).first()).higgles_balance_cents;

      env.STRIPE_SECRET_KEY = 'test-stripe-key';
      const transferKeys = [];
      let transferAttempts = 0;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url === 'https://api.stripe.com/v1/transfers' && init?.method === 'POST') {
          transferAttempts += 1;
          transferKeys.push(init.headers['idempotency-key']);
          if (transferAttempts === 1) return fail();
          return new Response(JSON.stringify({ id: 'tr_amb_1' }), { status: 200 });
        }
        if (url === 'https://api.stripe.com/v1/payouts' && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'po_amb_1' }), { status: 200 });
        }
        return originalFetch(input, init);
      };

      const first = await api('/builders/me/redeem', builder.session({ method: 'POST', body: JSON.stringify({}) }));
      expect(first.response.status).toBeGreaterThanOrEqual(400);
      expect(await balance()).toBe(0);
      const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM higgles_redemptions WHERE builder_id = ?')
        .bind(builder.builderId).first();
      expect(rows.n).toBe(1);

      const second = await api('/builders/me/redeem', builder.session({ method: 'POST', body: JSON.stringify({}) }));
      expect(second.response.status).toBe(200);
      expect(await balance()).toBe(0);
      expect(transferKeys).toHaveLength(2);
      expect(transferKeys[1]).toBe(transferKeys[0]);
    });
  }
});
