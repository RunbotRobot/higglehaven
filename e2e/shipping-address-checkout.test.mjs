// #4599 (shipping, 2/8): Buy on a shipped product asks where it goes before anything is sent. The form names what is
// missing where the person is typing, Cancel leaves the card open and buys nothing, and a filled-in form carries the
// address through to the order, which keeps its own copy (My Purchases shows "Ships to"). A digital good never asks.
// The seller has no payments set up and the buyer is an admin, so the no-card path is the one taken: the address is
// asked first, then the usual "Buy this item?" confirmation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish, emailForLabel, grantAdmin } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Ship Address Tester';
const VIEWPORT = { width: 390, height: 844 };

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: VIEWPORT });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

async function pageFetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  }, [pathAndQuery, options]);
}
const json = (body, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const { body: sellerMeBody } = await pageFetchJson('/api/sellers/me');
const modelForm = new FormData();
modelForm.append('file', new Blob([await fs.readFile(CRATE_MODEL_PATH)], { type: 'model/gltf-binary' }), 'ship-address-crate.glb');
const modelUploadRes = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: modelForm });
const modelUpload = await modelUploadRes.json();
if (modelUploadRes.status !== 200 && modelUploadRes.status !== 201) throw new Error(`model upload failed (${modelUploadRes.status})`);
const sessionCookie = (await page.context().cookies()).find((c) => c.name === 'hh_session');
async function createTemplate(fields) {
  const res = await fetch(`${BASE_URL}/api/catalog`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sessionCookie ? `hh_session=${sessionCookie.value}` : '' },
    body: JSON.stringify({
      category: 'placeholder', color: '#8899aa',
      dimensions: { width: 1.2, depth: 1.2, height: 1.2 },
      sellerId: sellerMeBody.seller.sellerId, modelUrl: modelUpload.modelUrl, modelSizeBytes: modelUpload.sizeBytes,
      ...fields,
    }),
  });
  const body = await res.json();
  if (res.status !== 200 && res.status !== 201) throw new Error(`catalog template create failed (${res.status}): ${JSON.stringify(body)}`);
  return body.template.templateId;
}
const shippedTemplate = await createTemplate({ name: 'Shipped Crate', priceCents: 500 });

const { body: buildersBody } = await pageFetchJson('/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];
const SHIPPED_ID = 'ship-address-crate-instance';
const placed = (await pageFetchJson('/api/instances/batch', json({
  instances: [{ instanceId: SHIPPED_ID, landletId: landlet.landletId, templateId: shippedTemplate, x: 0, y: 0 }],
}))).status;
console.log('placed the shipped product:', placed);
await grantAdmin(emailForLabel(LABEL));

await page.reload();
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });
await page.waitForTimeout(1000);
await page.keyboard.down('KeyD');
await page.waitForTimeout(150);
await page.keyboard.up('KeyD');
await page.waitForTimeout(100);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const modalOpen = () => page.locator('#shipping-address-modal.visible').count();

await page.evaluate(([px, py]) => {
  window.__testTeleportShopAvatar(px, py - 2, 0);
  window.__testForceShopProximityCheck();
}, [landlet.center.x, landlet.center.y]);
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() >= 1, null, { timeout: 30000 });
await page.waitForTimeout(800);
await page.evaluate((id) => window.__testTapShopProductByInstanceId(id), SHIPPED_ID);
await page.waitForFunction(() => !document.getElementById('product-card').hidden, null, { timeout: 8000 });
await page.waitForSelector('#product-card-buy-btn.visible', { timeout: 8000 });

// Buy asks for the address first.
await page.click('#product-card-buy-btn');
await page.waitForSelector('#shipping-address-modal.visible', { timeout: 10000 });
check((await page.locator('#confirm-modal.visible').count()) === 0, 'the address is asked before any confirmation');

// An empty form says what is missing and stays open.
await page.click('#shipping-address-continue-btn');
await page.waitForTimeout(200);
check((await modalOpen()) === 1, 'an incomplete form stays open');
check(/name/i.test(await page.textContent('#shipping-address-error')), 'it says the first thing missing');

// Cancel buys nothing and leaves the card open.
await page.click('#shipping-address-cancel-btn');
await page.waitForFunction(() => !document.getElementById('shipping-address-modal').classList.contains('visible'), null, { timeout: 5000 });
check((await page.locator('#product-card:not([hidden])').count()) === 1, 'cancelling leaves the product card open');
check((await pageFetchJson('/api/purchases/mine')).body?.purchases?.length === 0, 'cancelling buys nothing');

// Fill it in, then confirm.
await page.waitForFunction(() => !document.getElementById('product-card-buy-btn').disabled, null, { timeout: 5000 });
await page.click('#product-card-buy-btn');
await page.waitForSelector('#shipping-address-modal.visible', { timeout: 10000 });
await page.fill('#shipping-address-name', 'Ship Tester');
await page.fill('#shipping-address-line1', '12 Orchard Lane');
await page.fill('#shipping-address-city', 'Portland');
await page.fill('#shipping-address-region', 'OR');
await page.fill('#shipping-address-postal', '97201');
await page.click('#shipping-address-continue-btn');
await page.waitForSelector('#confirm-modal.visible', { timeout: 10000 });
await page.click('#confirm-modal-confirm-btn');
// The no-card path ends in a celebration, not a notice; the order is the thing to wait for.
await page.waitForFunction(async () => (await (await fetch('/api/purchases/mine')).json()).purchases?.length === 1, null, { timeout: 15000 });

const mine = (await pageFetchJson('/api/purchases/mine')).body?.purchases || [];
check(mine.length === 1, 'one order was made');
check(mine[0]?.shippingAddress?.line1 === '12 Orchard Lane' && mine[0]?.shippingAddress?.country === 'US', 'the order keeps the address it was bought with');

await finish(browser, { pass, label: '#4599: Buy on a shipped product asks for an address, and the order keeps it', errors });
