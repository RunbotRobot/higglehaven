// #3443 (part of #3412): a wall next to the avatar flipped between textured
// bricks and plain blocks as the avatar moved a few metres. The nearest-first
// rule (#3454) keeps everything within 10 m full detail; this covers the other
// half: items placed together as one bundle change detail together, decided
// from the bundle's size on screen, not brick by brick. A wall is a wall.
//
// Fixture: a bundle of 24 tiny (0.1 m) members in a 12 m row. Eight products
// x three placements each, so no product reaches the instancing minimum and
// every member is its own mesh with its own tiers (the case the per-item rule used to
// decide piecemeal). Judged: every member always shares one tier; nothing
// within 10 m is ever a reduced version; the wall as a whole keeps its real model out to
// 40 m (where each brick on its own is a few pixels and would have been a reduced version);
// and walking 2 m to 15 m and back three times causes zero tier changes.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish } from './helpers.mjs';

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

const LABEL = 'Bundle One Detail Tester';
const PRODUCT_COUNT = 8;
const PER_PRODUCT = 3;
const WALL_LOCAL_Y = -10;
const WALL_LENGTH_M = 12;

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
const created = await pageFetchJson('/api/instances/batch', json({ instances: memberInstances }));
const grouped = await pageFetchJson('/api/instances/group', json({ instanceIds: memberIds }));
console.log('seeded the 24-member wall and bundled it (both should be 2xx):', created.status, grouped.status);

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
const bands = () => page.evaluate((ids) => ids.map((id) => window.__testShopInstanceLodBand(id)), memberIds);

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
// Stop the spawn orbit so the teleports stick (same gesture the sibling LOD e2es use).
const joystick = await page.locator('#shop-move-joystick').boundingBox();
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

const samples = [];
async function sampleAt(distanceM) {
  await standAt(distanceM);
  const now = await bands();
  samples.push({ distanceM, bands: now });
  return now;
}

// Every member shares one tier at every distance; nothing within 10 m is a box;
// the wall keeps its real model out to 40 m.
for (const distance of [2, 8, 12, 15, 25, 40]) await sampleAt(distance);
const uniform = samples.every((s) => new Set(s.bands).size === 1);
const noBoxWithin10 = samples.filter((s) => s.distanceM <= 10).every((s) => s.bands.every((band) => band === 'full'));
const wallFullOutTo40 = samples.every((s) => s.bands.every((band) => band === 'full'));
for (const s of samples) console.log(`wall at ${s.distanceM} m, distinct tiers across its 24 members (should be 1, "full"):`, [...new Set(s.bands)].join(','));

// The walk the issue asks for: 2 m to 15 m and back, three times. Tier changes
// counted by the app itself; none are expected, inside 10 m or beyond.
await standAt(2);
await page.evaluate(() => { window.__shopLodFlipCount = 0; window.__frameMonitor.reset(); });
for (let lap = 0; lap < 3; lap++) {
  for (const d of [4, 6, 8, 10, 12, 15, 12, 10, 8, 6, 4, 2]) await standAt(d);
}
const flips = await page.evaluate(() => window.__shopLodFlipCount ?? 0);
const longestFrameMs = await page.evaluate(() => Math.round(window.__frameMonitor.longestFrameGapMs()));
console.log('tier changes over three 2 m to 15 m and back walks (should be 0):', flips);
console.log('longest gap between drawn frames during the walk, ms (reported):', longestFrameMs);

const pass = !!landlet && created.status < 300 && grouped.status < 300 && loaded
  && uniform && noBoxWithin10 && wallFullOutTo40 && flips === 0 && errors.length === 0;
await finish(browser, { pass, label: '#3443: a bundle changes detail as one set and a wall next to the avatar never flips', errors });
