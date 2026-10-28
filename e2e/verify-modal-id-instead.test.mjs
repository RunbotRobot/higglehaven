// #2862: the "Verify to continue" modal's own intro text
// (#verify-modal-intro) promises government-ID verification as an
// alternative to the credit card, but until now #verify-card-step never
// actually offered it -- the only way in was the separate Account panel's
// #auth-verify-id-btn, unreachable once already inside this no-escape
// modal (openVerifyModal passes no closeFn, see its own comment). This
// covers the new #verify-id-instead-btn wired to the same
// startDiditVerification() call, surfacing the same "not configured" error
// didit-verification.test.mjs's own #auth-verify-id-btn coverage proves for
// that button -- this deployment never configures DIDIT_API_KEY, so a real
// Didit round trip isn't driveable here either.
import { launchPage, finish, clearVerifyModalIfShown } from './helpers.mjs';

const LABEL = `Verify ID Instead ${Date.now()}`;
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await page.waitForSelector('#auth-modal.visible', { timeout: 8000 });

const email = `verify-id-instead-${Date.now()}@e2e.test`;
await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-username', LABEL);
await page.fill('#auth-signup-email', email);
await page.fill('#auth-signup-password', 'e2e-test-password-123');
await page.check('#auth-signup-age-attest');
await page.click('#auth-signup-form button[type="submit"]');
await page.waitForSelector('#auth-modal:not(.visible)', { state: 'attached', timeout: 20000 });

await page.waitForSelector('#verify-modal.visible', { timeout: 10000 });

// #verify-id-instead-btn lives inside #verify-card-step, same as the
// credit-card form it's an alternative to -- clear the age step first if
// it's showing. Mirrors clearVerifyModalIfShown's own "age step may have
// been skipped entirely" handling (age_attested_at is set automatically at
// signup, #2862's own issue text), since whether it shows here depends on
// that account-creation detail, not anything this test controls directly.
const ageStepShown = await page.locator('#verify-age-step').isVisible();
console.log('age-attestation step shown before the card step (informational -- age_attested_at may already be set at signup):', ageStepShown);
const idBtnHiddenDuringAgeStep = ageStepShown ? await page.locator('#verify-id-instead-btn').isHidden() : true;
console.log('ID-instead button hidden during the age-attestation step, if shown (should be true -- lives in the card step):', idBtnHiddenDuringAgeStep);

if (ageStepShown) {
  await page.check('#verify-age-attest');
  await page.click('#verify-continue-btn');
}
// #verify-id-instead-btn stays visible here even in this environment's
// always-simulated card path (no Stripe configured for e2e, #2859) --
// enterVerifyCardStep only hides #verify-card-form in that branch, not the
// whole #verify-card-step (see that function's own #2862 comment).
await page.waitForSelector('#verify-id-instead-btn:visible', { timeout: 10000 });

const idBtnVisibleDuringCardStep = await page.locator('#verify-id-instead-btn').isVisible();
console.log('ID-instead button visible once in the card step (should be true):', idBtnVisibleDuringCardStep);

await page.click('#verify-id-instead-btn');
const statusAfterClick = await page.waitForFunction(
  () => document.getElementById('verify-status').textContent.includes('not configured'),
  null,
  { timeout: 15000 },
).then(() => page.textContent('#verify-status'));
console.log('verify-status text after clicking "Verify by government ID instead" (should mention "not configured" -- Didit is unconfigured in this deployment):', statusAfterClick);

// The 503 above is a real, deliberate HTTP error response, logged to the
// console independent of this app's own code -- same filtering
// didit-verification.test.mjs's own comment documents.
const unexpectedErrorsSoFar = errors.filter((e) => !e.includes('Failed to load resource'));

const stillGatedAfterFailedIdAttempt = (await page.locator('#verify-modal.visible').count()) === 1;
console.log('Modal still showing after the unconfigured-Didit error (should be true -- not a false resolve):', stillGatedAfterFailedIdAttempt);

// The new button shouldn't have broken the real card path -- it still
// clears the gate normally afterward.
await clearVerifyModalIfShown(page);
await page.waitForSelector('#shop-status.visible', { timeout: 15000 }).catch(() => {});
const clearedViaCardPathAfterward = (await page.locator('#shop-status.visible').count()) === 1;
console.log('Gate still clearable via the normal card path after trying ID-instead (should be true):', clearedViaCardPathAfterward);

const pass = idBtnHiddenDuringAgeStep &&
  idBtnVisibleDuringCardStep &&
  statusAfterClick.includes('not configured') &&
  stillGatedAfterFailedIdAttempt &&
  clearedViaCardPathAfterward &&
  unexpectedErrorsSoFar.length === 0;
await finish(browser, {
  pass,
  label: 'Verify-modal "Verify by government ID instead" (#2862): offered inside the card step, wired to the same startDiditVerification() flow, and doesn\'t block the normal card path',
  errors,
});
