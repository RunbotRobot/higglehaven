// #4287: seller-less catalog creation is limited per address, and a batch may carry only so many of them.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './test-helpers.js';

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const template = (id) => ({ templateId: id, name: id, category: 'limit-test', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 100 });

describe('seller-less catalog creation (#4287)', () => {
  it('429s a single create once the address has used its allowance', async () => {
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 120 }, () => env.DB.prepare(
      'INSERT INTO rate_limit_events (bucket_key, created_at) VALUES (?, ?)',
    ).bind('catalog-create-anonymous:anon-limit-ip', now)));
    const refused = await api('/catalog', { method: 'POST', headers: { 'cf-connecting-ip': 'anon-limit-ip' }, body: JSON.stringify(template('anon-limit-a')) });
    expect(refused.response.status).toBe(429);
  });

  it('refuses a batch with more seller-less products than the cap', async () => {
    const templates = Array.from({ length: 51 }, (_, i) => template(`anon-batch-${i}`));
    const refused = await api('/catalog/batch', { method: 'POST', body: JSON.stringify({ templates }) });
    expect(refused.response.status).toBe(400);
    expect(refused.body.error).toMatch(/at most 50/);
  });
});

// #4287 step 2: off a local or test Worker, seller-less creation needs an admin session.
import { handleCatalog } from './lib/catalog.js';
import { signupAdmin } from './test-helpers.js';

describe('seller-less catalog creation off a local Worker (#4287 step 2)', () => {
  const productionEnv = { APP_BASE_URL: 'https://higglehaven.com' };
  const asRequest = (headers = {}) => new Request('https://higglehaven.test/api/catalog', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `prod-${crypto.randomUUID()}`, ...headers },
    body: JSON.stringify(template('prod-seed')),
  });

  it('refuses a caller with no session', async () => {
    await expect(handleCatalog(asRequest(), env.DB, ['catalog'], new URL('https://higglehaven.test/api/catalog'), env.MODELS, productionEnv))
      .rejects.toMatchObject({ status: 401 });
  });

  it('refuses a signed-in non-admin and fails closed when APP_BASE_URL is unset', async () => {
    const { signupBuilder } = await import('./test-helpers.js');
    const builder = await signupBuilder('prod-seed-nonadmin');
    const withSession = (envToUse) => handleCatalog(
      asRequest({ cookie: `hh_session=${builder.sessionToken}` }), env.DB, ['catalog'], new URL('https://higglehaven.test/api/catalog'), env.MODELS, envToUse,
    );
    await expect(withSession(productionEnv)).rejects.toMatchObject({ status: 403 });
    await expect(withSession({})).rejects.toMatchObject({ status: 403 });
  });

  it('lets an admin create one', async () => {
    const admin = await signupAdmin('prod-seed-admin');
    const response = await handleCatalog(
      asRequest({ cookie: `hh_session=${admin.sessionToken}` }), env.DB, ['catalog'], new URL('https://higglehaven.test/api/catalog'), env.MODELS, productionEnv,
    );
    expect(response.status).toBe(201);
  });
});
