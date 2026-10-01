// #1072 (owner direction, Control Room 2026-10-01): "one card, one
// account, permanently." handleConfirmCard's real-Stripe-configured branch
// has no automated coverage in this suite (STRIPE_SECRET_KEY is never
// configured here, and there's no outbound-fetch-mocking infrastructure --
// see PR #1073's own test-plan note), so the claim/reuse-rejection logic is
// tested directly against the exported primitive instead, the same
// "no real Stripe call needed" shape stripe-connect.test.js's own
// claimOrResumeBuilderRedemption tests already use.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { claimCardFingerprint } from './index.js';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function userId(account) {
  const me = await api('/auth/me', account.session());
  return me.body.user.userId;
}

describe('claimCardFingerprint (#1072)', () => {
  it('claims a brand-new fingerprint for the first account and reports it as not owned by another', async () => {
    const account = await signupBuilder('fingerprint-fresh');
    const fingerprint = `fp-${crypto.randomUUID()}`;

    const ownedByAnother = await claimCardFingerprint(env.DB, fingerprint, await userId(account));
    expect(ownedByAnother).toBe(false);

    const row = await env.DB.prepare('SELECT user_id FROM card_fingerprints WHERE fingerprint = ?')
      .bind(fingerprint).first();
    expect(row).toBeTruthy();
  });

  it('is idempotent — the same account re-claiming the same fingerprint is still not "owned by another"', async () => {
    const account = await signupBuilder('fingerprint-retry');
    const uid = await userId(account);
    const fingerprint = `fp-${crypto.randomUUID()}`;

    const first = await claimCardFingerprint(env.DB, fingerprint, uid);
    const second = await claimCardFingerprint(env.DB, fingerprint, uid);
    expect(first).toBe(false);
    expect(second).toBe(false);

    const row = await env.DB.prepare('SELECT user_id FROM card_fingerprints WHERE fingerprint = ?')
      .bind(fingerprint).first();
    expect(row.user_id).toBe(uid);
  });

  it('rejects a second, different account trying to claim a fingerprint the first account already owns', async () => {
    const first = await signupBuilder('fingerprint-owner');
    const second = await signupBuilder('fingerprint-intruder');
    const firstUserId = await userId(first);
    const secondUserId = await userId(second);
    const fingerprint = `fp-${crypto.randomUUID()}`;

    const firstClaim = await claimCardFingerprint(env.DB, fingerprint, firstUserId);
    expect(firstClaim).toBe(false);

    const secondClaim = await claimCardFingerprint(env.DB, fingerprint, secondUserId);
    expect(secondClaim).toBe(true);

    // The original owner's claim is untouched by the second account's
    // rejected attempt.
    const row = await env.DB.prepare('SELECT user_id FROM card_fingerprints WHERE fingerprint = ?')
      .bind(fingerprint).first();
    expect(row.user_id).toBe(firstUserId);
  });

  it('under a concurrent race for the same fingerprint, only one account ends up owning it', async () => {
    const first = await signupBuilder('fingerprint-race-a');
    const second = await signupBuilder('fingerprint-race-b');
    const firstUserId = await userId(first);
    const secondUserId = await userId(second);
    const fingerprint = `fp-${crypto.randomUUID()}`;

    const [firstResult, secondResult] = await Promise.all([
      claimCardFingerprint(env.DB, fingerprint, firstUserId),
      claimCardFingerprint(env.DB, fingerprint, secondUserId),
    ]);
    // Exactly one of the two calls sees itself as the owner (false) and the
    // other sees the fingerprint as already owned by a different account
    // (true) — never both false (double ownership) or both true (nobody
    // actually won the claim).
    expect([firstResult, secondResult].sort()).toEqual([false, true]);
  });
});
