// #2478 (sub-issue of #2475): once #2477's own targeting selects a
// kind: 'sit' target for the current idle episode, the avatar should ease
// into a seated pose snapped to that target's own height/orientation --
// legs/arms rotating forward from their hip/shoulder pivots, plus a
// visual-only height/yaw offset on the rendered mesh (never touching the
// real shopAvatarPosition/shopAvatarFacing -- see docs/API.md's "Sit pose
// + transition (#2478)" for why). Checks the blend actually engages close
// to its fully-blended values, then that a brief joystick deflection hard-
// cuts it back to 0 on the very next frame (the same instant-ease-out
// discipline every other idle blend in this file already follows).
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Idle Sit Pose Builder';
const LANDLET_ID = 'idle-sit-pose-landlet';
const TEMPLATE_ID = `idle-sit-pose-chair-${Date.now()}`;

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
// deflection" idiom e2e/shop-idle-sit-lean-targeting.test.mjs's own header
// comment documents -- otherwise shopSpawnRotating overwrites
// shopAvatarPosition.x/y every frame regardless of what this test teleports
// it to. Reused again below (after the seated pose engages) to drive the
// hard-cut-on-movement assertion.
async function deflectMoveJoystick(p) {
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

// Same ownership/creation shortcuts e2e/shop-idle-sit-lean-targeting.test.mjs's
// own comments explain in full: a seller-owned template (the shared fixture
// placeholder-chair can't be PATCHed by this account), builder fetched
// directly (bypassing Build mode's own claim-modal), landlet at the default
// (0,0) center.
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
const seller = (await fetchJson(page, '/api/sellers/me')).body.seller;

const templateCreated = await fetchJson(page, '/api/catalog', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    templateId: TEMPLATE_ID,
    name: 'Idle Sit Pose Test Chair',
    color: '#336699',
    dimensions: { width: 0.7, depth: 0.7, height: 1.0 },
    sellerId: seller.sellerId,
    priceCents: 500,
    metadata: { sitTarget: { offsetXM: 0, offsetYM: -0.2, heightM: 0.45, facingRad: 0 } },
  }),
});
console.log('sittable chair template created (status should be 201):', templateCreated.status, templateCreated.body);

const builder = (await fetchJson(page, '/api/builders/me')).body.builder;

const landletCreated = await fetchJson(page, '/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    landletId: LANDLET_ID,
    name: 'Idle Sit Pose Landlet',
    areaM2: 1000,
    status: 'claimed',
    ownerBuilderId: builder.builderId,
  }),
});
console.log('landlet created at the default (0,0) center (status should be 201):', landletCreated.status);

// No rotation on the chair this time (0 rather than #2477's own deliberate
// 90 degrees) -- that sub-issue's own test already proved the rotation
// math; this one only needs a stable, easy-to-hand-compute target so the
// pose assertions below aren't also re-deriving rotated offsets.
const CHAIR_X = 10;
const CHAIR_Y = 10;
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
      rotationZ: 0,
    }],
  }),
});
console.log('chair instance placed (status should be 201):', placed.status, placed.body);

// Hand-computed expected target (0-rotation chair, so no offset rotation
// to combine): worldZ = mesh.position.z (0.5) - height/2 (0.5) + heightM
// (0.45) = 0.45, worldFacingRad = facingRad (0) + mesh.rotation.z (0) = 0.
const SIT_TARGET_WORLD_Z = 0.45;
const SIT_TARGET_WORLD_FACING_RAD = 0;
// SHOP_AVATAR_LEG_LENGTH_M (src/main.js) -- the rig's own standing hip
// height above its group's local origin, same term the #2478 doc section
// explains solving the height offset backwards from.
const SHOP_AVATAR_LEG_LENGTH_M = 0.86;
const SHOP_SIT_LEG_ROTATION_RAD = (Math.PI / 2) * 0.88;
const SHOP_SIT_ARM_ROTATION_RAD = (Math.PI / 2) * 0.55;

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

await deflectMoveJoystick(page);
// 3-arg form forces shopFlightState to 'grounded' too (idle sway/sitting
// only ever run while grounded) -- 2m from the chair's own base position,
// comfortably inside the 3m search radius.
const AVATAR_X = CHAIR_X;
const AVATAR_Y = CHAIR_Y - 2;
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y, 0);
  window.__testForceShopProximityCheck();
}, [AVATAR_X, AVATAR_Y]);
await page.waitForTimeout(500); // lets the just-forced landlet instance load actually finish

// The avatar's own facing right after the teleport/deflection above settled
// (__testTeleportShopAvatar itself doesn't set facing, and the preceding
// deflectMoveJoystick's camera-relative turn leaves it at whatever the
// camera happened to be pointing, not a known/hand-computable value) --
// captured once here as the real baseline for the expected yaw-offset math
// below, since shopAvatarFacing itself never changes while idle (no real
// input, so nothing turns it).
const baselineFacingRad = (await page.evaluate(() => window.__shopAvatarOrientation)).facingRad;

// Same real-vs-simulated-time polling reasoning e2e/shop-idle-sit-lean-targeting.test.mjs's
// own comment documents for SHOP_IDLE_DELAY_S -- waits for the idle episode
// to actually pick the sit target up, then for shopSitBlend (eased at
// SHOP_IDLE_BLEND_PER_S = 0.6/s) to substantially engage rather than a
// fixed real-time sleep.
await page.waitForFunction(() => window.__testShopIdleInteractionTarget()?.kind === 'sit', { timeout: 15000 });
await page.waitForFunction(() => window.__testShopSitPose().blend > 0.9, { timeout: 20000 });

const engagedPose = await page.evaluate(() => window.__testShopSitPose());
console.log('seated pose once substantially engaged (blend should be > 0.9):', engagedPose);

function closeTo(actual, expectedValue, tolerance) {
  return typeof actual === 'number' && Math.abs(actual - expectedValue) < tolerance;
}

// At blend ~0.9 (not a clean 1.0, since the exponential ease never fully
// reaches it) every term should be within 10% of its fully-blended value --
// a generous tolerance that still catches a wrong sign, a missing scale
// factor, or a swapped term, which is what this test actually cares about.
const expectedHeightOffsetFull = SIT_TARGET_WORLD_Z - SHOP_AVATAR_LEG_LENGTH_M - 0; // avatar teleported to z=0
// Same shortest-angle atan2-of-sin/cos idiom updateShopAvatarIdle's own
// yaw-offset computation uses, applied here to the real baseline facing
// captured above rather than assuming a known starting facing.
const expectedYawDeltaFull = Math.atan2(
  Math.sin(SIT_TARGET_WORLD_FACING_RAD - baselineFacingRad),
  Math.cos(SIT_TARGET_WORLD_FACING_RAD - baselineFacingRad),
);
const poseEngaged =
  engagedPose.blend > 0.9 &&
  closeTo(engagedPose.heightOffset, expectedHeightOffsetFull * engagedPose.blend, 0.05) &&
  closeTo(engagedPose.yawOffset, expectedYawDeltaFull * engagedPose.blend, 0.05) &&
  closeTo(engagedPose.legRotationRad, SHOP_SIT_LEG_ROTATION_RAD * engagedPose.blend, 0.1) &&
  closeTo(engagedPose.armRotationRad, SHOP_SIT_ARM_ROTATION_RAD * engagedPose.blend, 0.1);
console.log('seated pose terms all close to their fully-blended hand-computed values (should be true):', poseEngaged);

// Instant ease-out: a brief joystick deflection counts as real input
// (hasActiveInput), which should hard-cut shopSitBlend (and both offsets)
// back to exactly 0 the very next frame -- not an eased decay like the
// ease-in above.
await deflectMoveJoystick(page);
const poseAfterMovement = await page.evaluate(() => window.__testShopSitPose());
console.log('seated pose hard-cut to 0 the instant movement resumed (should be true):', poseAfterMovement.blend === 0 && poseAfterMovement.heightOffset === 0 && poseAfterMovement.yawOffset === 0);

const pass =
  templateCreated.status === 201 &&
  landletCreated.status === 201 &&
  placed.status === 201 &&
  poseEngaged &&
  poseAfterMovement.blend === 0 &&
  poseAfterMovement.heightOffset === 0 &&
  poseAfterMovement.yawOffset === 0 &&
  errors.length === 0;

await finish(session.browser, {
  pass,
  label: '#2478: the seated pose eases in on a sit target and hard-cuts back to neutral on movement',
  errors,
});
