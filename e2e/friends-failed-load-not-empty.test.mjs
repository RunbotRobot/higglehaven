// #4578: when the Friends leaf could not load the list it showed the error and, beneath it, "No friends yet",
// telling someone with friends they have none. A failed load now shows the error and Try again and no empty
// sentence; the empty sentence is only for a list that loaded and was empty. The request is refused first, then allowed.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Friends Load Failure Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

let refuse = true;
await page.route('**/api/friendships*', async (route) => {
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

await openAccountMenu(page);
await page.click('#friends-btn');
await page.waitForSelector('#friends-modal.visible', { timeout: 5000 });
await page.waitForSelector('#friends-retry-btn:not([hidden])', { timeout: 10000 });
check((await page.textContent('#friends-status')).trim().length > 0, 'the leaf says the list could not be loaded');
check(await page.locator('#friends-panel-empty').isHidden(), 'a failed load does not say "No friends yet"');

refuse = false;
await page.click('#friends-retry-btn');
await page.waitForSelector('#friends-panel-empty:not([hidden])', { timeout: 10000 });
check(await page.locator('#friends-retry-btn').isHidden(), 'Try again is gone once the list loaded');
check((await page.textContent('#friends-status')).trim() === '', 'the error line is gone once the list loaded');

await finish(browser, {
  pass,
  label: '#4578: a failed Friends load shows the error and Try again, never "No friends yet"',
  errors: errors.filter((e) => !/500|Failed to load resource/.test(e)),
});
