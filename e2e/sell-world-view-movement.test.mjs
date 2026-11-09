// #3295 (leaf 4/6 of #3291, part of #3253): Sell mode's in-world view of a
// seller's products uses Shop mode's movement. Once the seller closes the
// product modal they are standing on the showcase page as their avatar, the
// Shop movement HUD is up, keyboard movement walks the avatar with the camera
// following, a showcase product is solid, and the avatar cannot leave the
// page's ground. While the modal is open the HUD is hidden and movement keys do
// nothing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Sell World View Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

// One product: it sits at the centre of the page's ground.
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', 'World View Crate');
await page.fill('#upload-price', '5');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
await page.waitForTimeout(500);

const worldViewActive = await page.evaluate(() => window.__sellWorldViewActive?.() === true);
console.log('Sell world view is live (should be true):', worldViewActive);

const hudSelectors = ['#shop-move-joystick', '#shop-look-joystick', '#shop-fly-btn'];
const hudVisibleWhileModalOpen = await Promise.all(hudSelectors.map((s) => page.locator(s).isVisible()));
console.log('Shop movement HUD visible while the modal is open (should be all false):', hudVisibleWhileModalOpen);

// Movement keys do nothing while the modal is up (typing in it must never walk the avatar).
const posAtModalOpen = await page.evaluate(() => window.__testShopAvatarPosition());
await page.keyboard.down('KeyW');
await page.waitForTimeout(600);
await page.keyboard.up('KeyW');
const posAfterKeyWhileModalOpen = await page.evaluate(() => window.__testShopAvatarPosition());
const movedWhileModalOpen = Math.hypot(
  posAfterKeyWhileModalOpen.x - posAtModalOpen.x,
  posAfterKeyWhileModalOpen.y - posAtModalOpen.y,
) > 0.01;
console.log('avatar moved on a movement key while the modal is open (should be false):', movedWhileModalOpen);

await page.click('#seller-close-btn');
await page.waitForTimeout(800);

const hudVisibleAfterClose = await Promise.all(hudSelectors.map((s) => page.locator(s).isVisible()));
console.log('Shop movement HUD visible once the modal is closed (should be all true):', hudVisibleAfterClose);

const bounds = await page.evaluate(() => window.__sellWorldGroundBounds());
const start = await page.evaluate(() => window.__testShopAvatarPosition());
console.log('ground bounds:', bounds, 'avatar start:', start);
const startsOnGround = bounds &&
  start.x >= bounds.minX && start.x <= bounds.maxX && start.y >= bounds.minY && start.y <= bounds.maxY;
console.log('avatar stands on the page (should be true):', startsOnGround);

// 1) Walk forward into the page, toward the product at its centre: it is
// solid, so the avatar stops in front of it instead of reaching the centre.
const cameraAtStart = await page.evaluate(() => window.__shopFlightCeilingDebug?.cameraRadiusM ?? null);
await page.keyboard.down('KeyW');
await page.waitForTimeout(3000);
await page.keyboard.up('KeyW');
const posBlocked = await page.evaluate(() => window.__testShopAvatarPosition());
const stoppedAtProduct = posBlocked.y < 0;
console.log('avatar stopped at the product instead of walking through it (should be true):', stoppedAtProduct, posBlocked);

// 2) Strafe: the avatar moves on a movement key.
await page.keyboard.down('KeyD');
await page.waitForTimeout(500);
const posStrafing = await page.evaluate(() => window.__testShopAvatarPosition());
const walked = Math.abs(posStrafing.x - posBlocked.x) > 0.2;
console.log('avatar walked on a movement key (should be true):', walked, posStrafing);

// 3) Keep going to the edge: never off the ground.
await page.waitForTimeout(6000);
await page.keyboard.up('KeyD');
const posEdge = await page.evaluate(() => window.__testShopAvatarPosition());
const cameraAtEdge = await page.evaluate(() => window.__shopFlightCeilingDebug?.cameraRadiusM ?? null);
const onGround = (p) => p.x <= bounds.maxX + 0.01 && p.x >= bounds.minX - 0.01 &&
  p.y <= bounds.maxY + 0.01 && p.y >= bounds.minY - 0.01;
const edgeOnGround = onGround(posEdge);
const reachedEdge = posEdge.x > bounds.maxX - 0.5;
console.log('avatar stayed on the page after walking to its edge (should be true):', edgeOnGround, posEdge);
console.log('avatar reached the edge of the page (should be true):', reachedEdge);

// The camera follows the avatar rather than staying where the orbit view had it.
// (A camera pinned to the page centre would read ~0 here; the follow camera trails
// the avatar by several metres, outside the 2.5 m page.)
const cameraFollows = cameraAtStart > 3 && cameraAtEdge > 3;
console.log('camera trails the avatar, well off the page centre (should be > 3 both):', cameraAtStart, cameraAtEdge);

// 4) From the side lane the way past the product is free: walk up the page,
// beyond the product's centre line, and stop at the far edge of the ground.
await page.keyboard.down('KeyW');
await page.waitForTimeout(6000);
await page.keyboard.up('KeyW');
const posFar = await page.evaluate(() => window.__testShopAvatarPosition());
const passedProduct = posFar.y > 0.2;
const farOnGround = onGround(posFar);
console.log('avatar walked past the product along its side (should be true):', passedProduct, posFar);
console.log('avatar stopped at the far edge of the page (should be true):', farOnGround);

// Reopening the modal quiets the HUD again.
await page.click('#seller-showcase-manage-btn');
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
const hudAfterReopen = await Promise.all(hudSelectors.map((s) => page.locator(s).isVisible()));
console.log('HUD hidden again after reopening the modal (should be all false):', hudAfterReopen);

const pass = worldViewActive &&
  hudVisibleWhileModalOpen.every((v) => !v) &&
  !movedWhileModalOpen &&
  hudVisibleAfterClose.every(Boolean) &&
  startsOnGround && stoppedAtProduct && walked && edgeOnGround && reachedEdge && cameraFollows &&
  passedProduct && farOnGround &&
  hudAfterReopen.every((v) => !v) &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#3295: Sell mode world view walks the page with Shop movement, solid product, bounded ground',
  errors,
});
