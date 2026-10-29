// #2882: #verify-id-instead-btn's click handler (src/account/auth.js) calls
// startDiditVerification(), which can 400 ("This account is already
// ID-verified.") when the server's own handleDiditVerificationSession
// reconciles a stale-but-actually-approved Didit session as a side effect
// of this very call -- applyDiditDecision has already raised trust_tier to
// id_verified in the DB by the time that 400 reaches the client. Before the
// fix, the old catch block only set an error status, leaving the user
// stuck looking at a "already ID-verified" error inside this no-escape
// modal (openVerifyModal passes no closeFn -- see that comment in
// src/account/auth.js) with no way forward but logging out.
//
// This deployment never configures DIDIT_API_KEY (same note every other
// voice/DM/nearby-chat e2e test in this repo already makes), so there's no
// way to drive a real Didit session to "already approved" and hit this
// branch through a genuine round trip. Instead, this intercepts the two
// network calls the fix's own recovery path makes -- POST
// /auth/didit-verification-session (mocked to 400, the real error shape)
// and the follow-up GET /auth/me (mocked to the account's own real user
// object with trustTier overridden to 'id_verified', the real post-reconcile
// server state) -- which exercises exactly the client-side recovery logic
// this issue is about, independent of whether a real Didit session exists.
import { launchPage, finish } from './helpers.mjs';

const LABEL = `Stale Reconcile ${Date.now()}`;
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await page.waitForSelector('#auth-modal.visible', { timeout: 8000 });

const email = `verify-stale-reconcile-${Date.now()}@e2e.test`;
await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-username', LABEL);
await page.fill('#auth-signup-email', email);
await page.fill('#auth-signup-password', 'e2e-test-password-123');
await page.check('#auth-signup-age-attest');
await page.click('#auth-signup-form button[type="submit"]');
await page.waitForSelector('#auth-modal:not(.visible)', { state: 'attached', timeout: 20000 });

await page.waitForSelector('#verify-modal.visible', { timeout: 10000 });

// Same age-step handling as e2e/verify-modal-id-instead.test.mjs's own
// comment -- whether it shows depends on signup's own age_attested_at
// timing, not anything this test controls directly.
const ageStepShown = await page.locator('#verify-age-step').isVisible();
if (ageStepShown) {
  await page.check('#verify-age-attest');
  await page.click('#verify-continue-btn');
}
await page.waitForSelector('#verify-id-instead-btn:visible', { timeout: 10000 });

// The account's own real /auth/me shape, captured before any mocking, so
// the follow-up GET /auth/me response below stays realistic (every other
// field intact) instead of a hand-fabricated user object that could drift
// from what the real endpoint actually returns.
const realUser = await page.evaluate(async () => {
  const res = await fetch('/api/auth/me');
  return (await res.json()).user;
});
console.log('real user before mocking (trustTier should be \'none\' -- not yet verified):', realUser.trustTier);

await page.route('**/auth/didit-verification-session', async (route) => {
  await route.fulfill({
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'This account is already ID-verified.' }),
  });
});
await page.route('**/auth/me', async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ user: { ...realUser, trustTier: 'id_verified' } }),
  });
});

await page.click('#verify-id-instead-btn');

// The fix resolves the modal via the re-fetched (now id_verified) user --
// same end state as a real successful card/ID verification would reach.
const resolved = await page.waitForSelector('#verify-modal:not(.visible)', { state: 'attached', timeout: 10000 })
  .then(() => true).catch(() => false);
console.log('modal resolved after the 400-then-refetch-shows-verified sequence (should be true -- #2882 fix):', resolved);

const stuckShowingStaleError = resolved
  ? false
  : await page.locator('#verify-status.error').isVisible().catch(() => false);
console.log('modal instead stuck showing the stale "already verified" error (should be false):', stuckShowingStaleError);

// The mocked 400 is a real, deliberate HTTP error response Playwright logs
// to the console independent of this app's own code -- same filtering
// every other test in this file's own family uses for its own deliberate
// error response.
const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));

const pass = resolved && !stuckShowingStaleError && unexpectedErrors.length === 0;
await finish(browser, {
  pass,
  label: 'Verify-modal "Verify by government ID instead" (#2882): recovers when a 400 reveals the account was already verified server-side by this same call, instead of leaving the no-escape modal stuck',
  errors,
});
