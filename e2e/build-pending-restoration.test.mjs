// #2987 (3/5 of #2305): the builder-facing "Removed items" view of #2986's
// suspended-seller removals (src/build/pendingRestoration.js, backed by
// GET/DELETE /api/instances/pending-restoration -- see
// worker/pending-restoration.test.js for the endpoint-level coverage).
//
// Drives the real sequence end to end with two separate accounts (a suspended
// seller's own session is blocked, so the seller and the builder can't share
// one): a seller lists a product, a builder places it on their land, an
// admin suspends the seller. The builder's Build mode then shows a "Removed
// Items" button (hidden beforehand), its modal names what used to be there,
// and "Clear" discards the slot for good -- after which lifting the
// suspension does NOT bring it back.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, emailForLabel, finish, acceptConfirmModal, removedItemsButtonShown, openAccountMenu, openBuildMoreFold } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL_BUILDER = 'Pending Restoration Suite Builder';
const LABEL_SELLER = 'Pending Restoration Suite Seller';
const PRODUCT_NAME = 'Suite Pending Restoration Product';

async function apiFetch(pathAndQuery, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${pathAndQuery}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...options.headers,
    },
  });
  return { response, body: await response.json() };
}

const adminCookie = await ensureAdminSession();

// --- The seller: its own browser/session, lists one product. ---
const { browser: sellerBrowser, page: sellerPage } = await launchPage({ promptAnswer: LABEL_SELLER });
await chooseIdentity(sellerPage, { mode: 'sell', label: LABEL_SELLER, isNew: true });
await sellerPage.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await sellerPage.waitForTimeout(300);
await sellerPage.click('#seller-close-btn');
await sellerPage.waitForTimeout(300);

const sellerMe = await sellerPage.evaluate(async () => (await fetch('/api/sellers/me')).json());
const sellerId = sellerMe.seller.sellerId;
const sellerSession = (await sellerPage.context().cookies()).find((c) => c.name === 'hh_session');
const sellerCookie = `hh_session=${sellerSession.value}`;

const modelForm = new FormData();
modelForm.append('file', new Blob([await fs.readFile(CRATE_MODEL_PATH)], { type: 'model/gltf-binary' }), 'pending-restoration-crate.glb');
const modelUpload = await apiFetch('/models', sellerCookie, { method: 'POST', body: modelForm });
if (![200, 201].includes(modelUpload.response.status)) {
  throw new Error(`model upload failed (${modelUpload.response.status}): ${JSON.stringify(modelUpload.body)}`);
}
const templateRes = await apiFetch('/catalog', sellerCookie, {
  method: 'POST',
  body: JSON.stringify({
    name: PRODUCT_NAME, category: 'placeholder', color: '#8899aa',
    dimensions: { width: 1, depth: 1, height: 1 },
    sellerId, modelUrl: modelUpload.body.modelUrl, modelSizeBytes: modelUpload.body.sizeBytes, priceCents: 500,
  }),
});
if (![200, 201].includes(templateRes.response.status)) {
  throw new Error(`catalog template create failed (${templateRes.response.status}): ${JSON.stringify(templateRes.body)}`);
}
const template = templateRes.body.template;

// --- The builder: claims land in Build mode and places the product. ---
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL_BUILDER });
await chooseIdentity(page, { mode: 'build', label: LABEL_BUILDER, isNew: true });
await claimLandlet(page);

async function pageFetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { body: buildersBody } = await pageFetchJson('/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL_BUILDER);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];

const placeRes = await pageFetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId: `pending-restoration-instance-${crypto.randomUUID()}`, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});
console.log('product placed on the builder\'s land (should be 201):', placeRes.status);

async function reloadBuildMode() {
  await page.reload();
  await chooseIdentity(page, { mode: 'build', label: LABEL_BUILDER, isNew: true });
  await page.waitForSelector('#undo-redo-panel', { state: 'attached', timeout: 15000 });
  // The button's visibility is decided by an async fetch after sign-in
  // resolves; give it a beat to settle either way.
  await page.waitForTimeout(1500);
}

await reloadBuildMode();
const hiddenBeforeSuspension = !(await removedItemsButtonShown(page));
console.log('"Removed items" button hidden while nothing is pending (should be true):', hiddenBeforeSuspension);

const suspend = await apiFetch('/auth/suspend-account', adminCookie, {
  method: 'POST', body: JSON.stringify({ email: emailForLabel(LABEL_SELLER), reason: 'e2e #2987 pending-restoration coverage' }),
});
if (suspend.response.status !== 200) {
  throw new Error(`suspend-account failed (${suspend.response.status}): ${JSON.stringify(suspend.body)}`);
}
console.log('instances removed by the suspension (should be 1):', suspend.body.instancesRemoved);

// #4297: the first read of the removed items fails; the list must be asked for again, not shown as "nothing removed".
await page.addInitScript(() => { window.__testPendingRetryDelaysMs = [500, 500, 500]; });
let pendingReads = 0;
await page.route('**/api/instances/pending-restoration', async (route) => {
  pendingReads += 1;
  if (pendingReads === 1) { await route.abort('failed'); return; }
  await route.continue();
});
await reloadBuildMode();
console.log('reads of the removed items (first aborted, then asked again; should be 2 or more):', pendingReads);
// #4201: the head wears a note for newly removed items (one tap opens the list), and says nothing once the list has been opened.
const noteBefore = await page.evaluate(() => {
  const note = document.getElementById('bud-note');
  return note && !note.hidden ? note.textContent : null;
});
console.log('head note for the newly removed item (should name Removed items):', noteBefore);
const shownAfterSuspension = await removedItemsButtonShown(page); // opens the Tools leaf, where the button now lives
const buttonText = shownAfterSuspension ? await page.locator('#pending-restoration-btn').textContent() : '';
console.log('"Removed items" button visible after the seller is suspended (should be true):', shownAfterSuspension, buttonText);

// #4201: in the Tools leaf the button wears the same dress as its siblings (a pill, not the browser's square default).
const buttonDress = await page.evaluate(() => {
  const own = getComputedStyle(document.getElementById('pending-restoration-btn'));
  const sibling = getComputedStyle(document.getElementById('toggle-ghosts'));
  return { own: own.borderRadius, sibling: sibling.borderRadius, height: parseFloat(own.minHeight) };
});
console.log('Removed items button dress matches its sibling (should be true):', buttonDress);
const buttonDressOk = buttonDress.own === buttonDress.sibling && buttonDress.height >= 44 && parseFloat(buttonDress.own) > 8;

await page.click('#pending-restoration-btn');
await page.waitForSelector('#pending-restoration-modal.visible', { timeout: 5000 });
await page.waitForSelector('.pending-restoration-row', { timeout: 5000 });
const rowText = await page.locator('.pending-restoration-row').first().textContent();
const rowCount = await page.locator('.pending-restoration-row').count();
console.log('exactly one row listed (should be 1):', rowCount);
console.log('row names the removed product (should include the product name):', rowText);

// #4201: the removed item can be shown as a ghost where it stood, under the one switch, and is never a placed item.
await page.click('#pending-restoration-close-btn');
await page.waitForSelector('#pending-restoration-modal.visible', { state: 'hidden', timeout: 5000 });
const ghostsBeforeToggle = await page.evaluate(() => window.__testRemovedGhostIds());
await page.click('#toggle-ghosts'); // #4201: the switch is "Faded items" in the Tools leaf
await page.waitForFunction(() => window.__testRemovedGhostIds().length === 1, undefined, { timeout: 5000 });
console.log('no ghost before the switch, one after (should be 0 then 1):', ghostsBeforeToggle.length, 1);
// The ghost is the item itself (its own model, translucent), not a block: #4201.
const ghostIsModel = await page.waitForFunction(() => window.__testGhostKinds().removed.join() === 'model', undefined, { timeout: 15000 }).then(() => true, () => false);
console.log('the ghost is the removed product\'s own model (should be true):', ghostIsModel);
// Tapping the ghost opens the list at its row.
await page.keyboard.press('Escape');
await page.waitForSelector('#settings-modal.visible', { state: 'hidden', timeout: 5000 }).catch(() => {});
const ghostPos = await page.evaluate(() => window.__testRemovedGhostScreenPos(window.__testRemovedGhostIds()[0]));
await page.mouse.click(ghostPos.x, ghostPos.y);
const tapOpenedList = await page.waitForSelector('#pending-restoration-modal.visible', { timeout: 5000 }).then(() => true, () => false);
console.log('a tap on the ghost opens the Removed items list (should be true):', tapOpenedList);
await page.click('#pending-restoration-close-btn');
// A slot whose product is gone entirely (no template): an outline carrying its name, never a block (#4201 item 4).
const goneOutline = await page.evaluate((landletId) => {
  window.__testSetRemovedGhostSlots([{
    snapshotId: 'gone-slot', landletId, templateId: 'template-that-is-gone', templateName: 'A product that is gone',
    position: { x: 2, y: 2, z: 0.5 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1, crop: null, label: null, template: null,
  }]);
  return { kinds: window.__testGhostKinds().removed, named: window.__testGhostNames() };
}, landlet.landletId);
console.log('a slot with no template is an outline with its name (should be outline, true):', goneOutline.kinds.join(), goneOutline.named.join());
const goneIsNamedOutline = goneOutline.kinds.join() === 'outline' && goneOutline.named.join() === 'true';
await page.click('#toggle-ghosts'); // #4201: the switch is "Faded items" in the Tools leaf
await page.waitForFunction(() => window.__testRemovedGhostIds().length === 0, undefined, { timeout: 5000 });
await page.keyboard.press('Escape');
await page.waitForSelector('#settings-modal.visible', { state: 'hidden', timeout: 5000 }).catch(() => {});
await page.click('#pending-restoration-btn').catch(async () => { await removedItemsButtonShown(page); await page.click('#pending-restoration-btn'); });
await page.waitForSelector('.pending-restoration-row', { timeout: 5000 });

// Clear it for good (#3278: confirmed in the in-app modal).
await page.locator('.pending-restoration-row-clear').first().click();
await acceptConfirmModal(page);
await page.waitForFunction(() => document.querySelectorAll('.pending-restoration-row').length === 0, null, { timeout: 5000 });
const emptyShown = await page.locator('#pending-restoration-empty').isVisible();
const buttonHiddenAfterClear = await page.evaluate(() => document.getElementById('pending-restoration-btn').hidden);
console.log('empty state shown after clearing (should be true):', emptyShown);
console.log('"Removed items" button hidden again once nothing is pending (should be true):', buttonHiddenAfterClear);

// Lifting the suspension must NOT bring a cleared slot back.
const unsuspend = await apiFetch('/auth/unsuspend-account', adminCookie, {
  method: 'POST', body: JSON.stringify({ email: emailForLabel(LABEL_SELLER) }),
});
if (unsuspend.response.status !== 200) {
  throw new Error(`unsuspend-account failed (${unsuspend.response.status}): ${JSON.stringify(unsuspend.body)}`);
}
console.log('instances restored after unsuspension (should be 0):', unsuspend.body.instancesRestored);
const { body: instancesAfter } = await pageFetchJson(`/api/instances?landletId=${landlet.landletId}`);
const stillGone = !instancesAfter.instances.some((i) => i.templateId === template.templateId);
console.log('cleared product did not return to the land (should be true):', stillGone);

const pass = placeRes.status === 201
  && hiddenBeforeSuspension
  && suspend.body.instancesRemoved === 1
  && shownAfterSuspension
  && /Removed items/.test(noteBefore ?? '')
  && /1/.test(buttonText)
  && buttonDressOk
  && rowCount === 1
  && ghostsBeforeToggle.length === 0
  && pendingReads >= 2
  && ghostIsModel
  && goneIsNamedOutline
  && tapOpenedList
  && rowText.includes(PRODUCT_NAME)
  && emptyShown
  && buttonHiddenAfterClear
  && unsuspend.body.instancesRestored === 0
  && stillGone
  && errors.every((e) => e.includes('net::ERR_FAILED')); // the one read aborted on purpose above (#4297)
await sellerBrowser.close();
await finish(browser, {
  pass,
  label: '#2987: Build mode lists products removed by a seller suspension and lets the builder clear one for good',
  errors,
});
