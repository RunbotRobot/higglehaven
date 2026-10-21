import * as THREE from 'three';
import { LANDLET_SIDE_M } from './state.js';

// #2552 (part of #2504/#2500's src/main.js module split, see #2503's design
// comment for the full dependency map): the Three.js engine primitives
// every mode's scene renders into, plus the one remaining genuinely-shared
// per-frame work (the compass needle + the final render call). Everything
// mode-specific that used to live inside animate()'s own `if (shopActive)
// {...} else {...}` branch is now a single callback each mode's own
// enter*Mode() registers exactly once on entry — see
// registerModeFrameUpdate's own comment below.

export const canvas = document.getElementById('app');

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // flat placeholder sky color

export const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
// Three.js defaults to Y-up, which reads as backwards for a project whose
// ground plane is naturally X/Y (latitude/longitude-shaped) with height as
// the odd one out — Z-up matches that better. OrbitControls (and
// Object3D.lookAt, used just below) both key off `camera.up` rather than
// hard-coding Y, so this is enough to retarget the whole "vertical axis"
// convention with no library patching. It has to happen before
// `new OrbitControls(...)` — OrbitControls reads `object.up` once, at
// construction, to build its internal up-axis-correction quaternion.
camera.up.set(0, 0, 1);
// Positioned up and back so the whole plot is in frame — Build mode's own
// default framing; Shop/Sell/layout-preview each reposition it on entry.
camera.position.set(LANDLET_SIDE_M * 0.6, LANDLET_SIDE_M * 0.6, LANDLET_SIDE_M * 0.5);
camera.lookAt(0, 0, 0);

export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

export function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

// #1169: on-screen compass (Shop and Build modes; hidden in Sell via
// SELL_HIDDEN_BUILDER_UI_IDS, src/main.js). Shop mode tracks a dedicated
// avatar-facing angle (eases toward movement direction rather than
// tracking the camera instantly) and registers it below via
// registerFacingOverride, on entry; Build mode (and layout-preview) has no
// avatar at all, just the free OrbitControls camera, so the default here
// reads its "facing" directly off the camera's own current look direction
// instead. Same single-mutable-slot reasoning as activeModeFrameUpdate
// below: exactly one mode is ever active per page load (mode switches are
// a full page reload — see world/state.js's own currentMode comment), so
// nothing needs to clear this back to null on the way out.
//
// "North" is a convention this codebase never previously defined for its
// world coordinates — inferred from the one existing precedent:
// loadLandletMap's claim-flyover camera (src/main.js) starts south of
// center looking toward +Y, which only reads sensibly if +Y is already
// "up"/North on that map. +X is then East, the only orientation consistent
// with standard map/compass reading once a Z-up world has a chosen North.
// Facing angle 0 means +Y (North); the in-world yaw convention turns a
// positive angle toward -X (see applyShopCameraOrientation's own comment,
// src/main.js), so the clockwise bearing an ordinary compass face uses is
// the negation of that facing angle.
const compassNeedleEl = document.getElementById('compass-needle');
const compassScratchDir = new THREE.Vector3();
let facingOverride = null;
export function registerFacingOverride(getFacingRad) {
  facingOverride = getFacingRad;
}
function currentFacingRad() {
  if (facingOverride) return facingOverride();
  camera.getWorldDirection(compassScratchDir);
  return Math.atan2(-compassScratchDir.x, compassScratchDir.y);
}
function updateCompassNeedle() {
  const bearingDeg = THREE.MathUtils.radToDeg(-currentFacingRad());
  compassNeedleEl.style.transform = `rotate(${bearingDeg}deg)`;
}

let activeModeFrameUpdate = null;
// A single mutable slot, not a registered-callback list: exactly one mode
// is ever active per page load (see the compass comment above), so a
// mode's own enter*Mode() just overwrites whatever the previous page load
// last set, with nothing to unregister on the way out. Shop registers its
// own movement+sky callback; Build (and layout-preview) registers its own
// tween+edge-pan+controls+debug+selection/highlight-tracking callback;
// Sell has no per-frame work of its own (paginated, static between page
// turns) and registers null.
export function registerModeFrameUpdate(fn) {
  activeModeFrameUpdate = fn;
}

export function animate(now) {
  requestAnimationFrame(animate);
  activeModeFrameUpdate?.(now);
  updateCompassNeedle();
  renderer.render(scene, camera);
}
animate(0);
