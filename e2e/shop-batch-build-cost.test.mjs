// #4483 (part of #3396, "Moving, looking and drawing never wait on loading"): how long does a loose wall of
// identical placements take to build into one instanced batch, and does a frame wait for it? The batch build
// (buildAndAttachBatch) allocates the instanced meshes, sets every matrix and partitions the placements into
// versions in one call; the loader's other work is sliced inside a per-frame budget, so this measures whether
// the batch is the exception. It seeds BATCH_COUNT loose bricks (default 3,000: more than the 800 of the walk
// test, so a regression that scales with the batch shows), enters Shop beside them, and reads the build's own
// synchronous timings (window.__shopBatchBuildTimings) and the frame monitor (longest frame gap, long tasks).
// BATCH_COUNT=5000 reports the larger case.
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
const PER_PRODUCT = Number(process.env.BATCH_COUNT ?? 3000); // #4113: past what the fades can take at once (about 130 bricks of this sphere), under the full-detail budget (about 260)
const WALL_LOCAL_Y = -10;
const WALL_LENGTH_M = 24; // 800 bricks 0.03 m apart (overlapping: nearer than the gap that links a set)

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
// CPU_THROTTLE (default 4) is the phone profile's CPU (scripts/live-site-lib.mjs PHONE_PROFILE): script time scales, GPU time does not.
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE ?? 4); // default: the phone profile's CPU, where the unsliced build cost over 100 ms
if (CPU_THROTTLE > 1) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
}
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
console.log('seeded the 800-member loose wall (should be 2xx):', created.status);

const wallWorldX = landlet.center.x;
const wallWorldY = landlet.center.y + WALL_LOCAL_Y;

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
// Stop the spawn orbit so the teleport sticks (same gesture the sibling LOD e2es use).
const joystick = await shopStickBox(page);
const jx = joystick.x + joystick.width / 2;
const jy = joystick.y + joystick.height / 2;
await page.mouse.move(jx, jy);
await page.mouse.down();
await page.mouse.move(jx + 25, jy, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

// The claimed landlet loads as Shop opens (the page reloads on the mode switch, so nothing can be reset first):
// the wall is built then. The frame monitor's figures therefore cover the whole opening, not only the batch.
let timings = [];
for (let attempt = 0; attempt < 240 && timings.length === 0; attempt++) {
  await page.waitForTimeout(250);
  timings = await page.evaluate(() => window.__shopBatchBuildTimings ?? []);
}
await page.waitForTimeout(1500);
const state = await page.evaluate(() => ({ loaded: window.__testShopLoadedInstanceCount?.(), tiers: window.__testShopBatchTierCounts?.() }));
console.log('state after the wait:', JSON.stringify(state));
const frame = await page.evaluate(() => ({ gap: window.__frameMonitor.longestFrameGapMs(), tasks: window.__frameMonitor.longTasks() }));
const t = timings[0] ?? null;
console.log('batch build timings:', JSON.stringify(timings.map((x) => ({ placements: x.placements, slices: x.slices, syncMs: +x.syncMs.toFixed(1), longestSliceMs: +x.longestSliceMs.toFixed(1) }))));
console.log(`frame monitor while it loaded: longest frame gap ${Math.round(frame.gap)} ms; long tasks ${frame.tasks.count} (longest ${Math.round(frame.tasks.longestMs)} ms)`);

if (process.env.BATCH_REPORT_FILE) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.BATCH_REPORT_FILE, `${JSON.stringify({ count: PER_PRODUCT, timings, frame })}\n`);
}
let pass = true;
const check = (ok, message) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${message}`); if (!ok) pass = false; };
check(t !== null && t.placements === PER_PRODUCT, `the ${PER_PRODUCT}-placement wall was built as one batch`);
// The figure the frame budget is about: the most batch-build work done in any one slice (a slice is its own unit of the
// world work queue, about 3 ms of work in chunks of 64 placements; a stage that is one call, such as the final attach,
// sets the floor). At 4x CPU the build used to be ONE unit of about 110 ms (3,000 placements): the bound is well under
// that, and above what a loaded runner measures (about 15 to 20 ms).
const MAX_SLICE_MS = Number(process.env.E2E_MAX_BATCH_SLICE_MS || (CPU_THROTTLE >= 4 ? 40 : 15));
check(t !== null && t.longestSliceMs < MAX_SLICE_MS, `no slice of the batch build does ${MAX_SLICE_MS} ms or more (${t ? Math.round(t.longestSliceMs) : 'n/a'} ms in the longest of ${t ? t.slices : 'n/a'}; ${t ? Math.round(t.syncMs) : 'n/a'} ms in total)`);
const stages = t?.stages ?? {};
const stageLine = Object.entries(stages).map(([name, v]) => `${name} ${v.totalMs.toFixed(1)} (longest ${v.longestMs.toFixed(1)})`).join(', ');
console.log(`stages, ms total (longest unbroken stretch): ${stageLine}`);
const worstStage = Object.entries(stages).reduce((worst, [name, v]) => (v.longestMs > worst.ms ? { name, ms: v.longestMs } : worst), { name: 'none', ms: 0 });
check(t !== null && worstStage.ms < MAX_SLICE_MS, `every stage's longest stretch is under ${MAX_SLICE_MS} ms (worst: ${worstStage.name} ${worstStage.ms.toFixed(1)} ms)`);
check(t !== null && t.slices >= 3 && t.syncMs > 2 * t.longestSliceMs, `the build was spread over several slices (${t ? t.slices : 'n/a'} slices; the whole is more than twice the longest slice)`);
check(frame.tasks.longestMs < 1500, `no single task of 1500 ms or more while the batch loaded (longest ${Math.round(frame.tasks.longestMs)} ms)`);

await finish(browser, { pass: pass && errors.length === 0, label: '#4483: a loose wall of identical placements builds into one batch without a long stall', errors });
