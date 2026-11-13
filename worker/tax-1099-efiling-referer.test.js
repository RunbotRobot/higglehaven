import { applyD1Migrations, env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder } from './test-helpers.js';
import { tax1099EfilingDomainHeaders } from './lib/seller-payouts-tax.js';

// #3517: the e-filing vendor whitelists by domain, not IP (a Worker has no fixed
// outbound IP). Its "Domain Reference Id" has to go in the Referer header of
// every call, on both the OAuth URL and the API URL. Own file (own D1/worker
// isolate, same reasoning as worker/tax-1099-filing-race.test.js) because it
// configures the vendor secrets. The vendor itself is mocked with a temporary
// globalThis.fetch override; that a Worker's outbound fetch really delivers a
// caller-set Referer was checked separately against a local echo server under
// the same runtime (wrangler dev / workerd), not here.
const REFERENCE_ID = 'test-domain-reference-id';
let adminSession;
// The headers of each vendor call, in order, so a test can tell the token call
// from the filing call.
let vendorCalls = [];
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('tax-1099-referer-admin')).session;
  env.TAX_ID_ENCRYPTION_KEY = 'a'.repeat(64);
  env.TAX_1099_EFILING_CLIENT_ID = 'test-client-id';
  env.TAX_1099_EFILING_CLIENT_SECRET = 'test-client-secret';
  env.TAX_1099_EFILING_USER_TOKEN = 'test-user-token';
  env.TAX_1099_PAYER_NAME = 'Higglehaven Test Payer';
  env.TAX_1099_PAYER_EIN = '00-0000000';

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers = new Headers(init?.headers);
    if (url.includes('tbsauth')) {
      vendorCalls.push({ kind: 'token', referer: headers.get('referer') });
      return new Response(JSON.stringify({ AccessToken: 'test-access-token' }), { status: 200 });
    }
    if (url.includes('/Create')) {
      vendorCalls.push({ kind: 'create', referer: headers.get('referer') });
      return new Response(JSON.stringify({ SubmissionId: 'sub-referer' }), { status: 200 });
    }
    return originalFetch(input, init);
  };
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const name of ['TAX_ID_ENCRYPTION_KEY', 'TAX_1099_EFILING_CLIENT_ID', 'TAX_1099_EFILING_CLIENT_SECRET',
    'TAX_1099_EFILING_USER_TOKEN', 'TAX_1099_PAYER_NAME', 'TAX_1099_PAYER_EIN', 'TAX_1099_EFILING_DOMAIN_REFERENCE_ID']) {
    env[name] = undefined;
  }
});

async function approvedForm(label) {
  const builder = await signupBuilder(label);
  const builderMe = await api('/builders/me', builder.session());
  const submitted = await api('/tax/id-form', builder.session({
    method: 'POST',
    body: JSON.stringify({
      formType: 'w9', legalName: 'Grace Hopper', addressLine1: '1 Compiler Lane',
      city: 'Arlington', state: 'VA', postalCode: '22201', taxIdNumber: '123-45-6789',
    }),
  }));
  expect(submitted.response.status).toBe(200);
  const granted = await api(`/builders/${builderMe.body.builder.builderId}/land-cap-grants`, adminSession({
    method: 'POST', body: JSON.stringify({ amountCents: 70000 }),
  }));
  expect(granted.response.status).toBe(201);
  const listed = await api(`/tax/admin-forms?year=${new Date().getUTCFullYear()}`, adminSession());
  const form = listed.body.forms.find((f) => f.email === builder.email);
  const approved = await api(`/tax/admin-forms/${form.formId}/approve`, adminSession({ method: 'POST' }));
  expect(approved.response.status).toBe(200);
  return form.formId;
}

describe('domain whitelisting Referer on the e-filing vendor calls (#3517)', () => {
  it('sends no Referer when no Domain Reference Id is configured (the Sandbox default)', async () => {
    env.TAX_1099_EFILING_DOMAIN_REFERENCE_ID = undefined;
    vendorCalls = [];
    const connection = await api('/tax/efiling-connection-test', adminSession());
    expect(connection.response.status).toBe(200);
    const formId = await approvedForm('tax-1099-referer-unset');
    vendorCalls = [];
    const filed = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(filed.response.status).toBe(200);
    expect(vendorCalls.map((c) => c.kind)).toEqual(['token', 'create']);
    expect(vendorCalls.every((c) => c.referer === null)).toBe(true);
  });

  it('sends the Domain Reference Id as Referer on both the token request and the filing call', async () => {
    env.TAX_1099_EFILING_DOMAIN_REFERENCE_ID = REFERENCE_ID;
    const formId = await approvedForm('tax-1099-referer-set');
    vendorCalls = [];
    const filed = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(filed.response.status).toBe(200);
    expect(vendorCalls.map((c) => c.kind)).toEqual(['token', 'create']);
    expect(vendorCalls.map((c) => c.referer)).toEqual([REFERENCE_ID, REFERENCE_ID]);
    // Treated like a credential: never returned to the admin.
    expect(JSON.stringify(filed.body)).not.toContain(REFERENCE_ID);
  });

  it('sends it on the admin connection test too (the same token request)', async () => {
    env.TAX_1099_EFILING_DOMAIN_REFERENCE_ID = REFERENCE_ID;
    vendorCalls = [];
    const connection = await api('/tax/efiling-connection-test', adminSession());
    expect(connection.response.status).toBe(200);
    expect(vendorCalls).toEqual([{ kind: 'token', referer: REFERENCE_ID }]);
    expect(JSON.stringify(connection.body)).not.toContain(REFERENCE_ID);
  });
});

describe('tax1099EfilingDomainHeaders (#3517)', () => {
  it('gives the Referer when configured, nothing when not, in the Sandbox', () => {
    expect(tax1099EfilingDomainHeaders({ TAX_1099_EFILING_DOMAIN_REFERENCE_ID: 'abc' })).toEqual({ referer: 'abc' });
    expect(tax1099EfilingDomainHeaders({})).toEqual({});
  });

  it('refuses to run Live without it, with a plain admin-facing message', () => {
    expect(tax1099EfilingDomainHeaders({ TAX_1099_EFILING_DOMAIN_REFERENCE_ID: 'abc' }, true)).toEqual({ referer: 'abc' });
    let thrown;
    try { tax1099EfilingDomainHeaders({}, true); } catch (error) { thrown = error; }
    expect(thrown?.status).toBe(503);
    expect(thrown?.message).toMatch(/domain whitelisting reference is not configured/);
  });
});
