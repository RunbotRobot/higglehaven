// #1445: loadShopLandletInstances (src/main.js) resolves a real placed
// instance's GLTF mesh (geometry/materials/textures) via
// createMeshForInstance *before* checking whether a newer load/unload
// cycle (entry.loadToken, bumped by unloadShopLandletInstances) superseded
// it while the model was still mid-fetch -- the superseded branch used to
// just `return`, discarding the already-built object without ever
// disposing it. Same Three.js resource-lifecycle gap as #1358/#1359/
// #1370/#1426/#1427, this time triggered by the SHOPPER'S OWN MOVEMENT
// crossing SHOP_LOAD_RADIUS_M (60m, in) then SHOP_UNLOAD_RADIUS_M (90m,
// out) relative to a claimed landlet's own center -- not a UI button click
// like #1427's Next/Prev pager (e2e/sell-mode-showcase.test.mjs).
//
// Forcing this race for real needs:
//  (1) a real claimed landlet with a real catalog-template instance placed
//      on it whose modelUrl is set, so createMeshForInstance actually goes
//      through the async GLTF-loading path rather than the synchronous
//      placeholder-box fallback;
//  (2) a model fetch slow enough to reliably still be in flight when the
//      shopper leaves again -- the same page.route() artificial-delay
//      approach #1427's own PR used, scoped to GET requests under
//      /uploads/** only (per e2e/avatar-equip-out-of-order.test.mjs's own
//      header comment: holding a route open measurably delays *other*,
//      unrelated same-origin requests too -- so this must never bleed past
//      the one path that actually needs delaying, and is only installed
//      once initial setup/navigation is done); and
//  (3) a deterministic way to actually cross both radii inside that delay
//      window. Real joystick/flight choreography is too imprecise to land
//      inside vs. outside two specific meter thresholds within a short
//      window without flaky hand-tuned sleeps -- this drives
//      shopAvatarPosition directly instead, via src/main.js's own
//      window.__testTeleportShopAvatar (e2e-only; see its own comment for
//      why it sets shopAvatarPosition rather than camera.position), and
//      (#1479) window.__testForceShopProximityCheck to make the resulting
//      load/unload decision itself land immediately rather than waiting
//      on the next real requestAnimationFrame tick to notice.
//
// #1479: that "delay window" is itself held open on demand (see
// releaseModelFetch below) rather than a fixed duration. A fixed
// MODEL_FETCH_DELAY_MS assumes everything between Shop-mode spawn (which
// can trigger this landlet's load on its own, before this script ever
// gets a turn -- see the route-install comment below) and the
// far-teleport finishes within that window -- not reliable, since
// Shop-mode's own setup (selector waits, the joystick gesture below) can
// itself take anywhere from under a second to multiple real seconds under
// load, and that clock starts at spawn, not at this script's own
// near-teleport. Holding the route open until the test itself says it's
// ready removes that race entirely: the fetch simply waits for however
// long setup actually takes, then resolves the instant it's released,
// immediately after the far-teleport's own forced supersede.
//
// Also needs the world itself to actually be big enough for the shopper to
// get 90m away from the landlet in the first place: Shop mode clamps the
// camera (and so updateShopProximity's own distance reading) to within a
// "gapless coverage" radius computed from the real landlets that actually
// exist (computeGaplessWorldRadius in src/main.js) -- a bare freshly-
// migrated dev DB only seeds a sparse handful of small, disconnected
// greenbelt squares (migrations/0028_seed_greenbelt_landlets.sql), which
// caps that radius at roughly the origin landlet's own half-width, nowhere
// near 90m. ensureRoomToWander below grows it explicitly, via two direct
// admin primitives that already exist for exactly this "world-generation/
// admin housekeeping" purpose -- deliberately NOT e2e/helpers.mjs's own
// growWorldAsAdmin (that scheme's procedural ring growth is gated on the
// greenbelt ratio already being *low*, which it never is on a fresh DB
// until most of the existing greenbelt is claimed -- far more setup than
// this test needs just to get some open room):
//   - PATCH /api/world to raise radiusM directly (no ratio gate on this
//     endpoint, unlike POST /world/expand);
//   - a plain POST /api/landlets (no spatial-overlap check at all, unlike
//     the batch/candidate endpoints -- see that handler's own comment)
//     seeding one large landlet centered on the origin, wide enough alone
//     to blanket the full 360-degree coverage sweep out past both radii.
// Deliberately status: 'generating', not 'greenbelt': fetchAllLandlets()
// (used for the coverage sweep) has no status filter and counts it either
// way, but the claim-map's own candidate search only ever fetches
// status: 'greenbelt'/'claimed' (src/main.js's claim-modal flow) -- so it
// can never collide with claimLandlet()'s own candidate click loop below.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Shop Leak Suite Tester';
const PRODUCT_NAME = 'Suite Shop Leak Product';

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

async function ensureRoomToWander() {
  const cookie = await ensureAdminSession();
  const worldPatch = await adminFetch('/world', cookie, {
    method: 'PATCH',
    body: JSON.stringify({ radiusM: 200 }),
  });
  if (worldPatch.response.status !== 200) {
    throw new Error(`ensureRoomToWander: world radius patch failed -- ${JSON.stringify(worldPatch.body)}`);
  }
  // 300m-sided square (half = 150) centered on the origin -- every one of
  // this fresh DB's pre-seeded claimable landlets sits within ~57m of the
  // origin (migrations/0028_seed_greenbelt_landlets.sql), so this alone
  // gives full 360-degree coverage well past SHOP_UNLOAD_RADIUS_M (90m)
  // from whichever one of them actually ends up claimed below.
  const filler = await adminFetch('/landlets', cookie, {
    method: 'POST',
    body: JSON.stringify({
      landletId: `e2e-shop-leak-filler-${crypto.randomUUID()}`,
      name: 'Shop Leak Suite Coverage Filler',
      areaM2: 300 * 300,
      centerX: 0,
      centerY: 0,
      status: 'generating',
    }),
  });
  if (filler.response.status !== 201) {
    throw new Error(`ensureRoomToWander: filler landlet create failed -- ${JSON.stringify(filler.body)}`);
  }
}

await ensureRoomToWander();

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

async function pageFetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

// GET /sellers/me mints this account's seller_id on first call if it
// doesn't exist yet (worker/index.js's getOrCreateSellerForUser) --
// entering Sell mode above already did this once via ensureSellerIdentity,
// so this just reads it back.
const { body: sellerMeBody } = await pageFetchJson('/api/sellers/me');
const sellerId = sellerMeBody.seller.sellerId;

// Uploaded and seeded straight through the server API (plain Node-side
// fetch, not the page's own upload wizard) -- same reasoning as #1427's
// own PR (see e2e/sell-mode-showcase.test.mjs's uploadModel/
// seedHeavyTemplate): main.js's own modelGltfCache is a per-URL in-memory
// Promise cache (reset only by a page reload, on top of whatever HTTP
// caching /uploads/** already does) -- a model this same page session ever
// fetched once (e.g. via the upload wizard's own dimension-preview step)
// is served instantly from that cache forever after, with no real network
// request left for page.route() to delay. Going straight through the API
// means Shop mode's later load below is this model's first-ever fetch, by
// either cache, for this page.
const modelBytes = await fs.readFile(CRATE_MODEL_PATH);
const modelForm = new FormData();
modelForm.append('file', new Blob([modelBytes], { type: 'model/gltf-binary' }), 'shop-leak-crate.glb');
const modelUploadRes = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: modelForm });
const modelUpload = await modelUploadRes.json();
if (modelUploadRes.status !== 200 && modelUploadRes.status !== 201) {
  throw new Error(`model upload failed (${modelUploadRes.status}): ${JSON.stringify(modelUpload)}`);
}

const cookies = await page.context().cookies();
const sessionCookie = cookies.find((c) => c.name === 'hh_session');
const cookieHeader = sessionCookie ? `hh_session=${sessionCookie.value}` : '';
const templateRes = await fetch(`${BASE_URL}/api/catalog`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: cookieHeader },
  body: JSON.stringify({
    name: PRODUCT_NAME, category: 'placeholder', color: '#8899aa',
    dimensions: { width: 1, depth: 1, height: 1 },
    sellerId, modelUrl: modelUpload.modelUrl, modelSizeBytes: modelUpload.sizeBytes,
  }),
});
const templateBody = await templateRes.json();
if (templateRes.status !== 200 && templateRes.status !== 201) {
  throw new Error(`catalog template create failed (${templateRes.status}): ${JSON.stringify(templateBody)}`);
}
const template = templateBody.template;

const { body: buildersBody } = await pageFetchJson('/api/builders');
const me = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];
console.log('claimed landlet found to place the test product on:', !!landlet);

const instanceId = `shop-leak-instance-${crypto.randomUUID()}`;
await pageFetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});

const landletCenterX = landlet.center.x;
const landletCenterY = landlet.center.y;
// Unit vector pointing from the landlet's own center away from the
// origin -- walking FAR_DISTANCE_FROM_LANDLET_M along it always lands
// exactly that far from the landlet (by construction, regardless of where
// the landlet itself sits), while staying well inside shopMaxRadiusM()'s
// own clamp (see ensureRoomToWander above): every pre-seeded landlet is
// within ~57m of the origin, so this point is never more than ~120m from
// the origin either, comfortably under the ~194m (200 - clearance) the
// world radius patch allows.
const awayDist = Math.hypot(landletCenterX, landletCenterY);
const awayDirX = awayDist > 1 ? -landletCenterX / awayDist : 1;
const awayDirY = awayDist > 1 ? -landletCenterY / awayDist : 0;
const FAR_DISTANCE_FROM_LANDLET_M = 120; // > SHOP_UNLOAD_RADIUS_M (90m), generous margin
const NEAR_OFFSET_M = 30; // < SHOP_LOAD_RADIUS_M (60m), generous margin

// #1479: also forces an immediate, synchronous load/unload decision via
// window.__testForceShopProximityCheck, rather than relying on the next
// real requestAnimationFrame tick to notice the new position on its own
// (see that hook's own comment in src/main.js).
async function teleportShopAvatar(x, y) {
  await page.evaluate(([tx, ty]) => {
    window.__testTeleportShopAvatar(tx, ty);
    window.__testForceShopProximityCheck();
  }, [x, y]);
}

function farPoint() {
  return [landletCenterX + awayDirX * FAR_DISTANCE_FROM_LANDLET_M, landletCenterY + awayDirY * FAR_DISTANCE_FROM_LANDLET_M];
}

const disposedBefore = await page.evaluate(() => window.__shopInstanceDisposedCount || 0);

// Installed BEFORE Shop mode is even entered, not just before the explicit
// teleport-near below: the claimed landlet is centered at (0, 0) and Shop
// mode's own spawn-orbit (enterShopMode) can itself land the avatar inside
// SHOP_LOAD_RADIUS_M of the origin, triggering loadShopLandletInstances's
// very first, otherwise-undelayed, real model fetch before this script
// ever gets a turn to move anything -- found the hard way: a first attempt
// that installed this route only after Shop mode's own ready-wait saw the
// model already fetched (and permanently cached in main.js's own
// modelGltfCache, a per-URL in-memory Promise cache that no later teleport
// can force a second real request out of) before the race ever started.
// Only /uploads/** GET requests are delayed -- e2e/avatar-equip-out-of-
// order.test.mjs's own header comment found that holding a route open
// measurably delays *other*, unrelated same-origin requests too, so this
// stays as narrowly path-scoped as page.route() allows.
// page.route() handlers run in this Node process, not in the page, so the
// "delay" can just be a plain Promise this script resolves itself
// (releaseModelFetch) once it's actually ready, rather than a guessed fixed
// duration -- see this file's own top comment for why a fixed delay can't
// be trusted to outlast however long Shop-mode's own setup takes to reach
// the far-teleport.
let modelFetchStartedAt = null;
let releaseModelFetch;
const modelFetchGate = new Promise((resolve) => { releaseModelFetch = resolve; });
await page.route('**/uploads/**', async (route) => {
  if (route.request().method() === 'GET') {
    if (modelFetchStartedAt === null) modelFetchStartedAt = Date.now();
    await modelFetchGate;
  }
  await route.continue();
});

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
// #688/#1175: spawn state isn't settled until enterShopMode's post-fetch
// tail finishes (same wait e2e/go-to-last-location.test.mjs and
// e2e/flight.test.mjs already rely on).
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// Every fresh Shop-mode spawn starts a slow, indefinite hands-off orbit
// (updateShopSpawnRotation, #1175's "rotating aerial shot") around a
// random fixed radius of the *origin* -- a constant radius a pure teleport
// can't out-race, since it overwrites shopAvatarPosition itself every
// single frame and only stops on real navigation input (shopMoveX/
// shopMoveY/shopLookX/shopLookY/shopVerticalInput going nonzero -- see
// updateShopMovement's own comment). A brief real joystick deflection and
// release (same gesture e2e/go-to-last-location.test.mjs already uses for
// this exact purpose) is enough: stopShopSpawnRotationForNavigation fires
// on the very first nonzero reading, freeing shopAvatarPosition for this
// test's own teleport hook to drive for the rest of the race.
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveCenterX, moveCenterY);
await page.mouse.down();
await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

// Walks (teleports) into SHOP_LOAD_RADIUS_M -- redundant (a harmless no-op)
// if the real spawn point already triggered this landlet's load on its
// own per the comment above, but guarantees the load actually starts
// regardless of where spawn happened to land. Either way, loadShopLandletInstances
// (the one already in flight, or the one this call's own forced proximity
// check just started) is now awaiting this never-before-fetched model's
// GLTF fetch, which the route handler above is holding open.
await teleportShopAvatar(landletCenterX + NEAR_OFFSET_M, landletCenterY);

// Poll (not a fixed sleep) for the route handler's own deterministic
// signal that the delayed fetch has actually started, rather than guessing
// how long entering load range plus starting a real network request takes.
const fetchStartDeadlineAt = Date.now() + 10000;
while (modelFetchStartedAt === null && Date.now() < fetchStartDeadlineAt) {
  await page.waitForTimeout(50);
}
console.log('model fetch actually started before leaving again (should be true):', modelFetchStartedAt !== null);

// Walks back out past SHOP_UNLOAD_RADIUS_M -- this call's own forced
// proximity check (see teleportShopAvatar) immediately and deterministically
// bumps entry.loadToken via unloadShopLandletInstances while
// loadShopLandletInstances is still awaiting the fetch the route handler is
// holding open. Only now, with the supersede already in place, is it safe
// to let that fetch resolve.
await teleportShopAvatar(...farPoint());
releaseModelFetch();

// Polling (rather than a fixed sleep) for the dispose count to actually
// change costs nothing on a healthy run (it returns the moment the count
// changes) but tolerates however long the now-released fetch and the
// superseded branch's own cleanup actually take, rather than gambling on
// one fixed number.
try {
  await page.waitForFunction(
    (baseline) => (window.__shopInstanceDisposedCount || 0) > baseline,
    disposedBefore,
    { timeout: 10000, polling: 100 },
  );
} catch {
  // Timed out -- fall through to the plain read below so a genuine
  // (non-timing) failure still reports the real count instead of throwing
  // an unrelated TimeoutError.
}
// Only unrouted now, once the released fetch has had every chance to
// actually reach its own route.continue() -- calling unroute() too soon
// after releaseModelFetch() raced that pending continuation in practice
// ("Route is already handled!"), since the handler was still parked on
// the gate promise and hadn't reached route.continue() yet when unroute()
// tore the route down out from under it.
await page.unroute('**/uploads/**');

const disposedAfter = await page.evaluate(() => window.__shopInstanceDisposedCount || 0);
console.log('superseded shop-instance mesh disposed count before the race (baseline):', disposedBefore);
console.log('superseded shop-instance mesh disposed count after the race (should be greater -- the #1445 fix):', disposedAfter);

const pass = !!landlet && modelFetchStartedAt !== null && disposedAfter > disposedBefore && errors.length === 0;
await finish(browser, {
  pass,
  label: '#1445: Shop mode landlet-instance load/unload race (shopper movement crossing SHOP_LOAD_RADIUS_M then SHOP_UNLOAD_RADIUS_M) disposes a superseded in-flight mesh instead of leaking it',
  errors,
});
