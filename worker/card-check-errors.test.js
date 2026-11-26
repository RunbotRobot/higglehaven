// #4478: the card check at sign-up. The two refusals that used to carry only an internal sentence now carry a
// stable code (src/errorCopy.js turns it into shopper copy that says nothing was charged and offers the ID route),
// and the "account no longer exists" 404 carries one too.
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  env.STRIPE_SECRET_KEY = undefined;
});

function stubStripe(setupIntent) {
  env.STRIPE_SECRET_KEY = 'test-stripe-key';
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url.includes('api.stripe.com') && url.includes('setup_intents/')) {
      return new Response(JSON.stringify(setupIntent), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  };
}

describe('confirm-card refusals carry codes (#4478)', () => {
  it('a set-up that belongs to someone else answers 403 with card_check_mismatch', async () => {
    const account = await signupBuilder('card-check-mismatch');
    stubStripe({ id: 'seti_x', status: 'succeeded', payment_method: 'pm_x', metadata: { userId: 'someone-else' } });
    const { response, body } = await api('/auth/confirm-card', account.session({
      method: 'POST', body: JSON.stringify({ setupIntentId: 'seti_x' }), headers: { 'content-type': 'application/json' },
    }));
    expect(response.status).toBe(403);
    expect(body.code).toBe('card_check_mismatch');
  });

  it('a set-up that has not succeeded answers 400 with card_check_incomplete', async () => {
    const account = await signupBuilder('card-check-incomplete');
    const me = await api('/auth/me', account.session());
    stubStripe({ id: 'seti_y', status: 'requires_action', payment_method: null, metadata: { userId: me.body.user.userId } });
    const { response, body } = await api('/auth/confirm-card', account.session({
      method: 'POST', body: JSON.stringify({ setupIntentId: 'seti_y' }), headers: { 'content-type': 'application/json' },
    }));
    expect(response.status).toBe(400);
    expect(body.code).toBe('card_check_incomplete');
  });
});
