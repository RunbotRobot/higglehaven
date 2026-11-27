// #4498: the payout-setup notice says "Open Payouts to finish" and a tap does: it marks the notice read, closes
// Notices and opens the Payouts leaf, from Build (no mode switch). Phone viewport (the default).
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, localD1 } from './helpers.mjs';

const NAME = 'Payout Notice Door';
const MESSAGE = 'Stripe needs more information before it can pay you out. Open Payouts to finish.';

const session = await launchPage({ promptAnswer: NAME });
const page = session.page;
await chooseIdentity(page, { mode: 'build', label: NAME, isNew: true });
await claimLandlet(page);

localD1(`INSERT INTO notifications (notification_id, builder_id, message, template_id, kind)
  SELECT 'notification-e2e-payouts-door', b.builder_id, '${MESSAGE}', NULL, 'payouts'
  FROM builders b JOIN users u ON u.user_id = b.user_id WHERE u.username = '${NAME}'`);

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#bud-note:not([hidden])', { timeout: 60000 });
await openAccountMenu(page);
await page.click('#notifications-btn');
await page.waitForSelector('#notifications-modal.visible', { timeout: 5000 });
const row = page.locator('.notification-row', { hasText: 'Open Payouts to finish' });
await row.waitFor({ timeout: 10000 });
console.log('the notice reads as a door (aria-label starts with Open):', (await row.getAttribute('aria-label')).startsWith('Open'));
await row.click();
const leafOpened = await page.waitForSelector('#bud-leaf-payouts', { timeout: 10000 }).then(() => true, () => false);
const noticesClosed = await page.evaluate(() => !document.getElementById('notifications-modal').classList.contains('visible'));
console.log('tapping it opens the Payouts leaf (should be true):', leafOpened, '; Notices closed (should be true):', noticesClosed);

await finish(session.browser, {
  pass: leafOpened && noticesClosed,
  label: '#4498: a tap on the payout-setup notice opens Payouts',
  errors: [],
});
