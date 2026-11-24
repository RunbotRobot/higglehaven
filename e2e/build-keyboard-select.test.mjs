// #4160 (part of #4158, Build from a keyboard 2/5): N steps through the placed items and selects each one, Shift+N
// goes back, Escape lets go, and a polite live region says what is selected and where it stands in the walk.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Build Key Select Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}
await placeTreeAt(110, 380);
await placeTreeAt(210, 380);
await placeTreeAt(310, 380);
await page.mouse.click(60, 600); // clear the auto-selection of the last placement
await page.waitForTimeout(300);

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const selectedCount = () => page.evaluate(() => window.__testSelectionBoxes().length);
const status = () => page.textContent('#build-select-status');

check((await selectedCount()) === 0, 'nothing is selected to start with');
await page.keyboard.press('n');
await page.waitForTimeout(300);
check((await selectedCount()) === 1, 'N selects one item');
const first = await status();
check(/, 1 of 3$/.test(first), `the live region says which (${first})`);
await page.keyboard.press('n');
await page.waitForTimeout(200);
check(/, 2 of 3$/.test(await status()), 'N again goes on to the second');
await page.keyboard.press('n');
await page.keyboard.press('n');
await page.waitForTimeout(200);
check(/, 1 of 3$/.test(await status()), 'it wraps from the last back to the first');
await page.keyboard.press('Shift+N');
await page.waitForTimeout(200);
check(/, 3 of 3$/.test(await status()), 'Shift+N goes back, wrapping to the last');
check((await selectedCount()) === 1, 'still exactly one item selected');

await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check((await selectedCount()) === 0, 'Escape lets go of the selection');
check((await status()) === 'Nothing selected', 'and the live region says so');

// Typing in a field is never a step.
await page.evaluate(() => { const i = document.createElement('input'); i.id = 'e2e-field'; document.body.appendChild(i); i.focus(); });
await page.keyboard.press('n');
await page.waitForTimeout(200);
check((await selectedCount()) === 0, 'an n typed in a field selects nothing');

await finish(browser, { pass: failures.length === 0 && errors.length === 0, label: 'Build: N steps through placed items, Escape lets go (#4160)', errors });
