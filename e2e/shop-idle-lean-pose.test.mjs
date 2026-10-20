// #2479 (sub-issue of #2475): once #2477's targeting selects a leanTarget
// for the current idle episode, the avatar should actually ease into a
// lean pose against it -- its real position (shopAvatarPosition, which
// positionShopCamera reads directly -- see updateShopAvatarIdle's own
// comment on shopLeanStart) blending toward the target's own worldX/Y/Z,
// its facing blending toward the target's own worldFacingRad, and its
// whole-body pitch tilting back by SHOP_LEAN_PITCH_RAD, all scaled by the
// same shopIdleBlend every other idle-sway term already uses. This is the
// first test in this area to actually verify a *pose change*, not just
// target selection (shop-idle-sit-lean-targeting.test.mjs's own scope).
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Idle Lean Pose Builder';
const LANDLET_ID = 'idle-lean-pose-landlet';
const TEMPLATE_ID = `idle-lean-pose-wall-${Date.now()}`;

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
// deflection" idiom shop-idle-sit-lean-targeting.test.mjs's own header
// comment documents -- otherwise shopSpawnRotating overwrites
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

// Sell mode first, same reasoning as shop-idle-sit-lean-targeting.test.mjs's
// own comment: a catalog template's metadata can only be PATCHed by its
// owning seller, so this creates its own template directly via the API
// with leanTarget already set at creation time, in the template's own
// local, un-rotated model space (1.0 x 1.0 x 2.0m, centered at origin).
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
const seller = (await fetchJson(page, '/api/sellers/me')).body.seller;

const templateCreated = await fetchJson(page, '/api/catalog', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    templateId: TEMPLATE_ID,
    name: 'Idle Lean Pose Test Wall',
    color: '#887766',
    dimensions: { width: 1.0, depth: 1.0, height: 2.0 },
    sellerId: seller.sellerId,
    priceCents: 500,
    // offsetYM = 0.3 puts the lean spot just in front of the wall's own
    // face; facingRad = Math.PI means "face the opposite way from the
    // wall's own local +Y," i.e. with your back to it -- the pose this
    // sub-issue is meant to produce.
    metadata: { leanTarget: { offsetXM: 0, offsetYM: 0.3, heightM: 1.0, facingRad: Math.PI } },
  }),
});
console.log('leanable wall template created (status should be 201):', templateCreated.status, templateCreated.body);

const builder = (await fetchJson(page, '/api/builders/me')).body.builder;

const landletCreated = await fetchJson(page, '/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    landletId: LANDLET_ID,
    name: 'Idle Lean Pose Landlet',
    areaM2: 1000,
    status: 'claimed',
    ownerBuilderId: builder.builderId,
  }),
});
console.log('landlet created at the default (0,0) center (status should be 201):', landletCreated.status);

// No rotation on the placed instance -- keeps the expected world target a
// direct read of the template's own local offset/facing, since the
// rotation-combination math itself is already covered by
// shop-idle-sit-lean-targeting.test.mjs. z = height/2 (1.0) matches the
// ground-rest convention a real placement would apply.
const WALL_X = 10;
const WALL_Y = 10;
const placed = await fetchJson(page, '/api/instances/batch', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    instances: [{
      templateId: TEMPLATE_ID,
      landletId: LANDLET_ID,
      x: WALL_X,
      y: WALL_Y,
      z: 1.0,
      rotationZ: 0,
    }],
  }),
});
console.log('wall instance placed (status should be 201):', placed.status, placed.body);

const expected = {
  worldX: WALL_X,
  worldY: WALL_Y + 0.3,
  worldZ: 1.0, // mesh.position.z (1.0) - height/2 (1.0) + heightM (1.0)
  worldFacingRad: Math.PI,
};

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

await stopSpawnOrbit(page);
// 2m from the wall's own lean spot -- comfortably inside the 3m search
// radius. 3-arg teleport forces shopFlightState to 'grounded' too (same
// convention the targeting test documents).
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y, 0);
  window.__testForceShopProximityCheck();
}, [WALL_X, WALL_Y - 2]);
await page.waitForTimeout(500); // lets the just-forced landlet instance load actually finish

// Sanity check: the target itself gets found (shop-idle-sit-lean-targeting's
// own scope), before this test moves on to the pose it actually drives.
const directSearch = await page.evaluate(
  ([x, y]) => window.__testFindShopIdleInteractionTarget(x, y),
  [WALL_X, WALL_Y - 2],
);
console.log('direct search result (should be the lean target):', directSearch);

// Polls until the lean pose has eased in most of the way, same
// real-vs-simulated-time reasoning the targeting test's own comment gives
// for not using a fixed real-time wait -- SHOP_IDLE_DELAY_S (3s) plus
// several more seconds for shopIdleBlend's own exponential ease (#2479's
// pose is scaled by it) to climb past 0.9 isn't guaranteed to land within
// any fixed real-time window under a throttled/loaded CI run.
await page.waitForFunction(
  () => (window.__shopAvatarOrientation?.leanBlend ?? 0) > 0.95,
  { timeout: 25000 },
);

const orientation = await page.evaluate(() => window.__shopAvatarOrientation);
const position = await page.evaluate(() => window.__testShopAvatarPosition());
console.log('orientation at high lean blend (leanBlend should be > 0.9):', orientation);
console.log('position at high lean blend (should be close to the lean target):', position);

// Recovers the quaternion's own yaw-only component by applying it to the
// avatar's local forward axis (+Y, per createShopAvatar's own "arbitrarily
// picking +Y as front" comment) -- the pitch term rotates around local X
// first (innermost in the yaw*pitch composition updateShopAvatarMovement
// builds), which only scales the resulting horizontal projection by
// cos(pitch) without rotating it, so atan2(-x, y) on the transformed
// vector recovers the composed yaw exactly regardless of how much pitch
// (SHOP_LEAN_PITCH_RAD, well under 90 degrees) is blended in.
function yawFromQuaternion([qx, qy, qz, qw]) {
  // Standard quaternion-vector rotation formula, v' = v + 2*cross(qv, cross(qv, v) + qw*v),
  // applied to local forward (0, 1, 0).
  const vx = 0, vy = 1, vz = 0;
  const cross1x = qy * vz - qz * vy;
  const cross1y = qz * vx - qx * vz;
  const cross1z = qx * vy - qy * vx;
  const tx = cross1x + qw * vx;
  const ty = cross1y + qw * vy;
  const tz = cross1z + qw * vz;
  const cross2x = qy * tz - qz * ty;
  const cross2y = qz * tx - qx * tz;
  const fx = vx + 2 * cross2x;
  const fy = vy + 2 * cross2y;
  return Math.atan2(-fx, fy);
}

function angleDelta(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

const actualYaw = yawFromQuaternion(orientation.quaternion);
const yawError = Math.abs(angleDelta(actualYaw, expected.worldFacingRad));
console.log('recovered yaw vs expected facing (error should be small):', actualYaw, expected.worldFacingRad, yawError);

function closeTo(actual, expectedValue, tolerance) {
  return typeof actual === 'number' && Math.abs(actual - expectedValue) < tolerance;
}

const pass =
  templateCreated.status === 201 &&
  landletCreated.status === 201 &&
  placed.status === 201 &&
  directSearch?.kind === 'lean' &&
  orientation.leanBlend > 0.95 &&
  // Backward tilt (positive, opposite SHOP_AVATAR_FLIGHT_PITCH_RAD's
  // forward-dive sign) should be most of the way to its own full value.
  orientation.pitchRad > 0.15 &&
  yawError < 0.15 &&
  closeTo(position.x, expected.worldX, 0.2) &&
  closeTo(position.y, expected.worldY, 0.2) &&
  closeTo(position.z, expected.worldZ, 0.2) &&
  errors.length === 0;

await finish(session.browser, {
  pass,
  label: '#2479: a lean target eases the avatar\'s real position, facing, and body pitch into a lean-against pose',
  errors,
});
