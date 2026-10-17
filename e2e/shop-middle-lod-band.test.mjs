// #2378 (sub-issue of #2377, docs/SPEC.md §1's near/middle-LOD/far-
// panoramic-backdrop chunk loading): a model-loaded placed instance should
// swap to a cheap simplified-proxy box once the shopper is far enough away
// (past SHOP_MIDDLE_LOD_ENTER_RADIUS_M, between the existing near-load and
// far-unload radii) rather than staying at full detail all the way out to
// SHOP_UNLOAD_RADIUS_M, and swap back to full detail on re-approach (past
// SHOP_MIDDLE_LOD_EXIT_RADIUS_M). This drives the real teleport+forced-
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
    window.__testTeleportShopAvatar(tx, ty);
    window.__testForceShopProximityCheck();
  }, [x, y]);
}

async function lodBand() {
  return page.evaluate((id) => window.__testShopInstanceLodBand(id), instanceId);
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
await teleportShopAvatar(30);
// Poll (not a fixed sleep) for the instance to actually finish loading —
// the model fetch itself is real async I/O.
let band = null;
const loadDeadlineAt = Date.now() + 10000;
while (band === null && Date.now() < loadDeadlineAt) {
  band = await lodBand();
  if (band === null) await page.waitForTimeout(100);
}
console.log('LOD band once loaded near the landlet (should be "near"):', band);
const nearAfterLoad = band;

// Past SHOP_MIDDLE_LOD_ENTER_RADIUS_M (75m) but under SHOP_UNLOAD_RADIUS_M
// (90m) -- should swap to the simplified proxy, not unload outright.
await teleportShopAvatar(80);
const bandAtMiddle = await lodBand();
console.log('LOD band past the middle-band enter threshold (should be "middle", not null/unloaded):', bandAtMiddle);

// Inside the enter/exit hysteresis gap (65-75m) -- should hold whatever
// state it was already in (middle), not flip back just from being closer
// than the enter threshold alone.
await teleportShopAvatar(70);
const bandInHysteresisGap = await lodBand();
console.log('LOD band inside the hysteresis gap, approaching from middle (should still be "middle"):', bandInHysteresisGap);

// Back under SHOP_MIDDLE_LOD_EXIT_RADIUS_M (65m) -- should swap back to
// full detail.
await teleportShopAvatar(30);
const bandAfterReapproach = await lodBand();
console.log('LOD band after re-approaching past the exit threshold (should be "near" again):', bandAfterReapproach);

const pass = !!landlet
  && nearAfterLoad === 'near'
  && bandAtMiddle === 'middle'
  && bandInHysteresisGap === 'middle'
  && bandAfterReapproach === 'near'
  && errors.length === 0;
await finish(browser, {
  pass,
  label: '#2378: a model-loaded placed instance swaps to a simplified LOD proxy in the middle distance band and back to full detail on re-approach, with real enter/exit hysteresis',
  errors,
});
