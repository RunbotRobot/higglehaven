// #2987 (3/5 of #2305): the builder-facing "Removed Items" view of #2986's
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
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, emailForLabel, finish, acceptConfirmModal } from './helpers.mjs';

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
const hiddenBeforeSuspension = await page.locator('#pending-restoration-btn').isHidden();
console.log('"Removed Items" button hidden while nothing is pending (should be true):', hiddenBeforeSuspension);

const suspend = await apiFetch('/auth/suspend-account', adminCookie, {
  method: 'POST', body: JSON.stringify({ email: emailForLabel(LABEL_SELLER), reason: 'e2e #2987 pending-restoration coverage' }),
});
if (suspend.response.status !== 200) {
  throw new Error(`suspend-account failed (${suspend.response.status}): ${JSON.stringify(suspend.body)}`);
}
console.log('instances removed by the suspension (should be 1):', suspend.body.instancesRemoved);

await reloadBuildMode();
const shownAfterSuspension = await page.locator('#pending-restoration-btn').isVisible();
const buttonText = shownAfterSuspension ? await page.locator('#pending-restoration-btn').textContent() : '';
console.log('"Removed Items" button visible after the seller is suspended (should be true):', shownAfterSuspension, buttonText);

await page.click('#pending-restoration-btn');
await page.waitForSelector('#pending-restoration-modal.visible', { timeout: 5000 });
await page.waitForSelector('.pending-restoration-row', { timeout: 5000 });
const rowText = await page.locator('.pending-restoration-row').first().textContent();
const rowCount = await page.locator('.pending-restoration-row').count();
console.log('exactly one row listed (should be 1):', rowCount);
console.log('row names the removed product (should include the product name):', rowText);

// Clear it for good (#3278: confirmed in the in-app modal).
await page.locator('.pending-restoration-row-clear').first().click();
await acceptConfirmModal(page);
await page.waitForFunction(() => document.querySelectorAll('.pending-restoration-row').length === 0, null, { timeout: 5000 });
const emptyShown = await page.locator('#pending-restoration-empty').isVisible();
const buttonHiddenAfterClear = await page.locator('#pending-restoration-btn').isHidden();
console.log('empty state shown after clearing (should be true):', emptyShown);
console.log('"Removed Items" button hidden again once nothing is pending (should be true):', buttonHiddenAfterClear);

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
  && /1/.test(buttonText)
  && rowCount === 1
  && rowText.includes(PRODUCT_NAME)
  && emptyShown
  && buttonHiddenAfterClear
  && unsuspend.body.instancesRestored === 0
  && stillGone
  && errors.length === 0;
await sellerBrowser.close();
await finish(browser, {
  pass,
  label: '#2987: Build mode lists products removed by a seller suspension and lets the builder clear one for good',
  errors,
});
