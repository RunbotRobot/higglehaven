// #2479 (sub-issue of #2475): once #2477's own targeting selects a
// kind: 'lean' target for the current idle episode, the avatar should ease
// into a lean-against pose aligned to that target's own position/
// orientation -- a visual-only position/yaw offset on the rendered mesh
// plus a backward body tilt, never touching the real shopAvatarPosition/
// shopAvatarFacing (see docs/API.md's "Lean pose + transition (#2479)" --
// same discipline as the sit pose's own height/yaw offset, for the same
// reason: sitting/leaning shouldn't affect movement, collision, curvature,
// or camera-follow code). Checks the blend actually engages close to its
// fully-blended values, then that a brief joystick deflection hard-cuts it
// back to 0 on the very next frame (the same instant-ease-out discipline
// every other idle blend in this file already follows).
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
// deflection" idiom shop-idle-sit-pose.test.mjs's own header comment
// documents -- otherwise shopSpawnRotating overwrites shopAvatarPosition.x/y
// every frame regardless of what this test teleports it to. Reused again
// below (after the lean pose engages) to drive the hard-cut-on-movement
// assertion.
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

// Same ownership/creation shortcuts shop-idle-sit-pose.test.mjs's own
// comments explain in full: a seller-owned template, builder fetched
// directly (bypassing Build mode's own claim-modal), landlet at the default
// (0,0) center.
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
// direct read of the template's own local offset/facing, same reasoning
// shop-idle-sit-pose.test.mjs's own comment gives for its own chair.
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

// Hand-computed expected target (0-rotation instance, so no offset
// rotation to combine): worldX/Y = instance position + offsetXM/offsetYM,
// worldZ = mesh.position.z (1.0) - height/2 (1.0) + heightM (1.0) = 1.0,
// worldFacingRad = facingRad (PI) + mesh.rotation.z (0) = PI.
const LEAN_TARGET_WORLD_X = WALL_X;
const LEAN_TARGET_WORLD_Y = WALL_Y + 0.3;
const LEAN_TARGET_WORLD_Z = 1.0;
const LEAN_TARGET_WORLD_FACING_RAD = Math.PI;
const SHOP_LEAN_PITCH_RAD = (12 * Math.PI) / 180;

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

await deflectMoveJoystick(page);
// 3-arg form forces shopFlightState to 'grounded' too -- 2m from the
// wall's own lean spot, comfortably inside the 3m search radius.
const AVATAR_X = WALL_X;
const AVATAR_Y = WALL_Y - 2;
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y, 0);
  window.__testForceShopProximityCheck();
}, [AVATAR_X, AVATAR_Y]);
await page.waitForTimeout(500); // lets the just-forced landlet instance load actually finish

// Captured once here as the real baseline for the expected position/yaw-
// offset math below, same reasoning shop-idle-sit-pose.test.mjs's own
// baselineFacingRad gives (shopAvatarFacing/shopAvatarPosition never change
// on their own while idle -- no real input, so nothing moves them).
const baselinePosition = await page.evaluate(() => window.__testShopAvatarPosition());
const baselineFacingRad = (await page.evaluate(() => window.__shopAvatarOrientation)).facingRad;

// Same real-vs-simulated-time polling reasoning shop-idle-sit-pose.test.mjs's
// own comment documents -- waits for the idle episode to actually pick the
// lean target up, then for shopLeanBlend (eased at SHOP_IDLE_BLEND_PER_S =
// 0.6/s) to substantially engage rather than a fixed real-time sleep.
// #2598: waitForFunction's signature is (pageFunction, arg, options) --
// these 2-arg calls put the options object in the arg slot instead, so the
// real applied timeout was always Playwright's own default (30000ms), not
// the written values -- and even those were too tight under current CI
// load. The explicit `null` arg reaches the options slot, and the
// timeouts are widened for real headroom.
await page.waitForFunction(() => window.__testShopIdleInteractionTarget()?.kind === 'lean', null, { timeout: 60000 });
await page.waitForFunction(() => window.__testShopLeanPose().blend > 0.9, null, { timeout: 60000 });

const engagedPose = await page.evaluate(() => window.__testShopLeanPose());
const engagedOrientation = await page.evaluate(() => window.__shopAvatarOrientation);
console.log('lean pose once substantially engaged (blend should be > 0.9):', engagedPose, engagedOrientation);

function closeTo(actual, expectedValue, tolerance) {
  return typeof actual === 'number' && Math.abs(actual - expectedValue) < tolerance;
}

// At blend ~0.9 (not a clean 1.0, since the exponential ease never fully
// reaches it) every term should be within a generous tolerance of its
// fully-blended value -- enough to catch a wrong sign, a missing scale
// factor, or a swapped term, which is what this test actually cares about.
const expectedOffsetXFull = LEAN_TARGET_WORLD_X - baselinePosition.x;
const expectedOffsetYFull = LEAN_TARGET_WORLD_Y - baselinePosition.y;
const expectedOffsetZFull = LEAN_TARGET_WORLD_Z - baselinePosition.z;
const expectedYawDeltaFull = Math.atan2(
  Math.sin(LEAN_TARGET_WORLD_FACING_RAD - baselineFacingRad),
  Math.cos(LEAN_TARGET_WORLD_FACING_RAD - baselineFacingRad),
);
const poseEngaged =
  engagedPose.blend > 0.9 &&
  closeTo(engagedPose.positionOffset.x, expectedOffsetXFull * engagedPose.blend, 0.1) &&
  closeTo(engagedPose.positionOffset.y, expectedOffsetYFull * engagedPose.blend, 0.1) &&
  closeTo(engagedPose.positionOffset.z, expectedOffsetZFull * engagedPose.blend, 0.1) &&
  closeTo(engagedPose.yawOffset, expectedYawDeltaFull * engagedPose.blend, 0.1) &&
  // Backward tilt (positive, opposite SHOP_AVATAR_FLIGHT_PITCH_RAD's
  // forward-dive sign) -- pitchRad eases toward SHOP_LEAN_PITCH_RAD *
  // blend independently (SHOP_AVATAR_FLIGHT_PITCH_EASE_PER_S), so this
  // only checks it's substantially engaged in the right direction.
  engagedOrientation.pitchRad > SHOP_LEAN_PITCH_RAD * 0.5 &&
  // The real, authoritative position/facing must stay completely
  // untouched -- visual-only per #2479/#2478's shared discipline.
  baselinePosition.x === (await page.evaluate(() => window.__testShopAvatarPosition())).x;
console.log('lean pose terms all close to their fully-blended hand-computed values (should be true):', poseEngaged);

// Instant ease-out: a brief joystick deflection counts as real input
// (hasActiveInput), which should hard-cut shopLeanBlend (and its offsets)
// back to exactly 0 the very next frame -- not an eased decay like the
// ease-in above.
await deflectMoveJoystick(page);
const poseAfterMovement = await page.evaluate(() => window.__testShopLeanPose());
console.log(
  'lean pose hard-cut to 0 the instant movement resumed (should be true):',
  poseAfterMovement.blend === 0 && poseAfterMovement.yawOffset === 0
    && poseAfterMovement.positionOffset.x === 0 && poseAfterMovement.positionOffset.y === 0 && poseAfterMovement.positionOffset.z === 0,
);

const pass =
  templateCreated.status === 201 &&
  landletCreated.status === 201 &&
  placed.status === 201 &&
  poseEngaged &&
  poseAfterMovement.blend === 0 &&
  poseAfterMovement.yawOffset === 0 &&
  poseAfterMovement.positionOffset.x === 0 &&
  poseAfterMovement.positionOffset.y === 0 &&
  poseAfterMovement.positionOffset.z === 0 &&
  errors.length === 0;

await finish(session.browser, {
  pass,
  label: '#2479: the lean pose eases in on a lean target and hard-cuts back to neutral on movement',
  errors,
});
