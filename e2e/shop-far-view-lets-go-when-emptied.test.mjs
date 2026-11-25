// #4147: a lándlet emptied (made greenbelt, unpublished, its builder suspended) while a Shop is already open must
// leave the far view without a reload, so nothing is drawn that the avatar could walk through. The far-placements
// endpoint is answered by the test (as in shop-far-view-from-altitude): first with a seeded lándlet, then, once "the
// server" has emptied it, with nothing. A Shop reads each tile in range again after TILE_REFRESH_MS (two minutes in
// the app; a test hook shortens it to six seconds here) and replaces what changed.
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish } from './helpers.mjs';
import { encodeFarPlacements } from '../worker/lib/far-placements-encoding.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const LABEL = 'Far View Emptied Tester';
const TILE_M = 512;
const TEMPLATE_ID = 'placeholder-chair';
const REFRESH_MS = 6000;
const landlet = { id: 'e2e-far-emptied-0', cx: 200, cy: 200 };
const rows = Array.from({ length: 25 }, (_, i) => ({
  landlet_id: landlet.id, cx: landlet.cx, cy: landlet.cy, template_id: TEMPLATE_ID,
  x_m: -20 + (i % 5) * 10, y_m: -20 + Math.floor(i / 5) * 10, z_m: 0,
  rotation_x_rad: 0, rotation_y_rad: 0, rotation_z_rad: i * 0.3, scale: 6, crop_json: '{}',
}));

const cookie = await ensureAdminSession();
const worldPatch = await fetch(`${BASE_URL}/api/world`, {
  method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ radiusM: 1500 }),
});
if (worldPatch.status !== 200) throw new Error(`world radius patch failed ${worldPatch.status}`);

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await page.addInitScript((ms) => { window.__testFarTileRefreshMs = ms; }, REFRESH_MS);
let emptied = false;
let tileRequests = 0;
await page.route('**/api/far-placements*', async (route) => {
  const match = /tile=(-?\d+),(-?\d+)/.exec(route.request().url());
  const tileX = Number(match?.[1] ?? 0);
  const tileY = Number(match?.[2] ?? 0);
  tileRequests += 1;
  const here = Math.floor(landlet.cx / TILE_M) === tileX && Math.floor(landlet.cy / TILE_M) === tileY;
  await route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(encodeFarPlacements({ x: tileX, y: tileY, sizeM: TILE_M }, here && !emptied ? rows : [])),
  });
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });
await page.waitForTimeout(1000);

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const instances = () => page.evaluate(() => window.__shopFarViewStats?.()?.plan?.instances ?? 0);

await page.evaluate(() => { window.__testTeleportShopAvatar(0, 0, 120); window.__testForceShopProximityCheck(); });
await page.waitForFunction(() => (window.__shopFarViewStats?.()?.plan?.instances ?? 0) > 0, null, { timeout: 90000, polling: 250 });
const drawnBefore = await instances();
check(drawnBefore > 0, `the seeded lándlet is drawn by the far view (${drawnBefore} instances)`);
const requestsBefore = tileRequests;

// The server empties the lándlet; the open Shop is not reloaded.
emptied = true;
const startedAt = Date.now();
let gone = false;
try {
  await page.waitForFunction(() => (window.__shopFarViewStats?.()?.plan?.instances ?? 0) === 0, null, { timeout: 60000, polling: 250 });
  gone = true;
} catch { gone = false; }
const waitedMs = Date.now() - startedAt;
check(gone, `the emptied lándlet leaves the far view without a reload (${gone ? `${waitedMs} ms` : 'still drawn'})`);
check(tileRequests > requestsBefore, `the tile was read again by the open Shop (${tileRequests - requestsBefore} more request(s))`);
check(waitedMs < 60000, `and within a bounded time, not for ever (${waitedMs} ms with a ${REFRESH_MS} ms refresh)`);

await finish(browser, { pass: failures.length === 0 && errors.length === 0, label: 'An emptied lándlet leaves the far view of an open Shop without a reload (#4147)', errors });
