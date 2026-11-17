// #3688 (part of #3654, Build in the bud): in Build the old top row is gone and the interface is
// the bud; "Add item" is a petal of it (no separate button over the world); it opens the catalog
// as a short strip (a search line and one row of items, recent ones first), and "All items" opens
// the whole catalog. 390x844.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Build Bud Add Item';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const shown = (selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}, selector);

// Resting Build: the bud, and none of the old row or the old Add Item button.
check(await page.evaluate(() => document.body.dataset.bud) === 'on', 'Build has the bud');
check(await shown('#account-menu-toggle'), 'the bud is on screen');
check(!(await shown('#mode-nav')) && !(await shown('#wordmark-panel')), 'the old top row (wordmark and mode buttons) is gone in Build');
check(!(await shown('#add-item-btn')), 'Add item is not drawn over the world while the bud is closed');

// Open the bud: Add item is a petal, with Shop and Sell beside the account rows.
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
check(await shown('#add-item-btn'), 'Add item is a petal of the open bud');
check((await page.textContent('#add-item-btn')).trim() === 'Add item', 'its words are "Add item"');
check(await shown('.mode-nav-btn[data-mode="shop"]') && await shown('.mode-nav-btn[data-mode="sell"]'), 'Shop and Sell are petals');

// The catalog opens as a strip.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible.strip', { timeout: 10000 });
check(await page.evaluate(() => document.getElementById('catalog-picker').classList.contains('strip')), 'the catalog opens as a strip');
check(await shown('#catalog-search-input') && await shown('#catalog-all-items-btn'), 'the strip has a search line and "All items"');
check(!(await shown('#catalog-search-scope-tabs')) && !(await shown('#catalog-mode-tabs')), 'the tabs and scopes are not in the strip');
const strip = await page.evaluate(() => {
  const picker = document.getElementById('catalog-picker').getBoundingClientRect();
  const tiles = [...document.querySelectorAll('#catalog-picker-grid .catalog-tile')].map((t) => t.getBoundingClientRect().top);
  return { height: picker.height, oneRow: new Set(tiles.map((t) => Math.round(t))).size === 1, count: tiles.length };
});
check(strip.oneRow && strip.count >= 2, `the items are one row (${JSON.stringify(strip)})`);
check(strip.height < 260, `the strip is short (${Math.round(strip.height)}px)`);

// Placing: pick the last item in catalog order, Tree. The petal then says Cancel placing.
await page.locator('#catalog-picker-grid .catalog-tile').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
check((await page.textContent('#add-item-btn')).trim() === 'Cancel placing', 'while placing, the petal says "Cancel placing"');
await page.mouse.click(160, 380);
await page.waitForTimeout(1000);
check((await page.textContent('#add-item-btn')).trim() === 'Add item', 'after placing, the petal says "Add item" again');

// Recent first: Tree was used, so it leads the strip now.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible.strip', { timeout: 10000 });
const first = await page.evaluate(() => [...document.querySelectorAll('#catalog-picker-grid .catalog-tile')]
  .sort((a, b) => Number(getComputedStyle(a).order) - Number(getComputedStyle(b).order))[0].textContent.trim());
check(first.startsWith('Tree'), `the item just used leads the strip (first: ${first})`);

// All items opens the whole catalog.
await page.click('#catalog-all-items-btn');
await page.waitForTimeout(300);
check(!(await page.evaluate(() => document.getElementById('catalog-picker').classList.contains('strip'))), 'All items leaves the strip');
check(await shown('#catalog-search-scope-tabs') && await shown('#catalog-mode-tabs'), 'the whole catalog has its tabs and scopes');

await finish(browser, { pass: pass && errors.length === 0, label: '#3688: Build in the bud: Add item is a petal and the catalog is a strip', errors });
