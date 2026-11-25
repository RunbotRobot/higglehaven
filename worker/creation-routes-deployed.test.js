// #4287: POST /api/sellers, POST /api/builders and seller-less catalog creation need an admin session on a deployed
// Worker (an https APP_BASE_URL, or none); they stay open only on a local or test Worker.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleSellers } from './lib/seller-profile.js';
import { isLocalOrTestWorker, requireAdminUnlessLocalWorker } from './lib/auth.js';
import { signupAdmin, signupBuilder } from './test-helpers.js';

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const deployed = { APP_BASE_URL: 'https://higglehaven.com' };
const post = (headers = {}) => new Request('https://higglehaven.test/api/sellers', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': `deployed-${crypto.randomUUID()}`, ...headers },
  body: JSON.stringify({ label: 'Deployed Seller' }),
});

describe('which Worker counts as local or test (#4287)', () => {
  it('a test binding or a local APP_BASE_URL is local; a deployed or unset one is not', () => {
    expect(isLocalOrTestWorker({ TEST_MIGRATIONS: [] })).toBe(true);
    expect(isLocalOrTestWorker({ APP_BASE_URL: 'http://127.0.0.1:8787' })).toBe(true);
    expect(isLocalOrTestWorker({ APP_BASE_URL: 'http://localhost:8787' })).toBe(true);
    expect(isLocalOrTestWorker({ APP_BASE_URL: 'https://higglehaven.com' })).toBe(false);
    expect(isLocalOrTestWorker({ APP_BASE_URL: 'http://127.0.0.1.evil.example' })).toBe(false);
    expect(isLocalOrTestWorker({})).toBe(false);
  });
});

describe('POST /api/sellers on a deployed Worker (#4287)', () => {
  const call = (headers) => handleSellers(post(headers), deployed, env.DB, ['sellers'], new URL('https://higglehaven.test/api/sellers'));

  it('refuses no session and a non-admin, and lets an admin through', async () => {
    await expect(call()).rejects.toMatchObject({ status: 401 });
    const builder = await signupBuilder('deployed-seller-nonadmin');
    await expect(call({ cookie: `hh_session=${builder.sessionToken}` })).rejects.toMatchObject({ status: 403 });
    const admin = await signupAdmin('deployed-seller-admin');
    const response = await call({ cookie: `hh_session=${admin.sessionToken}` });
    expect(response.status).toBe(201);
  });
});

describe('requireAdminUnlessLocalWorker', () => {
  it('lets a local Worker through with no session and asks a deployed one for an admin', async () => {
    await expect(requireAdminUnlessLocalWorker(post(), env.DB, { TEST_MIGRATIONS: [] })).resolves.toBeUndefined();
    await expect(requireAdminUnlessLocalWorker(post(), env.DB, deployed)).rejects.toMatchObject({ status: 401 });
  });
});
