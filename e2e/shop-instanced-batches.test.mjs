// #3402 (part of #3398): placements that look exactly the same are drawn by one
// instanced mesh per model part instead of one cloned mesh each. Seeds a claimed
// landlet with 829 placements of one uploaded model and checks, in Shop mode at
// phone width: every placement is still there (collision, reviews and the like
// see each one), the scene needs only a handful of draw calls (829 separate
// meshes would need hundreds), tap-to-inspect still resolves a batched item by
// its instance id, and leaving the landlet releases what the batches held.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Instanced Batches Tester';
const COUNT = 829;
const MAX_DRAW_CALLS = 100; // 829 cloned meshes need at least 829

async function adminFetch(pathAndQuery, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${pathAndQuery}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...options.headers },
  });
  return { response, body: await response.json() };
}

// Shop mode clamps its camera to the world's size, so the avatar can only get
// far enough from the landlet to unload it if the world is big enough.
const adminCookie = await ensureAdminSession();
const worldPatch = await adminFetch('/world', adminCookie, { method: 'PATCH', body: JSON.stringify({ radiusM: 200 }) });
if (worldPatch.response.status !== 200) throw new Error(`world radius patch failed: ${JSON.stringify(worldPatch.body)}`);
const filler = await adminFetch('/landlets', adminCookie, {
  method: 'POST',
  body: JSON.stringify({ landletId: `e2e-batch-filler-${crypto.randomUUID()}`, name: 'Batch Suite Coverage Filler', areaM2: 300 * 300, centerX: 0, centerY: 0, status: 'generating' }),
});
if (filler.response.status !== 201) throw new Error(`filler landlet create failed: ${JSON.stringify(filler.body)}`);

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
const warnings = [];
page.on('console', (msg) => { if (msg.type() === 'warning') warnings.push(msg.text().slice(0, 160)); });
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
modelForm.append('file', new Blob([await fs.readFile(CRATE_MODEL_PATH)], { type: 'model/gltf-binary' }), 'instanced-batches-crate.glb');
const modelUploadRes = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: modelForm });
const modelUpload = await modelUploadRes.json();
if (modelUploadRes.status !== 200 && modelUploadRes.status !== 201) throw new Error(`model upload failed (${modelUploadRes.status})`);
const sessionCookie = (await page.context().cookies()).find((c) => c.name === 'hh_session');
const templateRes = await fetch(`${BASE_URL}/api/catalog`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: sessionCookie ? `hh_session=${sessionCookie.value}` : '' },
  body: JSON.stringify({
    name: 'Instanced Batch Crate', category: 'placeholder', color: '#8899aa',
    dimensions: { width: 0.3, depth: 0.3, height: 0.3 },
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

const instances = Array.from({ length: COUNT }, (_, i) => ({
  instanceId: `instanced-batches-${i}`,
  landletId: landlet.landletId,
  templateId,
  x: -7 + (i % 29) * 0.5,
  y: -7 + Math.floor(i / 29) * 0.5,
}));
const statuses = [];
for (let i = 0; i < COUNT; i += 100) {
  statuses.push((await pageFetchJson('/api/instances/batch', json({ instances: instances.slice(i, i + 100) }))).status);
}
console.log(`seeded ${COUNT} placements (all 201):`, statuses.every((s) => s === 201));

// The page's catalog was fetched before this product existed.
await page.reload();
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 30000 });
await page.waitForTimeout(1000);

// A fresh Shop-mode spawn keeps overwriting the avatar's position every frame
// with its own hands-off orbit until real navigation input first arrives, which
// would undo every teleport below. Same release gesture other Shop e2es use.
const joystickBox = await page.locator('#shop-move-joystick').boundingBox();
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
const farPoint = [cx + awayX * 130, cy + awayY * 130]; // beyond the 90 m unload radius
const nearPoint = [cx + awayX * 30, cy + awayY * 30]; // inside the 60 m load radius
const moveTo = (point) => page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y, 0);
  window.__testForceShopProximityCheck();
}, point);
const where = async (label) => {
  const state = await page.evaluate(() => ({ pos: window.__testShopAvatarPosition(), count: window.__testShopLoadedInstanceCount() }));
  console.log(`${label}: avatar (${state.pos.x.toFixed(0)}, ${state.pos.y.toFixed(0)}), loaded ${state.count}; landlet centre (${cx.toFixed(0)}, ${cy.toFixed(0)})`);
};

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

// Baseline: nothing of this landlet loaded.
await where('spawn');
await moveTo(farPoint);
await where('after far');
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() === 0, null, { timeout: 30000 });
await page.waitForTimeout(2500);
await where('baseline');
const baseline = await page.evaluate(() => window.__testShopDrawStats());

await moveTo(nearPoint);
await page.evaluate(() => window.__frameMonitor.reset());
await where('after near');
try {
  await page.waitForFunction((n) => window.__testShopLoadedInstanceCount() === n, COUNT, { timeout: 120000 });
} catch (err) {
  const state = await page.evaluate(() => ({ count: window.__testShopLoadedInstanceCount(), stats: window.__testShopDrawStats() }));
  const inst = await pageFetchJson(`/api/instances?landletId=${landlet.landletId}`);
  const cat = await pageFetchJson('/api/catalog');
  console.log('debug: instances on landlet', inst.status, inst.body?.instances?.length, 'catalog has template', (cat.body?.templates ?? []).some((t) => t.templateId === templateId), 'warnings', JSON.stringify(warnings.slice(0, 5)));
  console.log('load did not complete:', JSON.stringify(state), 'page errors:', JSON.stringify(errors.slice(0, 8)));
  throw err;
}
await page.waitForTimeout(1000);
const loaded = await page.evaluate(() => window.__testShopDrawStats());
const loadStats = await page.evaluate(() => ({ longestGapMs: window.__frameMonitor.longestFrameGapMs() }));
console.log('loaded:', JSON.stringify(loaded), 'baseline:', JSON.stringify(baseline), `longest frame gap while loading ${Math.round(loadStats.longestGapMs)} ms`);
// "Moving, looking and drawing never wait on loading" (#3396): the batch is built
// in the frame-budgeted queue like everything else. Same ceiling as that test.
check(loadStats.longestGapMs < Number(process.env.E2E_MAX_FRAME_GAP_MS || 250), `loading the batch never holds a frame back (longest gap ${Math.round(loadStats.longestGapMs)} ms)`);
check(loaded.batches >= 1 && loaded.batchedPlacements === COUNT, `all ${COUNT} placements are in a batch (${loaded.batchedPlacements} in ${loaded.batches})`);
check(loaded.drawCalls < MAX_DRAW_CALLS, `the scene needs fewer than ${MAX_DRAW_CALLS} draw calls (${loaded.drawCalls})`);
check(loaded.geometries - baseline.geometries < 20, `batches share geometry instead of cloning it per item (${loaded.geometries - baseline.geometries} new geometries)`);

// Every placement is still a placed object: tap-to-inspect resolves a batched
// item by its instance id (its review is registered on its handle).
const tapped = await page.evaluate((id) => window.__testTapShopProductByInstanceId(id), 'instanced-batches-400');
check(tapped === true, 'a batched placement resolves for tap-to-inspect by instance id');
// The preview that opened covers the screen; close it so the real taps below reach the canvas.
await page.click('#shop-product-preview-close-btn');
await page.waitForTimeout(300);

// A real tap, on the pixels where a brick is drawn, opens that brick's product:
// the click is raycast against the batch's instanced mesh and the instance index
// maps back to the placement. The camera looks along a fixed heading and stays a
// fixed distance behind the avatar, so stand where it looks at the wall.
await moveTo([cx, cy]);
await page.waitForTimeout(700);
const view = await page.evaluate(() => window.__testShopCameraView());
const heading = Math.hypot(view.dx, view.dy) || 1;
console.log('camera view:', JSON.stringify(view));
let target = null;
for (const back of [10, 16, 22, 6]) {
  if (target) break;
  await moveTo([cx - (view.dx / heading) * back, cy - (view.dy / heading) * back]);
  await page.waitForTimeout(700);
  target = await page.evaluate((count) => {
    let best = null;
    for (let i = 0; i < count; i += 1) {
      const point = window.__testShopScreenPointOfInstance(`instanced-batches-${i}`);
      if (!point || !point.inFront || Math.abs(point.ndcX) > 0.4 || point.ndcY < -0.4 || point.ndcY > 0.4) continue;
      const distance = Math.hypot(point.ndcX, point.ndcY);
      if (!best || distance < best.distance) best = { id: `instanced-batches-${i}`, x: point.x, y: point.y, distance };
    }
    return best;
  }, COUNT);
}
const inView = await page.evaluate(() => window.__testShopDrawStats());
console.log(`wall in view: ${JSON.stringify(inView)}`);
check(target !== null, 'standing where the camera looks at the wall puts some bricks in the middle of the screen');
if (target) {
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(500);
  const tappedId = await page.evaluate(() => window.__testShopTappedInstanceId());
  const modalOpen = await page.locator('#shop-product-preview-modal').evaluate((el) => el.classList.contains('visible'));
  console.log(`tapped (${Math.round(target.x)}, ${Math.round(target.y)}) near ${target.id}; resolved to ${tappedId}; preview open: ${modalOpen}`);
  check(typeof tappedId === 'string' && tappedId.startsWith('instanced-batches-'), `a real tap on a brick resolves to one of the wall's placements (${tappedId})`);
  check(modalOpen, 'a real tap on a brick opens its product preview');
  // The tapped brick is drawn where the tap landed: its centre is within a
  // brick's size of the tap, not somewhere else in the wall.
  const hit = tappedId ? await page.evaluate((id) => window.__testShopScreenPointOfInstance(id), tappedId) : null;
  const offPx = hit ? Math.hypot(hit.x - target.x, hit.y - target.y) : Infinity;
  check(offPx < 140, `the tapped brick is the one under the finger (${Math.round(offPx)} px away)`);
}

// Leaving releases what the batches held, and nothing stays loaded.
await moveTo(farPoint);
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() === 0, null, { timeout: 30000 });
await page.waitForTimeout(4000);
const unloaded = await page.evaluate(() => window.__testShopDrawStats());
console.log('after unload:', JSON.stringify(unloaded));
check(unloaded.batches === 0 && unloaded.instancedMeshes === 0, 'leaving drops every batch');
check(unloaded.geometries <= baseline.geometries && unloaded.textures <= baseline.textures, `geometries and textures return to the baseline (geometries ${unloaded.geometries} vs ${baseline.geometries}, textures ${unloaded.textures} vs ${baseline.textures})`);

await finish(browser, { pass: pass && errors.length === 0, label: '#3402: 829 identical placements are drawn as instanced batches, still tappable, and unload releases them', errors });
