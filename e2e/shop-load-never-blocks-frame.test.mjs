// #3396: "Moving, looking and drawing never wait on loading." An 829-item wall
// loading below a flying avatar froze the screen for up to half a second at a
// time and left the joystick stuck where it was, because the loader built every
// item in one uninterrupted task. This seeds a claimed landlet with 829 items
// of one model, then loads it while the joystick is held, and measures: the
// longest gap between frames (window.__frameMonitor), the long tasks the browser
// reports, whether the avatar kept moving, that every item arrives, and that a
// load abandoned part way leaves nothing behind. Phone width.
//
// #3463: loading those 829 items must also cost one reviews request for the
// product (they all share it), not 829 (the browser used to run out of
// connections and drop most of them).
//
// The loader builds items in small pieces inside a per-frame time budget, so a
// partly loaded landlet is observable (an all-at-once loader never shows one).
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const LABEL = 'Load Never Blocks Tester';
const COUNT = 829;
// What a frame gap may be while the landlet loads, in headless Chromium on a
// software renderer. Ordinary frames are far below this; a one-task build of
// the whole landlet is far above it.
const MAX_FRAME_GAP_MS = Number(process.env.E2E_MAX_FRAME_GAP_MS || 250);

async function adminFetch(pathAndQuery, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${pathAndQuery}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...options.headers },
  });
  return { response, body: await response.json() };
}

// Shop mode clamps its camera to the world's size, so the avatar can only get
// far enough from the landlet to unload it if the world is big enough.
const cookie = await ensureAdminSession();
const worldPatch = await adminFetch('/world', cookie, { method: 'PATCH', body: JSON.stringify({ radiusM: 200 }) });
if (worldPatch.response.status !== 200) throw new Error(`world radius patch failed: ${JSON.stringify(worldPatch.body)}`);
const filler = await adminFetch('/landlets', cookie, {
  method: 'POST',
  body: JSON.stringify({ landletId: `e2e-load-filler-${crypto.randomUUID()}`, name: 'Load Suite Coverage Filler', areaM2: 300 * 300, centerX: 0, centerY: 0, status: 'generating' }),
});
if (filler.response.status !== 201) throw new Error(`filler landlet create failed: ${JSON.stringify(filler.body)}`);

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

async function pageFetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  }, [pathAndQuery, options]);
}
const json = (body, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const { body: buildersBody } = await pageFetchJson('/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];

const instances = Array.from({ length: COUNT }, (_, i) => ({
  instanceId: `load-never-blocks-${i}`,
  landletId: landlet.landletId,
  templateId: 'placeholder-chair',
  x: -7 + (i % 29) * 0.5,
  y: -7 + Math.floor(i / 29) * 0.5,
  // Each item a slightly different size, so none can share an instanced batch
  // (#3402 draws identical placements as one batch, which arrives in a single
  // cheap step). This test is about the per-item, frame-budgeted path that
  // every other kind of content takes; e2e/shop-instanced-batches.test.mjs
  // covers the batched one.
  scale: 1 + i * 1e-4,
}));
const statuses = [];
for (let i = 0; i < COUNT; i += 100) {
  statuses.push((await pageFetchJson('/api/instances/batch', json({ instances: instances.slice(i, i + 100) }))).status);
}
console.log(`seeded ${COUNT} items in ${statuses.length} batches (all 201):`, statuses.every((s) => s === 201));

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 30000 });
await page.waitForTimeout(1000);

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
const loadedCount = () => page.evaluate(() => window.__testShopLoadedInstanceCount());

// Unload whatever Shop mode's own spawn already started loading, and let it settle.
await moveTo(farPoint);
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() === 0, null, { timeout: 30000 });
await page.waitForTimeout(1500);

let reviewRequests = 0;
page.on('request', (req) => {
  if (req.method() === 'GET' && /\/api\/catalog\/[^/?]+\/reviews(\?|$)/.test(req.url())) reviewRequests += 1;
});

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

// ---- 1. Load it with the joystick held ----
const joystick = await page.locator('#shop-move-joystick').boundingBox();
const originX = joystick.x + joystick.width / 2;
const originY = joystick.y + joystick.height / 2;
reviewRequests = 0;
await moveTo(nearPoint);
await page.evaluate(() => window.__frameMonitor.reset());
await page.mouse.move(originX, originY);
await page.mouse.down();
await page.mouse.move(originX, originY - joystick.height / 2, { steps: 4 });
const before = await page.evaluate(() => window.__testShopAvatarPosition());
const loadStart = Date.now();
let sawPartial = false;
let count = 0;
while (Date.now() - loadStart < 120000) {
  count = await loadedCount();
  if (count > 0 && count < COUNT) sawPartial = true;
  if (count === COUNT) break;
  await page.waitForTimeout(50);
}
const loadMs = Date.now() - loadStart;
const after = await page.evaluate(() => window.__testShopAvatarPosition());
await page.mouse.up();
const moved = Math.hypot(after.x - before.x, after.y - before.y);
const stats = await page.evaluate(() => ({ longestGapMs: window.__frameMonitor.longestFrameGapMs(), longTasks: window.__frameMonitor.longTasks() }));
console.log(`loaded ${count}/${COUNT} in ${loadMs} ms; longest frame gap ${Math.round(stats.longestGapMs)} ms; long tasks ${stats.longTasks.count} (longest ${Math.round(stats.longTasks.longestMs)} ms); avatar moved ${moved.toFixed(1)} m while loading; partly-loaded state seen: ${sawPartial}`);
check(count === COUNT, `every item arrives (${count}/${COUNT})`);
check(stats.longestGapMs < MAX_FRAME_GAP_MS, `no frame gap of ${MAX_FRAME_GAP_MS} ms or more while loading (longest ${Math.round(stats.longestGapMs)} ms)`);
check(moved > 1, `the avatar kept moving while the landlet loaded (${moved.toFixed(1)} m)`);
console.log(`reviews requests while the ${COUNT} items of one product loaded: ${reviewRequests}`);
check(reviewRequests <= 1, `one reviews request for the product, not one per item (${reviewRequests} for ${COUNT} items)`);

// For the PR: what the same software renderer manages with the landlet fully
// loaded and nothing loading (829 separate meshes), so a remaining gap can be
// told apart from loading work.
await page.evaluate(() => window.__frameMonitor.reset());
await page.waitForTimeout(2500);
const steady = await page.evaluate(() => window.__frameMonitor.longestFrameGapMs());
console.log(`steady state with the landlet loaded and nothing loading: longest frame gap ${Math.round(steady)} ms`);

// ---- 1b. Flying forward over the loaded landlet (#3483) ----
// #3483: on the live site, eight seconds of flying forward from spawn produced
// one main-thread task of nearly three seconds, the day the stand-in boxes were
// removed. Every item of this landlet now wants its mid or far version as the
// avatar rises, so this holds the same path over the loaded 829 items and
// bounds the longest frame. The bound is deliberately generous (a software
// renderer on a loaded CI runner); a regression to a one-task build of the
// whole landlet is an order of magnitude above it.
const FLY_MAX_FRAME_GAP_MS = Number(process.env.E2E_FLY_MAX_FRAME_GAP_MS || 1500);
await page.evaluate(() => window.__frameMonitor.reset());
await page.click('#shop-fly-btn');
await page.waitForTimeout(800);
await page.mouse.move(originX, originY);
await page.mouse.down();
await page.mouse.move(originX, originY - joystick.height / 2, { steps: 4 });
await page.waitForTimeout(6000);
await page.mouse.up();
const flight = await page.evaluate(() => ({ longestGapMs: window.__frameMonitor.longestFrameGapMs(), longTasks: window.__frameMonitor.longTasks() }));
console.log(`flying forward over the loaded landlet: longest frame gap ${Math.round(flight.longestGapMs)} ms; long tasks ${flight.longTasks.count} (longest ${Math.round(flight.longTasks.longestMs)} ms)`);
check(flight.longestGapMs < FLY_MAX_FRAME_GAP_MS, `no frame gap of ${FLY_MAX_FRAME_GAP_MS} ms or more while flying over the loaded landlet (longest ${Math.round(flight.longestGapMs)} ms)`);
check(flight.longTasks.longestMs < FLY_MAX_FRAME_GAP_MS, `no single task of ${FLY_MAX_FRAME_GAP_MS} ms or more while flying over the loaded landlet (longest ${Math.round(flight.longTasks.longestMs)} ms)`);

// ---- 2. A load abandoned part way leaves nothing behind ----
await moveTo(farPoint);
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() === 0, null, { timeout: 30000 });
await page.waitForTimeout(1500);
await moveTo(nearPoint);
let partial = false;
try {
  await page.waitForFunction((total) => {
    const n = window.__testShopLoadedInstanceCount();
    return n > 0 && n < total;
  }, COUNT, { timeout: 20000, polling: 'raf' });
  partial = true;
} catch {
  partial = false;
}
check(partial, 'a landlet loading in pieces shows as partly loaded for a moment (items arrive over several frames)');
await moveTo(farPoint);
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() === 0, null, { timeout: 30000 });
await page.waitForTimeout(3000);
const leftover = await loadedCount();
check(leftover === 0, `leaving mid-load leaves no items behind, and none arrive later (${leftover})`);

await finish(browser, { pass: pass && errors.length === 0, label: '#3396: loading a landlet of 829 items never blocks a frame or the controls, every item arrives, and an abandoned load leaves nothing', errors });
