// #2923 (sub-issue of #2919): Stripe's one GA path for Connect money movement
// is a v2 Account object with the v1 /v1/transfers, /v1/payouts and
// /v1/balance endpoints (the owner accepted this on 2026-11-05; see AGENTS.md's
// "One model, not a hybrid" refinement). The seller payout and builder
// higgle-redemption code only ever addresses a connected account by its
// stored `acct_...` id, through the v1 client (stripeRequest) with the
// Stripe-Account header -- so a v2-created account works unchanged as long as
// that stays true. These tests pin exactly that contract, so a future change
// (for example pinning the v2 API version onto the money calls, or sending
// something other than the stored id) fails here instead of in production.
//
// Mocked Stripe only; own file because it needs STRIPE_SECRET_KEY set, which
// other suites rely on staying unset (see builder-redeem-payout-failure.test.js).
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stripeRequest } from './index.js';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  env.STRIPE_SECRET_KEY = undefined;
});

// v2 Accounts are addressed by the same `acct_` id shape as v1 ones.
const V2_ACCOUNT_ID = 'acct_1v2AccountMoneyCall';

function recordFetch(respond) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://api.stripe.com/')) return originalFetch(input, init);
    calls.push({ url, method: init?.method, headers: init?.headers ?? {}, body: init?.body });
    return respond(url, init);
  };
  return calls;
}

describe('v1 money-movement calls against a v2-created connected account (#2923)', () => {
  it('reads the connected account balance from /v1/balance with the Stripe-Account header and no version pin', async () => {
    env.STRIPE_SECRET_KEY = 'test-stripe-key';
    const calls = recordFetch(() => new Response(JSON.stringify({ available: [{ currency: 'usd', amount: 1234 }] }), { status: 200 }));
    const balance = await stripeRequest(env, 'GET', 'balance', undefined, undefined, V2_ACCOUNT_ID);
    expect(balance.available[0].amount).toBe(1234);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/balance');
    expect(calls[0].headers['stripe-account']).toBe(V2_ACCOUNT_ID);
    expect(calls[0].headers['stripe-version']).toBeUndefined();
  });

  it('creates a payout on /v1/payouts under the connected account with the idempotency key', async () => {
    env.STRIPE_SECRET_KEY = 'test-stripe-key';
    const calls = recordFetch(() => new Response(JSON.stringify({ id: 'po_v2' }), { status: 200 }));
    await stripeRequest(env, 'POST', 'payouts', { amount: 500, currency: 'usd' }, 'payout-key-1', V2_ACCOUNT_ID);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/payouts');
    expect(calls[0].headers['stripe-account']).toBe(V2_ACCOUNT_ID);
    expect(calls[0].headers['idempotency-key']).toBe('payout-key-1');
    expect(calls[0].headers['stripe-version']).toBeUndefined();
    expect(String(calls[0].body)).toBe('amount=500&currency=usd');
  });

  it('sends no Stripe-Account header for platform-level calls (no accidental account scoping)', async () => {
    env.STRIPE_SECRET_KEY = 'test-stripe-key';
    const calls = recordFetch(() => new Response(JSON.stringify({ id: 'tr_platform' }), { status: 200 }));
    await stripeRequest(env, 'POST', 'transfers', { amount: 100, currency: 'usd', destination: V2_ACCOUNT_ID }, 'transfer-key-1');
    expect(calls[0].url).toBe('https://api.stripe.com/v1/transfers');
    expect(calls[0].headers['stripe-account']).toBeUndefined();
    expect(calls[0].headers['stripe-version']).toBeUndefined();
  });

  it('builder higgle redemption transfers to the stored account id, then pays out under that same account', async () => {
    const builder = await signupBuilder('v2-account-redeem');
    await env.DB.prepare(`
      UPDATE builders SET stripe_account_id = ?, stripe_onboarding_status = 'complete',
        higgles_balance_cents = 5000 WHERE builder_id = ?
    `).bind(V2_ACCOUNT_ID, builder.builderId).run();
    env.STRIPE_SECRET_KEY = 'test-stripe-key';
    const calls = recordFetch((url) => new Response(
      JSON.stringify({ id: url.endsWith('/transfers') ? 'tr_v2' : 'po_v2' }), { status: 200 },
    ));

    const redeemed = await api('/builders/me/redeem', builder.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(redeemed.response.status).toBe(200);
    expect(redeemed.body.stripePayoutId).toBe('po_v2');

    const transfer = calls.find((call) => call.url === 'https://api.stripe.com/v1/transfers');
    const payout = calls.find((call) => call.url === 'https://api.stripe.com/v1/payouts');
    expect(new URLSearchParams(transfer.body).get('destination')).toBe(V2_ACCOUNT_ID);
    expect(transfer.headers['stripe-account']).toBeUndefined(); // the transfer is a platform call
    expect(payout.headers['stripe-account']).toBe(V2_ACCOUNT_ID);
    for (const call of calls) expect(call.headers['stripe-version']).toBeUndefined();
  });
});
