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

// #3077: after #3068 a redemption whose payout failed keeps its debit, which
// leaves availableCents at 0. The Redeem button used to render only when
// availableCents > 0, so the builder had no way to finish it.
describe('GET /builders/me/redeem reports a redemption left pending (#3077)', () => {
  it('reports the pending amount after a payout failure, and clears it once a retry finishes the payout', async () => {
    const builder = await signupBuilder('redeem-pending-status');
    await env.DB.prepare(`
      UPDATE builders SET stripe_account_id = 'acct_redeem_ps', stripe_onboarding_status = 'complete',
        higgles_balance_cents = 5000 WHERE builder_id = ?
    `).bind(builder.builderId).run();

    const before = await api('/builders/me/redeem', builder.session());
    expect(before.response.status).toBe(200);
    expect(before.body.availableCents).toBe(5000);
    expect(before.body.pendingRedemption).toBeNull();

    env.STRIPE_SECRET_KEY = 'test-stripe-key';
    let payoutAttempts = 0;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === 'https://api.stripe.com/v1/transfers' && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'tr_ps_1' }), { status: 200 });
      }
      if (url === 'https://api.stripe.com/v1/payouts' && init?.method === 'POST') {
        payoutAttempts += 1;
        if (payoutAttempts === 1) {
          return new Response(JSON.stringify({ error: { message: 'insufficient funds in connected account' } }), { status: 400 });
        }
        return new Response(JSON.stringify({ id: 'po_ps_1' }), { status: 200 });
      }
      return originalFetch(input, init);
    };

    const failed = await api('/builders/me/redeem', builder.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(failed.response.status).toBeGreaterThanOrEqual(400);

    const pending = await api('/builders/me/redeem', builder.session());
    expect(pending.body.availableCents).toBe(0);
    expect(pending.body.pendingRedemption).toEqual({ amountCents: 5000 });

    const resumed = await api('/builders/me/redeem', builder.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(resumed.response.status).toBe(200);

    const after = await api('/builders/me/redeem', builder.session());
    expect(after.body.pendingRedemption).toBeNull();
  });
});
