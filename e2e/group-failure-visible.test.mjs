// #3264 (owner report, Android phone): tapping Group in Build mode dimmed the
// button and then nothing visible happened. Two causes, both covered here:
//  1. A refused Group request set #product-info, but the handler's finally
//     (updateSelectionUI) rewrote it with "2 items selected" in the same tick,
//     so the message never showed. It now appears in #selection-action-status
//     and stays. (#3303: it is also selectable, stays until dismissed, and has
//     a Copy button.)
//  2. Group right after placing named ids the server had not stored yet (404).
//     Group now waits for the pending saves, then succeeds.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Group Failure Visible Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await placeTreeAt(160, 380);
await placeTreeAt(260, 380);
await page.mouse.click(60, 550);
await page.waitForTimeout(300);
const [posA, posB] = await page.evaluate(() => window.__testProductScreenPositions());
await page.click('#toggle-multiselect');
await page.waitForTimeout(200);
await page.mouse.click(posA.x, posA.y);
await page.waitForTimeout(150);
await page.mouse.click(posB.x, posB.y);
await page.waitForTimeout(300);

// 1. A refused Group request: the reason is visible and survives.
let groupRequests = 0;
let refuse = true;
await page.route('**/api/instances/group', async (route) => {
  groupRequests += 1;
  if (refuse) {
    await route.fulfill({
      status: 404, contentType: 'application/json',
      body: JSON.stringify({ error: 'Something you were working with was removed or changed. Reload and try again.', code: 'stale_reference' }),
    });
    return;
  }
  await route.continue();
});
await page.click('#group-item');
await page.waitForSelector('#selection-action-status:not([hidden])', { timeout: 5000 });
await page.waitForTimeout(1000); // long enough for any same-tick overwrite to have happened
const shown = await page.locator('#selection-action-status').innerText();
check(/Couldn't bundle/.test(shown) && /removed or changed/.test(shown), `refusal text: ${shown}`);
check(await page.locator('#selection-action-status').isVisible(), 'status still visible after a second');
check((await page.textContent('#product-info')).includes('2 items selected'), 'selection summary still shown separately');
check(await page.locator('#group-item').isEnabled(), 'Group is usable again after a refusal');

// #3303 (owner decision: any text a user can read, they can copy). On a phone
// the refusal used to be click-through (pointer-events: none) and vanished
// after 8 seconds, so there was no time or way to copy it.
await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
await page.waitForTimeout(8500); // past the old 8s auto-clear
check(await page.locator('#selection-action-status').isVisible(), 'the refusal is still shown after 8.5 seconds');
const statusStyle = await page.evaluate(() => {
  const style = getComputedStyle(document.getElementById('selection-action-status'));
  return { pointerEvents: style.pointerEvents, userSelect: style.userSelect };
});
check(statusStyle.pointerEvents !== 'none', `the refusal accepts pointer events (${statusStyle.pointerEvents})`);
check(statusStyle.userSelect !== 'none', `the refusal text is selectable (${statusStyle.userSelect})`);
await page.click('#selection-action-status-copy');
await page.waitForTimeout(300);
const copiedText = await page.evaluate(() => navigator.clipboard.readText());
check(/Couldn't bundle/.test(copiedText) && /removed or changed/.test(copiedText), `Copy puts the refusal on the clipboard: ${copiedText}`);
check((await page.textContent('#selection-action-status-copy')) === 'Copied!', 'Copy button confirms with "Copied!"');
await page.click('#selection-action-status-dismiss');
check(await page.locator('#selection-action-status').isHidden(), 'dismissing hides the refusal');

// 2. Group while a placement save is still in flight waits for it.
refuse = false;
let releaseCreate = null;
let createSeen = false;
await page.route('**/api/instances', async (route) => {
  if (route.request().method() !== 'POST') {
    await route.continue();
    return;
  }
  createSeen = true;
  await new Promise((resolve) => { releaseCreate = resolve; });
  await route.continue();
});
await page.mouse.click(60, 550);
await page.waitForTimeout(200);
await placeTreeAt(210, 450);
await page.waitForTimeout(300);
check(createSeen, 'the third placement save was held');
if ((await page.getAttribute('#toggle-multiselect', 'aria-pressed')) !== 'true') {
  await page.click('#toggle-multiselect');
  await page.waitForTimeout(200);
}
// The freshly placed tree is already selected; tapping the first one adds it.
await page.mouse.click(posA.x, posA.y);
await page.waitForTimeout(300);
check((await page.textContent('#product-info')).includes('2 items selected'), 'two items selected for the second Group');
const before = groupRequests;
await page.click('#group-item');
await page.waitForTimeout(800);
check(groupRequests === before, 'no group request is sent while a save is still pending');
releaseCreate?.();
await page.waitForFunction(() => document.getElementById('ungroup-item') && !document.getElementById('ungroup-item').disabled, null, { timeout: 15000 });
check(groupRequests === before + 1, 'exactly one group request after the save landed');

// The refusal in part 1 is deliberate: the browser logs the 404 and the app logs its own console.error.
const unexpectedErrors = errors.filter((e) => !/status of 404|Could not group selection/.test(e));
await finish(browser, { pass: pass && unexpectedErrors.length === 0, label: 'group-failure-visible', errors: unexpectedErrors });
