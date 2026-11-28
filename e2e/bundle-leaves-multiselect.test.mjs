// #4694: tapping Bundle ends Multi-Select. The new bundle is one item, so it is chosen like any other: its three
// rings and three arrows are on it and its card is the full one (Copy, Delete), with no step to turn a mode off.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Bundle Leaves Multiselect Tester';
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

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await page.click('#toggle-multiselect');
await page.waitForTimeout(200);
await page.mouse.click(posA.x, posA.y);
await page.waitForTimeout(150);
await page.mouse.click(posB.x, posB.y);
await page.waitForTimeout(300);
check((await page.getAttribute('#toggle-multiselect', 'aria-pressed')) === 'true', 'Multi-Select is on while choosing the items');
const handlesWhileChoosing = await page.evaluate(() => window.__testAxisHandlePoints().length);
check(handlesWhileChoosing === 0, `no arrows while two loose items are being chosen (found ${handlesWhileChoosing})`);

await page.click('#group-item');
await page.waitForTimeout(1000);

check((await page.getAttribute('#toggle-multiselect', 'aria-pressed')) === 'false', 'Bundle ended Multi-Select');
const points = await page.evaluate(() => window.__testAxisHandlePoints());
check(points.length === 6, `the new bundle wears three axes with an arrow at each end at once (found ${points.length})`);
check(await page.locator('#delete-item').isVisible(), 'the card is the full one: Delete is on it');
check(await page.locator('#ungroup-item').isEnabled(), 'Unbundle is on the card');

await finish(browser, { pass: pass && errors.length === 0, label: '#4694: Bundle leaves Multi-Select and the new bundle wears its rings and arrows', errors });
