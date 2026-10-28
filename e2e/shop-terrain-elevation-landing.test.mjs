// #2853 follow-up: a real takeoff-then-land flight sequence on a
// nonzero-elevation landlet used to resolve shopAvatarPosition.z to roughly
// double the landlet's real elevationM, both resting on bare ground and
// resting on top of a placed item.
//
// The bug: #2853's own per-frame sync (updateShopMovement) redefined
// shopFlightAltitudeM -> world z as
//   z = altitude + shopTerrainHeightAtM(x, y) - curvatureDropM(dist)
// but updateShopFlight's 'landing' branch -- written earlier, by #2852/
// PR #2870, before #2853's terrain term existed -- still converted
// bareGroundAltitudeM/shopLandingObstructionTopZ's absolute world-z values
// into altitude via the *old* formula (missing the new
// -shopTerrainHeightAtM(x, y) subtraction). Landing fed that stale altitude
// back into the new sync formula, which re-added the landlet's own
// elevationM a second time: an elevationM=8 landlet landed the avatar at
// z=16 on bare ground (should be 8) and z=12+elevationM on top of an item
// (should be just 12, the item's own real top).
//
// e2e/shop-terrain-elevation-altitude.test.mjs already covers the *sync
// formula itself* via direct (already-grounded) teleports; this test
// specifically drives the real 'landing' flight-state machine
// (updateShopFlight), the actual path that broke, via the real fly button
// rather than the test-only teleport hook's grounded shortcut.
import { execSync } from 'node:child_process';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Terrain Elevation Landing Builder';
const TEST_ELEVATION_M = 8;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

// Same placeholder-tree precedent e2e/shop-terrain-elevation-consistency.test.mjs
// and e2e/shop-walk-after-landing-on-object.test.mjs both use.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

const { landlets } = (await fetchJson('/api/landlets?limit=100')).body;
const myLandlet = landlets.find((l) => l.ownerBuilderId);
const { instances } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const treeInstance = instances.find((i) => i.templateId === 'placeholder-tree');
const treeWorldX = myLandlet.center.x + treeInstance.x;
const treeWorldY = myLandlet.center.y + treeInstance.y;

// The one real way to drive a nonzero elevation_m through this deployment
// for a test-claimed landlet -- see shop-terrain-elevation-consistency.test.mjs's
// own header comment for why.
execSync(
  `npx wrangler d1 execute higglehaven-db --local --command "UPDATE landlets SET elevation_m = ${TEST_ELEVATION_M} WHERE landlet_id = '${myLandlet.landletId}'"`,
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' },
);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// #1445: break the hands-off spawn orbit (shopSpawnRotating), which
// otherwise overwrites shopAvatarPosition.x/y every frame and fights the
// teleports below -- same convention this file's siblings already use.
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

// Clicking the fly button once always reaches 'landing' from here: a fresh
// spawn starts already 'flying' (the spawn-orbit altitude), so one click
// goes straight flying->landing; if it ever starts 'grounded' instead, the
// first click takes off and a second lands. Either way this reaches
// 'landing' without assuming which state the avatar starts in.
async function clickUntilLanding() {
  for (let i = 0; i < 6; i++) {
    const state = await page.evaluate(() => window.__testShopFlightState());
    if (state === 'landing') return;
    if (state === 'grounded' || state === 'flying') {
      await page.locator('#shop-fly-btn').click();
    }
    await page.waitForTimeout(1200);
  }
}

// Bare-ground landing, on the elevated landlet's own center.
await page.evaluate(([x, y]) => window.__testTeleportShopAvatar(x, y), [myLandlet.center.x, myLandlet.center.y]);
await page.waitForTimeout(300);
await clickUntilLanding();
await page.waitForFunction(() => window.__testShopFlightState() === 'grounded', { timeout: 15000 });
await page.waitForTimeout(300);
const groundLandingPos = await page.evaluate(() => window.__testShopAvatarPosition());
console.log(`bare-ground landing on elevationM=${TEST_ELEVATION_M} landlet (z should be ~${TEST_ELEVATION_M}, not ~${2 * TEST_ELEVATION_M}):`, groundLandingPos);

// Take off again, then land directly on top of the placed tree.
await page.locator('#shop-fly-btn').click(); // grounded -> takingOff
await page.waitForFunction(() => window.__testShopFlightState() === 'flying', { timeout: 10000 });
await page.evaluate(([x, y]) => window.__testTeleportShopAvatar(x, y), [treeWorldX, treeWorldY]);
await page.waitForTimeout(200);
const expectedItemTopZ = await page.evaluate(
  ([x, y]) => window.__testShopLandingObstructionTopZ(x, y),
  [treeWorldX, treeWorldY],
);
await page.locator('#shop-fly-btn').click(); // flying -> landing
await page.waitForFunction(() => window.__testShopFlightState() === 'grounded', { timeout: 15000 });
await page.waitForTimeout(300);
const itemLandingPos = await page.evaluate(() => window.__testShopAvatarPosition());
console.log(`landing on top of a placed item on the same elevated landlet (z should match the item's own real top, ${expectedItemTopZ}):`, itemLandingPos);

const pass =
  Math.abs(groundLandingPos.z - TEST_ELEVATION_M) < 0.1 &&
  Math.abs(itemLandingPos.z - expectedItemTopZ) < 0.1 &&
  errors.length === 0;

await finish(browser, {
  pass,
  label: '#2853 follow-up: real landing on an elevated landlet rests at its real elevation, not double-counted',
  errors,
});
