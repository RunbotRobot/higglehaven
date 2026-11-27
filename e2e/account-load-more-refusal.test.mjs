// #4562: "Load more" on Notices and "Mark all read" caught a failure with only console.warn and re-enabled the
// button, so a refused or dropped request looked like a tap that did nothing. They now say so beside the control and
// clear the line when the next try works. The pages are mocked (page.route) so a second page exists and a failure can
// be forced and then lifted, as e2e/dm-load-more.test.mjs does for the thread.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Load More Refusal Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

const notice = (id, message) => ({ notificationId: id, message, readAt: null, createdAt: '2026-11-27T10:00:00.000Z' });
let failLoadMore = true;
let failMarkAll = true;
await page.route('**/api/notifications?*', async (route) => {
  const url = new URL(route.request().url());
  if (url.searchParams.get('cursor')) {
    if (failLoadMore) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Test: the next page is not available.' }) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notifications: [notice('n-older', 'An older notice')], nextCursor: null }) });
    }
    return;
  }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notifications: [notice('n-1', 'First notice')], nextCursor: 'cursor-2' }) });
});
await page.route('**/api/notifications/mark-all-read', async (route) => {
  if (failMarkAll) {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Test: could not mark them read.' }) });
  } else {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
  }
});

await openAccountMenu(page);
await page.click('#notifications-btn');
await page.waitForSelector('#notifications-modal.visible', { timeout: 5000 });
await page.waitForSelector('#notifications-list .notification-row', { timeout: 10000 });
await page.waitForSelector('#notifications-load-more-btn:not([hidden])', { timeout: 5000 });

const lineText = () => page.evaluate(() => [...document.querySelectorAll('#notifications-modal .inline-action-status')]
  .filter((el) => !el.hidden && el.textContent.trim()).map((el) => el.textContent.trim()));

// 1. Load more refused: the line says why, the first notice stays, the button is usable again.
await page.click('#notifications-load-more-btn');
await page.waitForFunction(() => [...document.querySelectorAll('#notifications-modal .inline-action-status')]
  .some((el) => !el.hidden && el.textContent.includes('not available')), null, { timeout: 10000 });
console.log('load-more refusal line:', await lineText());
const rowsAfterRefusal = await page.locator('#notifications-list .notification-row').count();
const buttonEnabled = await page.locator('#notifications-load-more-btn').isEnabled();

// 2. The next try works: the older notice arrives and the line is gone.
failLoadMore = false;
await page.click('#notifications-load-more-btn');
await page.waitForFunction(() => document.querySelectorAll('#notifications-list .notification-row').length === 2, null, { timeout: 10000 });
const lineAfterSuccess = await lineText();

// 3. Mark all read refused: the same kind of line.
await page.click('#notifications-mark-all-btn');
await page.waitForFunction(() => [...document.querySelectorAll('#notifications-modal .inline-action-status')]
  .some((el) => !el.hidden && el.textContent.includes('could not mark')), null, { timeout: 10000 });
console.log('mark-all refusal line:', await lineText());

const expectedErrors = errors.filter((e) => !String(e).includes('500'));
const pass = rowsAfterRefusal === 1 && buttonEnabled && lineAfterSuccess.length === 0 && expectedErrors.length === 0;
await finish(browser, { pass, label: 'Account menu: Load more and Mark all read say when they fail (#4562)', errors: expectedErrors });
