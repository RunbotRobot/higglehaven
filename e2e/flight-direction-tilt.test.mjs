// #1168: owner bug report — "When flying, the avatar's direction of
// incline doesn't change to match the direction. He's always at a 45
// degree angle from the same direction." Root cause: flight pitch and
// facing/yaw used to be set as independent Euler fields on the same
// THREE.Object3D (src/main.js's updateShopMovement), which doesn't compose
// as "pitch in the frame yaw just established" the way two intrinsic
// rotations applied in sequence need to — see SHOP_AVATAR_FLIGHT_PITCH_RAD's
// own comment for the full explanation. Fixed by composing yaw and pitch as
// a single quaternion instead.
//
// This is three.js orientation math with no unit-test pool to live in
// (vitest.config.js's own note: nothing importing three.js belongs in
// src/**/*.test.js), so this is the verification the issue itself asked
// for: fly in two clearly different directions and confirm the tilt leans
// with whichever way the avatar is actually facing, not a fixed direction.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Flight Tilt Tester' });

await chooseIdentity(page, { mode: 'shop', label: 'Flight Tilt Tester', isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// #1175: every spawn (not just a first-ever visit) now spawns already
// flying, above a random world location — no fly-button tap needed. (A tap
// here would instead *land* the avatar, the opposite of what this test
// needs — see flight.test.mjs's own identical spawn-flying behavior and
// its own "land it first" step right after checking that.) Just wait for
// the takeoff/pitch-ease (SHOP_AVATAR_FLIGHT_PITCH_EASE_PER_S) to settle
// close to SHOP_AVATAR_FLIGHT_PITCH_RAD before anything below reads it.
await page.waitForTimeout(2000);

// Drags the move joystick (left stick — walks/flies forward-back-strafe,
// relative to the camera's current facing) from its base's own center
// toward (dxPx, dyPx), mirroring bindShopJoystick's real pointerdown/move
// pair rather than a synthetic onChange call, so this exercises the same
// DOM plumbing a real touch would. Releasing resets the stick to neutral
// afterward (onChange(0, 0), per bindShopJoystick's own `end` handler) —
// fine here since shopAvatarFacing only needs a brief non-zero input to
// turn toward a new heading, then eases there over the next couple hundred
// ms (SHOP_AVATAR_TURN_EASE_PER_S) regardless of whether the stick is still
// held.
async function dragMoveJoystick(dxPx, dyPx) {
  const box = await page.locator('#shop-move-joystick').boundingBox();
  const originX = box.x + box.width / 2;
  const originY = box.y + box.height / 2;
  await page.mouse.move(originX, originY);
  await page.mouse.down();
  await page.mouse.move(originX + dxPx, originY + dyPx, { steps: 5 });
  await page.waitForTimeout(400); // past SHOP_AVATAR_TURN_EASE_PER_S's own convergence window
  await page.mouse.up();
}

// Standard quaternion-vector rotation (Rodrigues' formula via the
// quaternion's own vector/scalar parts) — this is the well-known general
// formula for applying any unit quaternion to a vector, not a reimplementation
// of this fix's own yaw/pitch composition, so recovering the resulting
// "which way is tilted" direction from the raw quaternion the app reports
// doesn't just echo the fix's own math back at itself.
function rotateVectorByQuaternion([qx, qy, qz, qw], [vx, vy, vz]) {
  const uvx = qy * vz - qz * vy;
  const uvy = qz * vx - qx * vz;
  const uvz = qx * vy - qy * vx;
  const uuvx = qy * uvz - qz * uvy;
  const uuvy = qz * uvx - qx * uvz;
  const uuvz = qx * uvy - qy * uvx;
  return [
    vx + 2 * (qw * uvx + uuvx),
    vy + 2 * (qw * uvy + uuvy),
    vz + 2 * (qw * uvz + uuvz),
  ];
}

// The avatar's rest-pose "up" axis (0,0,1) is what flight pitch tips away
// from vertical — its horizontal (x,y) component after rotation points in
// the lean direction. Fixed, direction-independent tilt (the bug) would
// make this horizontal direction the same regardless of facing; correct
// behavior ties it to facing with a constant offset.
function leanAngleRad(orientation) {
  const [x, y] = rotateVectorByQuaternion(orientation.quaternion, [0, 0, 1]);
  return Math.atan2(y, x);
}

function shortestAngleDeltaRad(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

await dragMoveJoystick(0, -40); // up — forward
const orientationForward = await page.evaluate(() => window.__shopAvatarOrientation);

await dragMoveJoystick(40, 0); // right — strafe, a clearly different heading
const orientationRight = await page.evaluate(() => window.__shopAvatarOrientation);

const facingDeltaRad = Math.abs(shortestAngleDeltaRad(orientationRight.facingRad, orientationForward.facingRad));
console.log('facing actually changed between the two drags, in radians (should be well above 0, ideally near pi/2):', facingDeltaRad);

const pitchedBoth = Math.abs(orientationForward.pitchRad) > 0.1 && Math.abs(orientationRight.pitchRad) > 0.1;
console.log('flight pitch meaningfully non-zero in both readings (should be true -- confirms this is actually mid-flight, not grounded):', pitchedBoth, orientationForward.pitchRad, orientationRight.pitchRad);

// The core assertion: the lean direction tracks facing. (leanAngle - facing)
// should read the same constant offset in both orientations if the tilt
// correctly rotates with the body; the pre-fix bug made leanAngle
// essentially independent of facing, so this difference would instead track
// facingDeltaRad itself (close to facingDeltaRad, not close to 0).
const leanOffsetForward = shortestAngleDeltaRad(leanAngleRad(orientationForward), orientationForward.facingRad);
const leanOffsetRight = shortestAngleDeltaRad(leanAngleRad(orientationRight), orientationRight.facingRad);
const offsetDriftRad = Math.abs(shortestAngleDeltaRad(leanOffsetRight, leanOffsetForward));
console.log('lean-direction-relative-to-facing offset while facing forward (radians):', leanOffsetForward);
console.log('lean-direction-relative-to-facing offset while facing right (radians):', leanOffsetRight);
console.log('drift between those two offsets (should be near 0 -- the tilt rotates WITH facing):', offsetDriftRad);

const pass =
  facingDeltaRad > 0.5 &&
  pitchedBoth &&
  offsetDriftRad < 0.2 &&
  errors.length === 0;
await finish(browser, { pass, label: 'Flight tilt leans toward the direction actually being flown, not a fixed direction (#1168)', errors });
