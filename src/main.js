import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cropGeometryFromEnd } from './meshCrop.js';
import { CATALOG as FALLBACK_CATALOG, DEFAULT_INSTANCES } from './catalog.js';
import { loadInstances, saveInstances } from './layoutStorage.js';
import {
  fetchCatalog,
  fetchInstances,
  createInstanceRemote,
  updateInstanceRemote,
  deleteInstanceRemote,
  createInstancesRemote,
  upsertInstancesRemote,
  deleteInstancesRemote,
  uploadModelFile,
  createCatalogTemplate,
  updateCatalogTemplate,
  deleteCatalogTemplate,
  fetchLandlets,
  fetchLandlet,
  claimLandlet,
  fetchWorld,
  expandWorld,
  generateLandRing,
  fetchLandCandidateRing,
  completeRingGeneration,
  fetchBuilders,
  createBuilder,
  renameBuilder,
  deleteBuilder,
  fetchSellers,
  createSeller,
  renameSeller,
  deleteSeller,
  fetchAllLandlets,
} from './api.js';
import { setActiveBuilderId, takeLegacyIdentities } from './builderIdentity.js';
import { setActiveSellerId } from './sellerIdentity.js';
import { optimizeModelFile } from './modelOptimizer.js';
import { getUnits, setUnits, unitSuffix, toDisplayLength, fromDisplayLength, formatLength } from './settings.js';

// The API (worker/index.js + D1) is authoritative when reachable; the
// catalog.js constants above are only used if fetching it fails. This is
// reassigned once, in bootstrap() below, before anything reads it — every
// other reference to the catalog goes through this variable rather than
// FALLBACK_CATALOG directly.
let activeCatalog = FALLBACK_CATALOG;

// There's no auth system yet — a builder is just one of a list of random
// IDs persisted in localStorage (see builderIdentity.js), chosen via the
// builder menu at startup (runBuilderMenu, below). Both builderId and
// currentLandletId are settled once, in bootstrap(), before anything reads
// them; every instance created afterward is tagged with the chosen
// builder's ID so builders only ever see and edit their own landlet's
// placed products.
let builderId = null;
let currentLandletId = 'starter-landlet';

// A seller identity is a genuinely separate roster from builders (see
// worker/index.js's /api/sellers and docs/API.md's "Sellers" section) —
// catalog_templates.seller_id is tagged with this, not builderId, so
// "my products" means "products this seller identity uploaded," not
// "products this builder identity uploaded." Settled lazily, only once
// Sell mode is actually reached (see ensureSellerIdentity below), unlike
// builderId which bootstrap() always resolves up front.
let sellerId = null;

// Shop, Build, and Sell are the three peer top-level views (#mode-nav in
// index.html) — Sell is really just a modal reachable from either of the
// other two (see ensureBuilderIdentity/the Sell nav handler below), but
// Shop and Build are two fundamentally different full-screen scene setups
// (per-world absolute coordinates + flight controls vs. one landlet's local
// coordinates + build gizmos) that bootstrap() builds fresh each time,
// so switching between them goes through a reload rather than a live
// in-place teardown/rebuild, deliberately: this codebase already rejected
// that path once (see enterShopMode's own comment on why it re-fetches/
// rebuilds rather than trying to reuse Build's leftover state). sessionStorage
// (not localStorage) carries the *next* mode across that reload — it's
// gone once bootstrap() reads it, and a plain fresh tab with nothing set
// always lands on Shop, the product's chosen default landing view.
const START_MODE_KEY = 'higglehaven.startMode';
let currentMode = 'shop';

// Declared here (rather than alongside the rest of Shop mode, much further
// down) because animate() below reads it on every frame starting from its
// very first, synchronous call at module load — a `let` declared after
// that point would be in its temporal dead zone the first time animate()
// runs, throwing before the app ever renders a frame.
let shopActive = false;

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
controls.maxPolarAngle = Math.PI * 0.49; // stop just shy of edge-on/underground — same convention as the claim flyover

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
  const { width, depth } = meshDimensions(mesh);
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
  const height = meshDimensions(mesh).height;
  const otherHeight = meshDimensions(other).height;
  const zMinA = z - height / 2;
  const zMaxA = z + height / 2;
  const zMinB = other.position.z - otherHeight / 2;
  const zMaxB = other.position.z + otherHeight / 2;
  return !(zMaxA < zMinB || zMaxB < zMinA);
}

// excludeSet lets a group move (see groupMovePivot below) sweep each of its
// own members against everything *else* without immediately blocking on
// its own touching neighbors — a brick course sweeping against its own
// adjacent bricks would stop instantly otherwise.
function collidesWithAny(mesh, x, y, z, excludeSet) {
  for (const other of productMeshes) {
    if (other === mesh || excludeSet?.has(other)) continue;
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
function sweepAxis(mesh, buildPos, safeVal, candidateVal, excludeSet) {
  if (candidateVal === safeVal) return safeVal;
  const [cx, cy, cz] = buildPos(candidateVal);
  if (!collidesWithAny(mesh, cx, cy, cz, excludeSet)) return candidateVal;
  let lo = safeVal;
  let hi = candidateVal;
  for (let i = 0; i < 25; i++) {
    const mid = (lo + hi) / 2;
    const [mx, my, mz] = buildPos(mid);
    if (collidesWithAny(mesh, mx, my, mz, excludeSet)) hi = mid;
    else lo = mid;
  }
  return lo;
}

// Resolves a requested move from `safe` (mesh's last known collision-free
// position) toward `requested`, one axis at a time (X, then Y, then Z) so
// combined diagonal motion (e.g. a plane handle) still stops correctly
// against whatever it meets along the way.
function resolveByAxis(mesh, safe, requested, excludeSet) {
  const x = sweepAxis(mesh, (v) => [v, safe.y, safe.z], safe.x, requested.x, excludeSet);
  const y = sweepAxis(mesh, (v) => [x, v, safe.z], safe.y, requested.y, excludeSet);
  const z = sweepAxis(mesh, (v) => [x, y, v], safe.z, requested.z, excludeSet);
  return { x, y, z };
}

// Group-move counterpart to resolveByAxis: instead of resolving one mesh's
// position against a fixed safe/requested pair, this resolves how far the
// *whole group* is allowed to move together along one axis, so relative
// spacing survives a collision the same way it already does for the
// landlet-bounds clamp above. Each mesh sweeps from its own drag-start
// position (fixed for the whole drag — see groupMoveStartPositions) by the
// same candidate offset, excluding the rest of the group so touching
// members don't block each other; the most restrictive mesh's achieved
// offset wins for the whole group. Sweeping from the fixed drag-start point
// (rather than wherever the mesh currently sits) is what keeps this safe
// from the same runaway-delta tunneling risk a "sweep from last frame"
// approach would reintroduce — see the objectChange handler's own comment.
function resolveGroupAxisDelta(meshes, startPositions, axis, candidateOffset, excludeSet) {
  if (candidateOffset === 0) return 0;
  let achieved = candidateOffset;
  for (const mesh of meshes) {
    const from = startPositions.get(mesh)[axis];
    const buildPos = (v) => {
      const p = mesh.position;
      if (axis === 'x') return [v, p.y, p.z];
      if (axis === 'y') return [p.x, v, p.z];
      return [p.x, p.y, v];
    };
    const resolved = sweepAxis(mesh, buildPos, from, from + candidateOffset, excludeSet);
    const meshAchieved = resolved - from;
    achieved = candidateOffset > 0 ? Math.min(achieved, meshAchieved) : Math.max(achieved, meshAchieved);
  }
  return achieved;
}

// Ground footprint (X/Y) clamped to the landlet's bounds; vertical (Z)
// clamped between the ground and the placeholder cuboid volume's ceiling —
// see LANDLET_HEIGHT_M. Collision with other products (resolveByAxis,
// above) is applied separately, after this.
function clampToLandlet(mesh, x, y, z) {
  const { width, depth, height } = meshDimensions(mesh);
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
// Set true only for the duration of resyncTransformControlsDrag's own
// synthetic pointerUp/pointerDown pair (see its doc comment below) — every
// dragging-changed listener checks it first so that resync cycle never
// triggers a *real* drag-start/end reaction (undo snapshot, persisted
// layout, network sync) of its own.
let suppressDragCycleSideEffects = false;

// Where the camera stood when the current drag began — edge-pan is capped
// against displacement from *this*, not distance to the dragged object,
// since a normal drag already starts with the camera tens of meters from
// the object (see EDGE_PAN_MAX_PAN_FROM_DRAG_START_M).
let edgePanDragStartCameraPos = null;

function wireDraggingBehavior(transformControls) {
  transformControls.addEventListener('dragging-changed', (event) => {
    if (suppressDragCycleSideEffects) return;
    controls.enabled = !event.value;
    if (event.value) {
      edgePanDragStartCameraPos = camera.position.clone();
      pushUndoSnapshot();
      return;
    }
    edgePanDragStartCameraPos = null;
    persistLayout();
    // The group-move pivot (see groupMovePivot below) isn't a real product
    // itself — it's an invisible anchor the gizmo needed something to
    // attach to. Sync every mesh that actually moved instead of it, as one
    // batched request (see syncBatchUpdate) rather than one fire-and-forget
    // request per mesh — a wall-sized selection dragged at once is exactly
    // the load pattern that used to risk a few silently never saving.
    if (transformControls.object === groupMovePivot) {
      const meshes = groupMoveMeshes ?? [];
      groupMoveMeshes = null;
      groupMoveSet = null;
      groupMoveStartPositions = null;
      syncBatchUpdate(meshes);
    } else if (transformControls.object) {
      syncUpdate(transformControls.object);
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

// An invisible anchor the Move gizmo attaches to instead of a real product
// when several items are selected at once — TransformControls only ever
// knows how to attach to one Object3D. Dragging it doesn't move anything
// itself; each frame's delta gets applied identically to every selected
// mesh instead (see objectChange below), which is what keeps the group's
// relative arrangement intact while moving it as a unit.
const groupMovePivot = new THREE.Object3D();
scene.add(groupMovePivot);
let groupMoveMeshes = null; // meshes being moved together, captured at drag start
let groupMoveSet = null; // same meshes as a Set, for O(1) "is this mine?" checks during collision sweeps
let groupMoveStartPositions = null; // mesh -> its position when the drag began (fixed for the whole drag)
const groupMovePivotStartPosition = new THREE.Vector3(); // pivot's position when the drag began (fixed for the whole drag)

// resolveByAxis needs a known-good starting point to sweep from — captured
// fresh at the start of every drag, since the object's position right
// before a drag begins is by definition already collision-free.
translateControls.addEventListener('dragging-changed', (event) => {
  if (!event.value || !translateControls.object) return;
  if (translateControls.object === groupMovePivot) {
    groupMoveMeshes = [...selectedMeshes];
    groupMoveSet = new Set(groupMoveMeshes);
    groupMoveStartPositions = new Map(groupMoveMeshes.map((mesh) => [mesh, mesh.position.clone()]));
    groupMovePivotStartPosition.copy(groupMovePivot.position);
    return;
  }
  translateControls.object.userData.safePosition = translateControls.object.position.clone();
});
translateControls.addEventListener('objectChange', () => {
  const object = translateControls.object;
  if (!object) return;
  if (object === groupMovePivot) {
    // TransformControls always computes the pivot's position as (position at
    // drag start) + (cumulative pointer offset since drag start) — it has no
    // memory of anything we do to object.position ourselves mid-drag. So the
    // offset has to be measured against that same fixed start, not against
    // wherever we last left the pivot: measuring against our own previous
    // (possibly reduced, e.g. blocked-at-a-wall) position let the gap
    // between "what the pointer is asking for" and "what actually happened"
    // grow larger every subsequent frame the drag continued — eventually
    // large enough that a single frame's requested move jumped clean through
    // an obstacle (or, before collision was added here, corrupted the
    // landlet-bounds clamp the same way — see the group-squish bug this
    // replaced). Measuring from the fixed start keeps the offset tracking
    // the pointer smoothly, frame to frame, exactly like a single item's own
    // move already does.
    const totalOffset = object.position.clone().sub(groupMovePivotStartPosition);
    const meshes = groupMoveMeshes ?? [];
    let minOffsetX = -Infinity, maxOffsetX = Infinity;
    let minOffsetY = -Infinity, maxOffsetY = Infinity;
    let minOffsetZ = -Infinity, maxOffsetZ = Infinity;
    for (const mesh of meshes) {
      const start = groupMoveStartPositions.get(mesh);
      const { width, depth, height } = meshDimensions(mesh);
      const halfSpanX = LANDLET_SIDE_M / 2 - width / 2;
      const halfSpanY = LANDLET_SIDE_M / 2 - depth / 2;
      minOffsetX = Math.max(minOffsetX, -halfSpanX - start.x);
      maxOffsetX = Math.min(maxOffsetX, halfSpanX - start.x);
      minOffsetY = Math.max(minOffsetY, -halfSpanY - start.y);
      maxOffsetY = Math.min(maxOffsetY, halfSpanY - start.y);
      minOffsetZ = Math.max(minOffsetZ, height / 2 - start.z);
      maxOffsetZ = Math.min(maxOffsetZ, LANDLET_HEIGHT_M - height / 2 - start.z);
    }
    const offset = new THREE.Vector3(
      THREE.MathUtils.clamp(totalOffset.x, minOffsetX, maxOffsetX),
      THREE.MathUtils.clamp(totalOffset.y, minOffsetY, maxOffsetY),
      THREE.MathUtils.clamp(totalOffset.z, minOffsetZ, maxOffsetZ),
    );
    if (snapToSurfaces) {
      // Same idea as resolveByAxis for a single item, but resolved for the
      // whole group at once per axis (resolveGroupAxisDelta) so the group's
      // own touching members (excluded via groupMoveSet) never block each
      // other, while anything outside the group still stops the move —
      // sequential X, then Y, then Z, each updating positions before the
      // next axis sweeps, same order resolveByAxis already uses.
      offset.x = resolveGroupAxisDelta(meshes, groupMoveStartPositions, 'x', offset.x, groupMoveSet);
      for (const mesh of meshes) mesh.position.x = groupMoveStartPositions.get(mesh).x + offset.x;
      offset.y = resolveGroupAxisDelta(meshes, groupMoveStartPositions, 'y', offset.y, groupMoveSet);
      for (const mesh of meshes) mesh.position.y = groupMoveStartPositions.get(mesh).y + offset.y;
      offset.z = resolveGroupAxisDelta(meshes, groupMoveStartPositions, 'z', offset.z, groupMoveSet);
      for (const mesh of meshes) mesh.position.z = groupMoveStartPositions.get(mesh).z + offset.z;
    } else {
      for (const mesh of meshes) {
        const start = groupMoveStartPositions.get(mesh);
        mesh.position.set(start.x + offset.x, start.y + offset.y, start.z + offset.z);
      }
    }
    // Snap the pivot itself to the actually-applied (possibly reduced)
    // offset rather than the raw gizmo position, so the displayed gizmo
    // can't visually drift ahead of where the group really stopped.
    object.position.set(
      groupMovePivotStartPosition.x + offset.x,
      groupMovePivotStartPosition.y + offset.y,
      groupMovePivotStartPosition.z + offset.z,
    );
    return;
  }
  const requested = clampToLandlet(object, object.position.x, object.position.y, object.position.z);
  let resolved = requested;
  if (snapToSurfaces) {
    const safe = object.userData.safePosition ?? object.position;
    resolved = resolveByAxis(object, safe, requested);
  }
  object.userData.safePosition = new THREE.Vector3(resolved.x, resolved.y, resolved.z);
  object.position.set(resolved.x, resolved.y, resolved.z);
});

// Trim: shortens an extensible product (see extensibleAxes) along its
// seller-declared axis — cutting a door or a length of lumber down to fit,
// rather than the builder being stuck with whatever size the seller
// uploaded. TransformControls' own scale-mode gizmo drives the live drag —
// object.scale is left to update normally frame to frame, purely as an
// interactive preview, since fighting that mid-drag (writing to the same
// state TransformControls is tracking) is exactly what caused the camera
// edge-pan drift bug elsewhere in this file. Only on release is the
// resulting scale read back out, turned into a clamped crop length, and
// rebuilt as a clean box (applyCropToMesh) with scale reset to identity —
// so nothing about the mesh actually ends up stretched; scale is never
// part of what's persisted or rendered at rest, only how the drag feels
// while it's happening.
const trimControls = new TransformControls(camera, renderer.domElement);
trimControls.setMode('scale');
scene.add(trimControls.getHelper());
// A template can be extensible on more than one axis at once (see
// extensibleAxes/attachTrimControls) — each active axis gets its own
// single-axis handle shown simultaneously, but never a combined
// two-axis or three-axis handle: cropping is only ever meaningful one
// axis at a time (currentDragCropLength assumes exactly one), and a
// diagonal drag across two axes at once has no sensible crop-length
// interpretation. Plane handles (XY/YZ/XZ) are unconditionally off
// regardless of which single axes are enabled. The one case that
// slips past show-flag filtering — TransformControls' uniform "scale
// everything" corner cube, which appears whenever all three of
// showX/showY/showZ happen to be true (a template extensible on all
// three axes, e.g. a wall resizable to any thickness/length/height) —
// has no dedicated show flag to disable, so its handle geometry is
// swapped for an empty one instead: harmless dead space rather than a
// way to accidentally scale all three axes together through Trim,
// which is what the separate Resize tool is for.
trimControls.showXY = false;
trimControls.showYZ = false;
trimControls.showXZ = false;
for (const group of [trimControls._gizmo.picker.scale, trimControls._gizmo.gizmo.scale]) {
  for (const child of group.children) {
    if (child.name === 'XYZ') child.geometry = new THREE.BufferGeometry();
  }
}

// Which local axis the drag in progress is cropping — determined fresh
// each time a drag starts (see the dragging-changed listener below) from
// whichever single-axis handle TransformControls itself reports was
// grabbed, since attachTrimControls can now show more than one handle at
// once. Stays set to whatever it was last after a drag ends; only ever
// read again once another drag (which always resets it first) is active.
let trimAxis = null;
let trimStartLength = 0;

// Converts the gizmo's live (still-unclamped, still just a raw multiplier
// of trimStartLength) scale factor into the actual crop length it
// represents right now.
function currentDragCropLength(object) {
  const template = object.userData.template;
  const extensible = extensibleAxes(template)[trimAxis];
  const maxLength = template.dimensions[AXIS_DIMENSION_KEY[trimAxis]];
  const requestedLength = trimStartLength * object.scale[trimAxis];
  return THREE.MathUtils.clamp(requestedLength, extensible.minM, maxLength);
}

// A separate object, swapped in only while the drag is live, that shows
// the *actual* cropped result at the pointer's current position — see
// updateTrimPreview. The real object being dragged is hidden underneath
// it for the same span; TransformControls keeps tracking that real
// object's own .scale the whole time (completely untouched by any of
// this), so nothing here risks the kind of internal-state desync the
// camera edge-pan fix elsewhere in this file had to work around.
let trimPreviewMesh = null;
let trimPreviewTimer = null;
// The crop length trimPreviewMesh actually represents — lets
// updateTrimPreview skip a pointless rebuild when a drag is pinned at
// the min/max and further pointer movement can't change the clamped
// result, and lets a stale, slower-to-resolve request recognize it's been
// superseded (see trimPreviewRequestId).
let trimPreviewLength = null;
let trimPreviewRequestId = 0;

// Rebuilding a real model's cropped geometry isn't free (it's a full
// reload + clip), so this runs on a short throttle off objectChange
// rather than on every single pointermove — frequent enough to read as
// "live", not frequent enough to visibly lag a dense scanned mesh.
const RESIZE_PREVIEW_THROTTLE_MS = 120;

async function updateTrimPreview(object) {
  const clampedLength = currentDragCropLength(object);
  if (trimPreviewMesh && trimPreviewLength === clampedLength) return;
  const requestId = ++trimPreviewRequestId;
  const instanceLike = {
    instanceId: object.userData.instanceId,
    templateId: object.userData.template.templateId,
    x: object.position.x,
    y: object.position.y,
    z: object.position.z,
    rotationX: object.rotation.x,
    rotationY: object.rotation.y,
    rotationZ: object.rotation.z,
    crop: { ...object.userData.crop, [trimAxis]: clampedLength },
  };
  const preview = await createMeshForInstance(instanceLike);
  // The drag may have already ended, moved to a different object, or been
  // superseded by a newer request (dragging-changed's own immediate call
  // and objectChange's throttled one can both be in flight at once right
  // after a drag starts) while that reload was in flight — stale results
  // get discarded rather than popped in after the fact.
  if (!preview || !trimControls.dragging || trimControls.object !== object || requestId !== trimPreviewRequestId) {
    if (preview) disposeObject(preview);
    return;
  }
  if (trimPreviewMesh) {
    scene.remove(trimPreviewMesh);
    disposeObject(trimPreviewMesh);
  }
  trimPreviewMesh = preview;
  trimPreviewLength = clampedLength;
  scene.add(trimPreviewMesh);
  object.visible = false;
  // The selection outline tracks whatever mesh it was built for via its
  // own world matrix every frame regardless of that mesh's own .visible —
  // left alone, it would keep drawing around the hidden real object's own
  // live (still-stretching) scale, out of step with the correctly-cropped
  // preview sitting right where the object used to be.
  const outline = selectionOutlines.get(object);
  if (outline) {
    outline.helper.visible = false;
    outline.fill.visible = false;
  }
  trimInputEl(trimAxis).value = toDisplayLength(clampedLength).toFixed(2);
}

function clearTrimPreview(object) {
  if (trimPreviewTimer) {
    clearTimeout(trimPreviewTimer);
    trimPreviewTimer = null;
  }
  if (trimPreviewMesh) {
    scene.remove(trimPreviewMesh);
    disposeObject(trimPreviewMesh);
    trimPreviewMesh = null;
  }
  trimPreviewLength = null;
  if (object) {
    object.visible = true;
    const outline = selectionOutlines.get(object);
    if (outline) {
      outline.helper.visible = true;
      outline.fill.visible = true;
    }
  }
}

trimControls.addEventListener('objectChange', () => {
  const object = trimControls.object;
  if (!object || !trimAxis || !trimControls.dragging || trimPreviewTimer) return;
  trimPreviewTimer = setTimeout(() => {
    trimPreviewTimer = null;
    updateTrimPreview(object);
  }, RESIZE_PREVIEW_THROTTLE_MS);
});

trimControls.addEventListener('dragging-changed', async (event) => {
  controls.enabled = !event.value;
  const object = trimControls.object;
  if (!object) return;
  if (event.value) {
    // Which single-axis handle was actually grabbed, freshly determined
    // per drag rather than fixed at attach time — attachTrimControls may
    // now be showing more than one axis's handle at once. Anything other
    // than a clean single-letter 'X'/'Y'/'Z' (the plane and uniform-corner
    // handles are already meant to be unreachable — see trimControls'
    // own setup above — but this is a cheap second guard) leaves trimAxis
    // null, so the matching branch below no-ops the drag entirely rather
    // than trying to crop along an axis this template never declared.
    const axis = trimControls.axis && trimControls.axis.length === 1 ? trimControls.axis.toLowerCase() : null;
    trimAxis = axis && extensibleAxes(object.userData.template)?.[axis] ? axis : null;
    if (!trimAxis) return;
    pushUndoSnapshot();
    trimStartLength = effectiveLength(object.userData.template, object.userData, trimAxis, AXIS_DIMENSION_KEY[trimAxis]);
    // Hide the real object immediately, before even the first preview has
    // loaded, rather than waiting for updateTrimPreview to do it once
    // its (throttled, async) result comes back. TransformControls starts
    // live-stretching object.scale the instant the drag begins — without
    // this, that raw, unclamped stretch was the only thing on screen for
    // a beat every drag, most visible right at the extremes: yank the
    // handle hard past the max and the object visibly overshot before the
    // correctly-clamped preview finally popped in and snapped it back.
    // The one-time preview build kicked off here (not through the
    // throttle) means nothing but the correct cropped result — or, at
    // worst, briefly nothing at all — is ever visible instead.
    object.visible = false;
    const outline = selectionOutlines.get(object);
    if (outline) {
      outline.helper.visible = false;
      outline.fill.visible = false;
    }
    updateTrimPreview(object);
    return;
  }
  if (!trimAxis) return; // an invalid grab (see above) never hid the object or started a preview to undo
  const clampedLength = currentDragCropLength(object);
  clearTrimPreview(object);
  object.scale.set(1, 1, 1);
  const updated = await replaceMeshWithCrop(object, { ...object.userData.crop, [trimAxis]: clampedLength });
  const clamped = clampToLandlet(updated, updated.position.x, updated.position.y, updated.position.z);
  updated.position.set(clamped.x, clamped.y, clamped.z);
  updated.userData.safePosition = updated.position.clone();
  trimControls.attach(updated);
  persistLayout();
  syncUpdate(updated);
  updateTrimLengthInput();
});

// Resize: a real uniform scale, independent of Trim above — for a placed
// item whose own source model came in at the wrong physical size entirely
// (e.g. an uploaded scan authored many times too large or too small),
// rather than any per-axis shortening. Unlike Trim, this needs no special
// per-drag preview handling: TransformControls' own scale-mode gizmo can
// just be allowed to update object.scale directly and persist normally,
// since a uniform scale never distorts the model the way an unclamped
// per-axis stretch would. Only its uniform (center) handle is meant to be
// used — per-axis handles are hidden (see below) so a drag can't
// accidentally stretch one axis independently of the others.
const scaleControls = new TransformControls(camera, renderer.domElement);
scaleControls.setMode('scale');
scaleControls.showX = false;
scaleControls.showY = false;
scaleControls.showZ = false;
scene.add(scaleControls.getHelper());
wireDraggingBehavior(scaleControls);

const MIN_SCALE = 0.001;
const MAX_SCALE = 1000;

// TransformControls' scale gizmo scales an object about its own local
// origin, which sits at the object's vertical *center* once placed (see
// createMeshForInstance's own "z = height / 2 rests it on ground"
// convention) — left alone, growing the scale would sink the object into
// whatever it's resting on and shrinking it would lift it into the air,
// since only the geometry grows/shrinks while position.z stays fixed.
// Recomputing position.z to keep the object's *bottom* edge exactly where
// it was before this scale change — not assuming that's bare ground,
// since Snap can rest an item on top of another one — keeps it resting on
// whatever surface it was already on, growing/shrinking only upward from
// there, the way a real object being resized in place actually would.
function keepRestingOnScaleChange(object, oldScale, newScale) {
  const unscaledHeight = effectiveLength(object.userData.template, object.userData, 'z', 'height');
  const bottom = object.position.z - (unscaledHeight * oldScale) / 2;
  object.position.z = bottom + (unscaledHeight * newScale) / 2;
}

scaleControls.addEventListener('objectChange', () => {
  const object = scaleControls.object;
  if (!object) return;
  // The uniform handle already applies the same factor to all three axes,
  // but clamp and re-sync explicitly rather than trusting that — cheap
  // insurance against an extreme drag producing a degenerate (near-zero
  // or absurdly large) scale.
  const uniform = THREE.MathUtils.clamp(object.scale.x, MIN_SCALE, MAX_SCALE);
  object.scale.setScalar(uniform);
  keepRestingOnScaleChange(object, object.userData.scale ?? 1, uniform);
  object.userData.scale = uniform;
  updateResizeScaleInput();
});

// Reflects the selected item's current scale into the numeric field, as a
// percentage — called on selection change and right after a drag-driven
// resize, so the field never shows a stale value. (Its own .addEventListener
// registration lives further down, alongside each trim axis field's — all
// need their DOM refs, declared later in the file, to already exist.)
function updateResizeScaleInput() {
  if (selectedMeshes.size !== 1) return;
  const [mesh] = selectedMeshes;
  resizeScaleInputEl.value = Math.round((mesh.userData.scale ?? 1) * 100);
}

const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
sunLight.position.set(20, 10, 30);
scene.add(sunLight);

// PlaneGeometry already lies flat in the XY plane by default — which is
// now our ground plane (Z-up), so unlike before, no rotation is needed. This
// square is only a placeholder shown before bootstrap() resolves which
// landlet is actually being built on — applyLandletShape() below swaps the
// geometry for the real polygon once that's known. The mesh itself (and its
// raycasting target at line ~1343ish) has to exist immediately, since
// ground-click placement can happen before that fetch resolves.
const landletGeometry = new THREE.PlaneGeometry(LANDLET_SIDE_M, LANDLET_SIDE_M);
// DoubleSide so the plane stays visible from below during dev orbiting;
// the finished game will never let a shopper get under the ground plane.
const landletMaterial = new THREE.MeshStandardMaterial({ color: 0x4caf50, side: THREE.DoubleSide }); // placeholder grass
const landlet = new THREE.Mesh(landletGeometry, landletMaterial);
scene.add(landlet);

// Swaps the ground mesh's geometry for the landlet's real polygon (plot-
// local offsets from its own center, per docs/API.md) once bootstrap() has
// fetched it — a plain square fallback (shapeForLandlet's own fallback) for
// legacy/placeholder landlets that predate real procedural generation.
function applyLandletShape(landletRecord) {
  const oldGeometry = landlet.geometry;
  landlet.geometry = new THREE.ShapeGeometry(shapeForLandlet(landletRecord));
  oldGeometry.dispose();
}

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

// axis ('x'/'y'/'z', matching how BoxGeometry's three arguments map onto
// this scene below) -> { minM } declared by the seller on a template that
// can be shortened, e.g. a brick or lumber board cut down to fit a gap
// (see docs/API.md). Lives in the template's existing metadata_json rather
// than needing its own column — same place `placeholder: true` already
// lives.
function extensibleAxes(template) {
  return template.metadata?.extensible || null;
}

// The length actually in effect for one axis of an instance: the builder's
// crop override if it has cropped that axis, else the template's full
// (seller-uploaded maximum) size.
function effectiveLength(template, instance, axis, dimensionKey) {
  return instance.crop?.[axis] ?? template.dimensions[dimensionKey];
}

// A placed mesh's real, current footprint — its template's dimensions with
// any crop (mesh.userData.crop, set in createMeshForInstance) and uniform
// Resize scale (mesh.userData.scale) applied. Collision, landlet-bounds
// clamping, and stacking all need this rather than the template's raw
// dimensions, or a cropped/resized item would still claim its full
// template-declared footprint for those purposes.
function meshDimensions(mesh) {
  const { template, crop, scale = 1 } = mesh.userData;
  return {
    width: (crop?.x ?? template.dimensions.width) * scale,
    depth: (crop?.y ?? template.dimensions.depth) * scale,
    height: (crop?.z ?? template.dimensions.height) * scale,
  };
}

const AXIS_DIMENSION_KEY = { x: 'width', y: 'depth', z: 'height' };

// Swaps `mesh` for a freshly built Object3D reflecting `crop` — used by
// the Trim UI itself, and by restoreSnapshot when an undo/redo jump
// lands an *existing* mesh (reused rather than recreated, see its doc
// comment) on a snapshot with a different crop than the mesh currently
// has. Always goes through createMeshForInstance rather than mutating the
// existing mesh in place: a model-backed extensible item needs a real
// reload + re-clip (see loadCroppedModelInstance), which the box-fallback
// case could get away without, but sharing one path keeps crop-application
// logic in exactly one place. A no-op (returns `mesh` unchanged) for a
// non-extensible template, or when `crop` already matches what's
// currently applied — both common: most instances aren't extensible, and
// restoreSnapshot calls this for every instance an undo/redo jump
// touches, most of which didn't actually change crop.
async function replaceMeshWithCrop(mesh, crop) {
  const template = mesh.userData.template;
  if (!extensibleAxes(template)) return mesh;
  const nextCrop = { ...(crop || {}) };
  if (JSON.stringify(nextCrop) === JSON.stringify(mesh.userData.crop || {})) return mesh;

  const instanceLike = {
    instanceId: mesh.userData.instanceId,
    templateId: template.templateId,
    x: mesh.position.x,
    y: mesh.position.y,
    z: mesh.position.z,
    rotationX: mesh.rotation.x,
    rotationY: mesh.rotation.y,
    rotationZ: mesh.rotation.z,
    crop: nextCrop,
    scale: mesh.userData.scale ?? 1,
  };
  const newMesh = await createMeshForInstance(instanceLike);
  if (!newMesh) return mesh;

  const index = productMeshes.indexOf(mesh);
  if (index !== -1) productMeshes[index] = newMesh;
  scene.remove(mesh);
  disposeObject(mesh);
  scene.add(newMesh);
  newMesh.userData.safePosition = newMesh.position.clone();

  if (selectedMeshes.has(mesh)) {
    removeSelectionOutline(mesh);
    selectedMeshes.delete(mesh);
    selectedMeshes.add(newMesh);
    addSelectionOutline(newMesh);
  }
  return newMesh;
}

// Downsamples a texture to a single pixel via an offscreen canvas to get
// its overall average color — a cheap, dependency-free way to get "this
// product's actual color" for a real uploaded model, whose catalog
// template.color is usually just the upload flow's generic gray
// placeholder rather than a color anyone actually picked (see
// loadCroppedModelInstance's own use of this). Returns null for a
// materialless mesh or a texture whose image hasn't finished decoding yet
// (shouldn't happen in practice — GLTFLoader resolves textures before a
// model's load promise does — but a null-safe fallback costs nothing).
function averageTextureColor(texture) {
  const image = texture?.image;
  if (!image || !image.width || !image.height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return new THREE.Color(r / 255, g / 255, b / 255);
}

// For an extensible template that has a real model: loads it via
// loadModelInstance (its usual Y-up-correction/recenter pipeline), then —
// for each axis this particular instance is actually cropped shorter than
// the template's declared maximum on (a template can declare more than
// one extensible axis, see extensibleAxes, though most instances of it
// won't be cropped on all of them at once) — bakes each mesh's
// accumulated transform into its own geometry (putting it in the same
// container-local space effectiveLength's width/depth/height already
// describe) and runs it through meshCrop.js's plane clipper, once per
// cropped axis. Cropping only ever removes material from the +axis end
// (see meshCrop.js's own doc comment for why, and why the far end's cap
// is never a fabricated flat disc) — see docs/API.md's "Extensible
// products" section. Returns the container unmodified when there's
// nothing to crop on any axis, so a full-length instance of an
// extensible template still renders exactly like a normal one, model
// and all.
async function loadCroppedModelInstance(template, instance) {
  const container = await loadModelInstance(template.modelUrl);
  const extensible = extensibleAxes(template);
  if (!extensible) return container;

  const croppedAxes = ['x', 'y', 'z'].filter((axis) => {
    if (!extensible[axis]) return false;
    const dimensionKey = AXIS_DIMENSION_KEY[axis];
    const fullLength = template.dimensions[dimensionKey];
    const cropLength = effectiveLength(template, instance, axis, dimensionKey);
    return cropLength < fullLength - 1e-6;
  });
  if (croppedAxes.length === 0) return container;

  container.updateMatrixWorld(true);
  const meshes = [];
  container.traverse((child) => {
    if (child.isMesh) meshes.push(child);
  });

  // Cropping only the +axis end leaves the remaining geometry's true
  // center drifting toward -axis as cropLength shrinks — but every
  // consumer of a placed mesh's own position (collision, landlet-bounds
  // clamping, ...) assumes position IS the center. Recentering the
  // geometry and pushing the same offset onto this inner group (rather
  // than the outer group createMeshForInstance still needs to freely
  // position) keeps that invariant intact without moving anything the
  // builder actually sees: the untouched -axis end still lands in
  // exactly the same spot it would have without this compensation. Each
  // cropped axis's own offset is independent of the others (they're
  // different vector components), so accumulating them into one shift
  // and applying it once, after every axis has been cropped, is
  // equivalent to applying each axis's own shift right after its own
  // crop — simpler to just do once at the end.
  const shift = [0, 0, 0];
  const groupOffset = [0, 0, 0];
  for (const axis of croppedAxes) {
    const axisIndex = { x: 0, y: 1, z: 2 }[axis];
    const dimensionKey = AXIS_DIMENSION_KEY[axis];
    const fullLength = template.dimensions[dimensionKey];
    const cropLength = effectiveLength(template, instance, axis, dimensionKey);
    const recenterOffset = (cropLength - fullLength) / 2;
    shift[axisIndex] = -recenterOffset;
    groupOffset[axisIndex] = recenterOffset;
  }

  // The manufactured backing cap (materialIndex 1 — see meshCrop.js) is
  // meant to stay fully hidden behind the real, relocated end cap, but a
  // real scanned cross-section — especially one that isn't a simple
  // rectangular prism — can still leave some of it exposed even after
  // cropGeometryFromEnd's own bounding-box coverage fit, which can only
  // correct a size mismatch, not reshape a patch to a hole's actual
  // (possibly irregular) outline. Rendering that sliver with the SAME
  // textured material as the real surface used to mean sampling whatever
  // texel happens to sit at the flat cap's UV(0,0) — an arbitrary,
  // sometimes bizarrely-colored patch of the product's own texture atlas
  // showing up out of context. template.color is scarcely better for a
  // real uploaded model: it's near-universally the upload flow's generic
  // placeholder swatch (`#999999`), not this product's actual color, so a
  // visible sliver still read as a flat industrial-gray patch rather than
  // "an ordinary surface" of the same product. Sampling the real
  // material's own texture down to its average color instead means any
  // exposed sliver blends into the surrounding real surface's actual tone
  // — still not textured detail, but no longer an obviously wrong color.
  // DoubleSide: a genuinely holey real scan (see this block's own comment
  // above) can let a grazing view ray slip past the backing cap's front
  // face without a clean hit — rendering its normally-invisible backface
  // instead of falling through to empty space/background is a cheap,
  // strictly-better hardening regardless of any one model's own defects.
  const inner = new THREE.Group();
  for (const mesh of meshes) {
    let geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    // Cropping two or three axes on the same instance runs this same
    // geometry through cropGeometryFromEnd once per axis in turn — each
    // pass only ever touches its own axis's coordinate, so an
    // already-cropped x range is untouched by a following z crop and
    // vice versa (see cropGeometryFromEnd's own doc comment: it assumes
    // its axis is currently centered at 0, which chaining preserves
    // since a crop on one axis never moves another axis's coordinates).
    // The one real cost of chaining rather than cropping fresh geometry
    // per axis: a later pass's toTriangleList normalizes every triangle
    // it sees back to "real surface," including an earlier pass's own
    // fabricated backing-cap sliver near a shared corner — a small,
    // already-meant-to-be-hidden patch occasionally rendering with the
    // real texture instead of its flat backing color, not the always-
    // preserved surface a builder actually sees.
    for (const axis of croppedAxes) {
      const axisIndex = { x: 0, y: 1, z: 2 }[axis];
      const dimensionKey = AXIS_DIMENSION_KEY[axis];
      const fullLength = template.dimensions[dimensionKey];
      const cropLength = effectiveLength(template, instance, axis, dimensionKey);
      geometry = cropGeometryFromEnd(geometry, axisIndex, cropLength, fullLength);
    }
    geometry.translate(shift[0], shift[1], shift[2]);
    const originalMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const backingColor = averageTextureColor(originalMaterial?.map) || new THREE.Color(template.color);
    const backingMaterial = new THREE.MeshStandardMaterial({ color: backingColor, side: THREE.DoubleSide });
    inner.add(new THREE.Mesh(geometry, [originalMaterial, backingMaterial]));
  }
  inner.position.set(groupOffset[0], groupOffset[1], groupOffset[2]);
  const result = new THREE.Group();
  result.add(inner);
  return result;
}

// Builds the Object3D for a placed instance: its catalog template's real
// model if it has one (cropped via loadCroppedModelInstance when the
// template is extensible and this instance actually is cropped), falling
// back to a colored box (still used by any template without a model yet,
// and if a model fails to load or crop). Resting on the ground (z = height
// / 2) by default since a fresh instance has no saved z yet.
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
  const width = effectiveLength(template, instance, 'x', 'width');
  const depth = effectiveLength(template, instance, 'y', 'depth');
  const height = effectiveLength(template, instance, 'z', 'height');
  let object;
  if (template.modelUrl) {
    try {
      object = extensibleAxes(template)
        ? await loadCroppedModelInstance(template, instance)
        : await loadModelInstance(template.modelUrl);
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
  object.userData.crop = { ...(instance.crop || {}) };
  // A real uniform Resize (see scaleControls), entirely separate from
  // Trim's per-axis crop above — for a placed item whose own source model
  // came in at the wrong physical size. Applied to the whole returned
  // object (box fallback or real model container alike) so it scales
  // everything uniformly, position included via Object3D's own transform.
  object.userData.scale = instance.scale ?? 1;
  object.scale.setScalar(object.userData.scale);
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
    crop: mesh.userData.crop,
    scale: mesh.userData.scale ?? 1,
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
    landletId: currentLandletId,
    templateId: mesh.userData.template.templateId,
    x: mesh.position.x,
    y: mesh.position.y,
    z: mesh.position.z,
    rotationX: mesh.rotation.x,
    rotationY: mesh.rotation.y,
    rotationZ: mesh.rotation.z,
    crop: mesh.userData.crop,
    scale: mesh.userData.scale ?? 1,
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

// Bulk counterparts to the three above, for any action that touches many
// instances at once (paste, a multi-item group move, multi-delete,
// undo/redo restoring a snapshot). Two differences from the single-item
// versions: instances go through the server's own /instances/batch
// endpoint (chunked to its 100-per-request cap) instead of one request
// per item, and a failure here surfaces loudly via alert() instead of a
// console.warn only nobody sees. Both matter for the same reason: hundreds
// of simultaneous unbatched fire-and-forget requests is exactly the load
// pattern that let some quietly never reach the server while everything
// still looked right locally — discovered only much later, when a reload
// came back with items missing and no record of what or why.
async function syncBatchCreate(meshes) {
  if (meshes.length === 0) return;
  try {
    await createInstancesRemote(meshes.map(instanceFromMesh));
  } catch (err) {
    console.warn('Failed to sync new instances to backend:', err);
    alert(`Couldn't save ${meshes.length} placed item(s) to the server — they may not survive a reload. ${err.message || ''}`.trim());
  }
}

async function syncBatchUpdate(meshes) {
  if (meshes.length === 0) return;
  try {
    await upsertInstancesRemote(meshes.map(instanceFromMesh));
  } catch (err) {
    console.warn('Failed to sync instance updates to backend:', err);
    alert(`Couldn't save ${meshes.length} moved item(s) to the server — they may not survive a reload. ${err.message || ''}`.trim());
  }
}

async function syncBatchDelete(instanceIds) {
  if (instanceIds.length === 0) return;
  try {
    await deleteInstancesRemote(instanceIds);
  } catch (err) {
    console.warn('Failed to sync instance deletes to backend:', err);
    alert(`Couldn't save the deletion of ${instanceIds.length} item(s) to the server — they may reappear on reload. ${err.message || ''}`.trim());
  }
}

// Places a fresh instance at an exact spot — the world position the
// builder just tapped (see handlePlacementClick) — rather than a random
// offset near the center that then has to be dragged into place.
let instanceCounter = 0;
// sync: false lets a caller placing many instances at once (see
// placeClipboardItems) skip the per-item network request here and batch
// them all into one call itself instead — see syncBatchCreate's doc
// comment for why that distinction matters.
async function spawnInstanceAt(template, x, y, z, overrides = {}, { sync = true } = {}) {
  instanceCounter += 1;
  const instance = {
    instanceId: `${template.templateId}-${Date.now()}-${instanceCounter}`,
    templateId: template.templateId,
    x,
    y,
    z,
    rotationX: overrides.rotationX ?? 0,
    rotationY: overrides.rotationY ?? 0,
    rotationZ: overrides.rotationZ ?? 0,
    crop: overrides.crop,
    scale: overrides.scale ?? 1,
  };
  const mesh = await addInstanceToScene(instance);
  if (!mesh) return null;
  const clamped = clampToLandlet(mesh, mesh.position.x, mesh.position.y, mesh.position.z);
  mesh.position.set(clamped.x, clamped.y, clamped.z);
  mesh.userData.safePosition = mesh.position.clone();
  persistLayout();
  if (sync) syncCreate(mesh);
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

// sync: false is the multi-item counterpart to spawnInstanceAt's own —
// used wherever several instances are deleted in one action (multi-delete,
// undo/redo) so the caller can batch the network side into one request.
function deleteInstance(mesh, { sync = true } = {}) {
  const index = productMeshes.indexOf(mesh);
  if (index === -1) return;
  const instanceId = mesh.userData.instanceId;
  productMeshes.splice(index, 1);
  scene.remove(mesh);
  disposeObject(mesh);
  persistLayout();
  if (sync) syncDelete(instanceId);
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
    // Uploading from Build mode doesn't otherwise require a seller
    // identity to already be chosen (only Sell mode's own entry points
    // do) — ensure one now rather than tagging the new template with
    // whatever builder identity happens to be active.
    const uploaderSellerId = await ensureSellerIdentity();
    const template = await createCatalogTemplate({
      name,
      dimensions,
      color: '#999999', // only ever used if the model itself fails to load later
      modelUrl,
      sellerId: uploaderSellerId,
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

// Seller product management: lets a seller mark their own uploaded
// products extensible (see extensibleAxes) after the fact — the upload
// flow itself doesn't ask, since cutting something down to fit is a need
// that only shows up once a builder is actually trying to place it. Still
// no real accounts (see docs/API.md's "Sellers" section) — "mine" means
// sellerId matches this session's active seller identity (a genuinely
// separate roster from builders, not reused from one), falling back to
// any unclaimed (sellerId-less) custom upload so products created before
// sellers existed as their own concept — like a real scanned model
// uploaded before this feature — are still reachable here instead of
// stuck unmanageable.
const sellerModalEl = document.getElementById('seller-modal');
const sellerListEl = document.getElementById('seller-list');
const sellerStatusEl = document.getElementById('seller-status');
const sellerCloseBtn = document.getElementById('seller-close-btn');

function myProducts() {
  return activeCatalog.filter((template) =>
    template.sellerId === sellerId ||
    (template.sellerId === null && template.modelUrl?.startsWith('/uploads/')));
}

const AXIS_LIST = ['x', 'y', 'z'];
const AXIS_ROW_LABELS = { x: 'Width (x)', y: 'Depth (y)', z: 'Height (z)' };

// On-demand product preview: a small self-contained Three.js scene,
// entirely separate from the main builder scene, the same pattern the
// claim flyover uses (see disposeClaimFlyover). Lets a seller see the
// actual product — real scanned model or placeholder box, whichever the
// builder scene would show — rather than a simplified stand-in. Only one
// row's preview is ever live at a time (mobile GPUs don't want many
// WebGL contexts anyway), so this is a single shared canvas moved into
// whichever row's Preview button was last toggled on, rather than one
// per row. Defaults to a plain look-it-over view — no axis arrows — since
// most sellers opening this modal just want to rename or delete
// something; arrows only appear once a row's Extensibility section (a
// rare need — see docs/API.md) is actually expanded.
const sellerPreviewCanvas = document.createElement('canvas');
sellerPreviewCanvas.className = 'seller-preview-canvas';
const sellerPreviewHintEl = document.createElement('div');
sellerPreviewHintEl.className = 'seller-preview-hint';
const AXIS_ARROW_COLORS = { x: 0xff5555, y: 0x55dd55, z: 0x5599ff };
let axisPreview = null;

function mountPreviewInto(container) {
  container.appendChild(sellerPreviewCanvas);
  container.appendChild(sellerPreviewHintEl);
}

function disposeAxisPreview() {
  sellerPreviewCanvas.remove();
  sellerPreviewHintEl.remove();
  if (!axisPreview) return;
  axisPreview.controls.dispose();
  axisPreview.renderer.dispose();
  disposeObject(axisPreview.previewObject);
  for (const arrow of axisPreview.arrows) {
    arrow.line.geometry.dispose();
    arrow.line.material.dispose();
    arrow.cone.geometry.dispose();
    arrow.cone.material.dispose();
  }
  for (const sprite of axisPreview.labels) {
    sprite.material.map.dispose();
    sprite.material.dispose();
  }
  axisPreview = null;
}

// A small canvas-drawn "X"/"Y"/"Z" billboard at each arrow's tip, so the
// preview reads as a legend rather than three unlabeled colored lines.
function makeAxisLabelSprite(text, colorHex) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `#${colorHex.toString(16).padStart(6, '0')}`;
  ctx.beginPath();
  ctx.arc(32, 32, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#16240a';
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.renderOrder = 1;
  return sprite;
}

// highlightAxes: null for a plain general-viewing look (no arrows at all —
// the default once a row's Preview is toggled on), or an array of the
// axes ('x'/'y'/'z', zero or more, any subset since a template can be
// extensible on more than one at once) currently checked in the
// Extensibility panel. An empty array reads as a neutral, evenly-weighted
// X/Y/Z legend (nothing checked yet); a non-empty one turns those axes
// bright yellow and mutes the rest to gray.
async function showAxisPreview(template, container, highlightAxes) {
  disposeAxisPreview();
  mountPreviewInto(container);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(2, -3, 4);
  scene.add(sun);

  // Same instance shape addInstanceToScene builds, at the origin and with
  // no crop, so this shows the product's real full-size geometry (and, for
  // a real uploaded model, its real material/texture) exactly as it would
  // appear freshly placed in Build mode — not a simplified stand-in.
  const previewObject = await createMeshForInstance({
    templateId: template.templateId,
    x: 0, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0,
    crop: {},
  });
  if (!previewObject) return;
  scene.add(previewObject);

  const box = new THREE.Box3().setFromObject(previewObject);
  const size = box.getSize(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.05);

  const rect = sellerPreviewCanvas.getBoundingClientRect();
  const camera = new THREE.PerspectiveCamera(45, rect.width / Math.max(rect.height, 1), 0.01, 100);
  camera.up.set(0, 0, 1);
  const dist = radius * 2.6;
  camera.position.set(dist * 0.75, -dist * 0.95, dist * 0.65);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas: sellerPreviewCanvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(rect.width, rect.height, false);

  const controls = new OrbitControls(camera, sellerPreviewCanvas);
  controls.target.set(0, 0, 0);
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.minDistance = dist * 0.35;
  controls.maxDistance = dist * 3;
  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render);

  // Not checked yet: all three read as a neutral, evenly-weighted legend.
  // Once one or more axes are checked, those arrows turn bright yellow and
  // the rest mute to gray — the same "this one's the live one" language
  // the Trim gizmo itself uses elsewhere. highlightAxes === null (the
  // default, general-viewing look) skips arrows entirely.
  const arrows = [];
  const labels = [];
  if (highlightAxes !== null) {
    const axisDims = { x: size.x, y: size.y, z: size.z };
    const dirs = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
    for (const axis of AXIS_LIST) {
      const isHighlighted = highlightAxes.includes(axis);
      const color = highlightAxes.length > 0 ? (isHighlighted ? 0xffee33 : 0x888888) : AXIS_ARROW_COLORS[axis];
      const length = axisDims[axis] / 2 + radius * 0.35;
      const arrow = new THREE.ArrowHelper(dirs[axis], new THREE.Vector3(0, 0, 0), length, color, length * 0.3, length * 0.18);
      scene.add(arrow);
      arrows.push(arrow);
      const label = makeAxisLabelSprite(axis.toUpperCase(), color);
      label.position.copy(dirs[axis]).multiplyScalar(length * 1.2);
      const labelScale = radius * 0.28;
      label.scale.set(labelScale, labelScale, labelScale);
      scene.add(label);
      labels.push(label);
    }
  }

  render();
  axisPreview = { renderer, scene, camera, controls, previewObject, arrows, labels, templateId: template.templateId };
  sellerPreviewHintEl.textContent = highlightAxes === null
    ? 'Drag to look around.'
    : highlightAxes.length > 0
      ? `Yellow = extensible (${highlightAxes.map((axis) => axis.toUpperCase()).join(', ')}). Drag to look around.`
      : 'Arrows show X (red) / Y (green) / Z (blue). Check axes below to make them extensible. Drag to look around.';
}

function renderSellerList() {
  // Row DOM is about to be thrown away — an open preview would be left
  // pointing at a detached container, and any per-row event handler
  // (Save, axis select...) that referenced this render's stale `template`
  // closures goes with it.
  disposeAxisPreview();
  sellerListEl.innerHTML = '';
  const templates = myProducts();
  if (templates.length === 0) {
    sellerStatusEl.textContent = 'No custom products yet — use "+ Upload Model" to add one.';
    return;
  }
  sellerStatusEl.textContent = '';

  for (const template of templates) {
    const row = document.createElement('div');
    row.className = 'seller-row';

    const label = document.createElement('div');
    label.className = 'seller-row-label';
    label.textContent = template.name;
    row.appendChild(label);

    const dims = document.createElement('div');
    dims.className = 'seller-row-dims';
    const { width, depth, height } = template.dimensions;
    dims.textContent = `${formatLength(width)} × ${formatLength(depth)} × ${formatLength(height)}`;
    row.appendChild(dims);

    const rowStatus = document.createElement('div');
    rowStatus.className = 'seller-row-status';

    const actions = document.createElement('div');
    actions.className = 'seller-row-actions';
    row.appendChild(actions);

    const previewContainer = document.createElement('div');
    previewContainer.className = 'seller-row-preview';
    row.appendChild(previewContainer);

    // General-purpose look-it-over view by default (no axis arrows) — see
    // showAxisPreview's own doc comment. Toggling reuses the single
    // shared canvas rather than one per row.
    const previewBtn = document.createElement('button');
    previewBtn.className = 'seller-row-action-btn';
    previewBtn.type = 'button';
    previewBtn.textContent = 'Preview';
    previewBtn.addEventListener('click', () => {
      const alreadyOpenHere = axisPreview?.templateId === template.templateId;
      disposeAxisPreview();
      previewBtn.classList.remove('active');
      if (alreadyOpenHere) return; // toggled off
      previewBtn.classList.add('active');
      const showingExtensibility = !extensibilityPanel.hidden;
      showAxisPreview(template, previewContainer, showingExtensibility ? checkedAxes() : null);
    });
    actions.appendChild(previewBtn);

    const renameBtn = document.createElement('button');
    renameBtn.className = 'seller-row-action-btn';
    renameBtn.type = 'button';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', async () => {
      const next = prompt('Rename this product', template.name);
      if (!next || !next.trim() || next.trim() === template.name) return;
      rowStatus.textContent = '';
      rowStatus.classList.remove('error');
      renameBtn.disabled = true;
      try {
        const updated = await updateCatalogTemplate(template.templateId, { name: next.trim() });
        Object.assign(template, updated);
        label.textContent = template.name;
        buildCatalogPickerButtons();
      } catch (err) {
        rowStatus.textContent = err.message || 'Could not rename.';
        rowStatus.classList.add('error');
      } finally {
        renameBtn.disabled = false;
      }
    });
    actions.appendChild(renameBtn);

    // Duplicates the catalog row only — modelUrl is copied by reference,
    // not re-uploaded, so this is cheap and the original file is never
    // touched (deleting a template only ever removes its D1 row, never
    // the underlying R2 object — see docs/API.md). Lets a seller try
    // extensibility (or any other edit) on a copy without any risk to a
    // product they already have placed instances of, like a real scan
    // they don't want to accidentally break.
    const duplicateBtn = document.createElement('button');
    duplicateBtn.className = 'seller-row-action-btn';
    duplicateBtn.type = 'button';
    duplicateBtn.textContent = 'Duplicate';
    duplicateBtn.addEventListener('click', async () => {
      rowStatus.textContent = '';
      rowStatus.classList.remove('error');
      duplicateBtn.disabled = true;
      try {
        const copy = await createCatalogTemplate({
          name: `${template.name} (copy)`,
          dimensions: template.dimensions,
          color: template.color,
          modelUrl: template.modelUrl,
          priceCents: template.priceCents,
          metadata: template.metadata,
          // Safe to read directly (not ensureSellerIdentity()) — this only
          // ever runs while the Seller modal is open, which already
          // guaranteed one via openSellerModal().
          sellerId,
        });
        activeCatalog.push(copy);
        buildCatalogPickerButtons();
        renderSellerList();
      } catch (err) {
        rowStatus.textContent = err.message || 'Could not duplicate.';
        rowStatus.classList.add('error');
        duplicateBtn.disabled = false;
      }
    });
    actions.appendChild(duplicateBtn);

    // A hard delete — only the catalog row, never the underlying R2 model
    // (see the Duplicate comment above) — so it's recoverable by
    // re-registering the same modelUrl, just not from this UI. The
    // worker's placed_instances -> catalog_templates foreign key blocks
    // this outright (a 409) if the product is still placed anywhere,
    // rather than silently orphaning those instances — caught below and
    // reworded, since the server's own message is written for any FK
    // conflict on the API, not specifically "this product is in use."
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'seller-row-action-btn danger';
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Delete "${template.name}"? This can't be undone.`)) return;
      rowStatus.textContent = '';
      rowStatus.classList.remove('error');
      deleteBtn.disabled = true;
      try {
        await deleteCatalogTemplate(template.templateId);
        activeCatalog = activeCatalog.filter((t) => t.templateId !== template.templateId);
        buildCatalogPickerButtons();
        renderSellerList();
      } catch (err) {
        rowStatus.textContent = err.message?.includes('still in use')
          ? 'Still placed somewhere — remove those instances first, or Duplicate to edit a copy instead.'
          : err.message || 'Could not delete.';
        rowStatus.classList.add('error');
        deleteBtn.disabled = false;
      }
    });
    actions.appendChild(deleteBtn);

    // Extensibility (see docs/API.md) is a real but rare need — collapsed
    // by default so the row reads as "a product with some buttons," not
    // as a trim-configuration form. A template can be extensible on any
    // subset of its three axes at once (e.g. a wall resizable in
    // thickness, length, AND height) — each axis gets its own row here,
    // an independent checkbox plus min-length field rather than a single
    // either/or picker, and Save writes all three at once.
    const existingExtensible = extensibleAxes(template) || {};
    const extensibilityToggle = document.createElement('button');
    extensibilityToggle.className = 'seller-extensibility-toggle';
    extensibilityToggle.type = 'button';
    const anyAxisOn = () => Object.keys(existingExtensible).length > 0;
    extensibilityToggle.textContent = anyAxisOn() ? 'Extensibility (on) ▾' : 'Extensibility ▾';
    row.appendChild(extensibilityToggle);

    const extensibilityPanel = document.createElement('div');
    extensibilityPanel.className = 'seller-extensibility-panel';
    extensibilityPanel.hidden = true;
    row.appendChild(extensibilityPanel);

    const axisRows = {};
    function checkedAxes() {
      return AXIS_LIST.filter((axis) => axisRows[axis].checkbox.checked);
    }

    extensibilityToggle.addEventListener('click', () => {
      extensibilityPanel.hidden = !extensibilityPanel.hidden;
      extensibilityToggle.textContent = `${anyAxisOn() ? 'Extensibility (on)' : 'Extensibility'} ${extensibilityPanel.hidden ? '▾' : '▴'}`;
      // If this row's preview is already open, switch it between the
      // plain general view and the axis-arrow legend to match — no need
      // to open one that wasn't already showing.
      if (axisPreview?.templateId === template.templateId) {
        showAxisPreview(template, previewContainer, extensibilityPanel.hidden ? null : checkedAxes());
      }
    });

    for (const axis of AXIS_LIST) {
      const axisRow = document.createElement('label');
      axisRow.className = 'seller-axis-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !!existingExtensible[axis];

      const text = document.createElement('span');
      text.textContent = AXIS_ROW_LABELS[axis];

      const minInput = document.createElement('input');
      minInput.className = 'seller-min-input';
      minInput.type = 'number';
      minInput.step = '0.01';
      minInput.min = '0';
      minInput.placeholder = `min ${unitSuffix()}`;
      minInput.disabled = !checkbox.checked;
      if (existingExtensible[axis]) minInput.value = toDisplayLength(existingExtensible[axis].minM).toFixed(2);

      checkbox.addEventListener('change', () => {
        minInput.disabled = !checkbox.checked;
        if (axisPreview?.templateId === template.templateId) showAxisPreview(template, previewContainer, checkedAxes());
      });

      axisRow.appendChild(checkbox);
      axisRow.appendChild(text);
      axisRow.appendChild(minInput);
      extensibilityPanel.appendChild(axisRow);
      axisRows[axis] = { checkbox, minInput };
    }

    const saveBtn = document.createElement('button');
    saveBtn.className = 'seller-save-btn';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';

    saveBtn.addEventListener('click', async () => {
      rowStatus.textContent = '';
      rowStatus.classList.remove('error');
      const nextExtensible = {};
      for (const axis of AXIS_LIST) {
        const { checkbox, minInput } = axisRows[axis];
        if (!checkbox.checked) continue;
        const minM = fromDisplayLength(Number(minInput.value));
        const maxLength = template.dimensions[AXIS_DIMENSION_KEY[axis]];
        if (!Number.isFinite(minM) || minM <= 0) {
          rowStatus.textContent = `${AXIS_ROW_LABELS[axis]} minimum length must be a positive number.`;
          rowStatus.classList.add('error');
          return;
        }
        if (minM >= maxLength) {
          rowStatus.textContent = `${AXIS_ROW_LABELS[axis]} minimum must be less than this product's own ${formatLength(maxLength)} size.`;
          rowStatus.classList.add('error');
          return;
        }
        nextExtensible[axis] = { minM };
      }
      saveBtn.disabled = true;
      try {
        // A full replace, not a merge — validateTemplate on the worker
        // side takes whatever `metadata` is sent as the template's entire
        // new metadata, so any OTHER keys already there (like
        // placeholder: true) have to be carried through here rather than
        // just sending the one key this form actually edits.
        const nextMetadata = { ...template.metadata };
        if (Object.keys(nextExtensible).length > 0) {
          nextMetadata.extensible = nextExtensible;
        } else {
          delete nextMetadata.extensible;
        }
        const updated = await updateCatalogTemplate(template.templateId, { metadata: nextMetadata });
        Object.assign(template, updated);
        Object.assign(existingExtensible, nextExtensible);
        for (const axis of AXIS_LIST) if (!nextExtensible[axis]) delete existingExtensible[axis];
        rowStatus.textContent = 'Saved.';
        extensibilityToggle.textContent = `${anyAxisOn() ? 'Extensibility (on)' : 'Extensibility'} ${extensibilityPanel.hidden ? '▾' : '▴'}`;
      } catch (err) {
        rowStatus.textContent = err.message || 'Could not save.';
        rowStatus.classList.add('error');
      } finally {
        saveBtn.disabled = false;
      }
    });

    extensibilityPanel.appendChild(saveBtn);
    row.appendChild(rowStatus);
    sellerListEl.appendChild(row);
  }
}

// Ensures a seller identity is active before showing the modal. Only
// reachable via the #mode-nav Sell tab (openSellerModal call sites below),
// which calls this rather than separately remembering to await
// ensureSellerIdentity() first.
async function openSellerModal() {
  await ensureSellerIdentity();
  renderSellerList();
  sellerModalEl.classList.add('visible');
}
function closeSellerModal() {
  sellerModalEl.classList.remove('visible');
  disposeAxisPreview();
  // A save in here can change whether the currently-selected item (if any)
  // is extensible — updateSelectionUI() only normally re-runs on an actual
  // selection *change*, so without this the Trim button/field would keep
  // showing whatever was true when the modal opened, stale until the
  // builder reselected something.
  updateSelectionUI();
}
sellerCloseBtn.addEventListener('click', closeSellerModal);

// Settings: local, per-device display preferences — nothing here is ever
// sent to the server (see settings.js). Four sections exist as fixed tabs
// per the product ask even though only General/Units has a real setting
// today; Shop/Build/Sell show a placeholder rather than inventing controls
// nobody asked for yet.
const settingsModalEl = document.getElementById('settings-modal');
const settingsTabsEl = document.getElementById('settings-tabs');
const settingsSectionEl = document.getElementById('settings-section');
const settingsBtn = document.getElementById('settings-btn');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const trimUnitLabelEls = [...document.querySelectorAll('.trim-unit-label')];

let activeSettingsTab = 'general';

// Called whenever the Units preference changes, so every on-screen length
// reflects it immediately rather than only after the next selection change
// or modal reopen.
function refreshUnitDisplays() {
  for (const el of trimUnitLabelEls) el.textContent = unitSuffix();
  updateTrimLengthInput();
  if (sellerModalEl.classList.contains('visible')) renderSellerList();
}

function renderSettingsSection() {
  settingsSectionEl.innerHTML = '';
  for (const btn of settingsTabsEl.querySelectorAll('.settings-tab-btn')) {
    btn.classList.toggle('active', btn.dataset.section === activeSettingsTab);
  }

  if (activeSettingsTab !== 'general') {
    const note = document.createElement('div');
    note.className = 'settings-empty-note';
    note.textContent = 'Nothing to configure here yet.';
    settingsSectionEl.appendChild(note);
    return;
  }

  const field = document.createElement('div');
  field.className = 'settings-field';
  const fieldLabel = document.createElement('span');
  fieldLabel.textContent = 'Units';
  field.appendChild(fieldLabel);

  const radioRow = document.createElement('div');
  radioRow.className = 'settings-radio-row';
  const currentUnits = getUnits();
  for (const [value, optionLabel] of [['m', 'Meters'], ['ft', 'Feet']]) {
    const optionLabelEl = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'settings-units';
    radio.value = value;
    radio.checked = currentUnits === value;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      setUnits(value);
      refreshUnitDisplays();
    });
    optionLabelEl.appendChild(radio);
    optionLabelEl.appendChild(document.createTextNode(optionLabel));
    radioRow.appendChild(optionLabelEl);
  }
  field.appendChild(radioRow);
  settingsSectionEl.appendChild(field);
}

for (const btn of settingsTabsEl.querySelectorAll('.settings-tab-btn')) {
  btn.addEventListener('click', () => {
    activeSettingsTab = btn.dataset.section;
    renderSettingsSection();
  });
}

function openSettingsModal() {
  renderSettingsSection();
  settingsModalEl.classList.add('visible');
}
function closeSettingsModal() {
  settingsModalEl.classList.remove('visible');
}
settingsBtn.addEventListener('click', openSettingsModal);
settingsCloseBtn.addEventListener('click', closeSettingsModal);
// Only the static unit suffix needs painting at load — updateTrimLengthInput()
// depends on selectedMeshes, declared further below, and no-ops correctly
// (there's nothing selected yet) once that's ready.
for (const el of trimUnitLabelEls) el.textContent = unitSuffix();

// Only one gizmo is ever attached at a time. Showing both simultaneously
// was tried first and rejected: the rotate ring and the translate handles
// can occupy the same screen pixels at some angles/zoom levels, and each
// TransformControls instance hit-tests independently, so a single drag
// could trigger both at once (move AND rotate from one gesture). A mode
// toggle — the same convention Blender/Unity use — avoids that outright.
const modeControlsEl = document.getElementById('gizmo-mode-controls');
const modeMoveBtn = document.getElementById('mode-move');
const modeRotateBtn = document.getElementById('mode-rotate');
const modeTrimBtn = document.getElementById('mode-trim');
const trimLengthControlEl = document.getElementById('trim-length-control');
const trimAxisFieldEls = [...document.querySelectorAll('.trim-axis-field')];
// The active axis field's own input, or null when none is active — used
// wherever code needs to read/write "the field for whichever axis is
// currently being cropped" without re-querying the DOM each time.
function trimInputEl(axis) {
  return trimAxisFieldEls.find((field) => field.dataset.trimAxis === axis)?.querySelector('.trim-length-input') ?? null;
}
const modeResizeBtn = document.getElementById('mode-resize');
const resizeScaleControlEl = document.getElementById('resize-scale-control');
const resizeScaleInputEl = document.getElementById('resize-scale-input');
const snapToggleBtn = document.getElementById('toggle-snap');
const copyBtn = document.getElementById('copy-item');
const deleteBtn = document.getElementById('delete-item');
const multiSelectBtn = document.getElementById('toggle-multiselect');
const measureBtn = document.getElementById('toggle-measure');
const pasteBtn = document.getElementById('paste-btn');
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');

// Snapshot-based rather than per-action command objects: a "snapshot" is
// just the same plain instance-shape persistLayout()/instanceFromMesh()
// already produce, so undo/redo is "swap the whole layout for an earlier
// one" instead of needing a separate inverse operation authored for each
// of place/delete/move/rotate/paste. Simpler to get right, and this app's
// instance counts are small enough that diffing/rebuilding the scene on
// every undo is cheap.
const undoStack = [];
const redoStack = [];
const UNDO_HISTORY_LIMIT = 50;

function captureSnapshot() {
  return productMeshes.map((mesh) => instanceFromMesh(mesh));
}

function updateUndoRedoButtons() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
}

// Called right *before* any action that mutates the placed layout (place,
// delete, and the start of a move/rotate drag) — capturing the state as it
// was going into that action, so undoing it restores exactly that.
function pushUndoSnapshot() {
  undoStack.push(captureSnapshot());
  if (undoStack.length > UNDO_HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0; // a new action invalidates whatever redo history existed
  updateUndoRedoButtons();
}

// Reconciles the live scene to match a target snapshot: removes whatever's
// no longer in it, repositions/re-syncs whatever's still there, and
// re-creates whatever's missing (e.g. undoing a delete). A mesh surviving
// the jump is the *same* mesh object (only its position/rotation change),
// so it stays selected across the jump — only meshes actually removed here
// (e.g. undoing a Place, or redoing a Delete) drop out of the selection.
// Undoing a move/rotate is the common case and never touches this loop at
// all: nothing was added or removed, so nothing here needs to change.
async function restoreSnapshot(snapshot) {
  const targetIds = new Set(snapshot.map((inst) => inst.instanceId));
  const deletedIds = [];
  for (const mesh of [...productMeshes]) {
    if (!targetIds.has(mesh.userData.instanceId)) {
      if (selectedMeshes.has(mesh)) {
        removeSelectionOutline(mesh);
        selectedMeshes.delete(mesh);
      }
      deletedIds.push(mesh.userData.instanceId);
      deleteInstance(mesh, { sync: false });
    }
  }
  const currentById = new Map(productMeshes.map((mesh) => [mesh.userData.instanceId, mesh]));
  const updatedMeshes = [];
  const createdMeshes = [];
  for (const inst of snapshot) {
    let mesh = currentById.get(inst.instanceId);
    if (mesh) {
      mesh.position.set(inst.x, inst.y, inst.z);
      mesh.rotation.set(inst.rotationX, inst.rotationY, inst.rotationZ);
      mesh = await replaceMeshWithCrop(mesh, inst.crop);
      // replaceMeshWithCrop only reconciles crop — a Resize scale change
      // (with no crop change alongside it, the common case for an undo/redo
      // jump across just a resize) would otherwise never get restored on a
      // *reused* mesh, since the rebuild path above only triggers on an
      // actual crop difference and carries the mesh's own (stale) scale
      // forward when it does. Position (already restored above) was
      // captured at whatever scale was in effect at snapshot time, so it
      // doesn't need re-deriving here — only the scale itself does.
      mesh.scale.setScalar(inst.scale ?? 1);
      mesh.userData.scale = inst.scale ?? 1;
      mesh.userData.safePosition = mesh.position.clone();
      updatedMeshes.push(mesh);
    } else {
      const newMesh = await addInstanceToScene(inst);
      if (newMesh) createdMeshes.push(newMesh);
    }
  }
  updateSelectionUI();
  persistLayout();
  // A jump that touches many instances at once (e.g. undoing a big paste)
  // is exactly the case syncBatchCreate/Update/Delete exist for — see their
  // doc comment. The three don't overlap (disjoint instance IDs), so
  // there's no ordering to get wrong running them together.
  await Promise.all([
    syncBatchDelete(deletedIds),
    syncBatchUpdate(updatedMeshes),
    syncBatchCreate(createdMeshes),
  ]);
}

async function undo() {
  if (undoStack.length === 0) return;
  const previous = undoStack.pop();
  redoStack.push(captureSnapshot());
  await restoreSnapshot(previous);
  updateUndoRedoButtons();
}

async function redo() {
  if (redoStack.length === 0) return;
  const next = redoStack.pop();
  undoStack.push(captureSnapshot());
  await restoreSnapshot(next);
  updateUndoRedoButtons();
}

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

// Every axis a template declares extensible (see extensibleAxes) gets its
// own Trim handle shown at once — a template like a wall resizable in
// thickness, length, and height all at once declares all three, while
// most (a door, a lumber board) only ever declare one. trimControls'
// own setup above permanently disables the plane/uniform-corner handles
// that would otherwise let two or three axes get dragged together, so
// showing every declared axis's individual handle simultaneously is safe
// — each still crops exactly one axis at a time (see the
// dragging-changed listener, which determines trimAxis fresh per drag).
function attachTrimControls(mesh) {
  const axes = extensibleAxes(mesh.userData.template) || {};
  trimControls.showX = !!axes.x;
  trimControls.showY = !!axes.y;
  trimControls.showZ = !!axes.z;
  trimControls.attach(mesh);
  updateTrimLengthInput();
}

// Reflects the selected item's current cropped length into each active
// axis's numeric field, and shows/hides those fields to match which axes
// this template actually declares extensible — called on selection change
// and right after a drag-driven trim commits, so nothing ever shows a
// stale value or a field for an axis this item can't be trimmed on.
function updateTrimLengthInput() {
  if (selectedMeshes.size !== 1) return;
  const [mesh] = selectedMeshes;
  const axes = extensibleAxes(mesh.userData.template) || {};
  for (const field of trimAxisFieldEls) {
    const axis = field.dataset.trimAxis;
    const active = !!axes[axis];
    field.classList.toggle('active', active);
    if (!active) continue;
    const length = effectiveLength(mesh.userData.template, mesh.userData, axis, AXIS_DIMENSION_KEY[axis]);
    field.querySelector('.trim-length-input').value = toDisplayLength(length).toFixed(2);
  }
}

let currentGizmoMode = 'translate';
function setGizmoMode(mode) {
  currentGizmoMode = mode;
  modeMoveBtn.classList.toggle('active', mode === 'translate');
  modeRotateBtn.classList.toggle('active', mode === 'rotate');
  modeTrimBtn.classList.toggle('active', mode === 'trim');
  modeResizeBtn.classList.toggle('active', mode === 'resize');
  translateControls.detach();
  rotateControls.detach();
  trimControls.detach();
  scaleControls.detach();
  trimLengthControlEl.classList.remove('visible');
  resizeScaleControlEl.classList.remove('visible');
  if (selectedMeshes.size === 1) {
    const [mesh] = selectedMeshes;
    if (mode === 'trim') {
      // Not every selection can be trimmed — fall back to Move rather than
      // leaving every gizmo detached and nothing visibly attached at all.
      if (!extensibleAxes(mesh.userData.template)) return setGizmoMode('translate');
      attachTrimControls(mesh);
      trimLengthControlEl.classList.add('visible');
      return;
    }
    if (mode === 'resize') {
      scaleControls.attach(mesh);
      updateResizeScaleInput();
      resizeScaleControlEl.classList.add('visible');
      return;
    }
    // 'local' is what makes moving a single item along its own rotated
    // orientation feel natural (see translateControls' own setup comment);
    // a group has no single orientation to align to, so the pivot below
    // uses 'world' instead — this restores 'local' when coming back to a
    // single selection.
    translateControls.space = 'local';
    (mode === 'translate' ? translateControls : rotateControls).attach(mesh);
    return;
  }
  if (selectedMeshes.size > 1 && mode === 'translate') {
    groupMovePivot.position.copy(getSelectionPivot());
    translateControls.space = 'world';
    translateControls.attach(groupMovePivot);
  }
}

// Measure: a lightweight ruler for questions none of the placement tools
// answer on their own — "are these two courses of Wall - White stacked
// exactly 10 feet high?" is easy to eyeball wrong and tedious to work out
// from individual item heights by hand. Tap two points (either a placed
// item's own surface or bare ground — see resolveMeasurePoint, which
// reuses handlePlacementClick's own product-vs-ground raycast) and read
// the straight-line distance, plus its X/Y/Z breakdown so a nearly-but-
// not-quite-vertical pair of taps still reads its intended height
// correctly. A third tap starts a fresh measurement rather than adding a
// third point — this is a quick one-shot ruler, not a running total.
let measureMode = false;
let measurePointA = null;

const MEASURE_COLOR = 0xffee33;
const measureMarkerGeometry = new THREE.SphereGeometry(0.06, 12, 12);
const measureMarkerMaterial = new THREE.MeshBasicMaterial({ color: MEASURE_COLOR, depthTest: false });
const measureMarkerA = new THREE.Mesh(measureMarkerGeometry, measureMarkerMaterial);
const measureMarkerB = new THREE.Mesh(measureMarkerGeometry, measureMarkerMaterial);
measureMarkerA.visible = false;
measureMarkerB.visible = false;
measureMarkerA.renderOrder = 999;
measureMarkerB.renderOrder = 999;
scene.add(measureMarkerA, measureMarkerB);

const measureLineGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const measureLineMaterial = new THREE.LineDashedMaterial({ color: MEASURE_COLOR, dashSize: 0.15, gapSize: 0.08, depthTest: false });
const measureLine = new THREE.Line(measureLineGeometry, measureLineMaterial);
measureLine.visible = false;
measureLine.renderOrder = 999;
scene.add(measureLine);

function clearMeasurement() {
  measurePointA = null;
  measureMarkerA.visible = false;
  measureMarkerB.visible = false;
  measureLine.visible = false;
}

function updateMeasureInfo() {
  productInfoEl.textContent = measurePointA
    ? 'Measure: tap a second point.'
    : 'Measure: tap a point to start.';
}

// The same "a placed item's own surface wins over bare ground beneath it"
// raycast handlePlacementClick uses for tap-to-place, so a measurement can
// land precisely on, say, the top face of a stacked course rather than
// only ever reaching the ground plane underneath everything.
function resolveMeasurePoint() {
  const productHits = raycaster.intersectObjects(productMeshes, true);
  const groundHits = raycaster.intersectObject(landlet);
  if (productHits.length > 0 && (groundHits.length === 0 || productHits[0].distance < groundHits[0].distance)) {
    return productHits[0].point;
  }
  if (groundHits.length > 0) return groundHits[0].point;
  return null;
}

function handleMeasureClick() {
  const point = resolveMeasurePoint();
  if (!point) return;
  if (!measurePointA) {
    measurePointA = point.clone();
    measureMarkerA.position.copy(measurePointA);
    measureMarkerA.visible = true;
    measureMarkerB.visible = false;
    measureLine.visible = false;
    updateMeasureInfo();
    return;
  }
  measureMarkerB.position.copy(point);
  measureMarkerB.visible = true;
  measureLineGeometry.setFromPoints([measurePointA, point]);
  measureLine.computeLineDistances();
  measureLine.visible = true;
  const dx = Math.abs(point.x - measurePointA.x);
  const dy = Math.abs(point.y - measurePointA.y);
  const dz = Math.abs(point.z - measurePointA.z);
  const distance = measurePointA.distanceTo(point);
  productInfoEl.textContent =
    `${formatLength(distance)} — Δx ${formatLength(dx)}, Δy ${formatLength(dy)}, Δz ${formatLength(dz)} (tap to start a new measurement)`;
  measurePointA = null; // next tap begins a fresh measurement, per the message above
}

// Multi-Select and Move/Rotate are sibling tools that can't both be active
// (see updateSelectionUI's multiSelectMode branch) — pressing either gizmo
// button while multi-select is on exits multi-select first, without
// touching the selection it just built, so "whatever's already selected"
// is exactly what ends up under the gizmo.
function exitMultiSelectMode() {
  if (!multiSelectMode) return;
  multiSelectMode = false;
  multiSelectBtn.classList.remove('active');
  controls.enableRotate = true;
}
// Measure is its own sibling tool too — taps while it's on place ruler
// points rather than selecting or swiping, so switching to any selection-
// based tool exits it first (and clears whatever half-finished measurement
// was on screen), the same hand-off exitMultiSelectMode gives Move/Rotate.
function exitMeasureMode() {
  if (!measureMode) return;
  measureMode = false;
  measureBtn.classList.remove('active');
  clearMeasurement();
  updateSelectionUI();
}
modeMoveBtn.addEventListener('click', () => {
  exitMultiSelectMode();
  exitMeasureMode();
  setGizmoMode('translate');
});
modeRotateBtn.addEventListener('click', () => {
  exitMultiSelectMode();
  exitMeasureMode();
  setGizmoMode('rotate');
});
modeTrimBtn.addEventListener('click', () => {
  exitMultiSelectMode();
  exitMeasureMode();
  setGizmoMode('trim');
});
modeResizeBtn.addEventListener('click', () => {
  exitMultiSelectMode();
  exitMeasureMode();
  setGizmoMode('resize');
});

// Exact-value alternative to the drag handles above — typing a length
// commits the same way releasing a handle does: an undo snapshot, a
// clamped, non-stretched geometry rebuild, and a sync to the backend. One
// listener per axis field, each bound to its own axis (not the shared
// `trimAxis` variable, which only ever reflects whichever axis a drag is
// currently live on) — so editing, say, the Height field always crops z
// regardless of which handle (if any) was last dragged.
for (const field of trimAxisFieldEls) {
  const axis = field.dataset.trimAxis;
  const input = field.querySelector('.trim-length-input');
  input.addEventListener('change', async () => {
    if (selectedMeshes.size !== 1) return;
    const [mesh] = selectedMeshes;
    const template = mesh.userData.template;
    const extensible = extensibleAxes(template)?.[axis];
    if (!extensible) return;
    const maxLength = template.dimensions[AXIS_DIMENSION_KEY[axis]];
    const requestedDisplayLength = Number(input.value);
    if (!Number.isFinite(requestedDisplayLength)) {
      updateTrimLengthInput(); // revert to the last valid value
      return;
    }
    const requestedLength = fromDisplayLength(requestedDisplayLength);
    const clampedLength = THREE.MathUtils.clamp(requestedLength, extensible.minM, maxLength);
    pushUndoSnapshot();
    const updated = await replaceMeshWithCrop(mesh, { ...mesh.userData.crop, [axis]: clampedLength });
    const clamped = clampToLandlet(updated, updated.position.x, updated.position.y, updated.position.z);
    updated.position.set(clamped.x, clamped.y, clamped.z);
    updated.userData.safePosition = updated.position.clone();
    trimControls.attach(updated);
    persistLayout();
    syncUpdate(updated);
    updateTrimLengthInput();
  });
}

// Exact-value alternative to the Resize drag handle above — typing a
// percentage commits the same way releasing the handle does: an undo
// snapshot and a sync to the backend.
resizeScaleInputEl.addEventListener('change', async () => {
  if (selectedMeshes.size !== 1) return;
  const [mesh] = selectedMeshes;
  const requestedPercent = Number(resizeScaleInputEl.value);
  if (!Number.isFinite(requestedPercent) || requestedPercent <= 0) {
    updateResizeScaleInput(); // revert to the last valid value
    return;
  }
  const uniform = THREE.MathUtils.clamp(requestedPercent / 100, MIN_SCALE, MAX_SCALE);
  pushUndoSnapshot();
  mesh.scale.setScalar(uniform);
  keepRestingOnScaleChange(mesh, mesh.userData.scale ?? 1, uniform);
  mesh.userData.scale = uniform;
  const clamped = clampToLandlet(mesh, mesh.position.x, mesh.position.y, mesh.position.z);
  mesh.position.set(clamped.x, clamped.y, clamped.z);
  mesh.userData.safePosition = mesh.position.clone();
  persistLayout();
  syncUpdate(mesh);
  updateResizeScaleInput();
});

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
const selectionOutlines = new Map(); // mesh -> { helper: THREE.BoxHelper, fill: THREE.Mesh }

// A row of touching, identically-shaped items (a brick course, say) makes a
// wireframe-only outline ambiguous — the shared edge between a selected
// brick and its unselected neighbor looks the same either way. Adding a
// translucent fill over the selected item's own bounding volume (not just
// its edges) makes it unambiguous which volume is selected. The fill reuses
// a unit BoxGeometry and is rescaled/repositioned every frame (see animate)
// rather than rebuilding geometry, since BoxGeometry itself can't resize.
// Slightly padded larger than the helper's own box to avoid z-fighting
// against the item's own surface, which a same-size box would sit flush
// against.
const SELECTION_FILL_PADDING = 1.04;
const SELECTION_FILL_OPACITY = 0.45;
const selectionFillGeometry = new THREE.BoxGeometry(1, 1, 1);
const scratchBox = new THREE.Box3();
const scratchBoxSize = new THREE.Vector3();
const scratchBoxCenter = new THREE.Vector3();

function addSelectionOutline(mesh) {
  if (selectionOutlines.has(mesh)) return;
  const helper = new THREE.BoxHelper(mesh, SELECTION_OUTLINE_COLOR);
  scene.add(helper);

  const fillMaterial = new THREE.MeshBasicMaterial({
    color: SELECTION_OUTLINE_COLOR,
    transparent: true,
    opacity: SELECTION_FILL_OPACITY,
    depthWrite: false,
  });
  const fill = new THREE.Mesh(selectionFillGeometry, fillMaterial);
  scene.add(fill);

  selectionOutlines.set(mesh, { helper, fill });
}

function removeSelectionOutline(mesh) {
  const entry = selectionOutlines.get(mesh);
  if (!entry) return;
  scene.remove(entry.helper);
  entry.helper.geometry.dispose();
  entry.helper.material.dispose();
  scene.remove(entry.fill);
  entry.fill.material.dispose();
  selectionOutlines.delete(mesh);
}

// Reconciles every visible bit of "what's selected" UI (highlight already
// applied by the caller — this only handles text/panels/gizmo) with the
// current selectedMeshes set. Called after any change to that set.
function updateSelectionUI() {
  if (measureMode) {
    // Measure is its own exclusive mode (see exitMeasureMode) — the gizmo
    // stays fully detached and hidden the whole time it's on, the same
    // hand-off multiSelectMode gets below, but productInfoEl is left alone
    // here since Measure manages its own status text (see updateMeasureInfo
    // and handleMeasureClick) rather than a plain selection summary. The
    // selection itself (and its highlight) is untouched, exactly like
    // multiSelectMode below, so whatever was selected before Measure was
    // turned on is still selected once it's turned back off.
    modeControlsEl.classList.remove('visible');
    trimLengthControlEl.classList.remove('visible');
    resizeScaleControlEl.classList.remove('visible');
    translateControls.detach();
    rotateControls.detach();
    trimControls.detach();
    scaleControls.detach();
    return;
  }
  const count = selectedMeshes.size;
  if (count === 0) {
    productInfoEl.textContent = HINT_TEXT;
    modeControlsEl.classList.remove('visible');
    trimLengthControlEl.classList.remove('visible');
    resizeScaleControlEl.classList.remove('visible');
    translateControls.detach();
    rotateControls.detach();
    trimControls.detach();
    scaleControls.detach();
    return;
  }
  productInfoEl.textContent = count === 1 ? [...selectedMeshes][0].userData.template.name : `${count} items selected`;
  modeControlsEl.classList.add('visible');
  // Rotate has no group form (rotating several items around a shared pivot
  // while also spinning each one's own orientation is a much harder problem
  // than was asked for) — only Move is offered for a multi-item selection.
  // Disabling Rotate (rather than hiding it) keeps every other button —
  // Move, Snap, Copy, Delete — in the same position regardless of selection
  // count; removing it from the layout entirely let the rest reflow into
  // different left/right groupings depending on whether Rotate happened to
  // be there. Trim follows the same reasoning, disabled (not hidden) for
  // both a multi-item selection and a single non-extensible one. Resize
  // has no group form either (dragging several items' independent uniform
  // scales as one gesture isn't a well-defined operation) but applies to
  // any single item regardless of extensibility, unlike Trim.
  modeRotateBtn.disabled = count !== 1;
  const singleMesh = count === 1 ? [...selectedMeshes][0] : null;
  modeTrimBtn.disabled = !singleMesh || !extensibleAxes(singleMesh.userData.template);
  modeResizeBtn.disabled = !singleMesh;
  if (multiSelectMode) {
    // Multi-Select and Move/Rotate are sibling tools, not simultaneous ones
    // — the gizmo stays hidden the whole time multi-select is on, so it
    // can't clutter (or steal a drag from) the exact view a builder needs
    // clear while tapping/swiping across items. The Move/Rotate buttons
    // stay visible and clickable so the builder can jump straight from a
    // freshly built selection into moving/rotating it — clicking either
    // turns multi-select off itself (see their handlers below) and
    // reattaches the gizmo to whatever's already selected here.
    modeMoveBtn.classList.remove('active');
    modeRotateBtn.classList.remove('active');
    modeTrimBtn.classList.remove('active');
    modeResizeBtn.classList.remove('active');
    trimLengthControlEl.classList.remove('visible');
    resizeScaleControlEl.classList.remove('visible');
    translateControls.detach();
    rotateControls.detach();
    trimControls.detach();
    scaleControls.detach();
    return;
  }
  if (count === 1) {
    setGizmoMode(currentGizmoMode);
  } else {
    currentGizmoMode = 'translate';
    setGizmoMode('translate');
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

multiSelectBtn.addEventListener('click', () => {
  exitMeasureMode();
  multiSelectMode = !multiSelectMode;
  multiSelectBtn.classList.toggle('active', multiSelectMode);
  // One-finger drag is repurposed as a selection swipe while multi-select
  // is on (see the swipe-select handlers below) instead of orbiting the
  // camera — two-finger pan/pinch-zoom are untouched.
  controls.enableRotate = !multiSelectMode;
  // Whatever's already selected carries into (and out of) multi-select
  // rather than being cleared — toggling multi-select on with an item
  // already selected (from a single tap) lets the builder immediately
  // start adding more to it instead of losing that first item and having
  // to reselect it. Symmetric with Move/Rotate's own hand-off, which acts
  // on whatever was already selected when leaving multi-select (see
  // modeMoveBtn/modeRotateBtn and updateSelectionUI's multiSelectMode
  // branch, which is what actually hides the gizmo while this is true).
  updateSelectionUI();
});

measureBtn.addEventListener('click', () => {
  exitMultiSelectMode();
  measureMode = !measureMode;
  measureBtn.classList.toggle('active', measureMode);
  if (measureMode) {
    updateSelectionUI(); // hides the gizmo panel; see its own measureMode branch
    updateMeasureInfo();
  } else {
    clearMeasurement();
    updateSelectionUI();
  }
});

deleteBtn.addEventListener('click', () => {
  if (selectedMeshes.size === 0) return;
  pushUndoSnapshot();
  const meshes = [...selectedMeshes];
  const instanceIds = meshes.map((mesh) => mesh.userData.instanceId);
  clearSelection();
  updateSelectionUI();
  for (const mesh of meshes) deleteInstance(mesh, { sync: false });
  syncBatchDelete(instanceIds);
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
  const baseZ = Math.min(...meshes.map((mesh) => mesh.position.z - meshDimensions(mesh).height / 2));
  clipboard = meshes.map((mesh) => ({
    templateId: mesh.userData.template.templateId,
    dx: mesh.position.x - centroidX,
    dy: mesh.position.y - centroidY,
    dz: mesh.position.z - baseZ,
    rotationX: mesh.rotation.x,
    rotationY: mesh.rotation.y,
    rotationZ: mesh.rotation.z,
    crop: mesh.userData.crop,
    scale: mesh.userData.scale ?? 1,
  }));
  pasteBtn.disabled = false;
  // There's nothing left to multi-select once the copy is captured, and
  // multi-select repurposes a one-finger drag into a selection swipe —
  // leaving it on would strand the builder without the ability to rotate
  // the camera while navigating to a spot to paste.
  exitMultiSelectMode();
  const count = meshes.length;
  productInfoEl.textContent = `Copied ${count} item${count === 1 ? '' : 's'}`;
  // The status text above is easy to miss since it's well away from the
  // button itself — a brief press flash (see .pressed in index.html) gives
  // feedback right where the tap happened, the same way a physical button's
  // own travel would, rather than swapping the label to "Copied!" (which
  // reads more like the button now does something different).
  copyBtn.classList.add('pressed');
  setTimeout(() => copyBtn.classList.remove('pressed'), 150);
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
  // Multi-select repurposes a one-finger drag into a selection swipe (see
  // the swipe-select handlers below) instead of orbiting the camera —
  // useful while building a selection, but there's nothing left to select
  // during placement (the pending items are already captured), so leaving
  // it on would just strand the builder without the ability to rotate the
  // view while lining up where to place/paste.
  exitMultiSelectMode();
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

// Anchors a paste to the current selection's location — the centroid in
// X/Y (a single item's own position, if only one is selected), resting on
// top of whichever selected item is tallest so the pasted group never
// starts out embedded in one it's landing on.
function selectionPlacementAnchor() {
  if (selectedMeshes.size === 0) return null;
  const meshes = [...selectedMeshes];
  const centroid = getSelectionPivot();
  const supportZ = Math.max(...meshes.map((mesh) => mesh.position.z + meshDimensions(mesh).height / 2));
  return { x: centroid.x, y: centroid.y, supportZ };
}

let clipboard = null;
pasteBtn.addEventListener('click', async () => {
  if (!clipboard) return;
  catalogPickerEl.classList.remove('visible');
  // Something's already selected — paste right there instead of making the
  // builder tap a second time to say where, the same way pasting next to
  // what you just copied would work in any other editor.
  const anchor = selectionPlacementAnchor();
  if (anchor) {
    exitMultiSelectMode();
    pushUndoSnapshot();
    await placeClipboardItems(clipboard, anchor.x, anchor.y, anchor.supportZ);
    return;
  }
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

// Spawns a copied group anchored at (x, y, supportZ) — shared by both ways
// a paste can be anchored: tapping a spot in the world (handlePlacementClick)
// and pasting directly at whatever's already selected (see pasteBtn above).
// Caller is responsible for pushUndoSnapshot() beforehand, since the
// tap-a-spot flow shares that snapshot with the template-placement branch
// alongside it.
async function placeClipboardItems(items, x, y, supportZ) {
  const placed = [];
  for (const item of items) {
    const template = findTemplate(item.templateId);
    if (!template) continue;
    const mesh = await spawnInstanceAt(template, x + item.dx, y + item.dy, supportZ + item.dz, {
      rotationX: item.rotationX,
      rotationY: item.rotationY,
      rotationZ: item.rotationZ,
      crop: item.crop,
      scale: item.scale,
    }, { sync: false });
    if (mesh) placed.push(mesh);
  }
  clearSelection();
  for (const mesh of placed) {
    selectedMeshes.add(mesh);
    addSelectionOutline(mesh);
  }
  updateSelectionUI();
  // One batched request (chunked, see syncBatchCreate) instead of one
  // fire-and-forget request per pasted item — pasting a wall-sized group
  // is exactly the size of paste that used to risk losing a few silently.
  await syncBatchCreate(placed);
}

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

  const supportZ = supportingMesh ? supportingMesh.position.z + meshDimensions(supportingMesh).height / 2 : 0;

  const pending = pendingPlacement;
  pendingPlacement = null;
  addItemBtn.textContent = '+ Add Item';
  pushUndoSnapshot();

  if (pending.type === 'template') {
    const mesh = await spawnInstanceAt(pending.template, point.x, point.y, supportZ + pending.template.dimensions.height / 2);
    selectOnly(mesh);
  } else {
    await placeClipboardItems(pending.items, point.x, point.y, supportZ);
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

  if (measureMode) {
    handleMeasureClick();
    return;
  }

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

// Swipe-to-select: while multi-select is on, dragging across several items
// (a course of bricks, say) adds every one the finger passes over, instead
// of requiring a separate tap per item. One-finger drag is free for this
// because multi-select mode already disables OrbitControls' rotate (see
// the multiSelectBtn handler above); two-finger pan/pinch still work
// normally throughout.
//
// A plain tap-to-toggle (the click handler above) must keep working too, so
// this only starts actually adding items once the drag has moved past the
// same threshold the click handler uses to tell a tap from a drag — a
// stationary tap never triggers this, only a genuine swipe does.
let swipePointerId = null;
let swipeStartPos = null;
let swipeArmed = false; // true once this gesture has moved enough to count as a swipe, not a tap

// A second finger landing mid-swipe means the gesture is becoming a
// two-finger pan/pinch, not a selection swipe — the first finger's
// continued movement is now driving the camera, not picking items. Without
// tracking this, the swipe kept adding whatever the first finger passed
// over for the rest of the gesture, even while zooming/panning. Counted
// independently of the other pointer-count tracking further down (for the
// camera-recenter gesture check) since that one increments on the *same*
// pointerdown event this listener also reads, and registration order
// between separate listeners isn't something to depend on.
let activeSwipeTouchCount = 0;

renderer.domElement.addEventListener('pointerdown', (event) => {
  activeSwipeTouchCount++;
  if (activeSwipeTouchCount > 1) {
    swipePointerId = null;
    swipeStartPos = null;
    swipeArmed = false;
    return;
  }
  // A single selected item still shows its move/rotate gizmo even in
  // multi-select mode (see updateSelectionUI) — grabbing that gizmo must
  // not also be read as the start of a selection swipe. TransformControls'
  // own pointerdown handling (registered earlier, so it runs first) sets
  // `.dragging` synchronously when a handle is grabbed, so it's already
  // accurate by the time this listener runs.
  if (!multiSelectMode || pendingPlacement || swipePointerId !== null) return;
  if (translateControls.dragging || rotateControls.dragging) return;
  swipePointerId = event.pointerId;
  swipeStartPos = { x: event.clientX, y: event.clientY };
  swipeArmed = false;
});

function addToSelectionBySwipe(mesh) {
  if (!mesh || selectedMeshes.has(mesh)) return;
  selectedMeshes.add(mesh);
  addSelectionOutline(mesh);
  updateSelectionUI();
}

function addWhateverIsAtClientPos(x, y) {
  raycaster.setFromCamera(ndcFromEvent({ clientX: x, clientY: y }), camera);
  const hits = raycaster.intersectObjects(productMeshes, true);
  if (hits.length === 0) return;
  addToSelectionBySwipe(findRootProduct(hits[0].object));
}

window.addEventListener('pointermove', (event) => {
  if (event.pointerId !== swipePointerId || !swipeStartPos) return;
  if (translateControls.dragging || rotateControls.dragging) return;
  const dx = event.clientX - swipeStartPos.x;
  const dy = event.clientY - swipeStartPos.y;
  if (!swipeArmed) {
    if (Math.hypot(dx, dy) <= CLICK_DRAG_THRESHOLD_PX) return;
    swipeArmed = true;
    // A real swipe starts by touching down ON an item — without this, that
    // first item (whatever the finger landed on, before crossing the
    // tap-vs-drag threshold above) never gets a chance to be raycast at all
    // and silently drops out of the swipe, which is exactly wrong for
    // closely-packed items like a course of bricks where the threshold
    // alone can already cover the gap to the *next* one.
    addWhateverIsAtClientPos(swipeStartPos.x, swipeStartPos.y);
  }
  addWhateverIsAtClientPos(event.clientX, event.clientY);
});

function endSwipe(event) {
  activeSwipeTouchCount = Math.max(0, activeSwipeTouchCount - 1);
  if (event.pointerId !== swipePointerId) return;
  swipePointerId = null;
  swipeStartPos = null;
  swipeArmed = false;
}
window.addEventListener('pointerup', endSwipe);
window.addEventListener('pointercancel', endSwipe);

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
  // A tap-to-select that never moved enough to count as a rotate (see the
  // "change" handler below) never got the chance to consume this itself —
  // clear it here so it can't leak into whatever gesture comes next.
  if (activePointerCount === 0) pendingGestureCheck = false;
});
window.addEventListener('pointercancel', () => {
  activePointerCount = Math.max(0, activePointerCount - 1);
  if (activePointerCount === 0) pendingGestureCheck = false;
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
    const isRotate = controls.state === ROTATE_STATE || controls.state === TOUCH_ROTATE_STATE;
    if (!isRotate) {
      pendingGestureCheck = false;
    } else {
      // A tap that's about to *select* a different product also starts out
      // looking exactly like a one-finger rotate to OrbitControls (touch
      // jitter between press and release is enough to fire this "change"
      // event) — recentering here immediately would jump to whatever's
      // *currently* selected for an instant, since the tap's own "click"
      // handler (which would change the selection) hasn't run yet at this
      // point. Only committing to the recenter once real movement has
      // happened — reusing the same threshold the click handler itself
      // uses to tell a tap from a drag — means a plain tap never triggers
      // this at all, only an actual rotate does.
      const moved = lastPointerClientPos && pointerDownPos
        ? Math.hypot(lastPointerClientPos.x - pointerDownPos.x, lastPointerClientPos.y - pointerDownPos.y)
        : 0;
      if (moved > CLICK_DRAG_THRESHOLD_PX) {
        pendingGestureCheck = false;
        // With nothing selected there's nothing to recenter onto — two
        // earlier attempts at guessing a stand-in pivot (raycasting from the
        // gesture's start point, then from the screen's center) each fixed
        // one complaint but introduced another: a visible jump right as the
        // rotate began, since whatever the raycast hit rarely matched
        // wherever controls.target already was. Orbiting around the
        // existing target — the same target panning already set, unchanged
        // by rotating — is what a plain rotate is expected to feel like:
        // no shift at all.
        const pivot = getSelectionPivot();
        if (pivot) beginTargetTween(pivot);
      }
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
const EDGE_PAN_MAX_PAN_FROM_DRAG_START_M = 15;
// Orbiting is already kept above ground by controls.maxPolarAngle, but that
// only constrains OrbitControls' own rotation math — it has no say over a
// direct camera.position mutation like this one. Dragging an item down
// toward the ground routinely puts the pointer near the bottom edge (the
// ground is lower on screen than the item started), which is exactly when
// this fires, so without its own floor this was the one path that could
// carry the camera through the ground.
const CAMERA_MIN_HEIGHT_M = 0.3;
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
  // Shorten just the offset's vertical component, not the whole vector, so
  // a diagonal pan still slides sideways at full speed right up to the
  // floor instead of stopping dead the instant the floor is reached.
  if (offset.z < 0) {
    const headroom = camera.position.z - CAMERA_MIN_HEIGHT_M;
    offset.z = Math.max(offset.z, -Math.max(headroom, 0));
  }
  camera.position.add(offset);
  controls.target.add(offset);
}

function edgeStrength(distanceFromEdge) {
  if (distanceFromEdge >= EDGE_PAN_ZONE_PX) return 0;
  return 1 - Math.max(distanceFromEdge, 0) / EDGE_PAN_ZONE_PX;
}

// TransformControls remembers where the pointer's screen position hit an
// invisible drag plane at drag-start, using the camera at that instant —
// then, on every later pointer event, re-intersects that *same* plane
// using whichever camera exists *now*. Panning the camera mid-drag (see
// applyEdgePanWhileDraggingProduct) is exactly this: the finger hasn't
// moved, but the camera has, so the identical screen position now maps to
// a different 3D point, and the dragged item silently jumps by roughly
// however far the camera just moved — nothing in the UI shows this
// happened, only the final position looks wrong. Simulating a pointer-up
// immediately followed by a pointer-down at that same screen position
// re-anchors the drag to the post-pan camera before any further pointer
// movement can compound with the error. The axis is saved and restored
// directly (rather than re-detected via a fresh hover raycast) so a pan
// large enough to nudge the handle's screen position by a pixel can't
// cause the resync itself to lose the drag. suppressDragCycleSideEffects
// keeps this synthetic up/down pair from being read as a real drag
// ending and restarting (see wireDraggingBehavior).
function resyncTransformControlsDrag(transformControls, clientX, clientY) {
  if (!transformControls.dragging) return;
  const axis = transformControls.axis;
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -((clientY - rect.top) / rect.height) * 2 + 1,
    button: 0,
  };
  suppressDragCycleSideEffects = true;
  transformControls.pointerUp(null);
  transformControls.axis = axis;
  transformControls.pointerDown(pointer);
  suppressDragCycleSideEffects = false;
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
    // The resync above re-anchors the drag plane every frame, but after the
    // camera has panned far enough from where the drag started, the plane
    // raycast itself becomes numerically unstable (the plane is nearly
    // edge-on to the view ray), which can snap the dragged object on the
    // next real pointer move. Capping cumulative edge-pan displacement
    // (relative to the camera's position when the drag began, not distance
    // to the object — a normal drag already starts with the camera tens of
    // meters from the object) keeps the camera clear of that zone.
    if (edgePanDragStartCameraPos) {
      const panned = camera.position.distanceTo(edgePanDragStartCameraPos);
      if (panned >= EDGE_PAN_MAX_PAN_FROM_DRAG_START_M) return;
    }
    panCameraByScreenPixels(dx, dy);
    resyncTransformControlsDrag(translateControls, x, y);
  }
}

function animate(now) {
  requestAnimationFrame(animate);
  if (shopActive) {
    updateShopMovement(now);
  } else {
    updateTargetTween(now);
    applyEdgePanWhileDraggingProduct();
    controls.update();
    updateCameraDebug(now);
  }
  // A selected item's outline must track it live while the translate/rotate
  // gizmo drags it — BoxHelper doesn't auto-update, so it's recomputed here
  // every frame rather than only on selection change. The fill mesh reuses
  // the helper's own freshly-computed box rather than recomputing its own,
  // so the two never drift out of sync with each other.
  for (const [mesh, { helper, fill }] of selectionOutlines) {
    helper.update();
    // BoxHelper computes its world-aligned box internally without exposing
    // it (no public `.box` on this three.js version), so the fill mesh
    // recomputes the same box independently rather than reading it back off
    // the helper.
    scratchBox.setFromObject(mesh);
    scratchBox.getSize(scratchBoxSize);
    scratchBox.getCenter(scratchBoxCenter);
    fill.scale.copy(scratchBoxSize).multiplyScalar(SELECTION_FILL_PADDING);
    fill.position.copy(scratchBoxCenter);
  }
  renderer.render(scene, camera);
}
animate(0);

// Which landlet this session builds on: a builder's own claimed landlet if
// they already have one, otherwise a modal letting them claim a fresh one
// from whatever's currently available. Landlets start as `greenbelt`
// (claimable) once procedurally generated and enclosed by the growing world
// circle — see docs/API.md's world/landlet sections. If the backend is
// unreachable, this throws and bootstrap()'s own fallback below takes over
// before the modal is ever shown, same as it always has for catalog/instance
// fetches — there's nothing to claim in offline/local-fallback mode.
async function resolveLandletId() {
  const owned = await fetchLandlets({ status: 'claimed', ownerBuilderId: builderId, limit: 1 });
  if (owned.length > 0) return owned[0].landletId;
  return runClaimFlow();
}

// Dev-only stand-in for accounts: no passwords, just a locally-kept list of
// IDs (see builderIdentity.js) a builder can add to, rename, and switch
// between — e.g. to claim more than one landlet for testing. The same
// modal DOM also serves the entirely separate seller roster (see
// sellerIdentity.js/docs/API.md's "Sellers" section) — one shared UI
// parameterized by an IDENTITY_KINDS config below, rather than two
// near-identical modals, since only one identity flow is ever in
// progress at a time. Each kind's own menu (runIdentityMenu) blocks
// bootstrap() (builder) or the Sell nav/seller-identity button (seller)
// until one is chosen (mandatory — no Close button); the switcher buttons
// (#identity-btn / #seller-identity-btn) reopen it any time afterward to
// switch or rename (Close button shown, since there's already an active
// choice to dismiss back to).
const identityBtn = document.getElementById('identity-btn');
const sellerIdentityBtn = document.getElementById('seller-identity-btn');
const identityModalEl = document.getElementById('identity-modal');
const identityModalTitleEl = document.getElementById('identity-modal-title');
const identityHintEl = document.getElementById('identity-hint');
const identityListEl = document.getElementById('identity-list');
const identityNewBtn = document.getElementById('identity-new-btn');
const identityStatusEl = document.getElementById('identity-status');
const identityCloseBtn = document.getElementById('identity-close-btn');

const IDENTITY_KINDS = {
  builder: {
    noun: 'builder',
    idField: 'builderId',
    fetch: fetchBuilders,
    create: createBuilder,
    rename: renameBuilder,
    delete: deleteBuilder,
    deleteConfirm: (label) => `Delete "${label}"? Any land it owns is cleared and goes back to available — not just removed from this list.`,
    hint: 'Dev-only stand-in for login — no accounts, just IDs kept in this browser. Pick one to build as, rename any of them, or add a new one.',
    // Only the builder flow can be reached mid-startup, before any scene
    // has committed to Build — a seller identity is only ever needed once
    // already inside Shop/Build/wherever the Sell tap happened, so
    // "go to Shop instead" isn't a meaningful escape hatch there.
    showShopEscape: true,
  },
  seller: {
    noun: 'seller',
    idField: 'sellerId',
    fetch: fetchSellers,
    create: createSeller,
    rename: renameSeller,
    delete: deleteSeller,
    deleteConfirm: (label) => `Delete "${label}"? Its existing products stay in the catalog but lose their seller link.`,
    hint: 'Dev-only stand-in for login — no accounts, just IDs kept in this browser. Pick one to sell as, rename any of them, or add a new one.',
    showShopEscape: false,
  },
};

// Which kind the modal is currently showing, and its live onChoose
// callback (runIdentityMenu's vs a switcher's) — both set whenever the
// modal opens, read by the per-row Choose buttons and #identity-new-btn
// (a fresh row needs the same kind/callback wired up as everything else
// currently on screen).
let identityKind = IDENTITY_KINDS.builder;
let identityOnChoose = null;

// The roster itself is fetched fresh from the server every time the modal
// opens (see docs/API.md's "Builders"/"Sellers" sections) — it's shared
// across devices now, so a stale local copy could easily be missing an
// identity someone just created or deleted elsewhere.
async function renderIdentityList() {
  const kind = identityKind;
  identityHintEl.textContent = kind.hint;
  shopBtn.style.display = kind.showShopEscape ? '' : 'none';
  identityListEl.innerHTML = '';
  identityStatusEl.textContent = `Loading ${kind.noun}s…`;
  identityStatusEl.classList.remove('error');
  let identities;
  try {
    identities = await kind.fetch();
  } catch (err) {
    identityStatusEl.textContent = err.message || `Could not load ${kind.noun}s.`;
    identityStatusEl.classList.add('error');
    return;
  }
  identityStatusEl.textContent = '';

  for (const identity of identities) {
    const id = identity[kind.idField];
    const row = document.createElement('div');
    row.className = 'identity-row';

    const info = document.createElement('div');
    info.className = 'identity-row-info';
    const labelEl = document.createElement('div');
    labelEl.className = 'identity-row-label';
    labelEl.textContent = identity.label;
    const idEl = document.createElement('div');
    idEl.className = 'identity-row-id';
    idEl.textContent = id;
    info.append(labelEl, idEl);

    const actions = document.createElement('div');
    actions.className = 'identity-row-actions';
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', async () => {
      const next = prompt(`Rename this ${kind.noun}`, identity.label);
      if (!next || !next.trim()) return;
      try {
        await kind.rename(id, next.trim());
      } catch (err) {
        identityStatusEl.textContent = err.message || 'Could not rename.';
        identityStatusEl.classList.add('error');
      }
      renderIdentityList();
    });
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      // Shared across devices now, so the confirm matters more than it
      // used to — see each kind's own deleteConfirm for what's at stake.
      if (!confirm(kind.deleteConfirm(identity.label))) return;
      try {
        await kind.delete(id);
      } catch (err) {
        identityStatusEl.textContent = err.message || 'Could not delete.';
        identityStatusEl.classList.add('error');
      }
      renderIdentityList();
    });
    const chooseBtn = document.createElement('button');
    chooseBtn.type = 'button';
    chooseBtn.className = 'identity-choose-btn';
    chooseBtn.textContent = 'Play';
    chooseBtn.addEventListener('click', () => identityOnChoose(id));
    actions.append(renameBtn, deleteBtn, chooseBtn);

    row.append(info, actions);
    identityListEl.appendChild(row);
  }
}

function runIdentityMenu(kind, setActiveId) {
  return new Promise((resolve) => {
    identityKind = kind;
    identityModalTitleEl.textContent = `Choose a ${kind.noun}`;
    identityCloseBtn.style.display = 'none';
    identityOnChoose = (id) => {
      setActiveId(id);
      identityModalEl.classList.remove('visible');
      resolve(id);
    };
    identityModalEl.classList.add('visible');
    renderIdentityList();
  });
}

// Sell only ever needs an identity, not a claimed landlet (the Seller
// modal reads just activeCatalog + sellerId — see myProducts()) — so
// reaching it from Shop mode, which never runs bootstrap()'s own builder
// menu, still needs *some* way to resolve one. Sharing a single in-flight
// promise (rather than always calling runIdentityMenu() fresh) matters
// because bootstrap()'s own Build-mode flow can be awaiting the builder
// menu at the very moment the Sell nav button is tapped — two independent
// runIdentityMenu() calls would each set their own identityOnChoose, and
// the second silently overwrites the first, leaving the other's own await
// hanging forever with no way to resolve. Builder and seller each need
// their own promise here, not one shared — both flows can genuinely be
// in flight together (Build mode's own startup menu and a Sell tap).
let builderIdentityFlowPromise = null;
function ensureBuilderIdentity() {
  if (builderId) return Promise.resolve(builderId);
  if (!builderIdentityFlowPromise) {
    builderIdentityFlowPromise = runIdentityMenu(IDENTITY_KINDS.builder, setActiveBuilderId).then((id) => {
      builderId = id;
      builderIdentityFlowPromise = null;
      return id;
    });
  }
  return builderIdentityFlowPromise;
}

let sellerIdentityFlowPromise = null;
function ensureSellerIdentity() {
  if (sellerId) return Promise.resolve(sellerId);
  if (!sellerIdentityFlowPromise) {
    sellerIdentityFlowPromise = runIdentityMenu(IDENTITY_KINDS.seller, setActiveSellerId).then((id) => {
      sellerId = id;
      sellerIdentityFlowPromise = null;
      return id;
    });
  }
  return sellerIdentityFlowPromise;
}

// Shared by #identity-btn and the claim modal's Back button — the identity
// modal sits at a higher z-index than the claim modal (see index.html) so
// it can overlay it without needing to hide/reopen the claim modal
// underneath: choosing the same builder just closes back to it unchanged,
// and choosing a different one reloads (which tears down and rebuilds
// everything, claim modal included, for the new builder).
function openBuilderSwitcher() {
  identityKind = IDENTITY_KINDS.builder;
  identityModalTitleEl.textContent = 'Builder identity';
  identityCloseBtn.style.display = '';
  identityOnChoose = (id) => {
    identityModalEl.classList.remove('visible');
    if (id === builderId) return; // already this builder — nothing to reload
    setActiveBuilderId(id);
    // Only reachable from Build mode (see SHOP_HIDDEN_BUILDER_UI_IDS) — the
    // reload should land back in Build for the new builder, not bounce out
    // to Shop, the default a bare reload would otherwise pick.
    sessionStorage.setItem(START_MODE_KEY, 'build');
    location.reload();
  };
  identityModalEl.classList.add('visible');
  renderIdentityList();
}

// Reachable only from inside the (already-open) Seller modal — unlike the
// builder switcher, switching seller identity doesn't need a reload:
// nothing about the Build/Shop scene depends on which seller is active,
// only which catalog templates myProducts() considers "mine," so a
// straight re-render of the seller list is enough.
function openSellerSwitcher() {
  identityKind = IDENTITY_KINDS.seller;
  identityModalTitleEl.textContent = 'Seller identity';
  identityCloseBtn.style.display = '';
  identityOnChoose = (id) => {
    identityModalEl.classList.remove('visible');
    if (id === sellerId) return; // already this seller — nothing to refresh
    setActiveSellerId(id);
    sellerId = id;
    renderSellerList();
  };
  identityModalEl.classList.add('visible');
  renderIdentityList();
}

identityBtn.addEventListener('click', openBuilderSwitcher);
sellerIdentityBtn.addEventListener('click', openSellerSwitcher);

identityCloseBtn.addEventListener('click', () => {
  identityModalEl.classList.remove('visible');
});

identityNewBtn.addEventListener('click', async () => {
  const kind = identityKind;
  const label = prompt(`Name this ${kind.noun}`, '');
  if (!label || !label.trim()) return;
  try {
    await kind.create(label.trim());
  } catch (err) {
    identityStatusEl.textContent = err.message || `Could not create ${kind.noun}.`;
    identityStatusEl.classList.add('error');
  }
  renderIdentityList();
});

// Shop: a visitor mode reached straight from the builder-choice screen, no
// identity needed, since visiting doesn't build or claim anything. Unlike
// the claim flyover (a separate small canvas/renderer showing a top-down
// map you tap to select a plot), Shop is full-screen continuous flight
// through the real world using the *same* scene/camera/renderer the
// builder view uses — reused rather than duplicated, partly to avoid
// fighting mobile browsers' low limit on simultaneous WebGL contexts, and
// partly because "the same ground/instance data, seen from a moving
// camera" is genuinely the same rendering problem the builder scene
// already solves for one landlet, just for many at once.
//
// Every landlet has an absolute world position (center_x_m/center_y_m);
// every placed instance's x/y is local to its own landlet (see
// docs/API.md) — so an instance's true position here is
// landlet.center + instance.(x,y). Each landlet gets a THREE.Group
// positioned at that center, and its instances are added as children at
// their ordinary local coordinates, so nothing about createMeshForInstance
// itself needs to know Shop mode exists.
const shopStatusEl = document.getElementById('shop-status');
const shopHintEl = document.getElementById('shop-hint');
const shopBtn = document.getElementById('shop-btn');
const shopMoveJoystickEl = document.getElementById('shop-move-joystick');
const shopMoveKnobEl = shopMoveJoystickEl.querySelector('.shop-joystick-knob');
const shopLookJoystickEl = document.getElementById('shop-look-joystick');
const shopLookKnobEl = shopLookJoystickEl.querySelector('.shop-joystick-knob');
const shopVerticalControlsEl = document.getElementById('shop-vertical-controls');
const shopUpBtn = document.getElementById('shop-up-btn');
const shopDownBtn = document.getElementById('shop-down-btn');

const SHOP_PLOT_COLORS = { greenbelt: 0x6ca42e, claimed: 0x888888, generating: 0xd99a3f };
const SHOP_MOVE_SPEED_M_S = 14;
const SHOP_LOOK_SPEED_RAD_S = 1.8;
const SHOP_VERTICAL_SPEED_M_S = 10;
const SHOP_MIN_HEIGHT_M = 1.5;
const SHOP_MAX_PITCH = Math.PI * 0.47;
const SHOP_JOYSTICK_MAX_PX = 46;
const SHOP_JOYSTICK_DEADZONE_PX = 6;
const SHOP_LOAD_RADIUS_M = 60;
const SHOP_UNLOAD_RADIUS_M = 90;
const SHOP_PROXIMITY_INTERVAL_MS = 400;
// The world wall: an opaque ring standing at exactly the current world
// radius, tall enough that nothing generating out beyond it (still
// unclaimable — see the availability circle in docs/SPEC.md) is visible
// past the edge, and a matching radial clamp on the camera so it's a real
// boundary, not just a backdrop — the builder can never fly past it to see
// around it. A land straddling the boundary still shows whatever fraction
// of it sits inside — anywhere from a sliver to nearly the whole shape —
// which is the correct, intentional look here, not a bug to hide.
const SHOP_WALL_HEIGHT_M = 60;
const SHOP_WALL_MARGIN_M = 1.5; // small ground/wall seam overlap only — see wildGround below
// How far the camera must stay from the wall's own radius. Separate from
// (and much larger than) SHOP_WALL_MARGIN_M above: that one only needs to
// hide a cosmetic seam between the ground and the wall's base, but standing
// right up against the wall and swinging the camera from looking straight
// down back up past horizontal let a viewer glimpse past the wall — right
// at a grazing, near-tangent angle the wall's own paper-thin (zero
// thickness, single-sided) geometry doesn't reliably cover the view the
// way a real solid wall would. Keeping the camera meaningfully back from
// the wall means that grazing angle is never actually reachable by normal
// look input. Scales down for a small gapless world (see
// computeGaplessWorldRadius) so it can't eat most of a tiny world's
// playable area, but never drops below a floor that's still enough to
// avoid the grazing-angle case on any world.
const SHOP_WALL_CLEARANCE_M = 6;
const SHOP_WALL_CLEARANCE_MIN_M = 2;
// A dome caps the wall's open top, and both share one continuous vertical
// gradient (pale ground-green at the base, through a hazy horizon blend
// right at the wall/dome seam, up to a deeper sky blue at the dome's own
// apex) painted directly as vertex colors rather than a texture — see
// paintVerticalGradient. The illusion this is going for is a horizon that
// recedes into atmospheric haze and open sky, not a wall the world
// visibly stops at.
const SHOP_GROUND_HORIZON_COLOR = new THREE.Color(0xa8d98a); // the wall's own former flat color, now just its base
const SHOP_HAZY_HORIZON_COLOR = new THREE.Color(0xcfe8dc); // where wall meets dome — both gradients hit this exact color, so the seam is invisible
const SHOP_SKY_DOME_COLOR = new THREE.Color(0x5a9fd4); // deeper than the flat backdrop sky (0x87ceeb) for a sense of real overhead depth
// The dome's rise above the wall's own top — independent of the wall's
// rim radius (set via non-uniform scale, see enterShopMode) so a bigger
// world doesn't need a proportionately taller dome. Grows on its own if
// something built anywhere in the world is ever discovered taller than
// this provides clearance for — see growShopDomeIfNeeded.
const SHOP_DOME_INITIAL_RISE_M = SHOP_WALL_HEIGHT_M;
const SHOP_DOME_CLEARANCE_MARGIN_M = 5;
// Skip building a ground mesh for a landlet with no chance of being seen
// (entirely beyond the wall, comfortably past any land's own footprint) —
// pure cost-cutting as the world grows, never aggressive enough to risk
// hiding a real sliver.
const SHOP_LANDLET_CULL_MARGIN_M = 40;
// A wide range on purpose — Shop's "zoom" is a pure lens effect (the
// free-flying camera never actually moves closer/farther, see setShopFov's
// own comment), so there's no dolly-clipping-through-geometry risk that
// would otherwise argue for a narrower range. 6deg is a strong telephoto
// (roughly 10x magnification versus the 60deg default), 100deg is past
// human peripheral vision into genuine ultra-wide territory.
const SHOP_MIN_FOV_DEG = 6;
const SHOP_MAX_FOV_DEG = 100;
const SHOP_WHEEL_ZOOM_SENSITIVITY = 0.05;
const SHOP_PINCH_ZOOM_SENSITIVITY = 0.05;

let shopWorldRadiusM = null;
let shopDomeMesh = null;
let shopDomeRiseM = SHOP_DOME_INITIAL_RISE_M;

// Colors a geometry per-vertex along its own local "up" axis (the axis
// CylinderGeometry/SphereGeometry both author height/pole along before any
// Z-up rotation is applied), calling colorAt(localUp, out) for every
// vertex — a plain vertical gradient needs nothing fancier than that, and
// staying in each geometry's own local space means the result is
// independent of any later position/rotation/scale, so growShopDomeIfNeeded
// scaling the dome taller never has to repaint it.
function paintVerticalGradient(geometry, colorAt) {
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const out = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    colorAt(position.getY(i), out);
    colors[i * 3] = out.r;
    colors[i * 3 + 1] = out.g;
    colors[i * 3 + 2] = out.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// Called as each Shop-mode landlet's instances load in (see
// loadShopLandletInstances) — if anything anywhere in the world turns out
// to be tall enough to threaten poking through the dome, grow the dome to
// keep clearing it rather than ever letting a real build clip through a
// backdrop. Purely reactive to what's actually been loaded so far (Shop
// only loads a landlet's instances once the camera gets near it — see
// updateShopProximity), not a global precomputed guarantee.
function growShopDomeIfNeeded(object) {
  if (!shopDomeMesh) return;
  const box = new THREE.Box3().setFromObject(object);
  const neededRise = box.max.z - SHOP_WALL_HEIGHT_M + SHOP_DOME_CLEARANCE_MARGIN_M;
  if (neededRise <= shopDomeRiseM) return;
  shopDomeRiseM = neededRise;
  shopDomeMesh.scale.y = shopDomeRiseM;
}

let shopYaw = 0;
let shopPitch = -0.12;
// -1..1 each, driven continuously by joystick deflection (see
// bindShopJoystick below) and consumed every animate() frame in
// updateShopMovement — not per-pointer-move deltas like the old
// whole-screen drag-to-steer this replaced.
let shopMoveX = 0;
let shopMoveY = 0;
let shopLookX = 0;
let shopLookY = 0;
let shopLastFrameTime = null;
let shopLastProximityCheck = 0;
const shopLandlets = new Map(); // landletId -> { record, group, loaded, objects }
const shopWorldObjects = []; // ground meshes + the wild backdrop — disposed together on exit

// THREE's camera looks down its own local -Z by default, with +Y as local
// "up" — a convention for a Y-up world, not this app's Z-up one. Composing
// yaw (world Z) and pitch (local X) directly on top of that default, with
// no correction, points "yaw=0, pitch=0" straight down at the ground
// instead of level at the horizon: pitch's rotation axis is fine (X stays
// X either way), but the *forward* it's pitching away from is wrong.
// SHOP_BASE_QUAT reorients the default forward from world -Z to world +Y
// (level, matching camera.up.set(0,0,1)'s Z-up convention already used
// everywhere else in this app) before yaw/pitch are ever applied, so
// pitch=0 means level and pitch's sign means what it looks like it means.
const SHOP_BASE_QUAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

function applyShopCameraOrientation() {
  const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), shopYaw);
  const pitchQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), shopPitch);
  camera.quaternion.copy(yawQuat).multiply(pitchQuat).multiply(SHOP_BASE_QUAT);
}

// A standard dual-joystick mobile scheme: the left stick walks (forward/
// back/strafe, relative to the camera's current facing), the right stick
// looks (yaw/pitch). Each joystick tracks its own pointer via
// setPointerCapture so both thumbs work at once regardless of where the
// finger wanders once it's down — and each calls stopPropagation() so the
// builder scene's own product-drag/multi-select/gizmo listeners (registered
// on the canvas and on window) never see these events, without needing
// every one of those individually guarded against firing during Shop mode.
function bindShopJoystick(baseEl, knobEl, onChange) {
  let pointerId = null;
  let originX = 0;
  let originY = 0;

  function setKnob(x, y) {
    knobEl.style.transform = `translate(${x}px, ${y}px)`;
  }

  function update(clientX, clientY) {
    const dx = clientX - originX;
    const dy = clientY - originY;
    const dist = Math.hypot(dx, dy);
    if (dist < SHOP_JOYSTICK_DEADZONE_PX) {
      setKnob(0, 0);
      onChange(0, 0);
      return;
    }
    const clamped = Math.min(dist, SHOP_JOYSTICK_MAX_PX);
    const knobX = (dx / dist) * clamped;
    const knobY = (dy / dist) * clamped;
    setKnob(knobX, knobY);
    onChange(knobX / SHOP_JOYSTICK_MAX_PX, knobY / SHOP_JOYSTICK_MAX_PX);
  }

  function end(event) {
    if (event.pointerId !== pointerId) return;
    event.stopPropagation();
    pointerId = null;
    setKnob(0, 0);
    onChange(0, 0);
  }

  baseEl.addEventListener('pointerdown', (event) => {
    if (!shopActive || pointerId !== null) return;
    event.stopPropagation();
    event.preventDefault();
    pointerId = event.pointerId;
    originX = event.clientX;
    originY = event.clientY;
    baseEl.setPointerCapture(pointerId);
  });
  baseEl.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    event.stopPropagation();
    update(event.clientX, event.clientY);
  });
  baseEl.addEventListener('pointerup', end);
  baseEl.addEventListener('pointercancel', end);
}
bindShopJoystick(shopMoveJoystickEl, shopMoveKnobEl, (x, y) => {
  shopMoveX = x;
  shopMoveY = y;
});
bindShopJoystick(shopLookJoystickEl, shopLookKnobEl, (x, y) => {
  shopLookX = x;
  shopLookY = y;
});

// Altitude, as a separate concern from walking (which deliberately stays
// horizontal — see updateShopMovement's own comment) and from zoom (a pure
// lens effect, never actual movement — see SHOP_MIN_FOV_DEG's own
// comment): press-and-hold buttons, not a third joystick, since two thumbs
// already cover walk+look and a vertical-only third stick would be an
// awkward, cramped addition to a phone screen already busy with both
// hands. +1 while Up is held, -1 while Down, 0 otherwise, consumed every
// animate() frame in updateShopMovement exactly like shopMoveX/Y already are.
let shopVerticalInput = 0;
function bindShopVerticalButton(el, direction) {
  let pointerId = null;
  el.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    pointerId = event.pointerId;
    el.setPointerCapture(pointerId);
    el.classList.add('active');
    shopVerticalInput = direction;
  });
  const end = (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    el.classList.remove('active');
    if (shopVerticalInput === direction) shopVerticalInput = 0;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', end);
}
bindShopVerticalButton(shopUpBtn, 1);
bindShopVerticalButton(shopDownBtn, -1);

// Zoom: narrows/widens the camera's own field of view rather than moving
// it — there's no "target" to dolly toward like OrbitControls' zoom has,
// just a free-flying camera, so a lens-zoom is the natural equivalent.
// Wheel for desktop, pinch for touch. Both live on the canvas itself
// rather than the joysticks, so a thumb already on either stick never
// fights with a zoom gesture — pinching needs both fingers on open canvas,
// exactly where a joystick drag isn't.
function setShopFov(fov) {
  camera.fov = THREE.MathUtils.clamp(fov, SHOP_MIN_FOV_DEG, SHOP_MAX_FOV_DEG);
  camera.updateProjectionMatrix();
}
renderer.domElement.addEventListener('wheel', (event) => {
  if (!shopActive) return;
  event.preventDefault();
  setShopFov(camera.fov + event.deltaY * SHOP_WHEEL_ZOOM_SENSITIVITY);
}, { passive: false });

const shopPinchPointers = new Map(); // pointerId -> {x, y}
let shopPinchStartDistance = null;
let shopPinchStartFov = null;
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (!shopActive) return;
  shopPinchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (shopPinchPointers.size === 2) {
    const [a, b] = [...shopPinchPointers.values()];
    shopPinchStartDistance = Math.hypot(a.x - b.x, a.y - b.y);
    shopPinchStartFov = camera.fov;
  }
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!shopActive || !shopPinchPointers.has(event.pointerId)) return;
  shopPinchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (shopPinchPointers.size === 2 && shopPinchStartDistance !== null) {
    const [a, b] = [...shopPinchPointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    setShopFov(shopPinchStartFov - (distance - shopPinchStartDistance) * SHOP_PINCH_ZOOM_SENSITIVITY);
  }
});
function shopPinchEnd(event) {
  shopPinchPointers.delete(event.pointerId);
  if (shopPinchPointers.size < 2) {
    shopPinchStartDistance = null;
    shopPinchStartFov = null;
  }
}
renderer.domElement.addEventListener('pointerup', shopPinchEnd);
renderer.domElement.addEventListener('pointercancel', shopPinchEnd);

const shopForward = new THREE.Vector3();
const shopRight = new THREE.Vector3();

// Shared by walking's own floor clamp and the vertical Up/Down buttons —
// keeps the camera between the ground and comfortably below the dome's
// current apex (see SHOP_DOME_CLEARANCE_MARGIN_M), the same "a real
// boundary, not just a backdrop" treatment the radial wall clamp already
// gets just below this. The dome's own apex can grow over the course of a
// session (see growShopDomeIfNeeded), so this is recomputed fresh each
// call rather than cached.
function clampShopCameraHeight() {
  const maxHeight = SHOP_WALL_HEIGHT_M + shopDomeRiseM - SHOP_DOME_CLEARANCE_MARGIN_M;
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, SHOP_MIN_HEIGHT_M, maxHeight);
}

function updateShopMovement(now) {
  if (shopLastFrameTime === null) {
    shopLastFrameTime = now;
    return;
  }
  const dt = Math.min((now - shopLastFrameTime) / 1000, 0.1); // clamp against tab-switch-sized gaps
  shopLastFrameTime = now;

  if (shopLookX !== 0 || shopLookY !== 0) {
    shopYaw -= shopLookX * SHOP_LOOK_SPEED_RAD_S * dt;
    shopPitch = Math.max(
      -SHOP_MAX_PITCH,
      Math.min(SHOP_MAX_PITCH, shopPitch - shopLookY * SHOP_LOOK_SPEED_RAD_S * dt),
    );
    applyShopCameraOrientation();
  }

  if (shopMoveX !== 0 || shopMoveY !== 0) {
    // Movement stays in the horizontal plane (forward/right with their Z
    // dropped) so looking up or down while walking doesn't fly the camera
    // into the ground or sky — walking, not free flight.
    camera.getWorldDirection(shopForward);
    shopForward.z = 0;
    if (shopForward.lengthSq() > 1e-6) shopForward.normalize();
    shopRight.setFromMatrixColumn(camera.matrixWorld, 0);
    shopRight.z = 0;
    if (shopRight.lengthSq() > 1e-6) shopRight.normalize();

    camera.position.addScaledVector(shopForward, -shopMoveY * SHOP_MOVE_SPEED_M_S * dt);
    camera.position.addScaledVector(shopRight, shopMoveX * SHOP_MOVE_SPEED_M_S * dt);
    clampShopCameraHeight();

    // The world wall (see enterShopMode) is a real boundary, not just a
    // backdrop — keep the camera inside it the same way the floor clamp
    // above keeps it above ground.
    if (shopWorldRadiusM !== null) {
      const clearance = Math.max(
        SHOP_WALL_CLEARANCE_MIN_M,
        Math.min(SHOP_WALL_CLEARANCE_M, shopWorldRadiusM * 0.15),
      );
      const maxRadius = shopWorldRadiusM - clearance;
      const distance = Math.hypot(camera.position.x, camera.position.y);
      if (distance > maxRadius) {
        const scale = maxRadius / distance;
        camera.position.x *= scale;
        camera.position.y *= scale;
      }
    }
  }

  // A separate concern from walking (see the comment above): press-and-hold
  // Up/Down buttons that move the camera straight along world Z, regardless
  // of look direction or whether the walk joystick is also active.
  if (shopVerticalInput !== 0) {
    camera.position.z += shopVerticalInput * SHOP_VERTICAL_SPEED_M_S * dt;
    clampShopCameraHeight();
  }

  if (now - shopLastProximityCheck >= SHOP_PROXIMITY_INTERVAL_MS) {
    shopLastProximityCheck = now;
    updateShopProximity();
  }
}

function updateShopProximity() {
  for (const entry of shopLandlets.values()) {
    if (entry.record.status !== 'claimed') continue; // nothing built to show for anything else
    const distance = Math.hypot(entry.record.center.x - camera.position.x, entry.record.center.y - camera.position.y);
    if (!entry.loaded && distance < SHOP_LOAD_RADIUS_M) {
      entry.loaded = true; // set before awaiting so a second tick can't double-load
      loadShopLandletInstances(entry);
    } else if (entry.loaded && distance > SHOP_UNLOAD_RADIUS_M) {
      unloadShopLandletInstances(entry);
    }
  }
}

async function loadShopLandletInstances(entry) {
  let instances;
  try {
    instances = await fetchInstances(entry.record.landletId);
  } catch {
    entry.loaded = false; // allow a later pass to retry
    return;
  }
  for (const instance of instances) {
    if (!entry.loaded) return; // unloaded again while this was in flight
    const object = await createMeshForInstance(instance);
    if (!object || !entry.loaded) continue;
    entry.group.add(object);
    entry.objects.push(object);
    growShopDomeIfNeeded(object);
  }
}

function disposeObject3D(object) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material?.dispose();
  });
}

function unloadShopLandletInstances(entry) {
  entry.loaded = false;
  for (const object of entry.objects) {
    entry.group.remove(object);
    disposeObject3D(object);
  }
  entry.objects = [];
}

// The normal builder UI (toolbar, product hint, camera debug, undo/redo,
// the Identity pill) belongs to the single-landlet editing experience —
// none of it applies while visiting, and left showing it would just
// overlap Shop's own overlay. There's nothing to restore on the way out:
// leaving Shop mode (via #mode-nav's Build/Sell buttons) reloads the page
// rather than trying to undo this.
const SHOP_HIDDEN_BUILDER_UI_IDS = [
  'identity-btn', 'undo-redo-panel', 'product-info', 'gizmo-mode-controls', 'add-item-panel', 'camera-debug-panel',
];

async function enterShopMode() {
  identityModalEl.classList.remove('visible');
  for (const el of [shopStatusEl, shopHintEl, shopMoveJoystickEl, shopLookJoystickEl, shopVerticalControlsEl]) {
    el.classList.add('visible');
  }
  for (const id of SHOP_HIDDEN_BUILDER_UI_IDS) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  shopStatusEl.textContent = 'Loading the world…';
  controls.enabled = false;

  // The builder scene's placeholder square (see applyLandletShape) has
  // nothing to do with Shop mode's own per-landlet ground meshes.
  scene.remove(landlet);
  landlet.geometry.dispose();
  landlet.material.dispose();

  // Shop can be entered without a reload — Identity -> Shop, not just
  // fresh from the builder-choice screen — so whatever was actually built
  // this session is very likely still sitting in productMeshes. Those
  // meshes are positioned in the single active landlet's *local*
  // coordinates (the builder scene only ever shows one landlet, so its
  // local origin doubles as the scene origin) rather than that landlet's
  // real world position, which is what Shop mode's own per-landlet groups
  // use. Left in place, they'd clutter the scene somewhere near the world
  // origin — disconnected from, and easily mistaken for missing/wrong
  // versions of, that same landlet's content once Shop loads it fresh (in
  // the right place) as the camera gets close. This only tears down the
  // in-memory scene, not anything on the server — nothing here is deleted,
  // just no longer shown twice in two different places.
  clearSelection();
  translateControls.detach();
  rotateControls.detach();
  for (const mesh of productMeshes) {
    scene.remove(mesh);
    disposeObject(mesh);
  }
  productMeshes.length = 0;

  try {
    activeCatalog = await fetchCatalog();
  } catch {
    activeCatalog = FALLBACK_CATALOG;
  }

  let world;
  let allLandlets;
  try {
    [world, allLandlets] = await Promise.all([fetchWorld(), fetchAllLandlets()]);
  } catch (err) {
    shopStatusEl.textContent = err.message || 'Could not load the world.';
    return;
  }

  // The wall sits at the largest gap-free radius, not the administrative
  // world radius itself — see computeGaplessWorldRadius's doc comment.
  shopWorldRadiusM = computeGaplessWorldRadius(allLandlets, world.radiusM);

  // The visible world stops at the wall — no glimpse of "wild ground" that
  // isn't actually any land's own polygon. A thin overlap keeps the ground
  // from leaving a seam right at the wall's own base.
  const wildGround = new THREE.Mesh(
    new THREE.CircleGeometry(shopWorldRadiusM + SHOP_WALL_MARGIN_M, 64),
    new THREE.MeshStandardMaterial({ color: 0x2f5e1a }),
  );
  scene.add(wildGround);
  shopWorldObjects.push(wildGround);

  const wallGeometry = new THREE.CylinderGeometry(shopWorldRadiusM, shopWorldRadiusM, SHOP_WALL_HEIGHT_M, 64, 1, true);
  paintVerticalGradient(wallGeometry, (localY, out) => {
    const t = THREE.MathUtils.clamp((localY + SHOP_WALL_HEIGHT_M / 2) / SHOP_WALL_HEIGHT_M, 0, 1);
    out.copy(SHOP_GROUND_HORIZON_COLOR).lerp(SHOP_HAZY_HORIZON_COLOR, t);
  });
  // MeshBasicMaterial (unlit) rather than Standard — a horizon/sky backdrop
  // isn't a real lit surface, so it shouldn't visibly darken on the side
  // facing away from the sun the way an actual object would.
  const wall = new THREE.Mesh(wallGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }));
  wall.rotation.x = Math.PI / 2; // THREE's cylinder stands along local Y by default — this world is Z-up
  wall.position.z = SHOP_WALL_HEIGHT_M / 2;
  scene.add(wall);
  shopWorldObjects.push(wall);

  // Caps the wall's open top so the world reads as fully enclosed — an
  // upper hemisphere (unit sphere, theta 0..PI/2) whose equator matches
  // the wall's own rim exactly (same radius, continuous gradient color at
  // the seam — see SHOP_HAZY_HORIZON_COLOR), non-uniformly scaled (X/Z to
  // the wall's radius, Y — the pole axis before Z-up rotation — to how far
  // it currently rises) so growShopDomeIfNeeded can grow it later with a
  // single scale change, no geometry rebuild.
  const domeGeometry = new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2);
  paintVerticalGradient(domeGeometry, (localY, out) => {
    const t = THREE.MathUtils.clamp(localY, 0, 1);
    out.copy(SHOP_HAZY_HORIZON_COLOR).lerp(SHOP_SKY_DOME_COLOR, t);
  });
  shopDomeRiseM = SHOP_DOME_INITIAL_RISE_M;
  shopDomeMesh = new THREE.Mesh(domeGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }));
  shopDomeMesh.rotation.x = Math.PI / 2;
  shopDomeMesh.position.z = SHOP_WALL_HEIGHT_M;
  shopDomeMesh.scale.set(shopWorldRadiusM, shopDomeRiseM, shopWorldRadiusM);
  scene.add(shopDomeMesh);
  shopWorldObjects.push(shopDomeMesh);

  for (const record of allLandlets) {
    // Nothing this far past the wall could ever show even a sliver — skip
    // building geometry for it at all rather than paying for meshes no
    // camera position can ever see.
    const distanceFromOrigin = Math.hypot(record.center.x, record.center.y);
    if (distanceFromOrigin - SHOP_LANDLET_CULL_MARGIN_M > world.radiusM) continue;

    const group = new THREE.Group();
    group.position.set(record.center.x, record.center.y, 0);
    const groundMesh = new THREE.Mesh(
      new THREE.ShapeGeometry(shapeForLandlet(record)),
      new THREE.MeshStandardMaterial({ color: SHOP_PLOT_COLORS[record.status] ?? 0x4caf50 }),
    );
    groundMesh.position.z = 0.02;
    group.add(groundMesh);
    scene.add(group);
    shopLandlets.set(record.landletId, { record, group, loaded: false, objects: [] });
  }

  camera.position.set(0, 0, 8);
  shopYaw = 0;
  shopPitch = -0.12;
  applyShopCameraOrientation();
  setShopFov(camera.fov); // re-clamp in case a previous Shop session left it zoomed
  shopLastFrameTime = null;
  shopLastProximityCheck = 0;
  shopStatusEl.textContent = '';
  shopActive = true;
}

shopBtn.addEventListener('click', () => {
  // Reached mid-identity-flow (see runBuilderMenu, still awaited by
  // bootstrap() at this point) — no reload needed since Build mode's own
  // scene never started loading yet, just a live switch straight into
  // Shop instead. bootstrap()'s own `await runBuilderMenu()` is left
  // permanently pending, harmlessly, exactly as it already was before
  // #mode-nav existed.
  currentMode = 'shop';
  updateModeNavUI();
  enterShopMode();
});

// The persistent Shop/Build/Sell switcher (#mode-nav) — see START_MODE_KEY's
// own comment for why Shop<->Build goes through a reload while Sell doesn't.
const modeNavButtons = [...document.querySelectorAll('.mode-nav-btn')];
function updateModeNavUI() {
  for (const btn of modeNavButtons) btn.classList.toggle('active', btn.dataset.mode === currentMode);
}
for (const btn of modeNavButtons) {
  btn.addEventListener('click', async () => {
    const target = btn.dataset.mode;
    if (target === 'sell') {
      // openSellerModal() itself ensures a seller identity — no builder
      // identity or claimed landlet needed to sell, only to build.
      openSellerModal();
      return;
    }
    if (target === currentMode) return;
    sessionStorage.setItem(START_MODE_KEY, target);
    location.reload();
  });
}

const claimModalEl = document.getElementById('claim-modal');
const claimMapCanvas = document.getElementById('claim-map-canvas');
const claimStatusEl = document.getElementById('claim-status');
const claimRefreshBtn = document.getElementById('claim-refresh-btn');
const claimBackBtn = document.getElementById('claim-back-btn');
const claimGrowBtn = document.getElementById('claim-grow-btn');
const claimSelectionNameEl = document.getElementById('claim-selection-name');
const claimConfirmBtn = document.getElementById('claim-confirm-btn');

function runClaimFlow() {
  return new Promise((resolve) => {
    claimModalEl.classList.add('visible');
    loadLandletMap(resolve);
    claimRefreshBtn.onclick = () => loadLandletMap(resolve);
    claimGrowBtn.onclick = () => growTheWorld(resolve);
    // openBuilderSwitcher() shows the identity modal *over* this one rather
    // than replacing it (see its own doc comment) — fine when leaving an
    // already-built scene behind, but here there's nothing built yet to
    // preserve, and its own Close/Shop paths don't touch this modal at
    // all, so backing out any way other than actually claiming something
    // (or picking a genuinely different builder, which reloads on its own)
    // left this modal sitting there underneath, popping back into view the
    // moment whatever was covering it closed — including if the builder
    // this flow is claiming for gets deleted out from under it, since
    // nothing here is listening for that either. Reloading is the same
    // clean-slate escape hatch #mode-nav's own Shop/Build switching uses
    // for the same reason: nothing here to lose, and every path (Close,
    // Shop, a different
    // builder, this same builder again) starts over correctly from
    // runBuilderMenu() either way. Explicitly targeting 'build' keeps this
    // landing back in the identity/claim flow rather than the bare
    // reload's own default of Shop.
    claimBackBtn.onclick = () => {
      sessionStorage.setItem(START_MODE_KEY, 'build');
      location.reload();
    };
  });
}

// A self-contained Three.js scene/camera/renderer/controls for the claim
// modal, entirely separate from the main builder scene (which hasn't loaded
// any content yet at this point anyway) so it can be freely created and
// torn down each time the modal opens without touching builder state.
let claimFlyover = null;

function disposeClaimFlyover() {
  if (!claimFlyover) return;
  cancelAnimationFrame(claimFlyover.animationHandle);
  window.removeEventListener('resize', claimFlyover.onResize);
  claimFlyover.controls.dispose();
  claimFlyover.renderer.dispose();
  for (const mesh of claimFlyover.plotMeshes) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  for (const outline of claimFlyover.plotOutlines) outline.geometry.dispose();
  claimFlyover.plotOutlineMaterial.dispose();
  claimFlyover.selectionOutline?.geometry.dispose();
  claimFlyover.selectionOutlineMaterial.dispose();
  claimFlyover = null;
}

function pointInPolygonXY(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = (a.y > y) !== (b.y > y)
      && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

// The mosaic tessellation guarantees no gaps *between* adjacent cells (see
// generate-mosaic's own doc comment in worker/index.js), but its outer
// edge is scalloped, not a perfect circle: some directions reach past the
// world radius, others fall short of it, since the world radius has been
// expanded several times since the mosaic was generated without new
// geometry necessarily following it out in every direction. A wall drawn
// as a plain circle at the world radius exposed bare "wild ground" in the
// short directions — real, but not part of any land, which is exactly the
// thing the wall exists to hide. This instead finds the largest circle
// that's fully covered by *some* landlet's polygon in every direction, by
// marching outward at each of many sampled angles and stopping at the
// first gap. The wall goes there, not at the administrative radius —
// landlets with geometry beyond it (the currently-generating ones) still
// get built normally and show whatever fraction of them the wall doesn't
// cut off, same as before.
const SHOP_COVERAGE_ANGLE_SAMPLES = 144;
const SHOP_COVERAGE_RADIUS_STEP_M = 2;
function computeGaplessWorldRadius(landlets, worldRadiusM) {
  const worldPolygons = landlets
    .filter((record) => record.polygon && record.polygon.length >= 3)
    .map((record) => record.polygon.map((p) => ({ x: record.center.x + p.x, y: record.center.y + p.y })));
  if (worldPolygons.length === 0) return worldRadiusM; // nothing to measure coverage against yet
  let minCovered = worldRadiusM;
  for (let i = 0; i < SHOP_COVERAGE_ANGLE_SAMPLES; i++) {
    const angle = (i / SHOP_COVERAGE_ANGLE_SAMPLES) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let covered = 0;
    for (let r = SHOP_COVERAGE_RADIUS_STEP_M; r <= worldRadiusM; r += SHOP_COVERAGE_RADIUS_STEP_M) {
      const insideAny = worldPolygons.some((polygon) => pointInPolygonXY(dx * r, dy * r, polygon));
      if (!insideAny) break;
      covered = r;
    }
    minCovered = Math.min(minCovered, covered);
  }
  return minCovered;
}

// Builds a flat THREE.Shape for a landlet: its real polygon (plot-local
// meter offsets from its own center, per docs/API.md) when the backend has
// generated one, or a plain square sized to its area as a fallback for
// legacy/placeholder landlets (e.g. starter-landlet) that predate real
// procedural generation and were never given one.
function shapeForLandlet(landlet) {
  const shape = new THREE.Shape();
  if (landlet.polygon && landlet.polygon.length >= 3) {
    shape.moveTo(landlet.polygon[0].x, landlet.polygon[0].y);
    for (const point of landlet.polygon.slice(1)) shape.lineTo(point.x, point.y);
    shape.closePath();
    return shape;
  }
  const half = Math.sqrt(landlet.areaM2) / 2;
  shape.moveTo(-half, -half);
  shape.lineTo(half, -half);
  shape.lineTo(half, half);
  shape.lineTo(-half, half);
  shape.closePath();
  return shape;
}

const CLAIM_PLOT_COLORS = { greenbelt: 0x6ca42e, claimed: 0x888888 };

// A navigable overhead flyover: an orbit-controlled camera looking down at
// a flat rendering of the whole world circle and every landlet in it, each
// shape/position/color drawn straight from real world data (no separate 2D
// projection math — a landlet's plot sits at its own center_x_m/center_y_m
// on the same X/Y ground plane the builder scene itself uses). Tapping a
// plot previews it below regardless of status; only an available
// (greenbelt) one enables the Claim button.
async function loadLandletMap(resolve) {
  claimStatusEl.textContent = 'Loading the world…';
  claimStatusEl.classList.remove('error');
  claimGrowBtn.style.display = 'none';
  claimSelectionNameEl.textContent = 'No plot selected';
  claimConfirmBtn.disabled = true;
  claimConfirmBtn.onclick = null;
  disposeClaimFlyover();

  let world;
  let landlets;
  try {
    // Landlets still generating (not yet enclosed by the world's expansion
    // radius) are queued backend state, not something to show a builder —
    // only fetch the two statuses that are meaningful to see/select here.
    const [fetchedWorld, greenbeltLandlets, claimedLandlets] = await Promise.all([
      fetchWorld(),
      fetchLandlets({ status: 'greenbelt', limit: 100 }),
      fetchLandlets({ status: 'claimed', limit: 100 }),
    ]);
    world = fetchedWorld;
    landlets = [...greenbeltLandlets, ...claimedLandlets];
  } catch (err) {
    claimStatusEl.textContent = err.message || 'Could not load the world.';
    claimStatusEl.classList.add('error');
    return;
  }

  const radiusM = world.radiusM;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1a08);
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(radiusM, -radiusM, radiusM * 2);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(radiusM * 1.4, 64),
    new THREE.MeshBasicMaterial({ color: 0x152510 }),
  );
  scene.add(ground);

  const boundary = new THREE.Mesh(
    new THREE.RingGeometry(radiusM * 0.99, radiusM * 1.01, 128),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
  );
  boundary.position.z = 0.02;
  scene.add(boundary);

  // Plots of the same status share a fill color, so without a per-plot
  // border two adjacent greenbelt lands would visually merge into one —
  // this is a placeholder selection UI (a real flyover will eventually
  // replace it), so making individual land boundaries readable at a glance
  // matters more here than it would in a polished final view.
  const plotOutlineMaterial = new THREE.LineBasicMaterial({ color: 0x0d1a08, transparent: true, opacity: 0.7 });
  const plotMeshes = [];
  const plotOutlines = [];
  let anyAvailable = false;
  for (const landlet of landlets) {
    if (landlet.status === 'greenbelt') anyAvailable = true;
    const shape = shapeForLandlet(landlet);
    const geometry = new THREE.ShapeGeometry(shape);
    const material = new THREE.MeshBasicMaterial({ color: CLAIM_PLOT_COLORS[landlet.status] ?? 0xffffff });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(landlet.center.x, landlet.center.y, 0.05);
    mesh.userData.landlet = landlet;
    scene.add(mesh);
    plotMeshes.push(mesh);

    const outlineGeometry = new THREE.BufferGeometry().setFromPoints(
      shape.getPoints().map((p) => new THREE.Vector3(p.x, p.y, 0)),
    );
    const outline = new THREE.LineLoop(outlineGeometry, plotOutlineMaterial);
    outline.position.set(landlet.center.x, landlet.center.y, 0.06);
    scene.add(outline);
    plotOutlines.push(outline);
  }

  // A dedicated outline per selection, built from the same polygon as the
  // plot itself (not a bounding box, which reads as a plain rectangle for
  // every non-square shape) — swapped out on each click the same way
  // applyLandletShape() swaps the main builder scene's ground geometry.
  const selectionOutlineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
  let selectionOutline = null;
  let selectedMesh = null;

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, radiusM * 20);
  camera.up.set(0, 0, 1); // Z-up, matching the builder scene's own convention
  camera.position.set(0, -radiusM * 1.8, radiusM * 1.6);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas: claimMapCanvas, antialias: true });
  const controls = new OrbitControls(camera, claimMapCanvas);
  controls.target.set(0, 0, 0);
  controls.minDistance = radiusM * 0.15;
  controls.maxDistance = radiusM * 6;
  controls.maxPolarAngle = Math.PI * 0.49; // stop just shy of edge-on/underground
  controls.update();

  function onResize() {
    const rect = claimMapCanvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  }
  onResize();
  window.addEventListener('resize', onResize);

  const raycaster = new THREE.Raycaster();
  const pointerNdcClaim = new THREE.Vector2();
  claimMapCanvas.addEventListener('click', (event) => {
    const rect = claimMapCanvas.getBoundingClientRect();
    pointerNdcClaim.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdcClaim.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdcClaim, camera);
    const hits = raycaster.intersectObjects(plotMeshes);
    if (hits.length === 0) return;
    const mesh = hits[0].object;
    const landlet = mesh.userData.landlet;

    if (selectedMesh) {
      selectedMesh.material.color.setHex(CLAIM_PLOT_COLORS[selectedMesh.userData.landlet.status] ?? 0xffffff);
    }
    selectedMesh = mesh;
    // Lighten toward white rather than using a fixed highlight color, so
    // the highlighted plot still visibly carries its own status color
    // (available vs. claimed) instead of every selection looking the same.
    mesh.material.color.setHex(CLAIM_PLOT_COLORS[landlet.status] ?? 0xffffff).lerp(new THREE.Color(0xffffff), 0.45);

    if (selectionOutline) {
      scene.remove(selectionOutline);
      selectionOutline.geometry.dispose();
    }
    const outlinePoints = shapeForLandlet(landlet).getPoints().map((p) => new THREE.Vector3(p.x, p.y, 0));
    selectionOutline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(outlinePoints), selectionOutlineMaterial);
    selectionOutline.position.set(landlet.center.x, landlet.center.y, 0.07);
    selectionOutline.renderOrder = 2;
    scene.add(selectionOutline);
    claimFlyover.selectionOutline = selectionOutline;

    const statusLabel = landlet.status === 'greenbelt' ? 'Available' : 'Claimed';
    claimSelectionNameEl.textContent = `${landlet.name} (${landlet.areaM2} m²) — ${statusLabel}`;
    claimConfirmBtn.disabled = landlet.status !== 'greenbelt';
    claimConfirmBtn.onclick = () => claimSelectedLandlet(landlet, resolve);
  });

  function animate() {
    claimFlyover.animationHandle = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  claimFlyover = {
    scene, camera, renderer, controls, plotMeshes, plotOutlines, plotOutlineMaterial, onResize, animationHandle: 0,
    selectionOutline: null, selectionOutlineMaterial,
  };
  animate();

  claimStatusEl.textContent = anyAvailable
    ? ''
    : "No landlets are ready to claim yet — the world hasn't grown enough.";
  claimGrowBtn.style.display = anyAvailable ? 'none' : '';
}

async function claimSelectedLandlet(landlet, resolve) {
  claimConfirmBtn.disabled = true;
  claimStatusEl.textContent = `Claiming ${landlet.name}…`;
  claimStatusEl.classList.remove('error');
  try {
    const claimed = await claimLandlet(landlet.landletId, builderId);
    disposeClaimFlyover();
    claimModalEl.classList.remove('visible');
    resolve(claimed.landletId);
  } catch (err) {
    // Someone else likely claimed it in the meantime (409) — refresh the
    // map since its status is now stale.
    claimStatusEl.textContent = err.message || 'Claim failed — it may have just been taken.';
    claimStatusEl.classList.add('error');
    loadLandletMap(resolve);
  }
}

// Dev-only bootstrap for when nothing is claimable right now. Two cases,
// tried in order:
//
// 1. Land already exists just outside the current boundary — e.g. an
//    organic mosaic's outer cells that didn't fully fit inside the world
//    radius at generation time (see worker/index.js's generate-mosaic
//    handler) — but hasn't been expanded into yet. Expanding first can
//    make it claimable without generating anything new at all.
// 2. Genuinely nothing is queued anywhere. Generate one gap-free ring of
//    wedge-shaped candidates touching the *current* boundary, complete
//    its generation, then expand until it's enclosed and promotes to
//    greenbelt.
//
// Every ring gets a prefix derived from the world radius it was generated
// at (radius only ever grows, so this is naturally unique per call) rather
// than a single fixed prefix — the old fixed-prefix version could only
// ever generate one ring for the lifetime of the world; every later click
// just silently re-fetched that same, already-fully-grown ring and did
// nothing. A real deployment would want this driven by an actual
// world-building process rather than a builder's own browser session —
// see the message to Codex about this.
const GROW_WORLD_MAX_EXPANSIONS = 20;

async function expandToEncloseGenerating() {
  for (let i = 0; i < GROW_WORLD_MAX_EXPANSIONS; i++) {
    const generating = await fetchLandlets({ status: 'generating', limit: 1 });
    if (generating.length === 0) return; // nothing waiting to be enclosed
    try {
      await expandWorld();
    } catch {
      return; // ratio gate refused — greenbelt supply is already healthy
    }
  }
}

async function generateRingAtBoundary() {
  let world = await fetchWorld();
  // The world's radius_m is a pacing/UI boundary, not a guarantee that
  // nothing extends past it — an organic mosaic's outer cells can reach
  // beyond it well before an expansion catches up (see the comment atop
  // this section). generate-ring's own conflict check catches that (it
  // scans every existing candidate's radial band, not just ones inside the
  // current boundary) and 409s with a distinct message, so probe outward by
  // an expansion increment each time that specific conflict is hit, rather
  // than starting exactly at the current boundary and hoping it's clear.
  let innerRadiusM = world.radiusM;
  let ring = null;
  for (let attempt = 0; attempt < GROW_WORLD_MAX_EXPANSIONS && !ring; attempt++) {
    const prefix = `dev-ring-${Math.round(innerRadiusM)}`;
    try {
      const result = await generateLandRing({ prefix, count: 12, innerRadiusM });
      ring = { ringId: prefix, outerRadiusM: result.outerRadiusM };
    } catch (err) {
      if (err.message === 'Land candidate already exists') {
        // This exact radius was already tried (e.g. a retry after a
        // transient failure) — reuse that reservation instead of failing.
        const existing = await fetchLandCandidateRing(prefix);
        ring = { ringId: existing.ringId, outerRadiusM: existing.outerRadiusM };
      } else if (err.message === 'Generated ring would overlap existing land candidates') {
        innerRadiusM += world.expansionIncrementM;
      } else {
        throw err;
      }
    }
  }
  if (!ring) throw new Error("Couldn't find clear room to generate a new ring.");

  try {
    await completeRingGeneration(ring.ringId);
  } catch {
    // Not every member has materialized yet (can happen if the ring was
    // left over from a previous, interrupted attempt) — expand toward its
    // outer edge and retry once.
    for (let i = 0; i < GROW_WORLD_MAX_EXPANSIONS && world.radiusM < ring.outerRadiusM; i++) {
      world = await expandWorld();
    }
    await completeRingGeneration(ring.ringId);
  }

  for (let i = 0; i < GROW_WORLD_MAX_EXPANSIONS && world.radiusM < ring.outerRadiusM; i++) {
    world = await expandWorld();
  }
}

async function growTheWorld(resolve) {
  claimGrowBtn.disabled = true;
  claimStatusEl.textContent = 'Growing the world…';
  claimStatusEl.classList.remove('error');
  try {
    await expandToEncloseGenerating();
    const stillNoneAvailable = (await fetchLandlets({ status: 'greenbelt', limit: 1 })).length === 0;
    if (stillNoneAvailable) await generateRingAtBoundary();
  } catch (err) {
    claimStatusEl.textContent = err.message || 'Could not grow the world.';
    claimStatusEl.classList.add('error');
    claimGrowBtn.disabled = false;
    return;
  }
  claimGrowBtn.disabled = false;
  loadLandletMap(resolve);
}

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
// One-time: a device that already had local-only identities from before
// the shared roster existed gets them POSTed up under their exact existing
// IDs, so whatever they'd already claimed stays reachable. Best-effort and
// not retried — takeLegacyIdentities() clears the local copy regardless of
// whether the POSTs below actually reach the server, since this is a
// one-shot migration for pre-existing dev/test data, not something worth
// building real retry durability around.
async function migrateLegacyIdentities() {
  const legacy = takeLegacyIdentities();
  for (const identity of legacy) {
    try {
      await createBuilder(identity.label, identity.id);
    } catch {
      // Most likely: this ID is already on the roster (e.g. backfilled
      // server-side from landlet ownership, or a previous run of this
      // same migration) — nothing to do.
    }
  }
}

async function bootstrap() {
  await migrateLegacyIdentities();

  // Set by #mode-nav just before its reload; consumed
  // once here. Nothing set — a plain fresh tab — lands on Shop, the
  // product's chosen default landing view (see START_MODE_KEY above).
  const requestedStartMode = sessionStorage.getItem(START_MODE_KEY);
  sessionStorage.removeItem(START_MODE_KEY);
  const startMode = requestedStartMode === 'build' || requestedStartMode === 'sell' ? requestedStartMode : 'shop';

  if (startMode === 'shop') {
    currentMode = 'shop';
    updateModeNavUI();
    await enterShopMode();
    return;
  }

  currentMode = 'build';
  updateModeNavUI();
  builderId = await ensureBuilderIdentity();
  let instances;
  try {
    currentLandletId = await resolveLandletId();
    const [catalog, remoteInstances, landletRecord] = await Promise.all([
      fetchCatalog(), fetchInstances(currentLandletId), fetchLandlet(currentLandletId),
    ]);
    activeCatalog = catalog;
    instances = remoteInstances;
    applyLandletShape(landletRecord);
  } catch (err) {
    console.warn('Backend unreachable, falling back to local/placeholder data:', err);
    activeCatalog = FALLBACK_CATALOG;
    currentLandletId = 'starter-landlet';
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

  // "Sell" from Shop mode routes through the ordinary Build-mode load (the
  // Seller modal only actually needs builderId + activeCatalog, but there's
  // no lighter-weight bootstrap path than this one) and opens straight into
  // My Products once it's ready, rather than landing the builder on an
  // empty Build scene they didn't ask to see.
  if (startMode === 'sell') openSellerModal();
}
bootstrap();
