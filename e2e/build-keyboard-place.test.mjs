// #4163 (part of #4158): placing an item from the keyboard in Build. The catalog's tiles are buttons, so Tab and
// Enter reach and choose one; the world then takes focus, and Enter places the item where the camera is looking
// (the same placing a tap does). Enter does nothing with no item chosen, and Enter on "Cancel placing" still
// cancels. 390x844.
import { launchPage, chooseIdentity, claimLandlet, finish, openBudMenuOf } from './helpers.mjs';

const LABEL = 'Build Keyboard Place';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const placed = () => page.evaluate(() => window.__testProductPositions().length);
const active = () => page.evaluate(() => {
  const el = document.activeElement;
  return { tag: el?.tagName, id: el?.id || '', label: el?.getAttribute?.('aria-label') || '' };
});
const addItemText = async () => (await page.textContent('#add-item-btn')).trim();

await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
await openBudMenuOf(page, 'build');
const before = await placed();

// 1. With nothing chosen, Enter on the world does nothing.
await page.focus('canvas');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
check((await placed()) === before, 'Enter on the world with no item chosen places nothing');

// 2. Open the catalog and choose an item from the keyboard.
await page.focus('#add-item-btn');
await page.keyboard.press('Enter');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid .catalog-tile').filter({ hasText: 'Tree' }).focus();
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
check((await addItemText()) === 'Cancel placing', 'choosing a tile by key starts placing');
const afterChoose = await active();
console.log('focus after choosing (should be the world):', JSON.stringify(afterChoose));
check(afterChoose.tag === 'CANVAS' && /press Enter to place/.test(afterChoose.label), 'focus is on the world, which says how to place');

// 3. Enter places it.
await page.keyboard.press('Enter');
await page.waitForFunction((n) => window.__testProductPositions().length > n, before, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(500);
const afterPlace = await placed();
console.log('placed items before/after:', before, afterPlace);
check(afterPlace === before + 1, 'Enter placed exactly one item');
check((await addItemText()) === 'Add item', 'after placing, the petal says "Add item" again');

// 4. Enter again places nothing more (nothing is chosen now).
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
check((await placed()) === afterPlace, 'a second Enter places nothing');

// 5. Enter on "Cancel placing" still cancels (the world only takes Enter when the world has focus).
if (!(await page.evaluate(() => document.getElementById('account-menu-panel').classList.contains('expanded')))) {
  await page.click('#account-menu-toggle');
  await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
}
await openBudMenuOf(page, 'build');
await page.focus('#add-item-btn');
await page.keyboard.press('Enter');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid .catalog-tile').filter({ hasText: 'Tree' }).focus();
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
// The flower folds once something is chosen; open it again to reach the petal that now says Cancel placing.
if (!(await page.evaluate(() => document.getElementById('account-menu-panel').classList.contains('expanded')))) {
  await page.click('#account-menu-toggle');
  await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
}
await openBudMenuOf(page, 'build');
check((await addItemText()) === 'Cancel placing', 'the petal says Cancel placing before the cancel');
await page.focus('#add-item-btn');
check((await active()).id === 'add-item-btn', 'focus is on the Cancel placing petal');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
check((await addItemText()) === 'Add item', 'Enter on Cancel placing cancels');
const finalCount = await placed(); console.log('placed after cancel:', finalCount, 'expected', afterPlace); check(finalCount === afterPlace, 'and places nothing');

await finish(browser, { pass: pass && errors.length === 0, label: '#4163: Build: choose an item from the keyboard and place it with Enter where the camera looks', errors });
