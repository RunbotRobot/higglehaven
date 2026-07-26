import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { PRODUCTS } from './products.js';
import { loadLayout, saveLayout } from './layoutStorage.js';

// Naming convention (see docs/SPEC.md): plain "a" internally — "landlet", not "lándlet".
// A standard landlet is exactly 1000 m^2. Square footprint for this first pass:
// side length = sqrt(area), giving an edge just over 31.6 meters.
const LANDLET_AREA_M2 = 1000;
const LANDLET_SIDE_M = Math.sqrt(LANDLET_AREA_M2);

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
// Positioned up and back so the whole plot is in frame; Three.js is Y-up.
camera.position.set(LANDLET_SIDE_M * 0.6, LANDLET_SIDE_M * 0.5, LANDLET_SIDE_M * 0.6);
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

function clampToLandlet(mesh, x, z) {
  const { width, depth } = mesh.userData.product.dimensions;
  const halfSpanX = LANDLET_SIDE_M / 2 - width / 2;
  const halfSpanZ = LANDLET_SIDE_M / 2 - depth / 2;
  return {
    x: THREE.MathUtils.clamp(x, -halfSpanX, halfSpanX),
    z: THREE.MathUtils.clamp(z, -halfSpanZ, halfSpanZ),
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

// Rotate: Y (yaw) axis only — these are ground-resting items, so X/Z tilt
// handles would just be a way to break them.
const rotateControls = new TransformControls(camera, renderer.domElement);
rotateControls.setMode('rotate');
rotateControls.showX = false;
rotateControls.showZ = false;
rotateControls.showXYZE = false;
scene.add(rotateControls.getHelper());
wireDraggingBehavior(rotateControls);

// Move: X/Z (ground plane) only — no vertical placement yet. Setting
// showY = false also hides the XY/YZ plane handles (their names contain
// "Y"), leaving the X arrow, Z arrow, and the XZ plane square.
//
// space = 'local' (instead of the default 'world') is what makes moving a
// bookcase along a wall feel natural even when the wall isn't aligned to
// higglehaven's world grid: the handles follow the *object's own* rotation
// (set with the Rotate gizmo) rather than always pointing along world X/Z.
// Rotate the object to match the wall once, and its move handles are then
// "along the wall" / "into the wall" — no need to think in world axes at
// all.
const translateControls = new TransformControls(camera, renderer.domElement);
translateControls.setMode('translate');
translateControls.showY = false;
translateControls.space = 'local';
scene.add(translateControls.getHelper());
wireDraggingBehavior(translateControls);
translateControls.addEventListener('objectChange', () => {
  const object = translateControls.object;
  if (!object) return;
  const { x, z } = clampToLandlet(object, object.position.x, object.position.z);
  object.position.x = x;
  object.position.z = z;
  // Keep orbit centered on the product as it's dragged, not wherever it
  // started before the move.
  controls.target.copy(object.position);
});

const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
sunLight.position.set(20, 30, 10);
scene.add(sunLight);

// PlaneGeometry is built flat in the XY plane by default; rotating -90 deg
// around X lays it down onto the XZ ground plane (Y = up).
const landletGeometry = new THREE.PlaneGeometry(LANDLET_SIDE_M, LANDLET_SIDE_M);
// DoubleSide so the plane stays visible from below during dev orbiting;
// the finished game will never let a shopper get under the ground plane.
const landletMaterial = new THREE.MeshStandardMaterial({ color: 0x4caf50, side: THREE.DoubleSide }); // placeholder grass
const landlet = new THREE.Mesh(landletGeometry, landletMaterial);
landlet.rotation.x = -Math.PI / 2;
scene.add(landlet);

// Placeholder products: plain boxes standing in for real 3D models, sized
// and colored per the dummy data in products.js. Resting on the ground
// (y = height / 2) since there's no builder tool yet to place them otherwise.
// A saved layout (from a previous drag) overrides the default position.
const savedLayout = loadLayout();
const productMeshes = [];
for (const product of PRODUCTS) {
  const { width, height, depth } = product.dimensions;
  const saved = savedLayout[product.id];
  const x = saved ? saved.x : product.position.x;
  const z = saved ? saved.z : product.position.z;
  const geometry = new THREE.BoxGeometry(width, height, depth);
  const material = new THREE.MeshStandardMaterial({ color: product.color });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, height / 2, z);
  // Nullish, not a plain ternary on `saved` — a layout saved before rotation
  // existed has no rotationY field, which must fall back to 0 rather than
  // becoming NaN.
  mesh.rotation.y = saved?.rotationY ?? 0;
  mesh.userData.product = product;
  scene.add(mesh);
  productMeshes.push(mesh);
}

function persistLayout() {
  const positionsById = {};
  for (const mesh of productMeshes) {
    positionsById[mesh.userData.product.id] = {
      x: mesh.position.x,
      z: mesh.position.z,
      rotationY: mesh.rotation.y,
    };
  }
  saveLayout(positionsById);
}

const productInfoEl = document.getElementById('product-info');
const HINT_TEXT = 'Tap a product to inspect it';
productInfoEl.textContent = HINT_TEXT;

// Only one gizmo is ever attached at a time. Showing both simultaneously
// was tried first and rejected: the rotate ring and the translate handles
// can occupy the same screen pixels at some angles/zoom levels, and each
// TransformControls instance hit-tests independently, so a single drag
// could trigger both at once (move AND rotate from one gesture). A mode
// toggle — the same convention Blender/Unity use — avoids that outright.
const modeControlsEl = document.getElementById('gizmo-mode-controls');
const modeMoveBtn = document.getElementById('mode-move');
const modeRotateBtn = document.getElementById('mode-rotate');

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

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
let selectedMesh = null;

function setSelected(mesh) {
  if (selectedMesh === mesh) return;
  if (selectedMesh) selectedMesh.material.emissive.setHex(0x000000);
  selectedMesh = mesh;
  if (selectedMesh) {
    selectedMesh.material.emissive.setHex(0x444444);
    productInfoEl.textContent = selectedMesh.userData.product.name;
    modeControlsEl.classList.add('visible');
    setGizmoMode('translate');
    // Re-center orbit on the selected product, at whatever the *actual*
    // current camera distance to it is — otherwise one-finger rotate keeps
    // swinging at whatever radius the view happened to have before
    // selecting anything, which feels enormous once you've flown in close.
    controls.target.copy(selectedMesh.position);
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
// target is pinned to *it* (see setSelected / the translate objectChange
// handler above) specifically so one-finger rotate orbits at the real
// distance to that product instead of whatever radius free-flying left
// behind — and for the same reason, zoom while inspecting a product should
// be a normal dolly toward/away from it, not a truck past it.
//
// This has to hook OrbitControls' own "change" event rather than run once
// per animation frame: wheel/pinch handlers call update() (and dispatch
// "change") synchronously the moment the input event fires, not on the
// next frame — so by the time our own animate() loop calls update(), the
// dolly has already happened and there's nothing left to measure.
let lastKnownDistance = camera.position.distanceTo(controls.target);
controls.addEventListener('change', () => {
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

function animate(now) {
  requestAnimationFrame(animate);
  controls.update();
  updateCameraDebug(now);
  renderer.render(scene, camera);
}
animate(0);
