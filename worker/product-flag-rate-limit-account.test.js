// #3241 (sibling of #3238): the product-flag-create rate limit is keyed on the
// ACCOUNT (user_id), not the resettable builder profile. A builder profile can
// be reset to a new builder_id, so a builder-keyed quota handed the flagger a
// fresh one each time. Same standing decision as #3238: anything about a
// person as a person keys on user_id. Own file (own D1 isolate).
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const QUOTA = 20;

// The reset: the builder row goes, the account stays, and /builders/me lazily
// recreates a fresh profile (new builder_id) for the same account.
async function resetBuilderProfile(person) {
  await env.DB.prepare('DELETE FROM builders WHERE builder_id = ?').bind(person.builderId).run();
  expect((await api('/builders/me', person.session())).response.status).toBe(200);
}

async function createTemplate(templateId) {
  const created = await api('/catalog', {
    method: 'POST',
    body: JSON.stringify({ templateId, name: 'Flag rate limit product', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 } }),
  });
  expect(created.response.status).toBe(201);
}

describe('product-flag-create rate limit keys on the account (#3241)', () => {
  it('carries the quota across a builder-profile reset', async () => {
    const templateId = 'flag-rl-reset';
    await createTemplate(templateId);
    const flagger = await signupBuilder('flag-rl-reset-flagger');
    // The limiter runs before the duplicate-flag check, so repeat calls from one
    // flagger still count even though only the first creates a flag.
    const flag = () => api(`/catalog/${templateId}/flags`, flagger.session({ method: 'POST', body: JSON.stringify({}) }));
    for (let i = 0; i < QUOTA; i++) expect((await flag()).response.status).not.toBe(429);
    expect((await flag()).response.status).toBe(429);
    await resetBuilderProfile(flagger);
    expect((await flag()).response.status).toBe(429);
  });

  it('does not let one account\'s spent quota block a different account', async () => {
    const templateId = 'flag-rl-other';
    await createTemplate(templateId);
    const spender = await signupBuilder('flag-rl-spender');
    const other = await signupBuilder('flag-rl-other-account');
    const flag = (who) => api(`/catalog/${templateId}/flags`, who.session({ method: 'POST', body: JSON.stringify({}) }));
    for (let i = 0; i < QUOTA; i++) await flag(spender);
    expect((await flag(spender)).response.status).toBe(429);
    expect((await flag(other)).response.status).not.toBe(429);
  });
});
