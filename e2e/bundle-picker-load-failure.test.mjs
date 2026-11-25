// #4314: a failed request for the builder's bundles used to leave the picker without a bundles section, so a builder
// concluded they had none. The picker now says the bundles could not be loaded and offers Try again, and opening it
// asks again by itself. The request is refused for the whole first part of the run, then allowed.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Bundle Load Failure Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

let refuse = true;
await page.route('**/api/bundles?*', async (route) => {
  if (refuse && route.request().method() === 'GET') {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'down' }) });
  } else {
    await route.continue();
  }
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.waitForSelector('#bundle-picker-retry', { timeout: 10000 });
const message = await page.textContent('#bundle-picker-empty');
check(/Couldn't load your bundles/.test(message), `the picker says the bundles could not be loaded (got "${message}")`);
check(await page.locator('#bundle-picker-section').isVisible(), 'the bundles section is on screen, not hidden');

// The server comes back: Try again asks again and the failure notice goes.
refuse = false;
await page.click('#bundle-picker-retry');
// This builder has saved none, so once the request works the ordinary rule applies: no bundles, no section.
await page.waitForFunction(() => document.getElementById('bundle-picker-section').hidden, null, { timeout: 10000 });

await finish(browser, {
  pass,
  label: '#4314: a failed bundles request shows Couldn\'t load your bundles with Try again',
  errors: errors.filter((e) => !/500|Failed to load resource|Could not load bundles/.test(e)),
});
