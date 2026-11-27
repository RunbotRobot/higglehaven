// #4602 (Shipping 5/8, part of #4394): with "Dim what cannot ship to me" on, a product that ships to the United States only is
// washed toward cream where it stands (the real model, still there and still tappable) and its card offers no Buy and says
// why; a product with no such limit is untouched. Both are judged for a shopper whose country is France.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish, emailForLabel, grantAdmin } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Ship Dim Tester';
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
modelForm.append('file', new Blob([await fs.readFile(CRATE_MODEL_PATH)], { type: 'model/gltf-binary' }), 'product-card-crate.glb');
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
const domesticTemplate = await createTemplate({ name: 'Domestic Crate', priceCents: 500, metadata: { domesticOnly: true } });
const plainTemplate = await createTemplate({ name: 'Plain Crate', priceCents: 500 });

const { body: buildersBody } = await pageFetchJson('/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];

const DOMESTIC_ID = 'ship-dim-domestic';
const PLAIN_ID = 'ship-dim-plain';
const batch = (await pageFetchJson('/api/instances/batch', json({
  instances: [
    { instanceId: DOMESTIC_ID, landletId: landlet.landletId, templateId: domesticTemplate, x: -1.6, y: 0 },
    { instanceId: PLAIN_ID, landletId: landlet.landletId, templateId: plainTemplate, x: 1.6, y: 0 },
  ],
}))).status;
console.log('seeded two placements:', batch);

// The shopper's country is France and the switch is on (the same route Settings uses).
const setDest = await pageFetchJson('/api/shipping-destination', json({ country: 'FR', dimUnshippable: true }, 'PUT'));
console.log('destination saved (should be 200):', setDest.status);

// The page's catalog was fetched before these products existed.
await page.reload();
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 30000 }); // #3669: the fly button is gone
await page.waitForTimeout(1000);

// A fresh Shop-mode spawn keeps overwriting the avatar's position until real
// navigation input first arrives; the same release gesture other Shop e2es use.
// #3669: the on-screen stick is gone; a short key press is the same first navigation input.
await page.keyboard.down('KeyD');
await page.waitForTimeout(150);
await page.keyboard.up('KeyD');
await page.waitForTimeout(100);

// E2E_SHOT_DIR=<dir> saves a screenshot at each stage (for a PR description).
const shot = async (name) => {
  if (process.env.E2E_SHOT_DIR) await page.screenshot({ path: path.join(process.env.E2E_SHOT_DIR, `product-card-${name}.png`) });
};

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const cx = landlet.center.x;
const cy = landlet.center.y;
const moveTo = ([x, y]) => page.evaluate(([px, py]) => {
  window.__testTeleportShopAvatar(px, py, 0);
  window.__testForceShopProximityCheck();
}, [x, y]);
const screenPoint = (id) => page.evaluate((instanceId) => window.__testShopScreenPointOfInstance(instanceId), id);
const cardRect = () => page.evaluate(() => {
  const el = document.getElementById('product-card');
  if (!el || el.hidden) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, side: el.dataset.side, edge: el.dataset.edge, state: el.dataset.state };
});
const cardOpen = async () => (await cardRect()) !== null;
const inside = (rect, p) => p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;

// Stand where the camera looks at the products, so real taps can reach them.
await moveTo([cx, cy]);
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() >= 2, null, { timeout: 30000 });
await page.waitForTimeout(800);
const view = await page.evaluate(() => window.__testShopCameraView());
const heading = Math.hypot(view.dx, view.dy) || 1;
let domesticPoint = null;
let plainPoint = null;
for (const back of [2.5, 3.5, 1.5, 4.5, 0.5]) {
  await moveTo([cx - (view.dx / heading) * back, cy - (view.dy / heading) * back]);
  await page.waitForTimeout(800);
  domesticPoint = await screenPoint(DOMESTIC_ID);
  plainPoint = await screenPoint(PLAIN_ID);
  const centred = (p) => p && p.inFront && Math.abs(p.ndcX) < 0.93 && Math.abs(p.ndcY) < 0.8;
  if (centred(domesticPoint) && centred(plainPoint)) break;
  domesticPoint = null;
}
check(domesticPoint !== null, 'both products can be put on screen');
if (!domesticPoint) await finish(browser, { pass: false, label: '#4602: ship dim (could not frame the products)', errors });

const cardState = () => page.evaluate(() => ({
  name: document.getElementById('product-card-name').textContent.trim(),
  state: document.getElementById('product-card-state').textContent.trim(),
  buyShown: document.getElementById('product-card-buy-btn').classList.contains('visible'),
}));

// The dim is one number per product (its template), so two products sharing one model file can differ.
const levels = await page.evaluate(() => window.__testShipDimLevels());
console.log('ship-dim levels by template:', JSON.stringify(levels));
check(levels[domesticTemplate] === 1, 'the domestic crate is dimmed');
check(levels[plainTemplate] === 0, 'the plain crate is not');
await shot('dimmed');

await page.mouse.click(domesticPoint.x, domesticPoint.y);
await page.waitForFunction(() => !document.getElementById('product-card').hidden && document.getElementById('product-card-name').textContent.trim() === 'Domestic Crate', null, { timeout: 8000 });
await page.waitForTimeout(1200);
const domestic = await cardState();
console.log('domestic crate card:', JSON.stringify(domestic));
check(/does not ship to your country/.test(domestic.state), `the card says it does not ship (${domestic.state})`);
check(!domestic.buyShown, 'no Buy for a product that does not ship here');

await page.keyboard.press('Escape');
await page.waitForFunction(() => document.getElementById('product-card').hidden, null, { timeout: 5000 });
await page.mouse.click(plainPoint.x, plainPoint.y);
await page.waitForFunction(() => !document.getElementById('product-card').hidden && document.getElementById('product-card-name').textContent.trim() === 'Plain Crate', null, { timeout: 5000 });
await page.waitForTimeout(1200);
const plain = await cardState();
check(!/does not ship/.test(plain.state), 'a product with no limit is not called unshippable');
check(plain.buyShown, 'a product that ships here still offers Buy');

await finish(browser, { pass: pass && errors.length === 0, label: '#4602: a product that does not ship to the shopper offers no Buy and says why; one that does is untouched', errors });
