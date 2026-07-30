import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CATALOG as FALLBACK_CATALOG, DEFAULT_INSTANCES } from './catalog.js';
import { loadInstances, saveInstances } from './layoutStorage.js';
import {
  fetchCatalog,
  fetchInstances,
  createInstanceRemote,
  updateInstanceRemote,
  deleteInstanceRemote,
  uploadModelFile,
  createCatalogTemplate,
} from './api.js';
import { optimizeModelFile } from './modelOptimizer.js';

// The API (worker/index.js + D1) is authoritative when reachable; the
// catalog.js constants above are only used if fetching it fails. This is
// reassigned once, in bootstrap() below, before anything reads it — every
// other reference to the catalog goes through this variable rather than
// FALLBACK_CATALOG directly.
let activeCatalog = FALLBACK_CATALOG;

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

// Every product's *collision* footprint is a simple box (see dimensions on
// its catalog template), independent of whatever its actual visual model
// looks like — same separation most engines keep between a render mesh and
// a simpler collision shape. Nothing stops one box from sliding straight
// through another vertically (a lamp dragged over a table just clips into
// it) unless we check for that ourselves. The fix:
// treat every other product as a potential support surface. A dragged
// object's footprint (its X/Y rectangle, rotated by rotationZ) is tested
// for overlap against every other product's footprint; wherever they
// overlap, the dragged object can't rest any lower than that product's top
// surface. clampToLandlet folds this in as the *minimum* z it clamps to —
// it only ever pushes an object up onto something, never pulls it down, so
// lifting an object off a shelf and setting it back on the ground still
// works normally.
//
// Rectangle-vs-rectangle overlap (rather than a simpler bounding-circle
// check) matters here because a bounding circle would over-approximate a
// long, thin object like a table and trigger "resting" for things nowhere
// near its actual top — e.g. a lamp near the table's leg, at floor level,
// popping up onto the tabletop just for being within the table's diagonal
// radius. The standard fix for two arbitrarily-rotated rectangles is the
// separating axis theorem (SAT): project both onto each rectangle's own
// two edge directions (4 axes total, since opposite edges are parallel)
// and check for a gap on any of them — if every axis shows overlap, the
// rectangles truly intersect.
//
// Only rotation.z (yaw) factors in here, even though the rotate gizmo now
// allows tilting on any axis (see rotateControls below) — a fully tilted
// footprint would need real 3D OBB math, not a flat rotated rectangle.
// Deliberately left as this simpler approximation for now: the main
// reason to tilt a product is correcting an off-level scan back toward
// upright, not building on a deliberately tilted footprint.
function footprintCorners(mesh, x, y) {
  const { width, depth } = mesh.userData.template.dimensions;
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const cos = Math.cos(mesh.rotation.z);
  const sin = Math.sin(mesh.rotation.z);
  return [
    [halfWidth, halfDepth],
    [halfWidth, -halfDepth],
    [-halfWidth, -halfDepth],
    [-halfWidth, halfDepth],
  ].map(([localX, localY]) => [
    x + localX * cos - localY * sin,
    y + localX * sin + localY * cos,
  ]);
}

function footprintsOverlap(cornersA, cornersB) {
  const axes = [
    [cornersA[0][0] - cornersA[1][0], cornersA[0][1] - cornersA[1][1]],
    [cornersA[1][0] - cornersA[2][0], cornersA[1][1] - cornersA[2][1]],
    [cornersB[0][0] - cornersB[1][0], cornersB[0][1] - cornersB[1][1]],
    [cornersB[1][0] - cornersB[2][0], cornersB[1][1] - cornersB[2][1]],
  ];
  for (const [ax, ay] of axes) {
    const project = (corners) => {
      let min = Infinity;
      let max = -Infinity;
      for (const [cx, cy] of corners) {
        const dot = cx * ax + cy * ay;
        min = Math.min(min, dot);
        max = Math.max(max, dot);
      }
      return [min, max];
    };
    const [minA, maxA] = project(cornersA);
    const [minB, maxB] = project(cornersB);
    if (maxA < minB || maxB < minA) return false; // gap found along this axis
  }
  return true;
}

function boxesOverlap3D(mesh, x, y, z, other) {
  if (!footprintsOverlap(footprintCorners(mesh, x, y), footprintCorners(other, other.position.x, other.position.y))) {
    return false;
  }
  const height = mesh.userData.template.dimensions.height;
  const otherHeight = other.userData.template.dimensions.height;
  const zMinA = z - height / 2;
  const zMaxA = z + height / 2;
  const zMinB = other.position.z - otherHeight / 2;
  const zMaxB = other.position.z + otherHeight / 2;
  return !(zMaxA < zMinB || zMaxB < zMinA);
}

function collidesWithAny(mesh, x, y, z) {
  for (const other of productMeshes) {
    if (other === mesh) continue;
    if (boxesOverlap3D(mesh, x, y, z, other)) return true;
  }
  return false;
}

// Toggled by the "Snap" button (see gizmo-mode-controls wiring below). On
// by default; switching it off lets the selected product overlap others
// freely, for the rare case a builder actually wants that (a sign embedded
// in a wall, a rug under a table leg, ...) instead of colliding with them.
let snapToSurfaces = true;

// Resolves motion along a single axis, using `safeVal` (assumed to already
// be collision-free) as the search origin and `buildPos(v)` to fill in the
// other two, fixed coordinates. If moving all the way to `candidateVal`
// doesn't collide, the full move is allowed; otherwise binary-searches the
// segment between the two for the exact point contact begins.
//
// A first attempt at collision resolution compared *penetration depth*
// across all axes at once (a standard SAT/MTV technique) and always pushed
// out along whichever was shallowest. That mishandled the very case this
// was built for: a small item's footprint fully contained within a larger
// surface's (a lamp centered on a table) has a *shallow* horizontal
// containment depth (the lamp's own small width) versus a much *deeper*
// vertical one (the table's height) — so depth-comparison alone shoved it
// sideways off the table instead of resting it on top. Resolving strictly
// along whichever axis is actually being dragged sidesteps that ambiguity
// entirely: moving the Z arrow only ever resolves in Z (rests on top),
// moving an X/Y arrow only ever resolves in X/Y (stops flush against a
// side) — same principle Minecraft-style engines use for axis-separated
// collision.
function sweepAxis(mesh, buildPos, safeVal, candidateVal) {
  if (candidateVal === safeVal) return safeVal;
  const [cx, cy, cz] = buildPos(candidateVal);
  if (!collidesWithAny(mesh, cx, cy, cz)) return candidateVal;
  let lo = safeVal;
  let hi = candidateVal;
  for (let i = 0; i < 25; i++) {
    const mid = (lo + hi) / 2;
    const [mx, my, mz] = buildPos(mid);
    if (collidesWithAny(mesh, mx, my, mz)) hi = mid;
    else lo = mid;
  }
  return lo;
}

// Resolves a requested move from `safe` (mesh's last known collision-free
// position) toward `requested`, one axis at a time (X, then Y, then Z) so
// combined diagonal motion (e.g. a plane handle) still stops correctly
// against whatever it meets along the way.
function resolveByAxis(mesh, safe, requested) {
  const x = sweepAxis(mesh, (v) => [v, safe.y, safe.z], safe.x, requested.x);
  const y = sweepAxis(mesh, (v) => [x, v, safe.z], safe.y, requested.y);
  const z = sweepAxis(mesh, (v) => [x, y, v], safe.z, requested.z);
  return { x, y, z };
}

// Ground footprint (X/Y) clamped to the landlet's bounds; vertical (Z)
// clamped between the ground and the placeholder cuboid volume's ceiling —
// see LANDLET_HEIGHT_M. Collision with other products (resolveByAxis,
// above) is applied separately, after this.
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
    if (!event.value) {
      persistLayout();
      if (transformControls.object) syncUpdate(transformControls.object);
    }
  });
}

// Rotate: all three axes. Originally Z (yaw) only, on the assumption
// these are ground-resting items where X/Y tilt would just be a way to
// break them — but a real uploaded scan isn't guaranteed to have been
// captured level/upright (a real RealityScan brick scan came out tilted),
// so a builder needs to be able to correct that on any axis, not just
// spin the product in place.
const rotateControls = new TransformControls(camera, renderer.domElement);
rotateControls.setMode('rotate');
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
// resolveByAxis needs a known-good starting point to sweep from — captured
// fresh at the start of every drag, since the object's position right
// before a drag begins is by definition already collision-free.
translateControls.addEventListener('dragging-changed', (event) => {
  if (event.value && translateControls.object) {
    translateControls.object.userData.safePosition = translateControls.object.position.clone();
  }
});
translateControls.addEventListener('objectChange', () => {
  const object = translateControls.object;
  if (!object) return;
  const requested = clampToLandlet(object, object.position.x, object.position.y, object.position.z);
  let resolved = requested;
  if (snapToSurfaces) {
    const safe = object.userData.safePosition ?? object.position;
    resolved = resolveByAxis(object, safe, requested);
  }
  object.userData.safePosition = new THREE.Vector3(resolved.x, resolved.y, resolved.z);
  object.position.set(resolved.x, resolved.y, resolved.z);
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
  return activeCatalog.find((template) => template.templateId === templateId);
}

// Real product models (glTF/.glb — see public/models/ and catalog.js's
// modelUrl fields), not a generic box standing in for every product.
// Loaded once per URL and cached; every placed instance after the first
// gets a clone of the cached scene instead of re-fetching/re-parsing it.
const gltfLoader = new GLTFLoader();
const modelSceneCache = new Map(); // modelUrl -> Promise<THREE.Object3D> (uncloned)

function loadModelScene(url) {
  if (!modelSceneCache.has(url)) {
    modelSceneCache.set(url, gltfLoader.loadAsync(url).then((gltf) => gltf.scene));
  }
  return modelSceneCache.get(url);
}

// glTF is authored Y-up by convention (whatever tool exported it — Blender,
// etc.) — our scene is Z-up (see camera.up.set above), and nothing about
// loading a glTF file auto-corrects that; the raw vertex data just gets
// used as-is. Wrapping the loaded scene in a container and rotating *that
// inner copy* +90 degrees about X converts "up" from the model's Y to the
// container's Z, so the container's own position/rotation.z then behaves
// exactly like every other product's. This is the real correction any
// future genuine seller-uploaded model will also need, not a shortcut
// specific to these placeholder assets — which is why the placeholder
// models here are deliberately authored in standard Y-up space rather than
// pre-rotated to dodge it.
async function loadModelInstance(url) {
  const cachedScene = await loadModelScene(url);
  const model = cachedScene.clone();
  // Object3D.clone() shares materials/geometries by reference. Geometry
  // being shared is fine (read-only), but materials need independent
  // copies per instance so a future per-material tweak on one placed
  // instance (recoloring, damage states, etc.) can't leak into every other
  // instance sharing the same cached material.
  model.traverse((child) => {
    if (child.isMesh) {
      child.material = Array.isArray(child.material)
        ? child.material.map((material) => material.clone())
        : child.material.clone();
    }
  });
  model.rotation.x = Math.PI / 2;

  // Every placeholder model in this file is deliberately authored centered
  // on its own local origin, so "z = height / 2 rests it on the ground"
  // (see createMeshForInstance) holds by construction. A real uploaded
  // model can't be trusted to follow that convention — RealityScan (and
  // photogrammetry tools generally) keep whatever pivot the original
  // capture volume had, which does not move back to the geometry's center
  // after cropping away part of a scan. An uncentered model was exactly
  // this: cropping ~1.5in off the bottom of a 3in scan left the remaining
  // geometry sitting off-center relative to its own origin, so the
  // declared (correctly measured) height was right but the visual mesh
  // rendered shifted from where the collision system placed it — the
  // brick appeared to float exactly by the cropped-away amount whenever
  // Snap rested it on the ground. Recentering here, once per loaded
  // instance, makes the convention hold for any model regardless of the
  // source tool's own pivot.
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);

  const container = new THREE.Group();
  container.add(model);
  return container;
}

// Builds the Object3D for a placed instance: its catalog template's real
// model if it has one, falling back to a colored box (still used by any
// template without a model yet, and if a model fails to load). Resting on
// the ground (z = height / 2) by default since a fresh instance has no
// saved z yet.
//
// BoxGeometry's arguments are always (X-size, Y-size, Z-size) regardless of
// which axis a scene treats as "up" — it has no idea about camera.up. Since
// Z is our vertical axis, `height` (the product's real-world tallness) has
// to go in the third argument, not the second.
async function createMeshForInstance(instance) {
  const template = findTemplate(instance.templateId);
  if (!template) {
    // Catalog and instance list came from different sources (e.g. one
    // fetched from the API, the other loaded from a stale local cache) and
    // disagree on templateIds. bootstrap() below fetches both together
    // specifically to avoid this, but a defensive skip here is cheap
    // insurance against crashing the whole scene over one bad instance.
    console.warn(`No catalog template "${instance.templateId}" — skipping instance ${instance.instanceId ?? instance.id}`);
    return null;
  }
  const { width, height, depth } = template.dimensions;
  let object;
  if (template.modelUrl) {
    try {
      object = await loadModelInstance(template.modelUrl);
    } catch (err) {
      console.warn(`Failed to load model for "${template.templateId}" (${template.modelUrl}), falling back to a colored box:`, err);
    }
  }
  if (!object) {
    const geometry = new THREE.BoxGeometry(width, depth, height);
    const material = new THREE.MeshStandardMaterial({ color: template.color });
    object = new THREE.Mesh(geometry, material);
  }
  object.position.set(instance.x ?? 0, instance.y ?? 0, instance.z ?? height / 2);
  object.rotation.set(instance.rotationX ?? 0, instance.rotationY ?? 0, instance.rotationZ ?? 0);
  object.userData.instanceId = instance.instanceId ?? instance.id;
  object.userData.template = template;
  return object;
}

// Populated by bootstrap() once instance data (API or fallback) is
// available. Declared here, empty, so everything below that references it
// — the click/raycast handler in particular — can be wired up immediately;
// none of that code runs until the user actually interacts, by which point
// bootstrap() has long since filled it in.
const productMeshes = [];

async function addInstanceToScene(instance) {
  const object = await createMeshForInstance(instance);
  if (!object) return null;
  scene.add(object);
  productMeshes.push(object);
  return object;
}

function persistLayout() {
  const instances = productMeshes.map((mesh) => ({
    id: mesh.userData.instanceId,
    templateId: mesh.userData.template.templateId,
    x: mesh.position.x,
    y: mesh.position.y,
    z: mesh.position.z,
    rotationX: mesh.rotation.x,
    rotationY: mesh.rotation.y,
    rotationZ: mesh.rotation.z,
  }));
  saveInstances(instances);
}

// Best-effort sync to the backend: every call here is fire-and-forget and
// swallows its own errors. persistLayout()'s localStorage write is the
// source of truth the app can always rely on; these just try to keep the
// server copy current so a reload (or another device, eventually) sees the
// same layout. A failure here never blocks or rolls back the local change.
function instanceFromMesh(mesh) {
  return {
    instanceId: mesh.userData.instanceId,
    templateId: mesh.userData.template.templateId,
    x: mesh.position.x,
    y: mesh.position.y,
    z: mesh.position.z,
    rotationX: mesh.rotation.x,
    rotationY: mesh.rotation.y,
    rotationZ: mesh.rotation.z,
  };
}

async function syncCreate(mesh) {
  try {
    await createInstanceRemote(instanceFromMesh(mesh));
  } catch (err) {
    console.warn('Failed to sync new instance to backend:', err);
  }
}

async function syncUpdate(mesh) {
  try {
    const { instanceId, ...patch } = instanceFromMesh(mesh);
    await updateInstanceRemote(instanceId, patch);
  } catch (err) {
    console.warn('Failed to sync instance update to backend:', err);
  }
}

async function syncDelete(instanceId) {
  try {
    await deleteInstanceRemote(instanceId);
  } catch (err) {
    console.warn('Failed to sync instance delete to backend:', err);
  }
}

// Places a fresh instance at an exact spot — the world position the
// builder just tapped (see handlePlacementClick) — rather than a random
// offset near the center that then has to be dragged into place.
let instanceCounter = 0;
async function spawnInstanceAt(template, x, y, z, rotation = {}) {
  instanceCounter += 1;
  const instance = {
    instanceId: `${template.templateId}-${Date.now()}-${instanceCounter}`,
    templateId: template.templateId,
    x,
    y,
    z,
    rotationX: rotation.rotationX ?? 0,
    rotationY: rotation.rotationY ?? 0,
    rotationZ: rotation.rotationZ ?? 0,
  };
  const mesh = await addInstanceToScene(instance);
  if (!mesh) return null;
  const clamped = clampToLandlet(mesh, mesh.position.x, mesh.position.y, mesh.position.z);
  mesh.position.set(clamped.x, clamped.y, clamped.z);
  mesh.userData.safePosition = mesh.position.clone();
  persistLayout();
  syncCreate(mesh);
  return mesh;
}

// A product's Object3D might be a single Mesh (the box fallback) or a
// Group wrapping a loaded model's own node hierarchy — traverse either way
// rather than assuming a flat single-mesh shape, since a real seller-
// uploaded model could have any number of parts/materials.
function disposeObject(object) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material.dispose();
  });
}

function deleteInstance(mesh) {
  const index = productMeshes.indexOf(mesh);
  if (index === -1) return;
  const instanceId = mesh.userData.instanceId;
  productMeshes.splice(index, 1);
  scene.remove(mesh);
  disposeObject(mesh);
  persistLayout();
  syncDelete(instanceId);
}

const productInfoEl = document.getElementById('product-info');
const HINT_TEXT = 'Tap a product to inspect it';
productInfoEl.textContent = HINT_TEXT;

// Add-item catalog picker: a toggled panel listing every activeCatalog
// template. Tapping one doesn't place anything yet — it arms placement
// mode (see enterPlacementMode) so the next tap in the world, wherever
// that is, is where the item actually goes. Buttons are (re)built in
// bootstrap() once activeCatalog is settled, since the API's catalog
// isn't known until that fetch resolves.
const addItemBtn = document.getElementById('add-item-btn');
const catalogPickerEl = document.getElementById('catalog-picker');

function buildCatalogPickerButtons() {
  catalogPickerEl.replaceChildren();
  for (const template of activeCatalog) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = template.name;
    button.addEventListener('click', () => {
      catalogPickerEl.classList.remove('visible');
      enterPlacementMode({ type: 'template', template }, `Tap a spot to place ${template.name}`);
    });
    catalogPickerEl.appendChild(button);
  }
}
addItemBtn.addEventListener('click', () => {
  if (pendingPlacement) {
    cancelPlacementMode();
    return;
  }
  catalogPickerEl.classList.toggle('visible');
});

// Custom product upload: a builder's own model (photogrammetry scan,
// etc.) becomes a real catalog_templates row via two independent backend
// calls — POST /api/models to get bytes into storage and back a modelUrl,
// then the ordinary POST /api/catalog to register a product using it.
// This only works with the real backend reachable — creating a new
// persistent catalog entry has nowhere to live in offline/fallback mode,
// since catalog.js is a static file, not a runtime data store.
const uploadModalEl = document.getElementById('upload-modal');
const uploadNameInput = document.getElementById('upload-name');
const uploadFileInput = document.getElementById('upload-file-input');
const uploadStatusEl = document.getElementById('upload-status');
const uploadCancelBtn = document.getElementById('upload-cancel-btn');
const uploadSubmitBtn = document.getElementById('upload-submit-btn');
const uploadModelBtn = document.getElementById('upload-model-btn');

function setUploadStatus(text, isError) {
  uploadStatusEl.textContent = text;
  uploadStatusEl.classList.toggle('error', Boolean(isError));
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

function openUploadModal() {
  catalogPickerEl.classList.remove('visible');
  uploadNameInput.value = '';
  uploadFileInput.value = '';
  setUploadStatus('');
  uploadSubmitBtn.disabled = false;
  uploadModalEl.classList.add('visible');
}

function closeUploadModal() {
  uploadModalEl.classList.remove('visible');
}

uploadModelBtn.addEventListener('click', openUploadModal);
uploadCancelBtn.addEventListener('click', closeUploadModal);

// Measures a freshly-uploaded model's own real-world size by loading it
// through the exact same path every placed instance uses (loadModelInstance
// — including the Y-up -> Z-up correction), rather than trusting whatever
// the source tool claims. The measured container is never added to the
// scene, just disposed once its bounding box is read.
async function measureModelDimensions(modelUrl) {
  const container = await loadModelInstance(modelUrl);
  const box = new THREE.Box3().setFromObject(container);
  const size = box.getSize(new THREE.Vector3());
  disposeObject(container);
  return { width: size.x, depth: size.y, height: size.z };
}

uploadSubmitBtn.addEventListener('click', async () => {
  const name = uploadNameInput.value.trim();
  if (!name) {
    setUploadStatus('Name is required.', true);
    return;
  }
  const file = uploadFileInput.files[0];
  if (!file) {
    setUploadStatus('Choose a .glb file first.', true);
    return;
  }

  uploadSubmitBtn.disabled = true;
  try {
    let uploadable = file;
    try {
      const optimized = await optimizeModelFile(file, (status) => setUploadStatus(status));
      uploadable = new File([optimized.blob], file.name, { type: 'model/gltf-binary' });
      const trianglePct = optimized.trianglesBefore > 0 ? Math.round((optimized.trianglesAfter / optimized.trianglesBefore) * 100) : 100;
      setUploadStatus(
        `Reduced ${optimized.trianglesBefore.toLocaleString()} -> ${optimized.trianglesAfter.toLocaleString()} triangles ` +
          `(${trianglePct}%), ${formatBytes(optimized.bytesBefore)} -> ${formatBytes(optimized.bytesAfter)}. Uploading…`,
      );
    } catch (err) {
      // Optimization is a nice-to-have, not a requirement — if it fails
      // for any reason (an unusual mesh the simplifier chokes on, etc.)
      // fall back to uploading the original file rather than blocking
      // the whole thing on it.
      console.warn('Client-side model optimization failed, uploading original file:', err);
      setUploadStatus('Could not auto-reduce the model — uploading as-is…');
    }
    const { modelUrl } = await uploadModelFile(uploadable);

    setUploadStatus('Measuring model…');
    const dimensions = await measureModelDimensions(modelUrl);

    setUploadStatus('Creating product…');
    const template = await createCatalogTemplate({
      name,
      dimensions,
      color: '#999999', // only ever used if the model itself fails to load later
      modelUrl,
    });

    activeCatalog.push(template);
    buildCatalogPickerButtons();
    closeUploadModal();

    enterPlacementMode({ type: 'template', template }, `Tap a spot to place ${template.name}`);
  } catch (err) {
    console.error('Custom product upload failed:', err);
    setUploadStatus(err.message || 'Something went wrong.', true);
  } finally {
    uploadSubmitBtn.disabled = false;
  }
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
const snapToggleBtn = document.getElementById('toggle-snap');
const copyBtn = document.getElementById('copy-item');
const deleteBtn = document.getElementById('delete-item');
const multiSelectBtn = document.getElementById('toggle-multiselect');
const pasteBtn = document.getElementById('paste-btn');

let currentGizmoMode = 'translate';
function setGizmoMode(mode) {
  currentGizmoMode = mode;
  modeMoveBtn.classList.toggle('active', mode === 'translate');
  modeRotateBtn.classList.toggle('active', mode === 'rotate');
  translateControls.detach();
  rotateControls.detach();
  if (selectedMeshes.size !== 1) return;
  const [mesh] = selectedMeshes;
  (mode === 'translate' ? translateControls : rotateControls).attach(mesh);
}
modeMoveBtn.addEventListener('click', () => setGizmoMode('translate'));
modeRotateBtn.addEventListener('click', () => setGizmoMode('rotate'));

// Colliding with other products (see resolveByAxis above) is a helpful
// default, not a hard rule — a builder might genuinely want a sign embedded
// in a wall, or a rug overlapping a table leg. Snap starts on; toggling it
// off skips collision resolution entirely, letting the selected item
// overlap anything freely until it's switched back on.
snapToggleBtn.classList.add('active');
snapToggleBtn.addEventListener('click', () => {
  snapToSurfaces = !snapToSurfaces;
  snapToggleBtn.classList.toggle('active', snapToSurfaces);
});

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

// Selection is always a set, even for the common "just tapped one thing"
// case — multi-select mode (below) just changes how a tap modifies it
// (replace vs. add/remove) rather than needing two entirely separate
// selection systems. The move/rotate gizmos can only ever attach to one
// object, so they're only shown when the set holds exactly one.
const selectedMeshes = new Set();
let multiSelectMode = false;

// Highlighting via emissive tint (an earlier approach) silently did nothing
// on builder-uploaded models: RealityScan/Sketchfab-style exports commonly
// bake lighting into the texture and mark the material unlit (glTF's
// KHR_materials_unlit), which GLTFLoader turns into a MeshBasicMaterial —
// a material with no `emissive` property at all. A bounding-box outline
// (THREE.BoxHelper) is a separate line object, not a material tweak, so it
// highlights any mesh regardless of material type. Green to match the
// higglehaven brand (--brand-green in index.html) rather than an arbitrary
// accent color.
const SELECTION_OUTLINE_COLOR = 0x6ca42e;
const selectionOutlines = new Map(); // mesh -> THREE.BoxHelper

function addSelectionOutline(mesh) {
  if (selectionOutlines.has(mesh)) return;
  const helper = new THREE.BoxHelper(mesh, SELECTION_OUTLINE_COLOR);
  scene.add(helper);
  selectionOutlines.set(mesh, helper);
}

function removeSelectionOutline(mesh) {
  const helper = selectionOutlines.get(mesh);
  if (!helper) return;
  scene.remove(helper);
  helper.geometry.dispose();
  helper.material.dispose();
  selectionOutlines.delete(mesh);
}

// Reconciles every visible bit of "what's selected" UI (highlight already
// applied by the caller — this only handles text/panels/gizmo) with the
// current selectedMeshes set. Called after any change to that set.
function updateSelectionUI() {
  const count = selectedMeshes.size;
  if (count === 0) {
    productInfoEl.textContent = HINT_TEXT;
    modeControlsEl.classList.remove('visible');
    translateControls.detach();
    rotateControls.detach();
  } else if (count === 1) {
    const [mesh] = selectedMeshes;
    productInfoEl.textContent = mesh.userData.template.name;
    modeControlsEl.classList.add('visible');
    modeMoveBtn.style.display = '';
    modeRotateBtn.style.display = '';
    setGizmoMode(currentGizmoMode);
  } else {
    productInfoEl.textContent = `${count} items selected`;
    modeControlsEl.classList.add('visible');
    modeMoveBtn.style.display = 'none';
    modeRotateBtn.style.display = 'none';
    translateControls.detach();
    rotateControls.detach();
  }
}

function clearSelection() {
  for (const mesh of selectedMeshes) removeSelectionOutline(mesh);
  selectedMeshes.clear();
}

// Single-select: replaces the whole selection with just this one item (or
// clears it, for `mesh === null`) — the ordinary tap-a-product behavior,
// used whether or not multi-select mode happens to be on (e.g. right after
// a fresh placement).
function selectOnly(mesh) {
  if (selectedMeshes.size === 1 && selectedMeshes.has(mesh)) return;
  clearSelection();
  if (mesh) {
    selectedMeshes.add(mesh);
    addSelectionOutline(mesh);
  }
  updateSelectionUI();
}

// Multi-select: adds or removes just this one item, leaving the rest of
// the selection alone.
function toggleInSelection(mesh) {
  if (selectedMeshes.has(mesh)) {
    selectedMeshes.delete(mesh);
    removeSelectionOutline(mesh);
  } else {
    selectedMeshes.add(mesh);
    addSelectionOutline(mesh);
  }
  updateSelectionUI();
}

// Centroid of the current selection, used to pivot the camera around a
// multi-item selection the same way it already does for a single item.
function getSelectionPivot() {
  if (selectedMeshes.size === 0) return null;
  const centroid = new THREE.Vector3();
  for (const mesh of selectedMeshes) centroid.add(mesh.position);
  return centroid.divideScalar(selectedMeshes.size);
}

// Clearing on every toggle (not just when turning multi-select on) keeps the
// semantics simple: whatever was selected under the old mode never silently
// carries into the new one, where a tap that looks like "select" could
// actually be a toggle-off of a mesh already selected from before.
multiSelectBtn.addEventListener('click', () => {
  multiSelectMode = !multiSelectMode;
  multiSelectBtn.classList.toggle('active', multiSelectMode);
  clearSelection();
  updateSelectionUI();
});

deleteBtn.addEventListener('click', () => {
  if (selectedMeshes.size === 0) return;
  const meshes = [...selectedMeshes];
  clearSelection();
  updateSelectionUI();
  for (const mesh of meshes) deleteInstance(mesh);
});

// Copy captures each selected item's position/rotation *relative* to the
// group — offset from the group's centroid in X/Y, and height above the
// group's lowest bottom surface in Z (its "base") — rather than absolute
// coordinates, so Paste can reproduce the same relative arrangement
// anchored whereever the builder taps next (see handlePlacementClick).
// This is what lets a whole course of a brick wall get copy-pasted as one
// unit instead of one brick at a time.
function copySelection() {
  if (selectedMeshes.size === 0) return;
  const meshes = [...selectedMeshes];
  const centroidX = meshes.reduce((sum, mesh) => sum + mesh.position.x, 0) / meshes.length;
  const centroidY = meshes.reduce((sum, mesh) => sum + mesh.position.y, 0) / meshes.length;
  const baseZ = Math.min(...meshes.map((mesh) => mesh.position.z - mesh.userData.template.dimensions.height / 2));
  clipboard = meshes.map((mesh) => ({
    templateId: mesh.userData.template.templateId,
    dx: mesh.position.x - centroidX,
    dy: mesh.position.y - centroidY,
    dz: mesh.position.z - baseZ,
    rotationX: mesh.rotation.x,
    rotationY: mesh.rotation.y,
    rotationZ: mesh.rotation.z,
  }));
  pasteBtn.disabled = false;
  const count = meshes.length;
  productInfoEl.textContent = `Copied ${count} item${count === 1 ? '' : 's'}`;
  setTimeout(updateSelectionUI, 1200);
}
copyBtn.addEventListener('click', copySelection);

// Placement-pending state: set by tapping a catalog item, the upload
// flow's freshly-created product, or Paste — none of those place anything
// immediately anymore. The next world tap (see the click handler below)
// consumes this and does the actual placing.
let pendingPlacement = null;

function enterPlacementMode(pending, statusText) {
  clearSelection();
  modeControlsEl.classList.remove('visible');
  translateControls.detach();
  rotateControls.detach();
  pendingPlacement = pending;
  productInfoEl.textContent = statusText;
  addItemBtn.textContent = '✕ Cancel';
}

function cancelPlacementMode() {
  pendingPlacement = null;
  addItemBtn.textContent = '+ Add Item';
  updateSelectionUI();
}

let clipboard = null;
pasteBtn.addEventListener('click', () => {
  if (!clipboard) return;
  catalogPickerEl.classList.remove('visible');
  const count = clipboard.length;
  enterPlacementMode({ type: 'clipboard', items: clipboard }, `Tap a spot to paste ${count} item${count === 1 ? '' : 's'}`);
});

// A raycast hit against a model's nested mesh (see loadModelInstance)
// returns that inner mesh, not the top-level product Object3D tracked in
// productMeshes — walk back up the parent chain to find it.
function findRootProduct(object) {
  let current = object;
  while (current && !productMeshes.includes(current)) {
    current = current.parent;
  }
  return current;
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

// Places whatever's pending (a fresh catalog template, or a copied group)
// at wherever was just tapped — the ground, or directly on top of another
// product if that's what the raycast actually hit, so tapping a tabletop
// rests the new item there instead of on the ground beneath it.
async function handlePlacementClick() {
  const productHits = raycaster.intersectObjects(productMeshes, true);
  const groundHits = raycaster.intersectObject(landlet);

  let point;
  let supportingMesh = null;
  if (productHits.length > 0 && (groundHits.length === 0 || productHits[0].distance < groundHits[0].distance)) {
    point = productHits[0].point;
    supportingMesh = findRootProduct(productHits[0].object);
  } else if (groundHits.length > 0) {
    point = groundHits[0].point;
  } else {
    return; // tapped empty sky — nothing to place onto, leave placement pending
  }

  const supportZ = supportingMesh ? supportingMesh.position.z + supportingMesh.userData.template.dimensions.height / 2 : 0;

  const pending = pendingPlacement;
  pendingPlacement = null;
  addItemBtn.textContent = '+ Add Item';

  if (pending.type === 'template') {
    const mesh = await spawnInstanceAt(pending.template, point.x, point.y, supportZ + pending.template.dimensions.height / 2);
    selectOnly(mesh);
  } else {
    const placed = [];
    for (const item of pending.items) {
      const template = findTemplate(item.templateId);
      if (!template) continue;
      const mesh = await spawnInstanceAt(template, point.x + item.dx, point.y + item.dy, supportZ + item.dz, {
        rotationX: item.rotationX,
        rotationY: item.rotationY,
        rotationZ: item.rotationZ,
      });
      if (mesh) placed.push(mesh);
    }
    clearSelection();
    for (const mesh of placed) {
      selectedMeshes.add(mesh);
      addSelectionOutline(mesh);
    }
    updateSelectionUI();
  }
}

renderer.domElement.addEventListener('click', (event) => {
  if (pointerDownPos) {
    const dx = event.clientX - pointerDownPos.x;
    const dy = event.clientY - pointerDownPos.y;
    if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) return;
  }
  // Any genuine tap into the world — whether it selects a product or hits
  // empty ground — means the builder has moved on from the add-item flow,
  // so the catalog picker (if left open) should collapse either way.
  catalogPickerEl.classList.remove('visible');
  raycaster.setFromCamera(ndcFromEvent(event), camera);

  if (pendingPlacement) {
    handlePlacementClick();
    return;
  }

  // recursive: true, since a model's own geometry sits on nested child
  // meshes (see loadModelInstance) rather than directly on the top-level
  // Object3D pushed into productMeshes.
  const hits = raycaster.intersectObjects(productMeshes, true);
  const hitRoot = hits.length > 0 ? findRootProduct(hits[0].object) : null;
  if (multiSelectMode) {
    if (hitRoot) toggleInSelection(hitRoot);
  } else {
    selectOnly(hitRoot);
  }
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
    const pivot = isRotate ? getSelectionPivot() : null;
    if (pivot) {
      beginTargetTween(pivot);
    }
  }

  const newDistance = camera.position.distanceTo(controls.target);
  if (selectedMeshes.size === 0) {
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
  // A selected item's outline must track it live while the translate/rotate
  // gizmo drags it — BoxHelper doesn't auto-update, so it's recomputed here
  // every frame rather than only on selection change.
  for (const helper of selectionOutlines.values()) helper.update();
  renderer.render(scene, camera);
}
animate(0);

// Loads the real catalog + instance list from the backend API, falling
// back to catalog.js's placeholder data (and the localStorage cache) if
// either fetch fails. Catalog and instances are fetched together with a
// single Promise.all specifically so a failure in either one falls both
// back together — the API's seeded catalog (placeholder-table/chair/tree)
// and the local fallback catalog (crate/planter/lamp/table) use different
// templateIds, so pairing one source's catalog with the other's instances
// would leave every instance unable to find its template.
//
// Runs after animate() has already started so the (empty, for now) scene
// renders immediately rather than waiting on the network.
async function bootstrap() {
  let instances;
  try {
    const [catalog, remoteInstances] = await Promise.all([fetchCatalog(), fetchInstances()]);
    activeCatalog = catalog;
    instances = remoteInstances;
  } catch (err) {
    console.warn('Backend unreachable, falling back to local/placeholder data:', err);
    activeCatalog = FALLBACK_CATALOG;
    // A previously-saved instance list (builder additions/removals/moves)
    // entirely replaces the starter set — not merged with it — since the
    // starter set is just a first-visit default, not content to preserve
    // alongside whatever the builder has actually done.
    instances = loadInstances() ?? DEFAULT_INSTANCES;
  }

  buildCatalogPickerButtons();
  // In parallel: each instance's model load is an independent fetch (and
  // most placed instances share just a handful of cached model URLs), so
  // there's no reason to load them one at a time.
  await Promise.all(instances.map((instance) => addInstanceToScene(instance)));
}
bootstrap();
