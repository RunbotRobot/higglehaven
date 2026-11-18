// #3691 (Build in the bud, 4/6): Measure, Multi-Select (with its Brush slider) and Paste are the
// Tools petal's leaf, not buttons over the world. Choosing a tool puts the leaf away and the bud
// wears the tool's name until it is off; Paste is listed only after a Copy. 390x844.
import { launchPage, chooseIdentity, claimLandlet, finish, budClick } from './helpers.mjs';

const LABEL = 'Bud Tools Tester';
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
const word = () => page.evaluate(() => document.querySelector('#account-menu-toggle .bud-word')?.textContent.trim());
const home = (id) => page.evaluate((sel) => document.getElementById('tool-controls')?.contains(document.getElementById(sel)), id);
const openTools = async () => {
  await budClick(page, '#bud-petal-build-tools');
  await page.waitForSelector('#bud-leaf-tools', { timeout: 5000 });
};

// ---- The old controls are not drawn over the world ----
for (const id of ['#toggle-multiselect', '#toggle-measure', '#paste-btn', '#multiselect-brush-control']) {
  check(!(await drawn(id)), `${id} is not drawn over the world`);
}
check((await page.locator('#add-item-panel #toggle-multiselect').count()) === 0, 'Multi-Select is no longer in the Add item panel');

// ---- The petal and its leaf ----
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
check(await drawn('#bud-petal-build-tools'), 'the bud has a Tools petal');
await page.click('#bud-petal-build-tools');
await page.waitForSelector('#bud-leaf-tools', { timeout: 5000 });
const leaf = await page.evaluate(() => {
  const leaf = document.getElementById('bud-leaf-tools');
  const box = leaf.getBoundingClientRect();
  const inside = (id) => leaf.contains(document.getElementById(id));
  return {
    multi: inside('toggle-multiselect'), measure: inside('toggle-measure'),
    multiDrawn: document.getElementById('toggle-multiselect').getBoundingClientRect().height > 0,
    measureDrawn: document.getElementById('toggle-measure').getBoundingClientRect().height > 0,
    onScreen: box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight,
  };
});
check(leaf.multi && leaf.measure && leaf.multiDrawn && leaf.measureDrawn, `the leaf holds Multi-Select and Measure, drawn (${JSON.stringify(leaf)})`);
check(leaf.onScreen, 'the leaf is inside the screen');
check(!(await drawn('#paste-btn')), 'Paste is not listed before a Copy');
check(!(await drawn('#multiselect-brush-control')), 'the Brush slider is not shown while Multi-Select is off');
await page.click('.bud-leaf-close');
check(await home('toggle-multiselect') && await home('toggle-measure') && await home('paste-btn') && await home('multiselect-brush-control'), 'closing the leaf hands the controls back');
check((await word()) === 'Menu', `the bud says Menu with no tool on (${await word()})`);

// ---- Selecting: choosing it puts the leaf away, the bud wears its name, the brush is in the leaf ----
await page.click('#toggle-multiselect');
await page.waitForTimeout(300);
check((await page.locator('#bud-leaf-tools').count()) === 0, 'choosing Multi-Select puts the leaf away');
check((await word()) === 'Selecting', `the bud wears "Selecting" (${await word()})`);
check(await page.evaluate(() => document.getElementById('toggle-multiselect').getAttribute('aria-pressed')) === 'true', 'Multi-Select is on');
await openTools();
check(await drawn('#multiselect-brush-control') && await drawn('#multiselect-brush-size-input'), 'the Brush slider is in the leaf while Multi-Select is on');
await page.click('.bud-leaf-close');
await page.click('#toggle-multiselect'); // off again (the wrapper reopens the leaf)
await page.waitForTimeout(300);
check((await word()) === 'Menu', `the bud goes back to Menu when Multi-Select is off (${await word()})`);

// ---- Measuring ----
await page.click('#toggle-measure');
await page.waitForTimeout(300);
check((await word()) === 'Measuring', `the bud wears "Measuring" (${await word()})`);
check((await page.locator('#bud-leaf-tools').count()) === 0, 'choosing Measure puts the leaf away');
await page.click('#toggle-measure');
await page.waitForTimeout(300);
check((await word()) === 'Menu', 'Measure off: Menu again');

// ---- Paste: listed once something is copied ----
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(200, 420);
await page.waitForTimeout(1000);
await page.click('#copy-item');
await page.waitForTimeout(400);
await openTools();
check(await drawn('#paste-btn'), 'Paste is listed after a Copy');
await page.click('#paste-btn');
await page.waitForTimeout(800);
check((await page.locator('#bud-leaf-tools').count()) === 0, 'choosing Paste puts the leaf away');
const placed = await page.evaluate(() => window.__testProductScreenPositions().length);
check(placed === 2, `Paste put a copy next to the tree (${placed} items)`);

await finish(browser, { pass: pass && errors.length === 0, label: '#3691: Measure, Multi-Select and Paste are the bud\'s Tools petal', errors });
