// #2399: setInstanceLodState (#2378's middle-LOD-band swap) only ever
// toggled `.visible` on the proxy box and the real model's own children --
// but THREE.Raycaster's tree walk never checks `.visible` (only `.layers`,
// then each object's own raycast() return value), so visibility alone
// never decided which representation actually caught a tap. The *visible*
// one (proxy in the middle band, real model up close) needs to be the one
// that's actually hit-testable; the hidden one needs to be excluded, or a
// tap meant for what the shopper can see gets silently absorbed by
// whatever's invisible instead.
//
// Reuses e2e/shop-middle-lod-band.test.mjs's own real-model setup (crate.glb
// uploaded through the API, same teleport+forceProximityCheck pattern for
// deterministically crossing the enter/exit radii) rather than duplicating
// it, then drives the new window.__testShopInstanceLodHitSource hook (added
// alongside this fix) at both bands to confirm the hit always lands on the
// currently-visible representation, never the hidden one.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Middle LOD Band Tap Hit Tester';
const PRODUCT_NAME = 'Tap Hit Test Middle LOD Product';

async function adminFetch(pathAndQuery, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${pathAndQuery}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...options.headers,
    },
  });
  return { response, body: await response.json() };
}

// Same "grow the world and blanket it with one big filler landlet" shape as
// e2e/shop-middle-lod-band.test.mjs's own ensureRoomToWander.
async function ensureRoomToWander() {
  const cookie = await ensureAdminSession();
  const worldPatch = await adminFetch('/world', cookie, { method: 'PATCH', body: JSON.stringify({ radiusM: 200 }) });
  if (worldPatch.response.status !== 200) {
    throw new Error(`ensureRoomToWander: world radius patch failed -- ${JSON.stringify(worldPatch.body)}`);
  }
  const filler = await adminFetch('/landlets', cookie, {
    method: 'POST',
    body: JSON.stringify({
      landletId: `e2e-middle-lod-tap-filler-${crypto.randomUUID()}`,
      name: 'Middle LOD Tap Hit Test Coverage Filler',
      areaM2: 300 * 300,
      centerX: 0,
      centerY: 0,
      status: 'generating',
    }),
  });
  if (filler.response.status !== 201) {
    throw new Error(`ensureRoomToWander: filler landlet create failed -- ${JSON.stringify(filler.body)}`);
  }
}

await ensureRoomToWander();

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

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
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { body: sellerMeBody } = await pageFetchJson('/api/sellers/me');
const sellerId = sellerMeBody.seller.sellerId;

// Uploaded straight through the API so Shop mode's load below is a
// model-loaded instance, not the box-fallback path (which has no LOD proxy
// at all -- see buildInstanceLodProxy).
const modelBytes = await fs.readFile(CRATE_MODEL_PATH);
const modelForm = new FormData();
modelForm.append('file', new Blob([modelBytes], { type: 'model/gltf-binary' }), 'tap-hit-test-crate.glb');
const modelUploadRes = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: modelForm });
const modelUpload = await modelUploadRes.json();
if (modelUploadRes.status !== 200 && modelUploadRes.status !== 201) {
  throw new Error(`model upload failed (${modelUploadRes.status}): ${JSON.stringify(modelUpload)}`);
}

const cookies = await page.context().cookies();
const sessionCookie = cookies.find((c) => c.name === 'hh_session');
const cookieHeader = sessionCookie ? `hh_session=${sessionCookie.value}` : '';
const templateRes = await fetch(`${BASE_URL}/api/catalog`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: cookieHeader },
  body: JSON.stringify({
    name: PRODUCT_NAME, category: 'placeholder', color: '#8899aa',
    dimensions: { width: 1, depth: 1, height: 1 },
    sellerId, modelUrl: modelUpload.modelUrl, modelSizeBytes: modelUpload.sizeBytes, priceCents: 500,
  }),
});
const templateBody = await templateRes.json();
if (templateRes.status !== 200 && templateRes.status !== 201) {
  throw new Error(`catalog template create failed (${templateRes.status}): ${JSON.stringify(templateBody)}`);
}
const template = templateBody.template;

const { body: buildersBody } = await pageFetchJson('/api/builders');
const me = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];
console.log('claimed landlet found to place the test product on:', !!landlet);

const instanceId = `middle-lod-tap-hit-instance-${crypto.randomUUID()}`;
await pageFetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});

const landletCenterX = landlet.center.x;
const landletCenterY = landlet.center.y;
const awayDist = Math.hypot(landletCenterX, landletCenterY);
const awayDirX = awayDist > 1 ? -landletCenterX / awayDist : 1;
const awayDirY = awayDist > 1 ? -landletCenterY / awayDist : 0;

async function teleportShopAvatar(distanceFromLandletM) {
  const x = landletCenterX + awayDirX * distanceFromLandletM;
  const y = landletCenterY + awayDirY * distanceFromLandletM;
  await page.evaluate(([tx, ty]) => {
    window.__testTeleportShopAvatar(tx, ty);
    window.__testForceShopProximityCheck();
  }, [x, y]);
}

async function lodBand() {
  return page.evaluate((id) => window.__testShopInstanceLodBand(id), instanceId);
}

async function lodHitSource() {
  return page.evaluate((id) => window.__testShopInstanceLodHitSource(id), instanceId);
}

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// Stops the hands-off spawn orbit so the teleport hook's own writes to
// shopAvatarPosition actually stick frame-to-frame, same gesture
// e2e/shop-middle-lod-band.test.mjs already uses for this.
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveCenterX, moveCenterY);
await page.mouse.down();
await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

// Into SHOP_LOAD_RADIUS_M (60m) -- triggers the real load.
await teleportShopAvatar(30);
let band = null;
const loadDeadlineAt = Date.now() + 10000;
while (band === null && Date.now() < loadDeadlineAt) {
  band = await lodBand();
  if (band === null) await page.waitForTimeout(100);
}
console.log('LOD band once loaded near the landlet (should be "near"):', band);
const hitSourceNear = await lodHitSource();
console.log('Hit source while band is "near" (should be "real" -- full detail is the visible representation):', hitSourceNear);

// Past SHOP_MIDDLE_LOD_ENTER_RADIUS_M (75m) -- swaps to the simplified proxy.
await teleportShopAvatar(80);
const bandAtMiddle = await lodBand();
console.log('LOD band past the middle-band enter threshold (should be "middle"):', bandAtMiddle);
const hitSourceMiddle = await lodHitSource();
console.log('Hit source while band is "middle" (should be "proxy" -- the simplified box is the visible representation, not the hidden real model):', hitSourceMiddle);

const pass = !!landlet
  && band === 'near'
  && hitSourceNear === 'real'
  && bandAtMiddle === 'middle'
  && hitSourceMiddle === 'proxy'
  && errors.length === 0;
await finish(browser, {
  pass,
  label: '#2399: a tap always lands on whichever LOD representation is actually visible, never the hidden one',
  errors,
});
