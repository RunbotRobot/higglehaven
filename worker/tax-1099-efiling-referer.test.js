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
// What the mocked token endpoint does with a call, by the Referer it carried.
// Default: accepts everything (a vendor that is not checking whitelisting).
let tokenBehaviour = () => new Response(JSON.stringify({ AccessToken: 'test-access-token' }), { status: 200 });
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
      return tokenBehaviour(headers.get('referer'));
    }
    if (/\/v2\.0\.0\/(Form1099NEC\/Create|form1099K\/create)$/i.test(url)) {
      vendorCalls.push({ kind: 'create', referer: headers.get('referer') });
      return new Response(JSON.stringify({ SubmissionId: 'sub-referer' }), { status: 200 });
    }
    if (/\/v2\.0\.0\/Form1099\/transmit$/i.test(url)) {
      vendorCalls.push({ kind: 'transmit', referer: headers.get('referer') });
      return new Response(JSON.stringify({ Form1099Records: [{ FederalStatus: { Status: 'TRANSMITTED' } }] }), { status: 200 });
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
    expect(vendorCalls.map((c) => c.kind)).toEqual(['token', 'create', 'transmit']);
    expect(vendorCalls.every((c) => c.referer === null)).toBe(true);
  });

  it('sends the Domain Reference Id as Referer on the token request and on both the Create and Transmit calls', async () => {
    env.TAX_1099_EFILING_DOMAIN_REFERENCE_ID = REFERENCE_ID;
    const formId = await approvedForm('tax-1099-referer-set');
    vendorCalls = [];
    const filed = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(filed.response.status).toBe(200);
    expect(vendorCalls.map((c) => c.kind)).toEqual(['token', 'create', 'transmit']);
    expect(vendorCalls.map((c) => c.referer)).toEqual([REFERENCE_ID, REFERENCE_ID, REFERENCE_ID]);
    // Treated like a credential: never returned to the admin.
    expect(JSON.stringify(filed.body)).not.toContain(REFERENCE_ID);
  });

  it('sends it on the admin connection test too (the same token request)', async () => {
    env.TAX_1099_EFILING_DOMAIN_REFERENCE_ID = REFERENCE_ID;
    vendorCalls = [];
    const connection = await api('/tax/efiling-connection-test', adminSession());
    expect(connection.response.status).toBe(200);
    // The real id first, then (a vendor that accepts anything) one wrong id.
    expect(vendorCalls.map((c) => c.kind)).toEqual(['token', 'token']);
    expect(vendorCalls[0].referer).toBe(REFERENCE_ID);
    expect(vendorCalls[1].referer).not.toBe(REFERENCE_ID);
    expect(JSON.stringify(connection.body)).not.toContain(REFERENCE_ID);
  });
});

// #3607: the connection test also asks whether the vendor really checks the id.
describe('what the connection test learns about whitelisting (#3607)', () => {
  const refuse = () => new Response(JSON.stringify({ StatusCode: 401, StatusMessage: 'Unauthorized domain reference' }), { status: 401 });
  const accept = () => new Response(JSON.stringify({ AccessToken: 'test-access-token' }), { status: 200 });
  const test = async () => {
    env.TAX_1099_EFILING_DOMAIN_REFERENCE_ID = REFERENCE_ID;
    vendorCalls = [];
    return api('/tax/efiling-connection-test', adminSession());
  };
  afterAll(() => { tokenBehaviour = accept; });

  it('says not enforced when a wrong id is accepted, and tests nothing more', async () => {
    tokenBehaviour = accept;
    const { response, body } = await test();
    expect(response.status).toBe(200);
    expect(body).toEqual({ connected: true, whitelisting: 'not_enforced' });
    expect(vendorCalls).toHaveLength(2);
  });

  it('says enforced and insensitive when the wrong id is refused and the other letter case is accepted', async () => {
    tokenBehaviour = (referer) => (referer.toLowerCase() === REFERENCE_ID.toLowerCase() ? accept() : refuse());
    const { body } = await test();
    expect(body).toMatchObject({ connected: true, whitelisting: 'enforced', referenceIdCase: 'insensitive', refusal: { status: 401, message: 'Unauthorized domain reference' } });
    expect(vendorCalls).toHaveLength(3);
    expect(vendorCalls[2].referer).toBe(REFERENCE_ID.toUpperCase());
    expect(JSON.stringify(body)).not.toContain(REFERENCE_ID);
  });

  it('says sensitive when only the exact letter case is accepted', async () => {
    tokenBehaviour = (referer) => (referer === REFERENCE_ID ? accept() : refuse());
    const { body } = await test();
    expect(body).toMatchObject({ whitelisting: 'enforced', referenceIdCase: 'sensitive' });
  });

  it('never repeats the id if the vendor echoes it back in its refusal', async () => {
    tokenBehaviour = (referer) => (referer === REFERENCE_ID ? accept()
      : new Response(JSON.stringify({ StatusMessage: `Domain ${referer} is not allowed` }), { status: 403 }));
    const { body } = await test();
    expect(body.refusal).toEqual({ status: 403, message: 'Domain [id] is not allowed' });
  });

  // #3643: the real handshake is the connection. A probe the vendor answers with a
  // 5xx or a 429, or not at all, is "could not tell", never a failed test.
  it('still says connected when the wrong-id probe gets a 5xx, and says what the vendor answered', async () => {
    tokenBehaviour = (referer) => (referer === REFERENCE_ID ? accept() : new Response('bad gateway', { status: 502 }));
    const { response, body } = await test();
    expect(response.status).toBe(200);
    expect(body).toEqual({ connected: true, whitelisting: 'unknown', answer: { status: 502, message: '1099 e-filing authentication failed' } });
    expect(vendorCalls).toHaveLength(2);
  });

  it('still says connected when the wrong-id probe is rate-limited (429), with the vendor\'s own message', async () => {
    tokenBehaviour = (referer) => (referer === REFERENCE_ID ? accept()
      : new Response(JSON.stringify({ StatusMessage: `Too many requests from ${referer}` }), { status: 429 }));
    const { response, body } = await test();
    expect(response.status).toBe(200);
    expect(body).toEqual({ connected: true, whitelisting: 'unknown', answer: { status: 429, message: 'Too many requests from [id]' } });
    expect(JSON.stringify(body)).not.toContain(REFERENCE_ID);
  });

  it('still says connected when the wrong-id probe gets no answer at all', async () => {
    tokenBehaviour = (referer) => { if (referer === REFERENCE_ID) return accept(); throw new TypeError('network connection lost'); };
    const { response, body } = await test();
    expect(response.status).toBe(200);
    expect(body).toEqual({ connected: true, whitelisting: 'unknown', answer: { status: null, message: 'No answer from the vendor.' } });
  });

  it('keeps what it learned when only the letter-case probe cannot be read', async () => {
    tokenBehaviour = (referer) => {
      if (referer === REFERENCE_ID) return accept();
      if (referer === REFERENCE_ID.toUpperCase()) return new Response(JSON.stringify({ StatusMessage: 'Slow down' }), { status: 429 });
      return refuse();
    };
    const { response, body } = await test();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ connected: true, whitelisting: 'enforced', referenceIdCase: 'unknown', caseAnswer: { status: 429, message: 'Slow down' } });
    expect(body.refusal).toEqual({ status: 401, message: 'Unauthorized domain reference' });
  });

  it('fails the test, and makes no probe, when the real handshake itself fails', async () => {
    tokenBehaviour = () => new Response(JSON.stringify({ StatusMessage: 'Invalid credentials' }), { status: 401 });
    const { response, body } = await test();
    expect(response.status).toBe(502);
    expect(body.error).toBe('Invalid credentials');
    expect(vendorCalls).toHaveLength(1);
  });

  it('does not change a real call: it carries the configured id, not an override', async () => {
    tokenBehaviour = accept;
    env.TAX_1099_EFILING_DOMAIN_REFERENCE_ID = REFERENCE_ID;
    vendorCalls = [];
    await api('/tax/efiling-connection-test', adminSession());
    expect(vendorCalls[0].referer).toBe(REFERENCE_ID);
  });

  it('skips the probes when no id is configured', async () => {
    tokenBehaviour = accept;
    env.TAX_1099_EFILING_DOMAIN_REFERENCE_ID = undefined;
    vendorCalls = [];
    const { body } = await api('/tax/efiling-connection-test', adminSession());
    expect(body).toEqual({ connected: true });
    expect(vendorCalls).toHaveLength(1);
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
