// #3843 (part of #3539): the flower is one menu or leaf at a time. Opening My purchases while
// Notices is up used to leave both on screen (the second over the avatar). Opening one of the
// panels the bud opens (Settings, Notices, Friends, My purchases, My lándlets) now closes the
// others. Phone size, Shop, real clicks through the open menu.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'One Panel Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

const visiblePanels = () => page.evaluate(() => ['settings-modal', 'notifications-modal', 'my-purchases-modal', 'friends-modal', 'my-lands-modal']
  .filter((id) => document.getElementById(id)?.classList.contains('visible')));

async function open(buttonId, modalId) {
  await openAccountMenu(page);
  await page.click(`#${buttonId}`);
  await page.waitForSelector(`#${modalId}.visible`, { timeout: 5000 });
}

await open('notifications-btn', 'notifications-modal');
check(JSON.stringify(await visiblePanels()) === '["notifications-modal"]', 'Notices opens alone');

await open('my-purchases-btn', 'my-purchases-modal');
let now = await visiblePanels();
console.log('after Notices then My purchases:', JSON.stringify(now));
check(JSON.stringify(now) === '["my-purchases-modal"]', `opening My purchases closes Notices (open: ${now.join(', ')})`);

await open('friends-btn', 'friends-modal');
now = await visiblePanels();
check(JSON.stringify(now) === '["friends-modal"]', `opening Friends closes My purchases (open: ${now.join(', ')})`);

await open('settings-btn', 'settings-modal');
now = await visiblePanels();
check(JSON.stringify(now) === '["settings-modal"]', `opening Settings closes Friends (open: ${now.join(', ')})`);

// The close button still closes the one that is open, and the next one then opens alone.
await page.click('#settings-close-btn');
await page.waitForFunction(() => !document.getElementById('settings-modal').classList.contains('visible'), null, { timeout: 5000 });
await open('notifications-btn', 'notifications-modal');
check(JSON.stringify(await visiblePanels()) === '["notifications-modal"]', 'after closing Settings, Notices opens alone');

await finish(browser, { pass: pass && errors.length === 0, label: '#3843: opening one bud panel closes the others', errors });
