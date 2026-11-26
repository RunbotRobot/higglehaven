// #4410: a touch that starts on a rotation ring wins over the item's body. The tilt rings pass over the item, and
// a press on one of them where it crosses the item used to start a free move of the item instead (the owner:
// "trying to rotate using the rotation handles often accidentally selects the item to move freely instead").
// Away from the item's middle the ring is now the ring's; the middle is still the item's. 390x844, real mouse
// events, a mouse standing in for a finger.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Ring Over Body Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const state = () => page.evaluate(() => window.__testSelectedItemState());
const axisNow = () => page.evaluate(() => window.__testRotateActiveAxis());

// Zoom in on the tree until it is big on screen, so a tilt ring passes over its body (at the default view the
// rings round a small item are wider than the item).
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).first().click();
await page.waitForTimeout(300);
await page.mouse.click(195, 430);
await page.waitForTimeout(1000);
let core = await page.evaluate(() => window.__testItemScreenCore());
for (let i = 0; i < 8 && core && core.radius < 110; i++) {
  await page.mouse.move(330, 700);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(500);
  core = await page.evaluate(() => window.__testItemScreenCore());
}
console.log('item on screen:', JSON.stringify(core));
check(core && core.radius > 40, 'the item is big enough on screen to have a ring over its body');

// A press on the red or green ring where it is over the item but away from its middle must be the ring's.
// Look for such a spot by hovering over the item's body on a grid: where the gizmo says a tilt ring is under the
// finger, and the point is on the item and outside its middle.
const found = {};
for (let dy = -core.radius; dy <= core.radius && Object.keys(found).length < 2; dy += 5) {
  for (let dx = -core.radius; dx <= core.radius && Object.keys(found).length < 2; dx += 5) {
    const x = Math.round(core.x + dx);
    const y = Math.round(core.y + dy);
    if (Math.hypot(dx, dy) <= core.core + 6) continue;
    if (!(await page.evaluate(([px, py]) => window.__testSelectedItemHitAt(px, py), [x, y]))) continue;
    await page.mouse.move(x, y);
    await page.waitForTimeout(25);
    const axis = await axisNow();
    if ((axis === 'X' || axis === 'Y') && !found[axis]) found[axis] = { x, y };
  }
}
console.log('rings under a finger over the item body (outside its middle):', JSON.stringify(found));
let tested = 0;
for (const [axis, at] of Object.entries(found)) {
  tested++;
  const before = await state();
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  const picked = await axisNow();
  check(picked === axis, `a press on the ${axis} ring over the item's body is the ring's (the gizmo says ${picked})`);
  check(!(await page.evaluate(() => window.__testBodyDragActive())), `and does not start dragging the item (${axis})`);
  await page.mouse.move(at.x + 30, at.y + 20, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await state();
  check(Math.abs(after.x - before.x) < 0.02 && Math.abs(after.y - before.y) < 0.02, `the item did not move across the ground (${axis})`);
  await page.keyboard.press('Control+z').catch(() => {});
  await page.waitForTimeout(300);
}
check(tested >= 1, 'at least one tilt ring had a point on the item to press on');

// The middle of the item is still the item's: a drag from there moves it.
const spot = await page.evaluate(() => window.__testItemScreenCore());
const s0 = await state();
await page.mouse.move(spot.x, spot.y);
await page.mouse.down();
await page.mouse.move(spot.x + 50, spot.y + 30, { steps: 8 });
check(await page.evaluate(() => window.__testBodyDragActive()), "a drag that starts in the item's middle is a drag of the item");
await page.mouse.up();
await page.waitForTimeout(400);
const s1 = await state();
check(Math.hypot(s1.x - s0.x, s1.y - s0.y) > 0.3, 'and the item followed it');

await finish(browser, { pass: pass && errors.length === 0, label: '#4410: a press on a ring wins over the item body away from its middle; the middle is the item\'s', errors });
