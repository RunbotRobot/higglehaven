// #3577 (part of #3539, interface week): in Build, "All items" is a leaf that grows from the strip:
// the strip's width (not a 220 px column), a capped height with the world in view above it, Manual
// and Prompt on the header row beside the close button, Search and the All | Products | Bundles chips
// on one row that stays on top, and ONE scrolling region under it. Manual, Prompt, the scope chips
// and the strip behave as before. 390x844.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Build Catalog Leaf';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const box = (selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
}, selector);

async function openStrip() {
  if (!(await page.locator('#account-menu-panel.expanded').count())) await page.click('#account-menu-toggle');
  await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible.strip', { timeout: 10000 });
  await page.waitForTimeout(300);
}

await openStrip();
const stripBox = await box('#catalog-picker');
await page.click('#catalog-all-items-btn');
await page.waitForSelector('#catalog-picker.visible:not(.strip)', { timeout: 5000 });
await page.waitForTimeout(400);

// Width: the strip's width, not a narrow column; and it stays on screen.
const leaf = await box('#catalog-picker');
check(Math.abs(leaf.w - stripBox.w) < 2, `the full catalog is as wide as the strip (${Math.round(leaf.w)} against ${Math.round(stripBox.w)})`);
check(leaf.w >= 330 && leaf.r <= 390, `it is wide and on screen (${Math.round(leaf.w)}px wide, right edge ${Math.round(leaf.r)})`);

// Height: capped, so the world stays in view above it (the old panel was about 466 px tall).
check(leaf.h <= 844 * 0.31, `its height is capped (${Math.round(leaf.h)}px of 844)`);
check(leaf.y >= 844 * 0.5, `more than half of the screen above it is still world (it starts at ${Math.round(leaf.y)}px)`);

// Header row: Manual and Prompt beside the close button, not a row of their own.
const tabs = await box('#catalog-mode-tabs');
const close = await box('#catalog-picker-close-btn');
const search = await box('#catalog-search-input');
check(Math.abs((tabs.y + tabs.h / 2) - (close.y + close.h / 2)) <= 8, 'Manual and Prompt share the header row with the close button');
check(close.r > leaf.r - 24 && close.y < leaf.y + 20, 'the close button is in the upper-right corner');
check(tabs.b <= search.y, 'Search is below the tabs');

// Search and the scope chips are one row.
const scope = await box('#catalog-search-scope-tabs');
check(Math.abs((search.y + search.h / 2) - (scope.y + scope.h / 2)) <= 6, 'Search and the All | Products | Bundles chips are on one row');
check(scope.x >= search.r - 1, 'the chips sit to the right of Search');
const chipLabels = await page.$$eval('#catalog-search-scope-tabs .search-scope-btn', (els) => els.map((e) => `${e.textContent.trim()}:${e.dataset.searchScope}`));
check(chipLabels.join(',') === 'All:both,Products:products,Bundles:bundles', `the chips keep their words and scopes (${chipLabels.join(',')})`);

// One scrolling region: the grid does not scroll by itself; the manual region does, and Search stays on top.
const scrolling = await page.evaluate(() => {
  const picker = document.getElementById('catalog-picker');
  const regions = [];
  for (const el of [picker, ...picker.querySelectorAll('*')]) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) regions.push(el.id || el.className);
  }
  return regions;
});
check(scrolling.length === 1 && scrolling[0] === 'catalog-manual-mode', `exactly one scrolling region, the manual one (${JSON.stringify(scrolling)})`);
const rowTop = (await box('#catalog-search-row')).y;
await page.evaluate(() => { document.getElementById('catalog-manual-mode').scrollTop = 120; });
await page.waitForTimeout(150);
const rowAfter = (await box('#catalog-search-row')).y;
check(Math.abs(rowAfter - rowTop) < 1, `Search stays on top while the grid scrolls (${Math.round(rowTop)} then ${Math.round(rowAfter)})`);
await page.evaluate(() => { document.getElementById('catalog-manual-mode').scrollTop = 0; });

// The chips still narrow the list.
await page.click('.search-scope-btn[data-search-scope="products"]');
check(await page.evaluate(() => document.querySelector('.search-scope-btn[data-search-scope="products"]').classList.contains('active')), 'Products becomes the active scope');
await page.click('.search-scope-btn[data-search-scope="both"]');

// Prompt mode still opens inside the leaf, whole, and Manual brings the catalog back.
await page.click('.catalog-mode-tab-btn[data-catalog-mode="prompt"]');
await page.waitForTimeout(300);
const promptState = await page.evaluate(() => {
  const picker = document.getElementById('catalog-picker').getBoundingClientRect();
  const field = document.getElementById('prompt-mode-input').getBoundingClientRect();
  const manual = document.getElementById('catalog-manual-mode');
  return { manualHidden: manual.hidden || getComputedStyle(manual).display === 'none', fieldInside: field.width > 0 && field.bottom <= picker.bottom + 1 && field.top >= picker.top };
});
check(promptState.manualHidden, 'Prompt hides the manual catalog');
check(promptState.fieldInside, 'the Prompt box is inside the leaf');
await page.click('.catalog-mode-tab-btn[data-catalog-mode="manual"]');
await page.waitForTimeout(300);
check(!!(await box('#catalog-picker-grid')), 'Manual brings the products back');

// A product can still be picked from the leaf: it arms placement.
await page.locator('#catalog-picker-grid .catalog-tile').first().click();
await page.waitForTimeout(400);
check((await page.textContent('#add-item-btn')).trim() === 'Cancel placing', 'picking a product from the leaf arms placement');
await page.click('#add-item-btn');
await page.waitForTimeout(300);

// The strip is unchanged: no chips or tabs, Search across the whole line.
await openStrip();
check(!(await box('#catalog-search-scope-tabs')) && !(await box('#catalog-mode-tabs')), 'the strip has no tabs or chips');
const stripSearch = await box('#catalog-search-input');
const stripNow = await box('#catalog-picker');
check(stripSearch.w >= stripNow.w - 40, `in the strip Search takes the whole line (${Math.round(stripSearch.w)} of ${Math.round(stripNow.w)})`);
check(stripNow.h < 260, `the strip is still short (${Math.round(stripNow.h)}px)`);

await finish(browser, { pass: pass && errors.length === 0, label: '#3577: "All items" is a leaf at the strip\'s width and a capped height, one scrolling region', errors });
