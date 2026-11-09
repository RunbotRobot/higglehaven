// #3325 (leaf 2/7 of #3323): Rotate is enabled for a bundle and turns it as a
// rigid body about its pivot -- members orbit together and each turns by the
// same amount -- and the result persists. A plain (ungrouped) multi-selection
// still has Rotate disabled.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Bundle Rotate Tester';
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
const ids = [posA.instanceId, posB.instanceId];
const fetchInstances = () => page.evaluate(async (list) => {
  const out = [];
  for (const id of list) out.push((await (await fetch(`/api/instances/${id}`)).json()).instance);
  return out;
}, ids);

await page.click('#toggle-multiselect');
await page.waitForTimeout(200);
await page.mouse.click(posA.x, posA.y);
await page.waitForTimeout(150);
await page.mouse.click(posB.x, posB.y);
await page.waitForTimeout(300);
const rotateDisabledUngrouped = await page.locator('#mode-rotate').isDisabled();
console.log('Rotate disabled for a plain 2-item multi-selection (should be true):', rotateDisabledUngrouped);

await page.click('#group-item');
await page.waitForTimeout(800);
const rotateEnabledGrouped = await page.locator('#mode-rotate').isEnabled();
console.log('Rotate enabled once the selection is one bundle (should be true):', rotateEnabledGrouped);

const before = await fetchInstances();
await page.click('#mode-rotate');
await page.waitForTimeout(400);
const attached = await page.evaluate(() => window.__testRotateBundle('z', Math.PI / 2));
console.log('bundle rotated 90 degrees about Z via the gizmo path (should be true):', attached);
await page.waitForTimeout(1500);
const after = await fetchInstances();

const cx = (before[0].x + before[1].x) / 2;
const cy = (before[0].y + before[1].y) / 2;
// A 90 degree turn about Z maps (dx, dy) -> (-dy, dx) around the pivot.
const expected = before.map((i) => ({ x: cx - (i.y - cy), y: cy + (i.x - cx) }));
const near = (a, b) => Math.abs(a - b) < 0.02;
const positionsOk = after.every((i, k) => near(i.x, expected[k].x) && near(i.y, expected[k].y));
const spinOk = after.every((i, k) => near(i.rotationZ - before[k].rotationZ, Math.PI / 2));
const gapBefore = Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y);
const gapAfter = Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y);
console.log('before', JSON.stringify(before.map((i) => [i.x, i.y, i.rotationZ])), 'after', JSON.stringify(after.map((i) => [i.x, i.y, i.rotationZ])));
console.log('positions orbit the pivot / each turns 90 degrees / spacing preserved (all true):', positionsOk, spinOk, near(gapBefore, gapAfter));

const pass = rotateDisabledUngrouped && rotateEnabledGrouped && attached && positionsOk && spinOk && near(gapBefore, gapAfter) && errors.length === 0;
await finish(browser, { pass, label: '#3325: a bundle rotates as a rigid body about its pivot and persists', errors });
