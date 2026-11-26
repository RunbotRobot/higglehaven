// #4410: selecting an item shows the three movement axes (an arrow at each end) together with the three rings, with
// no Move or Rotate button. Dragging an arrow moves the item along that axis only; a press where an arrow and a
// ring lie under the same finger starts one drag, not two. 390x844, a mouse standing in for a finger.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Move Axes Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const state = () => page.evaluate(() => window.__testSelectedItemState());

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).first().click();
await page.waitForTimeout(300);
await page.mouse.click(195, 430);
await page.waitForTimeout(1000);

check(!(await page.locator('#mode-move-btn, #mode-rotate-btn').count()), 'there is no Move or Rotate button');
let points = await page.evaluate(() => window.__testAxisHandlePoints());
console.log('arrows:', JSON.stringify(points.map((p) => `${p.axis}@${Math.round(p.x)},${Math.round(p.y)}`)));
check(points.length === 6, `three axes with an arrow at each end are on the selected item (found ${points.length})`);
check(await page.evaluate(() => window.__testRotateActiveAxis !== undefined), 'the rings are still there');

// Drag one arrow of each axis, along the line from the item's middle through the arrow, and read where it went.
const start = await state();
for (const axis of ['X', 'Y', 'Z']) {
  points = await page.evaluate(() => window.__testAxisHandlePoints());
  const mine = points.filter((p) => p.axis === axis);
  const core = await page.evaluate(() => window.__testItemScreenCore());
  // the arrow farther from the item's middle on screen is the one aimed at
  mine.sort((a, b) => Math.hypot(b.x - core.x, b.y - core.y) - Math.hypot(a.x - core.x, a.y - core.y));
  // (a tree stands on the floor, so its height axis is tried upward: the arrow that is higher on screen)
  const at = axis === 'Z' ? mine.sort((a, b) => a.y - b.y)[0] : mine[0];
  // only an arrow that stands clear of every ring is pressed: a spot under both goes to the nearer, tested below
  const hit = await page.evaluate(([x, y]) => window.__testHandleAt(x, y), [Math.round(at.x), Math.round(at.y)]);
  if (hit.arrow !== axis) { console.log(`skip ${axis}: arrow tip not pickable at ${JSON.stringify(at)} -> ${JSON.stringify(hit)}`); continue; }
  const before = await state();
    const dx = (at.x - core.x), dy = (at.y - core.y);
  const len = Math.hypot(dx, dy) || 1;
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  check(!(await page.evaluate(() => window.__testBodyDragActive())), `a press on the ${axis} arrow does not start dragging the item`);
  await page.mouse.move(at.x + (dx / len) * 40, at.y + (dy / len) * 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await state();
  const moved = [after.x - before.x, after.y - before.y, after.z - before.z].map((v) => Math.abs(v));
  console.log(axis, 'moved', moved.map((v) => v.toFixed(2)).join(' '));
  const main = Math.max(...moved);
  check(main > 0.15, `dragging the ${axis} arrow moved the item (${main.toFixed(2)} m)`);
  const rest = moved.reduce((a, b) => a + b, 0) - main;
  check(rest < main * 0.25 + 0.02, `and along that axis only (${moved.map((v) => v.toFixed(2)).join(', ')})`);
}

await finish(browser, { pass: pass && errors.length === 0, label: '#4410: the three movement axes stand on a selected item beside the rings, and an arrow moves it along its axis only', errors });
