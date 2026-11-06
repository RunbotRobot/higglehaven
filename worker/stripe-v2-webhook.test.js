import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { signupSeller, signupBuilder } from './test-helpers.js';

// #3237. Own file (own D1/worker isolate): sets STRIPE_WEBHOOK_SECRET_V2 and
// STRIPE_SECRET_KEY, which other suites rely on staying unset.
const SECRET = 'test-stripe-v2-webhook-secret';
const originalFetch = globalThis.fetch;
let accountFetches;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  env.STRIPE_SECRET_KEY = undefined;
  env.STRIPE_WEBHOOK_SECRET_V2 = undefined;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function configure({ requirementsDue = [], failFetch = false } = {}) {
  env.STRIPE_WEBHOOK_SECRET_V2 = SECRET;
  env.STRIPE_SECRET_KEY = 'test-stripe-key';
  accountFetches = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const match = url.match(/^https:\/\/api\.stripe\.com\/v1\/accounts\/(acct_\w+)$/);
    if (match && (!init?.method || init.method === 'GET')) {
      accountFetches.push(match[1]);
      if (failFetch) return new Response('{"error":{"message":"boom"}}', { status: 500 });
      return new Response(JSON.stringify({
        id: match[1], charges_enabled: false, payouts_enabled: false,
        requirements: { currently_due: requirementsDue, disabled_reason: requirementsDue.length ? 'requirements.past_due' : null },
      }), { status: 200 });
    }
    return originalFetch(input, init);
  };
}

async function sign(timestamp, rawBody) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function postV2(event, { signatureHeader } = {}) {
  const rawBody = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  return SELF.fetch('https://higglehaven.test/api/auth/stripe-webhook-v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signatureHeader ?? `t=${ts},v1=${await sign(ts, rawBody)}` },
    body: rawBody,
  });
}

const thinEvent = (accountId, overrides = {}) => ({
  id: 'evt_test',
  object: 'v2.core.event',
  type: 'v2.core.account[requirements].updated',
  created: new Date().toISOString(),
  related_object: { id: accountId, type: 'v2.core.account' },
  ...overrides,
});

describe('Stripe v2 thin-event webhook (#3237)', () => {
  it('answers 503 when STRIPE_WEBHOOK_SECRET_V2 is not set', async () => {
    const res = await postV2(thinEvent('acct_v2_unset'), { signatureHeader: 't=1,v1=abc' });
    expect(res.status).toBe(503);
  });

  it('rejects a bad signature with 400-class and touches nothing', async () => {
    configure();
    const seller = await signupSeller('v2-webhook-badsig');
    await env.DB.prepare("UPDATE sellers SET stripe_account_id = 'acct_v2_badsig', stripe_onboarding_status = 'complete' WHERE seller_id = ?").bind(seller.sellerId).run();
    const res = await postV2(thinEvent('acct_v2_badsig'), { signatureHeader: `t=${Math.floor(Date.now() / 1000)},v1=${'a'.repeat(64)}` });
    expect(res.status).toBe(401);
    expect(accountFetches).toEqual([]);
    const row = await env.DB.prepare('SELECT stripe_onboarding_status FROM sellers WHERE seller_id = ?').bind(seller.sellerId).first();
    expect(row.stripe_onboarding_status).toBe('complete');
  });

  it('fetches the account and refreshes a seller\'s stored status', async () => {
    configure({ requirementsDue: ['individual.verification.document'] });
    const seller = await signupSeller('v2-webhook-seller');
    await env.DB.prepare("UPDATE sellers SET stripe_account_id = 'acct_v2_seller', stripe_onboarding_status = 'complete' WHERE seller_id = ?").bind(seller.sellerId).run();
    const res = await postV2(thinEvent('acct_v2_seller'));
    expect(res.status).toBe(200);
    expect(accountFetches).toEqual(['acct_v2_seller']);
    const row = await env.DB.prepare('SELECT stripe_onboarding_status, stripe_requirements_due FROM sellers WHERE seller_id = ?').bind(seller.sellerId).first();
    expect(row.stripe_onboarding_status).toBe('action_needed');
    expect(JSON.parse(row.stripe_requirements_due)).toEqual(['individual.verification.document']);
  });

  it('refreshes a builder the same way, and handles capability and account-link events', async () => {
    configure({ requirementsDue: ['individual.id_number'] });
    const builder = await signupBuilder('v2-webhook-builder');
    await env.DB.prepare("UPDATE builders SET stripe_account_id = 'acct_v2_builder', stripe_onboarding_status = 'complete' WHERE builder_id = ?").bind(builder.builderId).run();
    const cap = await postV2(thinEvent('acct_v2_builder', { type: 'v2.core.account[configuration.merchant].capability_status_updated' }));
    expect(cap.status).toBe(200);
    let row = await env.DB.prepare('SELECT stripe_onboarding_status FROM builders WHERE builder_id = ?').bind(builder.builderId).first();
    expect(row.stripe_onboarding_status).toBe('action_needed');

    await env.DB.prepare("UPDATE builders SET stripe_onboarding_status = 'complete', stripe_event_created_at = 0 WHERE builder_id = ?").bind(builder.builderId).run();
    const link = await postV2({
      id: 'evt_link', object: 'v2.core.event', type: 'v2.core.account_link.returned', created: new Date().toISOString(),
      related_object: { id: 'acl_x', type: 'v2.core.account_link' }, data: { account_id: 'acct_v2_builder' },
    });
    expect(link.status).toBe(200);
    row = await env.DB.prepare('SELECT stripe_onboarding_status FROM builders WHERE builder_id = ?').bind(builder.builderId).first();
    expect(row.stripe_onboarding_status).toBe('action_needed');
  });

  it('ignores an event older than the stored status without fetching', async () => {
    configure({ requirementsDue: ['x'] });
    const seller = await signupSeller('v2-webhook-stale');
    await env.DB.prepare("UPDATE sellers SET stripe_account_id = 'acct_v2_stale', stripe_onboarding_status = 'complete', stripe_event_created_at = ? WHERE seller_id = ?")
      .bind(Math.floor(Date.now() / 1000) + 3600, seller.sellerId).run();
    const res = await postV2(thinEvent('acct_v2_stale'));
    expect(res.status).toBe(200);
    expect(accountFetches).toEqual([]);
    const row = await env.DB.prepare('SELECT stripe_onboarding_status FROM sellers WHERE seller_id = ?').bind(seller.sellerId).first();
    expect(row.stripe_onboarding_status).toBe('complete');
  });

  it('acknowledges an unknown v2 type and an unknown account without fetching', async () => {
    configure();
    expect((await postV2(thinEvent('acct_whatever', { type: 'v2.core.account.updated' }))).status).toBe(200);
    expect((await postV2(thinEvent('acct_nobody_has_this'))).status).toBe(200);
    expect(accountFetches).toEqual([]);
  });

  it('answers 500 when Stripe cannot be reached, so Stripe redelivers', async () => {
    configure({ failFetch: true });
    const seller = await signupSeller('v2-webhook-fetchfail');
    await env.DB.prepare("UPDATE sellers SET stripe_account_id = 'acct_v2_fail', stripe_onboarding_status = 'complete' WHERE seller_id = ?").bind(seller.sellerId).run();
    const res = await postV2(thinEvent('acct_v2_fail'));
    expect(res.status).toBeGreaterThanOrEqual(500);
    const row = await env.DB.prepare('SELECT stripe_onboarding_status FROM sellers WHERE seller_id = ?').bind(seller.sellerId).first();
    expect(row.stripe_onboarding_status).toBe('complete');
  });
});
