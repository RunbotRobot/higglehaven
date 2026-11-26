// #4113 item 5 (part of #3412): the owner walked to a brick wall and back and saw it pop. This holds the
// rule that makes a wall change look the way they asked ("a behind-the-scenes efficiency strategy, not
// something user-facing", #4111): walking 80 m to 5 m and back along a wall of 200 loose bricks (never
// bundled, so the system groups them itself, #4063), (1) every brick is on one version at every step (a set
// never changes in part), (2) the versions only ever step one way on the way in (far, mid, full) and the
// other way on the way out, so nothing flickers back, and (3) every change goes through a dissolve: the
// app's own count of fades started is at least the number of version changes, so no set changed in one frame.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish, shopStickBox } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// #3416: the bricks are a dense-enough sphere to have mid and far versions (the
// repo's crate.glb is already cheap and has none), so the one-decision rule is
// exercised on real tiers. Node has no FileReader; GLTFExporter's binary path uses it.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.();
    });
  }
};
const denseScene = new THREE.Scene();
denseScene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 48, 48), new THREE.MeshStandardMaterial({ color: '#c0392b' })));
const denseBuffer = Buffer.from(await new GLTFExporter().parseAsync(denseScene, { binary: true }));

const LABEL = 'Wall Fade Walk Tester';
const PRODUCT_COUNT = 1;
const PER_PRODUCT = 200; // #4113: past what the fades can take at once (about 130 bricks of this sphere), under the full-detail budget (about 260)
const WALL_LOCAL_Y = -10;
const WALL_LENGTH_M = 6; // 200 bricks 0.03 m apart (overlapping: nearer than the gap that links a set)

async function adminFetch(pathAndQuery, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${pathAndQuery}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...options.headers },
  });
  return { response, body: await response.json() };
}

// Shop mode clamps the avatar to the world's gapless coverage, so grow the world
// and blanket it with one big filler landlet (see shop-middle-lod-band.test.mjs).
async function ensureRoomToWander() {
  const cookie = await ensureAdminSession();
  const worldPatch = await adminFetch('/world', cookie, { method: 'PATCH', body: JSON.stringify({ radiusM: 200 }) });
  if (worldPatch.response.status !== 200) throw new Error(`world radius patch failed -- ${JSON.stringify(worldPatch.body)}`);
  const filler = await adminFetch('/landlets', cookie, {
    method: 'POST',
    body: JSON.stringify({
      landletId: `e2e-bundle-lod-filler-${crypto.randomUUID()}`, name: 'Bundle LOD Suite Coverage Filler',
      areaM2: 300 * 300, centerX: 0, centerY: 0, status: 'generating',
    }),
  });
  if (filler.response.status !== 201) throw new Error(`filler landlet create failed -- ${JSON.stringify(filler.body)}`);
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
const json = (body, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const { body: sellerMeBody } = await pageFetchJson('/api/sellers/me');
const sellerId = sellerMeBody.seller.sellerId;

const modelBytes = denseBuffer;
const modelForm = new FormData();
modelForm.append('file', new Blob([modelBytes], { type: 'model/gltf-binary' }), 'bundle-lod-sphere.glb');
const modelUploadRes = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: modelForm });
const modelUpload = await modelUploadRes.json();
if (modelUploadRes.status !== 200 && modelUploadRes.status !== 201) throw new Error(`model upload failed: ${JSON.stringify(modelUpload)}`);

const cookies = await page.context().cookies();
const sessionCookie = cookies.find((c) => c.name === 'hh_session');
const cookieHeader = sessionCookie ? `hh_session=${sessionCookie.value}` : '';
const templates = [];
for (let p = 0; p < PRODUCT_COUNT; p++) {
  const res = await fetch(`${BASE_URL}/api/catalog`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({
      name: `Bundle LOD Brick ${p} ${crypto.randomUUID().slice(0, 8)}`, category: 'placeholder', color: '#8899aa',
      dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
      sellerId, modelUrl: modelUpload.modelUrl, modelSizeBytes: modelUpload.sizeBytes, priceCents: 500,
    }),
  });
  const body = await res.json();
  if (res.status !== 200 && res.status !== 201) throw new Error(`template ${p} create failed: ${JSON.stringify(body)}`);
  templates.push(body.template);
}

const { body: buildersBody } = await pageFetchJson('/api/builders');
const me = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];

const memberIds = [];
const memberInstances = [];
for (let i = 0; i < PRODUCT_COUNT * PER_PRODUCT; i++) {
  const instanceId = `bundle-lod-${crypto.randomUUID()}`;
  memberIds.push(instanceId);
  memberInstances.push({
    instanceId, landletId: landlet.landletId, templateId: templates[i % PRODUCT_COUNT].templateId,
    x: -WALL_LENGTH_M / 2 + (i * WALL_LENGTH_M) / (PRODUCT_COUNT * PER_PRODUCT - 1), y: WALL_LOCAL_Y,
  });
}
// The endpoint takes up to 100 placements a request.
let created = { status: 200 };
for (let from = 0; from < memberInstances.length && created.status < 300; from += 100) {
  created = await pageFetchJson('/api/instances/batch', json({ instances: memberInstances.slice(from, from + 100) }));
}
const grouped = { status: 200 }; // never bundled: the point of this test
console.log('seeded the 200-member loose wall (should be 2xx):', created.status);

const wallWorldX = landlet.center.x;
const wallWorldY = landlet.center.y + WALL_LOCAL_Y;
// Stand off the wall along +Y (away from the landlet), so the wall is a row
// seen side-on and the distance from every member is about the stated one.
async function standAt(distanceM) {
  await page.evaluate(([x, y]) => {
    window.__testTeleportShopAvatar(x, y, 0);
    window.__testForceShopProximityCheck();
  }, [wallWorldX, wallWorldY - distanceM]);
  await page.waitForTimeout(250);
}
const bands = () => page.evaluate((ids) => ids.map((id) => window.__testShopInstanceLodApplied(id)), memberIds);

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
// Stop the spawn orbit so the teleports stick (same gesture the sibling LOD e2es use).
const joystick = await shopStickBox(page);
const jx = joystick.x + joystick.width / 2;
const jy = joystick.y + joystick.height / 2;
await page.mouse.move(jx, jy);
await page.mouse.down();
await page.mouse.move(jx + 25, jy, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

await standAt(25);
let loaded = false;
for (let attempt = 0; attempt < 100 && !loaded; attempt++) {
  const now = await bands();
  loaded = now.every((band) => band !== null);
  if (!loaded) await page.waitForTimeout(150);
}
console.log('every member of the wall loaded:', loaded);

const RANK = { far: 0, mid: 1, full: 2 };
const startedNow = () => page.evaluate(() => window.__testShopBatchCrossfades().started);
const steps = [];
for (let d = 80; d >= 5; d -= 5) steps.push(d); // beyond about 80 m the landlet is not loaded at all
const walkIn = steps.slice();
const walkOut = steps.slice().reverse();
await page.evaluate(() => window.__testShopSetTiers()); // switch the read-out on
const startedBefore = await startedNow();
const rows = [];
async function walk(distances, direction) {
  let previous = null;
  for (const distanceM of distances) {
    await standAt(distanceM);
    // #4113: a wall past the fade caps changes in a sweep of a few seconds (bricks wait their turn to dissolve);
    // wait until every brick is on one version and no fade is running, so steps do not stack.
    let now = await bands();
    for (let attempt = 0; attempt < 60; attempt++) {
      await page.waitForTimeout(250);
      now = await bands();
      const running = await page.evaluate(() => window.__testShopBatchCrossfades().inFlight);
      if (new Set(now).size === 1 && running === 0) break;
    }
    const readout = await page.evaluate(() => window.__testShopSetTiers());
    rows.push({ direction, distanceM, tiers: [...new Set(now)], readout: JSON.stringify(readout) });
    previous = now;
  }
  return previous;
}
await walk(walkIn, 'in');
await walk(walkOut, 'out');
const startedAfter = await startedNow();
for (const r of rows) console.log(`${r.direction} ${r.distanceM} m:`, r.tiers.join(','), r.readout);

const uniform = rows.every((r) => r.tiers.length === 1);
let changes = 0;
let monotone = true;
for (const direction of ['in', 'out']) {
  const seq = rows.filter((r) => r.direction === direction).map((r) => r.tiers[0]);
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === seq[i - 1]) continue;
    changes += 1;
    const step = RANK[seq[i]] - RANK[seq[i - 1]];
    if (direction === 'in' ? step < 0 : step > 0) monotone = false;
  }
}
const fades = startedAfter - startedBefore;
console.log('every brick on one version at every step (should be true):', uniform);
console.log('versions only step one way each direction (should be true):', monotone);
// changes >= 2 below: the walk must actually cross a version boundary each way, or the test says nothing.
console.log('version changes over the walk, fades started (fades should be at least the changes):', changes, fades);

const hardSwaps = await page.evaluate(() => window.__testShopBatchCrossfades().hardSwaps);
console.log('why any swapped in one frame (#4113 diagnostics):', JSON.stringify(await page.evaluate(() => window.__testShopBatchCrossfades().hardSwapReasons)));
console.log('bricks that swapped in one frame because the fade caps were full (should be 0):', hardSwaps);

const pass = !!landlet && created.status < 300 && loaded && uniform && monotone && changes >= 2 && fades >= changes && hardSwaps === 0 && errors.length === 0;
await finish(browser, { pass, label: '#4113: a wall walked to and from changes version as one set, one way, through a dissolve', errors });
