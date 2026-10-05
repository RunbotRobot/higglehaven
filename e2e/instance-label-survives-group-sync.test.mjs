// #1294: placed_instances.label is a real, persisted field, but
// instanceFromMesh (src/main.js) never included it in the plain-object shape
// built for every sync call, and createMeshForInstance never stored a loaded
// instance's label onto mesh.userData either. The single-instance PATCH path
// survived this by accident (worker/index.js merges the patch onto the
// existing DB row first), but the batch path used by every Undo/Redo
// restoreSnapshot (and every group move) calls validateInstance directly on
// the raw client item with no such merge — a missing label key there
// defaults to null and overwrites whatever was actually stored.
//
// This confirms the fix: give an instance a label via the API directly
// (there's still no frontend UI to set one), reload so the client picks it
// up onto mesh.userData.label, then do something that routes that untouched
// instance through syncBatchUpdate — placing a second instance and
// immediately undoing it, which (per handlePlacementClick's own
// pushUndoSnapshot) captures a snapshot of "just the first instance," and
// restoreSnapshot pushes every instance in that snapshot through
// syncBatchUpdate even when nothing about it actually changed.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Instance Label Sync Tester';
const INSTANCE_LABEL = 'Welcome Sign';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

// Place the first instance — this is the one that'll get a label and then
// sit untouched through a later Undo.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').first().click();
await page.waitForTimeout(300);
await page.mouse.click(190, 380);
await page.waitForTimeout(800);

const instanceAId = await page.evaluate(() => window.__lastInstanceExtent.instanceId);
console.log('placed instance A:', instanceAId);

// No frontend UI sets an instance's label yet (#1294) — set it directly
// against the authenticated player's own session, same as the app's own
// same-origin fetches in src/api.js.
const patchResult = await page.evaluate(async (id) => {
  const res = await fetch(`/api/instances/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Welcome Sign' }),
  });
  return { status: res.status, body: await res.json() };
}, instanceAId);
console.log('label PATCH result (should be 200, label "Welcome Sign"):', patchResult.status, patchResult.body.instance?.label);

// Reload so the client actually picks the label up onto mesh.userData —
// instanceFromMesh/createMeshForInstance only round-trip whatever's already
// in memory, and instance A was created (above) before it had a label.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: false });
await page.waitForSelector('#account-menu-toggle', { timeout: 10000 });
await page.waitForTimeout(1500);

// Place a second instance (pushes an undo snapshot of "just A" first), then
// undo it — restoreSnapshot pushes A through syncBatchUpdate even though
// nothing about A itself changed.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').first().click();
await page.waitForTimeout(300);
await page.mouse.click(230, 380);
await page.waitForTimeout(800);

const undoEnabled = await page.locator('#undo-btn').isEnabled();
console.log('undo button enabled after placing a second instance (should be true):', undoEnabled);

await page.click('#undo-btn');
await page.waitForTimeout(1000);

const afterUndo = await page.evaluate(async (id) => {
  const res = await fetch(`/api/instances/${id}`);
  return res.json();
}, instanceAId);
console.log('instance A label after an unrelated Undo (should still be "Welcome Sign"):', afterUndo.instance?.label);

const pass =
  patchResult.status === 200 && patchResult.body.instance?.label === INSTANCE_LABEL &&
  undoEnabled &&
  afterUndo.instance?.label === INSTANCE_LABEL &&
  errors.length === 0;
await finish(browser, { pass, label: 'placed-instance label survives an unrelated Undo/batch sync (#1294)', errors });
