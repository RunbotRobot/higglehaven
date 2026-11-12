// #2399 / #3416: setInstanceLodState (the level-of-detail switch) only ever
// toggled `.visible` on the placed model's versions -- but THREE.Raycaster's
// tree walk never checks `.visible` (only `.layers`, then each object's own
// raycast() return value), so visibility alone never decided which version
// actually caught a tap. The *visible* one (full up close, mid, or far) needs
// to be the one that's hit-testable; the hidden ones need to be excluded, or a
// tap meant for what the shopper can see gets silently absorbed by whatever's
// invisible instead.
//
// Same dense-sphere setup and teleport pattern as
// e2e/shop-middle-lod-band.test.mjs, driving window.__testShopInstanceLodHitSource
// at each of the three versions to confirm the hit always lands on the one
// currently shown.
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
// model-loaded instance, not the box-fallback path (which has no reduced
// versions at all).
const modelBytes = denseBuffer;
const modelForm = new FormData();
modelForm.append('file', new Blob([modelBytes], { type: 'model/gltf-binary' }), 'tap-hit-test-sphere.glb');
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
    // #3373: z = 0 lands the avatar on the ground. The swap is by apparent size from the
    // camera, and the spawn flight is ~80 m up, which would make every item look small.
    window.__testTeleportShopAvatar(tx, ty, 0);
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

async function waitBand(expected, timeoutMs = 15000) {
  const deadlineAt = Date.now() + timeoutMs;
  let band = await lodBand();
  while (band !== expected && Date.now() < deadlineAt) {
    await page.waitForTimeout(100);
    band = await lodBand();
  }
  return band;
}

// 9 m: inside the protected radius, the full model.
await teleportShopAvatar(9);
const band = await waitBand('full');
console.log('tier once loaded close (should be "full"):', band);
// The mid and far models are built in the browser a little after the full one is
// shown (#3486 spreads that work over frames), and an item with no versions yet
// reports null, so wait for the versions to exist before asking which one a tap
// would land on.
let hitSourceFull = await lodHitSource();
for (let waited = 0; hitSourceFull === null && waited < 20000; waited += 200) {
  await page.waitForTimeout(200);
  hitSourceFull = await lodHitSource();
}
console.log('hit source while full (should be "full"):', hitSourceFull);

// 25 m (~52 px): the mid version.
await teleportShopAvatar(25);
const bandAtMid = await waitBand('mid');
const hitSourceMid = await lodHitSource();
console.log('tier at 25 m (should be "mid"):', bandAtMid, 'hit source (should be "mid"):', hitSourceMid);

// 80 m (~16 px): the far version.
await teleportShopAvatar(80);
const bandAtFar = await waitBand('far');
const hitSourceFar = await lodHitSource();
console.log('tier at 80 m (should be "far"):', bandAtFar, 'hit source (should be "far"):', hitSourceFar);

const pass = !!landlet
  && band === 'full'
  && hitSourceFull === 'full'
  && bandAtMid === 'mid'
  && hitSourceMid === 'mid'
  && bandAtFar === 'far'
  && hitSourceFar === 'far'
  && errors.length === 0;
await finish(browser, {
  pass,
  label: '#2399 / #3416: a tap always lands on whichever version (full, mid or far) is actually visible, never a hidden one',
  errors,
});
