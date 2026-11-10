// #3376: the rotation readout and exact angles. While Rotate is on, the selected
// item or bundle shows the angle it is at, measured from upright and named by
// the gizmo's ring colours; Snap on lands each turn on a step of that absolute
// angle, and with Snap off a turn settles onto a right angle inside a degree, so
// "perfectly upright" is always reachable. A bundle has no stored orientation:
// the readout derives it from its members, so it survives deselecting and
// selecting it again. Phone width. Turns go through __testRotateSelected /
// __testRotateBundle with dragAxis, which sets the gizmo's active ring the way a
// real drag does.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Rotation Readout Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const DEG = Math.PI / 180;
const readoutText = () => page.evaluate(() => {
  const el = document.getElementById('rotation-readout');
  return el.hidden ? null : el.textContent.trim();
});
async function waitReadout(re, label) {
  try {
    await page.waitForFunction((src) => {
      const el = document.getElementById('rotation-readout');
      return !el.hidden && new RegExp(src).test(el.textContent);
    }, re.source, { timeout: 5000 });
  } catch {
    check(false, `${label}: readout is ${JSON.stringify(await readoutText())}, wanted ${re}`);
    return;
  }
  check(true, label);
}

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}

// ---- 1. A single item ----
await placeTreeAt(160, 420);
check(await readoutText() === null, 'no readout while nothing is being rotated');
await page.click('#mode-rotate');
await waitReadout(/Turn 0\.0° \(blue ring\) · Tilt 0\.0° \(red ring\) · Tilt 0\.0° \(green ring\)/, 'single item at rest reads 0, 0, 0 in plain words');

const box = await page.evaluate(() => document.getElementById('rotation-readout').getBoundingClientRect().toJSON());
check(box.bottom <= 140 && box.left >= 0 && box.right <= 390, `the readout sits at the top and inside the viewport (${JSON.stringify(box)})`);
const selectable = await page.evaluate(() => {
  const s = getComputedStyle(document.getElementById('rotation-readout'));
  return s.userSelect !== 'none' && s.pointerEvents !== 'none';
});
check(selectable, 'the readout text is selectable');

// Snap is on by default: a 40 degree turn lands on 45 (a multiple of 15).
await page.evaluate((r) => window.__testRotateSelected('z', r, { dragAxis: true }), 40 * DEG);
await waitReadout(/Turn 45\.0° /, 'Snap on: a 40 degree turn lands on 45.0');
// Turning it again from 45 by 8 degrees: 53 absolute, lands on 60 (not 45 + a step).
await page.evaluate((r) => window.__testRotateSelected('z', r, { dragAxis: true }), 8 * DEG);
await waitReadout(/Turn 60\.0° /, 'Snap on: lands on a step of the ABSOLUTE angle, not of this turn');

// Snap off: free, but within a degree of a right angle settles exactly onto it.
await page.click('#toggle-snap');
await page.evaluate((r) => window.__testRotateSelected('z', r, { dragAxis: true }), 29.4 * DEG);
await waitReadout(/Turn 90\.0° /, 'Snap off: 89.4 settles onto exactly 90.0');
await page.evaluate((r) => window.__testRotateSelected('x', r, { dragAxis: true }), 7.5 * DEG);
await waitReadout(/Tilt 7\.5° \(red ring\)/, 'Snap off: a free turn stays where it is (7.5)');
await page.evaluate((r) => window.__testRotateSelected('x', r, { dragAxis: true }), -7.1 * DEG);
await waitReadout(/Tilt 0\.0° \(red ring\)/, 'Snap off: 0.4 off upright settles onto exactly 0.0');

// The readout stays up between drags and goes away with Rotate.
await page.waitForTimeout(600);
check(await readoutText() !== null, 'the readout stays after the drag ends');
await page.click('#mode-move');
await page.waitForTimeout(400);
check(await readoutText() === null, 'the readout goes away when Rotate is off');
await page.click('#toggle-snap'); // Snap back on

// ---- 2. A bundle ----
await placeTreeAt(260, 420);
await page.mouse.click(60, 650);
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
await page.click('#mode-rotate');
await waitReadout(/Tilt \S+° \(red ring\)/, 'a bundle shows a readout in Rotate mode');
const startText = await readoutText();

// The two trees were left at different turns above (the first item is at 90): the
// bundle reads as the orientation most members share; with a tie, the earliest.
await page.evaluate((r) => window.__testRotateBundle('x', r, { dragAxis: true }), 20 * DEG);
await waitReadout(/Tilt 15\.0° \(red ring\)/, 'Snap on: a bundle tilted 20 degrees lands on exactly 15.0');
await page.evaluate((r) => window.__testRotateBundle('x', r, { dragAxis: true }), 8 * DEG);
await waitReadout(/Tilt 30\.0° \(red ring\)/, 'Snap on: the next 8 degrees land on 30.0 (absolute, not 15 + 8)');
const afterTilt = await page.evaluate(() => window.__testBundleRotateResult());
check(afterTilt.lowestZ >= Math.max(afterTilt.floorZ, afterTilt.levelRange.minZ) - 1e-6, 'the tilted bundle is still above the floor');

// Derived from the members, not remembered by the session: select it again.
await page.mouse.click(60, 650);
await page.waitForTimeout(300);
check(await readoutText() === null, 'nothing selected: no readout');
const positions = await page.evaluate(() => window.__testProductScreenPositions());
await page.mouse.click(positions[0].x, positions[0].y);
await page.waitForTimeout(500);
await page.click('#mode-rotate');
await waitReadout(/Tilt 30\.0° \(red ring\)/, 'selecting the bundle again still reads 30.0');

// Back to exactly upright with Snap off: 30 - 29.5 = 0.5 absolute settles onto 0.
await page.click('#toggle-snap');
await page.evaluate((r) => window.__testRotateBundle('x', r, { dragAxis: true }), -29.5 * DEG);
await waitReadout(/Tilt 0\.0° \(red ring\)/, 'Snap off: 0.5 off upright settles onto exactly 0.0');
console.log('bundle readout at the start:', startText);

await finish(browser, { pass: pass && errors.length === 0, label: '#3376: Rotate shows the absolute angle in plain words and lands on exact angles (Snap steps; settle onto right angles)', errors });
