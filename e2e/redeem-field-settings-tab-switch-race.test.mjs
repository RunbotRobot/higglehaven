// Regression test for #1912: renderRedeemHigglesField (Settings > Build) had
// the same two-await shape as its twin renderSellSettingsSection (Settings >
// Sell), but only re-checked settingsRenderToken after the *first* await
// (ensureBuilderIdentity) -- not after the second (fetchBuilderRedeemStatus),
// unlike renderSellSettingsSection's own #1732 fix.
//
// Unlike #1732's own leak (a later, gated settingsSectionEl.appendChild(
// payoutsField) that landed visibly on whatever tab was now showing),
// nothing after this function's second await ever appends directly to the
// live settingsSectionEl again -- only to its own (by-then-detached)
// formField, so there's no DOM-visible leak to assert on the other tab.
// The real, if lower-severity, effect per the issue's own analysis is
// "wasted work and a submit handler wired to an orphaned (detached)
// button" -- the fix's own comment exposes window.__testLastRedeemFormField
// (this call's own formField) so that can be checked directly: fixed code
// never appends anything to it once superseded; pre-fix code still builds
// and appends the full onboarding form to it.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Redeem Field Tab Race Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await page.route('**/api/builders/me/redeem', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ configured: false, connected: false, status: null, requirementsCurrentlyDue: [], availableCents: 0 }),
  });
});

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForTimeout(200);

// Capture this specific (about-to-be-superseded) call's own formField
// reference before switching tabs overwrites window.__testLastRedeemFormField
// with a later call's.
const capturedBeforeSwitch = await page.evaluate(() => {
  window.__testCapturedRedeemFormField = window.__testLastRedeemFormField;
  return !!window.__testCapturedRedeemFormField;
});
console.log('Captured the Build tab render\'s own formField before switching away (should be true):', capturedBeforeSwitch);

await page.click('.settings-tab-btn[data-section="general"]');
await page.waitForTimeout(200);

const childCountRightAfterSwitch = await page.evaluate(() => window.__testCapturedRedeemFormField.childElementCount);
console.log('Captured formField child count right after switching away (should be 0 -- the pending fetch has not resolved yet):', childCountRightAfterSwitch);

// Wait past the delayed GET's own delay so the superseded Build-tab render
// actually resolves and (pre-fix) would go on to build+append the full
// Stripe onboarding form onto the captured (by-then-detached) formField.
await page.waitForTimeout(2500);

const stillOnGeneralTab = await page.locator('.settings-tab-btn[data-section="general"]').evaluate((el) => el.classList.contains('active'));
console.log('still showing the General tab (should be true -- no tab-switch happened on our own):', stillOnGeneralTab);

const childCountAfterDelay = await page.evaluate(() => window.__testCapturedRedeemFormField.childElementCount);
console.log('Captured formField child count after the delayed redeem-status fetch resolves (should stay 0 -- the superseded render must not build the form):', childCountAfterDelay);

await page.unroute('**/api/builders/me/redeem');

// Switching back to Build afterward should still work normally -- the fix
// only skips a superseded render, not a fresh, current one.
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('Redeem Higgles') && f.textContent.includes('Available to redeem')),
  { timeout: 20000 },
);
const buildTabWorksNormally = await page.locator('.settings-field', { hasText: 'Redeem Higgles' }).count();
console.log('Build tab still renders the Redeem Higgles field normally on a fresh, non-superseded switch (should be 1):', buildTabWorksNormally);

const pass = capturedBeforeSwitch &&
  childCountRightAfterSwitch === 0 &&
  stillOnGeneralTab &&
  childCountAfterDelay === 0 &&
  buildTabWorksNormally === 1 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1912: a superseded Settings Build-tab render never builds the Redeem Higgles onboarding form after a tab switch',
  errors,
});
