// #1829: owner report -- "when a flying avatar lands on an object, they
// are unable to walk (though the walking animation happens)." Root cause:
// shopPositionBlocked (src/main.js) excludes an object from its vertical-
// overlap check only when `z > itemZMax` ("flying above it") -- but
// landing on top of an object rests the avatar at exactly `z === itemZMax`
// (shopLandingObstructionTopZ's own clamp), which that strict inequality
// never excludes. The footprint-overlap check then runs against the very
// object the avatar is standing on and reports blocked, for every
// horizontal move attempt at that same z.
//
// Reproducing the real descent-and-land choreography via flight controls
// would be too imprecise to land exactly on `itemZMax` without flaky
// hand-tuned timing -- this instead places a real object (so the bug's own
// exact z boundary is a real, measured value) and drives the exact
// post-landing state and move through the real production functions via
// window.__testTeleportShopAvatar (extended with an optional z) and the
// new window.__testMoveShopAvatarWithCollision/window.__testShopAvatarPosition
// hooks, same "teleport + force the real per-frame logic" convention
// e2e/shop-landlet-instance-leak.test.mjs (#1445/#1479) already established.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Shop Landing Walk Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

// Place a Tree (placeholder-tree, migrations/0001_initial.sql) -- no
// modelUrl, so createMeshForInstance resolves synchronously via the plain-
// box fallback, same reasoning e2e/community-sign-mount-offset.test.mjs's
// own header comment gives for picking this exact template.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

const { landlets } = (await fetchJson('/api/landlets?limit=100')).body;
const myLandlet = landlets.find((l) => l.ownerBuilderId);
const { instances } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const treeInstance = instances.find((i) => i.templateId === 'placeholder-tree');
const { template: treeTemplate } = (await fetchJson('/api/catalog/placeholder-tree')).body;

// mesh.position.x/y are landlet-local (createMeshForInstance sets them
// straight from instance.x/y); worldX/worldY add the landlet's own world
// center, same as shopPositionBlocked's own worldX/worldY computation.
const treeWorldX = myLandlet.center.x + treeInstance.x;
const treeWorldY = myLandlet.center.y + treeInstance.y;
// A freshly placed instance with no explicit z rests at height/2
// (ground-rest convention, per #1594's own comment) -- its top surface
// (itemZMax) is that same value plus another height/2, i.e. the full
// height.
const treeTopZ = treeTemplate.dimensions.height;

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// #1445: a brief real joystick deflection breaks Shop-mode's own
// hands-off spawn orbit, freeing shopAvatarPosition for the teleport hook
// below to actually drive.
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveCenterX, moveCenterY);
await page.mouse.down();
await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

// Teleport onto the landlet's own center first (well within
// SHOP_LOAD_RADIUS_M) and force the load decision so the tree's own mesh
// is actually resolved into shopLandlets before landing exactly on it --
// placeholder-tree's synchronous fallback means no GLTF fetch to race,
// unlike the real-model case e2e/shop-landlet-instance-leak.test.mjs guards.
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y);
  window.__testForceShopProximityCheck();
}, [myLandlet.center.x, myLandlet.center.y]);
await page.waitForTimeout(500);

// Now land exactly on the tree's own top surface -- the precise boundary
// condition the bug is about.
await page.evaluate(([x, y, z]) => {
  window.__testTeleportShopAvatar(x, y, z);
  window.__testForceShopProximityCheck();
}, [treeWorldX, treeWorldY, treeTopZ]);

const positionBeforeMove = await page.evaluate(() => window.__testShopAvatarPosition());

// Drive the exact move moveShopAvatarWithCollision performs each frame
// while the joystick is held -- a small step that stays well within the
// tree's own 1.5m-square footprint (avatar collision half is 0.3m), same
// overlap condition the bug depends on.
await page.evaluate(() => window.__testMoveShopAvatarWithCollision(0.1, 0));

const positionAfterMove = await page.evaluate(() => window.__testShopAvatarPosition());

console.log('tree world position / top surface z:', { treeWorldX, treeWorldY, treeTopZ });
console.log('avatar position right after landing on top of the tree:', positionBeforeMove);
console.log('avatar position after attempting a small horizontal move (x should have advanced by ~0.1, not stayed put):', positionAfterMove);

const pass =
  Math.abs(positionBeforeMove.z - treeTopZ) < 0.001 &&
  Math.abs(positionAfterMove.x - (positionBeforeMove.x + 0.1)) < 0.001 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1829: standing exactly on an object\'s top surface after landing still allows walking',
  errors,
});
