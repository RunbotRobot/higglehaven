import { applyD1Migrations, env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

// Own file (own D1/worker isolate — see test-helpers.js's own comment on why
// the suite is split by file) specifically so setting env.TAX_ID_ENCRYPTION_KEY
// here can't leak into commerce.test.js's own "Tax summary" describe block,
// which relies on it staying unset to exercise the 503-unconfigured path for
// this same feature (#614, sub-issue of #350).
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // 64 hex chars == 256 bits, the shape importTaxIdEncryptionKey expects.
  env.TAX_ID_ENCRYPTION_KEY = 'a'.repeat(64);
});

afterAll(() => {
  env.TAX_ID_ENCRYPTION_KEY = undefined;
});

describe('Tax-ID form (#614)', () => {
  it('requires a session', async () => {
    const got = await api('/tax/id-form', {
      method: 'POST',
      body: JSON.stringify({ formType: 'w9' }),
    });
    expect(got.response.status).toBe(401);
  });

  it('rejects a formType that is neither w9 nor w8ben', async () => {
    const builder = await signupBuilder('tax-id-form-bad-type');
    const got = await api('/tax/id-form', builder.session({
      method: 'POST',
      body: JSON.stringify({ formType: 'w4', legalName: 'Ada Lovelace' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/formType/);
  });

  it('accepts a W-9 submission and stores the sensitive fields encrypted, not as plaintext', async () => {
    const builder = await signupBuilder('tax-id-form-w9');
    const got = await api('/tax/id-form', builder.session({
      method: 'POST',
      body: JSON.stringify({
        formType: 'w9',
        legalName: 'Ada Lovelace',
        addressLine1: '1 Analytical Engine Way',
        city: 'London',
        state: 'LDN',
        postalCode: '00000',
        taxIdNumber: '123-45-6789',
      }),
    }));
    expect(got.response.status).toBe(200);
    expect(got.body.taxFormType).toBe('w9');
    expect(got.body.taxFormCompletedAt).toBeTruthy();

    // Fetch the row via the user_id /auth/me's own session resolves to,
    // rather than assuming builder.builderId doubles as user_id.
    const me = await api('/auth/me', builder.session());
    const userRow = await env.DB.prepare(
      'SELECT tax_form_type, tax_form_completed_at, tax_id_encrypted FROM users WHERE user_id = ?',
    ).bind(me.body.user.userId).first();
    expect(userRow.tax_form_type).toBe('w9');
    expect(userRow.tax_form_completed_at).toBeTruthy();
    expect(userRow.tax_id_encrypted).toMatch(/^aesgcm\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(userRow.tax_id_encrypted).not.toMatch(/123-45-6789/);
    expect(userRow.tax_id_encrypted).not.toMatch(/Analytical Engine/);
  });

  it('rejects a W-9 submission missing a US-specific field (taxIdNumber)', async () => {
    const builder = await signupBuilder('tax-id-form-w9-incomplete');
    const got = await api('/tax/id-form', builder.session({
      method: 'POST',
      body: JSON.stringify({
        formType: 'w9', legalName: 'Ada Lovelace', addressLine1: '1 Way', city: 'London', state: 'LDN', postalCode: '00000',
      }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/taxIdNumber/);
  });

  it('accepts a W-8BEN submission with its own required fields', async () => {
    const builder = await signupBuilder('tax-id-form-w8ben');
    const got = await api('/tax/id-form', builder.session({
      method: 'POST',
      body: JSON.stringify({
        formType: 'w8ben',
        legalName: 'Grace Hopper',
        addressLine1: '1 Compiler Lane',
        city: 'Arlington',
        country: 'USA',
        countryOfCitizenship: 'USA',
        foreignTaxId: 'FTIN-000',
      }),
    }));
    expect(got.response.status).toBe(200);
    expect(got.body.taxFormType).toBe('w8ben');
  });

  it('rejects a W-8BEN submission missing a non-US-specific field (countryOfCitizenship)', async () => {
    const builder = await signupBuilder('tax-id-form-w8ben-incomplete');
    const got = await api('/tax/id-form', builder.session({
      method: 'POST',
      body: JSON.stringify({
        formType: 'w8ben', legalName: 'Grace Hopper', addressLine1: '1 Compiler Lane', city: 'Arlington', country: 'USA', foreignTaxId: 'FTIN-000',
      }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/countryOfCitizenship/);
  });

  it('lets a later resubmission overwrite an earlier one outright', async () => {
    const builder = await signupBuilder('tax-id-form-resubmit');
    await api('/tax/id-form', builder.session({
      method: 'POST',
      body: JSON.stringify({
        formType: 'w8ben', legalName: 'Old Name', addressLine1: '1 Old Way', city: 'Old City', country: 'USA', countryOfCitizenship: 'USA', foreignTaxId: 'OLD-1',
      }),
    }));
    const resubmitted = await api('/tax/id-form', builder.session({
      method: 'POST',
      body: JSON.stringify({
        formType: 'w9', legalName: 'New Name', addressLine1: '1 New Way', city: 'New City', state: 'CA', postalCode: '90210', taxIdNumber: '999-99-9999',
      }),
    }));
    expect(resubmitted.response.status).toBe(200);
    expect(resubmitted.body.taxFormType).toBe('w9');

    const me = await api('/auth/me', builder.session());
    expect(me.body.user.taxFormType).toBe('w9');
  });

  it("exposes taxFormType/taxFormCompletedAt on the account view once submitted", async () => {
    const builder = await signupBuilder('tax-id-form-account-view');
    const before = await api('/auth/me', builder.session());
    expect(before.body.user.taxFormType).toBeNull();
    expect(before.body.user.taxFormCompletedAt).toBeNull();

    await api('/tax/id-form', builder.session({
      method: 'POST',
      body: JSON.stringify({
        formType: 'w9', legalName: 'Ada Lovelace', addressLine1: '1 Way', city: 'London', state: 'LDN', postalCode: '00000', taxIdNumber: '123-45-6789',
      }),
    }));

    const after = await api('/auth/me', builder.session());
    expect(after.body.user.taxFormType).toBe('w9');
    expect(after.body.user.taxFormCompletedAt).toBeTruthy();
  });
});
