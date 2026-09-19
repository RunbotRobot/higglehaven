// #614: POST /api/tax/id-form (W-9/W-8BEN collection, encrypted-at-rest)
// has existed on the backend since #621, and the earnings-threshold gate
// that actually blocks redemption/payout without it (#615) has been live
// just as long — but nothing in src/main.js ever called the submission
// endpoint. A real account that crossed the threshold had no in-app way to
// unblock itself; worker/index.js's own taxThresholdPayoutBlockedError
// literally told the user to call the raw API. This test exercises the
// real "Tax Paperwork" field (Settings > General) end to end: the
// no-paperwork-on-file status note, switching between the W-9/W-8BEN field
// sets (and that the non-selected set is actually hidden, not just
// present-but-unstyled — see index.html's own [hidden]-vs-equal-
// specificity-author-rule comment this fix needed), and submitting.
//
// Same limitation as e2e/redeem-higgles-settings.test.mjs's own Stripe
// case: this suite never configures TAX_ID_ENCRYPTION_KEY (no .dev.vars
// entry, same as CI), so a real encrypt-and-store round trip isn't
// reachable here — worker/tax-id-form.test.js covers that with the key
// configured in its own isolated worker instance. What's testable and is
// the actual point of this fix is that the form now really submits and
// surfaces the server's real "not configured yet" 503, instead of no form
// existing at all.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Tax Paperwork Suite Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// Shop mode (not Build) — tax paperwork is an account-level fact, not tied
// to a builder identity or a claimed landlet, and entering Build here would
// show the full-screen #claim-modal first, which intercepts every pointer
// event over the account menu toggle until a landlet's actually claimed.
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="general"]');

await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('Tax Paperwork')),
  { timeout: 10000 },
);

const taxField = page.locator('.settings-field', { hasText: 'Tax Paperwork' });
const beforeStatus = await taxField.locator('.settings-empty-note').first().textContent();
console.log('Status before any submission (should say no paperwork on file):', beforeStatus);

// The W-9 radio is checked by default — its own fields (SSN/EIN, State, ZIP)
// should be visible, and the W-8BEN-only fields should not be.
const ssnLabel = page.locator('.stripe-onboarding-form label', { hasText: 'SSN or EIN' });
const foreignTaxIdLabel = page.locator('.stripe-onboarding-form label', { hasText: 'Foreign tax ID' });
const ssnVisibleBeforeSwitch = await ssnLabel.isVisible();
const foreignTaxIdVisibleBeforeSwitch = await foreignTaxIdLabel.isVisible();
console.log('W-9 field visible / W-8BEN field hidden by default:', ssnVisibleBeforeSwitch, !foreignTaxIdVisibleBeforeSwitch);

// Switch to W-8BEN and confirm the fields actually swap visibility (the
// real point of this test — a plain `hidden = true` on these labels does
// nothing without index.html's matching CSS override, since
// .stripe-onboarding-form label already sets display:flex at equal
// specificity to the browser's own [hidden]{display:none} rule).
await page.check('input[name="tax-form-type"][value="w8ben"]');
const ssnVisibleAfterSwitch = await ssnLabel.isVisible();
const foreignTaxIdVisibleAfterSwitch = await foreignTaxIdLabel.isVisible();
console.log('After switching to W-8BEN — W-9 field hidden / W-8BEN field visible:', !ssnVisibleAfterSwitch, foreignTaxIdVisibleAfterSwitch);

await taxField.locator('.stripe-onboarding-form label', { hasText: 'Legal name' }).locator('input').fill('Grace Hopper');
await taxField.locator('.stripe-onboarding-form label', { hasText: 'Street address' }).locator('input').fill('1 Compiler Lane');
await taxField.locator('.stripe-onboarding-form label', { hasText: 'City', exact: true }).locator('input').fill('Arlington');
await taxField.locator('.stripe-onboarding-form label', { hasText: /^Country$/ }).locator('input').fill('USA');
await taxField.locator('.stripe-onboarding-form label', { hasText: 'Country of citizenship' }).locator('input').fill('USA');
await foreignTaxIdLabel.locator('input').fill('FTIN-000');

const submitBtn = page.getByRole('button', { name: /tax paperwork/i });
await submitBtn.click();

await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('not configured on this server yet')),
  { timeout: 10000 },
);
const formStatusText = await taxField.locator('.settings-empty-note').last().textContent();
console.log('Form status after submitting (should surface the real "not configured" 503):', formStatusText);

// The failed submission shouldn't have changed the on-file status note.
const afterStatus = await taxField.locator('.settings-empty-note').first().textContent();

// The 503 above deliberately triggers a real non-2xx fetch, which Chromium
// logs as "Failed to load resource" independent of whether the app handled
// it gracefully — same filtering convention as e2e/redeem-higgles-settings
// .test.mjs and others documented in that file's own comment.
const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));

const pass = beforeStatus.includes('No tax paperwork on file yet') &&
  ssnVisibleBeforeSwitch && !foreignTaxIdVisibleBeforeSwitch &&
  !ssnVisibleAfterSwitch && foreignTaxIdVisibleAfterSwitch &&
  formStatusText.includes('Tax-ID collection is not configured on this server yet') &&
  afterStatus.includes('No tax paperwork on file yet') &&
  unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'Settings > General "Tax Paperwork" field submits a real W-9/W-8BEN form (#614)', errors });
