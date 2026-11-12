// #2378 / #3373 / #3416 (Model tiers 4/7): a placed model steps through three
// versions of ITSELF by how big it looks on screen -- full, mid (about a tenth
// of the triangles) and far (a few dozen to ~200) -- and back on re-approach,
// never a stand-in box. The step is by apparent size (src/shop/lodTier.js), not
// a fixed distance, so a large item keeps its real model at a range where a
// small one is already far, with a hysteresis band at each boundary. Items
// within 10 m of the avatar stay full (#3443). This drives the real
// teleport+forced-proximity-check pattern e2e/shop-landlet-instance-leak.test.mjs
// (#1445) established for deterministically crossing these ranges.
//
// The model is a dense sphere built here (public/models/crate.glb is already
// cheap, so it has no reduced versions to show). Phone-size viewport, as the
// owner uses the site.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Node has no FileReader -- GLTFExporter's binary path uses it.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.();
    });
  }
};
const denseScene = new THREE.Scene();
denseScene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 120, 120), new THREE.MeshStandardMaterial({ color: '#c0392b' })));
const denseBuffer = Buffer.from(await new GLTFExporter().parseAsync(denseScene, { binary: true }));

const LABEL = 'Middle LOD Band Suite Tester';
const PRODUCT_NAME = 'Suite Middle LOD Band Product';
const LARGE_PRODUCT_NAME = 'Suite Middle LOD Band Large Product';
const TINY_PRODUCT_NAME = 'Suite Middle LOD Band Tiny Product';

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
// path (which has no reduced versions at all).
const modelBytes = denseBuffer;
const modelForm = new FormData();
modelForm.append('file', new Blob([modelBytes], { type: 'model/gltf-binary' }), 'middle-lod-sphere.glb');
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

// #3443: a speck of an item (0.1 m across: ~13 px at 10 m, ~16 px at 8 m, under the 24 px swap-down
// size) stands in for one brick of a big wall. Beside the avatar it must stay the real
// model however small it looks; past the protected radius the size rule applies again.
const tinyTemplateRes = await fetch(`${BASE_URL}/api/catalog`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: cookieHeader },
  body: JSON.stringify({
    name: TINY_PRODUCT_NAME, category: 'placeholder', color: '#8899aa',
    dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
    sellerId, modelUrl: modelUpload.modelUrl, modelSizeBytes: modelUpload.sizeBytes, priceCents: 500,
  }),
});
const tinyTemplateBody = await tinyTemplateRes.json();
if (tinyTemplateRes.status !== 200 && tinyTemplateRes.status !== 201) {
  throw new Error(`tiny catalog template create failed (${tinyTemplateRes.status}): ${JSON.stringify(tinyTemplateBody)}`);
}
const tinyTemplate = tinyTemplateBody.template;

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

const tinyInstanceId = `middle-lod-tiny-instance-${crypto.randomUUID()}`;
const TINY_LOCAL_X = -10;
const TINY_LOCAL_Y = -10;
await pageFetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId: tinyInstanceId, landletId: landlet.landletId, templateId: tinyTemplate.templateId, x: TINY_LOCAL_X, y: TINY_LOCAL_Y }),
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
async function lodStats(id = instanceId) {
  return page.evaluate((i) => window.__testShopInstanceLodStats(i), id);
}
// Reduced versions are made on first need, so a step down is polled for rather
// than read at once. They are built in small per-frame steps (#3483: moving and
// drawing never wait on loading), so on a slow runner the first one takes a while
// of wall-clock; the wait is generous because only a build that never finishes is a failure.
async function waitBand(expected, id = instanceId, timeoutMs = 60000) {
  const deadlineAt = Date.now() + timeoutMs;
  let band = await lodBand(id);
  while (band !== expected && Date.now() < deadlineAt) {
    await page.waitForTimeout(100);
    band = await lodBand(id);
  }
  return band;
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

// Distances below are from the 1 m item (about 1100 / distance in CSS px on this
// viewport, camera behind the avatar): full above 80 px (inside ~16 m), mid down to 24 px (~54 m), far
// below; coming back up it holds each version until 110 px / 36 px.

// 9 m: inside the protected radius -- the full model.
await teleportShopAvatar(9);
const loadDeadlineAt = Date.now() + 15000;
while ((await lodBand()) === null && Date.now() < loadDeadlineAt) await page.waitForTimeout(100);
const nearAfterLoad = await waitBand('full');
console.log('tier once loaded close (should be "full"):', nearAfterLoad, await lodStats());
const fullStats = await lodStats();

// 80 m: ~16 px -- the far version of the same model, not an unload and not a
// box. The 8 m item at the same range is still a prominent object and keeps its
// full model (#3373: the owner's "huge item turns into a cube").
await teleportShopAvatar(80);
const bandAtFar = await waitBand('far');
const largeBandAtFar = await lodBand(largeInstanceId);
const farStats = await lodStats();
console.log('small item at 80 m (should be "far"):', bandAtFar, farStats);
console.log('large item at the same range (should still be "full"):', largeBandAtFar);

// ~45 m: ~29 px, inside the far hysteresis band (24-36 px). Coming from far it
// must hold far, not flip up just from being a bit closer.
await teleportShopAvatar(45);
await page.waitForTimeout(400);
const bandInFarGap = await lodBand();
console.log('inside the far/mid band, approaching from far (should still be "far"):', bandInFarGap);

// 25 m: ~52 px, past the far exit size -- mid.
await teleportShopAvatar(25);
const bandAtMid = await waitBand('mid');
const midStats = await lodStats();
console.log('small item at 25 m (should be "mid"):', bandAtMid, midStats);

// 13 m: ~86 px, inside the mid/full band (80-110 px). Coming from mid it holds mid.
await teleportShopAvatar(13);
await page.waitForTimeout(400);
const bandInMidGap = await lodBand();
console.log('inside the mid/full band, approaching from mid (should still be "mid"):', bandInMidGap);

// 8 m: beside the avatar (#3443) and past the full exit size -- full again.
await teleportShopAvatar(8);
const bandAfterReapproach = await waitBand('full');
console.log('after re-approaching (should be "full"):', bandAfterReapproach);

// The same band, now approaching from full: holds the full model.
await teleportShopAvatar(13);
await page.waitForTimeout(400);
const bandInGapFromFull = await lodBand();
console.log('inside the mid/full band, approaching from full (should still be "full"):', bandInGapFromFull);
await teleportShopAvatar(25);

// #3443: the speck, beside the avatar (8 m away on the ground) and then well past the
// protected radius (30 m away).
const tinyWorldX = landletCenterX + TINY_LOCAL_X;
const tinyWorldY = landletCenterY + TINY_LOCAL_Y;
async function teleportToTinyOffset(offsetM) {
  await page.evaluate(([tx, ty]) => {
    window.__testTeleportShopAvatar(tx, ty, 0);
    window.__testForceShopProximityCheck();
  }, [tinyWorldX + offsetM, tinyWorldY]);
}
await teleportToTinyOffset(8);
await page.waitForTimeout(300);
const tinyBandBeside = await lodBand(tinyInstanceId);
console.log('speck 8 m from the avatar (should be "full": protected):', tinyBandBeside);
await teleportToTinyOffset(30);
const tinyBandAway = await waitBand('far', tinyInstanceId);
console.log('speck 30 m away (should be "far": size rule applies):', tinyBandAway);
await teleportShopAvatar(25);

// #3416: each tier is a lighter version of the same model, and none is a box.
const trianglesStepDown = fullStats && midStats && farStats
  && fullStats.visibleTriangles > midStats.visibleTriangles
  && midStats.visibleTriangles > farStats.visibleTriangles
  && farStats.visibleTriangles <= 200
  && midStats.visibleTriangles <= fullStats.visibleTriangles * 0.2;
const noBoxes = [fullStats, midStats, farStats].every((st) => st && st.boxStandIns === 0);
console.log('triangles full/mid/far:', fullStats?.visibleTriangles, midStats?.visibleTriangles, farStats?.visibleTriangles);

const pass = !!landlet
  && trianglesStepDown
  && noBoxes
  && nearAfterLoad === 'full'
  && bandAtFar === 'far'
  && largeBandAtFar === 'full'
  && bandInFarGap === 'far'
  && bandAtMid === 'mid'
  && bandInMidGap === 'mid'
  && bandAfterReapproach === 'full'
  && bandInGapFromFull === 'full'
  && tinyBandBeside === 'full'
  && tinyBandAway === 'far'
  && errors.length === 0;
await finish(browser, {
  pass,
  label: '#3416: a placed model steps full -> mid -> far (lighter versions of itself, never a box) by apparent size and back on re-approach, with hysteresis at each boundary',
  errors,
});
