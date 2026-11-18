// #3760 (part of #3759, the flower): four menus, one open at a time. The bud opens on the general
// menu, which is the same in every mode; a place's own tools are under that place's petal; the
// petal of a menu with nothing in it (Shop's) opens no stem; the head or Escape closes whichever is open.
import { launchPage, chooseIdentity, goToMode, finish } from './helpers.mjs';

const LABEL = 'Bud Menus Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForSelector('body[data-bud="on"]', { timeout: 10000 });
await page.click('#seller-close-btn');
await page.waitForTimeout(400);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
// The ids of the leaves drawn in the open stem, in order.
const leaves = () => page.evaluate(() => [...document.querySelectorAll('#account-menu-panel > button, #account-menu-panel > .bud-pair')]
  .filter((el) => getComputedStyle(el).display !== 'none' && !el.hidden).map((el) => el.id || el.className));
const ringState = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#bud-modes button')]
  .map((b) => [b.dataset.mode ?? b.dataset.menu, b.getAttribute('aria-expanded')])));
const GENERAL_SELLER = ['account-auth-btn', 'notifications-btn', 'friends-btn', 'my-purchases-btn', 'settings-btn', 'bud-petal-general-help'];

// The ring has four petals: the three places and the general menu.
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded');
await page.waitForTimeout(400);
const ring = await page.evaluate(() => [...document.querySelectorAll('#bud-modes button')].map((b) => b.dataset.mode ?? b.dataset.menu));
check(ring.length === 4 && ['shop', 'build', 'sell', 'general'].every((m) => ring.includes(m)), `four petals around the head (${ring})`);

const apart = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('#bud-modes button')].map((b) => b.getBoundingClientRect());
  const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  return boxes.every((a, i) => boxes.every((b, j) => i === j || !overlap(a, b))) && boxes.every((b) => b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight);
});
check(apart, 'the four petals do not touch each other and stay on screen');
const stemBelowRing = await page.evaluate(() => {
  const ringBottom = Math.max(...[...document.querySelectorAll('#bud-modes button')].map((b) => b.getBoundingClientRect().bottom));
  return [...document.querySelectorAll('#account-menu-panel > button')].filter((b) => b.offsetParent !== null).every((b) => b.getBoundingClientRect().top >= ringBottom - 1);
});
check(stemBelowRing, 'the stem starts below the ring');

// It opens on the general menu: the person, notices, friends, purchases, settings, "?".
const sellGeneral = await leaves();
console.log('Sell, general:', JSON.stringify(sellGeneral));
check(GENERAL_SELLER.every((id) => sellGeneral.includes(id)), 'the general menu has its members');
check(!sellGeneral.some((id) => id.startsWith('bud-petal-sell-')), "Sell's own tools are not in the general menu");
check((await ringState()).general === 'true', 'the Menu petal shows it is the open one');

// The Sell petal opens Sell's stem and closes the general one.
await page.click('#bud-modes .mode-nav-btn[data-mode="sell"]');
await page.waitForTimeout(300);
const sellOwn = await leaves();
console.log('Sell, own:', JSON.stringify(sellOwn));
check(sellOwn.includes('bud-petal-sell-my-products') && sellOwn.includes('bud-petal-sell-add-product'), "Sell's menu has My products and Add a product");
check(!sellOwn.includes('settings-btn') && !sellOwn.includes('bud-petal-general-help'), 'only one menu is open: the general one closed');
check((await page.locator('#account-menu-panel.expanded').count()) === 1, 'the bud stays open while its menu changes');
const rs = await ringState();
check(rs.sell === 'true' && rs.general === 'false', 'the Sell petal shows it is the open one');

// "Menu" brings the general stem back.
await page.click('#bud-menu-general');
await page.waitForTimeout(300);
check(JSON.stringify(await leaves()) === JSON.stringify(sellGeneral), 'Menu brings the general menu back, as it was');

// Closing the head folds it; opening again starts on the general menu even after Sell's was open.
await page.click('#bud-modes .mode-nav-btn[data-mode="sell"]');
await page.click('#account-menu-toggle');
await page.waitForFunction(() => !document.getElementById('account-menu-panel').classList.contains('expanded'), null, { timeout: 5000 });
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded');
await page.waitForTimeout(300);
check(JSON.stringify(await leaves()) === JSON.stringify(sellGeneral), 'the bud opens on the general menu every time');
await page.click('#account-menu-toggle');

// The general menu is the same in Shop. Shop's petal opens no stem: it has nothing of its own.
await goToMode(page, 'shop');
await page.waitForSelector('body[data-mode="shop"][data-bud="on"]', { timeout: 30000 });
await page.waitForSelector('body.shop-ready', { timeout: 30000 }).catch(() => {});
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded');
await page.waitForTimeout(400);
const shopGeneral = await leaves();
console.log('Shop, general:', JSON.stringify(shopGeneral));
check(JSON.stringify(shopGeneral) === JSON.stringify(sellGeneral), 'the general menu is identical in Shop and in Sell');
await page.click('#bud-modes .mode-nav-btn[data-mode="shop"]');
await page.waitForTimeout(300);
check(JSON.stringify(await leaves()) === JSON.stringify(shopGeneral), "Shop's petal opens no stem of its own (it has no tools), so the general menu stays");

await finish(browser, { pass: pass && errors.length === 0, label: 'bud menus: four menus, one open at a time (#3760)', errors });
