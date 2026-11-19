// #3403 (part of #3398; the cause found under #3902): a batch of identical placements steps through
// the versions of its model by how big each placement looks, like a single placed item does
// (#3373/#3416), instead of drawing every placement at full detail at any distance. A wall of 1,655
// bricks of 5,320 triangles was one draw call of 8.8 million triangles per frame from any distance.
//
// Seeds a claimed landlet with a wall of identical placements of a dense sphere (public/models/crate.glb
// has no reduced versions to switch to) and checks, at phone width in Shop: beside the wall every
// placement is on the full model; a batch arriving from 26 m is on a reduced version from its first frame; at 26 m (small on screen) they are all on a reduced version and the
// frame draws a small fraction of the triangles; beside the wall with the full-detail triangle budget lowered only the nearest stay full (#3920); back beside it they are full again; the three set
// sizes sum to the placements at every step; and a real tap on a brick drawn from a reduced version
// still resolves to that brick's placement.
import path from 'node:path';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish, shopStickBox } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const LABEL = 'Batch LOD Tester';
const COUNT = 60;

// Node has no FileReader: GLTFExporter's binary path uses it.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => { this.result = buf; this.onloadend?.(); });
  }
};
const denseScene = new THREE.Scene();
denseScene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 48, 48), new THREE.MeshStandardMaterial({ color: '#c0392b' })));
const denseBuffer = Buffer.from(await new GLTFExporter().parseAsync(denseScene, { binary: true }));
const FULL_TRIANGLES = 48 * 47 * 2; // a UV sphere's triangles

async function adminFetch(pathAndQuery, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${pathAndQuery}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...options.headers },
  });
  return { response, body: await response.json() };
}

// Shop mode clamps its camera to the world's size: the world must be big enough to stand 30 m from the wall.
const adminCookie = await ensureAdminSession();
const worldPatch = await adminFetch('/world', adminCookie, { method: 'PATCH', body: JSON.stringify({ radiusM: 200 }) });
if (worldPatch.response.status !== 200) throw new Error(`world radius patch failed: ${JSON.stringify(worldPatch.body)}`);
const filler = await adminFetch('/landlets', adminCookie, {
  method: 'POST',
  body: JSON.stringify({ landletId: `e2e-batch-lod-filler-${crypto.randomUUID()}`, name: 'Batch LOD Coverage Filler', areaM2: 300 * 300, centerX: 0, centerY: 0, status: 'generating' }),
});
if (filler.response.status !== 201) throw new Error(`filler landlet create failed: ${JSON.stringify(filler.body)}`);

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
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
modelForm.append('file', new Blob([denseBuffer], { type: 'model/gltf-binary' }), 'batch-lod-sphere.glb');
const modelUploadRes = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: modelForm });
const modelUpload = await modelUploadRes.json();
if (modelUploadRes.status !== 200 && modelUploadRes.status !== 201) throw new Error(`model upload failed (${modelUploadRes.status}): ${JSON.stringify(modelUpload)}`);
const sessionCookie = (await page.context().cookies()).find((c) => c.name === 'hh_session');
const templateRes = await fetch(`${BASE_URL}/api/catalog`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: sessionCookie ? `hh_session=${sessionCookie.value}` : '' },
  body: JSON.stringify({
    name: 'Batch LOD Sphere', category: 'placeholder', color: '#8899aa',
    dimensions: { width: 1, depth: 1, height: 1 },
    sellerId: sellerMeBody.seller.sellerId, modelUrl: modelUpload.modelUrl, modelSizeBytes: modelUpload.sizeBytes, priceCents: 500,
  }),
});
const templateBody = await templateRes.json();
if (templateRes.status !== 200 && templateRes.status !== 201) throw new Error(`catalog template create failed (${templateRes.status}): ${JSON.stringify(templateBody)}`);
const templateId = templateBody.template.templateId;

const { body: buildersBody } = await pageFetchJson('/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];

// A wall 10 wide and 6 deep of 1 m spheres, 1.5 m apart, centred on the landlet.
const instances = Array.from({ length: COUNT }, (_, i) => ({
  instanceId: `batch-lod-${i}`,
  landletId: landlet.landletId,
  templateId,
  x: -7 + (i % 10) * 1.5,
  y: -4 + Math.floor(i / 10) * 1.5,
}));
const statuses = [];
for (let i = 0; i < COUNT; i += 100) {
  statuses.push((await pageFetchJson('/api/instances/batch', json({ instances: instances.slice(i, i + 100) }))).status);
}
console.log(`seeded ${COUNT} placements (all 201):`, statuses.every((s) => s === 201));

// The page's catalog was fetched before this product existed.
await page.reload();
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });
await page.waitForTimeout(1000);

// A fresh Shop-mode spawn overwrites the avatar's position every frame until real navigation input
// first arrives, which would undo every teleport below. Same release gesture other Shop e2es use.
const joystickBox = await shopStickBox(page);
const joystickX = joystickBox.x + joystickBox.width / 2;
const joystickY = joystickBox.y + joystickBox.height / 2;
await page.mouse.move(joystickX, joystickY);
await page.mouse.down();
await page.mouse.move(joystickX + 25, joystickY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

const cx = landlet.center.x;
const cy = landlet.center.y;
const awayDist = Math.hypot(cx, cy);
const awayX = awayDist > 1 ? -cx / awayDist : 1;
const awayY = awayDist > 1 ? -cy / awayDist : 0;
const at = (back) => [cx + awayX * back, cy + awayY * back];
const moveTo = (point) => page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y, 0);
  window.__testForceShopProximityCheck();
}, point);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const stats = () => page.evaluate(() => window.__testShopDrawStats());
const sum = (t) => t.full + t.mid + t.far;

// Baseline: nothing of this landlet loaded.
await moveTo(at(130));
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() === 0, null, { timeout: 30000 });
await page.waitForTimeout(2500);
const baseline = await stats();

// Arriving from a distance: the batch is drawn from reduced versions from the first frame it exists, not
// at full detail until its reduced versions load and a tick converts it (a thousand-brick wall seen
// from afar was one draw of millions of triangles for its first frames).
await moveTo(at(26));
await page.waitForFunction((n) => {
  window.__testForceShopProximityCheck();
  const stats = window.__testShopDrawStats();
  if (stats.batchedPlacements > 0 && !window.__firstBatchTiers) window.__firstBatchTiers = { ...stats.batchTiers, placements: stats.batchedPlacements };
  return stats.batchedPlacements === n;
}, COUNT, { timeout: 120000, polling: 'raf' });
const firstTiers = await page.evaluate(() => window.__firstBatchTiers);
console.log('first frame the batch exists, from 26 m:', JSON.stringify(firstTiers));
check(firstTiers && firstTiers.placements === COUNT && firstTiers.full === 0 && firstTiers.mid + firstTiers.far === COUNT, `a batch arriving from 26 m is on reduced versions from its first frame (${JSON.stringify(firstTiers)})`);

// Beside the wall: every placement is the full model.
await moveTo([cx, cy]);
await page.waitForFunction((n) => window.__testShopLoadedInstanceCount() === n, COUNT, { timeout: 120000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.__testForceShopProximityCheck());
const near = await stats();
console.log('beside the wall:', JSON.stringify(near.batchTiers), 'triangles', near.triangles);
check(near.batchedPlacements === COUNT, `all ${COUNT} placements are batched (${near.batchedPlacements})`);
check(near.batchTiers.full === COUNT && sum(near.batchTiers) === COUNT, `beside the wall every placement is on the full model (${JSON.stringify(near.batchTiers)})`);
check(near.triangles > COUNT * FULL_TRIANGLES * 0.8, `and the frame draws them all (${near.triangles} triangles of about ${COUNT * FULL_TRIANGLES})`);

// #3920: the full-detail triangle budget counts protected items too. Beside the wall everything is within
// the protected radius; with the budget lowered to about 22 spheres the nearest stay full and the
// farthest drop to mid, and the frame's triangles fall with them.
const CAP = 100_000;
await page.evaluate((cap) => { window.__testSetShopFullTriangleCap(cap); window.__testForceShopProximityCheck(); }, CAP);
await page.waitForFunction(() => { window.__testForceShopProximityCheck(); return window.__testShopDrawStats().batchTiers.full < 60; }, null, { timeout: 60000, polling: 500 }).catch(() => {});
await page.waitForTimeout(800);
const budgeted = await stats();
console.log('beside the wall with the budget lowered:', JSON.stringify(budgeted.batchTiers), 'triangles', budgeted.triangles);
const maxFull = Math.floor(CAP / FULL_TRIANGLES);
check(sum(budgeted.batchTiers) === COUNT, `the sets still sum to the placements (${JSON.stringify(budgeted.batchTiers)})`);
check(budgeted.batchTiers.full > 0 && budgeted.batchTiers.full <= maxFull, `only what the budget allows stays full (${budgeted.batchTiers.full}, at most ${maxFull})`);
check(budgeted.triangles < near.triangles * 0.5, `and the frame draws far fewer triangles (${budgeted.triangles} against ${near.triangles})`);
const placementsNow = await page.evaluate((n) => {
  const p = window.__testShopAvatarPosition();
  return Array.from({ length: n }, (_, i) => ({ i, tier: window.__testShopInstanceTier(`batch-lod-${i}`), p }));
}, COUNT);
const avatarAt = placementsNow[0].p;
const distanceOf = (i) => Math.hypot(cx + (-7 + (i % 10) * 1.5) - avatarAt.x, cy + (-4 + Math.floor(i / 10) * 1.5) - avatarAt.y);
const fullDistances = placementsNow.filter((e) => e.tier === 'full').map((e) => distanceOf(e.i));
const otherDistances = placementsNow.filter((e) => e.tier !== 'full').map((e) => distanceOf(e.i));
check(fullDistances.length > 0 && otherDistances.length > 0 && Math.max(...fullDistances) <= Math.min(...otherDistances) + 0.01, `the placements that stay full are the nearest to the avatar (farthest full ${Math.max(...fullDistances).toFixed(1)} m, nearest reduced ${Math.min(...otherDistances).toFixed(1)} m)`);
// Restoring the budget brings them all back.
await page.evaluate(() => { window.__testSetShopFullTriangleCap(); window.__testForceShopProximityCheck(); });
await page.waitForFunction(() => { window.__testForceShopProximityCheck(); return window.__testShopDrawStats().batchTiers.full === 60; }, null, { timeout: 60000, polling: 500 }).catch(() => {});
const restored = await stats();
check(restored.batchTiers.full === COUNT, `with the budget restored every placement beside the wall is full again (${JSON.stringify(restored.batchTiers)})`);

// 26 m away (a metre-wide ball reads 60 px): past the protected radius and under the mid size.
// The reduced versions of a product are built in the browser the first time they are needed.
await moveTo(at(26));
const settled = await page.waitForFunction(() => {
  window.__testForceShopProximityCheck();
  const t = window.__testShopDrawStats().batchTiers;
  return t.full === 0;
}, null, { timeout: 90000, polling: 500 }).then(() => true).catch(() => false);
const far = await stats();
console.log('26 m away:', JSON.stringify(far.batchTiers), 'triangles', far.triangles);
check(settled, `at 26 m every placement leaves the full model (${JSON.stringify(far.batchTiers)})`);
check(sum(far.batchTiers) === COUNT, `the sets always sum to the placements (${sum(far.batchTiers)})`);
// Whole-frame counts, not minus the baseline: the baseline was taken looking at other scenery.
check(far.triangles < near.triangles * 0.25, `at 26 m the frame draws under a quarter of the triangles (${far.triangles} against ${near.triangles})`);

// A real tap on a brick drawn from a reduced version still resolves to that brick. A Shop arrival
// looks steeply down; level the view so a wall 26 m ahead is on the screen.
await page.evaluate(() => window.__testSetShopPitch(0));
const view = await page.evaluate(() => window.__testShopCameraView());
const heading = Math.hypot(view.dx, view.dy) || 1;
await moveTo([cx - (view.dx / heading) * 26, cy - (view.dy / heading) * 26]);
await page.evaluate(() => window.__testSetShopPitch(0));
await page.waitForTimeout(900);
const target = await page.evaluate((count) => {
  let best = null;
  for (let i = 0; i < count; i += 1) {
    const point = window.__testShopScreenPointOfInstance(`batch-lod-${i}`);
    if (!point || !point.inFront || point.ndcX < -0.45 || point.ndcX > 0.6 || point.ndcY < -0.3 || point.ndcY > 0.8) continue;
    const distance = Math.hypot(point.ndcX, point.ndcY);
    if (!best || distance < best.distance) best = { id: `batch-lod-${i}`, x: point.x, y: point.y, distance };
  }
  return best;
}, COUNT);
if (!target) {
  const sample = await page.evaluate(() => [0, 5, 30, 59].map((i) => { const p = window.__testShopScreenPointOfInstance(`batch-lod-${i}`); return p && `${i}: ndc ${p.ndcX.toFixed(2)},${p.ndcY.toFixed(2)} front ${p.inFront}`; }));
  console.log('where the bricks are on screen:', JSON.stringify(sample), 'camera', JSON.stringify(await page.evaluate(() => window.__testShopCameraView())));
}
check(target !== null, 'standing back where the camera looks at the wall puts some bricks on the screen');
if (target) {
  const tier = await page.evaluate((id) => window.__testShopInstanceTier(id), target.id);
  check(tier === 'mid' || tier === 'far', `the brick to tap is drawn from a reduced version (${tier})`);
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(600);
  const tappedId = await page.evaluate(() => window.__testShopTappedInstanceId());
  console.log(`tapped (${Math.round(target.x)}, ${Math.round(target.y)}) near ${target.id} (${tier}); resolved to ${tappedId}`);
  check(typeof tappedId === 'string' && tappedId.startsWith('batch-lod-'), `a real tap on a reduced brick resolves to one of the wall's placements (${tappedId})`);
  const hit = tappedId ? await page.evaluate((id) => window.__testShopScreenPointOfInstance(id), tappedId) : null;
  const offPx = hit ? Math.hypot(hit.x - target.x, hit.y - target.y) : Infinity;
  check(offPx < 100, `the tapped brick is the one under the finger (${Math.round(offPx)} px away)`);
  if (await page.locator('#product-card-close-btn').isVisible().catch(() => false)) await page.click('#product-card-close-btn');
}

// Away and back, with the sets summing to the placements at every step.
const steps = [at(26), at(40), [cx, cy], at(30), [cx, cy]];
for (const point of steps) {
  await moveTo(point);
  await page.waitForTimeout(700);
  const t = (await stats()).batchTiers;
  check(sum(t) === COUNT, `no placement is lost or doubled at (${Math.round(point[0])}, ${Math.round(point[1])}): ${JSON.stringify(t)}`);
}
// Back beside it: full again.
await page.waitForFunction(() => { window.__testForceShopProximityCheck(); return window.__testShopDrawStats().batchTiers.full === 60; }, null, { timeout: 30000, polling: 500 }).catch(() => {});
const back = await stats();
check(back.batchTiers.full === COUNT, `back beside the wall every placement is the full model again (${JSON.stringify(back.batchTiers)})`);

// Leaving releases everything the batches held, the reduced sets too.
await moveTo(at(130));
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() === 0, null, { timeout: 30000 });
await page.waitForTimeout(4000);
const unloaded = await stats();
check(unloaded.batches === 0 && unloaded.instancedMeshes === 0, 'leaving drops every batch');
check(unloaded.geometries <= baseline.geometries + 2 && unloaded.textures <= baseline.textures + 2, `geometries and textures return to the baseline (geometries ${unloaded.geometries} vs ${baseline.geometries}, textures ${unloaded.textures} vs ${baseline.textures})`);

await finish(browser, { pass: pass && errors.length === 0, label: '#3403: a batch of identical placements steps through its model\'s versions by size on screen', errors });
