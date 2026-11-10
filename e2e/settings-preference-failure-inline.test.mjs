// #3359 (part of #3249's native-dialog sweep): a failed notification-preference
// save used to be reported with window.alert(), which a browser that suppresses
// native dialogs drops without a trace -- the checkbox just flipped back and the
// person was never told why. The message now shows beside the checkbox, stays
// until the next attempt, and no native dialog is raised. Every dialog is
// dismissed the way a suppressing browser would, at phone width.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Preference Failure Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 800 } });

let nativeDialogs = 0;
page.removeAllListeners('dialog');
page.on('dialog', async (dialog) => {
  nativeDialogs += 1;
  await dialog.dismiss();
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="general"]');
const field = page.locator('.settings-field:has-text("Notifications")');
await field.waitFor({ timeout: 10000 });
const checkbox = field.locator('input[type="checkbox"]').first();
await checkbox.waitFor({ timeout: 10000 });

await page.route('**/api/builders/me/notification-preferences', async (route) => {
  if (route.request().method() === 'PUT') {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Preferences are unavailable right now.' }) });
  } else {
    await route.continue();
  }
});

const before = await checkbox.isChecked();
await checkbox.click();
const status = field.locator('.inline-action-status');
await status.waitFor({ state: 'visible', timeout: 10000 });
const shown = (await status.textContent()).trim();
const revertedAfterFailure = (await checkbox.isChecked()) === before;
const selectable = await status.evaluate((el) => {
  const s = getComputedStyle(el);
  return s.userSelect !== 'none' && s.pointerEvents !== 'none';
});
console.log('inline message shown:', shown);

// A later successful save clears the message.
await page.unroute('**/api/builders/me/notification-preferences');
await checkbox.click();
await page.waitForFunction(() => document.querySelector('.settings-field .inline-action-status')?.hidden === true, null, { timeout: 10000 });

console.log('native dialogs raised (should be 0):', nativeDialogs);
const pass = /unavailable/.test(shown) && revertedAfterFailure && selectable && nativeDialogs === 0
  && errors.filter((e) => !/Failed to load resource|500/.test(e)).length === 0;
await finish(browser, { pass, label: 'a failed notification-preference save is reported inline, not by a native alert (#3359)', errors });
