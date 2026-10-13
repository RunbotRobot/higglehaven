// #1828: owner report — flying near the dome's own ceiling and then
// drifting outward let the avatar (and the camera that follows it) poke
// through the dome's visible curved surface, even while comfortably under
// its flat apex height. Root cause: shopMaxRadiusM/shopAvatarMaxRadiusM
// (the horizontal clamps) and clampShopCameraHeight/shopMaxFlightAltitudeM
// (the vertical clamp) are each one flat bound, together forming a
// cylindrical bounding box — but the actual boundary above the wall's rim
// is shopDomeMesh's own curved ellipsoid cap, whose real cross-section
// radius shrinks the higher up you go. A position can pass both flat
// clamps individually while already sitting outside the dome's real
// curved surface, worst right near the top.
//
// This is three.js geometry with no unit-test pool to live in
// (vitest.config.js's own note: nothing importing three.js belongs in
// src/**/*.test.js), so this is the verification the issue itself asked
// for: climb to near the dome's own ceiling, then hold full forward
// deflection long enough to try to blow past the dome's real (height-
// shrunk) radius at that altitude, and confirm the avatar/camera stay
// inside the dome's actual curved surface rather than just under its flat
// apex.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Flight Dome Curvature Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
// #688/#1175: spawn state isn't settled until enterShopMode's post-fetch
// tail finishes (same wait flight-dome-ceiling.test.mjs/flight.test.mjs rely on).
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// Climb near the dome's own ceiling first — same hold-up-button technique
// flight-dome-ceiling.test.mjs (#1631) already established.
const upBtnBox = await page.locator('#shop-up-btn').boundingBox();
await page.mouse.move(upBtnBox.x + upBtnBox.width / 2, upBtnBox.y + upBtnBox.height / 2);
await page.mouse.down();
await page.waitForTimeout(6000);
await page.mouse.up();

// ...then, while still elevated, hold the move joystick (left stick) at
// full forward deflection long enough to try to reach — and overshoot —
// the wall's own horizontal radius. Flight speed scales up to 100x at
// this altitude (SHOP_FLIGHT_MAX_SPEED_MULTIPLIER), so this comfortably
// covers even a freshly-seeded dev world's full radius well within the
// hold.
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveOriginX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveOriginY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveOriginX, moveOriginY);
await page.mouse.down();
await page.mouse.move(moveOriginX, moveOriginY - moveJoystickBox.height / 2, { steps: 5 });
await page.waitForTimeout(10000);
await page.mouse.up();

const debug = await page.evaluate(() => window.__shopFlightCeilingDebug);
console.log('avatar/camera position vs. the dome\'s own real curved surface after flying up and outward:', debug);

// Independently recomputes the dome's real cross-section radius at a given
// world z from the same ellipse equation the dome mesh's own non-uniform
// scale encodes (see shopMaxRadiusAtWorldZM's own comment) — not the clamp
// formula under test, same "independently recomputed from the mesh itself"
// principle flight-dome-ceiling.test.mjs's own domeApexWorldZ check uses.
function domeSurfaceRadiusAtZ(z) {
  const heightAboveDomeBaseM = z - debug.domeBaseWorldZ;
  if (heightAboveDomeBaseM <= 0) return debug.domeRadiusM;
  return debug.domeRadiusM * Math.sqrt(Math.max(0, 1 - (heightAboveDomeBaseM / debug.domeRiseM) ** 2));
}

const avatarDomeRadiusM = domeSurfaceRadiusAtZ(debug.avatarZ);
const cameraDomeRadiusM = domeSurfaceRadiusAtZ(debug.cameraZ);
// A small positive margin below the real curved surface is correct and
// expected (the same clearance shopMaxRadiusM/shopAvatarMaxRadiusM already
// subtract); a negative margin means the avatar/camera is outside the
// dome's real curved shape at its own height — the pre-fix bug this issue
// reported, even though both stayed under the dome's flat apex the whole
// time.
const avatarMarginM = avatarDomeRadiusM - debug.avatarRadiusM;
const cameraMarginM = cameraDomeRadiusM - debug.cameraRadiusM;
console.log(`dome's real cross-section radius at the avatar's own height: ${avatarDomeRadiusM}, avatar's actual horizontal radius: ${debug.avatarRadiusM}, margin (should be >= 0): ${avatarMarginM}`);
console.log(`dome's real cross-section radius at the camera's own height: ${cameraDomeRadiusM}, camera's actual horizontal radius: ${debug.cameraRadiusM}, margin (should be >= 0): ${cameraMarginM}`);
// Confirms the climb actually reached a height where the dome's real
// radius is meaningfully smaller than the flat clamp's full radius —
// otherwise a pass here wouldn't actually be exercising the bug at all.
console.log(`dome's real radius at this height as a fraction of its full radius (should be well under 1, confirming this is actually testing the curved part of the dome): ${avatarDomeRadiusM / debug.domeRadiusM}`);

const pass =
  avatarDomeRadiusM / debug.domeRadiusM < 0.9 &&
  avatarMarginM > -0.01 &&
  cameraMarginM > -0.01 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1828: flying up and outward stops the avatar/camera inside the dome\'s real curved surface, not just under its flat apex',
  errors,
});
