// #1840: split out from #1828/#1839 as a deliberate follow-up -- #1839
// fixed the dome boundary clamps to follow the dome's real curved shape at
// altitude, but both clamps (there and before it) only ever constrained
// the avatar group's own origin (its feet/hip pivot). Flying tips the
// whole group into a ~45deg forward lean (SHOP_AVATAR_FLIGHT_PITCH_RAD),
// so the torso/head reach forward past that clamped pivot -- the owner's
// own #1828 report: "his feet stay inside the dome, only his lean makes
// the rest of him go outside." This reproduces at ordinary, low altitude
// (no climb needed), where the clamp is just the flat wall radius -- a
// separate case from #1839's own altitude-dependent curved-dome bug.
//
// Three.js geometry with no unit-test pool to live in (vitest.config.js's
// own note), so this is e2e, same "independently recompute from the real
// exported state, not from the formula under test" principle
// flight-dome-ceiling.test.mjs/flight-dome-curvature.test.mjs already
// follow: applies the avatar's own real exported quaternion
// (window.__shopAvatarOrientation.quaternion -- the actual yaw+pitch
// composition the production code builds, not a hand-rederived copy of
// it) to a representative local point near the torso/head, to find the
// leaning mesh's own real farthest world-space point independent of
// whatever clamp formula ends up guarding it.
import * as THREE from 'three';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Flight Lean Clearance Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
// #688/#1175: spawn state isn't settled until enterShopMode's post-fetch
// tail finishes (same wait flight.test.mjs/flight-dome-ceiling.test.mjs rely on).
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// Avatar spawns already flying (#1175) near the world center, at ordinary
// (not climbed) altitude -- deliberately not holding Up first, since this
// bug reproduces at low altitude, unlike #1828/#1839's near-ceiling case.
// Hold full forward deflection long enough to reach the wall's own flat
// radius on a freshly-seeded dev world.
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveOriginX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveOriginY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveOriginX, moveOriginY);
await page.mouse.down();
await page.mouse.move(moveOriginX, moveOriginY - moveJoystickBox.height / 2, { steps: 5 });
await page.waitForTimeout(8000); // past SHOP_AVATAR_FLIGHT_PITCH_EASE_PER_S's own convergence window too, so the lean is fully eased in
await page.mouse.up();

const debug = await page.evaluate(() => ({
  flight: window.__shopFlightCeilingDebug,
  orientation: window.__shopAvatarOrientation,
}));
console.log('avatar pivot position / dome radius / real orientation quaternion after flying outward at low altitude:', debug);

// Same approximation #1840's own fix uses: the farthest reach point sits
// roughly TORSO_LENGTH + HEAD_RADIUS*2 above the pivot along the model's
// local +Z (torso/head are both built up along positive local Z from the
// group's own origin -- see createCustomShopAvatar/procedural-avatar
// construction in src/main.js). Applying the REAL exported quaternion
// (not a hand-rebuilt yaw/pitch composition) to this local point is what
// makes this an independent check of the production code's actual
// geometry, not a restatement of the fix's own formula.
const SHOP_AVATAR_TORSO_LENGTH_M = 0.5;
const SHOP_AVATAR_HEAD_RADIUS_M = 0.14;
const localReachPoint = new THREE.Vector3(0, 0, SHOP_AVATAR_TORSO_LENGTH_M + SHOP_AVATAR_HEAD_RADIUS_M * 2);
const realQuaternion = new THREE.Quaternion(...debug.orientation.quaternion);
const worldReachOffset = localReachPoint.clone().applyQuaternion(realQuaternion);

const farthestPointX = debug.flight.avatarX + worldReachOffset.x;
const farthestPointY = debug.flight.avatarY + worldReachOffset.y;
const farthestPointRadiusM = Math.hypot(farthestPointX, farthestPointY);
const pivotRadiusM = Math.hypot(debug.flight.avatarX, debug.flight.avatarY);
const marginM = debug.flight.domeRadiusM - farthestPointRadiusM;
console.log(`pivot radius: ${pivotRadiusM}, leaning mesh's farthest-point radius: ${farthestPointRadiusM}, dome/wall radius: ${debug.flight.domeRadiusM}, margin (should be >= 0, not negative): ${marginM}`);
// Confirms the clamp is actually being exercised (the pivot got pushed out
// near the wall), not just trivially passing because nothing moved.
console.log(`pivot got within this many meters of the wall: ${debug.flight.domeRadiusM - pivotRadiusM}`);

const pass =
  marginM > -0.05 &&
  debug.flight.domeRadiusM - pivotRadiusM < 5 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1840: a leaning, flying avatar\'s farthest-reaching body point stays inside the wall\'s real radius, not just its clamped pivot',
  errors,
});
