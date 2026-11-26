// #4413: a bundle's rotation rings stay centred on the bundle when it moves, as a single item's rings do. A bundle of
// two trees is selected, then moved (what a body drag, an undo or a nudge does to its members) and the rings' centre is
// read before and after against the bundle's own centre.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Bundle Rings Follow Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
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
await page.click('#toggle-multiselect');
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const near = (a, b) => Math.abs(a - b) < 0.01;
const apart = async () => {
  const c = await page.evaluate(() => window.__testRotateRingCentre());
  return c ? Math.hypot(c.ring.x - c.selection.x, c.ring.y - c.selection.y, c.ring.z - c.selection.z) : null;
};

const centreBefore = await page.evaluate(() => window.__testRotateRingCentre());
check(centreBefore !== null, 'the bundle wears its rings');
check(near(await apart(), 0), `the rings start on the bundle's centre (${await apart()} m apart)`);

// The bundle moves 3 m (what a drag of its body does to every member).
await page.evaluate(() => window.__testNudgeSelected(3));
await page.waitForTimeout(400);
const centreAfter = await page.evaluate(() => window.__testRotateRingCentre());
check(centreAfter.selection.x > centreBefore.selection.x + 2.9, `the bundle moved (${centreBefore.selection.x} to ${centreAfter.selection.x})`);
check(near(await apart(), 0), `the rings moved with it: ${await apart()} m apart after the move`);

// And back, as an undo would put it.
await page.evaluate(() => window.__testNudgeSelected(-3));
await page.waitForTimeout(400);
check(near(await apart(), 0), `the rings follow it back: ${await apart()} m apart`);

await finish(browser, {
  pass,
  label: '#4413: a bundle\'s rotation rings stay on the bundle when it moves',
  errors,
});
