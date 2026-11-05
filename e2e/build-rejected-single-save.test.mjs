// #1576: a single-item save the server actually answers and refuses (here a
// 409 "Landlet changed concurrently") used to vanish into console.warn: the
// item stayed on screen, saved only on this device, and silently reverted on
// a later reload. Now the builder is told in plain words and the scene is
// put back to what the server has -- the rejected new item leaves the scene,
// and a following (accepted) placement still works.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Rejected Save Suite Builder';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForSelector('#undo-redo-panel', { state: 'attached', timeout: 15000 });
await page.waitForTimeout(1000);

// Capture alert() text (launchPage's own handler just accepts them).
await page.evaluate(() => { window.__alerts = []; window.alert = (msg) => { window.__alerts.push(String(msg)); }; });

async function placeTree(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(1500);
}
const productCount = () => page.evaluate(() => window.__testProductScreenPositions().length);

// The server refuses the next single-item create.
await page.route('**/api/instances', (route) => {
  if (route.request().method() !== 'POST') return route.continue();
  return route.fulfill({
    status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: 'Landlet changed concurrently' }),
  });
});

const before = await productCount();
await placeTree(260, 520);
await page.waitForFunction(() => window.__alerts.length > 0, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(800);
const afterRejected = await productCount();
const alerts = await page.evaluate(() => window.__alerts);
console.log('items before / after the rejected placement (should be equal):', before, afterRejected);
console.log('alerts:', JSON.stringify(alerts));
const told = alerts.some((a) => /Couldn't save that new item/.test(a) && /put back/.test(a) && !/#\d+/.test(a));

// Once the server accepts again, placing works and stays.
await page.unroute('**/api/instances');
await page.evaluate(() => { window.__alerts = []; });
await placeTree(330, 540);
const afterAccepted = await productCount();
const quiet = (await page.evaluate(() => window.__alerts)).length === 0;
console.log('items after an accepted placement (should be before + 1):', afterAccepted);
console.log('no alert for an accepted save (should be true):', quiet);

// The browser logs the injected 409 itself as a console error; that one is expected.
const unexpectedErrors = errors.filter((message) => !/status of 409/.test(String(message)));
const pass = before === afterRejected && told && afterAccepted === before + 1 && quiet && unexpectedErrors.length === 0;
await finish(browser, {
  pass,
  label: '#1576: a server-rejected single-item save is surfaced and the scene is put back to what the server has',
  errors: unexpectedErrors,
});
