// #1407 (sub-issue of #1404, gated on #1405/#1406/#1065 all landing
// first): the AI-made Stripe-reinstatement decision flow -- every branch
// of the owner's own rubric (#1406), plus the admin-recorded-flag premise
// it evaluates against. Stripe is never configured in this suite (same
// convention as worker/stripe-connect.test.js) -- the actual reset
// mechanics (clearing stripe_account_id) are exercised directly against
// the DB rows this flow writes, not through a live Stripe round trip.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder, signupSeller } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('stripe-reinstatement-admin');
  adminSession = admin.session;
});

async function userIdFor(email) {
  const row = await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(email).first();
  return row.user_id;
}

// Inserts a flag directly (bypassing the admin endpoint) so a test can
// control its own flagged_at timestamp precisely, for the cooling-off
// tests below -- the real POST endpoint is covered by its own describe
// block first.
async function insertFlag(subjectType, subjectId, { disposition = 'suspected', flaggedAt = new Date().toISOString() } = {}) {
  const flagId = `test-flag-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO stripe_account_flags (flag_id, subject_type, subject_id, disposition, reason, flagged_by, flagged_at)
    VALUES (?, ?, ?, ?, 'test flag', ?, ?)
  `).bind(flagId, subjectType, subjectId, disposition, adminSession ? 'test-admin' : 'test-admin', flaggedAt).run();
  return flagId;
}

async function insertApprovedDiditSession(userId, createdAt) {
  await env.DB.prepare(`
    INSERT INTO didit_verification_sessions (session_id, user_id, status, created_at, processed_at)
    VALUES (?, ?, 'approved', ?, ?)
  `).bind(`test-didit-${crypto.randomUUID()}`, userId, createdAt, createdAt).run();
}

const NINETY_ONE_DAYS_AGO = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

describe('Stripe account flag (#1407)', () => {
  it('requires admin, 404s on an unknown id, and validates disposition/reason', async () => {
    const seller = await signupSeller('stripe-flag-guards-seller');

    const unauth = await api(`/sellers/${seller.sellerId}/stripe-account-flag`, {
      method: 'POST', body: JSON.stringify({ disposition: 'suspected', reason: 'test' }),
    });
    expect(unauth.response.status).toBe(401);

    const nonAdmin = await api(`/sellers/${seller.sellerId}/stripe-account-flag`, seller.session({
      method: 'POST', body: JSON.stringify({ disposition: 'suspected', reason: 'test' }),
    }));
    expect(nonAdmin.response.status).toBe(403);

    const missing = await api('/sellers/does-not-exist/stripe-account-flag', adminSession({
      method: 'POST', body: JSON.stringify({ disposition: 'suspected', reason: 'test' }),
    }));
    expect(missing.response.status).toBe(404);

    const badDisposition = await api(`/sellers/${seller.sellerId}/stripe-account-flag`, adminSession({
      method: 'POST', body: JSON.stringify({ disposition: 'not-a-real-value', reason: 'test' }),
    }));
    expect(badDisposition.response.status).toBe(400);

    const missingReason = await api(`/sellers/${seller.sellerId}/stripe-account-flag`, adminSession({
      method: 'POST', body: JSON.stringify({ disposition: 'suspected', reason: '' }),
    }));
    expect(missingReason.response.status).toBe(400);

    const tooLongReason = await api(`/sellers/${seller.sellerId}/stripe-account-flag`, adminSession({
      method: 'POST', body: JSON.stringify({ disposition: 'suspected', reason: 'x'.repeat(281) }),
    }));
    expect(tooLongReason.response.status).toBe(400);
  });

  it('records a flag for a seller and a builder, capturing the current stripe_account_id', async () => {
    const seller = await signupSeller('stripe-flag-seller');
    await env.DB.prepare("UPDATE sellers SET stripe_account_id = 'acct_flagged_seller' WHERE seller_id = ?")
      .bind(seller.sellerId).run();

    const flagged = await api(`/sellers/${seller.sellerId}/stripe-account-flag`, adminSession({
      method: 'POST', body: JSON.stringify({ disposition: 'suspected', reason: 'risk signals on this account' }),
    }));
    expect(flagged.response.status).toBe(201);
    expect(flagged.body).toMatchObject({ subjectType: 'seller', subjectId: seller.sellerId, disposition: 'suspected' });

    const row = await env.DB.prepare('SELECT * FROM stripe_account_flags WHERE flag_id = ?').bind(flagged.body.flagId).first();
    expect(row.stripe_account_id_at_flag_time).toBe('acct_flagged_seller');
    expect(row.flagged_by).toBe((await api('/auth/me', adminSession())).body.user.userId);

    const builder = await signupBuilder('stripe-flag-builder');
    const flaggedBuilder = await api(`/builders/${builder.builderId}/stripe-account-flag`, adminSession({
      method: 'POST', body: JSON.stringify({ disposition: 'confirmed_fraud', reason: 'chargeback confirmed' }),
    }));
    expect(flaggedBuilder.response.status).toBe(201);
    expect(flaggedBuilder.body.subjectType).toBe('builder');
  });

  it('rate-limits repeated flag attempts from the same admin', async () => {
    const admin = await signupAdmin('stripe-flag-rate-limit-admin');
    const seller = await signupSeller('stripe-flag-rate-limit-seller');
    for (let i = 0; i < 20; i++) {
      const attempt = await api(`/sellers/${seller.sellerId}/stripe-account-flag`, admin.session({
        method: 'POST', body: JSON.stringify({ disposition: 'suspected', reason: `attempt ${i}` }),
      }));
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api(`/sellers/${seller.sellerId}/stripe-account-flag`, admin.session({
      method: 'POST', body: JSON.stringify({ disposition: 'suspected', reason: 'one too many' }),
    }));
    expect(limited.response.status).toBe(429);
  }, 30000);
});

describe('Stripe reinstatement request (#1407)', () => {
  it('requires a session', async () => {
    const got = await api('/sellers/me/stripe-reinstatement-request', { method: 'POST' });
    expect(got.response.status).toBe(401);
  });

  it('409s when no flag is on record for this account', async () => {
    const seller = await signupSeller('stripe-reinstate-no-flag');
    const result = await api('/sellers/me/stripe-reinstatement-request', seller.session({ method: 'POST' }));
    expect(result.response.status).toBe(409);
  });

  it('denies permanently when confirmed fraud is on record, regardless of elapsed time', async () => {
    const seller = await signupSeller('stripe-reinstate-confirmed-fraud');
    await insertFlag('seller', seller.sellerId, { disposition: 'confirmed_fraud', flaggedAt: NINETY_ONE_DAYS_AGO });

    const result = await api('/sellers/me/stripe-reinstatement-request', seller.session({ method: 'POST' }));
    expect(result.response.status).toBe(200);
    expect(result.body.outcome).toBe('denied');
    // Reasoning stays server-side only -- the response body never leaks it.
    expect(result.body.reasoning).toBeUndefined();

    const decision = await env.DB.prepare(
      "SELECT * FROM account_moderation_decisions WHERE decision_type = 'stripe_reinstatement' AND subject_ref = ?",
    ).bind(`seller:${seller.sellerId}`).first();
    expect(decision.outcome).toBe('denied');
    expect(decision.decided_by).toBe('ai:stripe-reinstatement-flow');
    expect(decision.rubric_version).toBe('1406-v1');
    expect(decision.reasoning).toMatch(/confirmed fraud/i);
  });

  it('denies when the 90-day cooling-off period has not yet elapsed', async () => {
    const seller = await signupSeller('stripe-reinstate-cooling-off');
    await insertFlag('seller', seller.sellerId, { disposition: 'suspected', flaggedAt: THIRTY_DAYS_AGO });

    const result = await api('/sellers/me/stripe-reinstatement-request', seller.session({ method: 'POST' }));
    expect(result.body.outcome).toBe('denied');

    const decision = await env.DB.prepare(
      "SELECT * FROM account_moderation_decisions WHERE decision_type = 'stripe_reinstatement' AND subject_ref = ?",
    ).bind(`seller:${seller.sellerId}`).first();
    expect(decision.reasoning).toMatch(/cooling-off/i);
  });

  it('escalates (never denies outright) when cooling-off has elapsed but no fresh Didit re-verification is on record', async () => {
    const seller = await signupSeller('stripe-reinstate-no-reverify');
    await insertFlag('seller', seller.sellerId, { disposition: 'suspected', flaggedAt: NINETY_ONE_DAYS_AGO });

    const result = await api('/sellers/me/stripe-reinstatement-request', seller.session({ method: 'POST' }));
    expect(result.body.outcome).toBe('escalated');

    const decision = await env.DB.prepare(
      "SELECT * FROM account_moderation_decisions WHERE decision_type = 'stripe_reinstatement' AND subject_ref = ?",
    ).bind(`seller:${seller.sellerId}`).first();
    expect(decision.reasoning).toMatch(/fresh/i);
  });

  it('does not count a Didit session approved BEFORE the flag as "fresh"', async () => {
    const seller = await signupSeller('stripe-reinstate-stale-reverify');
    const userId = await userIdFor(seller.email);
    // Approved well before the flag -- already on file when the account was
    // restricted, so it proves nothing changed since then.
    await insertApprovedDiditSession(userId, new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString());
    await insertFlag('seller', seller.sellerId, { disposition: 'suspected', flaggedAt: NINETY_ONE_DAYS_AGO });

    const result = await api('/sellers/me/stripe-reinstatement-request', seller.session({ method: 'POST' }));
    expect(result.body.outcome).toBe('escalated');
  });

  it('approves, resets stripe_account_id, and logs the decision once every gate is satisfied', async () => {
    const seller = await signupSeller('stripe-reinstate-approved');
    const userId = await userIdFor(seller.email);
    await env.DB.prepare("UPDATE sellers SET stripe_account_id = 'acct_dead_reinstate', stripe_onboarding_status = 'action_needed' WHERE seller_id = ?")
      .bind(seller.sellerId).run();
    await insertFlag('seller', seller.sellerId, { disposition: 'suspected', flaggedAt: NINETY_ONE_DAYS_AGO });
    // Approved after the flag -- genuinely fresh.
    await insertApprovedDiditSession(userId, THIRTY_DAYS_AGO);

    const result = await api('/sellers/me/stripe-reinstatement-request', seller.session({ method: 'POST' }));
    expect(result.response.status).toBe(200);
    expect(result.body.outcome).toBe('approved');
    expect(result.body.stripeAccount).toMatchObject({ connected: false, status: 'not_started' });

    const row = await env.DB.prepare('SELECT stripe_account_id, stripe_onboarding_status FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(row.stripe_account_id).toBeNull();
    expect(row.stripe_onboarding_status).toBe('not_started');

    const decision = await env.DB.prepare(
      "SELECT * FROM account_moderation_decisions WHERE decision_type = 'stripe_reinstatement' AND subject_ref = ?",
    ).bind(`seller:${seller.sellerId}`).first();
    expect(decision.outcome).toBe('approved');

    // A fresh onboarding submission now takes the "create" branch (503
    // before ever reaching unconfigured Stripe), same proof-of-reset shape
    // worker/stripe-connect.test.js's own reset tests use.
    const resubmit = await api('/sellers/me/stripe-account', seller.session({
      method: 'POST',
      body: JSON.stringify({
        individual: {
          firstName: 'Ada', lastName: 'Seller', dobDay: 12, dobMonth: 6, dobYear: 1990, ssnLast4: '1234',
          addressLine1: '123 Main St', addressCity: 'Seattle', addressState: 'WA', addressPostalCode: '98101', addressCountry: 'US',
        },
        externalAccount: { routingNumber: '110000000', accountNumber: '000123456789', currency: 'usd' },
      }),
    }));
    expect(resubmit.response.status).toBe(503);
  });

  // #2740: performReinstatementReset's own WHERE re-asserts stripe_account_id
  // at UPDATE time, same concurrency guard as the sibling admin
  // stripe-account-reset endpoint's own #1414 fix -- this used to never
  // check that guard's result, so a stripe_account_id that changed between
  // this handler's own read and its UPDATE silently no-op'd the reset while
  // still reporting success. Same db.prepare monkey-patch idiom
  // worker/stripe-connect.test.js's own #1414 race tests use.
  it('rejects (409) rather than silently no-op-ing when stripe_account_id changed concurrently between the read and the reset', async () => {
    const seller = await signupSeller('stripe-reinstate-race');
    const userId = await userIdFor(seller.email);
    await env.DB.prepare("UPDATE sellers SET stripe_account_id = 'acct_dead_reinstate_race', stripe_onboarding_status = 'action_needed' WHERE seller_id = ?")
      .bind(seller.sellerId).run();
    await insertFlag('seller', seller.sellerId, { disposition: 'suspected', flaggedAt: NINETY_ONE_DAYS_AGO });
    await insertApprovedDiditSession(userId, THIRTY_DAYS_AGO);

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('UPDATE sellers') && sql.includes('stripe_account_id = NULL')) {
        armed = false;
        originalPrepare(`
          UPDATE sellers SET stripe_account_id = 'acct_new_seller_reinstate_race', stripe_onboarding_status = 'complete' WHERE seller_id = ?
        `).bind(seller.sellerId).run();
      }
      return originalPrepare(sql);
    };
    let rejected;
    try {
      rejected = await api('/sellers/me/stripe-reinstatement-request', seller.session({ method: 'POST' }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.error).toMatch(/changed concurrently/);

    // The race's winning write (the "already reconnected a real account in
    // the meantime" simulation) must survive untouched -- not silently
    // overwritten by the stale reset this handler must now refuse to apply.
    const row = await env.DB.prepare('SELECT stripe_account_id, stripe_onboarding_status FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(row.stripe_account_id).toBe('acct_new_seller_reinstate_race');
    expect(row.stripe_onboarding_status).toBe('complete');
  });

  it('works identically for a builder subject, logging subject_builder_id', async () => {
    const builder = await signupBuilder('stripe-reinstate-builder-approved');
    const userId = await userIdFor(builder.email);
    await env.DB.prepare("UPDATE builders SET stripe_account_id = 'acct_dead_reinstate_builder' WHERE builder_id = ?")
      .bind(builder.builderId).run();
    await insertFlag('builder', builder.builderId, { disposition: 'suspected', flaggedAt: NINETY_ONE_DAYS_AGO });
    await insertApprovedDiditSession(userId, THIRTY_DAYS_AGO);

    const result = await api('/builders/me/stripe-reinstatement-request', builder.session({ method: 'POST' }));
    expect(result.body.outcome).toBe('approved');

    const decision = await env.DB.prepare(
      "SELECT * FROM account_moderation_decisions WHERE decision_type = 'stripe_reinstatement' AND subject_ref = ?",
    ).bind(`builder:${builder.builderId}`).first();
    expect(decision.subject_builder_id).toBe(builder.builderId);
  });

  it('permanently denies on a 3rd flag even though every individual flag was only "suspected"', async () => {
    const seller = await signupSeller('stripe-reinstate-third-flag');
    const userId = await userIdFor(seller.email);
    await insertFlag('seller', seller.sellerId, { disposition: 'suspected', flaggedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString() });
    await insertFlag('seller', seller.sellerId, { disposition: 'suspected', flaggedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString() });
    await insertFlag('seller', seller.sellerId, { disposition: 'suspected', flaggedAt: NINETY_ONE_DAYS_AGO });
    await insertApprovedDiditSession(userId, THIRTY_DAYS_AGO);

    const result = await api('/sellers/me/stripe-reinstatement-request', seller.session({ method: 'POST' }));
    expect(result.body.outcome).toBe('denied');

    const decision = await env.DB.prepare(
      "SELECT * FROM account_moderation_decisions WHERE decision_type = 'stripe_reinstatement' AND subject_ref = ?",
    ).bind(`seller:${seller.sellerId}`).first();
    expect(decision.reasoning).toMatch(/flag #3/i);
  });

  it('rate-limits repeated reinstatement requests from the same account', async () => {
    const seller = await signupSeller('stripe-reinstate-rate-limit');
    await insertFlag('seller', seller.sellerId, { disposition: 'confirmed_fraud' });
    for (let i = 0; i < 10; i++) {
      const attempt = await api('/sellers/me/stripe-reinstatement-request', seller.session({ method: 'POST' }));
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/sellers/me/stripe-reinstatement-request', seller.session({ method: 'POST' }));
    expect(limited.response.status).toBe(429);
  }, 30000);
});
