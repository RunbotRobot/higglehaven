// #2378 (sub-issue of #2377, docs/SPEC.md §1's near/middle-LOD/far-
// panoramic-backdrop chunk loading): a model-loaded placed instance should
// swap to a cheap simplified-proxy box once it looks small on screen, rather
// than staying at full detail all the way out to the unload radius, and swap
// back to full detail on re-approach. #3373: the swap is by apparent size
// (src/shop/lodTier.js), not a fixed distance, so a large item keeps its real
// model at a range where a small one is already a box, with a hysteresis band
// in between. This drives the real teleport+forced-
// proximity-check pattern e2e/shop-landlet-instance-leak.test.mjs (#1445)
// already established for deterministically crossing these radii, minus
// that file's own GLTF-fetch-delay race machinery (not needed here — this
// only cares about the LOD state once the instance has actually loaded,
// not about an in-flight load being superseded).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Middle LOD Band Suite Tester';
const PRODUCT_NAME = 'Suite Middle LOD Band Product';
const LARGE_PRODUCT_NAME = 'Suite Middle LOD Band Large Product';

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

// Same "grow the world and blanket it with one big filler landlet" shape
// as e2e/shop-landlet-instance-leak.test.mjs's own ensureRoomToWander (see
// that file's header comment for why this is needed at all — Shop mode's
// own gapless-coverage radius, computed from the real landlets that exist,
// clamps shopAvatarPosition even for a direct __testTeleportShopAvatar call).
async function ensureRoomToWander() {
  const cookie = await ensureAdminSession();
  const worldPatch = await adminFetch('/world', cookie, { method: 'PATCH', body: JSON.stringify({ radiusM: 200 }) });
  if (worldPatch.response.status !== 200) {
    throw new Error(`ensureRoomToWander: world radius patch failed -- ${JSON.stringify(worldPatch.body)}`);
  }
  const filler = await adminFetch('/landlets', cookie, {
    method: 'POST',
    body: JSON.stringify({
      landletId: `e2e-middle-lod-filler-${crypto.randomUUID()}`,
      name: 'Middle LOD Band Suite Coverage Filler',
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

// Uploaded straight through the API (not the page's own upload wizard) so
// Shop mode's load below is a model-loaded instance, not the box-fallback
// path (which has no LOD proxy at all — see buildInstanceLodProxy).
const modelBytes = await fs.readFile(CRATE_MODEL_PATH);
const modelForm = new FormData();
modelForm.append('file', new Blob([modelBytes], { type: 'model/gltf-binary' }), 'middle-lod-crate.glb');
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

// #3373: the same model declared 8 m on a side: at the same range it looks
// several times bigger on screen than the 1 m one.
const largeTemplateRes = await fetch(`${BASE_URL}/api/catalog`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: cookieHeader },
  body: JSON.stringify({
    name: LARGE_PRODUCT_NAME, category: 'placeholder', color: '#8899aa',
    dimensions: { width: 8, depth: 8, height: 8 },
    sellerId, modelUrl: modelUpload.modelUrl, modelSizeBytes: modelUpload.sizeBytes, priceCents: 500,
  }),
});
const largeTemplateBody = await largeTemplateRes.json();
if (largeTemplateRes.status !== 200 && largeTemplateRes.status !== 201) {
  throw new Error(`large catalog template create failed (${largeTemplateRes.status}): ${JSON.stringify(largeTemplateBody)}`);
}
const largeTemplate = largeTemplateBody.template;

const { body: buildersBody } = await pageFetchJson('/api/builders');
const me = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];
console.log('claimed landlet found to place the test product on:', !!landlet);

const instanceId = `middle-lod-instance-${crypto.randomUUID()}`;
await pageFetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});

const largeInstanceId = `middle-lod-large-instance-${crypto.randomUUID()}`;
await pageFetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId: largeInstanceId, landletId: landlet.landletId, templateId: largeTemplate.templateId, x: 10, y: 10 }),
});

const landletCenterX = landlet.center.x;
const landletCenterY = landlet.center.y;
// Unit vector pointing away from the origin, same reasoning as
// e2e/shop-landlet-instance-leak.test.mjs's own awayDirX/awayDirY — picks a
// direction that stays within ensureRoomToWander's 300m-sided coverage
// regardless of where this particular landlet ended up.
const awayDist = Math.hypot(landletCenterX, landletCenterY);
const awayDirX = awayDist > 1 ? -landletCenterX / awayDist : 1;
const awayDirY = awayDist > 1 ? -landletCenterY / awayDist : 0;

async function teleportShopAvatar(distanceFromLandletM) {
  const x = landletCenterX + awayDirX * distanceFromLandletM;
  const y = landletCenterY + awayDirY * distanceFromLandletM;
  await page.evaluate(([tx, ty]) => {
    // #3373: z = 0 lands the avatar on the ground. The swap is by apparent size from the
    // camera, and the spawn flight is ~80 m up, which would make every item look small.
    window.__testTeleportShopAvatar(tx, ty, 0);
    window.__testForceShopProximityCheck();
  }, [x, y]);
}

async function lodBand(id = instanceId) {
  return page.evaluate((i) => window.__testShopInstanceLodBand(i), id);
}

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// Stops the hands-off spawn orbit so the teleport hook's own writes to
// shopAvatarPosition actually stick frame-to-frame, same gesture
// e2e/shop-landlet-instance-leak.test.mjs and e2e/go-to-last-location.test.mjs
// already use for this.
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
await teleportShopAvatar(25);
// Poll (not a fixed sleep) for the instance to actually finish loading —
// the model fetch itself is real async I/O.
let band = null;
const loadDeadlineAt = Date.now() + 10000;
while ((band === null || (await lodBand(largeInstanceId)) === null) && Date.now() < loadDeadlineAt) {
  band = await lodBand();
  await page.waitForTimeout(100);
}
band = await lodBand();
console.log('LOD band once loaded near the landlet (should be "near"):', band);
const nearAfterLoad = band;

// 80 m: a 1 m item is only ~16 px across, under the swap-down size -- the simplified
// proxy, not an unload. The 8 m item at the same range is still a prominent ~130 px
// object and keeps its real model (#3373: the owner's "huge item turns into a cube").
await teleportShopAvatar(80);
const bandAtMiddle = await lodBand();
const largeBandAtMiddle = await lodBand(largeInstanceId);
console.log('small item at 80 m (should be "middle", not null/unloaded):', bandAtMiddle);
console.log('large item at the same range (should still be "near"):', largeBandAtMiddle);

// ~45 m: the 1 m item is ~29 px, inside the swap hysteresis band (24-36 px). Coming
// from "middle" it must hold the box, not flip back up just from being a bit closer.
await teleportShopAvatar(45);
const bandInHysteresisGap = await lodBand();
console.log('small item inside the size hysteresis band, approaching from middle (should still be "middle"):', bandInHysteresisGap);

// Close: well past the swap-back size -- full detail again.
await teleportShopAvatar(25);
const bandAfterReapproach = await lodBand();
console.log('small item after re-approaching (should be "near" again):', bandAfterReapproach);

// The same band, now approaching from "near": it must hold the full model.
await teleportShopAvatar(45);
const bandInGapFromNear = await lodBand();
console.log('small item inside the size hysteresis band, approaching from near (should still be "near"):', bandInGapFromNear);
await teleportShopAvatar(25);

// #3254: the proxy takes the model's own color, not the template's generic
// placeholder (#8899aa here). crate.glb's material is orange (red-dominant).
const proxyColorHex = await page.evaluate((id) => window.__testShopInstanceLodProxyColor(id), instanceId);
console.log('LOD proxy color comes from the model, not template.color (should be an orange, not 8899aa):', proxyColorHex);
const proxyIsModelColor = typeof proxyColorHex === 'string' && proxyColorHex !== '8899aa' &&
  parseInt(proxyColorHex.slice(0, 2), 16) > parseInt(proxyColorHex.slice(4, 6), 16) + 60;

const pass = !!landlet
  && proxyIsModelColor
  && nearAfterLoad === 'near'
  && bandAtMiddle === 'middle'
  && largeBandAtMiddle === 'near'
  && bandInHysteresisGap === 'middle'
  && bandAfterReapproach === 'near'
  && bandInGapFromNear === 'near'
  && errors.length === 0;
await finish(browser, {
  pass,
  label: '#2378: a model-loaded placed instance swaps to a simplified LOD proxy in the middle distance band and back to full detail on re-approach, with real enter/exit hysteresis',
  errors,
});
