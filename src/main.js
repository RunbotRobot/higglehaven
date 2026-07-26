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
// Cap zoom-out short of the camera's far clipping plane (below) so the
// landlet can't be zoomed past the point where the camera stops rendering it.
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
const translateControls = new TransformControls(camera, renderer.domElement);
translateControls.setMode('translate');
translateControls.showY = false;
scene.add(translateControls.getHelper());
wireDraggingBehavior(translateControls);
translateControls.addEventListener('objectChange', () => {
  const object = translateControls.object;
  if (!object) return;
  const { x, z } = clampToLandlet(object, object.position.x, object.position.z);
  object.position.x = x;
  object.position.z = z;
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

// OrbitControls panning translates the camera AND its orbit target together
// (that's how it keeps the same view angle while panning). Nothing stops
// the target drifting upward off the ground plane, and once it has, zoom
// (dolly) is zooming toward that floating point instead of the landlet —
// which reads as "stuck", unable to get close to the ground no matter how
// far you zoom in. Re-anchoring target.y to 0 every frame, while shifting
// camera.position.y by the same amount (so the camera doesn't visibly
// jump), keeps the zoom focus pinned to ground level. Revisit this once
// there's anything worth focusing on above/below ground (multi-level
// builds, §1).
function reanchorOrbitTargetToGround() {
  if (controls.target.y === 0) return;
  camera.position.y -= controls.target.y;
  controls.target.y = 0;
}

const cameraDebugEl = document.getElementById('camera-debug');
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

function animate(now) {
  requestAnimationFrame(animate);
  controls.update();
  reanchorOrbitTargetToGround();
  updateCameraDebug(now);
  renderer.render(scene, camera);
}
animate(0);
