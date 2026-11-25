// #4025 (part of #3759, the flower), replacing #3760's four menus: three menus, one per place, and one
// row of icons along the top for what belongs to no place. One tap on the bud opens everything together:
// the three petals, the stem and leaves of the place the person is in, and the row (the account, Notices,
// Settings, Help). Friends and My purchases are in Shop's menu. There is no Menu petal.
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
const rowIds = () => page.evaluate(() => [...document.querySelectorAll('#bud-row button')]
  .filter((el) => getComputedStyle(el).display !== 'none' && !el.hidden).map((el) => el.id));
const ringState = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#bud-modes button')]
  .map((b) => [b.dataset.mode, b.getAttribute('aria-expanded')])));
const ROW = ['account-auth-btn', 'notifications-btn', 'settings-btn', 'bud-petal-row-help'];

async function openBud() {
  await page.click('#account-menu-toggle');
  await page.waitForSelector('#account-menu-panel.expanded');
  await page.waitForTimeout(500);
}
async function closeBud() {
  await page.click('#account-menu-toggle');
  await page.waitForFunction(() => !document.getElementById('account-menu-panel').classList.contains('expanded'), null, { timeout: 5000 });
  await page.waitForTimeout(700);
}

// One tap opens the petals, Sell's own stem and the row, together.
await openBud();
const ring = await page.evaluate(() => [...document.querySelectorAll('#bud-modes button')].map((b) => b.dataset.mode));
check(ring.length === 3 && ['shop', 'build', 'sell'].every((m) => ring.includes(m)), `three petals around the head and no Menu petal (${ring})`);
check((await page.locator('#bud-menu-general').count()) === 0, 'there is no Menu petal');
const sellStem = await leaves();
console.log('Sell stem:', JSON.stringify(sellStem));
check(sellStem.includes('bud-petal-sell-my-products') && sellStem.includes('bud-petal-sell-add-product'), "Sell's own menu is open: My products and Add a product");
check(!sellStem.includes('friends-btn') && !sellStem.includes('my-purchases-btn'), "Friends and My purchases are Shop's, not Sell's");
const sellRow = await rowIds();
console.log('Sell row:', JSON.stringify(sellRow));
check(ROW.every((id) => sellRow.includes(id)), 'the top row has the account, Notices, Settings and Help');
check(sellRow.every((id) => !sellStem.includes(id)), 'a row member is not also in the stem');
check((await ringState()).sell === 'true', "Sell's petal shows it is the open one");

const apart = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('#bud-modes button')].map((b) => b.getBoundingClientRect());
  const centres = boxes.map((b) => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 }));
  const distinct = centres.every((a, i) => centres.every((b, j) => i === j || Math.hypot(a.x - b.x, a.y - b.y) >= 34));
  return distinct && boxes.every((b) => b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight);
});
check(apart, 'the three petals do not touch each other and stay on screen');
const layout = await page.evaluate(() => {
  const r = (el) => el && el.getBoundingClientRect();
  const row = r(document.getElementById('bud-row'));
  const petals = [...document.querySelectorAll('#bud-modes button')].map(r);
  const hit = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const buttons = [...document.querySelectorAll('#bud-row button')].filter((b) => !b.hidden).map(r);
  return {
    rowOnScreen: row && row.left >= 0 && row.right <= innerWidth && row.top >= 0,
    rowClearOfPetals: petals.every((p) => !hit(row, p)),
    buttonsApart: buttons.every((a, i) => buttons.every((b, j) => i === j || !hit(a, b))),
    tall: Math.min(...buttons.map((b) => b.height)),
  };
});
check(layout.rowOnScreen && layout.rowClearOfPetals && layout.buttonsApart, `the row is on screen, clear of the petals, and its icons do not overlap (${JSON.stringify(layout)})`);
check(layout.tall >= 44, 'each row icon is at least 44px tall');
// #4199: the row draws no words, but each button keeps its word for a screen reader and as its title.
const rowWords = await page.evaluate(() => [...document.querySelectorAll('#bud-row button')].filter((b) => !b.hidden).map((b) => ({
  drawn: getComputedStyle(b).fontSize,
  title: b.title,
  name: [...b.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim(),
})));
check(rowWords.length >= 4 && rowWords.every((w) => w.drawn === '0px' && w.name && w.title === w.name), `the row draws no words and keeps each as its title (${JSON.stringify(rowWords)})`);
const stemBelowRing = await page.evaluate(() => {
  const ringBottom = Math.max(...[...document.querySelectorAll('#bud-modes button')].map((b) => b.getBoundingClientRect().bottom));
  return [...document.querySelectorAll('#account-menu-panel > button')].filter((b) => b.offsetParent !== null).every((b) => b.getBoundingClientRect().top >= ringBottom - 1);
});
check(stemBelowRing, 'the stem starts below the ring');

// The petal of the place you are in only marks where you are: nothing changes.
await page.click('#bud-modes .mode-nav-btn[data-mode="sell"]');
await page.waitForTimeout(300);
check(JSON.stringify(await leaves()) === JSON.stringify(sellStem), "Sell's own petal leaves its menu as it was");
check((await page.locator('#account-menu-panel.expanded').count()) === 1, 'the bud stays open');

// A second tap folds all of it; opening again opens the same.
await closeBud();
check((await page.locator('#bud-row').isVisible()) === false, 'the row folds with the flower');
await openBud();
check(JSON.stringify(await leaves()) === JSON.stringify(sellStem), 'it opens on the same menu every time');
await closeBud();

// Shop: Friends and My purchases, Chat; the same row.
await goToMode(page, 'shop');
await page.waitForSelector('body[data-mode="shop"][data-bud="on"]', { timeout: 30000 });
await page.waitForSelector('body.shop-ready', { timeout: 30000 }).catch(() => {});
await openBud();
const shopStem = await leaves();
console.log('Shop stem:', JSON.stringify(shopStem));
check(['friends-btn', 'my-purchases-btn', 'bud-petal-shop-chat'].every((id) => shopStem.includes(id)), "Shop's menu has Friends, My purchases and Chat");
check(!shopStem.some((id) => id.startsWith('bud-petal-sell-')), "Sell's tools are not in Shop's menu");
check(JSON.stringify(await rowIds()) === JSON.stringify(sellRow), 'the top row is identical in Shop and in Sell');
await closeBud();

await finish(browser, { pass: pass && errors.length === 0, label: 'bud menus: three menus and one row, opened together (#4025)', errors });
