// #3407 (leaf 3/3 of #3397): placed content arrives in Shop mode through fog,
// at phone width. A fog exists at a cluster's known position before any of its
// items is visible; the items then reach full opacity and the fog is gone and
// disposed; unloading leaks nothing; with reduced motion there is no fog.
// Frames from the arrival (fog risen, mid-resolve, at rest, and the reduced
// motion fade) are saved under $ARRIVAL_FRAMES_DIR (default: the OS temp dir) for the owner to judge
// the look, which is a taste call and expected to be tuned.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const FRAMES_DIR = process.env.ARRIVAL_FRAMES_DIR || path.join(os.tmpdir(), 'arrival-fog-frames');

const LABEL = 'Arrival Fog Suite Tester';
const PRODUCT_NAME = 'Suite Arrival Fog Product';
const ITEMS = 12;

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
// e2e/shop-content-loads-from-altitude.test.mjs.
async function ensureRoomToWander() {
  const cookie = await ensureAdminSession();
  const worldPatch = await adminFetch('/world', cookie, { method: 'PATCH', body: JSON.stringify({ radiusM: 200 }) });
  if (worldPatch.response.status !== 200) throw new Error(`world radius patch failed: ${JSON.stringify(worldPatch.body)}`);
  const filler = await adminFetch('/landlets', cookie, {
    method: 'POST',
    body: JSON.stringify({
      landletId: `e2e-arrival-fog-filler-${crypto.randomUUID()}`,
      name: 'Arrival Fog Suite Coverage Filler',
      areaM2: 300 * 300,
      centerX: 0,
      centerY: 0,
      status: 'generating',
    }),
  });
  if (filler.response.status !== 201) throw new Error(`filler landlet create failed: ${JSON.stringify(filler.body)}`);
}

await ensureRoomToWander();
await fs.mkdir(FRAMES_DIR, { recursive: true });

// 390px wide: the phone width this feature is judged at.
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 780 } });

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

const modelBytes = await fs.readFile(CRATE_MODEL_PATH);
const modelForm = new FormData();
modelForm.append('file', new Blob([modelBytes], { type: 'model/gltf-binary' }), 'arrival-fog-crate.glb');
const modelUploadRes = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: modelForm });
const modelUpload = await modelUploadRes.json();
if (modelUploadRes.status !== 200 && modelUploadRes.status !== 201) throw new Error(`model upload failed: ${JSON.stringify(modelUpload)}`);

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
if (templateRes.status !== 200 && templateRes.status !== 201) throw new Error(`catalog template create failed: ${JSON.stringify(templateBody)}`);
const template = templateBody.template;

const { body: buildersBody } = await pageFetchJson('/api/builders');
const me = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];
console.log('claimed landlet found:', !!landlet);

// One tight cluster of crates (a 4 x 3 block).
for (let i = 0; i < ITEMS; i += 1) {
  await pageFetchJson('/api/instances', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      instanceId: `arrival-fog-${crypto.randomUUID()}`,
      landletId: landlet.landletId,
      templateId: template.templateId,
      x: (i % 4) * 1.2 - 2, y: Math.floor(i / 4) * 1.2 - 1.2,
    }),
  });
}

const landletCenterX = landlet.center.x;
const landletCenterY = landlet.center.y;
const awayDist = Math.hypot(landletCenterX, landletCenterY);
const awayDirX = awayDist > 1 ? -landletCenterX / awayDist : 1;
const awayDirY = awayDist > 1 ? -landletCenterY / awayDist : 0;

async function teleportShopAvatar(distanceFromLandletM, altitudeM = 0) {
  // Explicit altitude 0: the load radius grows with altitude (#3261), so a
  // teleport that kept the spawn flight's height would never unload.
  await page.evaluate(([tx, ty, tz]) => {
    window.__testTeleportShopAvatar(tx, ty, tz);
    window.__testForceShopProximityCheck();
  }, [landletCenterX + awayDirX * distanceFromLandletM, landletCenterY + awayDirY * distanceFromLandletM, altitudeM]);
}

// Marks the run that exists now as stale, so the polls below only see the run a
// new load creates (an earlier, already-disposed run would look "at rest").
async function markRunStale() {
  await page.evaluate(() => { window.__staleArrivalRun = window.__shopArrivalRun; });
}

async function arrivalStats() {
  return page.evaluate(() => ({
    run: window.__shopArrivalRun && window.__shopArrivalRun !== window.__staleArrivalRun
      ? window.__shopArrivalRun.stats()
      : null,
    fogsAlive: window.__shopArrivalFogsAlive ? window.__shopArrivalFogsAlive() : null,
  }));
}

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveCenterX, moveCenterY);
await page.mouse.down();
await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

// Out of range first, so the load below is a fresh one.
await teleportShopAvatar(150);
await page.waitForTimeout(400);

// --- Arrival with motion ---
// An in-page sampler watches every frame, because the whole arrival lasts about
// two seconds and polling from outside would miss the early part.
await page.evaluate(() => {
  window.__arrivalSamples = { fogBeforeAnyItem: false, maxFogsAlive: 0, frames: 0, seenRun: null };
  const sample = () => {
    const run = window.__shopArrivalRun && window.__shopArrivalRun !== window.__staleArrivalRun
      ? window.__shopArrivalRun.stats()
      : null;
    const samples = window.__arrivalSamples;
    if (run) {
      samples.frames += 1;
      samples.seenRun = run;
      if (run.fogsAlive > 0 && run.dissolving === 0) samples.fogBeforeAnyItem = true;
      samples.maxFogsAlive = Math.max(samples.maxFogsAlive, run.fogsAlive);
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
});
await markRunStale();
// A little above and back from the cluster, looking down on it, so the frames show it.
await teleportShopAvatar(6, 9);
const frames = [];
const startedAt = Date.now();
let atRest = null;
while (Date.now() - startedAt < 30000) {
  const stats = await arrivalStats();
  const run = stats.run;
  // A frame whenever the fog is up (fog risen, then mid-resolve), up to four.
  if (run && run.fogsAlive > 0 && frames.length < 4) {
    const file = path.join(FRAMES_DIR, `arrival-${frames.length + 1}.png`);
    await page.screenshot({ path: file });
    frames.push(file);
  }
  if (run && run.arriving === 0 && run.finished > 0 && run.fogsAlive === 0) { atRest = stats; break; }
  await page.waitForTimeout(60);
}
await page.screenshot({ path: path.join(FRAMES_DIR, 'arrival-at-rest.png') });
const samples = await page.evaluate(() => window.__arrivalSamples);
const sawFogBeforeAnyItem = samples.fogBeforeAnyItem;
const sawFogRisen = samples.maxFogsAlive >= 1;
console.log('fog existed before any item was visible:', sawFogBeforeAnyItem, 'max fogs alive:', samples.maxFogsAlive, 'frames sampled:', samples.frames, 'screenshots:', frames.length);
console.log('arrival at rest:', JSON.stringify(atRest));
const restOk = !!atRest && atRest.run.fogsCreated >= 1 && atRest.run.dissolving === 0 && atRest.fogsAlive === 0;

// --- Unload releases everything ---
await teleportShopAvatar(150);
await page.waitForTimeout(600);
const afterUnload = await arrivalStats();
console.log('after unload:', JSON.stringify(afterUnload));
const unloadOk = afterUnload.fogsAlive === 0 && afterUnload.run?.disposed === true;

// --- Reduced motion: no fog, a plain fade ---
await page.emulateMedia({ reducedMotion: 'reduce' });
await markRunStale();
await teleportShopAvatar(6, 9);
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(FRAMES_DIR, 'reduced-motion-fade.png') });
let reduced = null;
const reducedDeadline = Date.now() + 30000;
while (Date.now() < reducedDeadline) {
  await page.evaluate(() => window.__testForceShopProximityCheck());
  reduced = await arrivalStats();
  if (reduced.run && reduced.run.arriving === 0 && reduced.run.finished > 0) break;
  await page.waitForTimeout(120);
}
console.log('reduced motion:', JSON.stringify(reduced));
const reducedOk = !!reduced?.run && reduced.run.clusters >= 1 && reduced.run.fogsCreated === 0 && reduced.run.arriving === 0 && reduced.run.dissolving === 0;

await teleportShopAvatar(150);
await page.waitForTimeout(400);

const pass = !!landlet && sawFogBeforeAnyItem && sawFogRisen && restOk && unloadOk && reducedOk && errors.length === 0;
await finish(browser, {
  pass,
  label: '#3407: a landlet arrives through fog (fog before any item, then at rest with nothing left over), unload releases it, reduced motion skips the fog',
  errors,
});
