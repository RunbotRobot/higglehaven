// #4409 (owner, 2026-11-26): "We don't need a 'That's the edge of this lándlet' note... It should be obvious that
// that's the reason for horizontally not moving a product further." Dragging an item past the lándlet's edge stops it
// there and says nothing; nudging into the edge says nothing either. A limit a person cannot see still says so
// (the floor under a nudge). 390x844, a placed Tree.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Edge Quiet Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);


// #4414: the nudge is a tap on the arrow at one end of a movement axis (X is the item's left/right, Y forward/back,
// Z up/down); the real press lands on the arrow wherever the camera shows it.
const ARROWS = { left: ['X', -1], right: ['X', 1], forward: ['Y', 1], back: ['Y', -1], up: ['Z', 1], down: ['Z', -1] };
async function tapArrow(direction) {
  const [axis, sign] = ARROWS[direction];
  const point = (await page.evaluate(() => window.__testAxisHandlePoints())).find((p) => p.axis === axis && p.sign === sign);
  if (!point) throw new Error(`no arrow for ${direction}`);
  await page.mouse.click(point.x, point.y);
}

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const state = () => page.evaluate(() => window.__testSelectedItemState());
const status = () => page.evaluate(() => document.getElementById('selection-action-status-text').textContent.trim());

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(160, 380);
await page.waitForTimeout(900);
const start = await state();

// A long drag, several times in a row, out toward the far side until the item can go no further.
let last = start;
let settled = false;
const notesSeen = [];
for (let i = 0; i < 8 && !settled; i++) {
  const [pos] = await page.evaluate(() => window.__testProductScreenPositions());
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.down();
  await page.mouse.move(pos.x + 180, pos.y - 360, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const text = await status();
  if (text) notesSeen.push(text);
  const now = await state();
  settled = Math.hypot(now.x - last.x, now.y - last.y) < 0.01;
  last = now;
}
const travelled = Math.hypot(last.x - start.x, last.y - start.y);
console.log('the item travelled this far towards the edge (m):', travelled.toFixed(2), 'and rests at', last.x.toFixed(2), last.y.toFixed(2));
check(travelled > 3, `the drag moved the item a long way before it stopped (${travelled})`);
check(settled, 'and it came to rest (the last drag moved it nowhere)');
check(notesSeen.length === 0, `no drag that ran into the lándlet's edge said anything (${JSON.stringify(notesSeen)})`);

// At the corner, nudging outward is a press that goes nowhere. It used to say "That's the edge of this lándlet."
if (!(await page.isVisible('#item-card-nudge'))) await page.click('#item-card-more-btn');
await page.waitForSelector('#item-card-nudge:not([hidden])', { timeout: 5000 });
const blockedNotes = [];
let blockedPresses = 0;
for (const direction of ['left', 'right', 'forward', 'back', 'left', 'forward']) {
  const before = await state();
  await tapArrow(direction);
  await page.waitForTimeout(350);
  const after = await state();
  if (Math.hypot(after.x - before.x, after.y - before.y) < 0.05) {
    blockedPresses += 1;
    const text = await status();
    if (text) blockedNotes.push(`${direction}: ${text}`);
  }
}
console.log('presses that went nowhere at the corner:', blockedPresses, 'notes:', JSON.stringify(blockedNotes));
check(blockedPresses >= 1, `nudging outward at the corner goes nowhere (${blockedPresses} blocked presses)`);
check(blockedNotes.length === 0, `and says nothing about the edge (${JSON.stringify(blockedNotes)})`);

// A limit that cannot be seen still says so: a nudge down at the floor.
await tapArrow('down');
await page.waitForTimeout(300);
check(/already on the floor/.test(await status()), `a nudge into the floor still says why (${await status()})`);

await finish(browser, { pass, label: '#4409: an item stopped at the lándlet edge says nothing; an unseen limit still says why', errors: errors.filter((e) => !e.includes('Failed to load resource')) });
