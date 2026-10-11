// #1594: owner report -- a community sign's floating post text rendered
// well above the model it's attached to, not just above its surface.
// rebuildSignSprites (src/main.js) computed each post sprite's z as
// `sign.mesh.position.z + baseHeight + 0.4 + i * 0.5` -- but
// sign.mesh.position.z is the mesh's own vertical *center*, per this
// codebase's ground-rest convention (createMeshForInstance sets
// position.z = height / 2 by default; supportZ/itemZMax elsewhere in
// src/main.js both compute a mesh's top surface the same way, as
// `mesh.position.z + height / 2`). Adding the *full* height instead of
// half overshot the actual top surface by another half-height, so the
// first post sprite (and the fade-in text stack above it) hovered a
// full half-model-height above the sign instead of sitting just above it.
//
// Verifying the real in-world render (rather than just the math in
// isolation) needs the sign to actually enter Shop mode's loaded radius --
// this file's own navigation follows the same teleport-and-force-proximity
// pattern e2e/shop-landlet-instance-leak.test.mjs (#1445/#1479) already
// established for landing deterministically inside SHOP_LOAD_RADIUS_M
// without racing real joystick movement. placeholder-tree has no
// modelUrl (migrations/0001_initial.sql), so this resolves synchronously
// via the plain-box fallback -- no GLTF fetch to race at all.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Community Sign Mount Offset Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

// Place a tree and flag it as a community sign, same setup as
// e2e/community-signs.test.mjs.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);
await page.click('#toggle-community-sign');
await page.waitForTimeout(500);

const { landlets } = (await fetchJson('/api/landlets?limit=100')).body;
const myLandlet = landlets.find((l) => l.ownerBuilderId);
const { instances } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const signInstance = instances.find((i) => i.templateId === 'placeholder-tree');

await fetchJson(`/api/instances/${signInstance.instanceId}/posts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ authorLabel: 'A Shopper', text: 'Love this place!' }),
});

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
// #688/#1175: spawn state isn't settled until enterShopMode's post-fetch
// tail finishes (same wait flight.test.mjs/shop-landlet-instance-leak.test.mjs rely on).
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// #1445: a brief real joystick deflection breaks Shop-mode's own
// hands-off spawn orbit, freeing shopAvatarPosition for the teleport hook
// below to actually drive (see that file's own comment for why a pure
// teleport alone can't out-race the orbit).
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveCenterX, moveCenterY);
await page.mouse.down();
await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

// Teleport (bypassing shopAvatarMaxRadiusM()'s clamp entirely, same as
// #1445's own use of this hook) straight onto the landlet's own center,
// well within SHOP_LOAD_RADIUS_M, and force the load/unload decision to
// land immediately rather than waiting on the next real frame.
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y);
  window.__testForceShopProximityCheck();
}, [myLandlet.center.x, myLandlet.center.y]);

await page.waitForFunction(() => (window.__lastSignSpriteDebug?.spriteZs?.length ?? 0) > 0, { timeout: 10000 });

const debug = await page.evaluate(() => window.__lastSignSpriteDebug);
console.log('sign mesh z / measured height / post sprite z values:', debug);

// meshZ should be the ground-rest center (height / 2) for a freshly
// placed instance with no explicit z. The correct first-post sprite z
// sits meshZ + height/2 (the model's real top surface) + 0.4 above that
// -- the pre-fix code instead landed a full extra height/2 higher
// (meshZ + height + 0.4), which this directly rules out rather than just
// re-deriving the already-fixed formula.
const expectedTopSurfaceZ = debug.meshZ + debug.meshHeight / 2;
const expectedFirstSpriteZ = expectedTopSurfaceZ + 0.4;
const buggyFirstSpriteZ = debug.meshZ + debug.meshHeight + 0.4;
const firstSpriteZ = debug.spriteZs[0];
console.log(`first post sprite z (should be ~${expectedFirstSpriteZ}, just above the real top surface ~${expectedTopSurfaceZ} -- NOT the pre-fix ~${buggyFirstSpriteZ}):`, firstSpriteZ);

const pass =
  Math.abs(firstSpriteZ - expectedFirstSpriteZ) < 0.001 &&
  Math.abs(firstSpriteZ - buggyFirstSpriteZ) > 1 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1594: community-sign post sprites sit just above the model\'s real top surface, not hovering a full extra half-height above it',
  errors,
});
