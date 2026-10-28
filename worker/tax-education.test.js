// #2842 (sub-issue of #2841, docs/SPEC.md §7): jurisdiction-keyed tax
// education content storage + admin-editable UI. Surfacing to builders
// (#2843) and content authorship/review process (#2844, owner judgment)
// are separate sub-issues — these tests only cover this issue's own
// scope: admin CRUD + the reviewed_at/reviewed_by gate.
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder } from './test-helpers.js';

let adminSession;
let adminEmail;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('tax-education-admin');
  adminSession = admin.session;
  adminEmail = admin.email;
  // #2843: GET /tax-education/mine resolves jurisdiction from a caller's
  // own on-file W-9/W-8BEN, which needs this configured the same way
  // tax-id-form.test.js's own beforeAll does (own D1 isolate per test
  // file, so this can't leak into any other file's own tests).
  env.TAX_ID_ENCRYPTION_KEY = 'a'.repeat(64);
});

afterAll(() => {
  env.TAX_ID_ENCRYPTION_KEY = undefined;
});

async function createEntry(overrides = {}) {
  const { response, body } = await api('/tax-education', adminSession({
    method: 'POST',
    body: JSON.stringify({ countryCode: 'US', title: 'US federal basics', body: 'General info, not advice.', ...overrides }),
  }));
  expect(response.status).toBe(201);
  return body.entry;
}

describe('Tax education content admin API (#2842)', () => {
  it('rejects every route for a non-admin session', async () => {
    const builder = await signupBuilder('tax-education-nonadmin');
    const list = await api('/tax-education', builder.session());
    expect(list.response.status).toBe(403);
    const create = await api('/tax-education', builder.session({
      method: 'POST', body: JSON.stringify({ countryCode: 'US', title: 'x', body: 'y' }),
    }));
    expect(create.response.status).toBe(403);
  });

  it('rejects every route for an unauthenticated caller', async () => {
    const got = await api('/tax-education');
    expect(got.response.status).toBe(401);
  });

  it('creates an entry with countryCode, title, and body', async () => {
    const entry = await createEntry();
    expect(entry).toMatchObject({
      countryCode: 'US', stateCode: null, title: 'US federal basics', body: 'General info, not advice.', reviewed: false,
    });
    expect(entry.id).toMatch(/^tax-edu-/);
    expect(entry.reviewedAt).toBeNull();
    expect(entry.reviewedBy).toBeNull();
  });

  it('normalizes a lowercase countryCode to uppercase', async () => {
    const entry = await createEntry({ countryCode: 'gb' });
    expect(entry.countryCode).toBe('GB');
  });

  it('rejects a countryCode that is not 2 letters', async () => {
    const got = await api('/tax-education', adminSession({
      method: 'POST', body: JSON.stringify({ countryCode: 'USA', title: 'x', body: 'y' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/countryCode/i);
  });

  it('accepts an optional stateCode', async () => {
    const entry = await createEntry({ countryCode: 'US', stateCode: 'ca', title: 'California specifics' });
    expect(entry.stateCode).toBe('CA');
  });

  it('rejects a title or body that is missing', async () => {
    const noTitle = await api('/tax-education', adminSession({
      method: 'POST', body: JSON.stringify({ countryCode: 'US', body: 'y' }),
    }));
    expect(noTitle.response.status).toBe(400);
    const noBody = await api('/tax-education', adminSession({
      method: 'POST', body: JSON.stringify({ countryCode: 'US', title: 'x' }),
    }));
    expect(noBody.response.status).toBe(400);
  });

  it('gets a single entry by id', async () => {
    const entry = await createEntry();
    const got = await api(`/tax-education/${entry.id}`, adminSession());
    expect(got.response.status).toBe(200);
    expect(got.body.entry).toMatchObject({ id: entry.id, title: 'US federal basics' });
  });

  it('404s getting a nonexistent id', async () => {
    const got = await api('/tax-education/tax-edu-does-not-exist', adminSession());
    expect(got.response.status).toBe(404);
  });

  it('lists entries, optionally filtered by countryCode', async () => {
    await createEntry({ countryCode: 'US', title: 'US entry' });
    await createEntry({ countryCode: 'GB', title: 'GB entry' });
    const all = await api('/tax-education', adminSession());
    expect(all.body.entries.length).toBeGreaterThanOrEqual(2);
    const usOnly = await api('/tax-education?countryCode=us', adminSession());
    expect(usOnly.body.entries.every((entry) => entry.countryCode === 'US')).toBe(true);
    expect(usOnly.body.entries.some((entry) => entry.title === 'US entry')).toBe(true);
  });

  it('updates title/body/stateCode via PATCH', async () => {
    const entry = await createEntry();
    const updated = await api(`/tax-education/${entry.id}`, adminSession({
      method: 'PATCH', body: JSON.stringify({ title: 'Updated title', stateCode: 'NY' }),
    }));
    expect(updated.response.status).toBe(200);
    expect(updated.body.entry).toMatchObject({ title: 'Updated title', stateCode: 'NY', body: entry.body });
  });

  it('marking reviewed stamps reviewedAt/reviewedBy from the calling admin, never a client-supplied value', async () => {
    const entry = await createEntry();
    const reviewed = await api(`/tax-education/${entry.id}`, adminSession({
      // #2842: reviewedBy is deliberately not an accepted input field at
      // all -- only `reviewed: true/false` is -- so passing one here
      // proves the server ignores it rather than trusting it.
      method: 'PATCH', body: JSON.stringify({ reviewed: true, reviewedBy: 'someone-else@example.com' }),
    }));
    expect(reviewed.response.status).toBe(200);
    expect(reviewed.body.entry.reviewed).toBe(true);
    expect(reviewed.body.entry.reviewedBy).toBe(adminEmail);
    expect(reviewed.body.entry.reviewedAt).not.toBeNull();
  });

  it('un-reviewing clears both reviewedAt and reviewedBy', async () => {
    const entry = await createEntry();
    await api(`/tax-education/${entry.id}`, adminSession({ method: 'PATCH', body: JSON.stringify({ reviewed: true }) }));
    const unreviewed = await api(`/tax-education/${entry.id}`, adminSession({
      method: 'PATCH', body: JSON.stringify({ reviewed: false }),
    }));
    expect(unreviewed.body.entry.reviewed).toBe(false);
    expect(unreviewed.body.entry.reviewedAt).toBeNull();
    expect(unreviewed.body.entry.reviewedBy).toBeNull();
  });

  it('404s PATCHing a nonexistent id', async () => {
    const got = await api('/tax-education/tax-edu-does-not-exist', adminSession({
      method: 'PATCH', body: JSON.stringify({ title: 'x' }),
    }));
    expect(got.response.status).toBe(404);
  });

  it('deletes an entry', async () => {
    const entry = await createEntry();
    const deleted = await api(`/tax-education/${entry.id}`, adminSession({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    const got = await api(`/tax-education/${entry.id}`, adminSession());
    expect(got.response.status).toBe(404);
  });

  it('404s deleting a nonexistent id', async () => {
    const got = await api('/tax-education/tax-edu-does-not-exist', adminSession({ method: 'DELETE' }));
    expect(got.response.status).toBe(404);
  });
});

async function submitW9(builderSession, state) {
  const got = await api('/tax/id-form', builderSession({
    method: 'POST',
    body: JSON.stringify({
      formType: 'w9', legalName: 'Ada Lovelace', addressLine1: '1 Way', city: 'Somewhere',
      state, postalCode: '00000', taxIdNumber: '123-45-6789',
    }),
  }));
  expect(got.response.status).toBe(200);
}

async function submitW8ben(builderSession, country) {
  const got = await api('/tax/id-form', builderSession({
    method: 'POST',
    body: JSON.stringify({
      formType: 'w8ben', legalName: 'Grace Hopper', addressLine1: '1 Way', city: 'Somewhere',
      country, countryOfCitizenship: country, foreignTaxId: 'FTIN-000',
    }),
  }));
  expect(got.response.status).toBe(200);
}

// #2843: surfaces #2842's own reviewed content to a caller, matched
// against the jurisdiction resolved from THEIR OWN already-on-file W-9/
// W-8BEN (getUserTaxJurisdiction, worker/lib/seller-payouts-tax.js) --
// never a new location-collection step.
describe('GET /tax-education/mine (#2843)', () => {
  it('requires a session', async () => {
    const got = await api('/tax-education/mine');
    expect(got.response.status).toBe(401);
  });

  it('returns no entries and a null jurisdiction when no tax form is on file', async () => {
    const builder = await signupBuilder('tax-education-mine-no-form');
    const got = await api('/tax-education/mine', builder.session());
    expect(got.response.status).toBe(200);
    expect(got.body).toEqual({ entries: [], jurisdiction: null });
  });

  it('matches a reviewed country-wide entry from a W-9 filer (country resolves to US)', async () => {
    const builder = await signupBuilder('tax-education-mine-w9-us');
    await submitW9(builder.session, 'TX');
    const entry = await createEntry({ countryCode: 'US', title: 'US general info' });
    await api(`/tax-education/${entry.id}`, adminSession({ method: 'PATCH', body: JSON.stringify({ reviewed: true }) }));

    const got = await api('/tax-education/mine', builder.session());
    expect(got.body.jurisdiction).toEqual({ country: 'US', state: 'TX' });
    expect(got.body.entries.some((e) => e.id === entry.id)).toBe(true);
    // Public shape only -- no admin-authoring metadata.
    expect(got.body.entries[0]).toEqual({ id: expect.any(String), countryCode: expect.any(String), stateCode: null, title: expect.any(String), body: expect.any(String) });
  });

  it('excludes an unreviewed entry', async () => {
    const builder = await signupBuilder('tax-education-mine-unreviewed');
    await submitW9(builder.session, 'TX');
    const entry = await createEntry({ countryCode: 'US', title: 'Not yet reviewed' });

    const got = await api('/tax-education/mine', builder.session());
    expect(got.body.entries.some((e) => e.id === entry.id)).toBe(false);
  });

  it('matches a state-specific entry for a filer in that state, and still includes a country-wide one', async () => {
    const builder = await signupBuilder('tax-education-mine-w9-state');
    await submitW9(builder.session, 'California');

    const stateEntry = await createEntry({ countryCode: 'US', stateCode: 'CA', title: 'California specifics' });
    await api(`/tax-education/${stateEntry.id}`, adminSession({ method: 'PATCH', body: JSON.stringify({ reviewed: true }) }));
    const countryEntry = await createEntry({ countryCode: 'US', title: 'US general' });
    await api(`/tax-education/${countryEntry.id}`, adminSession({ method: 'PATCH', body: JSON.stringify({ reviewed: true }) }));

    const got = await api('/tax-education/mine', builder.session());
    expect(got.body.jurisdiction).toEqual({ country: 'US', state: 'CA' });
    const ids = got.body.entries.map((e) => e.id);
    expect(ids).toContain(stateEntry.id);
    expect(ids).toContain(countryEntry.id);
    // State-specific sorts first.
    expect(ids.indexOf(stateEntry.id)).toBeLessThan(ids.indexOf(countryEntry.id));
  });

  it('does not match a different state\'s own state-specific entry', async () => {
    const builder = await signupBuilder('tax-education-mine-w9-other-state');
    await submitW9(builder.session, 'NY');
    const nyOnlyEntry = await createEntry({ countryCode: 'US', stateCode: 'CA', title: 'California only' });
    await api(`/tax-education/${nyOnlyEntry.id}`, adminSession({ method: 'PATCH', body: JSON.stringify({ reviewed: true }) }));

    const got = await api('/tax-education/mine', builder.session());
    expect(got.body.entries.some((e) => e.id === nyOnlyEntry.id)).toBe(false);
  });

  it('resolves a W-8BEN free-text country name to a jurisdiction match', async () => {
    const builder = await signupBuilder('tax-education-mine-w8ben-france');
    await submitW8ben(builder.session, 'France');
    const entry = await createEntry({ countryCode: 'FR', title: 'France general info' });
    await api(`/tax-education/${entry.id}`, adminSession({ method: 'PATCH', body: JSON.stringify({ reviewed: true }) }));

    const got = await api('/tax-education/mine', builder.session());
    expect(got.body.jurisdiction).toEqual({ country: 'FR', state: null });
    expect(got.body.entries.some((e) => e.id === entry.id)).toBe(true);
  });

  it('returns a null jurisdiction for a W-8BEN free-text country name it does not recognize', async () => {
    const builder = await signupBuilder('tax-education-mine-w8ben-unknown');
    await submitW8ben(builder.session, 'Not A Real Country Name');
    const got = await api('/tax-education/mine', builder.session());
    expect(got.body).toEqual({ entries: [], jurisdiction: null });
  });
});
