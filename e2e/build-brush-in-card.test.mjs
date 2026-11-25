// #3691 (Build in the bud, 4/6, the last piece): while Selecting is on and the card shows the
// painted selection, the brush's size slider is in the card, beside what is selected, not only in
// the Tools leaf. A real press on it adjusts the brush without adding to or clearing the
// selection, and turning Selecting off hands it back. 390x844, a mouse standing in for a finger
// (the same input the other Build e2e files use).
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Brush In Card Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}
const inCard = () => page.evaluate(() => document.getElementById('item-card-brush')?.contains(document.getElementById('multiselect-brush-control')));
const inHome = () => page.evaluate(() => document.getElementById('tool-controls')?.contains(document.getElementById('multiselect-brush-control')));
const drawn = (selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
}, selector);
const title = () => page.textContent('#item-card-name');

await placeTreeAt(120, 420);
await placeTreeAt(220, 420);
await page.mouse.click(60, 600); // clear the selection the last placement left
await page.waitForTimeout(300);
const [posA, posB] = await page.evaluate(() => window.__testProductScreenPositions());

check(!(await inCard()) && await inHome(), 'before Selecting, the slider waits in the tool controls');

await page.click('#toggle-multiselect');
await page.waitForTimeout(300);
check(!(await inCard()), 'Selecting on with nothing selected: no card yet, so the slider is not in a card');

await page.mouse.move(posA.x, posA.y);
await page.mouse.down();
await page.mouse.move(posB.x, posB.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
check((await title()).includes('2 items selected'), `two items are selected (${await title()})`);
check(await inCard(), 'the slider is in the card beside the selection');
check(await drawn('#multiselect-brush-size-input'), 'the slider is drawn in the card');
// The slider wears the brand green, not the browser's blue (the #4275 walk).
const sliderAccent = await page.evaluate(() => getComputedStyle(document.getElementById('multiselect-brush-size-input')).accentColor);
check(sliderAccent && sliderAccent !== 'auto', `the slider takes the brand's accent colour, not the browser's (${sliderAccent})`);
const geometry = await page.evaluate(() => {
  const card = document.getElementById('item-card').getBoundingClientRect();
  const slider = document.getElementById('multiselect-brush-size-input').getBoundingClientRect();
  return { inside: slider.left >= card.left - 1 && slider.right <= card.right + 1 && slider.top >= card.top - 1 && slider.bottom <= card.bottom + 1, onScreen: slider.left >= 0 && slider.right <= window.innerWidth };
});
check(geometry.inside && geometry.onScreen, `the slider sits inside the card and on screen (${JSON.stringify(geometry)})`);

// A real press on the slider changes the brush and leaves the selection alone.
const before = await page.textContent('#multiselect-brush-size-label');
const box = await page.locator('#multiselect-brush-size-input').boundingBox();
await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
await page.waitForTimeout(300);
const after = await page.textContent('#multiselect-brush-size-label');
check(before !== after, `pressing the slider changes the brush size (${before} to ${after})`);
check((await title()).includes('2 items selected'), `pressing the slider leaves the selection as it was (${await title()})`);

// The Tools leaf does not take it away from the card.
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
await page.click('#bud-petal-build-tools');
await page.waitForSelector('#bud-leaf-tools', { timeout: 5000 });
check(await inCard(), 'opening the Tools leaf leaves the slider in the card');
await page.click('.bud-leaf-close');
await page.waitForTimeout(300);
check(await inCard(), 'closing the Tools leaf leaves the slider in the card');

// Selecting off: the slider goes home, the card has its full actions back.
await page.click('#toggle-multiselect');
await page.waitForTimeout(400);
check(!(await inCard()) && await inHome(), 'Selecting off hands the slider back');
check(!(await drawn('#multiselect-brush-control')), 'the slider is not drawn with Selecting off');
check(await drawn('#copy-item'), 'the card has Copy back with Selecting off');

await finish(browser, { pass: pass && errors.length === 0, label: '#3691: the Selecting brush size slider is in the card beside the selection, adjustable without touching the selection', errors });
