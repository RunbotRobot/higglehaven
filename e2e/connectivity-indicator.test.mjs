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

// #3889: the message is a word beside the flower's head (#bud-note) that opens a leaf with the
// sentence, not a red button on the world and not a modal dialog.
const offlineWordHidden = () => page.evaluate(() => {
  const note = document.getElementById('bud-note');
  // data-bud-note goes the instant the word is cleared; the button itself is hidden 200ms later.
  return !note || !document.body.hasAttribute('data-bud-note') || note.textContent.trim() !== 'Offline';
});

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}

const indicatorHiddenBeforeAnyFailure = await offlineWordHidden();
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
const indicatorVisibleAfterFailure = !(await offlineWordHidden());
console.log('indicator visible after a network-level sync failure (should be true):', indicatorVisibleAfterFailure);

// The tree still placed locally despite the failed sync — persistLayout's
// own localStorage save runs before syncCreate ever gets called.
const treeStillPlacedLocally = await page.evaluate(() => {
  const raw = localStorage.getItem('higglehaven.landlet.instances');
  return raw ? JSON.parse(raw).length > 0 : false;
});
console.log('item still saved locally despite the failed sync (should be true):', treeStillPlacedLocally);

// #3889: tapping the word opens a leaf (the flower's one soft sheet) with the sentence as
// selectable text; any native dialog here would mean it regressed to alert().
let nativeDialogSeen = false;
page.once('dialog', () => { nativeDialogSeen = true; });
await page.click('#bud-note');
await page.waitForSelector('#bud-leaf-saying-connection', { timeout: 5000 });
const dialogMessage = await page.textContent('#bud-leaf-saying-connection .bud-leaf-body');
const selectable = await page.evaluate(() => getComputedStyle(document.querySelector('#bud-leaf-saying-connection .bud-leaf-body p')).userSelect !== 'none');
console.log('the sentence can be selected (should be true):', selectable);
await page.click('#bud-leaf-saying-connection .bud-leaf-close');
await page.waitForSelector('#bud-leaf-saying-connection', { state: 'detached', timeout: 5000 });
console.log('tapping the word explains what it means (should mention "server" and "device"):', dialogMessage);

// Server reachable again — the very next successful sync should hide it,
// with no special "recovery" action needed from the builder.
await page.unroute('**/api/instances');
await placeTreeAt(260, 400);
await page.waitForTimeout(500);
const indicatorHiddenAfterRecovery = await offlineWordHidden();
console.log('indicator hidden again after the next sync succeeds (should be true):', indicatorHiddenAfterRecovery);

// The aborted POST above is deliberately a real network-level failure (the
// whole point of this test), and Chromium logs that to the console as an
// error in its own right, independent of anything this app's code does —
// expected fallout of the simulated outage, not a real page/app error.
const unexpectedErrors = errors.filter((e) => !e.includes('net::ERR_FAILED'));

const pass = indicatorHiddenBeforeAnyFailure && indicatorVisibleAfterFailure && treeStillPlacedLocally &&
  dialogMessage.toLowerCase().includes('server') && dialogMessage.toLowerCase().includes('device') && !nativeDialogSeen && selectable &&
  indicatorHiddenAfterRecovery &&
  unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'Build-mode connectivity indicator (#545)', errors: unexpectedErrors });
