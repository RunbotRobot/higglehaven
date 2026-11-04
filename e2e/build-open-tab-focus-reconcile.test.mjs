// #3095, second half (the failed-save half is e2e/build-open-tab-seller-
// suspension.test.mjs): a Build tab that is merely left open -- no save is ever
// attempted -- must also stop showing a suspended seller's removed product once
// it regains focus, WITHOUT touching anything the builder placed themselves.
// Drives the real sequence: open tab with the product plus an ordinary tree,
// admin suspends the seller, the tab becomes visible again (visibilitychange),
// and the phantom leaves the scene, the Removed Items button appears, and the
// builder's tree stays.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, emailForLabel, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL_BUILDER = 'Open Tab Focus Suite Builder';
const LABEL_SELLER = 'Open Tab Focus Suite Seller';
const PRODUCT_NAME = 'Suite Open Tab Focus Product';

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
modelForm.append('file', new Blob([await fs.readFile(CRATE_MODEL_PATH)], { type: 'model/gltf-binary' }), 'open-tab-focus-crate.glb');
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
  body: JSON.stringify({ instanceId: `open-tab-focus-instance-${crypto.randomUUID()}`, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});
console.log('product placed on the builder\'s land (should be 201):', placeRes.status);

await page.reload();
await chooseIdentity(page, { mode: 'build', label: LABEL_BUILDER, isNew: true });
await page.waitForSelector('#undo-redo-panel', { state: 'attached', timeout: 15000 });
await page.waitForTimeout(1500);

// Capture alert() text (launchPage's own handler just accepts them).
await page.evaluate(() => { window.__alerts = []; window.alert = (msg) => { window.__alerts.push(String(msg)); }; });

// An ordinary tree the builder owns: it must survive the reconcile.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(260, 520);
await page.waitForTimeout(1200);

const productsBefore = (await page.evaluate(() => window.__testProductScreenPositions()))
  .filter((p) => p.instanceId.startsWith('open-tab-focus-instance-')).length;
const totalBefore = (await page.evaluate(() => window.__testProductScreenPositions())).length;
console.log('suspended seller\'s product shown before the suspension (should be 1):', productsBefore);

const suspend = await apiFetch('/auth/suspend-account', adminCookie, {
  method: 'POST', body: JSON.stringify({ email: emailForLabel(LABEL_SELLER), reason: 'e2e #3095 focus-reconcile coverage' }),
});
if (suspend.response.status !== 200) {
  throw new Error(`suspend-account failed (${suspend.response.status}): ${JSON.stringify(suspend.body)}`);
}

// Still no reload, no save: the tab just becomes visible again.
const phantomsBeforeFocus = (await page.evaluate(() => window.__testProductScreenPositions()))
  .filter((p) => p.instanceId.startsWith('open-tab-focus-instance-')).length;
console.log('phantom still shown before focus (should be 1):', phantomsBeforeFocus);
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.waitForFunction(() => window.__alerts.length > 0, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(800);

const after = await page.evaluate(() => window.__testProductScreenPositions());
const phantomsAfter = after.filter((p) => p.instanceId.startsWith('open-tab-focus-instance-')).length;
const alerts = await page.evaluate(() => window.__alerts);
const buttonShown = await page.locator('#pending-restoration-btn').isVisible();
console.log('phantom removed after focus (should be 0):', phantomsAfter);
console.log('builder\'s own items still shown (should be totalBefore - 1):', after.length, 'of', totalBefore);
console.log('Removed Items button visible (should be true):', buttonShown);
console.log('alerts:', JSON.stringify(alerts));
const explained = alerts.some((a) => /seller is suspended/.test(a) && /Removed Items/.test(a));

const pass = placeRes.status === 201
  && productsBefore === 1
  && phantomsBeforeFocus === 1
  && suspend.body.instancesRemoved === 1
  && phantomsAfter === 0
  && after.length === totalBefore - 1
  && buttonShown
  && explained
  && errors.length === 0;
await sellerBrowser.close();
await finish(browser, {
  pass,
  label: '#3095: an open Build tab drops products removed by a seller suspension on regaining focus, and keeps the builder\'s own items',
  errors,
});
