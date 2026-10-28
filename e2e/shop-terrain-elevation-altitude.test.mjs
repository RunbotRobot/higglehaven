// #2853 (leaf of #2373, Option C real terrain): flightMovement.js's own
// per-frame z-sync (updateShopMovement) used to treat "local ground" as a
// flat 0 everywhere, with only curvatureDropM(distance) folded in --
// #2850/#2851 gave every landlet a real elevationM, but nothing read it
// back out on the avatar/camera side. Reproduces the gap directly: teleport
// grounded onto a 0-elevation landlet, confirm z settles near 0, then slide
// (still grounded, no new takeoff/landing) onto a landlet with a real
// elevationM and confirm z rises to meet it -- the exact "walking across a
// landlet boundary with a different elevation" case the per-frame sync (not
// a one-shot landing-floor calculation) has to get right.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Terrain Elevation Altitude Builder';
const LOW_LANDLET_ID = 'terrain-elevation-low-landlet';
const HIGH_LANDLET_ID = 'terrain-elevation-high-landlet';
const HIGH_ELEVATION_M = 6;

const session = await launchPage({ promptAnswer: LABEL });
const page = session.page;

async function fetchJson(p, options) {
  return page.evaluate(async ([path, opts]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(path, opts);
        return { status: res.status, body: await res.json() };
      } catch (err) {
        if (attempt > 0) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, [p, options]);
}

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
const builder = (await fetchJson('/api/builders/me')).body.builder;

// Centers 40m apart -- comfortably outside each other's own ~1000m2
// footprint (half-side ~15.8m) so there's no overlap, and both well within
// SHOP_LOAD_RADIUS_M (60m) of the midpoint the avatar starts at below.
const lowCreated = await fetchJson('/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    landletId: LOW_LANDLET_ID, name: 'Terrain Low Landlet', areaM2: 1000,
    status: 'claimed', ownerBuilderId: builder.builderId,
    center: { x: 0, y: 0 }, elevationM: 0,
  }),
});
// Unowned (greenbelt) rather than claimed by a second builder -- a
// builder can only ever own one claimed landlet at a time (worker/lib/
// land.js's one-claimed-landlet-per-builder guard), and claim status is
// irrelevant to this fix anyway: shopTerrainHeightAtM/src/shop/mode.js's
// own group.position.z lift both apply elevationM unconditionally,
// regardless of a landlet's status.
const highCreated = await fetchJson('/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    landletId: HIGH_LANDLET_ID, name: 'Terrain High Landlet', areaM2: 1000,
    center: { x: 40, y: 0 }, elevationM: HIGH_ELEVATION_M,
  }),
});
console.log('landlets created (both 201 expected):', { low: lowCreated.status, high: highCreated.status });

await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// #1445: a brief real joystick deflection breaks the hands-off spawn orbit
// (shopSpawnRotating), which otherwise overwrites shopAvatarPosition.x/y
// every frame and would fight the teleports below -- same convention
// e2e/shop-landing-spot-item-collision-altitude.test.mjs's own header
// comment documents.
async function stopSpawnOrbit() {
  const box = await page.locator('#shop-move-joystick').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 25, cy, { steps: 5 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(100);
}
await stopSpawnOrbit();

// 3-arg teleport: grounded, z pinned to 0 directly on the low landlet's own
// center. A few real frames (not a hardcoded minimal wait) let
// updateShopMovement's per-frame sync run and settle z on its own, same as
// any other test here would wait out a real physics step.
await page.evaluate(() => window.__testTeleportShopAvatar(0, 0, 0));
await page.waitForTimeout(300);
const lowPosition = await page.evaluate(() => window.__testShopAvatarPosition());
console.log('position while grounded on the 0-elevation landlet (z should be ~0):', lowPosition);

// 2-arg teleport: moves x/y only, leaves z and flightState untouched (still
// 'grounded') -- the real "walked from one landlet onto a neighboring one
// with different elevation, without ever taking off" case. Without #2853's
// fix, the per-frame sync has no elevation term at all, so z would stay
// wherever it already was (~0) instead of rising to meet the new landlet's
// own real ground.
await page.evaluate(() => window.__testTeleportShopAvatar(40, 0));
await page.waitForTimeout(300);
const highPosition = await page.evaluate(() => window.__testShopAvatarPosition());
console.log(`position after sliding onto the ${HIGH_ELEVATION_M}m-elevation landlet while still grounded (z should rise to meet it):`, highPosition);

const errors = [...session.errors];
const pass =
  lowCreated.status === 201 &&
  highCreated.status === 201 &&
  Math.abs(lowPosition.z - 0) < 0.05 &&
  Math.abs(highPosition.z - HIGH_ELEVATION_M) < 0.05 &&
  errors.length === 0;

await finish(session.browser, {
  pass,
  label: '#2853: grounded altitude tracks a landlet\'s own real elevationM, not a flat 0',
  errors,
});
