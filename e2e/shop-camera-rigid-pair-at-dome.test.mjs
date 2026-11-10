// #3385 (owner rule from #3374): at the world's edge the avatar and the camera
// are one rigid pair. The camera stays exactly the follow distance from the
// avatar's anchor, neither end crosses the dome, and when the camera is on the
// outer side the avatar stops a follow distance short of where it stops when
// facing outward (the accepted asymmetry).
//
// Flying (above the ground, below the wall's rim): fly out facing outward and note where the avatar rests, turn the
// camera to face the centre (the pair slides in, the turn is never blocked),
// then back outward for longer than it takes to reach the edge.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Rigid Pair Dome Tester';
const FOLLOW_M = 4.2;
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await page.setViewportSize({ width: 1100, height: 800 });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 20000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 20000 });

const joystick = await page.locator('#shop-move-joystick').boundingBox();
const originX = joystick.x + joystick.width / 2;
const originY = joystick.y + joystick.height / 2;

// Everything is rebuilt from raw positions, not from the clamp's own formula.
const state = () => page.evaluate(() => {
  const bounds = window.__shopAvatarBoundsDebug();
  const c = window.__shopFlightCeilingDebug;
  const anchorZ = c.avatarZ + window.__shopAvatarMetrics.cameraAnchorHeightM;
  const domeAt = (z) => {
    const h = z - c.domeBaseWorldZ;
    return h <= 0 ? c.domeRadiusM : c.domeRadiusM * Math.sqrt(Math.max(0, 1 - (h / c.domeRiseM) ** 2));
  };
  const lookX = c.avatarX - bounds.cameraXM;
  const lookY = c.avatarY - bounds.cameraYM;
  return {
    domeRadiusM: c.domeRadiusM, domeRiseM: c.domeRiseM, domeBaseWorldZ: c.domeBaseWorldZ, avatarZ: c.avatarZ, cameraZ: bounds.cameraZM,
    pivotRadiusM: bounds.pivotRadiusM,
    bodyMarginM: bounds.farthest.marginM,
    anchorToCameraM: Math.hypot(lookX, lookY, anchorZ - bounds.cameraZM),
    horizontalOffsetM: Math.hypot(lookX, lookY),
    cameraLimitM: domeAt(bounds.cameraZM) - 0.3, // the camera's 0.3 m dome margin (SHOP_CAMERA_DOME_MARGIN_M)
    cameraMarginM: domeAt(bounds.cameraZM) - bounds.cameraRadiusM,
    // < 0: the camera looks toward the centre (it sits on the outer side).
    lookDotOutward: (lookX * c.avatarX + lookY * c.avatarY) / Math.max(1e-6, Math.hypot(lookX, lookY) * Math.hypot(c.avatarX, c.avatarY)),
  };
});

// The avatar spawns flying near the ceiling, where a freshly seeded (14 m) world's dome has
// narrowed to a few metres and no rigid pair can fit. Descend until it is flying below the
// wall's rim (the flat part of the world, still well above the ground) so the pair has room.
const downBox = await page.locator('#shop-down-btn').boundingBox();
await page.mouse.move(downBox.x + downBox.width / 2, downBox.y + downBox.height / 2);
await page.mouse.down();
for (let i = 0; i < 60; i += 1) {
  await page.waitForTimeout(250);
  const s0 = await state();
  if (s0.avatarZ - s0.domeBaseWorldZ < -3) break;
}
await page.mouse.up();
const flying = await state();
console.log('flying altitude check (avatar z minus dome base z, should be below the rim and above the ground):', (flying.avatarZ - flying.domeBaseWorldZ).toFixed(1));

// Run A: fly outward facing out.
await page.mouse.move(originX, originY);
await page.mouse.down();
await page.mouse.move(originX, originY - joystick.height / 2, { steps: 5 });
await page.waitForTimeout(9000);
await page.mouse.up();
await page.waitForTimeout(500);
const outward = await state();
console.log('facing out, at rest:', JSON.stringify(outward));

// Turn the camera to face the centre; the pair must keep its distance while it turns.
await page.keyboard.down('KeyE');
let turned = await state();
const turnSamples = [turned];
for (let i = 0; i < 400 && turned.lookDotOutward > -0.95; i += 1) {
  await page.waitForTimeout(100);
  turned = await state();
  turnSamples.push(turned);
}
await page.keyboard.up('KeyE');
await page.waitForTimeout(500);
turned = await state();
console.log('facing the centre, after the turn:', JSON.stringify(turned));
const worstTurnDistanceErr = Math.max(...turnSamples.map((s) => Math.abs(s.anchorToCameraM - FOLLOW_M)));
const worstTurnCameraMargin = Math.min(...turnSamples.map((s) => s.cameraMarginM));

// Back outward, facing the centre, for longer than it takes to reach the edge.
await page.keyboard.down('ArrowDown');
await page.waitForTimeout(9000);
const first = await state();
await page.waitForTimeout(2000);
const second = await state();
await page.keyboard.up('ArrowDown');
console.log('backing out, camera on the outer side:', JSON.stringify(second));

const stopped = Math.abs(second.pivotRadiusM - first.pivotRadiusM) < 0.3;
const facingCentre = second.lookDotOutward < -0.8;
const distanceHeld = Math.abs(second.anchorToCameraM - FOLLOW_M) < 0.15 && Math.abs(first.anchorToCameraM - FOLLOW_M) < 0.15
  && worstTurnDistanceErr < 0.15;
const bothInside = second.bodyMarginM >= -0.05 && second.cameraMarginM >= -0.05 && worstTurnCameraMargin >= -0.05;
// The camera is on the outer side and looking at the centre, so it sits horizontalOffsetM
// beyond the avatar: the pair stops when the camera reaches its limit.
const expectedRestM = second.cameraLimitM - second.horizontalOffsetM;
const restsWhereTheCameraStops = Math.abs(second.pivotRadiusM - expectedRestM) < 0.3;
const restsFarther = second.pivotRadiusM < outward.pivotRadiusM - 0.5 && restsWhereTheCameraStops;
console.log(`facing centre: ${facingCentre}, stopped: ${stopped}, distance held (turn worst err ${worstTurnDistanceErr.toFixed(2)}): ${distanceHeld}, both inside: ${bothInside}, rests ${(outward.pivotRadiusM - second.pivotRadiusM).toFixed(2)}m farther from the dome than facing out, where the camera stops (expected ${expectedRestM.toFixed(2)}): ${restsFarther}`);

await finish(browser, {
  pass: facingCentre && stopped && distanceHeld && bothInside && restsFarther && errors.length === 0,
  label: '#3385: at the dome the avatar-to-camera distance holds, both ends stay inside, and the avatar rests farther in with the camera on the outer side',
  errors,
});
