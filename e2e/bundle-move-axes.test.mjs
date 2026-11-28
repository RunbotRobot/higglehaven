// #4410: a bundle wears the three movement axes beside its rings, and dragging an arrow moves every member
// together along that axis only (a rigid move), as a single item's arrow moves it.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Bundle Axes Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
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
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

let points = await page.evaluate(() => window.__testAxisHandlePoints());
check(points.length === 6, `the bundle wears three axes with an arrow at each end (found ${points.length})`);
const before = await page.evaluate(() => window.__testProductPositions());
const screenCentre = { x: points.reduce((a, p) => a + p.x, 0) / points.length, y: points.reduce((a, p) => a + p.y, 0) / points.length };
const x = points.filter((p) => p.axis === 'X');
x.sort((a, b) => Math.hypot(b.x - screenCentre.x, b.y - screenCentre.y) - Math.hypot(a.x - screenCentre.x, a.y - screenCentre.y));
const at = { x: x[0].x, y: x[0].y };
const ox = at.x - screenCentre.x, oy = at.y - screenCentre.y, ol = Math.hypot(ox, oy) || 1;
let found = null;
for (let k = -2; k <= 14 && !found; k++) {
  const px = at.x + (ox / ol) * k * 2, py = at.y + (oy / ol) * k * 2;
  const hit = await page.evaluate(([a, b]) => window.__testHandleAt(a, b), [Math.round(px), Math.round(py)]);
  if (hit.arrow === 'X' && !hit.ring) found = { x: px, y: py };
}
check(!!found, 'a finger can find the X arrow of the bundle clear of the rings');
if (found) {
  await page.mouse.move(found.x, found.y);
  await page.mouse.down();
  await page.mouse.move(found.x + (ox / ol) * 40, found.y + (oy / ol) * 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.__testProductPositions());
  const d = after.map((a, i) => ({ x: a.x - before[i].x, y: a.y - before[i].y, z: a.z - before[i].z }));
  console.log('member moves', JSON.stringify(d.map((m) => [m.x, m.y, m.z].map((v) => +v.toFixed(2)))));
  check(Math.abs(d[0].x) > 0.15, `dragging the bundle's X arrow moved it (${d[0].x.toFixed(2)} m)`);
  check(Math.abs(d[0].x - d[1].x) < 0.02 && Math.abs(d[0].y) < 0.02 && Math.abs(d[1].y) < 0.02 && Math.abs(d[0].z) < 0.02, 'every member moved together, along that axis only');
}
await finish(browser, { pass: pass && errors.length === 0, label: '#4410: a bundle wears the movement axes and an arrow moves every member together', errors });
