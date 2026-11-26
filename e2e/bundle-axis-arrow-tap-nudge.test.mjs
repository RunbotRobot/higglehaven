// #4414: a tap on the arrow at either end of a bundle's movement axis moves every member one step together (a rigid
// move), as a single item's arrow does (e2e/build-axis-arrow-tap-nudge.test.mjs). 390x844.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Bundle Arrow Tap Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const positions = () => page.evaluate(() => window.__testProductPositions());
const STEP = 0.1;
const arrows = () => page.evaluate(() => window.__testAxisHandlePoints());

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}
async function tap(axis, sign) {
  const before = await positions();
  const points = await arrows();
  const arrow = points.find((p) => p.axis === axis && p.sign === sign);
  if (!arrow) return { missing: true };
  const cx = points.reduce((a, p) => a + p.x, 0) / points.length;
  const cy = points.reduce((a, p) => a + p.y, 0) / points.length;
  const ox = arrow.x - cx; const oy = arrow.y - cy; const ol = Math.hypot(ox, oy) || 1;
  let aim = null;
  for (let k = -6; k <= 14 && !aim; k++) {
    const x = Math.round(arrow.x + (ox / ol) * k * 2); const y = Math.round(arrow.y + (oy / ol) * k * 2);
    const hit = await page.evaluate(([a, b]) => window.__testHandleAt(a, b), [x, y]);
    if (hit.arrow === axis && !hit.ring) aim = { x, y };
  }
  if (!aim) return { missing: true };
  await page.mouse.click(aim.x, aim.y);
  await page.waitForTimeout(450);
  const after = await positions();
  return { arrow, moves: after.map((a, i) => ({ x: a.x - before[i].x, y: a.y - before[i].y, z: a.z - before[i].z })) };
}
const along = (move, direction) => move.x * direction.x + move.y * direction.y + move.z * direction.z;
const sideways = (move, direction) => { const a = along(move, direction); return Math.hypot(move.x - a * direction.x, move.y - a * direction.y, move.z - a * direction.z); };

await placeTreeAt(160, 380);
await placeTreeAt(260, 380);
await page.mouse.click(60, 550);
await page.waitForTimeout(300);
const [posA, posB] = await page.evaluate(() => window.__testProductScreenPositions());
await page.click('#toggle-multiselect');
await page.waitForTimeout(200);
await page.mouse.click(posA.x, posA.y);
await page.waitForTimeout(150);
await page.mouse.click(posB.x, posB.y);
await page.waitForTimeout(300);
await page.click('#group-item');
await page.waitForTimeout(800);
await page.click('#toggle-multiselect');
await page.waitForTimeout(500);

check((await arrows()).length === 6, 'a bundle wears the three axes with an arrow at each end');
for (const [axis, sign] of [['X', 1], ['Y', -1], ['Z', 1]]) {
  const rb = await tap(axis, sign);
  if (rb.missing) { check(false, `the bundle has a clear ${sign > 0 ? '+' : '-'}${axis} arrow`); continue; }
  const ok = rb.moves.every((m) => Math.abs(along(m, rb.arrow.direction) - STEP) < 0.015 && sideways(m, rb.arrow.direction) < 0.015);
  check(ok, `a tap on the bundle's ${sign > 0 ? '+' : '-'}${axis} arrow moves every member one step together (${JSON.stringify(rb.moves)})`);
}

await finish(browser, { pass: pass && errors.length === 0, label: '#4414: a tap on a bundle axis arrow nudges every member one step together', errors });
