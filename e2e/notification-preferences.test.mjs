// #2067 (leaf sub-issue of #1973, part of #1947): the Settings > General
// "Email me when one of my placed products sells out" opt-in checkbox --
// confirms it starts unchecked, persists a change across closing/reopening
// Settings, and round-trips through the real
// GET/PUT /api/builders/me/notification-preferences endpoints (not just
// local DOM state).
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Notification Preferences Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function openGeneralSettings() {
  await openAccountMenu(page);
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
  await page.click('.settings-tab-btn[data-section="general"]');
  await page.waitForTimeout(500);
}

async function fetchJson(pathAndQuery) {
  return page.evaluate(async (p) => (await fetch(p)).json(), pathAndQuery);
}

await openGeneralSettings();
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('Notifications')),
  undefined,
  { timeout: 10000 },
);

const checkbox = page.locator('.settings-field:has-text("Notifications") input[type="checkbox"]').first();
const beforeChecked = await checkbox.isChecked();
console.log('initial checkbox state (should be false, the server-side default):', beforeChecked);

const beforeServer = await fetchJson('/api/builders/me/notification-preferences');
console.log('server-side preference before any change (should be false):', beforeServer.notifySoldOutEmail);

await checkbox.click();
await page.waitForTimeout(500);
const afterChecked = await checkbox.isChecked();
console.log('checkbox state right after clicking (should be true):', afterChecked);

const afterServer = await fetchJson('/api/builders/me/notification-preferences');
console.log('server-side preference right after clicking (should be true, confirming the real PUT landed):', afterServer.notifySoldOutEmail);

await page.click('#settings-close-btn');
await page.waitForTimeout(300);
await openGeneralSettings();
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('Notifications')),
  undefined,
  { timeout: 10000 },
);
const reopenedChecked = await page.locator('.settings-field:has-text("Notifications") input[type="checkbox"]').first().isChecked();
console.log('checkbox state after reopening Settings (should still be true, confirming it reads the real server value, not just local state):', reopenedChecked);

const pass = beforeChecked === false
  && beforeServer.notifySoldOutEmail === false
  && afterChecked === true
  && afterServer.notifySoldOutEmail === true
  && reopenedChecked === true
  && errors.length === 0;
await finish(browser, {
  pass,
  label: '#2067: the sold-out email notification preference checkbox round-trips through the real API and persists across reopening Settings',
  errors,
});
