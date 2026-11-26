// #3689 (Build in the bud, slice a): under the item card's More, a Nudge pad (Left, Right, Forward, Back in
// the item's own turned axes; Up and Down vertical) with the height shown, and an Angles block (Turn and the
// two Tilts, typed in degrees). Both go through the same path as a drag: undo restores, a press that cannot
// move says why, and the blocks are left out unless exactly one item is selected. Phone width.
import { launchPage, chooseIdentity, claimLandlet, finish, budClick } from './helpers.mjs';

const LABEL = 'Nudge Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const state = () => page.evaluate(() => window.__testSelectedItemState());
const near = (a, b, eps = 0.011) => Math.abs(a - b) <= eps;
const status = () => page.evaluate(() => document.getElementById('selection-action-status-text').textContent.trim());

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(160, 380);
await page.waitForTimeout(800);

const blocksHidden = () => page.evaluate(() => document.getElementById('item-card-nudge').hidden && document.getElementById('item-card-angles').hidden);
check(!(await blocksHidden()), 'one selected item: the Nudge and Angles blocks exist in the card');
if (!(await page.isVisible('#item-card-nudge'))) await page.click('#item-card-more-btn');
await page.waitForSelector('#item-card-nudge:not([hidden])', { timeout: 5000 });
if (process.env.E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/card-more-open.png` });
const h0 = await page.textContent('#nudge-height-readout');
check(/^Height 0(\.00)?\s?(m|ft)?$/.test(h0.trim()), `a freshly placed item reads Height 0 (${h0})`);

const s0 = await state();
await page.click('[data-nudge="up"]');
await page.waitForTimeout(250);
const sUp = await state();
check(near(sUp.z - s0.z, 0.1), `Up lifts it a tenth of a metre (${sUp.z - s0.z})`);
check(/Height 0\.10/.test(await page.textContent('#nudge-height-readout')), `and the height reads it (${await page.textContent('#nudge-height-readout')})`);
await page.click('[data-nudge="down"]');
await page.waitForTimeout(250);
check(near((await state()).z, s0.z), 'Down puts it back on the floor');
await page.click('[data-nudge="down"]');
await page.waitForTimeout(250);
check(near((await state()).z, s0.z), 'Down again cannot go through the floor');
check(/already on the floor/.test(await status()), `and says why (${await status()})`);

for (let i = 0; i < 3; i++) { await page.click('[data-nudge="right"]'); await page.waitForTimeout(150); }
await page.waitForTimeout(250);
const sR = await state();
check(near(sR.x - s0.x, 0.3) && near(sR.y, s0.y), `Right three times slides it 0.3 m along its own axis (${JSON.stringify({ dx: sR.x - s0.x, dy: sR.y - s0.y })})`);

// Undo takes a nudge back like any move (the item stays selected across it).
await budClick(page, '#undo-btn');
await page.waitForTimeout(1000);
await page.waitForTimeout(500); // #4411: Undo is a standing button now, so there is no bud to fold (Escape would deselect)
const sU = await state();
check(sU && near(sU.x, sR.x - 0.1), `Undo takes the last nudge back (${sU?.x} vs ${sR.x - 0.1})`);
if (!(await page.isVisible('#item-card-nudge'))) await page.click('#item-card-more-btn');

// Typed angles: a quarter turn.
await page.fill('#angle-turn', '90');
await page.dispatchEvent('#angle-turn', 'change');
await page.waitForTimeout(400);
const sT = await state();
check(near(sT.turn, 90, 0.2), `typing 90 in Turn turns it a quarter (${sT.turn})`);
// ...and the nudges follow the turned axes: Forward is now along the world's -X.
const before = await state();
await page.click('[data-nudge="forward"]');
await page.waitForTimeout(250);
const after = await state();
check(near(after.x - before.x, -0.1) && near(after.y, before.y), `after a quarter turn Forward slides along the turned axis (${JSON.stringify({ dx: after.x - before.x, dy: after.y - before.y })})`);
// A tilt typed in.
await page.fill('#angle-tilt-red', '20');
await page.dispatchEvent('#angle-tilt-red', 'change');
await page.waitForTimeout(400);
check(near((await state()).tiltRed, 20, 0.2), 'typing a Tilt tilts it');
// Nonsense is put back, not applied.
await page.fill('#angle-turn', '');
await page.dispatchEvent('#angle-turn', 'change');
await page.waitForTimeout(400);
check(near((await state()).turn, 90, 0.2), 'an empty field leaves the turn as it was');

// Two items selected: no nudge, no angles.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(260, 330);
await page.waitForTimeout(800);
await page.evaluate(() => window.__testSelectAllProducts());
await page.waitForTimeout(400);
check(await blocksHidden(), 'several selected: the Nudge and Angles blocks are left out');

await finish(browser, { pass: pass && errors.length === 0, label: '#3689: card Nudge pad and Angles block (slice a)', errors });
