// #3689 (Build in the bud, slice a), as #4414 changed it: a tap on an arrow of the movement axes nudges (X, Y in
// the item's own turned axes; Z vertical) and the card's More shows the height, and an Angles block (Turn and the
// two Tilts, typed in degrees). Both go through the same path as a drag: undo restores, a press that cannot
// move says why, and the blocks are left out unless exactly one item is selected. Phone width.
import { launchPage, chooseIdentity, claimLandlet, finish, budClick } from './helpers.mjs';

const LABEL = 'Nudge Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);


// #4414: the nudge is a tap on the arrow at one end of a movement axis (X is the item's left/right, Y forward/back,
// Z up/down); the real press lands on the arrow wherever the camera shows it.
const ARROWS = { left: ['X', -1], right: ['X', 1], forward: ['Y', 1], back: ['Y', -1], up: ['Z', 1], down: ['Z', -1] };
async function tapArrow(direction) {
  const [axis, sign] = ARROWS[direction];
  const points = await page.evaluate(() => window.__testAxisHandlePoints());
  const arrow = points.find((p) => p.axis === axis && p.sign === sign);
  if (!arrow) throw new Error(`no arrow for ${direction}`);
  // A ring can pass under an arrow's tip (the nearer handle wins the press, a tie goes to the ring): aim at a point
  // on the arrow where no ring lies, as a finger would.
  const cx = points.reduce((a, p) => a + p.x, 0) / points.length;
  const cy = points.reduce((a, p) => a + p.y, 0) / points.length;
  const ox = arrow.x - cx; const oy = arrow.y - cy; const ol = Math.hypot(ox, oy) || 1;
  for (let k = -6; k <= 14; k++) {
    const x = Math.round(arrow.x + (ox / ol) * k * 2); const y = Math.round(arrow.y + (oy / ol) * k * 2);
    const hit = await page.evaluate(([a, b]) => window.__testHandleAt(a, b), [x, y]);
    if (hit.arrow === axis && !hit.ring) { await page.mouse.click(x, y); return; }
  }
  throw new Error(`no clear point on the arrow for ${direction}`);
}

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
check(/^0(\.00)?\s?(m|ft)?$/.test(h0.trim()), `a freshly placed item reads a height of 0 (${h0})`);

const s0 = await state();
await tapArrow('up');
await page.waitForTimeout(250);
const sUp = await state();
check(near(sUp.z - s0.z, 0.1), `Up lifts it a tenth of a metre (${sUp.z - s0.z})`);
check(/^0\.10/.test(await page.textContent('#nudge-height-readout')), `and the height reads it (${await page.textContent('#nudge-height-readout')})`);
await tapArrow('down');
await page.waitForTimeout(250);
check(near((await state()).z, s0.z), 'Down puts it back on the floor');
await tapArrow('down');
await page.waitForTimeout(250);
check(near((await state()).z, s0.z), 'Down again cannot go through the floor');
check(/already on the floor/.test(await status()), `and says why (${await status()})`);

for (let i = 0; i < 3; i++) { await tapArrow('right'); await page.waitForTimeout(150); }
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
await tapArrow('forward');
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
