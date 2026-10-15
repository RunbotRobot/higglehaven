// Ground/flooring products (docs/SPEC.md §3) — a seller-owned product
// marked "Flooring" via the Seller modal toggle always renders and places
// as a thin flat slab flush with the ground, regardless of where it's
// tapped or how its Move gizmo's Z arrow is dragged.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Flooring Suite Tester';
const PRODUCT_NAME = 'Suite Sod';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '5');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 45000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 45000 });
await page.waitForTimeout(500);

// Mark it as flooring.
const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
const flooringToggleBefore = await row().locator('button', { hasText: 'Flooring' }).textContent();
console.log('flooring toggle label before (should be plain "Flooring"):', flooringToggleBefore);
await row().locator('button', { hasText: 'Flooring' }).click();
await page.waitForTimeout(500);
const flooringToggleAfter = await row().locator('button', { hasText: 'Flooring' }).textContent();
console.log('flooring toggle label after (should include a checkmark):', flooringToggleAfter);

await page.click('#seller-close-btn');
await page.waitForTimeout(300);

// #540 made Sell a genuine currentMode (a real reload + bootstrap() on
// entry) rather than a modal overlay, so closing it leaves the seller
// looking at their own showcase array, not a live Build-mode scene
// underneath — switch back explicitly, same as seller-upload-and-resize.test.mjs.
await page.click('.mode-nav-btn[data-mode="build"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#add-item-btn', { timeout: 15000 });
await page.waitForTimeout(500);

// Place it by tapping directly on top of another already-placed item —
// flooring should still land at true ground level, not on top of
// whatever was tapped.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: PRODUCT_NAME }).click();
await page.waitForTimeout(300);
// Tap right on the tree's own screen position — a normal item placed here
// would rest on TOP of the tree; flooring should ignore that and sit at
// the ground instead.
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

// Read back the actual persisted instances to confirm the flooring one's
// z is pinned to the thin ground thickness, not resting on the tree it
// was tapped onto. A fresh local D1 (see e2e/run-all.mjs) only ever seeds
// one claimable landlet — "starter-landlet" — which claimLandlet() above
// always ends up claiming, so it's safe to name directly here.
const instances = await page.evaluate(async () => {
  const res = await fetch('/api/instances?landletId=starter-landlet&limit=100');
  const body = await res.json();
  return body.instances;
});
console.log('placed instances:', instances.map((i) => ({ template: i.templateId, x: i.x, y: i.y, z: i.z })));
const flooringInstance = instances.find((i) => i.z > 0 && i.z < 0.05);
console.log('flooring instance z (should be ~0.01, not resting on the tree):', flooringInstance?.z);
const zIsGroundLevel = flooringInstance !== undefined;

// #1770: a multi-select group-move used to skip the flush-to-ground clamp
// that a single-item move already applies, letting a flooring tile in a
// group get lifted into the air along with the rest of the group. The 3D
// gizmo's own blue arrow handle has no stable screen position to click
// (it depends on camera framing), so drive the drag through
// window.__testDragGroupMoveZ instead (see that hook's own comment in
// src/main.js) -- it fires the exact same dragging-changed/objectChange
// events a real drag would, just without the mouse coordinates.
const preDragZ = flooringInstance?.z;
await page.click('#toggle-multiselect');
await page.waitForTimeout(300);
let groupSelectionText = await page.textContent('#product-info');

// Flooring (already selected from placement) carries into multi-select
// mode. The tree's own clickable footprint sits above the ground point it
// was placed at (same reasoning as e2e/bundles.test.mjs's own
// selectByScanningY) -- scan upward from there until it joins the
// selection, stopping as soon as the status text reports 2 items rather
// than toggling flooring itself back off at a y still within its own thin
// clickable slab near the shared placement point.
for (let y = 370; y >= 280; y -= 10) {
  await page.mouse.click(210, y);
  await page.waitForTimeout(250);
  const text = await page.textContent('#product-info');
  groupSelectionText = text;
  if (/2.*selected/i.test(text)) break;
}
console.log('selection status with both items selected (should mention 2 items selected):', groupSelectionText);

// Multi-select and the Move gizmo are sibling tools (updateSelectionUI's
// own comment) -- the gizmo stays fully detached the whole time multi-
// select is on. Clicking Move exits multi-select without touching the
// selection just built and attaches translateControls to the group pivot.
await page.click('#mode-move');
await page.waitForTimeout(300);

const groupDragApplied = await page.evaluate((offsetZ) => window.__testDragGroupMoveZ(offsetZ), 0.5);
console.log('group-move Z-drag test hook applied (should be true):', groupDragApplied);
await page.waitForTimeout(800);

const instancesAfterDrag = await page.evaluate(async () => {
  const res = await fetch('/api/instances?landletId=starter-landlet&limit=100');
  const body = await res.json();
  return body.instances;
});
console.log('instances after group Z-drag:', instancesAfterDrag.map((i) => ({ instanceId: i.instanceId, z: i.z })));
const flooringAfterDrag = instancesAfterDrag.find((i) => i.instanceId === flooringInstance?.instanceId);
console.log('flooring z after group Z-drag (should stay close to', preDragZ, ', not lifted by ~0.5):', flooringAfterDrag?.z);
const flooringStayedFlush = flooringAfterDrag !== undefined && Math.abs(flooringAfterDrag.z - preDragZ) < 0.01;

const pass = flooringToggleBefore.trim() === 'Flooring' &&
  flooringToggleAfter.includes('✓') &&
  zIsGroundLevel &&
  /2.*selected/i.test(groupSelectionText) &&
  groupDragApplied === true &&
  flooringStayedFlush &&
  errors.length === 0;
await finish(browser, { pass, label: 'ground/flooring products place at true ground level and stay flush through a multi-select group move', errors });
