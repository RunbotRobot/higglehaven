// #3690 (part of #3654, Build in the bud): Undo and Redo are petals of the bud, drawn only while
// there is something to undo or redo; the level controls are the bud's Levels petal, which opens a
// leaf (no "Ground" pill, no standing dropdown). 390x844.
import { launchPage, chooseIdentity, claimLandlet, finish, openAccountMenu } from './helpers.mjs';

const LABEL = 'Build Bud Undo Levels';
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
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
}, selector);
const foldBud = () => page.keyboard.press('Escape');

// Nothing standing over the world for these: no pill, no Undo/Redo pair.
check(!(await shown('#level-menu-toggle')) && !(await page.locator('#level-menu-toggle').count()), 'there is no Ground pill');
check(!(await shown('#undo-btn')) && !(await shown('#redo-btn')) && !(await shown('#level-menu-panel')), 'Undo, Redo and the level menu are not standing on screen');

// Open bud, nothing done yet: Levels is a petal, Undo and Redo are not drawn.
await openAccountMenu(page);
check(await shown('#bud-petal-build-levels'), 'Levels is a petal');
check(!(await shown('#undo-btn')) && !(await shown('#redo-btn')), 'Undo and Redo are not drawn while there is nothing to undo or redo');
await foldBud();

// Place a Tree: now Undo is a petal.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid .catalog-tile').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(160, 380);
await page.waitForTimeout(1000);
await openAccountMenu(page);
check(await shown('#undo-btn') && !(await shown('#redo-btn')), 'after placing, Undo is a petal and Redo is not');
await page.click('#undo-btn');
await page.waitForTimeout(800);
await openAccountMenu(page);
check(await shown('#redo-btn'), 'after Undo, Redo is a petal');
check(!(await shown('#undo-btn')), 'with nothing left to undo, Undo is not drawn');
await foldBud();

// Levels: a leaf that says where you are, with Build above and Dig below; closes with its X.
await openAccountMenu(page);
await page.click('#bud-petal-build-levels');
await page.waitForSelector('#bud-leaf-levels #level-menu-panel.expanded', { timeout: 5000 });
check((await page.textContent('#bud-leaf-levels #level-label')).trim() === 'Ground', 'the leaf says "Ground"');
check(await shown('#level-build-btn') && await shown('#level-dig-btn'), 'the leaf has Build Level Above and Dig Level Below');
const leaf = await page.locator('#bud-leaf-levels').boundingBox();
check(leaf && leaf.x >= 0 && leaf.x + leaf.width <= 390 && leaf.y + leaf.height <= 844, `the leaf is inside the screen (${JSON.stringify(leaf)})`);
await page.click('#bud-leaf-levels .bud-leaf-close');
check((await page.locator('#bud-leaf-levels').count()) === 0, 'the leaf closes with its X');
check(!(await shown('#level-menu-panel')) && (await page.locator('#level-controls #level-menu-panel').count()) === 1, 'the level controls go back where they wait, out of sight');

// Opening the bud puts a leaf away.
await openAccountMenu(page);
await page.click('#bud-petal-build-levels');
await page.waitForSelector('#bud-leaf-levels', { timeout: 5000 });
await page.click('#account-menu-toggle');
await page.waitForTimeout(400);
check((await page.locator('#bud-leaf-levels').count()) === 0, 'opening the bud puts the leaf away');
check(await shown('#add-item-btn'), 'and the petals are not covered');

await finish(browser, { pass: pass && errors.length === 0, label: '#3690: Build in the bud: Undo/Redo are petals and Levels is a leaf', errors });
