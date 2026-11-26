// #4241: while a rotation ring is held, nothing but the ring moves the view. The owner saw Build zoom way out once
// while turning a bundle and could not reproduce it, so this pins what must hold: through a full drag of each ring,
// including one that ends near the screen's edge and one with a second finger landing and moving mid-drag, the
// camera's distance to its target and the target itself do not change ("one gesture does one thing"). Phone
// width, real pointer events; only where to press comes from the hook that projects each ring to the screen.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Rotation Camera Steady Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const ANGLE = { x: 'tiltRed', y: 'tiltGreen', z: 'turn' };
const itemState = () => page.evaluate(() => window.__testSelectedItemState());
const pose = () => page.evaluate(() => {
  const p = window.__testBuildCameraPose();
  const d = Math.hypot(p.camera.x - p.target.x, p.camera.y - p.target.y, p.camera.z - p.target.z);
  return { camera: p.camera, target: p.target, distance: d };
});
const shift = (a, b) => ({
  distance: Math.abs(a.distance - b.distance),
  target: Math.hypot(a.target.x - b.target.x, a.target.y - b.target.y, a.target.z - b.target.z),
});

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(195, 420);
await page.waitForTimeout(1000);

async function findGrab(axis) {
  const fresh = await page.evaluate(() => window.__testRotateRingPoints());
  for (const at of fresh[axis] || []) {
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(30);
    // (and no movement arrow under it: where an arrow and a ring meet, the nearer one takes the press, #4410)
    if ((await page.evaluate(() => window.__testRotateActiveAxis())) === axis.toUpperCase()
      && !(await page.evaluate(([x, y]) => window.__testHandleAt(x, y).arrow, [at.x, at.y]))) return at;
  }
  return null;
}

const cdp = await page.context().newCDPSession(page);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });

// Each case: where the held finger ends, and whether a second finger lands and moves while it is held.
const cases = [
  { name: 'plain', end: (at) => ({ x: at.x + 120, y: at.y + 70 }), second: false },
  { name: 'toward the edge', end: () => ({ x: 380, y: 420 }), second: false },
  { name: 'second finger', end: (at) => ({ x: at.x + 120, y: at.y + 70 }), second: true },
];
for (const axis of ['z', 'x', 'y']) {
  for (const c of cases) {
    const at = await findGrab(axis);
    check(!!at, `a finger can find the ${axis} ring (${c.name})`);
    if (!at) continue;
    const before = await pose();
    const angleBefore = (await itemState())[ANGLE[axis]];
    await page.mouse.down();
    await page.mouse.move(at.x + 40, at.y + 20, { steps: 8 });
    if (c.second) {
      await touch('touchStart', [{ x: 60, y: 700, id: 7 }]);
      await touch('touchMove', [{ x: 90, y: 660, id: 7 }]);
      await touch('touchMove', [{ x: 140, y: 600, id: 7 }]);
    }
    const end = c.end(at);
    await page.mouse.move(end.x, end.y, { steps: 14 });
    await page.waitForTimeout(250);
    const during = await pose();
    await page.mouse.up();
    if (c.second) await touch('touchEnd', []);
    await page.waitForTimeout(500);
    const after = await pose();
    const turned = Math.abs((await itemState())[ANGLE[axis]] - angleBefore);
    check(turned >= 5, `the ${axis} ring really turned the item, so this is a real ring drag (${c.name}: ${turned} deg)`);
    const s1 = shift(before, during);
    const s2 = shift(before, after);
    console.log(`${axis} ring, ${c.name}: during`, JSON.stringify(s1), 'after', JSON.stringify(s2));
    check(s1.distance < 0.05 && s1.target < 0.05, `the view does not move while the ${axis} ring is held (${c.name}): ${JSON.stringify(s1)}`);
    check(s2.distance < 0.05 && s2.target < 0.05, `the view is where it was after the ${axis} ring is let go (${c.name}): ${JSON.stringify(s2)}`);
  }
}

await finish(browser, { pass: pass && errors.length === 0, label: '#4241: a held rotation ring moves nothing but the item, never the view', errors });
