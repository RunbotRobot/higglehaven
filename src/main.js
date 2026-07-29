import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CATALOG as FALLBACK_CATALOG, DEFAULT_INSTANCES } from './catalog.js';
import { loadInstances, saveInstances } from './layoutStorage.js';
import { fetchCatalog, fetchInstances, createInstanceRemote, updateInstanceRemote, deleteInstanceRemote } from './api.js';

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
  // copies per instance — otherwise highlighting one selected brick (see
  // setEmissive below) would light up every other brick sharing the same
  // cached material.
  model.traverse((child) => {
    if (child.isMesh) {
      child.material = Array.isArray(child.material)
        ? child.material.map((material) => material.clone())
        : child.material.clone();
    }
  });
  model.rotation.x = Math.PI / 2;
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
  object.rotation.z = instance.rotationZ ?? 0;
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

let instanceCounter = 0;
async function spawnInstance(template) {
  instanceCounter += 1;
  const instance = {
    instanceId: `${template.templateId}-${Date.now()}-${instanceCounter}`,
    templateId: template.templateId,
    // Small random spread near the center so repeated adds don't stack
    // exactly on top of each other; still well within the landlet bounds.
    x: (Math.random() - 0.5) * 6,
    y: (Math.random() - 0.5) * 6,
  };
  const mesh = await addInstanceToScene(instance);
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
// template. Tapping one spawns and selects a new instance of it, ready to
// reposition. Buttons are (re)built in bootstrap() once activeCatalog is
// settled, since the API's catalog isn't known until that fetch resolves.
const addItemBtn = document.getElementById('add-item-btn');
const catalogPickerEl = document.getElementById('catalog-picker');

function buildCatalogPickerButtons() {
  catalogPickerEl.replaceChildren();
  for (const template of activeCatalog) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = template.name;
    button.addEventListener('click', async () => {
      catalogPickerEl.classList.remove('visible');
      const mesh = await spawnInstance(template);
      setSelected(mesh);
    });
    catalogPickerEl.appendChild(button);
  }
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
const snapToggleBtn = document.getElementById('toggle-snap');
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
deleteBtn.addEventListener('click', () => {
  if (!selectedMesh) return;
  const mesh = selectedMesh;
  setSelected(null);
  deleteInstance(mesh);
});

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
let selectedMesh = null;

// Same Mesh-or-Group reasoning as disposeObject: a model's visual content
// can be spread across several child meshes/materials, so the highlight
// has to be applied to all of them, not just a single top-level material.
function setEmissive(object, hex) {
  object.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material.emissive) material.emissive.setHex(hex);
    }
  });
}

function setSelected(mesh) {
  if (selectedMesh === mesh) return;
  if (selectedMesh) setEmissive(selectedMesh, 0x000000);
  selectedMesh = mesh;
  if (selectedMesh) {
    setEmissive(selectedMesh, 0x444444);
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
  // recursive: true, since a model's own geometry sits on nested child
  // meshes (see loadModelInstance) rather than directly on the top-level
  // Object3D pushed into productMeshes.
  const hits = raycaster.intersectObjects(productMeshes, true);
  setSelected(hits.length > 0 ? findRootProduct(hits[0].object) : null);
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
