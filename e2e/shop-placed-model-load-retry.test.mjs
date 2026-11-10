// #3254: a placed product whose model fetch fails once (a dropped request on a
// phone, an R2 read racing the upload) used to stay a plain grey bounding box
// for the whole tab session: createMeshForInstance caught the failure, fell
// back to the box, and nothing ever tried again. It now retries once, so a
// transient failure still ends with the real model. The first browser request
// for the model file is aborted here to stand in for that dropped request.
// A model that never loads still ends as the box (covered by the existing
// fallback path); this only asserts the recoverable case recovers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AVATAR_MODEL_PATH = path.join(REPO_ROOT, 'e2e', 'fixtures', 'test-rigged-avatar.glb');
const LABEL = 'Placed Model Retry Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

async function pageFetchJson(p, options) {
  return page.evaluate(async ([u, o]) => {
    const res = await fetch(u, o);
    return { status: res.status, body: await res.json() };
  }, [p, options]);
}
const { body: sellerMe } = await pageFetchJson('/api/sellers/me');

const form = new FormData();
form.append('file', new Blob([await fs.readFile(AVATAR_MODEL_PATH)], { type: 'model/gltf-binary' }), 'retry-model.glb');
const upload = await (await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: form })).json();

const sess = (await page.context().cookies()).find((c) => c.name === 'hh_session');
const templateRes = await fetch(`${BASE_URL}/api/catalog`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: sess ? `hh_session=${sess.value}` : '' },
  body: JSON.stringify({
    name: 'Placed Model Retry Product', category: 'placeholder', color: '#999999',
    dimensions: { width: 1, depth: 1, height: 1 },
    sellerId: sellerMe.seller.sellerId, modelUrl: upload.modelUrl, modelSizeBytes: upload.sizeBytes, priceCents: 500,
  }),
});
const template = (await templateRes.json()).template;

const { body: builders } = await pageFetchJson('/api/builders');
const me = builders.builders.find((b) => b.label === LABEL);
const { body: lands } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`);
const landlet = lands.landlets[0];
const instanceId = `retry-instance-${crypto.randomUUID()}`;
const placed = await pageFetchJson('/api/instances', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});
console.log('instance placed (should be 201):', placed.status);

// Abort only the first request for the model file.
let modelRequests = 0;
await page.route(`**${upload.modelUrl}`, async (route) => {
  modelRequests += 1;
  if (modelRequests === 1) return route.abort('failed');
  return route.continue();
});

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
const joystick = await page.locator('#shop-move-joystick').boundingBox();
const cx = joystick.x + joystick.width / 2;
const cy = joystick.y + joystick.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 25, cy, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.evaluate(([x, y]) => { window.__testTeleportShopAvatar(x, y, 0); window.__testForceShopProximityCheck(); }, [landlet.center.x + 4, landlet.center.y]);

// z = 0 lands the avatar on the ground beside the item (#3373: the tier is by apparent size from the camera, and the
// spawn flight is ~80 m up, where a 1 m item is a box). 'none' = the grey box fallback, 'near' = the real model with its LOD proxy.
let band = null;
const deadline = Date.now() + 15000;
while (band !== 'near' && Date.now() < deadline) {
  band = await page.evaluate((id) => window.__testShopInstanceLodBand(id), instanceId);
  if (band !== 'near') await page.waitForTimeout(200);
}
console.log('model requests made (first was aborted, so should be >= 2):', modelRequests);
console.log('final band after the dropped first request (should be "near", not "none"):', band);
await finish(browser, { pass: band === 'near' && modelRequests >= 2, label: 'placed product recovers its model after one dropped fetch', errors: errors.filter((e) => !/Failed to load resource|net::ERR_FAILED/.test(String(e))) });
