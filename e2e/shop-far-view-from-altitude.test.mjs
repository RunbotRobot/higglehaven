// #3480 (4/4 of #3418, part of #3412): "Everything built is always shown as
// itself: simplified with distance, never replaced by a stand-in and never left
// out." From altitude, landlets far from the avatar are drawn from their
// products' own simplified models (src/shop/farView.js), one instanced mesh per
// part per product, built inside the per-frame time budget (#3396).
//
// This seeds a many-landlet world by answering /api/far-placements itself (the
// client reads distant content only through that endpoint, #3417), so the test
// needs no builders or landlets of its own beyond the one Shop mode requires.
// It then flies the avatar to altitude at phone width (390x844) and measures,
// before the far view draws anything and after it has:
//   * triangles on screen and draw calls (window.__testShopDrawStats),
//   * the far view's own counts (window.__shopFarViewStats()),
//   * the longest frame gap while it builds (window.__frameMonitor),
// and checks that the distant landlets are drawn (instances > 0), cost about one
// draw call per product rather than one per item, never fall back to boxes (no
// planned item lacked a model), and never block a frame.
//
// The figures print for the PR; the bounds are deliberately generous so a slow
// CI runner on a software renderer does not flake (compare
// shop-load-never-blocks-frame.test.mjs, which uses the same approach).
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish } from './helpers.mjs';
import { encodeFarPlacements } from '../worker/lib/far-placements-encoding.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const LABEL = 'Far View Altitude Tester';
const TILE_M = 512;
const TEMPLATE_ID = 'placeholder-chair';
const ALTITUDE_M = 120;
const LANDLET_COLUMNS = 8;
const LANDLET_SPACING_M = 90;
const ITEMS_PER_LANDLET = 25;
// A frame gap while the far view builds, on headless Chromium's software
// renderer. Ordinary frames are far below this; building every far mesh in one
// task would be far above it.
const MAX_FRAME_GAP_MS = Number(process.env.E2E_MAX_FRAME_GAP_MS || 600);
const SHOT_DIR = process.env.E2E_SHOT_DIR || join(tmpdir(), 'far-view-from-altitude');

async function adminFetch(pathAndQuery, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${pathAndQuery}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...options.headers },
  });
  return { response, body: await response.json() };
}

// Shop mode clamps the camera to the world, so it needs room for a flight at
// altitude over a few hundred metres of landlets.
const cookie = await ensureAdminSession();
const worldPatch = await adminFetch('/world', cookie, { method: 'PATCH', body: JSON.stringify({ radiusM: 1500 }) });
if (worldPatch.response.status !== 200) throw new Error(`world radius patch failed: ${JSON.stringify(worldPatch.body)}`);

// The seeded world: a grid of landlets around the origin, each with the same
// product placed 25 times at a large scale so it stays visible from afar.
const landlets = [];
for (let row = 0; row < LANDLET_COLUMNS; row += 1) {
  for (let col = 0; col < LANDLET_COLUMNS; col += 1) {
    landlets.push({
      id: `e2e-far-altitude-${row}-${col}`,
      cx: (col - LANDLET_COLUMNS / 2) * LANDLET_SPACING_M + 200,
      cy: (row - LANDLET_COLUMNS / 2) * LANDLET_SPACING_M + 200,
    });
  }
}
const rowsForTile = (tileX, tileY) => {
  const rows = [];
  for (const landlet of landlets) {
    if (Math.floor(landlet.cx / TILE_M) !== tileX || Math.floor(landlet.cy / TILE_M) !== tileY) continue;
    for (let i = 0; i < ITEMS_PER_LANDLET; i += 1) {
      rows.push({
        landlet_id: landlet.id, cx: landlet.cx, cy: landlet.cy, template_id: TEMPLATE_ID,
        x_m: -20 + (i % 5) * 10, y_m: -20 + Math.floor(i / 5) * 10, z_m: 0,
        rotation_x_rad: 0, rotation_y_rad: 0, rotation_z_rad: i * 0.3, scale: 6, crop_json: '{}',
      });
    }
  }
  return rows;
};

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
let tileRequests = 0;
// Phase 1 (before): every tile is empty, so the far view has nothing to draw.
// Phase 2 (after): the page is reloaded and the tiles carry the seeded world.
let seeded = false;
await page.route('**/api/far-placements*', async (route) => {
  const match = /tile=(-?\d+),(-?\d+)/.exec(route.request().url());
  const tileX = Number(match?.[1] ?? 0);
  const tileY = Number(match?.[2] ?? 0);
  tileRequests += 1;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(encodeFarPlacements({ x: tileX, y: tileY, sizeM: TILE_M }, seeded ? rowsForTile(tileX, tileY) : [])),
  });
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 30000 });
await page.waitForTimeout(1000);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
mkdirSync(SHOT_DIR, { recursive: true });

// ---- Before: at altitude over a world with nothing to draw in the distance ----
const goToAltitude = async () => {
  await page.evaluate((z) => {
    window.__testTeleportShopAvatar(0, 0, z);
    window.__testForceShopProximityCheck();
  }, ALTITUDE_M);
};
await goToAltitude();
// Give the far view time to start (it waits for the world to be quiet) and read
// the empty tiles around the avatar.
await page.waitForFunction(() => (window.__shopFarViewStats?.()?.tiles ?? 0) > 0, null, { timeout: 60000, polling: 250 });
await page.waitForTimeout(2500);
const drawBefore = await page.evaluate(() => window.__testShopDrawStats());
const farBefore = await page.evaluate(() => window.__shopFarViewStats?.() ?? null);
await page.screenshot({ path: join(SHOT_DIR, 'altitude-before.png') });
console.log(`before: ${drawBefore.triangles} triangles, ${drawBefore.drawCalls} draw calls; far view instances ${farBefore?.plan?.instances ?? 0}`);
check((farBefore?.plan?.instances ?? 0) === 0, `nothing is drawn by the far view when there is nothing in the distance (${farBefore?.plan?.instances})`);

// Now the seeded world: reload so the far view starts afresh and reads it.
seeded = true;
tileRequests = 0;
await page.reload({ waitUntil: 'networkidle' });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 30000 });
await page.waitForTimeout(500);
await page.evaluate(() => window.__frameMonitor.reset());
await goToAltitude();

// ---- After: wait for the far view to draw the distant landlets ----
const expectedItems = landlets.length * ITEMS_PER_LANDLET;
const armedAt = Date.now();
let drawn = false;
try {
  await page.waitForFunction(() => {
    const stats = window.__shopFarViewStats?.();
    return !!stats && stats.drawCalls > 0 && stats.plan?.instances > 0;
  }, null, { timeout: 90000, polling: 250 });
  drawn = true;
} catch {
  drawn = false;
}
const drawMs = Date.now() - armedAt;
// Let any remaining planned builds finish so the figures describe a settled view.
await page.waitForTimeout(3000);
const frames = await page.evaluate(() => ({ longestGapMs: window.__frameMonitor.longestFrameGapMs(), longTasks: window.__frameMonitor.longTasks() }));
const drawAfter = await page.evaluate(() => window.__testShopDrawStats());
const farAfter = await page.evaluate(() => window.__shopFarViewStats?.() ?? null);
await page.screenshot({ path: join(SHOT_DIR, 'altitude-after.png') });
const plan = farAfter?.plan ?? {};
console.log(`after (${drawMs} ms to first draw, ${tileRequests} tile requests): ${drawAfter.triangles} triangles, ${drawAfter.drawCalls} draw calls`);
console.log(`far view: ${farAfter?.products} product(s), ${farAfter?.drawCalls} far draw calls, ${plan.instances} instances from ${plan.landlets} landlets (seeded ${expectedItems} items in ${landlets.length} landlets); over budget ${plan.overBudget}, too small ${plan.tooSmall}, no model ${plan.noModel}`);
console.log(`longest frame gap while it built: ${Math.round(frames.longestGapMs)} ms; long tasks ${frames.longTasks.count} (longest ${Math.round(frames.longTasks.longestMs)} ms)`);
console.log(`screenshots: ${join(SHOT_DIR, 'altitude-before.png')}, ${join(SHOT_DIR, 'altitude-after.png')}`);

writeFileSync(join(SHOT_DIR, 'figures.json'), JSON.stringify({
  seeded: { landlets: landlets.length, items: expectedItems },
  before: { triangles: drawBefore.triangles, drawCalls: drawBefore.drawCalls },
  after: { triangles: drawAfter.triangles, drawCalls: drawAfter.drawCalls, farDrawCalls: farAfter?.drawCalls, farInstances: plan.instances, farLandlets: plan.landlets, msToFirstDraw: drawMs, tileRequests },
  longestFrameGapMs: Math.round(frames.longestGapMs), longTasks: frames.longTasks,
}, null, 2));
check(drawn, 'the far view drew the distant landlets from altitude');
check((plan.instances ?? 0) > 0, `far instances are drawn (${plan.instances})`);
check((plan.landlets ?? 0) >= 2, `several distant landlets are drawn, not one (${plan.landlets})`);
check((plan.noModel ?? 0) === 0, `every planned item has a model of itself, so no stand-in is needed (${plan.noModel} without)`);
check((farAfter?.drawCalls ?? 0) > 0 && (farAfter?.drawCalls ?? 0) * 5 <= (plan.instances ?? 0),
  `about one draw call per part per product, not one per item (${farAfter?.drawCalls} draw calls for ${plan.instances} instances)`);
check(drawAfter.triangles > drawBefore.triangles, `distant landlets add triangles to the frame (${drawBefore.triangles} -> ${drawAfter.triangles})`);
check(frames.longestGapMs < MAX_FRAME_GAP_MS, `no frame gap of ${MAX_FRAME_GAP_MS} ms or more while the far view builds (longest ${Math.round(frames.longestGapMs)} ms)`);

await finish(browser, { pass: pass && errors.length === 0, label: '#3480: from altitude the distant landlets are drawn from their own models, about one draw call per product, without blocking a frame', errors });
