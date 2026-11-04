// #3095 (found walking #3083): a Build mode tab left open while its seller is
// suspended used to keep showing the removed product, and the next Undo
// surfaced a misleading "couldn't save moved item(s) ... may not survive a
// reload" error. Now the rejected save reconciles with the server: the
// phantom product leaves the scene, the Removed Items button appears without
// a reload, and the message says what actually happened.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, emailForLabel, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL_BUILDER = 'Open Tab Suspension Suite Builder';
const LABEL_SELLER = 'Open Tab Suspension Suite Seller';
const PRODUCT_NAME = 'Suite Open Tab Suspension Product';

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
modelForm.append('file', new Blob([await fs.readFile(CRATE_MODEL_PATH)], { type: 'model/gltf-binary' }), 'open-tab-suspension-crate.glb');
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
  body: JSON.stringify({ instanceId: `open-tab-suspension-instance-${crypto.randomUUID()}`, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});
console.log('product placed on the builder\'s land (should be 201):', placeRes.status);

await page.reload();
await chooseIdentity(page, { mode: 'build', label: LABEL_BUILDER, isNew: true });
await page.waitForSelector('#undo-redo-panel', { state: 'attached', timeout: 15000 });
await page.waitForTimeout(1500);

// Capture alert() text (launchPage's own handler just accepts them).
await page.evaluate(() => { window.__alerts = []; window.alert = (msg) => { window.__alerts.push(String(msg)); }; });

// An ordinary tree: placing it, then deleting it, leaves Undo enabled with a
// snapshot that also contains the (soon to be phantom) product.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(260, 520);
await page.waitForTimeout(800);
await page.click('#delete-item');
await page.waitForTimeout(800);
const undoEnabled = await page.locator('#undo-btn').isEnabled();
console.log('undo enabled after deleting the tree (should be true):', undoEnabled);

const productStillShownBefore = (await page.evaluate(() => window.__testProductScreenPositions())).length;
console.log('products in the scene before the suspension (should be 1):', productStillShownBefore);

// Suspend while this tab stays open -- no reload.
const suspend = await apiFetch('/auth/suspend-account', adminCookie, {
  method: 'POST', body: JSON.stringify({ email: emailForLabel(LABEL_SELLER), reason: 'e2e #3095 open-tab coverage' }),
});
if (suspend.response.status !== 200) {
  throw new Error(`suspend-account failed (${suspend.response.status}): ${JSON.stringify(suspend.body)}`);
}

await page.click('#undo-btn');
await page.waitForFunction(() => window.__alerts.length > 0 || document.getElementById('pending-restoration-btn')?.hidden === false, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);

const phantomsAfter = (await page.evaluate(() => window.__testProductScreenPositions()))
  .filter((p) => p.instanceId.startsWith('open-tab-suspension-instance-')).length;
const alerts = await page.evaluate(() => window.__alerts);
const buttonShown = await page.locator('#pending-restoration-btn').isVisible();
console.log('phantom product removed from the open tab (should be 0):', phantomsAfter);
console.log('Removed Items button visible without a reload (should be true):', buttonShown);
console.log('alerts:', JSON.stringify(alerts));
const misleading = alerts.some((a) => /may not survive a reload/.test(a));
const explained = alerts.some((a) => /seller is suspended/.test(a) && /Removed Items/.test(a));

const pass = placeRes.status === 201
  && undoEnabled
  && productStillShownBefore === 1
  && suspend.body.instancesRemoved === 1
  && phantomsAfter === 0
  && buttonShown
  && !misleading
  && explained
  // The one rejected save is the trigger itself: the browser logs its 400.
  && errors.every((e) => /status of 400/.test(e));
await sellerBrowser.close();
await finish(browser, {
  pass,
  label: '#3095: an open Build tab drops products removed by a seller suspension and explains it',
  errors,
});
