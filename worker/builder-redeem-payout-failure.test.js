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

// #3079: follow-ups from the second review of #3073.
describe('Higgle redemption destination and pre-call failures (#3079)', () => {
  it('releases the claim when our own code throws before the Transfer is attempted', async () => {
    const builder = await signupBuilder('redeem-precall-error');
    await env.DB.prepare(`
      UPDATE builders SET stripe_account_id = 'acct_redeem_pre', stripe_onboarding_status = 'complete',
        higgles_balance_cents = 5000 WHERE builder_id = ?
    `).bind(builder.builderId).run();
    env.STRIPE_SECRET_KEY = 'test-stripe-key';
    let stripeCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('https://api.stripe.com/')) { stripeCalls += 1; return new Response('{}', { status: 200 }); }
      return originalFetch(input, init);
    };
    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.trim().startsWith('SELECT stripe_account_id FROM builders WHERE builder_id = ?')) {
        armed = false;
        throw new Error('simulated D1 read failure');
      }
      return originalPrepare(sql);
    };
    let result;
    try {
      result = await api('/builders/me/redeem', builder.session({ method: 'POST', body: JSON.stringify({}) }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(result.response.status).toBeGreaterThanOrEqual(400);
    expect(stripeCalls).toBe(0);
    const row = await env.DB.prepare('SELECT higgles_balance_cents FROM builders WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(row.higgles_balance_cents).toBe(5000);
    const leftover = await env.DB.prepare('SELECT COUNT(*) AS n FROM higgles_redemptions WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(leftover.n).toBe(0);
  });

  it('resumes against the account the redemption was claimed for, and refuses once that account is no longer connected', async () => {
    const builder = await signupBuilder('redeem-destination-pinned');
    await env.DB.prepare(`
      UPDATE builders SET stripe_account_id = 'acct_redeem_orig', stripe_onboarding_status = 'complete',
        higgles_balance_cents = 5000 WHERE builder_id = ?
    `).bind(builder.builderId).run();
    env.STRIPE_SECRET_KEY = 'test-stripe-key';
    const transfers = [];
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === 'https://api.stripe.com/v1/transfers' && init?.method === 'POST') {
        transfers.push({ body: String(init.body), key: init.headers['idempotency-key'] });
        if (transfers.length === 1) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ id: 'tr_dest_1' }), { status: 200 });
      }
      if (url === 'https://api.stripe.com/v1/payouts' && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'po_dest_1' }), { status: 200 });
      }
      return originalFetch(input, init);
    };
    const redeem = () => api('/builders/me/redeem', builder.session({ method: 'POST', body: JSON.stringify({}) }));

    expect((await redeem()).response.status).toBeGreaterThanOrEqual(400);
    const claimed = await env.DB.prepare('SELECT destination_account_id FROM higgles_redemptions WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(claimed.destination_account_id).toBe('acct_redeem_orig');

    // The builder's account is reset and a different one connected.
    await env.DB.prepare("UPDATE builders SET stripe_account_id = 'acct_redeem_other' WHERE builder_id = ?")
      .bind(builder.builderId).run();
    const refused = await redeem();
    expect(refused.response.status).toBe(409);
    expect(transfers).toHaveLength(1); // nothing was sent to either account
    const stillClaimed = await env.DB.prepare('SELECT higgles_balance_cents FROM builders WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(stillClaimed.higgles_balance_cents).toBe(0);

    // Reconnecting the original account lets the same redemption finish under the same key.
    await env.DB.prepare("UPDATE builders SET stripe_account_id = 'acct_redeem_orig' WHERE builder_id = ?")
      .bind(builder.builderId).run();
    const resumed = await redeem();
    expect(resumed.response.status).toBe(200);
    expect(transfers).toHaveLength(2);
    expect(transfers[1].key).toBe(transfers[0].key);
    expect(transfers[1].body).toContain('acct_redeem_orig');
  });
});
