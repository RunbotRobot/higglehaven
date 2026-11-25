// #4118: all three rotation rings are on a selected item and each one is a real handle: a finger put on the
// blue ring turns the item, one on the red ring tips it one way, one on the green ring tips it the other way, and
// each drag changes its own angle and leaves the other two alone ("A handle on the thing is never traded for a
// field on a panel"). Phone width, real pointer events (a press, a drag, a release), no test shortcut for the
// turn itself; only where to press comes from a hook that projects each ring's pick area to the screen.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Rotation Rings Drag Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const state = () => page.evaluate(() => window.__testSelectedItemState());

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(195, 420);
await page.waitForTimeout(1000);

const rings = await page.evaluate(() => window.__testRotateRingsShown());
check(rings.x && rings.y && rings.z, `all three rings are on the selected item (${JSON.stringify(rings)})`);
const points = await page.evaluate(() => window.__testRotateRingPoints());
check(points.x?.length && points.y?.length && points.z?.length, 'every ring has a place on screen to grab it');

const ANGLE = { x: 'tiltRed', y: 'tiltGreen', z: 'turn' };
// Hover over the ring's points until the gizmo says this ring is under the finger, as a person feels for a thin line.
async function findGrab(axis) {
  const fresh = await page.evaluate(() => window.__testRotateRingPoints());
  for (const at of fresh[axis] || []) {
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(30);
    if ((await page.evaluate(() => window.__testRotateActiveAxis())) === axis.toUpperCase()) return at;
  }
  return null;
}
for (const axis of ['z', 'x', 'y']) {
  const at = await findGrab(axis);
  check(!!at, `a finger can find the ${axis} ring (the gizmo reports it under the finger)`);
  if (!at) continue;
  const before = await state();
  await page.mouse.down();
  await page.mouse.move(at.x + 70, at.y + 40, { steps: 12 });
  await page.mouse.move(at.x + 120, at.y + 70, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await state();
  const changed = Object.fromEntries(Object.entries(ANGLE).map(([a, name]) => [a, Math.abs(after[name] - before[name])]));
  console.log(`dragging the ${axis} ring changed (deg):`, JSON.stringify(changed));
  check(changed[axis] >= 5, `a drag on the ${axis} ring changes its angle (${changed[axis]} deg)`);
  for (const other of ['x', 'y', 'z'].filter((a) => a !== axis)) {
    check(changed[other] < 1, `a drag on the ${axis} ring leaves the ${other} angle alone (${changed[other]} deg)`);
  }
  check(Math.abs(after.x - before.x) < 0.02 && Math.abs(after.y - before.y) < 0.02, `a drag on the ${axis} ring does not move the item along the ground`);
}

await finish(browser, { pass: pass && errors.length === 0, label: '#4118: each of the three rotation rings is a real handle that changes its own angle and nothing else', errors });
