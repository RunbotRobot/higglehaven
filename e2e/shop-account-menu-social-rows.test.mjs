// #3550: Notices and Friends stay in the account menu in Shop mode (they
// used to be hidden there, so the world's social surfaces were reachable
// only after switching to Build). Opens each from Shop, closes it, and
// checks the person is still in Shop.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ viewport: { width: 390, height: 844 } });
async function patch(route) {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
}
await page.route('**/api/auth/me', patch);
await page.route('**/api/auth/signup', patch);
await chooseIdentity(page, { mode: 'shop', label: 'SocialRows' + (Date.now() % 100000), isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });

await openAccountMenu(page);
const rows = await page.evaluate(() => ['notifications-btn', 'friends-btn'].map((id) => getComputedStyle(document.getElementById(id)).display !== 'none'));
let pass = rows.every(Boolean);
console.log('Notices/Friends rows visible in Shop:', rows);

await page.click('#notifications-btn');
await page.waitForSelector('#notifications-modal.visible', { timeout: 5000 });
await page.click('#notifications-close-btn');
await page.waitForSelector('#notifications-modal:not(.visible)', { state: 'attached', timeout: 5000 });

await openAccountMenu(page);
await page.click('#friends-btn');
await page.waitForSelector('#friends-modal.visible', { timeout: 5000 });
await page.click('#friends-close-btn');
await page.waitForSelector('#friends-modal:not(.visible)', { state: 'attached', timeout: 5000 });

const stillShop = await page.evaluate(() => !!document.querySelector('body.shop-ready'));
console.log('still in Shop:', stillShop);
pass = pass && stillShop;
await finish(browser, { pass, label: 'shop account menu social rows', errors });
