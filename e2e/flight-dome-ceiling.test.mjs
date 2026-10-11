// #1631: owner report (live testing) -- flying straight up, both the
// avatar and the camera were able to ascend above the world dome, which
// should be a hard boundary (the whole world design assumes a player can
// never see past it).
//
// Root cause: updateShopFlight/clampShopCameraHeight's own flight-ceiling
// formula (SHOP_WALL_HEIGHT_M + shopDomeRiseM - SHOP_DOME_CLEARANCE_MARGIN_M)
// didn't account for the ground-curvature sag (curvatureDropM) that
// enterShopMode itself already bakes into the dome/wall's own world-z
// position (wallGroundDropM there) once the world has grown large enough
// for that sag to matter -- on the small, freshly-seeded dev world this is
// a sub-millimeter difference (not reproducible), but it grows with the
// world's radius and became a real, visible tens-of-meters gap once the
// world radius reaches a realistic production-scale size. Reproduced here
// by growing the world directly via the admin API (the same technique
// e2e/shop-landlet-instance-leak.test.mjs (#1445) already established for
// deterministic Shop-mode navigation) rather than waiting for a real
// multi-month-old production world.
import { launchPage, chooseIdentity, ensureAdminSession, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
// Large enough that curvatureDropM(radius) is tens of meters (clearly
// visible), not the sub-millimeter sag a small dev world produces.
const BIG_RADIUS_M = 20000;

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

// Same reasoning as #1445's own ensureRoomToWander: PATCH /api/world alone
// raises world.radiusM, but Shop mode's own shopWorldRadiusM is derived via
// computeGaplessWorldRadius(allLandlets, world.radiusM) -- a filler landlet
// wide enough to blanket full 360-degree coverage out to that radius is
// needed too, or the gapless-coverage computation falls back to whatever
// the existing sparse seed landlets actually cover.
async function growWorld() {
  const cookie = await ensureAdminSession();
  const worldPatch = await adminFetch('/world', cookie, { method: 'PATCH', body: JSON.stringify({ radiusM: BIG_RADIUS_M }) });
  if (worldPatch.response.status !== 200) {
    throw new Error(`growWorld: world radius patch failed -- ${JSON.stringify(worldPatch.body)}`);
  }
  const filler = await adminFetch('/landlets', cookie, {
    method: 'POST',
    body: JSON.stringify({
      landletId: `e2e-flight-ceiling-filler-${crypto.randomUUID()}`,
      name: 'Flight Ceiling Suite Coverage Filler',
      areaM2: BIG_RADIUS_M * 2 * BIG_RADIUS_M * 2,
      centerX: 0,
      centerY: 0,
      status: 'generating',
    }),
  });
  if (filler.response.status !== 201) {
    throw new Error(`growWorld: filler landlet create failed -- ${JSON.stringify(filler.body)}`);
  }
}

await growWorld();

const LABEL = 'Flight Dome Ceiling Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
// #688/#1175: spawn state isn't settled until enterShopMode's post-fetch
// tail finishes (same wait flight.test.mjs/shop-landlet-instance-leak.test.mjs rely on).
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// Avatar spawns already flying (#1175) near the world center, where
// curvatureDropM(avatar's own distance) is near zero -- the exact
// condition that maximizes the pre-fix gap between the clamp and the
// dome's real apex. Hold the up button long enough to hit the ceiling.
const upBtnBox = await page.locator('#shop-up-btn').boundingBox();
await page.mouse.move(upBtnBox.x + upBtnBox.width / 2, upBtnBox.y + upBtnBox.height / 2);
await page.mouse.down();
await page.waitForTimeout(6000);
await page.mouse.up();

const debug = await page.evaluate(() => window.__shopFlightCeilingDebug);
console.log('avatar/camera z vs. the dome\'s own real world-space apex z after flying up as far as possible:', debug);

// A small positive clearance below the real apex is correct and expected
// (SHOP_DOME_CLEARANCE_MARGIN_M); anything above it, or even equal to it,
// means the avatar/camera poked through or grazed the dome -- the pre-fix
// bug let this gap run to tens of meters on a world this size.
const avatarClearanceM = debug.domeApexWorldZ - debug.avatarZ;
const cameraClearanceM = debug.domeApexWorldZ - debug.cameraZ;
console.log(`avatar clearance below the dome's real apex (should be a small positive number, not negative or huge): ${avatarClearanceM}`);
console.log(`camera clearance below the dome's real apex (should be a small positive number, not negative or huge): ${cameraClearanceM}`);

const pass =
  avatarClearanceM > 0 && avatarClearanceM < 10 &&
  cameraClearanceM > 0 && cameraClearanceM < 10 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1631: flying straight up in a large (realistically-sized) world stops the avatar/camera comfortably under the dome\'s real apex, not above it',
  errors,
});
