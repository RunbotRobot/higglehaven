// Regression test for #1586: the AFK label (afkSprite, src/main.js's
// updateShopAvatarIdle) used to time out only off the move joystick
// (shopMoveX/shopMoveY) -- a shopper who was only panning the camera via
// the look joystick (shopLookX/shopLookY) still got timed out to AFK after
// SHOP_AFK_DELAY_S despite clearly being at the controls, and that same
// look-only input never cleared an AFK state already showing. Fixed by
// having updateShopAvatarIdle take a combined hasActiveInput (move OR
// look) instead of moveMagnitude alone.
//
// window.__shopAfkOpacity (added alongside the existing
// window.__shopAvatarOrientation diagnostic) exposes afkSprite's own
// material.opacity each frame -- otherwise only checkable by eye.
//
// This necessarily waits out the real SHOP_AFK_DELAY_S (90s) twice (once to
// confirm look-only input never trips it, once to actually get an AFK state
// to then clear) -- there's no faster deterministic way to exercise this
// specific timer from outside the module.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'AFK Look-Only Tester';
const SHOP_AFK_DELAY_S = 90;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.click('.mode-nav-btn[data-mode="shop"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });

async function afkOpacity() {
  return page.evaluate(() => window.__shopAfkOpacity ?? null);
}

// A trivial move-joystick tap (down, tiny move, up) -- just enough to count
// as navigation input and end #1175's hands-off spawn orbit, so the avatar
// is genuinely stationary (not auto-orbiting) for the rest of this test.
// Mirrors e2e/compass.test.mjs's own dragMoveJoystick idiom.
async function tapMoveJoystick() {
  const box = await page.locator('#shop-move-joystick').boundingBox();
  const originX = box.x + box.width / 2;
  const originY = box.y + box.height / 2;
  await page.mouse.move(originX, originY);
  await page.mouse.down();
  await page.mouse.move(originX + 20, originY, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}
await tapMoveJoystick();

const opacityAfterSpawnStop = await afkOpacity();
console.log('AFK opacity right after stopping the spawn orbit (should be ~0):', opacityAfterSpawnStop);

// Hold ONLY the look joystick deflected for the entire AFK delay -- a real
// pointer down+move+(hold, no release) the same way bindShopJoystick reads
// it: shopLookX/shopLookY latch to the deflected value from that one move
// event and stay there every frame until release, same as a player holding
// the stick to keep panning the camera.
const lookBox = await page.locator('#shop-look-joystick').boundingBox();
const lookOriginX = lookBox.x + lookBox.width / 2;
const lookOriginY = lookBox.y + lookBox.height / 2;
await page.mouse.move(lookOriginX, lookOriginY);
await page.mouse.down();
await page.mouse.move(lookOriginX + 25, lookOriginY, { steps: 2 });
await page.waitForTimeout((SHOP_AFK_DELAY_S + 5) * 1000);
const opacityWhileLookHeld = await afkOpacity();
console.log(`AFK opacity after holding ONLY the look joystick for ${SHOP_AFK_DELAY_S + 5}s (should still be ~0 -- #1586's bug):`, opacityWhileLookHeld);
await page.mouse.up();
await page.waitForTimeout(300);

const opacityRightAfterLookRelease = await afkOpacity();
console.log('AFK opacity immediately after releasing the look joystick (should still be ~0 -- no input at all yet, nothing to have triggered AFK):', opacityRightAfterLookRelease);

// Now genuinely idle -- no input of any kind. Wait out the real delay to
// confirm the underlying AFK mechanism itself still works (the baseline
// this fix must not have broken).
await page.waitForTimeout((SHOP_AFK_DELAY_S + 5) * 1000);
const opacityAfterRealIdle = await afkOpacity();
console.log(`AFK opacity after ${SHOP_AFK_DELAY_S + 5}s of true stillness (should now be clearly visible, > 0.5):`, opacityAfterRealIdle);

// A brief look-only nudge (not held) should clear it right away -- the
// other half of #1586's report ("doesn't clear once movement resumes"),
// generalized to "or look resumes."
await page.mouse.move(lookOriginX, lookOriginY);
await page.mouse.down();
await page.mouse.move(lookOriginX, lookOriginY + 25, { steps: 2 });
await page.mouse.up();
await page.waitForTimeout(500);
const opacityAfterLookNudge = await afkOpacity();
console.log('AFK opacity shortly after a brief look-only nudge (should drop back to ~0):', opacityAfterLookNudge);

const near0 = (v) => typeof v === 'number' && v < 0.05;
const pass =
  near0(opacityAfterSpawnStop) &&
  near0(opacityWhileLookHeld) &&
  near0(opacityRightAfterLookRelease) &&
  typeof opacityAfterRealIdle === 'number' && opacityAfterRealIdle > 0.5 &&
  near0(opacityAfterLookNudge) &&
  errors.length === 0;
await finish(browser, { pass, label: 'Shop AFK indicator: look-only input counts as activity (#1586)', errors });
