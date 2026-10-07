import { applyD1Migrations, env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder } from './test-helpers.js';

// Own file (own D1/worker isolate — same reasoning as worker/tax-id-form
// .test.js's own comment): setting TAX_ID_ENCRYPTION_KEY/TAX_1099_EFILING_*
// here can't leak into worker/commerce.test.js's own "1099 e-filing
// transmission (#646)" describe block, which relies on these staying unset
// to exercise its own "not configured" 503 paths for the same routes.
//
// #1410: POST /tax/admin-forms/:formId/file called the real e-filing
// vendor (transmitTax1099Form) BEFORE its own atomic status='approved'
// claim, so two concurrent /file requests on the same form could both pass
// the pre-check and both transmit -- two distinct real federal filings for
// one form. The fix claims the row (status -> 'filing') before the
// transmission and only lets the winner actually call the vendor. Since
// this suite can't reach a real TaxBandits sandbox, the vendor's own
// OAuth token endpoint and Create endpoint are mocked via a temporary
// globalThis.fetch override (same idiom worker/reviews-auth.test.js's own
// "still returns a session when the verification email's fetch rejects
// outright" test already uses for a different external vendor).
let adminSession;
let createCallCount = 0;
let nextCreateShouldFail = false;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('tax-1099-file-race-admin');
  adminSession = admin.session;

  env.TAX_ID_ENCRYPTION_KEY = 'a'.repeat(64);
  env.TAX_1099_EFILING_CLIENT_ID = 'test-client-id';
  env.TAX_1099_EFILING_CLIENT_SECRET = 'test-client-secret';
  env.TAX_1099_EFILING_USER_TOKEN = 'test-user-token';
  env.TAX_1099_PAYER_NAME = 'Higglehaven Test Payer';
  env.TAX_1099_PAYER_EIN = '00-0000000';

  globalThis.fetch = async (input, ...rest) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('tbsauth')) {
      return new Response(JSON.stringify({ AccessToken: 'test-access-token' }), { status: 200 });
    }
    if (url.includes('/Form1099NEC/Create') || url.includes('/Form1099K/Create')) {
      createCallCount += 1;
      if (nextCreateShouldFail) {
        nextCreateShouldFail = false;
        return new Response(JSON.stringify({ StatusMessage: 'simulated vendor failure' }), { status: 502 });
      }
      return new Response(JSON.stringify({ SubmissionId: `sub-${createCallCount}` }), { status: 200 });
    }
    return originalFetch(input, ...rest);
  };
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  env.TAX_ID_ENCRYPTION_KEY = undefined;
  env.TAX_1099_EFILING_CLIENT_ID = undefined;
  env.TAX_1099_EFILING_CLIENT_SECRET = undefined;
  env.TAX_1099_EFILING_USER_TOKEN = undefined;
  env.TAX_1099_PAYER_NAME = undefined;
  env.TAX_1099_PAYER_EIN = undefined;
});

async function approvedFormFor(label) {
  const builder = await signupBuilder(label);
  const builderMe = await api('/builders/me', builder.session());
  // A real submission through /tax/id-form, not a faked tax_id_encrypted
  // column -- this suite actually configures TAX_ID_ENCRYPTION_KEY and
  // reaches decryptTaxIdPayload for real (unlike commerce.test.js's own
  // orphaned-approved-form test, which never configures it and so never
  // decrypts the placeholder value it writes directly).
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
  const year = new Date().getUTCFullYear();
  const listed = await api(`/tax/admin-forms?year=${year}`, adminSession());
  const form = listed.body.forms.find((f) => f.email === builder.email);
  const approved = await api(`/tax/admin-forms/${form.formId}/approve`, adminSession({ method: 'POST' }));
  expect(approved.response.status).toBe(200);
  return form.formId;
}

describe('1099 e-filing transmission race (#1410)', () => {
  it('transmits to the e-filing vendor exactly once even when two /file requests race', async () => {
    const formId = await approvedFormFor('tax-1099-file-race-concurrent');
    const before = createCallCount;

    // Fired together, not awaited one at a time -- same genuinely-concurrent
    // pattern worker/commerce.test.js's own concurrent-approve/concurrent-void
    // races already use to reproduce this exact class of bug.
    const [first, second] = await Promise.all([
      api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' })),
      api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' })),
    ]);
    const statuses = [first.response.status, second.response.status].sort();
    console.log('Concurrent /file request statuses (should be [200, 409]):', statuses);
    console.log('Vendor Create calls made for this one form (should be 1, not 2 -- was the #1410 bug):', createCallCount - before);

    const row = await env.DB.prepare('SELECT status, filing_reference FROM tax_1099_forms WHERE form_id = ?').bind(formId).first();
    console.log('Final row status (should be filed, not stuck in filing):', row.status);

    expect(statuses).toEqual([200, 409]);
    expect(createCallCount - before).toBe(1);
    expect(row.status).toBe('filed');
    expect(row.filing_reference).toBeTruthy();
  });

  it('releases the claim back to approved if the vendor transmission fails, so a retry can still succeed', async () => {
    const formId = await approvedFormFor('tax-1099-file-race-retry');
    nextCreateShouldFail = true;

    const failed = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(failed.response.status).toBe(502);

    const afterFailure = await env.DB.prepare('SELECT status FROM tax_1099_forms WHERE form_id = ?').bind(formId).first();
    console.log('Status right after a failed transmission (should be approved again, not stuck in filing):', afterFailure.status);
    expect(afterFailure.status).toBe('approved');

    const retried = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(retried.response.status).toBe(200);
    expect(retried.body.status).toBe('filed');
  });
});
