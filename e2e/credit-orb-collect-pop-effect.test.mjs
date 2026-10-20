// #2441 (owner ask, 2026-10-20): collecting a credit orb used to just
// instantly remove the mesh with no animated feedback on the orb itself --
// only a plain text toast (see e2e/credit-orb-collect.test.mjs). This
// confirms the new scale-up-then-fade pop effect (spawnCreditOrbPopEffect/
// updateCreditOrbPopEffects in src/main.js) actually spawns on a genuine
// collection and cleans itself up again once its short lifespan
// (CREDIT_ORB_POP_LIFESPAN_S) elapses -- via window.__testActiveCreditOrbPopEffectCount,
// the same "expose a minimal hook purely for test verification" convention
// window.__testActiveCreditOrbIds (#2264) already uses, since
// creditOrbPopEffects isn't otherwise observable from a test.
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish } from './helpers.mjs';

const LABEL = 'Credit Orb Pop Effect Tester';
const LANDLET_ID = `credit-orb-pop-e2e-${Date.now()}`;
const ORB_X = 2;
const ORB_Y = -1;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await createGreenbeltLandletAsAdmin(LANDLET_ID, { areaM2: 1000 });
const orbId = await seedCreditOrbAsAdmin(LANDLET_ID, { x: ORB_X, y: ORB_Y });

async function fetchJson(path) {
  return page.evaluate(async (p) => (await fetch(p)).json(), path);
}

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

const { landlets } = await fetchJson('/api/landlets?limit=100');
const myLandlet = landlets.find((l) => l.landletId === LANDLET_ID);
console.log('seeded landlet found via the API (should be true):', !!myLandlet);

// #1445: a brief real joystick deflection breaks Shop mode's own hands-off
// spawn orbit, freeing shopAvatarPosition for the teleport hook to drive --
// same sequence e2e/credit-orb-collect.test.mjs uses.
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveCenterX, moveCenterY);
await page.mouse.down();
await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y);
  window.__testForceShopProximityCheck();
}, [myLandlet.center.x, myLandlet.center.y]);
await page.waitForTimeout(500);

const popEffectsBeforeCollecting = await page.evaluate(() => window.__testActiveCreditOrbPopEffectCount());
console.log('no pop effect active before collecting (should be 0):', popEffectsBeforeCollecting);

// Walk exactly onto the orb's own world position, well within
// CREDIT_ORB_COLLECT_RADIUS_M, same as e2e/credit-orb-collect.test.mjs.
const orbWorldX = myLandlet.center.x + ORB_X;
const orbWorldY = myLandlet.center.y + ORB_Y;
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y);
  window.__testForceShopProximityCheck();
}, [orbWorldX, orbWorldY]);

await page.waitForSelector('#shop-credit-orb-toast.visible', { timeout: 5000 });

const popEffectsRightAfterCollecting = await page.evaluate(() => window.__testActiveCreditOrbPopEffectCount());
console.log('pop effect spawned right after collecting (should be 1):', popEffectsRightAfterCollecting);

// CREDIT_ORB_POP_LIFESPAN_S is 0.4s -- waiting well past it confirms
// updateCreditOrbPopEffects actually disposes and removes the effect
// instead of leaving it (and its cloned geometry/material) around forever.
await page.waitForTimeout(1000);
const popEffectsAfterLifespan = await page.evaluate(() => window.__testActiveCreditOrbPopEffectCount());
console.log('pop effect cleaned up after its lifespan elapses (should be 0):', popEffectsAfterLifespan);

const listedAfterCollecting = await fetchJson(`/api/credit-orbs?landletId=${encodeURIComponent(LANDLET_ID)}`);
console.log('orb no longer active after auto-collecting (should be true):', !listedAfterCollecting.orbs.some((o) => o.orbId === orbId));

const pass = !!myLandlet &&
  popEffectsBeforeCollecting === 0 &&
  popEffectsRightAfterCollecting === 1 &&
  popEffectsAfterLifespan === 0 &&
  !listedAfterCollecting.orbs.some((o) => o.orbId === orbId) &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Credit orb collection spawns a scale-up-then-fade pop effect that cleans itself up (#2441)',
  errors,
});
