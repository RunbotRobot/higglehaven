import { applyD1Migrations, env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder } from './test-helpers.js';
import { buildTax1099CreateBody } from './lib/seller-payouts-tax.js';

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
let transmitCallCount = 0;
// #3517: the order of vendor calls, the body of the last Transmit, and what the
// next Create/Transmit should do instead of succeeding.
let vendorCallOrder = [];
let lastTransmitRequestBody = null;
let nextCreateShouldFail = false;
let nextCreateReturnsErrors = false;
let nextTransmitStatus = null; // null = succeed; a string = answer with that FederalStatus
// #2939: the vendor payload itself, captured so a test can assert on the
// actual State/CountryCd values transmitted -- every other test in this
// file only cares that a call happened, not what was in it.
let lastCreateRequestBody = null;
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
    // #3517: API v2.0.0 -- Create only creates; a separate Transmit files it.
    if (/\/v2\.0\.0\/(Form1099NEC\/Create|form1099K\/create)$/i.test(url)) {
      createCallCount += 1;
      vendorCallOrder.push('create');
      lastCreateRequestBody = rest[0]?.body ? JSON.parse(rest[0].body) : null;
      if (nextCreateShouldFail) {
        nextCreateShouldFail = false;
        return new Response(JSON.stringify({ StatusMessage: 'simulated vendor failure' }), { status: 502 });
      }
      if (nextCreateReturnsErrors) {
        nextCreateReturnsErrors = false;
        return new Response(JSON.stringify({
          SubmissionId: `sub-${createCallCount}`,
          Form1099Records: { ErrorRecords: [{ Errors: [{ Id: 'E1', Name: 'Invalid', Message: 'simulated record validation error' }] }] },
        }), { status: 207 });
      }
      return new Response(JSON.stringify({ SubmissionId: `sub-${createCallCount}` }), { status: 200 });
    }
    if (/\/v2\.0\.0\/Form1099\/transmit$/i.test(url)) {
      transmitCallCount += 1;
      vendorCallOrder.push('transmit');
      lastTransmitRequestBody = rest[0]?.body ? JSON.parse(rest[0].body) : null;
      const status = nextTransmitStatus;
      nextTransmitStatus = null;
      if (status === 'FAIL') return new Response(JSON.stringify({ StatusMessage: 'simulated transmit failure' }), { status: 502 });
      return new Response(JSON.stringify({
        SubmissionId: lastTransmitRequestBody?.SubmissionId,
        Form1099Records: [{ FormType: 'Form1099NEC', RecordId: 'rec-1', FederalStatus: { Status: status ?? 'TRANSMITTED', Message: status ? `simulated status ${status}` : null } }],
      }), { status: 200 });
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

// #2939: formFields lets a caller override/replace the default w9 shape
// (e.g. a w8ben submission, or a spelled-out state/country) -- every
// pre-existing call site below passes nothing and keeps the original w9
// defaults unchanged.
async function approvedFormFor(label, formFields = {}) {
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
      ...formFields,
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
    const transmitsBefore = transmitCallCount;

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
    expect(transmitCallCount - transmitsBefore).toBe(1);
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

// #3517: API v2.0.0 files in two vendor calls. Create only creates a submission
// (nothing reaches the IRS); a separate Transmit files it. A form must only ever
// be called filed once Transmit says so, and a failure between the two must not
// lead to a second submission on retry.
describe('1099 e-filing is Create then Transmit (#3517)', () => {
  const nonTransmittingStatus = 'REJECTED';

  it('creates, stores the submission id, transmits that id, and only then calls the form filed', async () => {
    const formId = await approvedFormFor('tax-1099-v2-create-then-transmit');
    vendorCallOrder = [];

    const filed = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(filed.response.status).toBe(200);
    expect(vendorCallOrder).toEqual(['create', 'transmit']);
    const row = await env.DB.prepare('SELECT status, filing_reference, efiling_submission_id FROM tax_1099_forms WHERE form_id = ?').bind(formId).first();
    expect(row.status).toBe('filed');
    expect(row.efiling_submission_id).toBeTruthy();
    expect(row.filing_reference).toBe(row.efiling_submission_id);
    // Transmit is sent the submission id only (every record under it).
    expect(lastTransmitRequestBody).toEqual({ SubmissionId: row.efiling_submission_id });
  });

  it('after a failed Transmit the form returns to approved with its submission id kept, and the retry transmits that submission instead of creating a second', async () => {
    const formId = await approvedFormFor('tax-1099-v2-retry-no-second-create');
    vendorCallOrder = [];
    nextTransmitStatus = 'FAIL';

    const failed = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(failed.response.status).toBe(502);
    expect(vendorCallOrder).toEqual(['create', 'transmit']);
    const after = await env.DB.prepare('SELECT status, filing_reference, efiling_submission_id FROM tax_1099_forms WHERE form_id = ?').bind(formId).first();
    expect(after.status).toBe('approved');
    expect(after.efiling_submission_id).toBeTruthy(); // kept for the retry
    expect(after.filing_reference).toBeNull(); // not filed

    const createsBefore = createCallCount;
    vendorCallOrder = [];
    const retried = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(retried.response.status).toBe(200);
    expect(createCallCount).toBe(createsBefore); // no second submission
    expect(vendorCallOrder).toEqual(['transmit']);
    expect(lastTransmitRequestBody.SubmissionId).toBe(after.efiling_submission_id);
    const done = await env.DB.prepare('SELECT status, filing_reference FROM tax_1099_forms WHERE form_id = ?').bind(formId).first();
    expect(done.status).toBe('filed');
    expect(done.filing_reference).toBe(after.efiling_submission_id);
  });

  it('does not transmit, store a submission or call the form filed when Create reports a validation error', async () => {
    const formId = await approvedFormFor('tax-1099-v2-create-errors');
    vendorCallOrder = [];
    nextCreateReturnsErrors = true;

    const rejected = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(rejected.response.status).toBe(502);
    expect(rejected.body.error).toMatch(/simulated record validation error/);
    expect(vendorCallOrder).toEqual(['create']); // never reached Transmit
    const row = await env.DB.prepare('SELECT status, efiling_submission_id, filing_reference FROM tax_1099_forms WHERE form_id = ?').bind(formId).first();
    expect(row).toEqual({ status: 'approved', efiling_submission_id: null, filing_reference: null });
  });

  it('does not call the form filed when Transmit answers with a status that is not a transmission', async () => {
    const formId = await approvedFormFor('tax-1099-v2-transmit-not-transmitted');
    nextTransmitStatus = nonTransmittingStatus;

    const rejected = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(rejected.response.status).toBe(502);
    expect(rejected.body.error).toMatch(/simulated status REJECTED/);
    const row = await env.DB.prepare('SELECT status, filing_reference FROM tax_1099_forms WHERE form_id = ?').bind(formId).first();
    expect(row.status).toBe('approved');
    expect(row.filing_reference).toBeNull();
  });

  it('refuses a payee whose legal name cannot be split into a first and last name, before any vendor call', async () => {
    const formId = await approvedFormFor('tax-1099-v2-single-name', { legalName: 'Cher' });
    vendorCallOrder = [];

    const rejected = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/legal name/i);
    expect(vendorCallOrder).toEqual([]);
    const row = await env.DB.prepare('SELECT status FROM tax_1099_forms WHERE form_id = ?').bind(formId).first();
    expect(row.status).toBe('approved');
  });

  it('builds the v2.0.0 body for both forms: payer under the manifest, a Recipient, and the amount where that form keeps it', () => {
    const payeeTaxId = {
      formType: 'w9', legalName: 'Grace Brewster Hopper', addressLine1: '1 Compiler Lane', city: 'Arlington',
      state: 'VA', postalCode: '22201', taxIdNumber: '123-45-6789',
    };
    const base = { env: { TAX_1099_PAYER_NAME: 'Payer Co', TAX_1099_PAYER_EIN: '00-0000000' }, payeeTaxId, payeeEmail: 'grace@example.com' };
    const nec = buildTax1099CreateBody(base.env, { ...base, form: { form_type: '1099-nec', tax_year: 2026, gross_income_cents: 123456 } });
    expect(nec.SubmissionManifest).toEqual({
      TaxYear: '2026',
      IsFederal: true,
      ReturnHeader: { Business: { BusinessNm: 'Payer Co', TINDetails: { Format: 'PLAIN_TIN', TINType: 'EIN', TIN: '00-0000000' } } },
    });
    expect(nec.ReturnData[0].ReturnManifest).toEqual({ IsFederal: true });
    expect(nec.ReturnData[0].Recipient.IndividualNm).toEqual({ FirstNm: 'Grace Brewster', LastNm: 'Hopper' });
    expect(nec.ReturnData[0].Recipient.TINDetails).toEqual({ Format: 'PLAIN_TIN', TINType: 'SSN', TIN: '123-45-6789' });
    expect(nec.ReturnData[0].NECFormData).toEqual({ NEC: 1234.56 });
    expect(nec.ReturnData[0].KFormData).toBeUndefined();
    const kForm = buildTax1099CreateBody(base.env, { ...base, form: { form_type: '1099-k', tax_year: 2026, gross_income_cents: 2000000 } });
    expect(kForm.ReturnData[0].KFormData).toEqual({ GrossAmt: 20000 });
    expect(kForm.ReturnData[0].NECFormData).toBeUndefined();
  });
});

// #2939: transmitTax1099Form used to forward the payee's own free-text
// state/country form input straight into the vendor's real IRS-e-filing
// Address.State/Address.CountryCd fields -- 2-letter-code fields, not
// free text. These confirm the normalization fix actually lands in the
// real transmitted payload, not just that a call happens (the race tests
// above already cover that).
describe('1099 e-filing transmission country/state normalization (#2939)', () => {
  it('normalizes a spelled-out US state to its 2-letter code before e-filing a W-9 payee', async () => {
    const formId = await approvedFormFor('tax-1099-file-state-name', { state: 'California' });

    const filed = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(filed.response.status).toBe(200);
    expect(lastCreateRequestBody.ReturnData[0].Recipient.Address.ProvinceOrState).toBe('CA');
    expect(lastCreateRequestBody.ReturnData[0].Recipient.Address.Country).toBe('US');
  });

  // #2951: usStateNameToCode was originally written only for
  // getUserTaxJurisdiction's soft tax-education lookup (US states + DC
  // only, by its own old header comment) -- #2939 reused it for this
  // strict, fail-closed real filing without checking whether a real W-9
  // filer's address could fall outside that domain. A US-territory
  // resident (Puerto Rico, Guam, etc.) is a legitimate W-9 filer with no
  // state, and would have been permanently rejected here before #2951.
  it('normalizes a US territory name to its own 2-letter code before e-filing a W-9 payee', async () => {
    const formId = await approvedFormFor('tax-1099-file-territory-name', { state: 'Puerto Rico' });

    const filed = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(filed.response.status).toBe(200);
    expect(lastCreateRequestBody.ReturnData[0].Recipient.Address.ProvinceOrState).toBe('PR');
  });

  it('normalizes a spelled-out country to its 2-letter code before e-filing a W-8BEN payee', async () => {
    const formId = await approvedFormFor('tax-1099-file-country-name', {
      formType: 'w8ben', country: 'France', countryOfCitizenship: 'France', foreignTaxId: 'FR123456789',
      // w8ben has no state/postalCode/taxIdNumber fields (validateTaxIdForm's
      // own w8ben branch never collects them) -- clear the w9 defaults so
      // validateTaxIdForm doesn't see stray fields from an unrelated form type.
      state: undefined, postalCode: undefined, taxIdNumber: undefined,
    });

    const filed = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(filed.response.status).toBe(200);
    expect(lastCreateRequestBody.ReturnData[0].Recipient.Address.Country).toBe('FR');
    // #3517: a foreign payee has no US TIN field in v2.0.0 (an assumption to
    // check on the first Sandbox filing, see buildTax1099CreateBody's comment).
    expect(lastCreateRequestBody.ReturnData[0].Recipient.TINDetails).toEqual({ TINType: 'NA' });
  });

  it('rejects filing (without transmitting) when a W-9 state cannot be resolved to a valid code', async () => {
    const formId = await approvedFormFor('tax-1099-file-bad-state', { state: 'Atlantis' });
    const before = createCallCount;

    const rejected = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/state/i);
    // Never reached the vendor at all -- this is a local validation
    // failure, not the vendor rejecting a bad request.
    expect(createCallCount).toBe(before);

    const row = await env.DB.prepare('SELECT status FROM tax_1099_forms WHERE form_id = ?').bind(formId).first();
    expect(row.status).toBe('approved');
  });
});

// #2082: approve/file/void fired real outbound vendor calls (/file, via
// transmitTax1099Form on the shared TAX_1099_EFILING credentials) with no
// rate limit at all, unlike every other Stripe/vendor-calling handler in
// this file (handlePurchaseRefund etc.). Exercised via /void here --
// simplest of the three to set up 101 distinct attempts for (no vendor mock
// or approved-form precondition needed), but all three share one bucket
// key (`tax-1099-admin:${user.user_id}`) per the fix itself, so this
// covers the guard for all of them. 100, not this file's usual 20 --
// see TAX_1099_ADMIN_RATE_LIMIT_MAX's own comment in worker/index.js for
// why (reviewing 1099s is a real batch admin workflow, and 20 tripped on
// this exact file's own pre-existing e-filing test suite).
describe('admin-forms rate limit (#2082)', () => {
  it('rate-limits repeated admin-forms mutations (approve/file/void) from the same admin', async () => {
    const admin = await signupAdmin('tax-1099-admin-rate-limit-admin');
    const builder = await signupBuilder('tax-1099-admin-rate-limit-builder');
    // builderFromRow/publicBuilderFromRow (worker/index.js) both exclude
    // userId from the /builders/me response on purpose (#807) -- read it
    // straight from the users table by email instead, same idiom this
    // file's own concurrent-/file tests use for their own author lookups.
    const userRow = await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(builder.email).first();
    const userId = userRow.user_id;
    const formIds = Array.from({ length: 101 }, (_, i) => `tax-1099-admin-rate-limit-form-${i}`);
    // UNIQUE(user_id, tax_year, form_type) -- one real builder's user_id,
    // a distinct tax_year per row so the constraint doesn't collide.
    await env.DB.batch(formIds.map((formId, i) => env.DB.prepare(`
      INSERT INTO tax_1099_forms (form_id, user_id, tax_year, form_type, status, gross_income_cents, generated_at, updated_at)
      VALUES (?, ?, ?, '1099-nec', 'draft', 50000, datetime('now'), datetime('now'))
    `).bind(formId, userId, 2000 + i)));

    for (let i = 0; i < 100; i++) {
      const attempt = await api(`/tax/admin-forms/${formIds[i]}/void`, admin.session({ method: 'POST' }));
      expect(attempt.response.status).toBe(200);
    }
    const limited = await api(`/tax/admin-forms/${formIds[100]}/void`, admin.session({ method: 'POST' }));
    expect(limited.response.status).toBe(429);
  }, 60000);

  // #2130: GET /tax/admin-forms (re-)generates draft 1099s on every call --
  // the same "real DB cost" shape as the approve/file/void trio above, but
  // it had no guard at all. Shares their exact bucket key, so pre-seeding
  // it directly (same idiom as #1844's own GET /builders rate-limit test)
  // is cheaper than firing 100 real requests just to prove the shared
  // bucket actually covers this branch too.
  it('rate-limits GET /tax/admin-forms, sharing the admin-forms mutation bucket', async () => {
    const admin = await signupAdmin('tax-1099-admin-get-rate-limit-admin');
    const adminRow = await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(admin.email).first();
    const bucketKey = `tax-1099-admin:${adminRow.user_id}`;
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 100 }, () => env.DB.prepare(
      'INSERT INTO rate_limit_events (bucket_key, created_at) VALUES (?, ?)',
    ).bind(bucketKey, now)));

    const limited = await api(`/tax/admin-forms?year=${new Date().getUTCFullYear()}`, admin.session());
    expect(limited.response.status).toBe(429);
  });
});
