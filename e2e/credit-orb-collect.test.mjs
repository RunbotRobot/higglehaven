// #1995 (sub-issue of #1976, "Orb-collection mechanic..."): the Shop-mode
// rendering + proximity auto-collect + feedback piece. #1994's own spawn
// cadence (spawnCreditOrbIfDue, ~70min apart by default) is far too slow to
// wait out in a test, so this seeds an orb directly via the admin-gated
// POST /api/credit-orbs fixture (seedCreditOrbAsAdmin) rather than driving
// the real cron. Real Shop-mode camera movement is exercised via
// window.__testTeleportShopAvatar/__testForceShopProximityCheck, the same
// established convention e2e/community-sign-edit-char-limit-guard.test.mjs
// and e2e/shop-walk-after-landing-on-object.test.mjs already use for the
// identical reason (no flaky hand-tuned joystick choreography needed to
// reach an exact world position).
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish } from './helpers.mjs';

const LABEL = 'Credit Orb Suite Tester';
const LANDLET_ID = `credit-orb-e2e-${Date.now()}`;
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
// spawn orbit, freeing shopAvatarPosition for the teleport hook to drive —
// same sequence e2e/community-sign-edit-char-limit-guard.test.mjs uses.
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveCenterX, moveCenterY);
await page.mouse.down();
await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

// Teleport onto the landlet's own center first and force the load decision
// so loadCreditOrbsForLandlet actually fetches and populates shopCreditOrbs
// before standing right next to the orb itself — same two-step choreography
// e2e/community-sign-edit-char-limit-guard.test.mjs/
// e2e/shop-walk-after-landing-on-object.test.mjs already use for the
// identical reason (a real load decision, not a teleport alone, populates
// the per-frame-scanned list updateCreditOrbs reads).
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y);
  window.__testForceShopProximityCheck();
}, [myLandlet.center.x, myLandlet.center.y]);
await page.waitForTimeout(500);

const listedBeforeWalkingOver = await fetchJson(`/api/credit-orbs?landletId=${encodeURIComponent(LANDLET_ID)}`);
console.log('orb still active before walking onto it (should be true):', listedBeforeWalkingOver.orbs.some((o) => o.orbId === orbId));

// Now walk exactly onto the orb's own world position (landlet center +
// its landlet-local x/y, matching docs/API.md's "Credit orbs" shape) —
// well within CREDIT_ORB_COLLECT_RADIUS_M.
const orbWorldX = myLandlet.center.x + ORB_X;
const orbWorldY = myLandlet.center.y + ORB_Y;
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y);
  window.__testForceShopProximityCheck();
}, [orbWorldX, orbWorldY]);

// updateCreditOrbs runs unconditionally every animate() frame (unlike the
// throttled load/unload decision above), so a short real wait is enough —
// same reasoning e2e/community-sign-edit-char-limit-guard.test.mjs gives
// for updateSignFade's own identical per-frame shape.
await page.waitForSelector('#shop-credit-orb-toast.visible', { timeout: 5000 });
const toastText = await page.textContent('#shop-credit-orb-toast');
console.log('collect confirmation toast text:', toastText);

const listedAfterCollecting = await fetchJson(`/api/credit-orbs?landletId=${encodeURIComponent(LANDLET_ID)}`);
console.log('orb no longer active after auto-collecting (should be true):', !listedAfterCollecting.orbs.some((o) => o.orbId === orbId));

const pass = !!myLandlet &&
  listedBeforeWalkingOver.orbs.some((o) => o.orbId === orbId) &&
  !listedAfterCollecting.orbs.some((o) => o.orbId === orbId) &&
  toastText.includes('credit') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Credit orb: walking within range auto-collects it and shows a confirmation toast (#1995)',
  errors,
});
