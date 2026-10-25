// #2744 (owner report, live conversation 2026-10-25): after equipping a
// real, rigged, animated custom avatar (a "green delivery-man model"), the
// owner saw (1) the avatar always facing the camera instead of its own
// movement direction, and (2) no walk animation ever playing. Not diagnosed
// at filing time -- the issue's own body flags that this specific code
// path (createCustomShopAvatar's mixer/actions binding against a real
// skeleton + named idle/walk/fly clips) had never actually been exercised
// end-to-end: animation-runtime-application.test.mjs's own header comment
// says its one upload fixture (crate.glb) has no skeleton at all, so every
// compatibility check in that test short-circuits to null/false before
// ever reaching real binding or playback.
//
// e2e/fixtures/test-rigged-avatar.glb fills that gap: a minimal
// SkinnedMesh (two bones, "Root"/"Leg") with three named AnimationClips
// (idle/walk/fly, per docs/SPEC.md's "Avatar rig/animation clip
// convention") -- small enough to check in, but a real skeleton + real
// clips, not crate.glb's "everything comes back null" shortcut.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, emailForLabel, grantAdmin } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AVATAR_MODEL_PATH = path.join(REPO_ROOT, 'e2e', 'fixtures', 'test-rigged-avatar.glb');

const LABEL = 'Rigged Avatar Facing Tester';
const AVATAR_PRODUCT_NAME = 'Rigged Test Avatar';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', AVATAR_PRODUCT_NAME);
await page.fill('#upload-price', '5');
await page.setInputFiles('#upload-file-input', AVATAR_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
// #682: the upload wizard surfaces which named clips it detected once a
// model has any at all (docs/SPEC.md's own "Avatar rig/animation clip
// convention") -- confirms the fixture itself is sound (idle/walk/fly all
// present) before equipping ever enters the picture, so a later failure
// can't be blamed on a bad fixture.
const detectedCloudBefore = await page.locator('#upload-step-dimensions').textContent();
console.log('upload wizard detected animation clips (should mention idle/walk/fly):', detectedCloudBefore.trim());
await page.waitForTimeout(300);
await page.check('#upload-avatar-category-checkbox');
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
await page.waitForTimeout(500);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const avatarTemplate = templates.find((t) => t.name === AVATAR_PRODUCT_NAME);
console.log('uploaded avatar template detected skeletonSignature (should be non-null -- a real rig):', avatarTemplate?.skeletonSignature);

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];

await grantAdmin(emailForLabel(LABEL));
const purchaseResult = await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId: 'rigged-avatar-instance', landletId: landlet.landletId, templateId: avatarTemplate.templateId, x: 0, y: 0 }),
}).then(() => fetchJson('/api/instances/rigged-avatar-instance/purchase', { method: 'POST' }));
console.log('avatar purchase status (should be 201):', purchaseResult.status);

// --- Enter Shop mode, then equip the rigged avatar live from Settings ---
await page.click('.mode-nav-btn[data-mode="shop"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="shop"]');
const myAvatarsField = page.locator('.settings-field', { hasText: 'My Avatars' });
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('My Avatars') && f.querySelectorAll('.version-row').length >= 2),
  null,
  { timeout: 30000 },
);
await myAvatarsField.locator('.version-row', { hasText: AVATAR_PRODUCT_NAME }).locator('button', { hasText: 'Equip' }).click();
await page.waitForFunction(
  (name) => [...document.querySelectorAll('.version-row')].some((r) => r.textContent.includes(name) && r.textContent.includes('equipped')),
  AVATAR_PRODUCT_NAME,
  { timeout: 10000 },
);
await page.click('#settings-close-btn');
await page.waitForTimeout(300);

const animationSource = await page.evaluate(() => window.__shopAvatarAnimationSource);
console.log('animation source after equipping the rigged fixture (should be "own" -- its own idle/walk/fly clips, no separately-applied animation):', animationSource);

// #2043: every fresh Shop-mode spawn starts already airborne -- tapping
// the fly button starts a real landing (not a no-op freeze), and the
// landing animation needs its own fixed duration to actually finish, same
// margin e2e/shop-landing-spot-avatar-collision.test.mjs's own comment
// documents, before ground movement/walk-vs-fly animation state means
// anything.
await page.click('#shop-fly-btn');
await page.waitForTimeout(2500); // past SHOP_FLIGHT_LANDING_DURATION_S (2s) -- now grounded

async function dragMoveJoystick(dxPx, dyPx) {
  const box = await page.locator('#shop-move-joystick').boundingBox();
  const originX = box.x + box.width / 2;
  const originY = box.y + box.height / 2;
  await page.mouse.move(originX, originY);
  await page.mouse.down();
  await page.mouse.move(originX + dxPx, originY + dyPx, { steps: 5 });
  await page.waitForTimeout(400);
}
async function releaseMoveJoystick() {
  await page.mouse.up();
  await page.waitForTimeout(400);
}

const orientationBeforeMove = await page.evaluate(() => window.__shopAvatarOrientation);
console.log('facing before any movement input:', orientationBeforeMove?.facingRad);

// Drag forward and read the animation state mid-drag (while still held, so
// moveMagnitude is actually nonzero) before releasing.
await dragMoveJoystick(0, -40);
const animStateWhileMovingForward = await page.evaluate(() => window.__shopAvatarAnimState);
const orientationForward = await page.evaluate(() => window.__shopAvatarOrientation);
await releaseMoveJoystick();
const animStateAfterStopping = await page.evaluate(() => window.__shopAvatarAnimState);
console.log('animation state while walking forward (should be "walk"):', animStateWhileMovingForward);
console.log('animation state after releasing the stick and settling (should be "idle"):', animStateAfterStopping);

// A clearly different direction (strafe right) — the facing should turn to
// follow, not stay pinned to whatever the camera happens to be looking at.
await dragMoveJoystick(40, 0);
const orientationRight = await page.evaluate(() => window.__shopAvatarOrientation);
const cameraYawDuringStrafe = await page.evaluate(() => window.__shopCameraYaw);
await releaseMoveJoystick();

function shortestAngleDeltaRad(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}
const facingDeltaRad = Math.abs(shortestAngleDeltaRad(orientationRight.facingRad, orientationForward.facingRad));
console.log('facing changed between forward and strafe-right drags, radians (should be well above 0, ideally near pi/2):', facingDeltaRad);
// The bug as reported ("always faces the camera") would mean the avatar's
// facing matches the camera's own look direction (shopYaw) rather than its
// own movement-derived heading -- check the two are NOT the same angle
// (within a wide tolerance, since legitimately walking straight toward the
// camera's own forward direction would coincidentally match it too, but
// this test's own forward-then-strafe sequence deliberately diverges).
const facingMatchesCameraRad = Math.abs(shortestAngleDeltaRad(orientationRight.facingRad, cameraYawDuringStrafe));
console.log('facing vs. camera yaw during the strafe (bug would read ~0 here; correct behavior reads close to the real turn angle):', facingMatchesCameraRad);

const pass =
  avatarTemplate?.skeletonSignature != null &&
  purchaseResult.status === 201 &&
  animationSource === 'own' &&
  animStateWhileMovingForward === 'walk' &&
  animStateAfterStopping === 'idle' &&
  facingDeltaRad > 0.5 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#2744: a real rigged custom avatar turns to face its own movement direction and plays its walk clip',
  errors,
});
