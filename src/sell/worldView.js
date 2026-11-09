// #3295 (leaf 4/6 of #3291, part of #3253; owner decision #3253, "One way to
// move through the world"): Sell mode's in-world view of a seller's products
// uses Shop mode's movement, camera and HUD with the seller's own equipped
// avatar, instead of its own orbit navigation. This module is the whole of
// what Sell adds on top of the shared movement core (src/shop/
// flightMovement.js): the Sell world (the page's products as obstacles, flat
// ground, the page's rectangular ground as the edge), mounting the avatar,
// the per-frame update, and revealing the HUD.
//
// What Sell deliberately does NOT do: no presence report, chat, voice or Shop
// world loading -- those are Shop's world services (updateShopWorldServices),
// which this never calls. Only the movement core runs.
import { scene, registerModeFrameUpdate, registerFacingOverride } from '../world/scene.js';
import { landlet } from '../world/models.js';
import { controls } from '../build/scene.js';
import { currentAuthUser } from '../account/auth.js';
import { fetchMyEquippedAvatar, fetchMyEquippedAnimation } from '../api.js';
import {
  shopAvatarFacing, setShopActive, setShopEquippedAvatarSkeletonSignature,
  shopMoveJoystickEl, shopLookJoystickEl, shopFlyBtn, shopVerticalControlsEl, shopStatusEl,
} from '../main.js';
import {
  shopAvatar, setShopAvatar, createShopAvatar, createCustomShopAvatar,
  shopAvatarHeightM, shopAvatarCollisionHalfM, shopCameraAnchorHeightM,
  resetShopAvatarIdleState,
} from '../shop/avatar.js';
import { disposeObject3D } from '../shop/mode.js';
import {
  updateShopMovementCore, beginShopStanding, isShopStandingSpotBlocked, releaseShopMovementInput,
} from '../shop/flightMovement.js';
import { mountShopAvatar } from '../shop/mountShopAvatar.js';
import { setMovementWorld, createSellMovementWorld } from '../shop/movementWorld.js';
import { sellerShowcaseMeshes, setSellerShowcasePageLoadedListener } from './showcase.js';

// { minX, maxX, minY, maxY } of the current page's ground, or null before the
// first page exists. The showcase ground is the shared `landlet` mesh whose
// geometry loadSellerShowcasePage swaps per page, so its bounding box is the
// walkable area.
let groundBounds = null;
// The seller modal opens over the page on entry and again from "Manage": while
// it is open the HUD is hidden and keyboard movement is off, so typing in the
// modal never walks the avatar.
let modalOpen = true;
let mounted = false;

function refreshGroundBounds() {
  const geometry = landlet.geometry;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  groundBounds = { minX: box.min.x, maxX: box.max.x, minY: box.min.y, maxY: box.max.y };
}

// The first free spot walking in from the front edge of the ground, centre
// first: a page of one product has that product at the middle, so the centre
// of the front strip is the natural start but may be taken by a large
// avatar's footprint.
function pickSpawn() {
  const half = shopAvatarCollisionHalfM() + 0.05;
  const { minX, maxX, minY, maxY } = groundBounds;
  const stepM = 0.25;
  for (let y = minY + half; y <= maxY - half; y += stepM) {
    for (let offset = 0; offset <= (maxX - minX) / 2 - half; offset += stepM) {
      for (const x of offset === 0 ? [0] : [offset, -offset]) {
        if (!isShopStandingSpotBlocked(x, y)) return { x, y };
      }
    }
  }
  // Ground too small or full for the avatar's footprint: the centre still
  // beats no start at all (the core's own boundary clamp keeps it on the page).
  return { x: (minX + maxX) / 2, y: minY + half };
}

// The avatar standing at the start of the page, facing into it (yaw 0 faces
// +y, the way the Shop spawn faces the world centre), camera behind it.
function placeAvatarAtPageStart() {
  if (!mounted) return;
  refreshGroundBounds();
  const { x, y } = pickSpawn();
  beginShopStanding(x, y, 0);
}

function showHud(visible) {
  for (const el of [shopMoveJoystickEl, shopLookJoystickEl, shopFlyBtn, shopVerticalControlsEl]) {
    el.classList.toggle('visible', visible);
  }
}

// Movement input (joysticks, keyboard, fly button) and the HUD are live only
// while the page itself is what the seller is looking at. Driven by the modal's
// own visibility (below), not by each code path that opens it: the modal is
// opened from several places (entry, the Products button, tapping a product on
// the page), and a path that forgot to tell this module would leave the HUD and
// movement keys live underneath it.
function setSellWorldModalOpen(open) {
  modalOpen = open;
  if (!mounted) return;
  // Anything held when the modal opens (a key, a stick) must not stay "down":
  // its release may land on the modal instead of the world.
  if (open) releaseShopMovementInput();
  setShopActive(!open);
  showHud(!open);
}

const sellerModalEl = document.getElementById('seller-modal');
new MutationObserver(() => {
  setSellWorldModalOpen(sellerModalEl.classList.contains('visible'));
}).observe(sellerModalEl, { attributes: true, attributeFilter: ['class'] });

// Enters the Sell world view. Called from enterSellMode once the seller
// identity is confirmed. Re-entrant (a second call re-mounts the avatar).
export async function enterSellWorldView() {
  // Build's orbit camera is replaced by the movement core's follow camera.
  controls.enabled = false;
  document.body.classList.add('sell-world-view'); // lifts the Products button clear of the look joystick
  setMovementWorld(createSellMovementWorld({
    showcaseMeshes: () => sellerShowcaseMeshes,
    groundBounds: () => groundBounds,
  }));
  refreshGroundBounds();
  await mountShopAvatar({ scene, isLoggedIn: Boolean(currentAuthUser) }, {
    fetchMyEquippedAvatar, fetchMyEquippedAnimation,
    setEquippedAvatarSkeletonSignature: setShopEquippedAvatarSkeletonSignature,
    getShopAvatar: () => shopAvatar, setShopAvatar, disposeObject3D,
    createCustomShopAvatar, createShopAvatar,
    shopAvatarHeightM, shopAvatarCollisionHalfM, shopCameraAnchorHeightM,
    resetShopAvatarIdleState,
  });
  mounted = true;
  setSellerShowcasePageLoadedListener(placeAvatarAtPageStart);
  placeAvatarAtPageStart();
  // The movement core only: Shop's world services (presence, chat, voice,
  // landlet loading) are never started in Sell.
  registerModeFrameUpdate((now) => {
    updateShopMovementCore(now);
  });
  registerFacingOverride(() => shopAvatarFacing);
  shopStatusEl.classList.remove('visible');
  setSellWorldModalOpen(modalOpen);
  // e2e-only (same convention as window.__testShopAvatarPosition): lets a test
  // tell the world view is live without reading pixels.
  window.__sellWorldViewActive = () => mounted;
  // e2e-only: the page's walkable bounds, so a test can assert the avatar
  // stays on the page without recomputing the ground.
  window.__sellWorldGroundBounds = () => (groundBounds ? { ...groundBounds } : null);
}
