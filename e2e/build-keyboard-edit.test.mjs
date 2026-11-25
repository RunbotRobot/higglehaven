// #4161 (leaf 3 of #4158): Delete and undo/redo from the keyboard in Build. A key does what the button
// of the same name does: Delete removes the selected item (and Undo brings it back), Ctrl+Z undoes,
// Ctrl+Shift+Z redoes, and nothing happens while a field has focus.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Build Edit Keys Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const cardShown = () => page.evaluate(() => { const el = document.getElementById('item-card'); return !el.hidden && el.getBoundingClientRect().height > 0; });
const select = async () => { await page.evaluate(() => window.__testSelectAllProducts()); await page.waitForTimeout(400); };

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(160, 380);
await page.waitForTimeout(1200);
check(await cardShown(), 'a Tree is placed and selected');

// Delete removes it.
await page.keyboard.press('Delete');
await page.waitForTimeout(600);
check(!(await cardShown()), 'Delete removes the selected item and the card goes');
await select();
check(!(await cardShown()), 'nothing is left to select');

// Ctrl+Z brings it back.
await page.keyboard.press('Control+z');
await page.waitForTimeout(900);
await select();
check(await cardShown(), 'Ctrl+Z undoes the delete');

// Ctrl+Shift+Z deletes it again.
await page.keyboard.press('Control+Shift+Z');
await page.waitForTimeout(900);
await select();
check(!(await cardShown()), 'Ctrl+Shift+Z redoes it');
await page.keyboard.press('Control+z');
await page.waitForTimeout(900);
await select();
check(await cardShown(), 'and Ctrl+Z brings it back again');

// Backspace deletes too, but not while a field has focus.
await page.evaluate(() => {
  const input = document.createElement('input');
  input.id = 'kb-edit-field';
  document.body.appendChild(input);
  input.focus();
});
await page.keyboard.press('Backspace');
await page.keyboard.press('Delete');
await page.waitForTimeout(500);
await select();
check(await cardShown(), 'keys typed in a field do not delete the selection');
await page.evaluate(() => document.getElementById('kb-edit-field').remove());
await page.evaluate(() => document.body.focus());
await page.keyboard.press('Backspace');
await page.waitForTimeout(600);
check(!(await cardShown()), 'Backspace deletes it when nothing else has the keys');

await finish(browser, { pass: pass && errors.length === 0, label: '#4161: Delete, undo and redo work from the keyboard in Build', errors });
