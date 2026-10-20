// #2362: the #2044 landing-spot-avatar-collision nudge (nearestOpenLandingSpot,
// src/main.js) moves shopAvatarPosition.x/y to the chosen open spot, but the
// landing altitude floor just above it (obstructionTopZ/minAltitudeM, fed
// into clampedLandingAltitudeM) was already computed at the *pre-nudge*
// (x, y) a few lines earlier. If the nudge actually moves the avatar onto a
// spot with a placed item under it, that stale floor (typically 0, bare
// ground, since the original spot had no obstruction of its own) is never
// recomputed for the real landing spot -- so the avatar settles at the old
// floor's height while horizontally sitting inside the new spot's item,
// clipped into its solid geometry instead of resting on its own top surface.
//
// Reproduces this with the real landing choreography: B (teleported, so its
// reported position is exact rather than wherever a real landing happened to
// put it) occupies the spot A's landing would otherwise settle at, forcing
// nearestOpenLandingSpot's ring search to walk outward. The radius-0.5m ring
// (all 8 directions) stays within B's own avatar-clearance radius (0.3m
// avatar half + 0.3m B's own half = 0.6m > 0.5m) so the whole ring is
// rejected regardless of any item; the radius-1.0m ring clears that
// clearance, so its very first direction (angle 0) is the search's first
// real candidate — placed 0.2m from a Tree's center (half-footprint 0.75m,
// per migrations/0001_initial.sql's placeholder-tree row: 1.5x1.5x4.0m),
// comfortably inside it, while the *original* (pre-nudge) spot sits 1.2m
// from that same center — outside the tree's 0.75m + the avatar's own 0.3m
// collision half, so it reads as clear ground. A then lands for real (click
// #shop-fly-btn, wait past the landing duration) and should end up resting
// on top of the tree, not clipped into it at the stale pre-nudge floor.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL_A = 'Landing Item Collision Builder A';
const LABEL_B = 'Landing Item Collision Builder B';
const LANDLET_ID = 'landing-item-collision-landlet';

const sessionA = await launchPage({ promptAnswer: LABEL_A });
const sessionB = await launchPage({ promptAnswer: LABEL_B });
const errors = [...sessionA.errors, ...sessionB.errors];
const pageA = sessionA.page;
const pageB = sessionB.page;

// #1445: a brief real joystick deflection breaks Shop-mode's own hands-off
// spawn orbit (shopSpawnRotating, which otherwise overwrites
// shopAvatarPosition.x/y every frame regardless of flight state), freeing
// it for window.__testTeleportShopAvatar to actually drive -- same
// convention e2e/shop-walk-after-landing-on-object.test.mjs's own header
// comment documents and uses.
async function stopSpawnOrbit(page) {
  const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
  const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
  const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
  await page.mouse.move(moveCenterX, moveCenterY);
  await page.mouse.down();
  await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(100);
}

async function fetchJson(page, path, options) {
  return page.evaluate(async ([p, opts]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(p, opts);
        return { status: res.status, body: await res.json() };
      } catch (err) {
        if (attempt > 0) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, [path, options]);
}

await chooseIdentity(pageA, { mode: 'build', label: LABEL_A, isNew: true });
const builderA = (await fetchJson(pageA, '/api/builders/me')).body.builder;

const landletCreated = await fetchJson(pageA, '/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    landletId: LANDLET_ID,
    name: 'Landing Item Collision Landlet',
    areaM2: 1000,
    status: 'claimed',
    ownerBuilderId: builderA.builderId,
  }),
});
console.log('landlet created at the default (0,0) center (status should be 201):', landletCreated.status);

await pageA.reload({ waitUntil: 'networkidle' });
await pageA.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// Place a Tree (placeholder-tree, migrations/0001_initial.sql) via the real
// build UI -- no modelUrl, so createMeshForInstance resolves synchronously
// via the plain-box fallback, same reasoning e2e/shop-walk-after-landing-on-object.test.mjs's
// own header comment gives for picking this exact template. Switches A into
// Build mode first since #shop-fly-btn above was reached straight off the
// reload (Shop is the default view), matching that sibling test's own flow.
await chooseIdentity(pageA, { mode: 'build', label: LABEL_A, isNew: false });
await pageA.click('#add-item-btn');
await pageA.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await pageA.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await pageA.waitForTimeout(300);
await pageA.mouse.click(210, 400);
await pageA.waitForTimeout(800);

const { landlets } = (await fetchJson(pageA, '/api/landlets?limit=100')).body;
const myLandlet = landlets.find((l) => l.landletId === LANDLET_ID);
const { instances } = (await fetchJson(pageA, `/api/instances?landletId=${myLandlet.landletId}`)).body;
const treeInstance = instances.find((i) => i.templateId === 'placeholder-tree');
const { template: treeTemplate } = (await fetchJson(pageA, '/api/catalog/placeholder-tree')).body;

const treeWorldX = myLandlet.center.x + treeInstance.x;
const treeWorldY = myLandlet.center.y + treeInstance.y;
// A freshly placed instance with no explicit z rests at height/2
// (ground-rest convention, per #1594's own comment) -- its top surface
// (itemZMax) is that same value plus another height/2, i.e. the full height.
const treeTopZ = treeTemplate.dimensions.height;

// B will occupy exactly this spot -- 1.2m from the tree's center, outside
// its footprint. nearestOpenLandingSpot's search from here rejects the
// whole radius-0.5m ring (within B's own avatar-clearance radius) and then
// accepts the very first radius-1.0m candidate it tries (angle 0, i.e.
// (bx + 1.0, by)), which lands 0.2m from the tree's center -- comfortably
// inside its footprint.
const bx = treeWorldX - 1.2;
const by = treeWorldY;
const expectedNudgeX = bx + 1.0;
const expectedNudgeY = by;

await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
await pageB.reload({ waitUntil: 'networkidle' });
await pageB.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageB.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
// Exact, deterministic placement (unlike A's own real landing below) --
// this is purely the "occupant" B drives into position, not the thing under
// test, so there's no reason to race real flight-landing timing for it.
// The 3-arg form forces shopFlightState to 'grounded' (see that hook's own
// comment), which is required for B to actually appear in presence at all
// (#2043: flying avatars are withheld).
await stopSpawnOrbit(pageB);
await pageB.evaluate(([x, y]) => window.__testTeleportShopAvatar(x, y, 0), [bx, by]);

// Give B's own report loop (1500ms interval) and A's poll loop (1000ms
// interval) a few cycles to pick it up before A's landing below forces the
// nudge decision -- same margin e2e/shop-landing-spot-avatar-collision.test.mjs
// uses, just awaited before A acts instead of after.
await pageB.waitForTimeout(500);
await pageA.waitForTimeout(3000);

await chooseIdentity(pageA, { mode: 'shop', label: LABEL_A, isNew: false });
await pageA.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// Teleport A (2-arg -- leaves z/flightState untouched, so A stays 'flying',
// same as every fresh Shop-mode spawn per #2043) to exactly B's occupied
// spot, force the landlet's own objects (the tree included) to actually be
// loaded into shopLandlets before landing, then land for real.
await stopSpawnOrbit(pageA);
await pageA.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y);
  window.__testForceShopProximityCheck();
}, [bx, by]);
await pageA.waitForTimeout(500);

const othersSeenByA = await pageA.evaluate(() => window.__shopOtherAvatars);
console.log('B as seen by A right before landing (should be a real {x, y, ...} at bx/by):', othersSeenByA);

await pageA.click('#shop-fly-btn'); // starts landing from A's current (bx, by)
// #2423: a fixed real-time wait here (the convention this test originally
// copied from e2e/shop-landing-spot-avatar-collision.test.mjs) assumes
// SHOP_FLIGHT_LANDING_DURATION_S (2s) of *simulated* flight time reliably
// elapses within a couple seconds of *real* time -- not guaranteed under a
// CPU-starved CI run, since each frame's dt is clamped to 0.1s
// (updateShopMovement's own comment) and a slow/sparse RAF loop can leave
// simulated time lagging well behind real time. Poll the real flight state
// instead of guessing a bigger number.
await pageA.waitForFunction(() => window.__testShopFlightState() === 'grounded', { timeout: 15000 });

const finalPosition = await pageA.evaluate(() => window.__testShopAvatarPosition());

console.log('tree world position / top surface z:', { treeWorldX, treeWorldY, treeTopZ });
console.log('B\'s occupied spot (forces the nudge):', { bx, by });
console.log('expected nudge target (0.2m inside the tree\'s footprint):', { expectedNudgeX, expectedNudgeY });
console.log('A\'s final position after landing (x,y should match the nudge target; z should rest on treeTopZ, not clip at the stale pre-nudge ground level):', finalPosition);

const pass =
  landletCreated.status === 201 &&
  !!treeInstance &&
  Math.abs(finalPosition.x - expectedNudgeX) < 0.01 &&
  Math.abs(finalPosition.y - expectedNudgeY) < 0.01 &&
  Math.abs(finalPosition.z - treeTopZ) < 0.01 &&
  errors.length === 0;

await sessionB.browser.close();
await finish(sessionA.browser, {
  pass,
  label: '#2362: landing on a nudged spot rests on top of a placed item there instead of clipping into it',
  errors,
});
