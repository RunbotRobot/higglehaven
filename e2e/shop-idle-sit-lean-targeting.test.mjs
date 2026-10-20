// #2477 (sub-issue of #2475): the first idle episode after no movement
// input for SHOP_IDLE_DELAY_S should select the nearest in-range sit/lean
// target (#2476's own metadata) and expose it via
// window.__testShopIdleInteractionTarget(), with the target's offset/
// height/facing correctly rotated into world space by the placed
// instance's own rotationZ. Scope is selection only (per docs/API.md's
// "Sit/lean proximity targeting (#2477)") -- no pose change to verify yet,
// just that the right target (and the right world-space numbers) get
// found.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Idle Sit Lean Targeting Builder';
const LANDLET_ID = 'idle-sit-lean-targeting-landlet';
const TEMPLATE_ID = `idle-sit-lean-chair-${Date.now()}`;

const session = await launchPage({ promptAnswer: LABEL });
const { errors, page } = session;

async function fetchJson(p, path, options) {
  return p.evaluate(async ([pathArg, opts]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(pathArg, opts);
        return { status: res.status, body: await res.json() };
      } catch (err) {
        if (attempt > 0) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, [path, options]);
}

// Same "break the hands-off spawn orbit with a brief real joystick
// deflection" idiom e2e/shop-landing-spot-item-collision-altitude.test.mjs's
// own header comment documents -- otherwise shopSpawnRotating overwrites
// shopAvatarPosition.x/y every frame regardless of what this test teleports
// it to.
async function stopSpawnOrbit(p) {
  const moveJoystickBox = await p.locator('#shop-move-joystick').boundingBox();
  const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
  const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
  await p.mouse.move(moveCenterX, moveCenterY);
  await p.mouse.down();
  await p.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
  await p.waitForTimeout(100);
  await p.mouse.up();
  await p.waitForTimeout(100);
}

// Sell mode first (lazily provisions a linked seller profile for this same
// account, per docs/API.md's "Authentication") -- a catalog template's own
// metadata can only be PATCHed by its owning seller (handleCatalog's own
// requireSessionSeller/assertOwner gate), so this can't just patch the
// shared seed placeholder-chair (owned by the fixture 'dev-seller') the
// way a test that only *places* an existing template gets away with.
// Creates its own template directly via the API (same "no seller-facing
// UI control for this" shortcut e2e/seller-duplicate-preserves-stock.test.mjs's
// own comment documents for stockQuantity) with the sitTarget already set
// at creation time, in the template's own local, un-rotated model space
// (0.7 x 0.7 x 1.0m dimensions, centered at origin -- same space
// docs/API.md documents for sitTarget).
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
const seller = (await fetchJson(page, '/api/sellers/me')).body.seller;

const templateCreated = await fetchJson(page, '/api/catalog', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    templateId: TEMPLATE_ID,
    name: 'Idle Sit/Lean Targeting Test Chair',
    color: '#654321',
    dimensions: { width: 0.7, depth: 0.7, height: 1.0 },
    sellerId: seller.sellerId,
    priceCents: 500,
    metadata: { sitTarget: { offsetXM: 0, offsetYM: -0.2, heightM: 0.45, facingRad: 0 } },
  }),
});
console.log('sittable chair template created (status should be 201):', templateCreated.status, templateCreated.body);

// Fetched directly rather than via chooseIdentity({ mode: 'build' }) --
// docs/API.md's "Authentication" says signup unconditionally provisions a
// linked builder profile regardless of which mode's UI is ever actually
// clicked into, so this needs no separate Build-mode entry at all. That
// matters here specifically: entering Build mode's own UI for the first
// time on an account with no owned land yet opens the real claim-modal,
// which this test has no reason to drive and would otherwise sit open,
// blocking the later click into Shop mode below.
const builder = (await fetchJson(page, '/api/builders/me')).body.builder;

const landletCreated = await fetchJson(page, '/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    landletId: LANDLET_ID,
    name: 'Idle Sit Lean Targeting Landlet',
    areaM2: 1000,
    status: 'claimed',
    ownerBuilderId: builder.builderId,
  }),
});
console.log('landlet created at the default (0,0) center (status should be 201):', landletCreated.status);

// A 90-degree rotation deliberately exercises the offset-rotation math
// (offsetYM = -0.2 rotates to worldX offset = +0.2, worldY offset = 0) --
// a 0-rotation placement wouldn't actually prove the rotation combination
// is correct (it would pass even with offsetXM/offsetYM swapped or a sign
// error). z = height/2 (0.5) is the ground-rest convention the real build
// UI applies on placement (same value e2e/shop-landing-spot-item-collision-altitude.test.mjs's
// own comment documents for a freshly-placed instance), since this test
// bypasses that UI and places directly via the batch API.
const CHAIR_X = 10;
const CHAIR_Y = 10;
const CHAIR_ROTATION_Z = Math.PI / 2;
const placed = await fetchJson(page, '/api/instances/batch', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    instances: [{
      templateId: TEMPLATE_ID,
      landletId: LANDLET_ID,
      x: CHAIR_X,
      y: CHAIR_Y,
      z: 0.5,
      rotationZ: CHAIR_ROTATION_Z,
    }],
  }),
});
console.log('chair instance placed (status should be 201):', placed.status, placed.body);

const expected = {
  kind: 'sit',
  worldX: CHAIR_X + 0.2,
  worldY: CHAIR_Y,
  worldZ: 0.45,
  worldFacingRad: CHAIR_ROTATION_Z,
};

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

await stopSpawnOrbit(page);
// 3-arg form (x, y, z) forces shopFlightState to 'grounded' too (same
// convention the altitude test above documents) -- idle sway/targeting
// only ever runs while grounded. 2m from the chair's own base position,
// comfortably inside the 3m search radius of the rotated sit target.
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y, 0);
  window.__testForceShopProximityCheck();
}, [CHAIR_X, CHAIR_Y - 2]);
await page.waitForTimeout(500); // lets the just-forced landlet instance load actually finish

// Direct-search sanity check (no idle-timer wait needed for this half) --
// confirms the search function itself finds the rotated target correctly,
// independent of the idle-episode caching this test checks below.
const directSearch = await page.evaluate(
  ([x, y]) => window.__testFindShopIdleInteractionTarget(x, y),
  [CHAIR_X, CHAIR_Y - 2],
);
console.log('direct search result (should match the rotated expected target):', directSearch);

// Polls instead of a fixed real-time wait, same #2423-established
// reasoning as the altitude test's own real-vs-simulated-time comment:
// SHOP_IDLE_DELAY_S (3s) of simulated time isn't guaranteed to elapse
// within exactly 3s of real time under a throttled/loaded CI run.
await page.waitForFunction(() => window.__testShopIdleInteractionTarget() !== null, { timeout: 15000 });
const idleEpisodeTarget = await page.evaluate(() => window.__testShopIdleInteractionTarget());
console.log('target cached for this idle episode (should match the rotated expected target):', idleEpisodeTarget);

// Control case: a search origin far from the chair should find nothing,
// confirming this isn't just always returning *something* regardless of
// distance.
const farSearch = await page.evaluate(
  ([x, y]) => window.__testFindShopIdleInteractionTarget(x, y),
  [CHAIR_X + 50, CHAIR_Y],
);
console.log('direct search far from the chair (should be null):', farSearch);

function closeTo(actual, expectedValue, tolerance = 0.01) {
  return typeof actual === 'number' && Math.abs(actual - expectedValue) < tolerance;
}

function matchesExpected(target) {
  return !!target
    && target.kind === expected.kind
    && closeTo(target.worldX, expected.worldX)
    && closeTo(target.worldY, expected.worldY)
    && closeTo(target.worldZ, expected.worldZ)
    && closeTo(target.worldFacingRad, expected.worldFacingRad);
}

const pass =
  templateCreated.status === 201 &&
  landletCreated.status === 201 &&
  placed.status === 201 &&
  matchesExpected(directSearch) &&
  matchesExpected(idleEpisodeTarget) &&
  farSearch === null &&
  errors.length === 0;

await finish(session.browser, {
  pass,
  label: '#2477: the nearest in-range sit target is found and correctly rotated into world space once idle begins',
  errors,
});
