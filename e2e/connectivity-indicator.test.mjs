// #545: Build mode's connectivity indicator. Owner-clarified UX: a small
// icon shown only when a sync to the backend has failed with a genuine
// network-level error (server unreachable) — tapping it explains what it
// means, and it disappears again the moment a later sync succeeds. Placing
// an item still works either way (persistLayout's own localStorage save
// runs first) — this is purely about the visibility of the indicator
// itself, not about placement succeeding or failing.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Connectivity Indicator Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}

const indicatorHiddenBeforeAnyFailure = await page.locator('#connectivity-indicator').isHidden();
console.log('indicator hidden before any sync has ever failed (should be true):', indicatorHiddenBeforeAnyFailure);

// Simulate the server being genuinely unreachable (not just returning an
// error) for the single-instance-create endpoint only — aborting a route
// makes the page's own fetch() reject with a TypeError, exactly what a
// real network failure (offline, DNS, connection refused) does.
await page.route('**/api/instances', async (route) => {
  if (route.request().method() === 'POST') {
    await route.abort('failed');
    return;
  }
  await route.continue();
});

await placeTreeAt(160, 400);
await page.waitForTimeout(300);
const indicatorVisibleAfterFailure = await page.locator('#connectivity-indicator').isVisible();
console.log('indicator visible after a network-level sync failure (should be true):', indicatorVisibleAfterFailure);

// The tree still placed locally despite the failed sync — persistLayout's
// own localStorage save runs before syncCreate ever gets called.
const treeStillPlacedLocally = await page.evaluate(() => {
  const raw = localStorage.getItem('higglehaven.landlet.instances');
  return raw ? JSON.parse(raw).length > 0 : false;
});
console.log('item still saved locally despite the failed sync (should be true):', treeStillPlacedLocally);

// launchPage already registers its own page.on('dialog', ...) that accepts
// every dialog (needed for the prompt()/alert() calls used throughout this
// app) — this just reads the message, leaving accept() to that handler
// rather than racing it for the same dialog.
let dialogMessage = '';
page.once('dialog', (dialog) => { dialogMessage = dialog.message(); });
await page.click('#connectivity-indicator');
await page.waitForTimeout(200);
console.log('tapping the icon explains what it means (should mention "server" and "device"):', dialogMessage);

// Server reachable again — the very next successful sync should hide it,
// with no special "recovery" action needed from the builder.
await page.unroute('**/api/instances');
await placeTreeAt(260, 400);
await page.waitForTimeout(500);
const indicatorHiddenAfterRecovery = await page.locator('#connectivity-indicator').isHidden();
console.log('indicator hidden again after the next sync succeeds (should be true):', indicatorHiddenAfterRecovery);

// The aborted POST above is deliberately a real network-level failure (the
// whole point of this test), and Chromium logs that to the console as an
// error in its own right, independent of anything this app's code does —
// expected fallout of the simulated outage, not a real page/app error.
const unexpectedErrors = errors.filter((e) => !e.includes('net::ERR_FAILED'));

const pass = indicatorHiddenBeforeAnyFailure && indicatorVisibleAfterFailure && treeStillPlacedLocally &&
  dialogMessage.toLowerCase().includes('server') && dialogMessage.toLowerCase().includes('device') &&
  indicatorHiddenAfterRecovery &&
  unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'Build-mode connectivity indicator (#545)', errors: unexpectedErrors });
