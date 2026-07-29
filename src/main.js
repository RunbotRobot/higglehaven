import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CATALOG, DEFAULT_INSTANCES } from './catalog.js';
import { loadInstances, saveInstances } from './layoutStorage.js';

// Naming convention (see docs/SPEC.md): plain "a" internally — "landlet", not "lándlet".
// A standard landlet is exactly 1000 m^2. Square footprint for this first pass:
// side length = sqrt(area), giving an edge just over 31.6 meters.
const LANDLET_AREA_M2 = 1000;
const LANDLET_SIDE_M = Math.sqrt(LANDLET_AREA_M2);
// Placeholder buildable volume: a basic single-level landlet, one level
// (10m, per spec §3) straight up, modeled as a plain cuboid rather than the
// spec's actual cone-shaped volume (cross-section changes with distance
// from Earth's center once curvature is modeled). Same simplification as
// using a flat plane instead of a curved one for the ground right now — get
// the mechanic working, model the real geometry later.
const LANDLET_HEIGHT_M = 10;

const canvas = document.getElementById('app');

document.getElementById('build-info').textContent =
  `build ${__BUILD_COMMIT__} · ${__BUILD_TIME__}`;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // flat placeholder sky color

const camera = new THREE.PerspectiveCamera(
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
// Positioned up and back so the whole plot is in frame.
camera.position.set(LANDLET_SIDE_M * 0.6, LANDLET_SIDE_M * 0.6, LANDLET_SIDE_M * 0.5);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

// Dev-only orbit camera so the scene is inspectable on a phone (pinch/drag)
// before any real avatar movement exists. Not part of the in-world control scheme.
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
// Bounds how far a single scroll/pinch tick can move the camera (see the
// dolly-to-truck conversion below) — not an overall travel limit, since
// "zoom" here is really "fly forward/backward" and can cover any distance
// over repeated gestures.
controls.maxDistance = LANDLET_SIDE_M * 5;

// Ground footprint (X/Y) clamped to the landlet's bounds; vertical (Z)
// clamped to the placeholder cuboid volume above — see LANDLET_HEIGHT_M.
function clampToLandlet(mesh, x, y, z) {
  const { width, depth, height } = mesh.userData.template.dimensions;
  const halfSpanX = LANDLET_SIDE_M / 2 - width / 2;
  const halfSpanY = LANDLET_SIDE_M / 2 - depth / 2;
  return {
    x: THREE.MathUtils.clamp(x, -halfSpanX, halfSpanX),
    y: THREE.MathUtils.clamp(y, -halfSpanY, halfSpanY),
    z: THREE.MathUtils.clamp(z, height / 2, LANDLET_HEIGHT_M - height / 2),
  };
}

// Standard Blender/Unity-style transform gizmos (spec §3) for manipulating
// the selected product — one for rotating, one for moving. Handles are
// offset from the object itself specifically so a touch-drag doesn't put
// your finger over the thing you're trying to look at, unlike dragging the
// object's own body directly.
function wireDraggingBehavior(transformControls) {
  transformControls.addEventListener('dragging-changed', (event) => {
    controls.enabled = !event.value;
    if (!event.value) persistLayout();
  });
}

// Rotate: Z (yaw, our vertical axis) only — these are ground-resting items,
// so X/Y tilt handles would just be a way to break them.
const rotateControls = new TransformControls(camera, renderer.domElement);
rotateControls.setMode('rotate');
rotateControls.showX = false;
rotateControls.showY = false;
rotateControls.showXYZE = false;
scene.add(rotateControls.getHelper());
wireDraggingBehavior(rotateControls);

// Move: all three axes — X/Y ground-plane arrows and plane handles, plus a
// Z arrow for vertical placement within the buildable volume
// (LANDLET_HEIGHT_M, clamped in clampToLandlet).
//
// space = 'local' (instead of the default 'world') is what makes moving a
// bookcase along a wall feel natural even when the wall isn't aligned to
// higglehaven's world grid: the handles follow the *object's own* rotation
// (set with the Rotate gizmo) rather than always pointing along world X/Y.
// Rotate the object to match the wall once, and its move handles are then
// "along the wall" / "into the wall" — no need to think in world axes at
// all.
const translateControls = new TransformControls(camera, renderer.domElement);
translateControls.setMode('translate');
translateControls.space = 'local';
scene.add(translateControls.getHelper());
wireDraggingBehavior(translateControls);
translateControls.addEventListener('objectChange', () => {
  const object = translateControls.object;
  if (!object) return;
  const { x, y, z } = clampToLandlet(object, object.position.x, object.position.y, object.position.z);
  object.position.set(x, y, z);
});

const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
sunLight.position.set(20, 10, 30);
scene.add(sunLight);

// PlaneGeometry already lies flat in the XY plane by default — which is
// now our ground plane (Z-up), so unlike before, no rotation is needed.
const landletGeometry = new THREE.PlaneGeometry(LANDLET_SIDE_M, LANDLET_SIDE_M);
// DoubleSide so the plane stays visible from below during dev orbiting;
// the finished game will never let a shopper get under the ground plane.
const landletMaterial = new THREE.MeshStandardMaterial({ color: 0x4caf50, side: THREE.DoubleSide }); // placeholder grass
const landlet = new THREE.Mesh(landletGeometry, landletMaterial);
scene.add(landlet);

function findTemplate(templateId) {
  return CATALOG.find((template) => template.templateId === templateId);
}

// Placeholder products: plain boxes standing in for real 3D models, sized
// and colored per the catalog template each instance references. Resting
// on the ground (z = height / 2) by default since a fresh instance has no
// saved z yet.
//
// BoxGeometry's arguments are always (X-size, Y-size, Z-size) regardless of
// which axis a scene treats as "up" — it has no idea about camera.up. Since
// Z is our vertical axis, `height` (the product's real-world tallness) has
// to go in the third argument, not the second.
function createMeshForInstance(instance) {
  const template = findTemplate(instance.templateId);
  const { width, height, depth } = template.dimensions;
  const geometry = new THREE.BoxGeometry(width, depth, height);
  const material = new THREE.MeshStandardMaterial({ color: template.color });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(instance.x ?? 0, instance.y ?? 0, instance.z ?? height / 2);
  mesh.rotation.z = instance.rotationZ ?? 0;
  mesh.userData.instanceId = instance.id;
  mesh.userData.template = template;
  return mesh;
}

// A previously-saved instance list (builder additions/removals/moves)
// entirely replaces the starter set — not merged with it — since the
// starter set is just a first-visit default, not content to preserve
// alongside whatever the builder has actually done.
const initialInstances = loadInstances() ?? DEFAULT_INSTANCES;
const productMeshes = [];
for (const instance of initialInstances) {
  const mesh = createMeshForInstance(instance);
  scene.add(mesh);
  productMeshes.push(mesh);
}

function persistLayout() {
  const instances = productMeshes.map((mesh) => ({
    id: mesh.userData.instanceId,
    templateId: mesh.userData.template.templateId,
    x: mesh.position.x,
    y: mesh.position.y,
    z: mesh.position.z,
    rotationZ: mesh.rotation.z,
  }));
  saveInstances(instances);
}

let instanceCounter = 0;
function spawnInstance(template) {
  instanceCounter += 1;
  const instance = {
    id: `${template.templateId}-${Date.now()}-${instanceCounter}`,
    templateId: template.templateId,
    // Small random spread near the center so repeated adds don't stack
    // exactly on top of each other; still well within the landlet bounds.
    x: (Math.random() - 0.5) * 6,
    y: (Math.random() - 0.5) * 6,
  };
  const mesh = createMeshForInstance(instance);
  scene.add(mesh);
  productMeshes.push(mesh);
  persistLayout();
  return mesh;
}

function deleteInstance(mesh) {
  const index = productMeshes.indexOf(mesh);
  if (index === -1) return;
  productMeshes.splice(index, 1);
  scene.remove(mesh);
  mesh.geometry.dispose();
  mesh.material.dispose();
  persistLayout();
}

const productInfoEl = document.getElementById('product-info');
const HINT_TEXT = 'Tap a product to inspect it';
productInfoEl.textContent = HINT_TEXT;

// Add-item catalog picker: a toggled panel listing every CATALOG template.
// Tapping one spawns and selects a new instance of it, ready to reposition.
const addItemBtn = document.getElementById('add-item-btn');
const catalogPickerEl = document.getElementById('catalog-picker');
for (const template of CATALOG) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = template.name.replace('Placeholder ', '');
  button.addEventListener('click', () => {
    const mesh = spawnInstance(template);
    catalogPickerEl.classList.remove('visible');
    setSelected(mesh);
  });
  catalogPickerEl.appendChild(button);
}
addItemBtn.addEventListener('click', () => {
  catalogPickerEl.classList.toggle('visible');
});

// Only one gizmo is ever attached at a time. Showing both simultaneously
// was tried first and rejected: the rotate ring and the translate handles
// can occupy the same screen pixels at some angles/zoom levels, and each
// TransformControls instance hit-tests independently, so a single drag
// could trigger both at once (move AND rotate from one gesture). A mode
// toggle — the same convention Blender/Unity use — avoids that outright.
const modeControlsEl = document.getElementById('gizmo-mode-controls');
const modeMoveBtn = document.getElementById('mode-move');
const modeRotateBtn = document.getElementById('mode-rotate');
const deleteBtn = document.getElementById('delete-item');

function setGizmoMode(mode) {
  modeMoveBtn.classList.toggle('active', mode === 'translate');
  modeRotateBtn.classList.toggle('active', mode === 'rotate');
  translateControls.detach();
  rotateControls.detach();
  if (!selectedMesh) return;
  (mode === 'translate' ? translateControls : rotateControls).attach(selectedMesh);
}
modeMoveBtn.addEventListener('click', () => setGizmoMode('translate'));
modeRotateBtn.addEventListener('click', () => setGizmoMode('rotate'));
deleteBtn.addEventListener('click', () => {
  if (!selectedMesh) return;
  const mesh = selectedMesh;
  setSelected(null);
  deleteInstance(mesh);
});

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
let selectedMesh = null;

function setSelected(mesh) {
  if (selectedMesh === mesh) return;
  if (selectedMesh) selectedMesh.material.emissive.setHex(0x000000);
  selectedMesh = mesh;
  if (selectedMesh) {
    selectedMesh.material.emissive.setHex(0x444444);
    productInfoEl.textContent = selectedMesh.userData.template.name;
    modeControlsEl.classList.add('visible');
    setGizmoMode('translate');
  } else {
    productInfoEl.textContent = HINT_TEXT;
    modeControlsEl.classList.remove('visible');
    translateControls.detach();
    rotateControls.detach();
  }
}

function ndcFromEvent(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  return pointerNdc;
}

// The browser's "click" event fires on pointerup as long as press and
// release happened over the same element — it does NOT get suppressed just
// because the pointer moved a lot in between. So an orbit-drag across the
// canvas still fires a click at the release point, which would otherwise
// misread as tapping (or missing) a product. Tracking the press position
// and ignoring clicks that moved more than a few pixels fixes that.
const CLICK_DRAG_THRESHOLD_PX = 8;
let pointerDownPos = null;

renderer.domElement.addEventListener('pointerdown', (event) => {
  pointerDownPos = { x: event.clientX, y: event.clientY };
});

renderer.domElement.addEventListener('click', (event) => {
  if (pointerDownPos) {
    const dx = event.clientX - pointerDownPos.x;
    const dy = event.clientY - pointerDownPos.y;
    if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) return;
  }
  raycaster.setFromCamera(ndcFromEvent(event), camera);
  const hits = raycaster.intersectObjects(productMeshes);
  setSelected(hits.length > 0 ? hits[0].object : null);
});

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

// OrbitControls' native "zoom" (wheel / pinch) is a *dolly*: it changes the
// distance between the camera and a fixed orbit target. That's "zoom to a
// point" — and it has a real failure mode, which is what made zoom feel
// stuck after panning: wherever the target currently sits becomes a wall
// you can approach but never get past. Converting every dolly step into a
// *truck* — moving the camera AND the target forward together, by the same
// amount, along the camera's current view direction — turns "zoom" into
// what it's actually meant to feel like here: flying forward or backward,
// same as e.g. SketchUp's walk tool or a game's fly-camera. There's no
// longer a fixed focus point to get stuck against, since the target is
// continuously redefined as "wherever is dollyDelta ahead of me" rather
// than a stale world-space location.
//
// This only applies with nothing selected, though. With a product selected,
// target gets pinned to it right as a one-finger rotate begins (see below)
// so rotate orbits at the real distance to that product instead of
// whatever radius free-flying left behind — and for the same reason, zoom
// while inspecting a product should be a normal dolly toward/away from it,
// not a truck past it.
//
// This has to hook OrbitControls' own "change" event rather than run once
// per animation frame: wheel/pinch handlers call update() (and dispatch
// "change") synchronously the moment the input event fires, not on the
// next frame — so by the time our own animate() loop calls update(), the
// dolly has already happened and there's nothing left to measure.
let lastKnownDistance = camera.position.distanceTo(controls.target);

// Re-centering on the selected product needs to happen only for an actual
// one-finger rotate — not a two-finger pan, and not the tail end of a pan
// where one finger lifts a moment before the other. Both are harder than
// they sound:
//
// - A two-finger pan's first finger briefly looks identical to a one-finger
//   rotate until the second finger lands and corrects OrbitControls'
//   internal state. Checking controls.state on OrbitControls' "start" event
//   (a first attempt) fires on that first finger and wrongly recenters.
// - Releasing a two-finger pan by lifting one finger before the other hits
//   this same problem from the other end: OrbitControls treats the
//   now-solo remaining finger as if it just started a brand new one-finger
//   rotate (see its onPointerUp, case 1 — "minimal placeholder event -
//   allows state correction on pointer-up"), and dispatches a fresh "start"
//   for it. If we're listening for "start" at all, this false-restart
//   retargets right as you're trying to let go of a pan.
//
// Both are solved by arming the check ourselves, only on a genuine new
// press (our own tracked pointer count going 0 -> 1) rather than on
// OrbitControls' "start" event — that reclassification-on-release never
// fires a pointerdown, so it can't trigger this. We still wait for the
// first "change" event to actually read controls.state, since a real
// two-finger gesture's second finger lands (correcting the state) before
// any meaningful movement happens in practice.
//
// ROTATE (mouse) = 0, TOUCH_ROTATE = 1 finger = 3: OrbitControls' state
// enum isn't exported, so these are hardcoded from its source (pinned
// three version, see package.json) — see _STATE in OrbitControls.js.
const ROTATE_STATE = 0;
const TOUCH_ROTATE_STATE = 3;
let pendingGestureCheck = false;
let activePointerCount = 0;
renderer.domElement.addEventListener('pointerdown', () => {
  activePointerCount++;
  if (activePointerCount === 1) {
    pendingGestureCheck = true;
  }
});
window.addEventListener('pointerup', () => {
  activePointerCount = Math.max(0, activePointerCount - 1);
});
window.addEventListener('pointercancel', () => {
  activePointerCount = Math.max(0, activePointerCount - 1);
});

// Re-centering used to jump straight to the product's position the instant
// it was triggered. Easing it in over a short tween instead — nudging
// target toward the product a little each frame rather than all at once —
// reads as a deliberate part of the rotate gesture instead of a jump cut.
const TARGET_TWEEN_DURATION_MS = 250;
const targetTween = {
  active: false,
  from: new THREE.Vector3(),
  to: new THREE.Vector3(),
  startTime: 0,
};

function beginTargetTween(destination) {
  targetTween.active = true;
  targetTween.from.copy(controls.target);
  targetTween.to.copy(destination);
  targetTween.startTime = performance.now();
}

function updateTargetTween(now) {
  if (!targetTween.active) return;
  const t = Math.min((now - targetTween.startTime) / TARGET_TWEEN_DURATION_MS, 1);
  const eased = t * t * (3 - 2 * t); // smoothstep
  controls.target.lerpVectors(targetTween.from, targetTween.to, eased);
  if (t >= 1) targetTween.active = false;
}

controls.addEventListener('change', () => {
  if (pendingGestureCheck) {
    pendingGestureCheck = false;
    const isRotate = controls.state === ROTATE_STATE || controls.state === TOUCH_ROTATE_STATE;
    if (isRotate && selectedMesh) {
      beginTargetTween(selectedMesh.position);
    }
  }

  const newDistance = camera.position.distanceTo(controls.target);
  if (!selectedMesh) {
    const dollyDelta = lastKnownDistance - newDistance;
    if (Math.abs(dollyDelta) > 1e-6) {
      camera.getWorldDirection(cameraDirection);
      controls.target.addScaledVector(cameraDirection, dollyDelta);
    }
  }
  lastKnownDistance = camera.position.distanceTo(controls.target);
});

const cameraDebugEl = document.getElementById('camera-debug');
const cameraDebugCopyBtn = document.getElementById('camera-debug-copy');
const cameraDirection = new THREE.Vector3();
let lastDebugUpdate = 0;

function updateCameraDebug(now) {
  if (now - lastDebugUpdate < 200) return;
  lastDebugUpdate = now;
  camera.getWorldDirection(cameraDirection);
  const fmt = (v) => v.toFixed(2);
  cameraDebugEl.textContent =
    `cam  ${fmt(camera.position.x)}, ${fmt(camera.position.y)}, ${fmt(camera.position.z)}\n` +
    `tgt  ${fmt(controls.target.x)}, ${fmt(controls.target.y)}, ${fmt(controls.target.z)}\n` +
    `dir  ${fmt(cameraDirection.x)}, ${fmt(cameraDirection.y)}, ${fmt(cameraDirection.z)}`;
}

cameraDebugCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(cameraDebugEl.textContent);
    cameraDebugCopyBtn.textContent = 'Copied!';
  } catch {
    cameraDebugCopyBtn.textContent = "Couldn't copy";
  }
  setTimeout(() => {
    cameraDebugCopyBtn.textContent = 'Copy';
  }, 1200);
});

// Auto-pan the camera while dragging a product near a screen edge, so it
// can be moved further than what's currently in view — same idea as
// Figma/Slides' edge-scrolling. Only while the move gizmo itself is being
// dragged (not for camera rotate/pan), and driven every frame (not just on
// pointermove) so holding still right at the edge keeps panning.
const EDGE_PAN_ZONE_PX = 60;
const EDGE_PAN_SPEED_PX = 14;
let lastPointerClientPos = null;
window.addEventListener('pointermove', (event) => {
  lastPointerClientPos = { x: event.clientX, y: event.clientY };
});

// Standard perspective-camera screen-space pan math (same formula
// OrbitControls itself uses internally): scaling by the target's distance
// and tan(fov/2) makes a given pixel amount correspond to a consistent
// screen-space shift regardless of current zoom.
function panCameraByScreenPixels(dxPixels, dyPixels) {
  const targetDistance =
    camera.position.distanceTo(controls.target) * Math.tan((camera.fov / 2) * (Math.PI / 180));
  const scale = (2 * targetDistance) / renderer.domElement.clientHeight;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
  const offset = new THREE.Vector3()
    .addScaledVector(right, dxPixels * scale)
    .addScaledVector(up, dyPixels * scale);
  camera.position.add(offset);
  controls.target.add(offset);
}

function edgeStrength(distanceFromEdge) {
  if (distanceFromEdge >= EDGE_PAN_ZONE_PX) return 0;
  return 1 - Math.max(distanceFromEdge, 0) / EDGE_PAN_ZONE_PX;
}

function applyEdgePanWhileDraggingProduct() {
  if (!translateControls.dragging || !lastPointerClientPos) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const { x, y } = lastPointerClientPos;

  const rightStrength = edgeStrength(rect.right - x);
  const leftStrength = edgeStrength(x - rect.left);
  const topStrength = edgeStrength(y - rect.top);
  const bottomStrength = edgeStrength(rect.bottom - y);

  const dx = (rightStrength - leftStrength) * EDGE_PAN_SPEED_PX;
  const dy = (topStrength - bottomStrength) * EDGE_PAN_SPEED_PX;
  if (dx !== 0 || dy !== 0) {
    panCameraByScreenPixels(dx, dy);
  }
}

function animate(now) {
  requestAnimationFrame(animate);
  updateTargetTween(now);
  applyEdgePanWhileDraggingProduct();
  controls.update();
  updateCameraDebug(now);
  renderer.render(scene, camera);
}
animate(0);
