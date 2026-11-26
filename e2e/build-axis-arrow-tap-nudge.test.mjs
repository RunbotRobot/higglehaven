// #4414 (the owner: "Let's move the nudge to the arrow on the movement axes. When you tap the arrow, it does the nudge
// in that direction"): a tap on the arrow at either end of a movement axis moves the selection one step that way, for
// one item and for a bundle, from two camera angles; a drag from the same arrow is still the axis move; one Undo takes
// a tap back; and the card carries no Nudge pad. 390x844.
import { launchPage, chooseIdentity, claimLandlet, finish, budClick } from './helpers.mjs';

const LABEL = 'Arrow Tap Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const positions = () => page.evaluate(() => window.__testProductPositions());
const STEP = 0.1; // a tenth of a metre in the default units
const arrows = () => page.evaluate(() => window.__testAxisHandlePoints());

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}

// Taps one arrow (by its axis and end) and returns how far each product moved, in world metres.
async function tap(axis, sign) {
  const before = await positions();
  const points = await arrows();
  const arrow = points.find((p) => p.axis === axis && p.sign === sign);
  if (!arrow) return { missing: true };
  await page.mouse.click(arrow.x, arrow.y);
  await page.waitForTimeout(450);
  const after = await positions();
  return { arrow, moves: after.map((a, i) => ({ x: a.x - before[i].x, y: a.y - before[i].y, z: a.z - before[i].z })) };
}
const along = (move, direction) => move.x * direction.x + move.y * direction.y + move.z * direction.z;
const sideways = (move, direction) => { const a = along(move, direction); return Math.hypot(move.x - a * direction.x, move.y - a * direction.y, move.z - a * direction.z); };

// ---- one item ---------------------------------------------------------------------------------------------------------
await placeTreeAt(160, 400);
check(await page.evaluate(() => !document.querySelector('[data-nudge]')), 'the card has no Nudge pad any more');
// lift it first so the downward arrows have room, then every arrow once
let r = await tap('Z', 1);
check(!r.missing && Math.abs(r.moves[0].z - STEP) < 0.011, `the up arrow lifts it a step (${r.moves?.[0].z})`);
r = await tap('Z', 1);
for (const [axis, sign] of [['X', 1], ['X', -1], ['Y', 1], ['Y', -1], ['Z', -1]]) {
  r = await tap(axis, sign);
  if (r.missing) { check(false, `an arrow at the ${sign > 0 ? '+' : '-'} end of ${axis} is there`); continue; }
  const move = r.moves[0];
  check(Math.abs(along(move, r.arrow.direction) - STEP) < 0.015 && sideways(move, r.arrow.direction) < 0.015, `a tap on ${sign > 0 ? '+' : '-'}${axis} moves one step along that arrow's way (${JSON.stringify(move)})`);
}

// Undo takes one tap back, in one press.
const beforeUndo = (await positions())[0];
await tap('X', 1);
const tapped = (await positions())[0];
await budClick(page, '#undo-btn');
await page.waitForTimeout(900);
const undone = (await positions())[0];
check(Math.hypot(undone.x - beforeUndo.x, undone.y - beforeUndo.y, undone.z - beforeUndo.z) < 0.011 && Math.hypot(tapped.x - beforeUndo.x, tapped.y - beforeUndo.y) > 0.05, 'one Undo takes a tap back to where it stood');

// A drag from the same arrow is still the axis move (not a nudge).
{
  const before = (await positions())[0];
  const arrow = (await arrows()).find((p) => p.axis === 'Y' && p.sign === 1);
  await page.mouse.move(arrow.x, arrow.y);
  await page.mouse.down();
  await page.mouse.move(arrow.x, arrow.y - 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = (await positions())[0];
  check(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) > 0.2, `a drag from an arrow moves it well past one step (${Math.hypot(after.x - before.x, after.y - before.y).toFixed(2)} m)`);
}

// The same taps from another camera angle: the arrow's own direction, not a fixed word.
await page.mouse.move(300, 600);
await page.mouse.down();
await page.mouse.move(120, 600, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(500);
{
  const r2 = await tap('X', 1);
  check(!r2.missing && Math.abs(along(r2.moves[0], r2.arrow.direction) - STEP) < 0.015, `from another camera angle a tap still moves one step along that arrow (${JSON.stringify(r2.moves?.[0])})`);
}

// ---- a bundle -----------------------------------------------------------------------------------------------------------
await page.mouse.click(60, 650);
await page.waitForTimeout(300);
await placeTreeAt(260, 330);
await page.mouse.click(60, 650);
await page.waitForTimeout(300);
const screenPositions = await page.evaluate(() => window.__testProductScreenPositions());
await page.click('#toggle-multiselect');
await page.waitForTimeout(200);
for (const p of screenPositions) { await page.mouse.click(p.x, p.y); await page.waitForTimeout(150); }
await page.waitForTimeout(300);
await page.click('#group-item');
await page.waitForTimeout(800);
await page.click('#toggle-multiselect');
await page.waitForTimeout(500);
check((await arrows()).length === 6, 'a bundle wears the three axes with an arrow at each end');
for (const [axis, sign] of [['X', 1], ['Y', -1], ['Z', 1]]) {
  const rb = await tap(axis, sign);
  if (rb.missing) { check(false, `the bundle has the ${sign > 0 ? '+' : '-'}${axis} arrow`); continue; }
  const ok = rb.moves.every((m) => Math.abs(along(m, rb.arrow.direction) - STEP) < 0.015 && sideways(m, rb.arrow.direction) < 0.015);
  check(ok, `a tap on the bundle's ${sign > 0 ? '+' : '-'}${axis} arrow moves every member one step together (${JSON.stringify(rb.moves)})`);
}

await finish(browser, { pass: pass && errors.length === 0, label: '#4414: a tap on an axis arrow nudges one step, for an item and a bundle', errors });
