// #3690 (Build in the bud, 3/6): in Build the interface is the bud. Undo and Redo are one petal
// with two halves, drawn only when there is something to undo or redo; Levels is a petal whose
// leaf says which level you are on with Build above and Dig below. The "Ground" pill and its
// dropdown, and the Undo/Redo pills in the top-right row, are gone. 390x844.
import { launchPage, chooseIdentity, claimLandlet, finish, openAccountMenu, budClick, openBudMenuOf } from './helpers.mjs';

// Open the bud only when it is closed: a petal's own click may or may not fold it.
const ensureBudOpen = async (page) => {
  const open = await page.evaluate(() => document.getElementById('account-menu-panel').classList.contains('expanded'));
  if (!open) await openAccountMenu(page);
  await openBudMenuOf(page, 'build'); // #3760: Undo/Redo and Levels are in Build's own menu
};

const LABEL = 'Bud Undo Levels Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const drawn = (selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}, selector);

// ---- The old controls are gone ----
check(await page.evaluate(() => document.body.dataset.bud) === 'on', 'Build has the bud');
check(!(await drawn('#mode-nav')), 'the old Shop/Build/Sell row is not drawn in Build');
check((await page.locator('#level-menu-toggle').count()) === 0, 'the "Ground" pill is gone');
// #4411: Undo and Redo stand as two small icons in one row at the upper right, always drawn, greyed when idle.
check(await drawn('#undo-redo-panel #undo-btn') && await drawn('#undo-redo-panel #redo-btn'), 'Undo and Redo are both drawn in the standing row');
check(await page.evaluate(() => document.getElementById('undo-btn').disabled && document.getElementById('redo-btn').disabled), 'both are greyed with nothing to undo or redo');
check(await page.evaluate(() => document.getElementById('undo-btn').getAttribute('aria-label') === 'Undo' && document.getElementById('redo-btn').getAttribute('aria-label') === 'Redo'), 'each has its accessible name');

// ---- Nothing to undo yet: no pair petal ----
await openAccountMenu(page);
await openBudMenuOf(page, 'build'); // #3760: Levels, Undo and Redo are in Build's own menu
check(await drawn('#bud-petal-build-levels'), 'the bud has a Levels petal');
check((await page.locator('#bud-undo-redo').count()) === 0, 'Undo and Redo are not a petal of the bud any more');
// Shop and Sell are petals of the bud in Build (the mode row is gone).
check(await drawn('.mode-nav-btn[data-mode="shop"]') && await drawn('.mode-nav-btn[data-mode="sell"]'), 'Shop and Sell are petals of the bud');
await page.click('#account-menu-toggle');

// ---- Place a tree: the pair petal appears, with Undo on ----
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(200, 420);
await page.waitForTimeout(1000);
check(await page.evaluate(() => !document.getElementById('undo-btn').disabled && document.getElementById('redo-btn').disabled), 'Undo is on and Redo stays greyed once something was placed');
await page.click('#undo-btn');
await page.waitForTimeout(1200);
check(await page.evaluate(() => document.getElementById('undo-btn').disabled && !document.getElementById('redo-btn').disabled), 'Redo is on after an Undo');
await page.click('#redo-btn');
await page.waitForTimeout(1200);
const afterRedo = await page.evaluate(() => window.__testProductScreenPositions().length);
check(afterRedo === 1, `Redo puts the tree back (${afterRedo} items)`);
const rowBox = await page.evaluate(() => { const r = document.getElementById('undo-redo-panel').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, h: document.getElementById('undo-btn').getBoundingClientRect().height }; });
check(rowBox.left >= 0 && rowBox.right <= 390 && rowBox.bottom <= 844 && rowBox.h >= 36, `the row is inside the screen and its icons are about 36 px (${JSON.stringify(rowBox)})`);

// ---- Levels leaf ----
await budClick(page, '#bud-petal-build-levels');
await page.waitForSelector('#bud-leaf-levels #level-menu-panel', { timeout: 5000 });
const leaf = await page.evaluate(() => {
  const leaf = document.getElementById('bud-leaf-levels');
  const inside = (id) => leaf.contains(document.getElementById(id));
  const box = leaf.getBoundingClientRect();
  return {
    line: leaf.querySelector('.bud-level-line')?.textContent.trim(),
    labelInside: inside('level-label'), panelInside: inside('level-menu-panel'),
    build: document.getElementById('level-build-btn').getBoundingClientRect().height > 0,
    dig: document.getElementById('level-dig-btn').getBoundingClientRect().height > 0,
    onScreen: box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight,
  };
});
check(leaf.line === 'You are on Ground', `the leaf says where you are (${leaf.line})`);
check(leaf.labelInside && leaf.panelInside && leaf.build && leaf.dig && leaf.onScreen, `the leaf holds the level label, Build level above and Dig level below, on screen (${JSON.stringify(leaf)})`);
await page.click('.bud-leaf-close');
const parked = await page.evaluate(() => {
  const home = document.getElementById('level-controls');
  return { gone: !document.getElementById('bud-leaf-levels'), labelHome: home.contains(document.getElementById('level-label')), panelHome: home.contains(document.getElementById('level-menu-panel')) };
});
check(parked.gone && parked.labelHome && parked.panelHome, `closing the leaf gives the level controls back (${JSON.stringify(parked)})`);
// Opening it again works (the elements were returned, not destroyed).
await budClick(page, '#bud-petal-build-levels');
await page.waitForSelector('#bud-leaf-levels #level-menu-panel', { timeout: 5000 });
check(await page.locator('#bud-leaf-levels #level-label').count() === 1, 'the leaf opens again with the label');

await finish(browser, { pass: pass && errors.length === 0, label: '#3690: Undo and Redo stand in one small row and Levels is a leaf; the pills are gone', errors });
