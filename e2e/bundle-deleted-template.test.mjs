// Regression test for #469: placeClipboardItems() used to silently
// `continue` past a bundle item whose templateId no longer resolves in the
// live catalog (findTemplate returns null) — no alert, no status message,
// nothing. Reachable because deleting a catalog template only checks for
// currently-*placed* instances (an ON DELETE RESTRICT FK), not whether some
// saved bundle's items_json still references it: place items, save them as
// a bundle, delete every placed instance (now allowed), then delete the
// template itself (now allowed too, since nothing placed references it
// anymore) — the bundle still lists it, permanently. Placing that bundle
// afterward used to look completely indistinguishable from tapping empty
// sky when every item in it was affected, which is the case this test
// drives (all items share one template). A self-uploaded product (not a
// built-in like Tree) is used so this session's own seller identity owns
// it and can actually delete it — a built-in template belongs to no seller
// the test can authenticate as.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Bundle Deleted Template Tester';
const PRODUCT_NAME = 'Deleted Template Crate';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);
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

async function placeCrateAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: PRODUCT_NAME }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}
await placeCrateAt(100, 500);
await placeCrateAt(320, 500);

// Placing the second crate auto-selected it (handlePlacementClick's own
// selectOnly for a 'template' placement, same as bundles.test.mjs's own
// note on this) — clear that first, on a patch of open ground away from
// both crates, so toggling Multi-Select on doesn't carry it into the
// selection (it would otherwise count as "already selected," and the
// very first of the two taps below would toggle it back OFF instead of
// adding the other crate, netting exactly one selected item throughout).
await page.mouse.click(210, 650);
await page.waitForTimeout(300);

// Unlike a tall tree (whose canopy renders well above its placement
// point, see bundles.test.mjs's own note on that), a crate's clickable
// footprint sits right where it was placed — clicking the exact placement
// coordinates again selects it directly, no need to scan a vertical strip.
await page.click('#toggle-multiselect');
await page.waitForTimeout(300);
await page.mouse.click(100, 500);
await page.waitForTimeout(300);
await page.mouse.click(320, 500);
await page.waitForTimeout(300);
const selectionText = await page.textContent('#product-info');
console.log('selection status before saving (should say 2 items selected):', selectionText);

await page.click('#save-bundle-item');
await page.waitForFunction(
  () => document.getElementById('product-info').textContent.includes('Saved'),
  { timeout: 10000 },
);

// Both crates are still selected (Save Bundle doesn't clear selection) —
// delete the placed instances so the template's ON DELETE RESTRICT FK no
// longer has anything blocking it.
await page.click('#delete-item');
await page.waitForTimeout(300);

async function fetchJson(pathAndQuery) {
  return page.evaluate(async (p) => (await fetch(p)).json(), pathAndQuery);
}
const { templates } = await fetchJson('/api/catalog?limit=100');
const crateTemplateId = templates.find((t) => t.name === PRODUCT_NAME)?.templateId;
console.log('found the uploaded catalog template to delete (should be non-empty):', crateTemplateId);

// Poll rather than a fixed sleep — syncBatchDelete's own DELETE request
// above is fire-and-forget from the click handler's point of view, so
// there's no direct signal here for when the instance rows actually clear
// the FK. Retrying this DELETE is safe: it's idempotent from the test's
// perspective (only the first successful call matters).
let deleteOk = false;
for (let attempt = 0; attempt < 20 && !deleteOk; attempt++) {
  const res = await page.evaluate(
    async (id) => (await fetch(`/api/catalog/${id}`, { method: 'DELETE' })).ok,
    crateTemplateId,
  );
  if (res) { deleteOk = true; break; }
  await page.waitForTimeout(300);
}
console.log('deleted the catalog template once nothing placed referenced it (should be true):', deleteOk);

// findTemplate looks up the client's in-memory activeCatalog snapshot,
// only refetched on mode entry — the DELETE above happened via a raw
// fetch the page never learns about on its own, so without a reload here
// activeCatalog would still list the (now server-side-deleted) template,
// findTemplate would still resolve it, and this would exercise
// syncBatchCreate's own pre-existing "couldn't save" alert (a 400 from
// the server rejecting the stale templateId) instead of the actual #469
// case this test targets. A reload forces the real re-fetch, the same
// precondition bundle-rename-sync.test.mjs establishes for its own
// stale-in-memory-object bug.
await page.evaluate(() => sessionStorage.setItem('higglehaven.startMode', 'build'));
await page.reload();
await page.waitForSelector('#account-menu-toggle', { timeout: 15000 });
await page.waitForTimeout(500);

// Placing the bundle now should hit the #469 case: every item's template
// has been deleted out from under it.
let alertMessage = null;
page.on('dialog', (dialog) => {
  if (dialog.type() === 'alert') alertMessage = dialog.message();
});

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('.bundle-tile-place').first().click();
await page.waitForTimeout(300);
await page.mouse.click(210, 550);
await page.waitForTimeout(1000);
console.log('alert shown when placing a bundle whose only template was deleted (should mention "2" and "no longer exists"):', alertMessage);

const pass = deleteOk &&
  !!alertMessage && alertMessage.includes('2') && alertMessage.includes('no longer exists') &&
  errors.length === 0;
await finish(browser, { pass, label: '#469: placing a bundle whose template was deleted surfaces a clear alert instead of silently no-oping', errors });
