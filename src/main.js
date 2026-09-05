import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cropGeometryFromEnd } from './meshCrop.js';
import { CATALOG as FALLBACK_CATALOG, DEFAULT_INSTANCES } from './catalog.js';
import { loadInstances, saveInstances } from './layoutStorage.js';
import {
  signUp,
  logIn,
  logOut,
  fetchCurrentUser,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
  resendVerificationEmail,
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
  fetchBuilders,
  fetchMyBuilder,
  fetchMySeller,
  fetchAllLandlets,
  fetchNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  fetchFriendships,
  sendFriendRequest,
  acceptFriendRequest,
  removeFriendship,
  fetchLandletVersions,
  saveLandletVersion,
  fetchLandletVersion,
  activateLandletVersion,
  replaceLandletDraft,
  fetchBundles,
  fetchSharedBundles,
  createBundle,
  updateBundle,
  deleteBundle,
  fetchSignPosts,
  createSignPost,
  deleteSignPost,
  fetchCalendarEvents,
  createCalendarEvent,
  deleteCalendarEvent,
  triggerCalendarEvent,
  fetchProductReviews,
  createProductReview,
  deleteProductReview,
  startAuction,
  fetchAuctions,
  placeBid,
  resolveAuctionNow,
  purchaseInstance,
  fetchPurchases,
  refundPurchase,
} from './api.js';
import { optimizeModelFile, rescaleModelFile } from './modelOptimizer.js';
import { getUnits, setUnits, unitSuffix, toDisplayLength, fromDisplayLength, formatLength } from './settings.js';
import { takeoffAltitudeM, landingAltitudeM, flightSpeedMultiplier } from './flight.js';

// The API (worker/index.js + D1) is authoritative when reachable; the
// catalog.js constants above are only used if fetching it fails. This is
// reassigned once, in bootstrap() below, before anything reads it — every
// other reference to the catalog goes through this variable rather than
// FALLBACK_CATALOG directly.
let activeCatalog = FALLBACK_CATALOG;

// Saved groups a builder can stamp down again together (see migrations/
// 0039_bundles.sql) — fetched once builderId is settled in bootstrap() and
// refreshed after any save/delete. Empty (rather than falling back to
// something local) when the backend's unreachable — a bundle only makes
// sense as something durable across sessions/landlets, so there's no
// offline equivalent worth keeping, unlike activeCatalog's FALLBACK_CATALOG.
let myBundles = [];
// Every builder's opted-in shared bundles (see migrations/0040_bundle_sharing.sql)
// — a separate list from myBundles, not a filtered view of it, fetched
// alongside it in bootstrap() so the picker's section can show/hide
// correctly based on either tab having something before a builder ever
// switches to the Community tab.
let communityBundles = [];
let activeBundleTab = 'mine';

// Resolved from the logged-in account's own builder profile (see
// ensureBuilderIdentity, docs/API.md's "Authentication") once, in
// bootstrap(), before anything reads it; every instance created afterward
// is tagged with it so builders only ever see and edit their own
// landlet's placed products. currentLandletId is settled alongside it.
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

// Shown in Settings' General tab (renderGeneralSettingsSection) rather than
// an always-on-screen HUD overlay — decluttering the main view, now that
// it's the only way to read/copy exactly which commit is deployed.
const BUILD_INFO_TEXT = `build ${__BUILD_COMMIT__} · ${__BUILD_TIME__}`;

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
// How far the free-fly target (see the dolly-to-truck conversion below) is
// allowed to wander from the landlet, across any number of dolly gestures.
// Comfortably inside the camera's own far plane (set above, at
// construction) so the ground/sky stay visible and the landlet stays
// reachable no matter how much scrolling happened — well past enough for
// a builder to back away from even a badly oversized placed item, without
// ever risking the astronomical, effectively-unrecoverable coordinates
// unbounded free-flying could otherwise reach.
const MAX_FLY_TARGET_DISTANCE_M = 500;

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

// Alignment assist (docs/SPEC.md §3: "transient guide near an alignment
// opportunity, continued movement releases it, pausing commits it") — only
// for a single selected item's own Move drag, not a group move (which
// already has its own collision/bounds logic above; stacking alignment
// snapping on top of that is a lot more moving parts for a feature this
// deliberately simple isn't worth the risk to). Deliberately X/Y only —
// height is what snapToSurfaces (resting on another item) is for.
//
// "Conservative starting threshold, tune via playtesting" is the spec's
// own words for this exact number — SNAP_M is how close an edge/center has
// to get before it grabs at all; RELEASE_M (wider, for hysteresis) is how
// far the raw drag has to move on before a held snap actually lets go, so
// a snap reads as a magnet with some grip rather than flickering on/off
// right at one threshold.
const ALIGNMENT_SNAP_M = 0.05;
const ALIGNMENT_RELEASE_M = 0.15;
const ALIGNMENT_GUIDE_COLOR = 0xff33cc;

const alignmentGuideMaterial = new THREE.LineDashedMaterial({ color: ALIGNMENT_GUIDE_COLOR, dashSize: 0.2, gapSize: 0.1, depthTest: false });
function makeAlignmentGuide() {
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const line = new THREE.Line(geometry, alignmentGuideMaterial);
  line.visible = false;
  line.renderOrder = 999;
  scene.add(line);
  return line;
}
const alignmentGuideX = makeAlignmentGuide(); // shown when the dragged item's X is currently snapped — drawn running along Y, at the shared X coordinate
const alignmentGuideY = makeAlignmentGuide(); // same, for a Y snap — drawn running along X

// null per axis when nothing's currently snapped; otherwise
// { guideCoordinate, snappedValue } — guideCoordinate is the world
// coordinate the snap is holding onto (what the hysteresis check below
// measures the raw drag against), snappedValue is what the dragged mesh's
// own center gets set to so its matching edge/center actually lands there.
const alignmentSnapState = { x: null, y: null };

// Own local half-extent along `axis` — ignoring rotation, same simplifying
// axis-aligned-bounding-box assumption the group-move bounds clamp above
// already makes for every placed item, extensibility axes included.
function alignmentHalfExtent(mesh, axis) {
  const dims = meshDimensions(mesh);
  return (axis === 'x' ? dims.width : dims.depth) / 2;
}

// Every other placed item's own min/center/max along `axis`, each a
// candidate the dragged item might snap to.
function alignmentTargets(movingMesh, axis) {
  const targets = [];
  for (const mesh of productMeshes) {
    if (mesh === movingMesh) continue;
    const half = alignmentHalfExtent(mesh, axis);
    const center = mesh.position[axis];
    targets.push(center - half, center, center + half);
  }
  return targets;
}

// Finds the single closest edge/center match (if any, within
// ALIGNMENT_SNAP_M) between the dragged item's own three candidate
// positions (its min/center/max, computed at the *requested* rawValue) and
// every other item's own three. Only ever the single best match — two
// simultaneous candidates this close together would just be visual noise,
// and the dragged item can only actually align to one line at a time.
function findAlignmentSnap(movingMesh, axis, rawValue) {
  const half = alignmentHalfExtent(movingMesh, axis);
  const movingCandidates = [rawValue - half, rawValue, rawValue + half];
  const targets = alignmentTargets(movingMesh, axis);
  let best = null;
  for (const movingCandidate of movingCandidates) {
    for (const target of targets) {
      const distance = Math.abs(movingCandidate - target);
      if (distance < ALIGNMENT_SNAP_M && (!best || distance < best.distance)) {
        best = { distance, guideCoordinate: target, snappedValue: rawValue + (target - movingCandidate) };
      }
    }
  }
  return best;
}

function resolveAlignmentAxis(axis, movingMesh, rawValue) {
  const held = alignmentSnapState[axis];
  if (held && Math.abs(rawValue - held.guideCoordinate) < ALIGNMENT_RELEASE_M) {
    return held.snappedValue; // still within the release band — keep holding, ignore rawValue entirely
  }
  const found = findAlignmentSnap(movingMesh, axis, rawValue);
  alignmentSnapState[axis] = found;
  return found ? found.snappedValue : rawValue;
}

// A guide line spans the whole landlet along the axis it's perpendicular
// to (X snap -> a line running the landlet's Y extent, and vice versa) at
// the world height of whichever item is currently selected, so it reads
// clearly above the ground rather than embedded in it.
function updateAlignmentGuides(movingMesh) {
  const half = LANDLET_SIDE_M / 2;
  const z = movingMesh ? movingMesh.position.z : 0;
  if (alignmentSnapState.x) {
    const x = alignmentSnapState.x.guideCoordinate;
    alignmentGuideX.geometry.setFromPoints([new THREE.Vector3(x, -half, z), new THREE.Vector3(x, half, z)]);
    alignmentGuideX.computeLineDistances();
    alignmentGuideX.visible = true;
  } else {
    alignmentGuideX.visible = false;
  }
  if (alignmentSnapState.y) {
    const y = alignmentSnapState.y.guideCoordinate;
    alignmentGuideY.geometry.setFromPoints([new THREE.Vector3(-half, y, z), new THREE.Vector3(half, y, z)]);
    alignmentGuideY.computeLineDistances();
    alignmentGuideY.visible = true;
  } else {
    alignmentGuideY.visible = false;
  }
}

// resolveByAxis needs a known-good starting point to sweep from — captured
// fresh at the start of every drag, since the object's position right
// before a drag begins is by definition already collision-free.
translateControls.addEventListener('dragging-changed', (event) => {
  if (!event.value) {
    // Drag ended (or this is the initial false event some TransformControls
    // versions fire before anything ever started) — nothing should stay
    // held or visible once nobody's actively dragging.
    alignmentSnapState.x = null;
    alignmentSnapState.y = null;
    updateAlignmentGuides(null);
  }
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
  // Alignment assist runs last, on the already landlet-clamped and
  // collision-resolved position — it only ever nudges within whatever room
  // those two already left, never fights them for it.
  resolved = {
    x: resolveAlignmentAxis('x', object, resolved.x),
    y: resolveAlignmentAxis('y', object, resolved.y),
    // Flooring is always flush with the ground (see isFlooringTemplate) —
    // free to move in X/Y like anything else, but the Z (blue) gizmo arrow
    // shouldn't be able to lift a "patch of ground" up into the air.
    z: isFlooringTemplate(object.userData.template) ? FLOORING_THICKNESS_M / 2 : resolved.z,
  };
  updateAlignmentGuides(object);
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
let trimStartScale = 1;

// Converts the gizmo's live (still-unclamped, still just a raw multiplier
// of trimStartLength) scale factor into the actual crop length it
// represents right now. Dividing out trimStartScale cancels any
// pre-existing per-instance scale the drag's own multiplier would
// otherwise inherit — see trimStartScale's own comment.
function currentDragCropLength(object) {
  const template = object.userData.template;
  const extensible = extensibleAxes(template)[trimAxis];
  const maxLength = template.dimensions[AXIS_DIMENSION_KEY[trimAxis]];
  const requestedLength = trimStartLength * (object.scale[trimAxis] / trimStartScale);
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
    // TransformControls' scale gizmo starts multiplying from the object's
    // own *current* scale, not from 1 — for the ordinary case (no legacy
    // per-instance Resize scale applied) that's already 1 and this is a
    // no-op, but a pre-existing scaled instance (from before Resize was
    // removed from Build mode) would otherwise have that leftover scale
    // silently folded into the drag's own multiplier, cropping to a
    // fraction of the intended length. Dividing it back out in
    // currentDragCropLength keeps the drag reading as "how much of the
    // template's full length is this" regardless of a legacy scale.
    trimStartScale = object.userData.scale ?? 1;
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

// Fixed bright daylight, always — no day-night cycle (docs/SPEC.md §1's
// "shared, compressed 4-hour cycle" is deliberately not implemented here
// for now: a builder shouldn't have to make their space look good in three
// different kinds of lighting, and a dark "night" phase read as ominous
// rather than the lighthearted, bright feel this world is going for). These
// values are the cycle's own former "daylight" keyframe — kept exactly so
// nothing about the lit look actually changes, only the fact that it never
// stops being this.
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
  // Every caller here — clampToLandlet's own minimum-z floor, collision
  // resolution, the group-move bounds clamp, alignment assist's own
  // half-extent — needs to agree a flooring mesh is genuinely thin, not
  // whatever height the seller declared for the (unused, for flooring)
  // full-size model. Defined once here rather than special-cased at every
  // call site.
  if (isFlooringTemplate(template)) {
    return { width: template.dimensions.width, depth: template.dimensions.depth, height: FLOORING_THICKNESS_M };
  }
  return {
    width: (crop?.x ?? template.dimensions.width) * scale,
    depth: (crop?.y ?? template.dimensions.depth) * scale,
    height: (crop?.z ?? template.dimensions.height) * scale,
  };
}

const AXIS_DIMENSION_KEY = { x: 'width', y: 'depth', z: 'height' };
const AXIS_LIST = ['x', 'y', 'z'];

// Ground/flooring products (docs/SPEC.md §3: "placing a specific real
// flooring/sod product replaces [the default grass] within that
// footprint") — a template opts in via metadata.flooring (toggled in the
// Seller modal), not a separate catalog field, the same lightweight
// pattern extensibleAxes already uses for metadata.extensible. Always
// renders as a thin flat plane at true ground level regardless of the
// template's own declared height or whether it has a real uploaded model
// — true texture-masking of the shared ground mesh within an arbitrary
// footprint is a real rendering problem or its own; a thin tinted slab
// reads as "this patch of ground is now this product" without it, the
// same simplification a placeholder box already stands in for any product
// with no real model.
const FLOORING_THICKNESS_M = 0.02;
function isFlooringTemplate(template) {
  return template.metadata?.flooring === true;
}

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
  if (isFlooringTemplate(template)) {
    // A deliberately separate, much simpler path — no model loading, no
    // crop/extensibility, no uniform-scale legacy handling (none of the
    // Resize/Trim tools apply to flooring — it's always its own declared
    // footprint, always thin, always at the ground). Only x/y and
    // rotationZ from the instance are meaningful; z is always the fixed
    // ground thickness regardless of what's stored (see the
    // objectChange handler's own flooring clamp for why a stale non-zero
    // z from before this feature existed, or a stray drag, can't stick).
    const width = template.dimensions.width;
    const depth = template.dimensions.depth;
    const geometry = new THREE.BoxGeometry(width, depth, FLOORING_THICKNESS_M);
    const material = new THREE.MeshStandardMaterial({ color: template.color });
    const object = new THREE.Mesh(geometry, material);
    object.position.set(instance.x ?? 0, instance.y ?? 0, FLOORING_THICKNESS_M / 2);
    object.rotation.z = instance.rotationZ ?? 0;
    object.userData.instanceId = instance.instanceId ?? instance.id;
    object.userData.template = template;
    object.userData.crop = {};
    object.userData.scale = 1;
    return object;
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
  // A uniform scale factor, separate from Trim's per-axis crop above.
  // Builders can no longer set this (Resize was removed from Build mode —
  // the world should be populated at each product's real, seller-declared
  // size), but existing instances saved before that change still carry a
  // non-1 value here and must keep rendering at it. Applied to the whole
  // returned object (box fallback or real model container alike) so it
  // scales everything uniformly, position included via Object3D's own
  // transform.
  object.userData.scale = instance.scale ?? 1;
  object.scale.setScalar(object.userData.scale);
  // Community signs (docs/API.md's "Community signs") — a per-instance
  // flag, unlike flooring's per-template one, so it lives on the instance
  // itself rather than being derived from the template. Flooring can't
  // also be a sign (its own branch above never sets this), which is fine —
  // nothing in the spec calls for a flat ground patch to double as one.
  object.userData.isCommunitySign = instance.isCommunitySign ?? false;
  // Community calendar (docs/API.md's "Community calendar") — same
  // per-instance-flag reasoning as isCommunitySign just above, and
  // independent of it.
  object.userData.isCommunityCalendar = instance.isCommunityCalendar ?? false;
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
    isCommunitySign: mesh.userData.isCommunitySign ?? false,
    isCommunityCalendar: mesh.userData.isCommunityCalendar ?? false,
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
    isCommunitySign: mesh.userData.isCommunitySign ?? false,
    isCommunityCalendar: mesh.userData.isCommunityCalendar ?? false,
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
// No longer defaults to an idle "Tap a product to inspect it" hint — that
// was permanent on-screen real estate spent stating the obvious. The pill
// itself is still exactly as useful for everything it was already showing
// (a selected item's name, Measure's readouts, Copy/Save Bundle
// confirmations, ...) — it just now hides completely (native `hidden`,
// which `#product-info`'s own CSS never overrides) rather than falling
// back to a permanent placeholder when there's nothing to say.
function setProductInfo(text) {
  productInfoEl.textContent = text;
  productInfoEl.hidden = !text;
}
productInfoEl.hidden = true;

// Add-item catalog picker: a toggled panel listing every activeCatalog
// template as a grid of thumbnails with the name below each, rather than a
// plain list of name-only buttons — much faster to recognize a product by
// its actual shape/color than by reading through a list of names. Tapping
// one doesn't place anything yet — it arms placement mode (see
// enterPlacementMode) so the next tap in the world, wherever that is, is
// where the item actually goes. Tiles are (re)built in bootstrap() once
// activeCatalog is settled, since the API's catalog isn't known until that
// fetch resolves.
const addItemBtn = document.getElementById('add-item-btn');
const catalogPickerEl = document.getElementById('catalog-picker');
const catalogPickerGridEl = document.getElementById('catalog-picker-grid');
const catalogPickerCloseBtn = document.getElementById('catalog-picker-close-btn');
const catalogSearchInputEl = document.getElementById('catalog-search-input');
const catalogPickerEmptyEl = document.getElementById('catalog-picker-empty');
const catalogPickerEmptyQueryEl = document.getElementById('catalog-picker-empty-query');
const bundlePickerSectionEl = document.getElementById('bundle-picker-section');
const bundlePickerGridEl = document.getElementById('bundle-picker-grid');
const bundlePickerEmptyEl = document.getElementById('bundle-picker-empty');
const bundleTabButtons = [...document.querySelectorAll('.bundle-tab-btn')];

// A template's appearance never changes after creation (there's no edit
// flow for its color or model), so a thumbnail rendered once this session
// is good for the rest of it — keyed by templateId rather than re-rendered
// every time the picker reopens or a new upload rebuilds the whole grid.
const catalogThumbnailCache = new Map();
const CATALOG_THUMBNAIL_SIZE = 128;
let catalogThumbnailCanvas = null;
let catalogThumbnailRenderer = null;
// Real thumbnail rendering awaits an actual model load (loadModelInstance),
// so overlapping calls could otherwise interleave through the one shared
// canvas/renderer below (mobile GPUs don't want a WebGL context per tile —
// same reasoning as the Seller modal's single shared preview canvas) and
// read back whichever render happened to finish last. Chaining every call
// onto this one queue serializes the actual render+readback work while
// still letting each caller await its own result independently.
let catalogThumbnailQueue = Promise.resolve();

// A flat swatch of the template's own color, shown immediately while the
// real render (which needs an async model load for anything with a
// modelUrl) is still in flight — closer to the real product than a blank
// or generic placeholder icon would be.
function solidColorDataUrl(color) {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  canvas.getContext('2d').fillStyle = color || '#999999';
  canvas.getContext('2d').fillRect(0, 0, 1, 1);
  return canvas.toDataURL();
}

async function renderCatalogThumbnailNow(template) {
  if (!catalogThumbnailCanvas) {
    catalogThumbnailCanvas = document.createElement('canvas');
    catalogThumbnailRenderer = new THREE.WebGLRenderer({
      canvas: catalogThumbnailCanvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    catalogThumbnailRenderer.setSize(CATALOG_THUMBNAIL_SIZE, CATALOG_THUMBNAIL_SIZE, false);
  }
  // Same instance shape showAxisPreview uses — origin, no crop, no
  // rotation — so this shows the product's real full-size appearance
  // (actual model/texture when it has one) the same way Build mode would.
  const previewObject = await createMeshForInstance({
    templateId: template.templateId,
    x: 0, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0,
    crop: {},
  });
  if (!previewObject) return null;

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(2, -3, 4);
  scene.add(sun);
  scene.add(previewObject);

  const box = new THREE.Box3().setFromObject(previewObject);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.05);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.up.set(0, 0, 1);
  const dist = radius * 2.6;
  camera.position.set(dist * 0.75, -dist * 0.95, dist * 0.65);
  camera.lookAt(0, 0, 0);

  catalogThumbnailRenderer.render(scene, camera);
  const dataUrl = catalogThumbnailCanvas.toDataURL('image/png');
  disposeObject(previewObject);
  return dataUrl;
}

function renderCatalogThumbnail(template) {
  if (catalogThumbnailCache.has(template.templateId)) {
    return Promise.resolve(catalogThumbnailCache.get(template.templateId));
  }
  const result = catalogThumbnailQueue.then(() => renderCatalogThumbnailNow(template));
  catalogThumbnailQueue = result.then(
    () => {},
    () => {}, // keep the queue alive even if one template's render fails
  );
  result.then((dataUrl) => {
    if (dataUrl) catalogThumbnailCache.set(template.templateId, dataUrl);
  });
  return result;
}

// Client-side name filtering (see #catalog-search-input's own CSS comment)
// — toggles each already-built tile's `hidden` attribute rather than
// re-querying the catalog or touching the thumbnail cache, since neither a
// template's name nor its appearance changes mid-session. Reads whatever
// buildCatalogPickerButtons last stamped into each tile's dataset.name, so
// it's safe to call any time after the grid exists, including right after
// a rebuild while the picker itself is closed.
function filterCatalogTiles() {
  const query = catalogSearchInputEl.value.trim().toLowerCase();
  let anyVisible = false;
  for (const tile of catalogPickerGridEl.children) {
    const matches = !query || tile.dataset.name.includes(query);
    tile.hidden = !matches;
    if (matches) anyVisible = true;
  }
  catalogPickerEmptyEl.hidden = anyVisible || !query;
  catalogPickerEmptyQueryEl.textContent = catalogSearchInputEl.value.trim();
}
catalogSearchInputEl.addEventListener('input', filterCatalogTiles);

function buildCatalogPickerButtons() {
  catalogPickerGridEl.replaceChildren();
  for (const template of activeCatalog) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'catalog-tile';
    tile.dataset.name = template.name.toLowerCase();

    const thumb = document.createElement('img');
    thumb.className = 'catalog-thumb';
    thumb.alt = '';
    thumb.src = catalogThumbnailCache.get(template.templateId) ?? solidColorDataUrl(template.color);
    tile.appendChild(thumb);

    const name = document.createElement('span');
    name.className = 'catalog-tile-name';
    name.textContent = template.name;
    tile.appendChild(name);

    tile.addEventListener('click', () => {
      catalogPickerEl.classList.remove('visible');
      enterPlacementMode({ type: 'template', template }, `Tap a spot to place ${template.name}`);
    });
    catalogPickerGridEl.appendChild(tile);

    if (!catalogThumbnailCache.has(template.templateId)) {
      renderCatalogThumbnail(template).then((dataUrl) => {
        if (dataUrl) thumb.src = dataUrl;
      });
    }
  }
  filterCatalogTiles();
}

// Bundles (see migrations/0039_bundles.sql, 0040_bundle_sharing.sql) — no
// thumbnail, just a name and item count; tapping one arms placement mode
// with exactly the same {type:'clipboard', items} shape a Paste does, so
// handlePlacementClick's existing clipboard-placement path
// (placeClipboardItems) needs no changes to place a bundle.
//
// The whole section stays hidden until either list has something — a
// builder who's never saved a bundle themselves but whose neighbors have
// shared some still gets to discover the Community tab. Delete (and the
// Shared/Private toggle) only ever show on a tile this builder actually
// owns — a shared bundle is still owned by whoever created it (see
// handleBundles' own comment in worker/index.js); the backend does no
// ownership check, so this is the only place that's actually enforced.
function currentBundleTabList() {
  return activeBundleTab === 'mine' ? myBundles : communityBundles;
}

function renderBundlePicker() {
  bundlePickerSectionEl.hidden = myBundles.length === 0 && communityBundles.length === 0;
  if (bundlePickerSectionEl.hidden) return;

  for (const btn of bundleTabButtons) {
    btn.classList.toggle('active', btn.dataset.bundleTab === activeBundleTab);
  }

  const bundles = currentBundleTabList();
  bundlePickerGridEl.replaceChildren();
  bundlePickerEmptyEl.hidden = bundles.length > 0;
  if (bundles.length === 0) {
    bundlePickerEmptyEl.textContent = activeBundleTab === 'mine'
      ? "You haven't saved any bundles yet — select items and use Save Bundle."
      : 'No one has shared a bundle yet.';
    return;
  }

  for (const bundle of bundles) {
    const tile = document.createElement('div');
    tile.className = 'bundle-tile';
    const owned = bundle.builderId === builderId;

    const placeBtn = document.createElement('button');
    placeBtn.type = 'button';
    placeBtn.className = 'bundle-tile-place';
    const name = document.createElement('span');
    name.className = 'bundle-tile-name';
    name.textContent = bundle.name;
    const count = document.createElement('span');
    count.className = 'bundle-tile-count';
    count.textContent = `${bundle.items.length} item${bundle.items.length === 1 ? '' : 's'}`;
    placeBtn.append(name, count);
    placeBtn.addEventListener('click', () => {
      catalogPickerEl.classList.remove('visible');
      enterPlacementMode({ type: 'clipboard', items: bundle.items }, `Tap a spot to place "${bundle.name}"`);
    });
    tile.appendChild(placeBtn);

    if (owned) {
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'bundle-tile-rename';
      renameBtn.textContent = '✎';
      renameBtn.setAttribute('aria-label', `Rename bundle "${bundle.name}"`);
      renameBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const next = prompt('Rename this bundle', bundle.name);
        if (!next || !next.trim() || next.trim() === bundle.name) return;
        renameBtn.disabled = true;
        try {
          const updated = await updateBundle(bundle.bundleId, { name: next.trim() });
          Object.assign(bundle, updated);
          renderBundlePicker();
        } catch (err) {
          console.warn('Could not rename bundle:', err);
          renameBtn.disabled = false;
        }
      });
      tile.appendChild(renameBtn);

      const shareToggleBtn = document.createElement('button');
      shareToggleBtn.type = 'button';
      // Own class, not shared with .bundle-tile-delete despite the same
      // look — a page.click('.bundle-tile-delete') would otherwise hit
      // whichever of the two buttons happens to render first in the DOM
      // instead of the one actually intended.
      shareToggleBtn.className = 'bundle-tile-share';
      shareToggleBtn.textContent = bundle.shared ? '⇩' : '⇧';
      shareToggleBtn.setAttribute(
        'aria-label',
        bundle.shared ? `Stop sharing "${bundle.name}"` : `Share "${bundle.name}" to the Community tab`,
      );
      shareToggleBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        shareToggleBtn.disabled = true;
        try {
          const updated = await updateBundle(bundle.bundleId, { shared: !bundle.shared });
          Object.assign(bundle, updated);
          // Sharing/unsharing changes which list(s) this bundle belongs in
          // — simplest to just re-fetch both rather than hand-patch
          // communityBundles for an add/remove that only affects this one
          // tab's membership.
          [myBundles, communityBundles] = await Promise.all([fetchBundles(), fetchSharedBundles()]);
          renderBundlePicker();
        } catch (err) {
          console.warn('Could not update bundle sharing:', err);
          shareToggleBtn.disabled = false;
        }
      });
      tile.appendChild(shareToggleBtn);

      const deleteTileBtn = document.createElement('button');
      deleteTileBtn.type = 'button';
      deleteTileBtn.className = 'bundle-tile-delete';
      deleteTileBtn.setAttribute('aria-label', `Delete bundle "${bundle.name}"`);
      deleteTileBtn.textContent = '×';
      deleteTileBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!confirm(`Delete bundle "${bundle.name}"? This can't be undone.`)) return;
        try {
          await deleteBundle(bundle.bundleId);
          myBundles = myBundles.filter((b) => b.bundleId !== bundle.bundleId);
          communityBundles = communityBundles.filter((b) => b.bundleId !== bundle.bundleId);
          renderBundlePicker();
        } catch (err) {
          console.warn('Could not delete bundle:', err);
        }
      });
      tile.appendChild(deleteTileBtn);
    }

    bundlePickerGridEl.appendChild(tile);
  }
}
for (const btn of bundleTabButtons) {
  btn.addEventListener('click', () => {
    activeBundleTab = btn.dataset.bundleTab;
    renderBundlePicker();
  });
}
addItemBtn.addEventListener('click', () => {
  if (pendingPlacement) {
    cancelPlacementMode();
    return;
  }
  const opening = !catalogPickerEl.classList.contains('visible');
  catalogPickerEl.classList.toggle('visible');
  if (opening) {
    // Fresh search each time the picker opens, rather than carrying over
    // whatever was last typed — the same "reset on open" pattern the
    // upload modal's own file step uses.
    catalogSearchInputEl.value = '';
    filterCatalogTiles();
  }
});
catalogPickerCloseBtn.addEventListener('click', () => {
  catalogPickerEl.classList.remove('visible');
});

// Custom product upload: a builder's own model (photogrammetry scan,
// etc.) becomes a real catalog_templates row via two independent backend
// calls — POST /api/models to get bytes into storage and back a modelUrl,
// then the ordinary POST /api/catalog to register a product using it.
// This only works with the real backend reachable — creating a new
// persistent catalog entry has nowhere to live in offline/fallback mode,
// since catalog.js is a static file, not a runtime data store.
const uploadModalEl = document.getElementById('upload-modal');
const uploadModalTitleEl = document.getElementById('upload-modal-title');
const uploadStepFileEl = document.getElementById('upload-step-file');
const uploadStepDimensionsEl = document.getElementById('upload-step-dimensions');
const uploadDimensionsPreviewEl = document.getElementById('upload-dimensions-preview');
const uploadNameInput = document.getElementById('upload-name');
const uploadPriceInput = document.getElementById('upload-price');
const uploadDigitalGoodCheckbox = document.getElementById('upload-digital-good-checkbox');
const uploadDigitalGoodDisclaimerLabel = document.getElementById('upload-digital-good-disclaimer-label');
const uploadDigitalGoodDisclaimerSelect = document.getElementById('upload-digital-good-disclaimer-select');

uploadDigitalGoodCheckbox.addEventListener('change', () => {
  uploadDigitalGoodDisclaimerLabel.hidden = !uploadDigitalGoodCheckbox.checked;
});
const uploadFileInput = document.getElementById('upload-file-input');
const uploadStatusEl = document.getElementById('upload-status');
const uploadCancelBtn = document.getElementById('upload-cancel-btn');
const uploadSubmitBtn = document.getElementById('upload-submit-btn');
const uploadModelBtn = document.getElementById('upload-model-btn');
const uploadDimensionInputEls = {
  x: document.querySelector('.upload-dimension-input[data-axis="x"]'),
  y: document.querySelector('.upload-dimension-input[data-axis="y"]'),
  z: document.querySelector('.upload-dimension-input[data-axis="z"]'),
};
const uploadDimensionUnitEls = [...document.querySelectorAll('.upload-dimension-unit')];

// Upload is a two-step wizard sharing one modal shell: 'file' (name + pick
// a .glb) then 'dimensions' (confirm/adjust the measured real-world size
// before the product is actually created). uploadModelUrl/
// uploadOriginalDimensions hold what step 'file' produced, since step
// 'dimensions' needs them and the R2 upload shouldn't happen twice.
let uploadStep = 'file';
let uploadModelUrl = null;
let uploadOriginalDimensions = null;
let uploadDimensionPreview = null;

function setUploadStatus(text, isError) {
  uploadStatusEl.textContent = text;
  uploadStatusEl.classList.toggle('error', Boolean(isError));
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

function disposeUploadDimensionPreview() {
  uploadDimensionsPreviewEl.innerHTML = '';
  if (!uploadDimensionPreview) return;
  uploadDimensionPreview.controls.dispose();
  uploadDimensionPreview.renderer.dispose();
  disposeObject(uploadDimensionPreview.previewObject);
  for (const arrow of uploadDimensionPreview.arrows) {
    arrow.line.geometry.dispose();
    arrow.line.material.dispose();
    arrow.cone.geometry.dispose();
    arrow.cone.material.dispose();
  }
  for (const sprite of uploadDimensionPreview.labels) {
    sprite.material.map.dispose();
    sprite.material.dispose();
  }
  uploadDimensionPreview = null;
}

function resetUploadModalToFileStep() {
  uploadStep = 'file';
  uploadModelUrl = null;
  uploadOriginalDimensions = null;
  disposeUploadDimensionPreview();
  uploadModalTitleEl.textContent = 'Upload Model';
  uploadStepFileEl.hidden = false;
  uploadStepDimensionsEl.hidden = true;
  uploadSubmitBtn.textContent = 'Add Product';
}

function openUploadModal() {
  catalogPickerEl.classList.remove('visible');
  uploadNameInput.value = '';
  uploadPriceInput.value = '';
  uploadDigitalGoodCheckbox.checked = false;
  uploadDigitalGoodDisclaimerLabel.hidden = true;
  uploadDigitalGoodDisclaimerSelect.value = 'gift-card';
  uploadFileInput.value = '';
  setUploadStatus('');
  uploadSubmitBtn.disabled = false;
  resetUploadModalToFileStep();
  uploadModalEl.classList.add('visible');
}

function closeUploadModal() {
  uploadModalEl.classList.remove('visible');
  resetUploadModalToFileStep();
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

function setUploadDimensionInputs(dimensionsMeters) {
  for (const axis of AXIS_LIST) {
    const key = AXIS_DIMENSION_KEY[axis];
    uploadDimensionInputEls[axis].value = toDisplayLength(dimensionsMeters[key]).toFixed(2);
  }
}

function currentUploadDimensionsMeters() {
  const dims = {};
  for (const axis of AXIS_LIST) {
    const key = AXIS_DIMENSION_KEY[axis];
    dims[key] = fromDisplayLength(Number(uploadDimensionInputEls[axis].value));
  }
  return dims;
}

function refreshUploadDimensionUnits() {
  const suffix = unitSuffix();
  for (const el of uploadDimensionUnitEls) el.textContent = suffix;
}

// Editing any one dimension field rescales the OTHER TWO in lockstep to
// hold the model's original proportions — always computed fresh off the
// originally-measured dimensions (never off whatever's currently
// displayed), so repeated edits can't compound rounding error.
for (const axis of AXIS_LIST) {
  uploadDimensionInputEls[axis].addEventListener('input', () => {
    if (!uploadOriginalDimensions) return;
    const key = AXIS_DIMENSION_KEY[axis];
    const editedMeters = fromDisplayLength(Number(uploadDimensionInputEls[axis].value));
    if (!Number.isFinite(editedMeters) || editedMeters <= 0) return;
    const scaleFactor = editedMeters / uploadOriginalDimensions[key];
    if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return;
    for (const otherAxis of AXIS_LIST) {
      if (otherAxis === axis) continue;
      const otherKey = AXIS_DIMENSION_KEY[otherAxis];
      uploadDimensionInputEls[otherAxis].value = toDisplayLength(uploadOriginalDimensions[otherKey] * scaleFactor).toFixed(2);
    }
    updateUploadDimensionLabels();
  });
}

// A wider rounded-rect badge sized for a numeric string like "1.24m",
// unlike makeAxisLabelSprite's single-letter circular badge. Exposes
// userData.setText so the same sprite can be redrawn in place as the
// seller edits a dimension field.
function makeDimensionLabelSprite(text, colorHex) {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  const draw = (label) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = `#${colorHex.toString(16).padStart(6, '0')}`;
    ctx.beginPath();
    ctx.roundRect(2, 12, canvas.width - 4, canvas.height - 24, 16);
    ctx.fill();
    ctx.fillStyle = '#16240a';
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, canvas.width / 2, canvas.height / 2);
    texture.needsUpdate = true;
  };
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.renderOrder = 1;
  draw(text);
  sprite.userData.setText = draw;
  return sprite;
}

// Shows the freshly-uploaded (not-yet-created) model with its X/Y/Z
// dimensions labeled, mirroring the Seller modal's extensibility axis
// preview (showAxisPreview) but for a model that has no catalog template
// yet, so it's loaded directly via loadModelInstance rather than
// createMeshForInstance. The arrows/geometry are sized once to the
// original measured bounding box and never rescaled afterward — since
// dimension edits are always proportion-preserving (a uniform scale),
// every possible edit renders identically, so only the label text needs
// to change as the seller types (see updateUploadDimensionLabels).
async function showUploadDimensionPreview(modelUrl) {
  disposeUploadDimensionPreview();

  const canvas = document.createElement('canvas');
  canvas.className = 'seller-preview-canvas';
  uploadDimensionsPreviewEl.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(2, -3, 4);
  scene.add(sun);

  const previewObject = await loadModelInstance(modelUrl);
  scene.add(previewObject);

  const box = new THREE.Box3().setFromObject(previewObject);
  const size = box.getSize(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.05);

  const rect = canvas.getBoundingClientRect();
  const camera = new THREE.PerspectiveCamera(45, rect.width / Math.max(rect.height, 1), 0.01, 100);
  camera.up.set(0, 0, 1);
  const dist = radius * 2.6;
  camera.position.set(dist * 0.75, -dist * 0.95, dist * 0.65);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(rect.width, rect.height, false);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.minDistance = dist * 0.35;
  controls.maxDistance = dist * 3;
  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render);

  const axisDims = { x: size.x, y: size.y, z: size.z };
  const dirs = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
  const arrows = [];
  const labels = [];
  for (const axis of AXIS_LIST) {
    const length = axisDims[axis] / 2 + radius * 0.35;
    const color = AXIS_ARROW_COLORS[axis];
    const arrow = new THREE.ArrowHelper(dirs[axis], new THREE.Vector3(0, 0, 0), length, color, length * 0.3, length * 0.18);
    scene.add(arrow);
    arrows.push(arrow);
    const label = makeDimensionLabelSprite('', color);
    label.position.copy(dirs[axis]).multiplyScalar(length * 1.25);
    const labelScale = radius * 0.5;
    label.scale.set(labelScale, labelScale * 0.4, labelScale);
    scene.add(label);
    labels.push(label);
  }

  uploadDimensionPreview = { renderer, scene, camera, controls, previewObject, arrows, labels, render };
  updateUploadDimensionLabels();
}

function updateUploadDimensionLabels() {
  if (!uploadDimensionPreview) return;
  const dims = currentUploadDimensionsMeters();
  const axisLabelDims = { x: dims.width, y: dims.depth, z: dims.height };
  AXIS_LIST.forEach((axis, i) => {
    uploadDimensionPreview.labels[i].userData.setText(formatLength(axisLabelDims[axis]));
  });
  uploadDimensionPreview.render();
}

async function handleUploadFileStep() {
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
    uploadModelUrl = modelUrl;
    uploadOriginalDimensions = dimensions;
    setUploadDimensionInputs(dimensions);
    refreshUploadDimensionUnits();

    setUploadStatus('Loading preview…');
    await showUploadDimensionPreview(modelUrl);

    uploadStep = 'dimensions';
    uploadModalTitleEl.textContent = 'Confirm Dimensions';
    uploadStepFileEl.hidden = true;
    uploadStepDimensionsEl.hidden = false;
    uploadSubmitBtn.textContent = 'Create Product';
    setUploadStatus('');
  } catch (err) {
    console.error('Custom product upload failed:', err);
    setUploadStatus(err.message || 'Something went wrong.', true);
  } finally {
    uploadSubmitBtn.disabled = false;
  }
}

// A seller-edited dimension only counts as a real change worth re-encoding
// the model over — not just float noise from round-tripping through
// display units and a fixed 2-decimal display precision.
function dimensionsChanged(a, b) {
  return AXIS_LIST.some((axis) => {
    const key = AXIS_DIMENSION_KEY[axis];
    return Math.abs(a[key] - b[key]) > Math.max(0.001, a[key] * 0.005);
  });
}

async function handleUploadDimensionsStep() {
  const name = uploadNameInput.value.trim();
  const dimensions = currentUploadDimensionsMeters();
  if (!Object.values(dimensions).every((value) => Number.isFinite(value) && value > 0)) {
    setUploadStatus('Enter a positive size for each dimension.', true);
    return;
  }
  // Price is genuinely optional — a blank field means "no price set" (null),
  // not zero, mirroring priceCents' own null-means-unset convention
  // everywhere else (docs/API.md's "Catalog templates").
  const priceInput = uploadPriceInput.value.trim();
  let priceCents = null;
  if (priceInput) {
    const dollars = Number(priceInput);
    if (!Number.isFinite(dollars) || dollars < 0) {
      setUploadStatus('Price must be a non-negative number, or left blank.', true);
      return;
    }
    priceCents = Math.round(dollars * 100);
  }

  uploadSubmitBtn.disabled = true;
  try {
    let finalModelUrl = uploadModelUrl;
    // createMeshForInstance and (especially) loadCroppedModelInstance's
    // crop math both assume a template's declared dimensions exactly equal
    // the loaded model's own rendered size — see rescaleModelFile's own
    // doc comment. If the seller changed the size away from what was
    // actually measured, the uploaded file itself has to be rescaled to
    // match, not just the number stored alongside it.
    if (dimensionsChanged(dimensions, uploadOriginalDimensions)) {
      setUploadStatus('Applying your size change…');
      const scaleFactor = dimensions.width / uploadOriginalDimensions.width;
      const originalBlob = await fetch(uploadModelUrl).then((res) => res.blob());
      const rescaledBlob = await rescaleModelFile(originalBlob, scaleFactor);
      setUploadStatus('Uploading resized model…');
      finalModelUrl = (await uploadModelFile(new File([rescaledBlob], 'model.glb', { type: 'model/gltf-binary' }))).modelUrl;
    }

    setUploadStatus('Creating product…');
    // Upload Model only lives inside the (already-open) Seller modal now,
    // which already guaranteed a seller identity to open at all — this is
    // just a defensive fallback, not the primary path to one.
    const uploaderSellerId = await ensureSellerIdentity();
    const metadata = {};
    if (uploadDigitalGoodCheckbox.checked) {
      metadata.digitalGoodDisclaimer = uploadDigitalGoodDisclaimerSelect.value;
    }
    const template = await createCatalogTemplate({
      name,
      dimensions,
      color: '#999999', // only ever used if the model itself fails to load later
      modelUrl: finalModelUrl,
      sellerId: uploaderSellerId,
      priceCents,
      metadata,
    });

    activeCatalog.push(template);
    buildCatalogPickerButtons();
    closeUploadModal();
    // Back to the Seller modal it was opened from, with the new product
    // showing up right away — not straight into a Build-mode tap-to-place
    // flow, since Upload Model can now be reached from Shop (no landlet to
    // place onto at all) as easily as from Build.
    renderSellerList();
  } catch (err) {
    console.error('Custom product creation failed:', err);
    setUploadStatus(err.message || 'Something went wrong.', true);
  } finally {
    uploadSubmitBtn.disabled = false;
  }
}

uploadSubmitBtn.addEventListener('click', () => {
  if (uploadStep === 'file') handleUploadFileStep();
  else handleUploadDimensionsStep();
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

    // Dims/actions/preview/extensibility only show once this row is
    // actually tapped — mirrors the identity picker's own row redesign
    // (task #87), for the same reason: a product's full name matters more
    // than room for buttons it doesn't need yet.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'seller-row-toggle';
    const label = document.createElement('div');
    label.className = 'seller-row-label';
    label.textContent = template.name;
    toggle.appendChild(label);
    row.appendChild(toggle);

    const details = document.createElement('div');
    details.className = 'seller-row-details';
    row.appendChild(details);

    toggle.addEventListener('click', () => {
      const wasExpanded = row.classList.contains('expanded');
      for (const otherRow of sellerListEl.querySelectorAll('.seller-row')) otherRow.classList.remove('expanded');
      // A collapsed row's preview would otherwise keep a live WebGL
      // context running inside a display:none panel for nothing.
      disposeAxisPreview();
      previewBtn.classList.remove('active');
      if (!wasExpanded) row.classList.add('expanded');
    });

    const dims = document.createElement('div');
    dims.className = 'seller-row-dims';
    const refreshDimsText = () => {
      const { width, depth, height } = template.dimensions;
      dims.textContent = `${formatLength(width)} × ${formatLength(depth)} × ${formatLength(height)}`;
    };
    refreshDimsText();
    details.appendChild(dims);

    const priceText = document.createElement('div');
    priceText.className = 'seller-row-price';
    const refreshPriceText = () => {
      priceText.textContent = template.priceCents == null ? 'Not priced' : formatPriceCents(template.priceCents);
    };
    refreshPriceText();
    details.appendChild(priceText);

    // Digital good disclosure (docs/SPEC.md §4) — shown right under price
    // when set, same "Not X" convention as price's own "Not priced".
    const digitalGoodText = document.createElement('div');
    digitalGoodText.className = 'seller-row-digital-good';
    const refreshDigitalGoodText = () => {
      const key = template.metadata?.digitalGoodDisclaimer;
      digitalGoodText.textContent = key ? `Digital good: ${DIGITAL_GOOD_DISCLAIMER_TEXT[key]}` : 'Not a digital good';
    };
    refreshDigitalGoodText();
    details.appendChild(digitalGoodText);

    const digitalGoodToggle = document.createElement('button');
    digitalGoodToggle.className = 'seller-extensibility-toggle seller-digital-good-toggle';
    digitalGoodToggle.type = 'button';
    digitalGoodToggle.textContent = 'Edit Digital Good ▾';
    details.appendChild(digitalGoodToggle);

    const digitalGoodPanel = document.createElement('div');
    digitalGoodPanel.className = 'seller-digital-good-panel';
    digitalGoodPanel.hidden = true;
    details.appendChild(digitalGoodPanel);

    const digitalGoodCheckboxLabel = document.createElement('label');
    digitalGoodCheckboxLabel.className = 'seller-digital-good-checkbox-label';
    const digitalGoodCheckbox = document.createElement('input');
    digitalGoodCheckbox.type = 'checkbox';
    digitalGoodCheckboxLabel.appendChild(digitalGoodCheckbox);
    digitalGoodCheckboxLabel.appendChild(document.createTextNode('This is a digital good'));
    digitalGoodPanel.appendChild(digitalGoodCheckboxLabel);

    const digitalGoodSelect = document.createElement('select');
    digitalGoodSelect.className = 'seller-digital-good-select';
    for (const [key, text] of Object.entries(DIGITAL_GOOD_DISCLAIMER_TEXT)) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = text;
      digitalGoodSelect.appendChild(option);
    }
    digitalGoodPanel.appendChild(digitalGoodSelect);

    function fillDigitalGoodInputs() {
      const key = template.metadata?.digitalGoodDisclaimer;
      digitalGoodCheckbox.checked = !!key;
      digitalGoodSelect.value = key || 'gift-card';
      digitalGoodSelect.hidden = !digitalGoodCheckbox.checked;
    }
    fillDigitalGoodInputs();
    digitalGoodCheckbox.addEventListener('change', () => {
      digitalGoodSelect.hidden = !digitalGoodCheckbox.checked;
    });

    const digitalGoodStatus = document.createElement('div');
    digitalGoodStatus.className = 'seller-digital-good-status';

    const digitalGoodSaveBtn = document.createElement('button');
    digitalGoodSaveBtn.className = 'seller-digital-good-save-btn';
    digitalGoodSaveBtn.type = 'button';
    digitalGoodSaveBtn.textContent = 'Save Digital Good';
    digitalGoodSaveBtn.addEventListener('click', async () => {
      digitalGoodStatus.textContent = '';
      digitalGoodStatus.classList.remove('error');
      const nextMetadata = { ...template.metadata };
      if (digitalGoodCheckbox.checked) {
        nextMetadata.digitalGoodDisclaimer = digitalGoodSelect.value;
      } else {
        delete nextMetadata.digitalGoodDisclaimer;
      }
      digitalGoodSaveBtn.disabled = true;
      try {
        const updated = await updateCatalogTemplate(template.templateId, { metadata: nextMetadata });
        Object.assign(template, updated);
        refreshDigitalGoodText();
        digitalGoodStatus.textContent = 'Saved.';
      } catch (err) {
        digitalGoodStatus.textContent = err.message || 'Could not save.';
        digitalGoodStatus.classList.add('error');
      } finally {
        digitalGoodSaveBtn.disabled = false;
      }
    });
    digitalGoodPanel.appendChild(digitalGoodSaveBtn);
    digitalGoodPanel.appendChild(digitalGoodStatus);

    digitalGoodToggle.addEventListener('click', () => {
      digitalGoodPanel.hidden = !digitalGoodPanel.hidden;
      digitalGoodToggle.textContent = `Edit Digital Good ${digitalGoodPanel.hidden ? '▾' : '▴'}`;
      if (!digitalGoodPanel.hidden) fillDigitalGoodInputs();
    });

    // No-returns policy (docs/SPEC.md §5: "No-returns-policy respected as
    // seller-set default") — absent/false means returns are accepted (the
    // spec's own default), so a seller only ever opts INTO no-returns, same
    // single-boolean-in-metadata simplicity as digital goods above. Own
    // classes throughout for the same "don't share a class across
    // genuinely different rows/panels" reasoning as Extensibility vs. Edit
    // Size vs. Edit Digital Good.
    const noReturnsText = document.createElement('div');
    noReturnsText.className = 'seller-row-no-returns';
    const refreshNoReturnsText = () => {
      noReturnsText.textContent = template.metadata?.noReturns ? 'Returns: not accepted' : 'Returns: accepted';
    };
    refreshNoReturnsText();
    details.appendChild(noReturnsText);

    const noReturnsToggle = document.createElement('button');
    noReturnsToggle.className = 'seller-extensibility-toggle seller-no-returns-toggle';
    noReturnsToggle.type = 'button';
    noReturnsToggle.textContent = 'Edit Returns Policy ▾';
    details.appendChild(noReturnsToggle);

    const noReturnsPanel = document.createElement('div');
    noReturnsPanel.className = 'seller-no-returns-panel';
    noReturnsPanel.hidden = true;
    details.appendChild(noReturnsPanel);

    const noReturnsCheckboxLabel = document.createElement('label');
    noReturnsCheckboxLabel.className = 'seller-no-returns-checkbox-label';
    const noReturnsCheckbox = document.createElement('input');
    noReturnsCheckbox.type = 'checkbox';
    noReturnsCheckboxLabel.appendChild(noReturnsCheckbox);
    noReturnsCheckboxLabel.appendChild(document.createTextNode('This product does not accept returns'));
    noReturnsPanel.appendChild(noReturnsCheckboxLabel);

    const noReturnsStatus = document.createElement('div');
    noReturnsStatus.className = 'seller-no-returns-status';

    const noReturnsSaveBtn = document.createElement('button');
    noReturnsSaveBtn.className = 'seller-no-returns-save-btn';
    noReturnsSaveBtn.type = 'button';
    noReturnsSaveBtn.textContent = 'Save Returns Policy';
    noReturnsSaveBtn.addEventListener('click', async () => {
      noReturnsStatus.textContent = '';
      noReturnsStatus.classList.remove('error');
      const nextMetadata = { ...template.metadata };
      if (noReturnsCheckbox.checked) {
        nextMetadata.noReturns = true;
      } else {
        delete nextMetadata.noReturns;
      }
      noReturnsSaveBtn.disabled = true;
      try {
        const updated = await updateCatalogTemplate(template.templateId, { metadata: nextMetadata });
        Object.assign(template, updated);
        refreshNoReturnsText();
        noReturnsStatus.textContent = 'Saved.';
      } catch (err) {
        noReturnsStatus.textContent = err.message || 'Could not save.';
        noReturnsStatus.classList.add('error');
      } finally {
        noReturnsSaveBtn.disabled = false;
      }
    });
    noReturnsPanel.appendChild(noReturnsSaveBtn);
    noReturnsPanel.appendChild(noReturnsStatus);

    noReturnsToggle.addEventListener('click', () => {
      noReturnsPanel.hidden = !noReturnsPanel.hidden;
      noReturnsToggle.textContent = `Edit Returns Policy ${noReturnsPanel.hidden ? '▾' : '▴'}`;
      if (!noReturnsPanel.hidden) noReturnsCheckbox.checked = !!template.metadata?.noReturns;
    });

    // Shipping (docs/SPEC.md §5: "Dimmed-filter approach ... non-shippable
    // items are dimmed with a label ('ships to United States only')") —
    // absent/false means the product ships internationally (the spec's own
    // permissive default), same single-boolean-in-metadata simplicity and
    // own-classes-per-row reasoning as No-Returns above.
    const domesticOnlyText = document.createElement('div');
    domesticOnlyText.className = 'seller-row-domestic-only';
    const refreshDomesticOnlyText = () => {
      domesticOnlyText.textContent = template.metadata?.domesticOnly
        ? 'Shipping: United States only' : 'Shipping: international';
    };
    refreshDomesticOnlyText();
    details.appendChild(domesticOnlyText);

    const domesticOnlyToggle = document.createElement('button');
    domesticOnlyToggle.className = 'seller-extensibility-toggle seller-domestic-only-toggle';
    domesticOnlyToggle.type = 'button';
    domesticOnlyToggle.textContent = 'Edit Shipping ▾';
    details.appendChild(domesticOnlyToggle);

    const domesticOnlyPanel = document.createElement('div');
    domesticOnlyPanel.className = 'seller-domestic-only-panel';
    domesticOnlyPanel.hidden = true;
    details.appendChild(domesticOnlyPanel);

    const domesticOnlyCheckboxLabel = document.createElement('label');
    domesticOnlyCheckboxLabel.className = 'seller-domestic-only-checkbox-label';
    const domesticOnlyCheckbox = document.createElement('input');
    domesticOnlyCheckbox.type = 'checkbox';
    domesticOnlyCheckboxLabel.appendChild(domesticOnlyCheckbox);
    domesticOnlyCheckboxLabel.appendChild(document.createTextNode('This product ships to the United States only'));
    domesticOnlyPanel.appendChild(domesticOnlyCheckboxLabel);

    const domesticOnlyStatus = document.createElement('div');
    domesticOnlyStatus.className = 'seller-domestic-only-status';

    const domesticOnlySaveBtn = document.createElement('button');
    domesticOnlySaveBtn.className = 'seller-domestic-only-save-btn';
    domesticOnlySaveBtn.type = 'button';
    domesticOnlySaveBtn.textContent = 'Save Shipping';
    domesticOnlySaveBtn.addEventListener('click', async () => {
      domesticOnlyStatus.textContent = '';
      domesticOnlyStatus.classList.remove('error');
      const nextMetadata = { ...template.metadata };
      if (domesticOnlyCheckbox.checked) {
        nextMetadata.domesticOnly = true;
      } else {
        delete nextMetadata.domesticOnly;
      }
      domesticOnlySaveBtn.disabled = true;
      try {
        const updated = await updateCatalogTemplate(template.templateId, { metadata: nextMetadata });
        Object.assign(template, updated);
        refreshDomesticOnlyText();
        domesticOnlyStatus.textContent = 'Saved.';
      } catch (err) {
        domesticOnlyStatus.textContent = err.message || 'Could not save.';
        domesticOnlyStatus.classList.add('error');
      } finally {
        domesticOnlySaveBtn.disabled = false;
      }
    });
    domesticOnlyPanel.appendChild(domesticOnlySaveBtn);
    domesticOnlyPanel.appendChild(domesticOnlyStatus);

    domesticOnlyToggle.addEventListener('click', () => {
      domesticOnlyPanel.hidden = !domesticOnlyPanel.hidden;
      domesticOnlyToggle.textContent = `Edit Shipping ${domesticOnlyPanel.hidden ? '▾' : '▴'}`;
      if (!domesticOnlyPanel.hidden) domesticOnlyCheckbox.checked = !!template.metadata?.domesticOnly;
    });

    // Edit Size: correct a mis-measured (or since-outgrown) real-world
    // size after the fact — proportional-only, same as the upload
    // wizard's own dimensions step (handleUploadDimensionsStep), since
    // Trim (not this) is the tool for changing one instance's own aspect
    // ratio. A real uploaded model gets its actual geometry rescaled to
    // match (rescaleModelFile) and re-uploaded before the template is
    // patched — a placeholder box product has no model file to rescale,
    // so its dimensions alone are patched. Either way, the server-side
    // PATCH handler notifies every builder with this template placed
    // (see notifyBuildersOfDimensionChange) — nothing extra to call here.
    const sizeToggle = document.createElement('button');
    // Own classes throughout, not shared with the Extensibility toggle/
    // panel/rows below despite the identical look (same CSS rules, applied
    // to both) — several existing tests select the Extensibility panel's
    // axis rows/inputs by class and index (nth(0)/(1)/(2)) assuming exactly
    // three such elements per row; a second, earlier-in-DOM set under a
    // shared class would silently shift those indices.
    sizeToggle.className = 'seller-extensibility-toggle seller-size-toggle';
    sizeToggle.type = 'button';
    sizeToggle.textContent = 'Edit Size ▾';
    details.appendChild(sizeToggle);

    const sizePanel = document.createElement('div');
    sizePanel.className = 'seller-size-panel';
    sizePanel.hidden = true;
    details.appendChild(sizePanel);

    const sizeInputs = {};
    for (const axis of AXIS_LIST) {
      const axisRow = document.createElement('label');
      axisRow.className = 'seller-size-row';
      const text = document.createElement('span');
      text.textContent = AXIS_ROW_LABELS[axis];
      const input = document.createElement('input');
      input.className = 'seller-size-input';
      input.type = 'number';
      input.step = '0.01';
      input.min = '0';
      axisRow.appendChild(text);
      axisRow.appendChild(input);
      sizePanel.appendChild(axisRow);
      sizeInputs[axis] = input;
    }

    function fillSizeInputs() {
      for (const axis of AXIS_LIST) {
        sizeInputs[axis].value = toDisplayLength(template.dimensions[AXIS_DIMENSION_KEY[axis]]).toFixed(2);
      }
    }
    fillSizeInputs();

    // Editing one axis rescales the other two in lockstep off the
    // template's own current dimensions (not whatever's mid-edit in the
    // other fields), so repeated edits can't compound rounding error —
    // same approach as the upload wizard's proportional linking.
    for (const axis of AXIS_LIST) {
      sizeInputs[axis].addEventListener('input', () => {
        const key = AXIS_DIMENSION_KEY[axis];
        const editedMeters = fromDisplayLength(Number(sizeInputs[axis].value));
        if (!Number.isFinite(editedMeters) || editedMeters <= 0) return;
        const scaleFactor = editedMeters / template.dimensions[key];
        if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return;
        for (const otherAxis of AXIS_LIST) {
          if (otherAxis === axis) continue;
          const otherKey = AXIS_DIMENSION_KEY[otherAxis];
          sizeInputs[otherAxis].value = toDisplayLength(template.dimensions[otherKey] * scaleFactor).toFixed(2);
        }
      });
    }

    // Own classes, not .seller-row-status/.seller-save-btn (see the
    // classes comment above the toggle/panel) — several tests read "the"
    // row status or click "the" save button by class alone, assuming just
    // one of each per row.
    const sizeStatus = document.createElement('div');
    sizeStatus.className = 'seller-size-status';

    const sizeSaveBtn = document.createElement('button');
    sizeSaveBtn.className = 'seller-size-save-btn';
    sizeSaveBtn.type = 'button';
    sizeSaveBtn.textContent = 'Save Size';
    sizeSaveBtn.addEventListener('click', async () => {
      sizeStatus.textContent = '';
      sizeStatus.classList.remove('error');
      const nextDimensions = {
        width: fromDisplayLength(Number(sizeInputs.x.value)),
        depth: fromDisplayLength(Number(sizeInputs.y.value)),
        height: fromDisplayLength(Number(sizeInputs.z.value)),
      };
      if (!Object.values(nextDimensions).every((value) => Number.isFinite(value) && value > 0)) {
        sizeStatus.textContent = 'Enter a positive size for each dimension.';
        sizeStatus.classList.add('error');
        return;
      }
      if (!dimensionsChanged(nextDimensions, template.dimensions)) {
        sizeStatus.textContent = 'No change.';
        return;
      }
      sizeSaveBtn.disabled = true;
      try {
        const patch = { dimensions: nextDimensions };
        if (template.modelUrl?.startsWith('/uploads/')) {
          const scaleFactor = nextDimensions.width / template.dimensions.width;
          sizeStatus.textContent = 'Rescaling model…';
          const originalBlob = await fetch(template.modelUrl).then((res) => res.blob());
          const rescaledBlob = await rescaleModelFile(originalBlob, scaleFactor);
          sizeStatus.textContent = 'Uploading resized model…';
          patch.modelUrl = (await uploadModelFile(new File([rescaledBlob], 'model.glb', { type: 'model/gltf-binary' }))).modelUrl;
        }
        sizeStatus.textContent = 'Saving…';
        const updated = await updateCatalogTemplate(template.templateId, patch);
        Object.assign(template, updated);
        refreshDimsText();
        buildCatalogPickerButtons();
        if (axisPreview?.templateId === template.templateId) {
          showAxisPreview(template, previewContainer, extensibilityPanel.hidden ? null : checkedAxes());
        }
        sizeStatus.textContent = 'Saved — any builder with this placed has been notified.';
      } catch (err) {
        sizeStatus.textContent = err.message || 'Could not resize.';
        sizeStatus.classList.add('error');
      } finally {
        sizeSaveBtn.disabled = false;
      }
    });
    sizePanel.appendChild(sizeSaveBtn);
    sizePanel.appendChild(sizeStatus);

    sizeToggle.addEventListener('click', () => {
      sizePanel.hidden = !sizePanel.hidden;
      sizeToggle.textContent = `Edit Size ${sizePanel.hidden ? '▾' : '▴'}`;
      if (!sizePanel.hidden) fillSizeInputs();
    });

    // Edit Price: the only way a seller can ever set/change a product's
    // priceCents after upload (the upload wizard's own price field only
    // covers creation) — same collapsed-panel-with-a-Save-step idiom as
    // Edit Size just above, own classes throughout for the same reasons.
    const priceToggle = document.createElement('button');
    priceToggle.className = 'seller-extensibility-toggle seller-price-toggle';
    priceToggle.type = 'button';
    priceToggle.textContent = 'Edit Price ▾';
    details.appendChild(priceToggle);

    const pricePanel = document.createElement('div');
    pricePanel.className = 'seller-price-panel';
    pricePanel.hidden = true;
    details.appendChild(pricePanel);

    const priceInput = document.createElement('input');
    priceInput.className = 'seller-price-input';
    priceInput.type = 'number';
    priceInput.step = '0.01';
    priceInput.min = '0';
    priceInput.placeholder = 'e.g. 12.99, or blank for no price';
    pricePanel.appendChild(priceInput);

    function fillPriceInput() {
      priceInput.value = template.priceCents == null ? '' : (template.priceCents / 100).toFixed(2);
    }
    fillPriceInput();

    const priceStatus = document.createElement('div');
    priceStatus.className = 'seller-price-status';

    const priceSaveBtn = document.createElement('button');
    priceSaveBtn.className = 'seller-price-save-btn';
    priceSaveBtn.type = 'button';
    priceSaveBtn.textContent = 'Save Price';
    priceSaveBtn.addEventListener('click', async () => {
      priceStatus.textContent = '';
      priceStatus.classList.remove('error');
      const trimmed = priceInput.value.trim();
      let priceCents = null;
      if (trimmed) {
        const dollars = Number(trimmed);
        if (!Number.isFinite(dollars) || dollars < 0) {
          priceStatus.textContent = 'Price must be a non-negative number, or left blank.';
          priceStatus.classList.add('error');
          return;
        }
        priceCents = Math.round(dollars * 100);
      }
      if (priceCents === template.priceCents) {
        priceStatus.textContent = 'No change.';
        return;
      }
      priceSaveBtn.disabled = true;
      try {
        const updated = await updateCatalogTemplate(template.templateId, { priceCents });
        Object.assign(template, updated);
        refreshPriceText();
        priceStatus.textContent = 'Saved.';
        priceToggle.textContent = `Edit Price ${pricePanel.hidden ? '▾' : '▴'}`;
      } catch (err) {
        priceStatus.textContent = err.message || 'Could not save.';
        priceStatus.classList.add('error');
      } finally {
        priceSaveBtn.disabled = false;
      }
    });
    pricePanel.appendChild(priceSaveBtn);
    pricePanel.appendChild(priceStatus);

    priceToggle.addEventListener('click', () => {
      pricePanel.hidden = !pricePanel.hidden;
      priceToggle.textContent = `Edit Price ${pricePanel.hidden ? '▾' : '▴'}`;
      if (!pricePanel.hidden) fillPriceInput();
    });

    const rowStatus = document.createElement('div');
    rowStatus.className = 'seller-row-status';

    const actions = document.createElement('div');
    actions.className = 'seller-row-actions';
    details.appendChild(actions);

    const previewContainer = document.createElement('div');
    previewContainer.className = 'seller-row-preview';
    details.appendChild(previewContainer);

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

    // Ground/flooring (docs/SPEC.md §3, see isFlooringTemplate in this
    // file) — a single opt-in flag, not a numeric form like Extensibility
    // or Edit Size, so a plain immediate-PATCH toggle button fits better
    // than a collapsed panel with its own Save step.
    const flooringToggleBtn = document.createElement('button');
    flooringToggleBtn.className = 'seller-row-action-btn';
    flooringToggleBtn.type = 'button';
    flooringToggleBtn.classList.toggle('active', isFlooringTemplate(template));
    flooringToggleBtn.textContent = isFlooringTemplate(template) ? 'Flooring ✓' : 'Flooring';
    flooringToggleBtn.addEventListener('click', async () => {
      rowStatus.textContent = '';
      rowStatus.classList.remove('error');
      flooringToggleBtn.disabled = true;
      try {
        const nextMetadata = { ...template.metadata, flooring: !isFlooringTemplate(template) };
        if (!nextMetadata.flooring) delete nextMetadata.flooring;
        const updated = await updateCatalogTemplate(template.templateId, { metadata: nextMetadata });
        Object.assign(template, updated);
        flooringToggleBtn.classList.toggle('active', isFlooringTemplate(template));
        flooringToggleBtn.textContent = isFlooringTemplate(template) ? 'Flooring ✓' : 'Flooring';
        buildCatalogPickerButtons();
      } catch (err) {
        rowStatus.textContent = err.message || 'Could not update.';
        rowStatus.classList.add('error');
      } finally {
        flooringToggleBtn.disabled = false;
      }
    });
    actions.appendChild(flooringToggleBtn);

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
    details.appendChild(extensibilityToggle);

    const extensibilityPanel = document.createElement('div');
    extensibilityPanel.className = 'seller-extensibility-panel';
    extensibilityPanel.hidden = true;
    details.appendChild(extensibilityPanel);

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

    // Product reviews (docs/SPEC.md §5, docs/API.md's "Product reviews") —
    // shopper-authored, tied to this product itself rather than to any one
    // placed instance of it, so this is the seller's own moderation view,
    // not a Build-mode one. Collapsed by default like Extensibility above,
    // fetched lazily on first open rather than for every row up front.
    const reviewToggle = document.createElement('button');
    reviewToggle.className = 'seller-extensibility-toggle seller-review-toggle';
    reviewToggle.type = 'button';
    reviewToggle.textContent = 'Reviews ▾';
    details.appendChild(reviewToggle);

    const reviewPanel = document.createElement('div');
    reviewPanel.className = 'seller-review-panel';
    reviewPanel.hidden = true;
    details.appendChild(reviewPanel);

    const reviewSummaryEl = document.createElement('div');
    reviewSummaryEl.className = 'seller-review-summary';
    reviewPanel.appendChild(reviewSummaryEl);

    const reviewListEl = document.createElement('div');
    reviewListEl.className = 'seller-review-list';
    reviewPanel.appendChild(reviewListEl);

    const reviewEmptyEl = document.createElement('div');
    reviewEmptyEl.className = 'seller-review-empty';
    reviewEmptyEl.textContent = 'No reviews yet.';
    reviewPanel.appendChild(reviewEmptyEl);

    async function renderReviews() {
      reviewListEl.innerHTML = '';
      reviewSummaryEl.textContent = '';
      let reviews;
      let averageRating;
      try {
        ({ reviews, averageRating } = await fetchProductReviews(template.templateId));
      } catch (err) {
        reviewEmptyEl.textContent = err.message || 'Could not load reviews.';
        reviewEmptyEl.hidden = false;
        return;
      }
      reviewEmptyEl.hidden = reviews.length > 0;
      if (reviews.length > 0) {
        const stars = '★'.repeat(Math.round(averageRating)) + '☆'.repeat(5 - Math.round(averageRating));
        reviewSummaryEl.textContent = `${stars} ${averageRating.toFixed(1)} average (${reviews.length} review${reviews.length === 1 ? '' : 's'})`;
      }
      for (const review of reviews) {
        const reviewRow = document.createElement('div');
        reviewRow.className = 'product-review-row';
        const body = document.createElement('div');
        body.className = 'product-review-row-body';
        const author = document.createElement('div');
        author.className = 'product-review-row-author';
        author.textContent = review.authorLabel;
        body.appendChild(author);
        const rating = document.createElement('div');
        rating.className = 'product-review-row-rating';
        rating.textContent = '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
        body.appendChild(rating);
        if (review.text) {
          const text = document.createElement('div');
          text.textContent = review.text;
          body.appendChild(text);
        }
        const time = document.createElement('div');
        time.className = 'product-review-row-time';
        const date = new Date(review.createdAt);
        time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
        body.appendChild(time);
        reviewRow.appendChild(body);
        const deleteRowBtn = document.createElement('button');
        deleteRowBtn.className = 'product-review-row-delete';
        deleteRowBtn.type = 'button';
        deleteRowBtn.textContent = '×';
        deleteRowBtn.setAttribute('aria-label', 'Delete review');
        deleteRowBtn.addEventListener('click', async () => {
          deleteRowBtn.disabled = true;
          try {
            await deleteProductReview(template.templateId, review.reviewId);
            await renderReviews();
          } catch (err) {
            console.warn('Could not delete review:', err);
            deleteRowBtn.disabled = false;
          }
        });
        reviewRow.appendChild(deleteRowBtn);
        reviewListEl.appendChild(reviewRow);
      }
    }

    reviewToggle.addEventListener('click', () => {
      reviewPanel.hidden = !reviewPanel.hidden;
      reviewToggle.textContent = `Reviews ${reviewPanel.hidden ? '▾' : '▴'}`;
      if (!reviewPanel.hidden) renderReviews();
    });

    // Simulated purchases (docs/API.md's "Simulated purchases"/"Refunds")
    // — this product's own sale history, across every builder who happens
    // to host an instance of it (fetchPurchases by templateId, not
    // builderId — see handlePurchases' own comment in worker/index.js).
    // Refunding is seller-initiated here, standing in for a real
    // customer-service-initiated refund (docs/SPEC.md §6's
    // no-personal-support-contact policy) — shoppers have no account in
    // this dev-mode identity system to authenticate a "my purchases"
    // self-service view against in the first place.
    const salesToggle = document.createElement('button');
    salesToggle.className = 'seller-extensibility-toggle seller-sales-toggle';
    salesToggle.type = 'button';
    salesToggle.textContent = 'Sales ▾';
    details.appendChild(salesToggle);

    const salesPanel = document.createElement('div');
    salesPanel.className = 'seller-sales-panel';
    salesPanel.hidden = true;
    details.appendChild(salesPanel);

    const salesSummaryEl = document.createElement('div');
    salesSummaryEl.className = 'seller-sales-summary';
    salesPanel.appendChild(salesSummaryEl);

    const salesListEl = document.createElement('div');
    salesListEl.className = 'seller-sales-list';
    salesPanel.appendChild(salesListEl);

    const salesEmptyEl = document.createElement('div');
    salesEmptyEl.className = 'seller-sales-empty';
    salesEmptyEl.textContent = 'No sales yet.';
    salesPanel.appendChild(salesEmptyEl);

    async function renderSales() {
      salesListEl.innerHTML = '';
      salesSummaryEl.textContent = '';
      let purchases;
      try {
        purchases = await fetchPurchases({ templateId: template.templateId });
      } catch (err) {
        salesEmptyEl.textContent = err.message || 'Could not load sales.';
        salesEmptyEl.hidden = false;
        return;
      }
      salesEmptyEl.hidden = purchases.length > 0;
      if (purchases.length > 0) {
        salesSummaryEl.textContent = `${purchases.length} sale${purchases.length === 1 ? '' : 's'}`;
      }
      for (const purchase of purchases) {
        const saleRow = document.createElement('div');
        saleRow.className = 'product-sale-row';
        const body = document.createElement('div');
        body.className = 'product-sale-row-body';
        const summary = document.createElement('div');
        summary.className = 'product-sale-row-summary';
        summary.textContent = `${purchase.buyerLabel || 'Anonymous'} — ${purchase.quantity}x, ${formatPriceCents(purchase.totalCents)} total`;
        body.appendChild(summary);
        const commission = document.createElement('div');
        commission.className = 'product-sale-row-commission';
        commission.textContent = `You earned ${formatPriceCents(purchase.builderShareCents)}`;
        body.appendChild(commission);
        const time = document.createElement('div');
        time.className = 'product-sale-row-time';
        const date = new Date(purchase.createdAt);
        time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
        body.appendChild(time);
        saleRow.appendChild(body);

        if (purchase.refundedAt) {
          const refundedLabel = document.createElement('div');
          refundedLabel.className = 'product-sale-row-refunded';
          refundedLabel.textContent = 'Refunded';
          saleRow.appendChild(refundedLabel);
        } else {
          const refundBtn = document.createElement('button');
          refundBtn.className = 'product-sale-row-refund-btn';
          refundBtn.type = 'button';
          refundBtn.textContent = 'Refund';
          refundBtn.addEventListener('click', async () => {
            refundBtn.disabled = true;
            try {
              await refundPurchase(purchase.purchaseId);
              await renderSales();
            } catch (err) {
              alert(err.message || 'Could not refund this purchase.');
              refundBtn.disabled = false;
            }
          });
          saleRow.appendChild(refundBtn);
        }
        salesListEl.appendChild(saleRow);
      }
    }

    salesToggle.addEventListener('click', () => {
      salesPanel.hidden = !salesPanel.hidden;
      salesToggle.textContent = `Sales ${salesPanel.hidden ? '▾' : '▴'}`;
      if (!salesPanel.hidden) renderSales();
    });

    details.appendChild(rowStatus);
    sellerListEl.appendChild(row);
  }
}

// Ensures a seller identity is active before showing the modal. Only
// reachable via the #mode-nav Sell tab (openSellerModal call sites below),
// which calls this rather than separately remembering to await
// ensureSellerIdentity() first. Backing out of that picker (Close) means
// there's still no seller identity — just leave the Seller modal unopened
// rather than showing it with nothing to filter its list by.
async function openSellerModal() {
  const id = await ensureSellerIdentity();
  if (!id) {
    updateModeNavUI(); // undoes the Sell button's own optimistic highlight below
    return;
  }
  renderSellerList();
  sellerModalEl.classList.add('visible');
}
function closeSellerModal() {
  sellerModalEl.classList.remove('visible');
  disposeAxisPreview();
  // An Edit Size save while this modal was open can have just created a
  // notification for this same builder identity — refresh the badge now
  // rather than leaving it stale until the next Build-mode entry.
  refreshNotificationsBadge();
  // A save in here can change whether the currently-selected item (if any)
  // is extensible — updateSelectionUI() only normally re-runs on an actual
  // selection *change*, so without this the Trim button/field would keep
  // showing whatever was true when the modal opened, stale until the
  // builder reselected something.
  updateSelectionUI();
  // Sell never actually changes currentMode (see #mode-nav's own click
  // handler below — it's a modal overlay on top of Build/Shop, not a real
  // mode transition), so leaving it needs to explicitly restore whichever
  // of Shop/Build's nav buttons was really active underneath, rather than
  // leaving Sell looking active forever once its own highlight (also set
  // there) was the last thing to touch these buttons.
  updateModeNavUI();
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

  if (activeSettingsTab === 'general') {
    renderGeneralSettingsSection();
    return;
  }
  if (activeSettingsTab === 'build') {
    renderBuildSettingsSection();
    return;
  }
  if (activeSettingsTab === 'auctions') {
    renderAuctionsSettingsSection();
    return;
  }

  const note = document.createElement('div');
  note.className = 'settings-empty-note';
  note.textContent = 'Nothing to configure here yet.';
  settingsSectionEl.appendChild(note);
}

function renderGeneralSettingsSection() {
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

  const versionField = document.createElement('div');
  versionField.className = 'settings-field';
  const versionLabel = document.createElement('span');
  versionLabel.textContent = 'Version';
  versionField.appendChild(versionLabel);
  const versionValue = document.createElement('div');
  versionValue.className = 'settings-empty-note';
  versionValue.textContent = BUILD_INFO_TEXT;
  versionField.appendChild(versionValue);
  settingsSectionEl.appendChild(versionField);
}

// Land cap (docs/SPEC.md §3, docs/API.md's "Land cap") — a builder-account
// fact, not tied to the currently-active landlet the way Publish/Version
// History below are, so this shows regardless of currentMode/
// currentLandletId (as long as a builder identity has actually been
// chosen at all this session — builderId can still be null if Settings is
// opened from Shop mode before ever entering Build).
async function renderLandCapField() {
  if (!builderId) return;
  const field = document.createElement('div');
  field.className = 'settings-field';
  const fieldLabel = document.createElement('span');
  fieldLabel.textContent = 'Land Cap';
  field.appendChild(fieldLabel);
  const status = document.createElement('div');
  status.className = 'settings-empty-note';
  status.textContent = 'Loading…';
  field.appendChild(status);
  settingsSectionEl.appendChild(field);
  try {
    const [builders, ownedLandlets] = await Promise.all([
      fetchBuilders(),
      fetchLandlets({ status: 'claimed', ownerBuilderId: builderId, limit: 100 }),
    ]);
    const me = builders.find((b) => b.builderId === builderId);
    const ownedAreaM2 = ownedLandlets.reduce((sum, l) => sum + l.areaM2, 0);
    status.textContent = `You own ${ownedAreaM2.toLocaleString()} m² of your ${me.landCapM2.toLocaleString()} m² cap. ` +
      'Your cap grows automatically as you earn dállers from selling land via auction — never purchasable with cash.';
  } catch (err) {
    status.textContent = err.message || 'Could not load your land cap.';
  }
}

// Publish + Version History (see docs/API.md's "Landlet drafts"/"Landlet
// versions") — the one place the already-existing draft/version/activate
// backend gets a frontend. Only meaningful while actually in Build mode on
// a claimed landlet (Settings itself stays reachable from Shop too, but
// there's no landlet to publish from there).
function renderBuildSettingsSection() {
  renderLandCapField();
  if (currentMode !== 'build' || !currentLandletId) {
    const note = document.createElement('div');
    note.className = 'settings-empty-note';
    note.textContent = 'Enter Build mode on a claimed landlet to publish or manage versions.';
    settingsSectionEl.appendChild(note);
    return;
  }
  const landletId = currentLandletId;

  const publishField = document.createElement('div');
  publishField.className = 'settings-field';
  const publishLabel = document.createElement('span');
  publishLabel.textContent = 'Publish';
  publishField.appendChild(publishLabel);
  const publishHint = document.createElement('div');
  publishHint.className = 'settings-empty-note';
  publishHint.textContent = 'Shoppers see whatever was last published here, not your live edits, until you publish again.';
  publishField.appendChild(publishHint);
  const publishBtn = document.createElement('button');
  publishBtn.type = 'button';
  publishBtn.className = 'version-action-btn';
  publishBtn.textContent = 'Publish';
  publishField.appendChild(publishBtn);
  const publishStatus = document.createElement('div');
  publishStatus.id = 'build-publish-status';
  publishStatus.className = 'settings-empty-note';
  publishField.appendChild(publishStatus);
  settingsSectionEl.appendChild(publishField);

  const historyField = document.createElement('div');
  historyField.className = 'settings-field';
  const historyLabel = document.createElement('span');
  historyLabel.textContent = 'Version History';
  historyField.appendChild(historyLabel);
  const historyList = document.createElement('div');
  historyList.className = 'version-list';
  historyField.appendChild(historyList);
  settingsSectionEl.appendChild(historyField);

  async function renderVersionHistory() {
    historyList.innerHTML = '<div class="settings-empty-note">Loading…</div>';
    let versions;
    let activeVersionId;
    try {
      [{ versions }, { activeVersionId }] = await Promise.all([
        fetchLandletVersions(landletId, { limit: 20 }),
        fetchLandlet(landletId),
      ]);
    } catch (err) {
      historyList.innerHTML = '';
      const errNote = document.createElement('div');
      errNote.className = 'settings-empty-note';
      errNote.textContent = err.message || 'Could not load version history.';
      historyList.appendChild(errNote);
      return;
    }
    historyList.innerHTML = '';
    if (versions.length === 0) {
      historyList.innerHTML = '<div class="settings-empty-note">No versions saved yet — Publish creates the first one.</div>';
      return;
    }
    for (const version of versions) {
      const row = document.createElement('div');
      row.className = 'version-row';

      const info = document.createElement('div');
      info.className = 'version-row-info';
      const itemWord = version.instanceCount === 1 ? 'item' : 'items';
      const liveTag = version.versionId === activeVersionId ? ' — live' : '';
      info.textContent = `${version.name} — ${version.instanceCount} ${itemWord} — ${new Date(version.createdAt).toLocaleString()}${liveTag}`;
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'version-row-actions';

      const setLiveBtn = document.createElement('button');
      setLiveBtn.type = 'button';
      setLiveBtn.className = 'version-action-btn';
      setLiveBtn.textContent = 'Set Live';
      setLiveBtn.disabled = version.versionId === activeVersionId;
      setLiveBtn.addEventListener('click', async () => {
        setLiveBtn.disabled = true;
        try {
          await activateLandletVersion(landletId, version.versionId);
          // Feedback goes through the shared publishStatus, not a status
          // element inside this row — renderVersionHistory() (below) tears
          // down and rebuilds every row's DOM, including this one, so
          // anything set on a per-row element here would be wiped before
          // ever actually being visible.
          publishStatus.textContent = `Shoppers now see "${version.name}".`;
          publishStatus.classList.remove('error');
          renderVersionHistory();
        } catch (err) {
          publishStatus.textContent = err.message || 'Could not activate.';
          publishStatus.classList.add('error');
          setLiveBtn.disabled = false;
        }
      });
      actions.appendChild(setLiveBtn);

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'version-action-btn';
      restoreBtn.textContent = 'Restore to Editor';
      restoreBtn.addEventListener('click', async () => {
        if (!confirm(`Replace everything currently placed with "${version.name}"? This saves its own version first, so it's reversible, but everything since your last save will be gone from the live editor.`)) return;
        restoreBtn.disabled = true;
        publishStatus.textContent = 'Restoring…';
        publishStatus.classList.remove('error');
        try {
          const full = await fetchLandletVersion(landletId, version.versionId);
          await replaceLandletDraft(landletId, {
            instances: full.instances,
            versionName: `Restored from "${version.name}"`,
          });
          // Simplest correct way to get the live scene back in sync with
          // whatever the server now holds — the same "something changed
          // server-side, reload" pattern claimBackBtn already uses
          // elsewhere in this file.
          sessionStorage.setItem(START_MODE_KEY, 'build');
          location.reload();
        } catch (err) {
          publishStatus.textContent = err.message || 'Could not restore.';
          publishStatus.classList.add('error');
          restoreBtn.disabled = false;
        }
      });
      actions.appendChild(restoreBtn);

      row.appendChild(actions);
      historyList.appendChild(row);
    }
  }

  publishBtn.addEventListener('click', async () => {
    publishBtn.disabled = true;
    publishStatus.textContent = 'Publishing…';
    publishStatus.classList.remove('error');
    try {
      const version = await saveLandletVersion(landletId, {});
      await activateLandletVersion(landletId, version.versionId);
      publishStatus.textContent = `Published as "${version.name}" — shoppers now see this.`;
      renderVersionHistory();
    } catch (err) {
      publishStatus.textContent = err.message || 'Could not publish.';
      publishStatus.classList.add('error');
    } finally {
      publishBtn.disabled = false;
    }
  });

  renderVersionHistory();
}

function formatDallers(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// A catalog template's own priceCents (docs/API.md's "Catalog templates")
// is a real-world USD price a shopper would pay for the product — a
// distinct concept from dállers (the platform's internal commission
// currency, formatDallers above) even though the cents-to-dollars math is
// identical, so this stays its own named helper rather than reusing that
// one.
function formatPriceCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// Mirrors worker/index.js's own DIGITAL_GOOD_DISCLAIMER_TEXT (docs/SPEC.md
// §4's "clear higglehaven-controlled disclaimer") — kept as a second copy
// here rather than fetched from the server, since it's small, static, and
// needed synchronously while building each seller-row's DOM.
const DIGITAL_GOOD_DISCLAIMER_TEXT = {
  'gift-card': 'Digital gift card to a real business',
  'art-file': 'Digital art or print file',
  'software-tool': 'higglehaven-ecosystem software tool',
};

function formatAuctionTimeRemaining(isoString) {
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms <= 0) return 'ending soon';
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  return hours >= 1 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
}

function formatAuctionSummary(auction) {
  const bidText = auction.highestBidCents !== null
    ? `high bid ${formatDallers(auction.highestBidCents)} (${auction.bidCount} bid${auction.bidCount === 1 ? '' : 's'})`
    : `no bids yet, starts at ${formatDallers(auction.startingBidCents)}`;
  const outcomeText = auction.startingBidCents === 0
    ? 'free to the highest bidder, or released if unsold'
    : `stays yours at ${formatDallers(auction.startingBidCents)} if unsold`;
  return `${auction.landletId} — ${bidText} — ${formatAuctionTimeRemaining(auction.endsAt)} — ${outcomeText}`;
}

// Land acquisition auctions (docs/SPEC.md §5, docs/API.md's "Land
// acquisition auctions") — its own Settings tab, reachable regardless of
// mode, since bidding on someone else's landlet isn't a "your own Build
// session" action the way Publish/Version History is. Covers both
// starting a voluntary auction on whatever landlet this identity
// currently owns and browsing/bidding on every other active auction in
// the world.
async function renderAuctionsSettingsSection() {
  if (!builderId) {
    const note = document.createElement('div');
    note.className = 'settings-empty-note';
    note.textContent = 'Choose a builder identity to start or bid on an auction.';
    settingsSectionEl.appendChild(note);
    return;
  }

  const startField = document.createElement('div');
  startField.className = 'settings-field';
  const startLabel = document.createElement('span');
  startLabel.textContent = 'Sell Your Land';
  startField.appendChild(startLabel);
  const startStatus = document.createElement('div');
  startStatus.className = 'settings-empty-note';
  startField.appendChild(startStatus);
  settingsSectionEl.appendChild(startField);

  const listField = document.createElement('div');
  listField.className = 'settings-field';
  const listLabel = document.createElement('span');
  listLabel.textContent = 'Active Auctions';
  listField.appendChild(listLabel);
  const auctionList = document.createElement('div');
  auctionList.className = 'auction-list';
  listField.appendChild(auctionList);
  settingsSectionEl.appendChild(listField);

  async function renderStartSection() {
    startStatus.textContent = '';
    startStatus.classList.remove('error');
    for (const el of startField.querySelectorAll('.auction-start-form, .auction-row')) el.remove();
    let owned;
    try {
      owned = await fetchLandlets({ status: 'claimed', ownerBuilderId: builderId, limit: 1 });
    } catch (err) {
      startStatus.textContent = err.message || 'Could not check your landlet.';
      startStatus.classList.add('error');
      return;
    }
    if (owned.length === 0) {
      startStatus.textContent = 'Claim a landlet first to auction it off.';
      return;
    }
    const myLandletId = owned[0].landletId;
    let activeForMine;
    try {
      activeForMine = await fetchAuctions({ status: 'active', landletId: myLandletId });
    } catch (err) {
      startStatus.textContent = err.message || 'Could not check for an existing auction.';
      startStatus.classList.add('error');
      return;
    }
    if (activeForMine.length > 0) {
      const row = document.createElement('div');
      row.className = 'auction-row';
      const info = document.createElement('div');
      info.className = 'auction-row-info';
      info.textContent = `Your auction is live — ${formatAuctionSummary(activeForMine[0])}`;
      row.appendChild(info);
      startField.appendChild(row);
      return;
    }

    startStatus.textContent = 'A $0 starting bid gives it away free if nobody bids; any other amount keeps it yours if it goes unsold.';
    const form = document.createElement('div');
    form.className = 'auction-start-form';
    const bidLabel = document.createElement('label');
    bidLabel.textContent = 'Starting bid ($)';
    const bidInput = document.createElement('input');
    bidInput.type = 'number';
    bidInput.min = '0';
    bidInput.step = '0.01';
    bidInput.value = '0';
    bidLabel.appendChild(bidInput);
    form.appendChild(bidLabel);
    const durationLabel = document.createElement('label');
    durationLabel.textContent = 'Duration (hours)';
    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.min = '1';
    durationInput.step = '1';
    durationInput.value = '24';
    durationLabel.appendChild(durationInput);
    form.appendChild(durationLabel);
    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'auction-start-btn';
    startBtn.textContent = 'Start Auction';
    startBtn.addEventListener('click', async () => {
      const dollars = Number(bidInput.value);
      const hours = Number(durationInput.value);
      if (!Number.isFinite(dollars) || dollars < 0) {
        startStatus.textContent = 'Starting bid must be zero or more.';
        startStatus.classList.add('error');
        return;
      }
      if (!Number.isFinite(hours) || hours < 1) {
        startStatus.textContent = 'Duration must be at least 1 hour.';
        startStatus.classList.add('error');
        return;
      }
      startBtn.disabled = true;
      try {
        await startAuction(myLandletId, {
          startingBidCents: Math.round(dollars * 100),
          durationHours: Math.round(hours),
        });
        await renderStartSection();
        await renderAuctionList();
      } catch (err) {
        startStatus.textContent = err.message || 'Could not start the auction.';
        startStatus.classList.add('error');
        startBtn.disabled = false;
      }
    });
    form.appendChild(startBtn);
    startField.appendChild(form);
  }

  async function renderAuctionList() {
    auctionList.innerHTML = '<div class="settings-empty-note">Loading…</div>';
    let auctions;
    try {
      auctions = await fetchAuctions({ status: 'active' });
    } catch (err) {
      auctionList.innerHTML = '';
      const errNote = document.createElement('div');
      errNote.className = 'settings-empty-note';
      errNote.textContent = err.message || 'Could not load auctions.';
      auctionList.appendChild(errNote);
      return;
    }
    auctionList.innerHTML = '';
    if (auctions.length === 0) {
      auctionList.innerHTML = '<div class="settings-empty-note">No active auctions right now.</div>';
      return;
    }
    for (const auction of auctions) {
      const row = document.createElement('div');
      row.className = 'auction-row';
      const info = document.createElement('div');
      info.className = 'auction-row-info';
      info.textContent = formatAuctionSummary(auction);
      row.appendChild(info);

      // GET /auctions already resolves anything past its end time before
      // this list is built (see resolveDueAuctions in worker/index.js) —
      // this button exists only for the narrow gap between that moment
      // and the *next* fetch, e.g. a second tab that loaded the list a
      // moment before this one's own timer ran out. Anyone can trigger
      // it; resolution is an objective time-based fact, not a seller- or
      // bidder-specific action.
      const isPastDue = new Date(auction.endsAt).getTime() <= Date.now();
      if (isPastDue) {
        const resolveBtn = document.createElement('button');
        resolveBtn.type = 'button';
        resolveBtn.className = 'auction-resolve-btn';
        resolveBtn.textContent = 'Resolve Now';
        resolveBtn.addEventListener('click', async () => {
          resolveBtn.disabled = true;
          try {
            await resolveAuctionNow(auction.auctionId);
            await renderAuctionList();
            await renderStartSection();
          } catch (err) {
            alert(err.message || 'Could not resolve this auction.');
            resolveBtn.disabled = false;
          }
        });
        row.appendChild(resolveBtn);
      } else if (auction.sellerBuilderId !== builderId) {
        // A seller doesn't bid on their own listing — same row, just no
        // bid form, rather than a disabled one (nothing useful to type
        // into it).
        const form = document.createElement('div');
        form.className = 'auction-row-bid-form';
        const minCents = auction.highestBidCents !== null ? auction.highestBidCents + 1 : auction.startingBidCents;
        const bidInput = document.createElement('input');
        bidInput.type = 'number';
        bidInput.className = 'auction-row-bid-input';
        bidInput.min = (minCents / 100).toFixed(2);
        bidInput.step = '0.01';
        bidInput.placeholder = `${formatDallers(minCents)}+`;
        form.appendChild(bidInput);
        const bidBtn = document.createElement('button');
        bidBtn.type = 'button';
        bidBtn.className = 'auction-bid-btn';
        bidBtn.textContent = 'Place Bid';
        bidBtn.addEventListener('click', async () => {
          const dollars = Number(bidInput.value);
          if (!Number.isFinite(dollars) || dollars < 0) return;
          bidBtn.disabled = true;
          try {
            await placeBid(auction.auctionId, { amountCents: Math.round(dollars * 100) });
            await renderAuctionList();
            await renderStartSection();
          } catch (err) {
            alert(err.message || 'Could not place bid.');
            bidBtn.disabled = false;
          }
        });
        form.appendChild(bidBtn);
        row.appendChild(form);
      }
      auctionList.appendChild(row);
    }
  }

  renderStartSection();
  renderAuctionList();
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
const snapToggleBtn = document.getElementById('toggle-snap');
const copyBtn = document.getElementById('copy-item');
const saveBundleBtn = document.getElementById('save-bundle-item');
const communitySignBtn = document.getElementById('toggle-community-sign');
const communityCalendarBtn = document.getElementById('toggle-community-calendar');
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

// Set for the duration of restoreSnapshot's own await (mesh rebuilding plus
// the batch create/update/delete network calls) — without it, a second
// rapid click (a trackpad double-click, or just an eager user) before the
// first restoreSnapshot resolves would pop another snapshot and start a
// second, concurrent restoreSnapshot mutating the same shared
// productMeshes/selectedMeshes/undoStack/redoStack and firing overlapping
// batch requests, potentially for the same instance IDs.
let undoRedoBusy = false;

function updateUndoRedoButtons() {
  undoBtn.disabled = undoRedoBusy || undoStack.length === 0;
  redoBtn.disabled = undoRedoBusy || redoStack.length === 0;
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
  if (undoStack.length === 0 || undoRedoBusy) return;
  undoRedoBusy = true;
  updateUndoRedoButtons();
  try {
    const previous = undoStack.pop();
    redoStack.push(captureSnapshot());
    await restoreSnapshot(previous);
  } finally {
    undoRedoBusy = false;
    updateUndoRedoButtons();
  }
}

async function redo() {
  if (redoStack.length === 0 || undoRedoBusy) return;
  undoRedoBusy = true;
  updateUndoRedoButtons();
  try {
    const next = redoStack.pop();
    undoStack.push(captureSnapshot());
    await restoreSnapshot(next);
  } finally {
    undoRedoBusy = false;
    updateUndoRedoButtons();
  }
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
    // effectiveLength lives in the template's own (unscaled) space — a
    // legacy instance carrying a per-instance Resize scale from before
    // that feature was removed still needs its crop length shown as the
    // real, currently-rendered size, not the pre-scale one.
    const length = effectiveLength(mesh.userData.template, mesh.userData, axis, AXIS_DIMENSION_KEY[axis]) * (mesh.userData.scale ?? 1);
    field.querySelector('.trim-length-input').value = toDisplayLength(length).toFixed(2);
  }
}

let currentGizmoMode = 'translate';
function setGizmoMode(mode) {
  currentGizmoMode = mode;
  modeMoveBtn.classList.toggle('active', mode === 'translate');
  modeRotateBtn.classList.toggle('active', mode === 'rotate');
  modeTrimBtn.classList.toggle('active', mode === 'trim');
  translateControls.detach();
  rotateControls.detach();
  trimControls.detach();
  trimLengthControlEl.classList.remove('visible');
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
let measurePointB = null;

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

// Invisible, larger companion spheres co-located with each visible marker —
// a raycast against the marker's own true 0.06m-radius geometry is a
// precise-tap-only target, unforgiving for grabbing it back on a touchscreen
// once it's already placed. These exist purely as a bigger hit-test
// surface (see hitTestMeasureMarkerAt below); kept in perfect sync with
// their visible counterpart's position/visibility rather than parented to
// it, since a Group would be one more thing to keep synced with undo/scene
// teardown for no real benefit here.
const measureMarkerHitGeometry = new THREE.SphereGeometry(0.18, 8, 8);
const measureMarkerHitMaterial = new THREE.MeshBasicMaterial({ visible: false });
const measureMarkerAHit = new THREE.Mesh(measureMarkerHitGeometry, measureMarkerHitMaterial);
const measureMarkerBHit = new THREE.Mesh(measureMarkerHitGeometry, measureMarkerHitMaterial);
measureMarkerAHit.visible = false;
measureMarkerBHit.visible = false;
scene.add(measureMarkerAHit, measureMarkerBHit);

const measureLineGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const measureLineMaterial = new THREE.LineDashedMaterial({ color: MEASURE_COLOR, dashSize: 0.15, gapSize: 0.08, depthTest: false });
const measureLine = new THREE.Line(measureLineGeometry, measureLineMaterial);
measureLine.visible = false;
measureLine.renderOrder = 999;
scene.add(measureLine);

function clearMeasurement() {
  measurePointA = null;
  measurePointB = null;
  measureMarkerA.visible = false;
  measureMarkerB.visible = false;
  measureMarkerAHit.visible = false;
  measureMarkerBHit.visible = false;
  measureLine.visible = false;
}

// The current reading, recomputed identically whether the second point was
// just placed or an already-placed endpoint was just dragged somewhere new.
function updateMeasureResultText() {
  const dx = Math.abs(measurePointB.x - measurePointA.x);
  const dy = Math.abs(measurePointB.y - measurePointA.y);
  const dz = Math.abs(measurePointB.z - measurePointA.z);
  const distance = measurePointA.distanceTo(measurePointB);
  setProductInfo(
    `${formatLength(distance)} — Δx ${formatLength(dx)}, Δy ${formatLength(dy)}, Δz ${formatLength(dz)} (drag either point, or tap elsewhere to start over)`);
}

function updateMeasureInfo() {
  if (measurePointA && measurePointB) {
    updateMeasureResultText();
  } else {
    setProductInfo(measurePointA
      ? 'Measure: tap a second point.'
      : 'Measure: tap a point to start.');
  }
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

// Which endpoint (if either) sits under the raycaster right now — checked
// against the larger invisible hit spheres, not the visible markers
// themselves (see their own comment). Only ever tested against whichever
// endpoints are actually placed.
function hitTestMeasureMarkerAt(event) {
  raycaster.setFromCamera(ndcFromEvent(event), camera);
  const targets = [];
  if (measureMarkerAHit.visible) targets.push(measureMarkerAHit);
  if (measureMarkerBHit.visible) targets.push(measureMarkerBHit);
  const hit = raycaster.intersectObjects(targets)[0];
  if (!hit) return null;
  return hit.object === measureMarkerAHit ? 'A' : 'B';
}

function handleMeasureClick() {
  const point = resolveMeasurePoint();
  if (!point) return;
  if (measurePointA && measurePointB) {
    // A tap anywhere else once a measurement is already complete starts a
    // fresh one — this point becomes the new point A. Dragging an existing
    // endpoint (see the pointerdown/pointermove handlers below) is the
    // separate, more common way to adjust a measurement without losing it.
    clearMeasurement();
  }
  if (!measurePointA) {
    measurePointA = point.clone();
    measureMarkerA.position.copy(measurePointA);
    measureMarkerAHit.position.copy(measurePointA);
    measureMarkerA.visible = true;
    measureMarkerAHit.visible = true;
    measureMarkerB.visible = false;
    measureMarkerBHit.visible = false;
    measureLine.visible = false;
    updateMeasureInfo();
    return;
  }
  measurePointB = point.clone();
  measureMarkerB.position.copy(measurePointB);
  measureMarkerBHit.position.copy(measurePointB);
  measureMarkerB.visible = true;
  measureMarkerBHit.visible = true;
  measureLineGeometry.setFromPoints([measurePointA, measurePointB]);
  measureLine.computeLineDistances();
  measureLine.visible = true;
  updateMeasureResultText();
}

// Dragging an already-placed endpoint to adjust a measurement without
// starting over — the same free-form "point anywhere on ground or a
// product" resolution as placing it originally (resolveMeasurePoint), just
// driven by pointermove instead of a single click. Not wired through
// OrbitControls/TransformControls at all (a measurement isn't a scene
// object with its own undo/persistence story, just a local visual aid),
// so this is a small dedicated pointerdown/move/up sequence — the same
// shape as the free-look pointer tracking above, but scoped to Measure
// mode and to a hit on one of the two endpoint hitboxes specifically.
let draggingMeasureMarker = null; // 'A' | 'B' | null
let measureMarkerWasDragged = false;

// Registered on window with capture, not as a plain listener on
// renderer.domElement — OrbitControls attaches its own pointerdown handler
// directly to that same element (in its constructor, long before this
// code runs), and two listeners on one element always fire in
// *registration* order regardless of capture/bubble (that distinction only
// applies between an element and its ancestors). Only a capture-phase
// listener on an ancestor is guaranteed to see the event, and be able to
// act on it (disabling controls, stopping propagation), before
// OrbitControls' own listener does — the same ordering problem, and the
// same fix, as the free-look wheel listener above.
window.addEventListener('pointerdown', (event) => {
  if (!measureMode) return;
  // Reset before the hit test, not after — a plain tap elsewhere (placing
  // a fresh point, not grabbing an endpoint) still needs a clean flag for
  // its own upcoming 'click', and it wouldn't get one if this stayed
  // gated behind "only when a marker is actually hit": a big enough drag
  // on an endpoint never fires a native 'click' at all (see the 'click'
  // handler's own guard for why this flag exists in the first place), so
  // the only guaranteed next opportunity to clear it is the very next
  // pointerdown, whatever gesture that turns out to be.
  measureMarkerWasDragged = false;
  const hit = hitTestMeasureMarkerAt(event);
  if (!hit) return;
  draggingMeasureMarker = hit;
  // Grabbing an endpoint is not a camera gesture — without this, the same
  // one-finger drag that's repositioning the marker would simultaneously
  // free-look (or orbit) the camera underneath it via OrbitControls' own
  // handling of this identical pointerdown/move sequence. stopPropagation
  // here keeps every other pointerdown-driven thing (OrbitControls, the
  // free-look gesture counter, multi-select's swipe tracker) from ever
  // seeing this press at all, not just this one's worth of camera motion.
  controls.enabled = false;
  event.stopPropagation();
}, { capture: true });
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!draggingMeasureMarker) return;
  event.stopPropagation();
  raycaster.setFromCamera(ndcFromEvent(event), camera);
  const point = resolveMeasurePoint();
  if (!point) return;
  measureMarkerWasDragged = true;
  if (draggingMeasureMarker === 'A') {
    measurePointA = point.clone();
    measureMarkerA.position.copy(measurePointA);
    measureMarkerAHit.position.copy(measurePointA);
  } else {
    measurePointB = point.clone();
    measureMarkerB.position.copy(measurePointB);
    measureMarkerBHit.position.copy(measurePointB);
  }
  if (measurePointA && measurePointB) {
    measureLineGeometry.setFromPoints([measurePointA, measurePointB]);
    measureLine.computeLineDistances();
    updateMeasureResultText();
  }
});
function endMeasureMarkerDrag() {
  if (!draggingMeasureMarker) return;
  draggingMeasureMarker = null;
  controls.enabled = true;
}
window.addEventListener('pointerup', endMeasureMarkerDrag);
window.addEventListener('pointercancel', endMeasureMarkerDrag);

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
  // Defensive, not expected in normal single-pointer use (releasing a drag
  // always fires pointerup first, which already restores this via
  // endMeasureMarkerDrag) — but leaving controls disabled if this were
  // ever reached mid-drag would strand the camera with no way to move it.
  if (draggingMeasureMarker) {
    draggingMeasureMarker = null;
    controls.enabled = true;
  }
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
    // The typed value is a real, final measured length — "choose the
    // final measured size after the trim" — but crop is stored in the
    // template's own unscaled space (see effectiveLength). Clamping and
    // storing in that same real space first, then converting once at the
    // very end, keeps a legacy per-instance Resize scale (see
    // trimStartScale's own comment) from silently turning "3 feet" into a
    // fraction of that.
    const scale = mesh.userData.scale ?? 1;
    const requestedLength = fromDisplayLength(requestedDisplayLength);
    const clampedRealLength = THREE.MathUtils.clamp(requestedLength, extensible.minM * scale, maxLength * scale);
    const clampedLength = clampedRealLength / scale;
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
    translateControls.detach();
    rotateControls.detach();
    trimControls.detach();
    return;
  }
  const count = selectedMeshes.size;
  if (count === 0) {
    setProductInfo('');
    modeControlsEl.classList.remove('visible');
    trimLengthControlEl.classList.remove('visible');
    translateControls.detach();
    rotateControls.detach();
    trimControls.detach();
    return;
  }
  setProductInfo(count === 1 ? [...selectedMeshes][0].userData.template.name : `${count} items selected`);
  modeControlsEl.classList.add('visible');
  // Rotate has no group form (rotating several items around a shared pivot
  // while also spinning each one's own orientation is a much harder problem
  // than was asked for) — only Move is offered for a multi-item selection.
  // Disabling Rotate (rather than hiding it) keeps every other button —
  // Move, Snap, Copy, Delete — in the same position regardless of selection
  // count; removing it from the layout entirely let the rest reflow into
  // different left/right groupings depending on whether Rotate happened to
  // be there. Trim follows the same reasoning, disabled (not hidden) for
  // both a multi-item selection and a single non-extensible one.
  modeRotateBtn.disabled = count !== 1;
  const singleMesh = count === 1 ? [...selectedMeshes][0] : null;
  modeTrimBtn.disabled = !singleMesh || !extensibleAxes(singleMesh.userData.template);
  // Community Sign (docs/API.md's "Community signs") only makes sense for
  // one specific placed object at a time, same reasoning as Trim above —
  // disabled (not hidden) for a multi-item selection so the button row
  // doesn't reflow.
  communitySignBtn.disabled = !singleMesh;
  communitySignBtn.classList.toggle('active', !!singleMesh?.userData.isCommunitySign);
  // Once flagged, this same button opens the Manage Posts panel instead of
  // un-flagging directly (see its own click handler) — the label makes
  // that click destination explicit rather than reading like a second
  // identical toggle.
  communitySignBtn.textContent = singleMesh?.userData.isCommunitySign ? 'Community Sign ✓ (Manage)' : 'Community Sign';
  // Community Calendar (docs/API.md's "Community calendar") — same
  // reasoning and same toggle-then-manage button design as Community Sign
  // just above, independent of it.
  communityCalendarBtn.disabled = !singleMesh;
  communityCalendarBtn.classList.toggle('active', !!singleMesh?.userData.isCommunityCalendar);
  communityCalendarBtn.textContent = singleMesh?.userData.isCommunityCalendar ? 'Community Calendar ✓ (Manage)' : 'Community Calendar';
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
    trimLengthControlEl.classList.remove('visible');
    translateControls.detach();
    rotateControls.detach();
    trimControls.detach();
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

// Each selected item's position/rotation *relative* to the group — offset
// from the group's centroid in X/Y, and height above the group's lowest
// bottom surface in Z (its "base") — rather than absolute coordinates, so
// the result can be re-anchored wherever a builder taps next (see
// handlePlacementClick/placeClipboardItems). Shared by Copy (kept in the
// in-memory clipboard for this session only) and Save Bundle (persisted to
// the backend so it survives a reload and works on any landlet) — both
// just want "this exact arrangement, portable."
function relativeItemsForMeshes(meshes) {
  const centroidX = meshes.reduce((sum, mesh) => sum + mesh.position.x, 0) / meshes.length;
  const centroidY = meshes.reduce((sum, mesh) => sum + mesh.position.y, 0) / meshes.length;
  const baseZ = Math.min(...meshes.map((mesh) => mesh.position.z - meshDimensions(mesh).height / 2));
  return meshes.map((mesh) => ({
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
}

// Copy captures the current selection into the in-memory clipboard —
// see relativeItemsForMeshes for the actual offset math this and Save
// Bundle share. This is what lets a whole course of a brick wall get
// copy-pasted as one unit instead of one brick at a time.
function copySelection() {
  if (selectedMeshes.size === 0) return;
  const meshes = [...selectedMeshes];
  clipboard = relativeItemsForMeshes(meshes);
  pasteBtn.disabled = false;
  // There's nothing left to multi-select once the copy is captured, and
  // multi-select repurposes a one-finger drag into a selection swipe —
  // leaving it on would strand the builder without the ability to rotate
  // the camera while navigating to a spot to paste.
  exitMultiSelectMode();
  const count = meshes.length;
  setProductInfo(`Copied ${count} item${count === 1 ? '' : 's'}`);
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

// Save Bundle persists the current selection's relative arrangement to the
// backend (see relativeItemsForMeshes) so it can be stamped down again
// later — in a different session, or on a different landlet entirely —
// rather than only living in this session's in-memory clipboard the way an
// ordinary Copy does.
saveBundleBtn.addEventListener('click', async () => {
  if (selectedMeshes.size === 0) return;
  const meshes = [...selectedMeshes];
  const name = prompt('Name this bundle', '');
  if (!name || !name.trim()) return;
  // Private by default (docs/SPEC.md's Bundles section) — sharing is an
  // explicit extra step, not the default, so a plain confirm() dialog
  // (declined by default on most platforms) rather than folding it into
  // the name prompt itself.
  const shared = confirm('Share this bundle to the Community tab so any builder can use it too?');
  saveBundleBtn.disabled = true;
  try {
    const bundle = await createBundle({ name: name.trim(), items: relativeItemsForMeshes(meshes), shared });
    myBundles.unshift(bundle);
    if (shared) communityBundles.unshift(bundle);
    renderBundlePicker();
    const count = meshes.length;
    setProductInfo(`Saved "${bundle.name}" (${count} item${count === 1 ? '' : 's'})`);
    setTimeout(updateSelectionUI, 1200);
  } catch (err) {
    console.error('Could not save bundle:', err);
    setProductInfo(err.message || 'Could not save bundle.');
  } finally {
    saveBundleBtn.disabled = false;
  }
});

// Community Sign (docs/SPEC.md §6, docs/API.md's "Community signs") — an
// immediate-PATCH flag on the single selected instance the first time (the
// same pattern the Seller modal's own Flooring button uses for a
// per-instance/per-template boolean rather than a form with its own Save
// step). Once already flagged, this same button instead opens the Manage
// Posts panel (#sign-posts-modal, below) rather than un-flagging directly
// — un-flagging lives inside that panel's own "Remove Community Sign"
// button instead. A dedicated always-present "Manage Posts" toolbar button
// was tried first and reverted: on a phone-width viewport it pushed
// #gizmo-mode-controls' wrapped button row tall enough to physically
// overlap and intercept taps meant for the 3D canvas beneath it (caught by
// e2e/bundles.test.mjs — an unrelated test — suddenly failing to select a
// placed tree). Folding both actions into one button removes that extra
// row entirely.
communitySignBtn.addEventListener('click', async () => {
  if (selectedMeshes.size !== 1) return;
  const [mesh] = selectedMeshes;
  if (mesh.userData.isCommunitySign) {
    openSignPostsModal(mesh);
    return;
  }
  mesh.userData.isCommunitySign = true;
  updateSelectionUI();
  persistLayout();
  await syncUpdate(mesh);
});

// A builder's moderation view onto one sign's posts (see docs/API.md's
// "Community signs"), reusing the same modal shell #notifications-modal
// already establishes. Build mode never renders a sign's post sprites
// itself (those are Shop-mode-only, see registerShopSign), so this modal
// is the only place a builder ever sees what's actually been posted.
const signPostsModalEl = document.getElementById('sign-posts-modal');
const signPostsCloseBtn = document.getElementById('sign-posts-close-btn');
const signPostsListEl = document.getElementById('sign-posts-list');
const signPostsEmptyEl = document.getElementById('sign-posts-empty');
const signPostsUnflagBtn = document.getElementById('sign-posts-unflag-btn');
let signPostsTargetMesh = null;

function formatSignPostTime(isoString) {
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

async function renderSignPosts() {
  signPostsListEl.innerHTML = '';
  if (!signPostsTargetMesh) return;
  const instanceId = signPostsTargetMesh.userData.instanceId;
  let posts;
  try {
    posts = await fetchSignPosts(instanceId);
  } catch (err) {
    signPostsEmptyEl.textContent = err.message || 'Could not load posts.';
    signPostsEmptyEl.hidden = false;
    return;
  }
  signPostsEmptyEl.hidden = posts.length > 0;
  for (const post of posts) {
    const row = document.createElement('div');
    row.className = 'sign-post-row';
    const body = document.createElement('div');
    body.className = 'sign-post-row-body';
    const author = document.createElement('div');
    author.className = 'sign-post-row-author';
    author.textContent = post.authorLabel;
    body.appendChild(author);
    const text = document.createElement('div');
    text.textContent = post.text;
    body.appendChild(text);
    const time = document.createElement('div');
    time.className = 'sign-post-row-time';
    time.textContent = formatSignPostTime(post.createdAt);
    body.appendChild(time);
    row.appendChild(body);
    const deleteRowBtn = document.createElement('button');
    deleteRowBtn.className = 'sign-post-row-delete';
    deleteRowBtn.type = 'button';
    deleteRowBtn.textContent = '×';
    deleteRowBtn.setAttribute('aria-label', 'Delete post');
    deleteRowBtn.addEventListener('click', async () => {
      deleteRowBtn.disabled = true;
      try {
        await deleteSignPost(instanceId, post.postId);
        await renderSignPosts();
      } catch (err) {
        console.warn('Could not delete post:', err);
        deleteRowBtn.disabled = false;
      }
    });
    row.appendChild(deleteRowBtn);
    signPostsListEl.appendChild(row);
  }
}

function openSignPostsModal(mesh) {
  signPostsTargetMesh = mesh;
  signPostsModalEl.classList.add('visible');
  renderSignPosts();
}
signPostsCloseBtn.addEventListener('click', () => {
  signPostsModalEl.classList.remove('visible');
  signPostsTargetMesh = null;
});
signPostsUnflagBtn.addEventListener('click', async () => {
  if (!signPostsTargetMesh) return;
  const mesh = signPostsTargetMesh;
  mesh.userData.isCommunitySign = false;
  signPostsModalEl.classList.remove('visible');
  signPostsTargetMesh = null;
  updateSelectionUI();
  persistLayout();
  await syncUpdate(mesh);
});

// Community Calendar (docs/SPEC.md §6, docs/API.md's "Community
// calendar") — structurally identical to Community Sign just above (same
// toggle-then-manage button design, same reasoning), deliberately kept as
// its own independent flag/table rather than merged with signs — see
// migrations/0042's own comment.
communityCalendarBtn.addEventListener('click', async () => {
  if (selectedMeshes.size !== 1) return;
  const [mesh] = selectedMeshes;
  if (mesh.userData.isCommunityCalendar) {
    openCalendarEventsModal(mesh);
    return;
  }
  mesh.userData.isCommunityCalendar = true;
  updateSelectionUI();
  persistLayout();
  await syncUpdate(mesh);
});

// A builder's moderation view onto one calendar's events — same shell/
// pattern as the sign posts modal just above.
const calendarEventsModalEl = document.getElementById('calendar-events-modal');
const calendarEventsCloseBtn = document.getElementById('calendar-events-close-btn');
const calendarEventsListEl = document.getElementById('calendar-events-list');
const calendarEventsEmptyEl = document.getElementById('calendar-events-empty');
const calendarEventsUnflagBtn = document.getElementById('calendar-events-unflag-btn');
let calendarEventsTargetMesh = null;

function formatCalendarEventTime(isoString) {
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

async function renderCalendarEvents() {
  calendarEventsListEl.innerHTML = '';
  if (!calendarEventsTargetMesh) return;
  const instanceId = calendarEventsTargetMesh.userData.instanceId;
  let events;
  try {
    events = await fetchCalendarEvents(instanceId);
  } catch (err) {
    calendarEventsEmptyEl.textContent = err.message || 'Could not load events.';
    calendarEventsEmptyEl.hidden = false;
    return;
  }
  calendarEventsEmptyEl.hidden = events.length > 0;
  for (const event of events) {
    const row = document.createElement('div');
    row.className = 'calendar-event-row';
    const body = document.createElement('div');
    body.className = 'calendar-event-row-body';
    const author = document.createElement('div');
    author.className = 'calendar-event-row-author';
    author.textContent = event.authorLabel;
    body.appendChild(author);
    const text = document.createElement('div');
    text.textContent = event.text;
    body.appendChild(text);
    const time = document.createElement('div');
    time.className = 'calendar-event-row-time';
    time.textContent = formatCalendarEventTime(event.createdAt);
    body.appendChild(time);
    if (event.scheduledAt) {
      const schedule = document.createElement('div');
      schedule.className = 'calendar-event-row-time';
      schedule.textContent = event.triggeredAt
        ? `🎉 Fired at ${formatCalendarEventTime(event.triggeredAt)}`
        : `⏳ Scheduled for ${formatCalendarEventTime(event.scheduledAt)}`;
      body.appendChild(schedule);
    }
    row.appendChild(body);
    const deleteRowBtn = document.createElement('button');
    deleteRowBtn.className = 'calendar-event-row-delete';
    deleteRowBtn.type = 'button';
    deleteRowBtn.textContent = '×';
    deleteRowBtn.setAttribute('aria-label', 'Delete event');
    deleteRowBtn.addEventListener('click', async () => {
      deleteRowBtn.disabled = true;
      try {
        await deleteCalendarEvent(instanceId, event.eventId);
        await renderCalendarEvents();
      } catch (err) {
        console.warn('Could not delete event:', err);
        deleteRowBtn.disabled = false;
      }
    });
    row.appendChild(deleteRowBtn);
    calendarEventsListEl.appendChild(row);
  }
}

function openCalendarEventsModal(mesh) {
  calendarEventsTargetMesh = mesh;
  calendarEventsModalEl.classList.add('visible');
  renderCalendarEvents();
}
calendarEventsCloseBtn.addEventListener('click', () => {
  calendarEventsModalEl.classList.remove('visible');
  calendarEventsTargetMesh = null;
});
calendarEventsUnflagBtn.addEventListener('click', async () => {
  if (!calendarEventsTargetMesh) return;
  const mesh = calendarEventsTargetMesh;
  mesh.userData.isCommunityCalendar = false;
  calendarEventsModalEl.classList.remove('visible');
  calendarEventsTargetMesh = null;
  updateSelectionUI();
  persistLayout();
  await syncUpdate(mesh);
});

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
  setProductInfo(statusText);
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
    // A drag that grabbed and moved an endpoint (see the pointerdown/
    // pointermove handlers above) can still land under CLICK_DRAG_THRESHOLD_PX
    // and fire this native 'click' too — without this guard it would be
    // read as "place a new point right here," undoing the drag that had
    // just finished.
    if (measureMarkerWasDragged) {
      measureMarkerWasDragged = false;
      return;
    }
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
// Declared here (rather than right next to the 'change' listener that
// mostly uses it below) so this pointerdown handler and the wheel listener
// further down can both reach it — both are genuinely new, unambiguous
// gestures, and need to clear any free-look left sticking around from a
// previous rotate's still-damping tail (see the 'change' listener's own
// comment on why it doesn't clear itself on release) before it wrongly
// hijacks them into pinning the camera in place.
let freeLookActive = false;
const freeLookAnchorPosition = new THREE.Vector3();
renderer.domElement.addEventListener('pointerdown', () => {
  activePointerCount++;
  freeLookActive = false;
  if (activePointerCount === 1) {
    pendingGestureCheck = true;
  }
});
// Wheel-driven dolly never fires a pointerdown, so it needs its own
// explicit clear — registered on window with capture so it reliably runs
// before OrbitControls' own wheel listener (attached directly to
// renderer.domElement in its constructor): two listeners on the very same
// element fire in registration order regardless of capture/bubble, so
// only an ancestor's capture-phase listener is guaranteed to go first.
window.addEventListener('wheel', () => { freeLookActive = false; }, { capture: true, passive: true });
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

// Free-look with nothing selected — two earlier raycasting-based stand-in
// pivots were each tried and reverted: both picked a point that rarely
// matched wherever controls.target already was, producing a visible jump
// right as the rotate began. This instead reuses OrbitControls itself
// (rather than a second, parallel camera controller like Shop mode's) but
// continuously cancels out the one part of its behavior that felt wrong:
// with nothing selected, a "rotate" orbits camera.position around a
// stale, arbitrary target, so a builder ends up circling some point that
// isn't where they're looking. Every 'change' event during such a drag
// restores camera.position to exactly where it was when the drag began,
// and instead moves the (otherwise invisible) target to stay a fixed
// distance directly ahead of that anchored position — mathematically,
// "look only" is just "orbit around a phantom point that tracks the
// camera" rather than a fixed world point. The net feel matches Shop
// mode's own look controls (position never moves, only facing direction
// changes) while staying inside OrbitControls' existing rotate/pan/dolly
// machinery rather than replacing it outright. freeLookActive/
// freeLookAnchorPosition themselves are declared up near
// pendingGestureCheck, not here, since the pointerdown/wheel listeners
// there need to reach them too.
controls.addEventListener('change', () => {
  if (pendingGestureCheck) {
    const isRotate = controls.state === ROTATE_STATE || controls.state === TOUCH_ROTATE_STATE;
    if (!isRotate) {
      pendingGestureCheck = false;
      // A pan or dolly starting right on the heels of a previous free-look
      // drag's damping tail (see below for why freeLookActive outlives the
      // drag itself) is a genuinely different gesture — don't keep pinning
      // position against it.
      freeLookActive = false;
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
        const pivot = getSelectionPivot();
        if (pivot) {
          freeLookActive = false;
          beginTargetTween(pivot);
        } else {
          freeLookActive = true;
          freeLookAnchorPosition.copy(camera.position);
        }
      }
    }
  }

  // Deliberately NOT reset on pointerup/pointercancel the way
  // pendingGestureCheck is — enableDamping means OrbitControls keeps
  // dispatching "change" events for a few frames after release as the
  // rotation coasts to a stop, and those damped frames need the exact same
  // position-pinning or the tail end of every free-look drag would yank
  // back to a stale-target orbit for its last few frames. It only turns
  // off above, once a genuinely different gesture (pan/dolly, or a rotate
  // that lands on a real selection) is confirmed.
  if (freeLookActive) {
    camera.getWorldDirection(cameraDirection);
    camera.position.copy(freeLookAnchorPosition);
    controls.target.copy(freeLookAnchorPosition).addScaledVector(cameraDirection, lastKnownDistance || 1);
  }

  const newDistance = camera.position.distanceTo(controls.target);
  if (selectedMeshes.size === 0 && !freeLookActive) {
    const dollyDelta = lastKnownDistance - newDistance;
    if (Math.abs(dollyDelta) > 1e-6) {
      camera.getWorldDirection(cameraDirection);
      controls.target.addScaledVector(cameraDirection, dollyDelta);
      // Free-flying like this has no built-in floor the way orbiting a
      // fixed target does — controls.maxDistance only bounds a single
      // dolly tick (see this block's own doc comment above), not the total
      // distance flown across many of them. A builder repeatedly zooming
      // to try to reach a product that turned out to be pathologically
      // oversized (an unconverted import defaulting to the wrong real-world
      // scale, say) could otherwise fly the target thousands of kilometers
      // from the landlet with no way back — camera.position ends up out
      // past camera.far, the whole scene renders as nothing but the flat
      // background sky color, and neither scrolling nor rotating gives any
      // visual cue which direction leads home. Clamping keeps every dolly
      // tick within a radius still comfortably inside camera.far, so the
      // landlet and sky stay visible and reachable no matter how much
      // scrolling happened trying to get away from (or into) something huge.
      controls.target.clampLength(0, MAX_FLY_TARGET_DISTANCE_M);
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
    updateShopSky(now);
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

// Real login (docs/API.md's "Authentication") replaced the dev-mode
// identity picker that used to live here — entering Build or Sell mode
// now requires a real account, and the resulting builder/seller profile
// is whichever one that account already has (auto-provisioned server-
// side — see migrations/0054_link_builders_sellers_to_users.sql), not a
// free-text label picked from a shared list. ensureBuilderIdentity/
// ensureSellerIdentity below keep the exact same Promise<id-or-null>
// contract the old picker-backed versions had (null only if the login
// prompt is dismissed without logging in), so every other call site in
// this file — bootstrap()'s Build-mode startup, openSellerModal, the
// Upload Model fallback — needed no changes at all.

// Blocks on a real login if nobody's logged in yet, opening #auth-modal
// (openAuthModal/closeAuthModal/waitForAuthResult are defined with the
// rest of the account-menu wiring further down) and resolving once
// login/signup succeeds, or with null if the modal is dismissed without
// either. Closes the modal itself once resolved — the generic signup
// handler deliberately leaves it open afterward to show a dev-mode
// verify-email link (see its own comment), which would otherwise sit on
// top of the claim/build UI this is about to reveal.
async function requireLogin(view = 'signup', hint) {
  if (currentAuthUser) return currentAuthUser;
  openAuthModal(view);
  // openAuthModal itself clears any status text, so this has to come
  // after — a plain, neutral message (no error/success styling) saying
  // *why* a login wall just appeared, rather than leaving a first-time
  // visitor to guess.
  if (hint) setAuthStatus(hint);
  const user = await waitForAuthResult();
  closeAuthModal();
  return user;
}

// Two independent in-flight promises (not one shared "identity" flow),
// for the same reason the old picker's own comment gave: Build mode's own
// startup can be awaiting a login at the very moment the Sell nav button
// triggers its own, and each needs to resolve independently.
let builderIdentityFlowPromise = null;
async function ensureBuilderIdentity() {
  if (builderId) return builderId;
  if (!builderIdentityFlowPromise) {
    builderIdentityFlowPromise = (async () => {
      const user = await requireLogin('signup', 'Sign up (or log in) to start building.');
      if (!user) return null;
      const builder = await fetchMyBuilder();
      builderId = builder.builderId;
      return builderId;
    })();
  }
  const id = await builderIdentityFlowPromise;
  builderIdentityFlowPromise = null;
  return id;
}

let sellerIdentityFlowPromise = null;
async function ensureSellerIdentity() {
  if (sellerId) return sellerId;
  if (!sellerIdentityFlowPromise) {
    sellerIdentityFlowPromise = (async () => {
      const user = await requireLogin('signup', 'Sign up (or log in) to start selling.');
      if (!user) return null;
      const seller = await fetchMySeller();
      sellerId = seller.sellerId;
      return sellerId;
    })();
  }
  const id = await sellerIdentityFlowPromise;
  sellerIdentityFlowPromise = null;
  return id;
}

// Builder-facing notifications (see migrations/0038_notifications.sql) —
// currently only ever produced by a seller changing a placed product's
// dimensions (notifyBuildersOfDimensionChange, worker/index.js). A plain
// pill button + badge count, refreshed whenever a builder identity
// resolves or the modal itself opens/closes — no live polling, since
// nothing else in this app pushes updates to an already-open tab either.
const notificationsBtn = document.getElementById('notifications-btn');
const notificationsBadgeEl = document.getElementById('notifications-badge');
const notificationsModalEl = document.getElementById('notifications-modal');
const notificationsCloseBtn = document.getElementById('notifications-close-btn');
const notificationsListEl = document.getElementById('notifications-list');
const notificationsEmptyEl = document.getElementById('notifications-empty');
const notificationsMarkAllBtn = document.getElementById('notifications-mark-all-btn');

async function refreshNotificationsBadge() {
  if (!builderId) return;
  try {
    const unread = await fetchNotifications({ unreadOnly: true });
    notificationsBadgeEl.textContent = String(unread.length);
    notificationsBadgeEl.hidden = unread.length === 0;
  } catch (err) {
    console.warn('Could not refresh notifications badge:', err);
  }
}

function formatNotificationTime(isoString) {
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

async function renderNotifications() {
  notificationsListEl.innerHTML = '';
  if (!builderId) return;
  let notifications;
  try {
    notifications = await fetchNotifications();
  } catch (err) {
    notificationsEmptyEl.textContent = err.message || 'Could not load notices.';
    notificationsEmptyEl.hidden = false;
    return;
  }
  notificationsEmptyEl.hidden = notifications.length > 0;
  for (const notification of notifications) {
    const row = document.createElement('div');
    row.className = 'notification-row';
    row.classList.toggle('unread', !notification.readAt);
    const message = document.createElement('div');
    message.textContent = notification.message;
    row.appendChild(message);
    const time = document.createElement('div');
    time.className = 'notification-row-time';
    time.textContent = formatNotificationTime(notification.createdAt);
    row.appendChild(time);
    // Tapping any notice marks just that one read — simpler than a
    // separate per-row dismiss button, and "Mark all read" still exists
    // for clearing the whole list at once.
    if (!notification.readAt) {
      row.addEventListener('click', async () => {
        try {
          await markNotificationRead(notification.notificationId);
          row.classList.remove('unread');
          refreshNotificationsBadge();
        } catch (err) {
          console.warn('Could not mark notification read:', err);
        }
      });
    }
    notificationsListEl.appendChild(row);
  }
}

notificationsBtn.addEventListener('click', () => {
  notificationsModalEl.classList.add('visible');
  renderNotifications();
});
notificationsCloseBtn.addEventListener('click', () => {
  notificationsModalEl.classList.remove('visible');
  refreshNotificationsBadge();
});
notificationsMarkAllBtn.addEventListener('click', async () => {
  if (!builderId) return;
  notificationsMarkAllBtn.disabled = true;
  try {
    await markAllNotificationsRead();
    await renderNotifications();
    await refreshNotificationsBadge();
  } catch (err) {
    console.warn('Could not mark all notifications read:', err);
  } finally {
    notificationsMarkAllBtn.disabled = false;
  }
});

// Friend requests (docs/SPEC.md §2: "Friend/group systems: standard friend
// requests; social map shows friends' approximate location.") Same plain
// pill-button-plus-badge design as Notices just above, badge counting
// pending incoming requests rather than unread notices.
const friendsBtn = document.getElementById('friends-btn');
const friendsBadgeEl = document.getElementById('friends-badge');
const friendsModalEl = document.getElementById('friends-modal');
const friendsCloseBtn = document.getElementById('friends-close-btn');
const friendsAddBtn = document.getElementById('friends-add-btn');
const friendsStatusEl = document.getElementById('friends-status');
const friendsIncomingListEl = document.getElementById('friends-incoming-list');
const friendsIncomingEmptyEl = document.getElementById('friends-incoming-empty');
const friendsOutgoingListEl = document.getElementById('friends-outgoing-list');
const friendsOutgoingEmptyEl = document.getElementById('friends-outgoing-empty');
const friendsAcceptedListEl = document.getElementById('friends-accepted-list');
const friendsAcceptedEmptyEl = document.getElementById('friends-accepted-empty');

async function refreshFriendsBadge() {
  if (!builderId) return;
  try {
    const friendships = await fetchFriendships();
    const incoming = friendships.filter((f) => f.direction === 'incoming' && f.status === 'pending');
    friendsBadgeEl.textContent = String(incoming.length);
    friendsBadgeEl.hidden = incoming.length === 0;
  } catch (err) {
    console.warn('Could not refresh friends badge:', err);
  }
}

// "Social map ... approximate location" (see worker/index.js's own comment
// on handleFriendships for why this is simplified to a friend's claimed
// lándlet rather than a live position) — rendered here as plain text, not
// an actual map widget. A real map would need its own renderer/camera the
// way the claim flyover does (a full WebGL scene, not something to spin up
// just for a small modal list) — this ships the underlying "where do my
// friends live" data first.
function friendLocationText(friendship) {
  if (!friendship.otherLandlet) return "Hasn't claimed a lándlet yet";
  const { name, center } = friendship.otherLandlet;
  return `${name} (${center.x.toFixed(0)}, ${center.y.toFixed(0)})`;
}

async function renderFriends() {
  friendsIncomingListEl.innerHTML = '';
  friendsOutgoingListEl.innerHTML = '';
  friendsAcceptedListEl.innerHTML = '';
  if (!builderId) return;
  let friendships;
  try {
    friendships = await fetchFriendships();
  } catch (err) {
    friendsStatusEl.textContent = err.message || 'Could not load friends.';
    friendsStatusEl.classList.add('error');
    return;
  }
  const incoming = friendships.filter((f) => f.direction === 'incoming' && f.status === 'pending');
  const outgoing = friendships.filter((f) => f.direction === 'outgoing' && f.status === 'pending');
  const accepted = friendships.filter((f) => f.status === 'accepted');

  friendsIncomingEmptyEl.hidden = incoming.length > 0;
  for (const friendship of incoming) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    const body = document.createElement('div');
    body.className = 'friend-row-body';
    const label = document.createElement('div');
    label.className = 'friend-row-label';
    label.textContent = friendship.otherLabel;
    body.appendChild(label);
    row.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'friend-row-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', async () => {
      acceptBtn.disabled = true;
      try {
        await acceptFriendRequest(friendship.friendshipId);
        await renderFriends();
        await refreshFriendsBadge();
      } catch (err) {
        console.warn('Could not accept friend request:', err);
        acceptBtn.disabled = false;
      }
    });
    actions.appendChild(acceptBtn);
    const declineBtn = document.createElement('button');
    declineBtn.type = 'button';
    declineBtn.className = 'danger';
    declineBtn.textContent = 'Decline';
    declineBtn.addEventListener('click', async () => {
      declineBtn.disabled = true;
      try {
        await removeFriendship(friendship.friendshipId);
        await renderFriends();
        await refreshFriendsBadge();
      } catch (err) {
        console.warn('Could not decline friend request:', err);
        declineBtn.disabled = false;
      }
    });
    actions.appendChild(declineBtn);
    row.appendChild(actions);
    friendsIncomingListEl.appendChild(row);
  }

  friendsOutgoingEmptyEl.hidden = outgoing.length > 0;
  for (const friendship of outgoing) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    const body = document.createElement('div');
    body.className = 'friend-row-body';
    const label = document.createElement('div');
    label.className = 'friend-row-label';
    label.textContent = friendship.otherLabel;
    body.appendChild(label);
    row.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'friend-row-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'danger';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.disabled = true;
      try {
        await removeFriendship(friendship.friendshipId);
        await renderFriends();
      } catch (err) {
        console.warn('Could not cancel friend request:', err);
        cancelBtn.disabled = false;
      }
    });
    actions.appendChild(cancelBtn);
    row.appendChild(actions);
    friendsOutgoingListEl.appendChild(row);
  }

  friendsAcceptedEmptyEl.hidden = accepted.length > 0;
  for (const friendship of accepted) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    const body = document.createElement('div');
    body.className = 'friend-row-body';
    const label = document.createElement('div');
    label.className = 'friend-row-label';
    label.textContent = friendship.otherLabel;
    body.appendChild(label);
    const location = document.createElement('div');
    location.className = 'friend-row-location';
    location.textContent = friendLocationText(friendship);
    body.appendChild(location);
    row.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'friend-row-actions';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'danger';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      removeBtn.disabled = true;
      try {
        await removeFriendship(friendship.friendshipId);
        await renderFriends();
      } catch (err) {
        console.warn('Could not remove friend:', err);
        removeBtn.disabled = false;
      }
    });
    actions.appendChild(removeBtn);
    row.appendChild(actions);
    friendsAcceptedListEl.appendChild(row);
  }
}

// Account menu (docs/API.md's "Frontend-only account menu") — the
// Log In/Notices/Friends/Settings buttons above are unchanged in every
// other respect; this only adds the expand/collapse chrome around them.
// Each row's own click handler (accountAuthBtn/notificationsBtn/
// friendsBtn/settingsBtn, all defined elsewhere) already opens its own
// modal, so the only extra behavior needed here is closing the menu once
// a row is picked, and closing it on an outside tap the way every other
// transient popover in this app does.
const accountMenuToggle = document.getElementById('account-menu-toggle');
const accountMenuPanel = document.getElementById('account-menu-panel');
accountMenuToggle.addEventListener('click', () => {
  accountMenuPanel.classList.toggle('expanded');
  accountMenuToggle.classList.toggle('active', accountMenuPanel.classList.contains('expanded'));
});
for (const row of accountMenuPanel.querySelectorAll('button')) {
  row.addEventListener('click', () => {
    accountMenuPanel.classList.remove('expanded');
    accountMenuToggle.classList.remove('active');
  });
}
document.addEventListener('click', (event) => {
  if (!accountMenuPanel.classList.contains('expanded')) return;
  if (event.target === accountMenuToggle || accountMenuPanel.contains(event.target)) return;
  accountMenuPanel.classList.remove('expanded');
  accountMenuToggle.classList.remove('active');
});

// Real login (docs/API.md's "Authentication") — now the sole way a
// builder/seller identity is established (see ensureBuilderIdentity/
// ensureSellerIdentity above, migrations/0054_link_builders_sellers_to_users.sql).
let currentAuthUser = null;
let pendingResetToken = null;
// Resolved by exactly one of: a successful login/signup (notifyAuthResult
// is called with the new user from both submit handlers below), or
// dismissing the modal without either (authCloseBtn calls it with null).
// This is what lets ensureBuilderIdentity/ensureSellerIdentity block on
// "the user just logged in, or gave up" regardless of which of those two
// forms — or neither — they actually used.
let pendingAuthResolvers = [];
function notifyAuthResult(user) {
  const resolvers = pendingAuthResolvers;
  pendingAuthResolvers = [];
  for (const resolve of resolvers) resolve(user);
}
function waitForAuthResult() {
  return new Promise((resolve) => pendingAuthResolvers.push(resolve));
}
const accountAuthBtn = document.getElementById('account-auth-btn');
const authModalEl = document.getElementById('auth-modal');
const authModalTitle = document.getElementById('auth-modal-title');
const authCloseBtn = document.getElementById('auth-close-btn');
const authLoggedOutEl = document.getElementById('auth-logged-out');
const authLoggedInEl = document.getElementById('auth-logged-in');
const authTabBtns = [...document.querySelectorAll('.auth-tab-btn')];
const authForms = {
  login: document.getElementById('auth-login-form'),
  signup: document.getElementById('auth-signup-form'),
  forgot: document.getElementById('auth-forgot-form'),
  reset: document.getElementById('auth-reset-form'),
};
const authStatusEl = document.getElementById('auth-status');
const authAccountEmailEl = document.getElementById('auth-account-email');
const authAccountVerifiedEl = document.getElementById('auth-account-verified');
const authAccountPioneerEl = document.getElementById('auth-account-pioneer');
const authResendVerifyBtn = document.getElementById('auth-resend-verify-btn');
const authLogoutBtn = document.getElementById('auth-logout-btn');

function setAuthStatus(text, type) {
  authStatusEl.textContent = text || '';
  authStatusEl.classList.toggle('error', type === 'error');
  authStatusEl.classList.toggle('success', type === 'success');
}

const AUTH_VIEW_TITLES = {
  login: 'Log In',
  signup: 'Sign Up',
  forgot: 'Reset Password',
  reset: 'Reset Password',
};

// 'reset' is deliberately not one of the tab-switchable views (no
// .auth-tab-btn targets it) — it's only ever entered programmatically, via
// a password-reset email link (see the DOMContentLoaded handler below),
// never something a user taps into on their own.
function showAuthView(view) {
  for (const [name, form] of Object.entries(authForms)) form.hidden = name !== view;
  for (const btn of authTabBtns) btn.classList.toggle('active', btn.dataset.authView === view);
  authModalTitle.textContent = AUTH_VIEW_TITLES[view];
  setAuthStatus('');
  // Back to masked every time this view is (re)entered — form.reset()
  // (called after a successful signup) only resets values, not the type
  // attribute a Show tap changes, so without this the field could still
  // read as plain-text on a later visit despite being empty again.
  authSignupPasswordInput.type = 'password';
  authSignupPasswordToggleBtn.textContent = 'Show';
}

function refreshAccountAuthUI() {
  if (currentAuthUser) {
    accountAuthBtn.textContent = currentAuthUser.username;
    authLoggedOutEl.hidden = true;
    authLoggedInEl.hidden = false;
    authModalTitle.textContent = 'Account';
    authAccountEmailEl.textContent = currentAuthUser.email;
    authAccountVerifiedEl.textContent = currentAuthUser.emailVerified ? '✓ Email verified' : 'Email not verified yet';
    authAccountVerifiedEl.classList.toggle('verified', currentAuthUser.emailVerified);
    authResendVerifyBtn.hidden = currentAuthUser.emailVerified;
    // Founding/pioneer recognition (docs/SPEC.md §3) — this app has no
    // separate profile page, so the account panel is the closest fit (the
    // old dev-mode identity roster used to show this — see
    // migrations/0054_link_builders_sellers_to_users.sql's own comment for
    // why that roster no longer drives Build entry at all). Fetched fresh
    // on every open rather than cached, since rank/land cap can change
    // between one open and the next.
    authAccountPioneerEl.textContent = '';
    fetchMyBuilder().then((builder) => {
      if (builder.isPioneer) authAccountPioneerEl.textContent = `🏆 Pioneer #${builder.pioneerRank}`;
    }).catch(() => {});
  } else {
    accountAuthBtn.textContent = 'Log In / Sign Up';
    authLoggedOutEl.hidden = false;
    authLoggedInEl.hidden = true;
  }
}

function openAuthModal(view = 'login') {
  if (!currentAuthUser) showAuthView(view);
  setAuthStatus('');
  authModalEl.classList.add('visible');
}

function closeAuthModal() {
  authModalEl.classList.remove('visible');
}

async function refreshCurrentUser() {
  currentAuthUser = await fetchCurrentUser();
  refreshAccountAuthUI();
  return currentAuthUser;
}

accountAuthBtn.addEventListener('click', () => {
  // refreshAccountAuthUI's own pioneer-rank/land-cap fetch only otherwise
  // runs right after a login/signup/logout state change — reopening the
  // panel later without this would keep showing whatever was true at that
  // moment (e.g. "not yet a pioneer," even well after actually claiming a
  // landlet and earning the badge).
  if (currentAuthUser) refreshAccountAuthUI();
  openAuthModal('login');
});
authCloseBtn.addEventListener('click', () => {
  closeAuthModal();
  notifyAuthResult(null);
});
for (const btn of authTabBtns) {
  btn.addEventListener('click', () => showAuthView(btn.dataset.authView));
}
document.getElementById('auth-forgot-btn').addEventListener('click', () => showAuthView('forgot'));
document.getElementById('auth-forgot-back-btn').addEventListener('click', () => showAuthView('login'));

// Lets a builder double-check what they actually typed while choosing a
// password at signup, rather than trusting a masked field with no way to
// catch a typo before submitting. Only on signup — login's password field
// isn't where a typo would go unnoticed (a wrong one just fails to log in
// and can be retried), and reset's new-password field is short-lived
// enough not to need it either.
const authSignupPasswordInput = document.getElementById('auth-signup-password');
const authSignupPasswordToggleBtn = document.getElementById('auth-signup-password-toggle');
authSignupPasswordToggleBtn.addEventListener('click', () => {
  const showing = authSignupPasswordInput.type === 'text';
  authSignupPasswordInput.type = showing ? 'password' : 'text';
  authSignupPasswordToggleBtn.textContent = showing ? 'Show' : 'Hide';
});

// A brief press flash (see .pressed in index.html) on every auth form's
// submit button — these all wait on a network round-trip before anything
// else visibly changes, so without this a tap can read as not having
// registered at all rather than "working on it." Fired immediately on
// submit, not after the request resolves, since it's the tap itself being
// acknowledged, not the outcome.
function flashSubmitPressed(form) {
  const btn = form.querySelector('button[type="submit"]');
  if (!btn) return;
  btn.classList.add('pressed');
  setTimeout(() => btn.classList.remove('pressed'), 220);
}

authForms.login.addEventListener('submit', async (event) => {
  event.preventDefault();
  flashSubmitPressed(authForms.login);
  const email = document.getElementById('auth-login-email').value;
  const password = document.getElementById('auth-login-password').value;
  setAuthStatus('');
  try {
    currentAuthUser = await logIn({ email, password });
    refreshAccountAuthUI();
    closeAuthModal();
    authForms.login.reset();
    notifyAuthResult(currentAuthUser);
  } catch (err) {
    setAuthStatus(err.message || 'Could not log in.', 'error');
  }
});

authForms.signup.addEventListener('submit', async (event) => {
  event.preventDefault();
  flashSubmitPressed(authForms.signup);
  const email = document.getElementById('auth-signup-email').value;
  const password = document.getElementById('auth-signup-password').value;
  const username = document.getElementById('auth-signup-username').value.trim();
  setAuthStatus('');
  try {
    const result = await signUp({ email, password, username });
    currentAuthUser = result.user;
    refreshAccountAuthUI();
    authForms.signup.reset();
    // devVerifyUrl only ever appears when no real email provider is
    // configured (see sendEmail's own comment) — surfacing it here is what
    // keeps this whole flow testable/usable in that dev-mode case, exactly
    // the way the backend's own dev-mode fallback is meant to be used.
    if (result.devVerifyUrl) {
      setAuthStatus(`Account created! (dev mode, no email configured) Verify at: ${result.devVerifyUrl}`, 'success');
    } else {
      closeAuthModal();
    }
    // Notified regardless of whether the modal itself just closed —
    // requireLogin (ensureBuilderIdentity/ensureSellerIdentity's own gate)
    // closes it unconditionally once resolved, since the dev-mode status
    // message above would otherwise sit on top of the claim/build UI this
    // unblocks.
    notifyAuthResult(currentAuthUser);
  } catch (err) {
    setAuthStatus(err.message || 'Could not sign up.', 'error');
  }
});

authForms.forgot.addEventListener('submit', async (event) => {
  event.preventDefault();
  flashSubmitPressed(authForms.forgot);
  const email = document.getElementById('auth-forgot-email').value;
  setAuthStatus('');
  try {
    const result = await requestPasswordReset(email);
    authForms.forgot.reset();
    setAuthStatus(
      result.devResetUrl
        ? `If that email has an account, a reset link was sent. (dev mode: ${result.devResetUrl})`
        : 'If that email has an account, a reset link was sent.',
      'success',
    );
  } catch (err) {
    setAuthStatus(err.message || 'Could not request a password reset.', 'error');
  }
});

authForms.reset.addEventListener('submit', async (event) => {
  event.preventDefault();
  flashSubmitPressed(authForms.reset);
  const newPassword = document.getElementById('auth-reset-password').value;
  setAuthStatus('');
  try {
    await resetPassword(pendingResetToken, newPassword);
    pendingResetToken = null;
    authForms.reset.reset();
    // Order matters: showAuthView clears #auth-status itself (a plain view
    // switch shouldn't carry over a stale message from whatever view came
    // before it), so the real success message has to be set after it, not
    // before.
    showAuthView('login');
    setAuthStatus('Password reset! You can log in with your new password now.', 'success');
  } catch (err) {
    setAuthStatus(err.message || 'Could not reset the password.', 'error');
  }
});

authResendVerifyBtn.addEventListener('click', async () => {
  setAuthStatus('');
  try {
    const result = await resendVerificationEmail();
    setAuthStatus(
      result.devVerifyUrl
        ? `Verification email sent. (dev mode: ${result.devVerifyUrl})`
        : 'Verification email sent.',
      'success',
    );
  } catch (err) {
    setAuthStatus(err.message || 'Could not resend the verification email.', 'error');
  }
});

authLogoutBtn.addEventListener('click', async () => {
  try {
    await logOut();
  } catch {
    // Best-effort — the cookie is cleared client-side visibility regardless
    // once currentAuthUser is nulled out below, even if the network call
    // itself failed.
  }
  currentAuthUser = null;
  // Build mode requires a real, logged-in account (ensureBuilderIdentity's
  // own login wall) — staying on it post-logout would just immediately
  // reprompt the login modal over whatever was on screen, stranding the
  // builder mid-edit with no identity behind it. A reload into Shop
  // instead is the same clean-slate escape hatch #mode-nav's own Shop<->
  // Build switching already uses (see its own comment), and Shop needs no
  // account at all, so it's always a safe place to land after logging out.
  if (currentMode === 'build') {
    sessionStorage.setItem(START_MODE_KEY, 'shop');
    location.reload();
    return;
  }
  refreshAccountAuthUI();
  closeAuthModal();
});

// A verify-email or reset-password link (see issueEmailVerification/
// handleRequestPasswordReset in worker/index.js) lands back on this same
// page with a query param carrying the token — handled once, up front,
// then stripped from the URL so a page refresh doesn't replay it. Also
// where currentAuthUser first gets resolved on every page load — stored
// as authInitPromise (rather than left as a bare fire-and-forget IIFE) so
// bootstrap() below can await it before checking currentAuthUser itself.
// Without that, a fresh page load with an already-valid session cookie
// would race: bootstrap()'s own ensureBuilderIdentity check runs
// synchronously, reaching `if (currentAuthUser) ...` before this
// function's GET /api/auth/me round trip could possibly have resolved,
// wrongly popping the login modal open over a session that was actually
// fine (caught via a real reload-while-logged-in-and-in-Build-mode e2e
// scenario, not something a fresh-every-time page load would ever surface
// on its own).
const authInitPromise = (async () => {
  const params = new URLSearchParams(location.search);
  const verifyToken = params.get('verifyEmail');
  const resetToken = params.get('resetPassword');
  if (!verifyToken && !resetToken) {
    await refreshCurrentUser();
    return;
  }

  history.replaceState(null, '', location.pathname);
  await refreshCurrentUser();

  if (verifyToken) {
    try {
      await verifyEmail(verifyToken);
      await refreshCurrentUser();
      openAuthModal('login');
      setAuthStatus('Email verified!', 'success');
    } catch (err) {
      openAuthModal('login');
      setAuthStatus(err.message || 'That verification link is invalid or has expired.', 'error');
    }
  } else if (resetToken) {
    pendingResetToken = resetToken;
    // Forced to the logged-out form view even if this browser happens to
    // have an active session — resetting a password is about whichever
    // account the token itself identifies, not necessarily the one
    // currently logged in here, so it should never be hidden behind
    // refreshAccountAuthUI's "you're logged in" panel.
    authLoggedOutEl.hidden = false;
    authLoggedInEl.hidden = true;
    authModalEl.classList.add('visible');
    showAuthView('reset');
  }
})();

friendsBtn.addEventListener('click', () => {
  friendsModalEl.classList.add('visible');
  friendsStatusEl.textContent = '';
  friendsStatusEl.classList.remove('error');
  renderFriends();
});
friendsCloseBtn.addEventListener('click', () => {
  friendsModalEl.classList.remove('visible');
  refreshFriendsBadge();
});
friendsAddBtn.addEventListener('click', async () => {
  const label = prompt("Friend's name (must match their identity exactly):", '');
  if (!label || !label.trim()) return;
  friendsStatusEl.textContent = '';
  friendsStatusEl.classList.remove('error');
  friendsAddBtn.disabled = true;
  try {
    const builders = await fetchBuilders();
    const match = builders.find((b) => b.label.toLowerCase() === label.trim().toLowerCase());
    if (!match) {
      friendsStatusEl.textContent = `No builder named "${label.trim()}" found.`;
      friendsStatusEl.classList.add('error');
      return;
    }
    await sendFriendRequest(match.builderId);
    friendsStatusEl.textContent = `Friend request sent to ${match.label}.`;
    await renderFriends();
  } catch (err) {
    friendsStatusEl.textContent = err.message || 'Could not send friend request.';
    friendsStatusEl.classList.add('error');
  } finally {
    friendsAddBtn.disabled = false;
  }
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
const shopMoveJoystickEl = document.getElementById('shop-move-joystick');
const shopMoveKnobEl = shopMoveJoystickEl.querySelector('.shop-joystick-knob');
const shopLookJoystickEl = document.getElementById('shop-look-joystick');
const shopLookKnobEl = shopLookJoystickEl.querySelector('.shop-joystick-knob');
const shopFlyBtn = document.getElementById('shop-fly-btn');
const shopVerticalControlsEl = document.getElementById('shop-vertical-controls');
const shopUpBtn = document.getElementById('shop-up-btn');
const shopDownBtn = document.getElementById('shop-down-btn');
const shopSignHintEl = document.getElementById('shop-sign-hint');
const shopCalendarHintEl = document.getElementById('shop-calendar-hint');
const shopReviewHintEl = document.getElementById('shop-review-hint');
const shopProductInfoEl = document.getElementById('shop-product-info');
const shopBuyHintEl = document.getElementById('shop-buy-hint');

// A flat, neutral gray for "claimed" reads as concrete/asphalt — a jarring,
// cold clash against this world's warm cream-and-green palette (see
// :root's --pill-rgb/--panel-rgb/--brand-green in index.html) every other
// bit of chrome uses. A warm tan instead reads as cleared/settled ground
// (tilled earth, a building's footprint) while staying clearly distinct
// from greenbelt's green and generating's amber.
const SHOP_PLOT_COLORS = { greenbelt: 0x6ca42e, claimed: 0xc2a878, generating: 0xd99a3f };
// docs/SPEC.md §2's confirmed ground speeds: 1.8 m/s walking, 2.2 m/s
// running. There's no separate run input (a run key/button) — the move
// joystick's own deflection doubles as intensity, so pushing it all the way
// out runs and a gentle nudge walks, the same analog feel a real joystick
// gamepad gives a run.
const SHOP_WALK_SPEED_M_S = 1.8;
const SHOP_RUN_SPEED_M_S = 2.2;
const SHOP_LOOK_SPEED_RAD_S = 1.8;
const SHOP_MIN_HEIGHT_M = 1.5;
// Flight (docs/SPEC.md §2) — see updateShopFlight/bindShopFlyToggle. Two
// spec details are deliberately not built here, both because they're
// inherently about *other* players seeing you, which this single-player-
// only build has none of: "flying avatars are invisible to other users"
// (so takeoff/landing here are pure altitude ramps, no fade — there's no
// one else to fade for) and "occupied landing spots offset to nearest open
// space" (nothing to occupy a spot with yet). Revisit both once real
// multiplayer presence exists (spec §9's own phase-4, after this one).
const SHOP_FLIGHT_TAKEOFF_DURATION_S = 1; // spec's "~1s lift"
const SHOP_FLIGHT_LANDING_DURATION_S = 2; // spec's "~2s reverse"
const SHOP_FLIGHT_HOVER_START_ALTITUDE_M = 3; // altitude reached at the end of takeoff, before the player climbs further
const SHOP_FLIGHT_VERTICAL_SPEED_M_S = 8; // ascend/descend rate once actually flying (the up/down buttons)
const SHOP_FLIGHT_DOUBLE_PRESS_WINDOW_MS = 400;
// docs/SPEC.md §1: "New users spawn zoomed-out in flight mode above the
// world" — a one-time first-ever-visit spawn, distinct from every later
// Shop-mode entry's ordinary grounded start (see enterShopMode). Below the
// initial flight ceiling (SHOP_WALL_HEIGHT_M + SHOP_DOME_INITIAL_RISE_M -
// SHOP_DOME_CLEARANCE_MARGIN_M = 115 at launch) with real clearance to
// spare, comfortably above "building height" (SHOP_FLIGHT_SPEED_REF_
// ALTITUDE_M, 10) so the view actually reads as "above the world," not just
// a slightly-elevated hover.
const SHOP_NEW_VISITOR_START_ALTITUDE_M = 80;
// Shop mode itself needs no login (unlike Build/Sell), so "new" here can
// only be tracked per-device, not per-account — the same lightweight,
// no-real-accounts-yet convention shopperLabel() already uses nearby.
const SHOP_VISITED_BEFORE_KEY = 'higglehaven.shopVisitedBefore';
// Speed-vs-altitude curve: spec's own two data points — "~10x walking
// speed near building-height" and "up to ~100x at max altitude" — plus its
// governing rule, "each doubling of altitude ≈ 50% more max ground speed."
// That rule alone fixes the curve's shape as a power law (speed ∝
// altitude^p) with p = log2(1.5) ≈ 0.585 (a whole doubling of the input
// giving exactly a 1.5x — not 2x — output is the definition of that
// exponent). Anchoring it at "~10x at building height" (SHOP_FLIGHT_
// SPEED_REF_ALTITUDE_M/MULTIPLIER below) and solving for where it reaches
// 100x lands at ~500m — the spec's own max-altitude figure — which is a
// strong confirmation this is the curve the spec's numbers actually
// describe, not just a guess fitted after the fact.
const SHOP_FLIGHT_SPEED_EXPONENT = Math.log2(1.5);
const SHOP_FLIGHT_SPEED_REF_ALTITUDE_M = 10; // "building height"
const SHOP_FLIGHT_SPEED_REF_MULTIPLIER = 10;
const SHOP_FLIGHT_MIN_SPEED_MULTIPLIER = 1; // just after takeoff, before climbing
const SHOP_FLIGHT_MAX_SPEED_MULTIPLIER = 100; // spec's "up to ~100x at max altitude"
// docs/SPEC.md's 500m flight ceiling assumes a much taller sky than this
// world's current wall/dome backdrop was ever built for (SHOP_WALL_HEIGHT_M
// + a dome that only grows reactively to clear tall builds — see
// growShopDomeIfNeeded — nowhere close to 500m by default). Capping flight
// to the same dynamic dome ceiling the camera itself already respects
// (clampShopCameraHeight) is a deliberate scope boundary for this pass,
// not an attempt at the literal number — genuinely extending the dome to a
// real 500m sky is its own separate visual-design task.
// Tighter than the old free-fly camera's own 0.47*PI (~85deg) — that
// figure let a bodiless camera look almost straight up/down freely, but
// this third-person rig swings the camera up and over the avatar's own
// head the more it looks down (see positionShopCamera), so an equally
// steep pitch here would swing the camera into a near-fully-overhead,
// disorienting god's-eye view. 0.35*PI (~63deg) still allows looking well
// down at your own feet or up at a tall build without reaching that
// extreme.
const SHOP_MAX_PITCH = Math.PI * 0.35;
// The avatar's own body proportions (docs/SPEC.md §2's default avatar —
// see createShopAvatar), all in meters, hip-up from the ground the avatar
// group's own origin sits on:
const SHOP_AVATAR_LEG_LENGTH_M = 0.86;
const SHOP_AVATAR_LEG_RADIUS_M = 0.075;
const SHOP_AVATAR_HIP_WIDTH_M = 0.12;
const SHOP_AVATAR_TORSO_LENGTH_M = 0.5;
const SHOP_AVATAR_TORSO_RADIUS_M = 0.17;
const SHOP_AVATAR_ARM_LENGTH_M = 0.6;
const SHOP_AVATAR_ARM_RADIUS_M = 0.055;
const SHOP_AVATAR_SHOULDER_WIDTH_M = 0.23;
const SHOP_AVATAR_HEAD_RADIUS_M = 0.14;
// docs/SPEC.md §2's collision numbers ("a 2-foot-diameter hard barrier"),
// reused here for shopper-vs-placed-item collision (the item-collision half
// of "Shopper collision still prevents walking through items" — Build
// mode's own item-vs-item collision, above, never covered this since Shop
// mode's multi-landlet shopLandlets map isn't part of productMeshes).
// Approximated as a small square rather than a true circle so the existing
// footprintCorners/footprintsOverlap SAT helpers (built for box-vs-box) can
// be reused as-is instead of writing separate circle-vs-polygon math.
const SHOP_AVATAR_COLLISION_HALF_M = 0.3;
const SHOP_AVATAR_HEIGHT_M = SHOP_AVATAR_LEG_LENGTH_M + SHOP_AVATAR_TORSO_LENGTH_M + SHOP_AVATAR_HEAD_RADIUS_M * 2;
// How fast the avatar's body turns to face its own movement direction
// (see updateShopMovement) — high enough to read as responsive, not
// instant, similar to every other "ease toward a target per second"
// treatment in this file (e.g. SHOP_AVATAR_SWING_EASE_PER_S).
const SHOP_AVATAR_TURN_EASE_PER_S = 12;
// Where the third-person camera orbits around — roughly head height, not
// the very top of the head, so looking straight ahead frames the avatar
// low in frame rather than staring at the back of its skull.
const SHOP_CAMERA_ANCHOR_HEIGHT_M =
  SHOP_AVATAR_LEG_LENGTH_M + SHOP_AVATAR_TORSO_LENGTH_M + SHOP_AVATAR_HEAD_RADIUS_M * 0.6;
// A fixed-radius orbit around that anchor (`positionShopCamera` below) — the
// classic over-the-shoulder third-person rig: subtracting the look
// direction from the anchor means looking down swings the camera up and
// back, looking up swings it down and in, all without a separate
// "collision" pass (clampShopCameraHeight/the wall-radius clamp still catch
// the rare pose that would otherwise dip the camera underground or past the
// world wall — see updateShopMovement).
const SHOP_CAMERA_FOLLOW_DISTANCE_M = 4.2;
// A full walk-cycle swing (hip/shoulder pivot, radians) at a full run;
// scales down toward 0 as the joystick's own deflection (and thus speed)
// drops toward a stand-still — see updateShopAvatarPose.
const SHOP_AVATAR_SWING_AMPLITUDE_RAD = 0.55;
// Radians/second the walk-cycle phase advances at a full run; scales down
// with speed the same way the swing amplitude does, so a slow walk cycles
// its legs slower as well as with a smaller swing, not just a smaller one.
const SHOP_AVATAR_CYCLE_SPEED_RAD_S = 7;
// How fast the avatar's swing amplitude eases toward its current target
// (moving vs. stopped) each frame — see updateShopAvatarPose.
const SHOP_AVATAR_SWING_EASE_PER_S = 8;
// docs/SPEC.md §2's "context-aware idle state machine ... after inactivity,
// with randomization" — see updateShopAvatarIdle. This pass only covers
// "stand" (a subtle randomized weight-shift sway + occasional head turn);
// "sit"/"lean" need a real interaction-target system (e.g. a chair prop
// with an occupancy slot) that doesn't exist yet.
const SHOP_IDLE_DELAY_S = 3; // no movement input for this long before idle sway starts easing in
const SHOP_IDLE_BLEND_PER_S = 0.6; // how fast idle sway eases in/out (in on stillness, out the instant movement resumes)
const SHOP_IDLE_SWAY_AMPLITUDE_RAD = 0.035; // whole-body weight-shift, small enough to read as idle fidget, not a stagger
const SHOP_IDLE_SWAY_PERIOD_MIN_S = 3.5;
const SHOP_IDLE_SWAY_PERIOD_MAX_S = 6;
const SHOP_IDLE_ARM_SWAY_AMPLITUDE_RAD = 0.05;
const SHOP_IDLE_HEAD_TURN_MAX_RAD = 0.4; // a natural glance range, not a full look-behind
const SHOP_IDLE_HEAD_TURN_INTERVAL_MIN_S = 2.5;
const SHOP_IDLE_HEAD_TURN_INTERVAL_MAX_S = 5;
const SHOP_IDLE_HEAD_TURN_EASE_PER_S = 1.5;
const SHOP_JOYSTICK_MAX_PX = 46;
const SHOP_JOYSTICK_DEADZONE_PX = 6;
const SHOP_LOAD_RADIUS_M = 60;
const SHOP_UNLOAD_RADIUS_M = 90;
const SHOP_PROXIMITY_INTERVAL_MS = 400;
// Community signs (docs/SPEC.md §6, docs/API.md's "Community signs") —
// shopper-authored posts fade in as the camera approaches a sign and back
// out past it, rather than a hard show/hide cutoff, the same
// proximity-as-opacity idea the spec's own in-world social feed calls for
// generally ("size/opacity as a function of distance"). SIGN_INTERACT_RADIUS_M
// is deliberately much tighter than the fade radius — close enough to
// plausibly be able to read the sign at all before "Leave a Note" appears.
const SIGN_FADE_NEAR_M = 4; // fully opaque at/within this distance
const SIGN_FADE_FAR_M = 20; // fully transparent at/beyond this distance
const SIGN_INTERACT_RADIUS_M = 8;
const SIGN_MAX_VISIBLE_POSTS = 5;
const SHOPPER_LABEL_KEY = 'higglehaven.shopperLabel';
// Community calendar (docs/SPEC.md §6, docs/API.md's "Community
// calendar") reuses the SIGN_FADE_NEAR_M/SIGN_FADE_FAR_M/
// SIGN_INTERACT_RADIUS_M/SIGN_MAX_VISIBLE_POSTS constants above directly
// rather than declaring near-duplicate CALENDAR_* ones — they're generic
// "how far can you read floating in-world text" thresholds, not anything
// specific to signs, so there's nothing calendar-specific to tune
// separately (unlike the backend's own deliberately-separate table/flag —
// see migrations/0042's comment on why that split is real).
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
let shopWallMesh = null;
let shopDomeRiseM = SHOP_DOME_INITIAL_RISE_M;
let shopSkyMaterial = null; // shared by both wall and dome — see createShopSkyMaterial
let shopSkyClockStart = null;

// Clouds only ever show in the upper portion of the wall (its own hazy-
// horizon band) and above — never near the wall's ground-colored base, so
// the boundary still mostly reads as plain sky/horizon rather than a
// visibly "effects-y" surface. Both are absolute world Z heights (this
// world is Z-up, ground at z=0), independent of shopDomeRiseM growing
// later — see growShopDomeIfNeeded — since growing the dome only extends
// clear sky *above* SHOP_CLOUD_FADE_HIGH_Z, which was already full opacity.
const SHOP_CLOUD_FADE_LOW_Z = SHOP_WALL_HEIGHT_M * 0.55;
const SHOP_CLOUD_FADE_HIGH_Z = SHOP_WALL_HEIGHT_M * 1.25;

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

// A soft, slowly swirling cloud layer painted directly over the wall/dome's
// own vertex-color gradient (vColor below — the exact colors
// paintVerticalGradient already wrote) rather than replacing it, so the
// calm horizon/sky look this was tuned to keep is the base case and clouds
// are only ever a translucent overlay on top of it. One shared material
// instance for both meshes (see enterShopMode) keeps their animation
// perfectly in sync and means only one uTime needs updating per frame.
//
// The "swirl": each height band drifts around the vertical axis at a
// slightly different azimuthal speed (see the sin(heightFrac...) term in
// `drift` below), so bands shear past each other over time instead of the
// whole sky sliding sideways together — soft, continuous, and slow enough
// to read as soothing rather than busy. World-space position (not each
// geometry's own local parametrization) drives both the swirl angle and
// the height-based fade, so the effect is seamless across the wall/dome
// seam even though they're two separate meshes with different local
// coordinate systems.
const SHOP_SKY_VERTEX_SHADER = `
  attribute vec3 color;
  varying vec3 vColor;
  varying vec3 vWorldPosition;
  void main() {
    vColor = color;
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SHOP_SKY_FRAGMENT_SHADER = `
  varying vec3 vColor;
  varying vec3 vWorldPosition;
  uniform float uTime;
  uniform float uFadeLowZ;
  uniform float uFadeHighZ;
  uniform float uWorldRadius;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  // Band-limited fbm: each octave is faded out once its own noise-space
  // period gets small relative to how much p itself changes between
  // neighboring screen pixels (fwidth(p)). Without this, looking nearly
  // straight up into the dome compresses a huge sweep of world-space
  // azimuth into a handful of screen pixels near the apex, so the same
  // pixel-to-pixel jump in p covers many full cycles of the higher
  // octaves — undersampling them, which aliases into sharp radiating
  // streaks rather than soft cloud texture. Fading each octave out before
  // that happens leaves only the octaves that are still actually resolved
  // at that pixel, which reads as a smooth (if slightly hazier) blend
  // instead — exactly the soft wisp this was meant to look like everywhere,
  // not just where the view happens to be gentle enough not to alias.
  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    float totalWeight = 0.0;
    for (int i = 0; i < 4; i++) {
      float footprint = fwidth(p.x) + fwidth(p.y);
      float fade = 1.0 - smoothstep(0.005, 0.05, footprint);
      value += amplitude * fade * noise(p);
      totalWeight += amplitude * fade;
      p *= 2.05;
      amplitude *= 0.55;
    }
    // Renormalize so fading out high octaves near the apex converges the
    // result toward the (still fully resolved) low-frequency base rather
    // than just going dim/dark — a change in texture, not in brightness.
    return totalWeight > 0.0001 ? value / totalWeight : value;
  }

  void main() {
    float heightFrac = clamp((vWorldPosition.z - uFadeLowZ) / (uFadeHighZ - uFadeLowZ), 0.0, 1.0);
    // Rotating the actual XY position (not an extracted angle) around the
    // vertical axis avoids a polar singularity — sampling noise by angle
    // alone makes every point near the dome's apex, however close
    // together, resolve to wildly different angles, which reads as sharp
    // rays converging to a point rather than soft cloud cover. Rotating
    // real coordinates has no such singularity: nearby points stay nearby.
    // Each height band rotates at a slightly different rate (the
    // sin(heightFrac...) term) so bands shear past each other over time —
    // that shear is what actually reads as "swirl."
    float swirlAngle = uTime * (0.02 + 0.015 * sin(heightFrac * 6.2831));
    float s = sin(swirlAngle);
    float c = cos(swirlAngle);
    // Normalized by the world's own current radius (not a fixed meters
    // scale) so the pattern always spans the same handful of cells around
    // the dome regardless of how big the world currently is — a fixed
    // meters-based frequency would compress into a single, texture-less
    // noise cell for a small early-game world, or tile too busily once the
    // world has grown large.
    vec2 normalizedXY = vWorldPosition.xy / max(uWorldRadius, 1.0);
    vec2 swirled = mat2(c, -s, s, c) * normalizedXY;
    vec2 samplePos = swirled * 2.5 + vec2(uTime * 0.05, heightFrac * 3.0 - uTime * 0.015);
    float clouds = fbm(samplePos);
    // A narrow smoothstep range here reads as a near-binary edge — cloud or
    // not, with barely any blend in between — which combined with how pale
    // both colors already are shows up as a hard visible line at the
    // boundary rather than a soft wisp. Widening it spreads the transition
    // across much more of the noise field's own range.
    float cloudMask = smoothstep(0.25, 0.95, clouds);
    float visibility = heightFrac * cloudMask * 0.5; // kept subtle — an overlay, not a repaint
    vec3 cloudColor = vec3(0.99, 0.99, 1.0);
    gl_FragColor = vec4(mix(vColor, cloudColor, visibility), 1.0);
  }
`;

function createShopSkyMaterial(worldRadiusM) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFadeLowZ: { value: SHOP_CLOUD_FADE_LOW_Z },
      uFadeHighZ: { value: SHOP_CLOUD_FADE_HIGH_Z },
      uWorldRadius: { value: worldRadiusM },
    },
    vertexShader: SHOP_SKY_VERTEX_SHADER,
    fragmentShader: SHOP_SKY_FRAGMENT_SHADER,
    side: THREE.BackSide,
    // fwidth() in fbm() (used to band-limit the noise near the dome apex,
    // see fbm's own comment) needs this extension under WebGL1/GLSL ES
    // 1.00; harmless no-op where the renderer already exposes it as core
    // (WebGL2).
    extensions: { derivatives: true },
  });
}

// Called every animate() frame while Shop mode is active (see animate's own
// dispatch) — advances the shared sky material's clock. A local clock
// start rather than reusing `now` directly so the shader's time uniform
// stays small/precise regardless of how long the page has been open before
// Shop mode was entered.
function updateShopSky(now) {
  if (!shopSkyMaterial) return;
  if (shopSkyClockStart === null) shopSkyClockStart = now;
  shopSkyMaterial.uniforms.uTime.value = (now - shopSkyClockStart) / 1000;
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
// The avatar's own facing (docs/SPEC.md §2) — deliberately separate from
// shopYaw (the camera's look direction, right-stick-driven): the left
// stick turns the avatar to face wherever it's actually walking, while the
// right stick free-looks independently, the standard third-person control
// scheme. Only updated while moving (see updateShopMovement) — standing
// still and looking around doesn't spin the avatar in place.
let shopAvatarFacing = 0;
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
// Every currently-loaded community-sign instance: { mesh, group, instanceId,
// posts, sprites }. Populated/torn down alongside its landlet's own
// objects (see loadShopLandletInstances/unloadShopLandletInstances) rather
// than kept in its own load radius — a sign is exactly as "loaded" as the
// rest of its landlet.
const shopSigns = [];
let nearestActiveSign = null; // whichever sign #shop-sign-hint currently targets, or null
// Same shape/lifecycle as shopSigns above, for community-calendar instances.
const shopCalendars = [];
let nearestActiveCalendar = null;
// Same shape/lifecycle as shopSigns above, for every placed instance's
// reviews (no opt-in flag — see registerShopReview) — a
// {mesh, group, templateId, reviews, sprites} entry per loaded one, with
// `reviews` populated once rather than re-fetched.
const shopReviews = [];
let nearestActiveReview = null;
// #shop-product-info's own content/visibility is driven by this instead of
// nearestActiveReview (see the tap handler further below) — showing it the
// instant a shopper wanders near anything read as noisy/intrusive, closer
// to a tooltip stuck to the cursor than an intentional "what is this."
// Requiring a tap makes seeing it a deliberate choice. The buy/review hints
// stay proximity-driven below, unlike product-info — those are prompts to
// *do* something about whatever's nearby, not information display, so
// showing them on approach still reads as "you can act here," not clutter.
let shopTappedProduct = null;

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

// Flight (docs/SPEC.md §2): double-tap the fly button, or double-press
// space on desktop, toggles takeoff/landing (toggleShopFlight). Ascend/
// descend while actually flying is a separate, ordinary press-and-hold
// pair — shopVerticalInput/bindShopVerticalButton, +1 while Up is held,
// -1 while Down, consumed every frame in updateShopFlight exactly like
// shopMoveX/Y already are for the move joystick.
//
// Each button's own held-state is tracked independently (shopUpHeld/
// shopDownHeld) rather than shopVerticalInput itself recording "who's
// holding" — holding both and releasing just one used to silently stick
// the other off, since the second press's pointerdown would overwrite the
// first's contribution to the one shared variable, and the first button's
// own pointerup only ever cleared it if it still matched that button's own
// direction. Deriving shopVerticalInput as a sum of both held-flags means
// either button's press/release only ever touches its own flag.
let shopUpHeld = false;
let shopDownHeld = false;
let shopVerticalInput = 0;
function updateShopVerticalInput() {
  shopVerticalInput = (shopUpHeld ? 1 : 0) + (shopDownHeld ? -1 : 0);
}
function bindShopVerticalButton(el, direction) {
  let pointerId = null;
  el.addEventListener('pointerdown', (event) => {
    if (!shopActive) return;
    event.stopPropagation();
    pointerId = event.pointerId;
    el.setPointerCapture(pointerId);
    el.classList.add('active');
    if (direction === 1) shopUpHeld = true;
    else shopDownHeld = true;
    updateShopVerticalInput();
  });
  const end = (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    el.classList.remove('active');
    if (direction === 1) shopUpHeld = false;
    else shopDownHeld = false;
    updateShopVerticalInput();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', end);
}
bindShopVerticalButton(shopUpBtn, 1);
bindShopVerticalButton(shopDownBtn, -1);

// A double-tap/double-press, not a single one, so a single accidental tap
// (or an ordinary spacebar press while, say, a builder is just looking
// around with keyboard focus on the page) never launches the player into
// the air unintentionally — matches docs/SPEC.md §2's own wording exactly
// ("double-tap jump (mobile) / double-press spacebar (desktop)").
function bindShopFlyToggle(el) {
  el.addEventListener('pointerdown', (event) => {
    if (!shopActive) return;
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - shopLastFlyBtnTapAt <= SHOP_FLIGHT_DOUBLE_PRESS_WINDOW_MS) {
      shopLastFlyBtnTapAt = -Infinity; // consumed — a third tap starts a fresh pair, not an immediate re-trigger
      toggleShopFlight();
    } else {
      shopLastFlyBtnTapAt = now;
    }
  });
}
bindShopFlyToggle(shopFlyBtn);

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || !shopActive) return;
  const target = event.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  event.preventDefault(); // stop the page's own default scroll-on-space
  // OS key-auto-repeat fires further keydowns (no keyup in between) well
  // inside SHOP_FLIGHT_DOUBLE_PRESS_WINDOW_MS while the key is held, which
  // would otherwise read as a rapid double-press and keep re-toggling
  // flight for as long as spacebar stays down — holding is not the
  // deliberate double-press this gesture requires.
  if (event.repeat) return;
  const now = performance.now();
  if (now - shopLastSpacePressAt <= SHOP_FLIGHT_DOUBLE_PRESS_WINDOW_MS) {
    shopLastSpacePressAt = -Infinity;
    toggleShopFlight();
  } else {
    shopLastSpacePressAt = now;
  }
});

// Zoom: narrows/widens the camera's own field of view rather than moving
// it — the camera's own position is derived every frame from the avatar it
// follows (positionShopCamera), not something a dolly could move
// independently, so a lens-zoom is the natural equivalent. Wheel for
// desktop, pinch for touch. Both live on the canvas itself
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
const shopViewDirection = new THREE.Vector3();
const shopMoveDir = new THREE.Vector3();
const shopCameraAnchor = new THREE.Vector3();

// The default avatar (docs/SPEC.md §2: "a single, standard, deliberately
// non-gendered avatar assigned instantly at registration"). No character
// asset/rig exists yet, so this is a plain, neutral placeholder built from
// primitives — a real modeled-and-rigged replacement is future work, not
// this pass's job. Limbs are each their own pivot Group (hip/shoulder
// height, empty at the pivot's own local origin) with the limb mesh hung
// below it (`mesh.position.z = -length / 2`), so a walk cycle can just
// rotate the pivot about local X — swinging the limb through the
// forward/back-and-up/down sagittal plane exactly like a real hip/shoulder
// joint — rather than needing a skeleton for one swinging joint per limb.
function createShopAvatar() {
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x5b8dc9 });
  const headMaterial = new THREE.MeshStandardMaterial({ color: 0xe8c9a0 });

  function limb(radius, length, material) {
    const pivot = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 8), material);
    mesh.rotation.x = Math.PI / 2; // stand the cylinder's local-Y axis up along world Z
    mesh.position.z = -length / 2; // hang it below the pivot rather than centered on it
    pivot.add(mesh);
    return pivot;
  }

  const group = new THREE.Group();

  const legPivotL = limb(SHOP_AVATAR_LEG_RADIUS_M, SHOP_AVATAR_LEG_LENGTH_M, bodyMaterial);
  legPivotL.position.set(-SHOP_AVATAR_HIP_WIDTH_M, 0, SHOP_AVATAR_LEG_LENGTH_M);
  group.add(legPivotL);
  const legPivotR = limb(SHOP_AVATAR_LEG_RADIUS_M, SHOP_AVATAR_LEG_LENGTH_M, bodyMaterial);
  legPivotR.position.set(SHOP_AVATAR_HIP_WIDTH_M, 0, SHOP_AVATAR_LEG_LENGTH_M);
  group.add(legPivotR);

  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(SHOP_AVATAR_TORSO_RADIUS_M, SHOP_AVATAR_TORSO_LENGTH_M, 4, 8),
    bodyMaterial,
  );
  torso.rotation.x = Math.PI / 2;
  torso.position.z = SHOP_AVATAR_LEG_LENGTH_M + SHOP_AVATAR_TORSO_LENGTH_M / 2 + SHOP_AVATAR_TORSO_RADIUS_M;
  group.add(torso);

  const shoulderZ = SHOP_AVATAR_LEG_LENGTH_M + SHOP_AVATAR_TORSO_LENGTH_M + SHOP_AVATAR_TORSO_RADIUS_M * 0.6;
  const armPivotL = limb(SHOP_AVATAR_ARM_RADIUS_M, SHOP_AVATAR_ARM_LENGTH_M, bodyMaterial);
  armPivotL.position.set(-SHOP_AVATAR_SHOULDER_WIDTH_M, 0, shoulderZ);
  group.add(armPivotL);
  const armPivotR = limb(SHOP_AVATAR_ARM_RADIUS_M, SHOP_AVATAR_ARM_LENGTH_M, bodyMaterial);
  armPivotR.position.set(SHOP_AVATAR_SHOULDER_WIDTH_M, 0, shoulderZ);
  group.add(armPivotR);

  // Its own pivot (rather than a bare mesh straight on `group`, like the
  // torso) purely so the idle "look around" behavior (updateShopAvatarIdle)
  // can turn just the head about local Z without touching the rest of the
  // body.
  const headPivot = new THREE.Group();
  headPivot.position.z =
    SHOP_AVATAR_LEG_LENGTH_M + SHOP_AVATAR_TORSO_LENGTH_M + SHOP_AVATAR_TORSO_RADIUS_M * 2 + SHOP_AVATAR_HEAD_RADIUS_M;
  const head = new THREE.Mesh(new THREE.SphereGeometry(SHOP_AVATAR_HEAD_RADIUS_M, 16, 12), headMaterial);
  headPivot.add(head);
  group.add(headPivot);

  return { group, legPivotL, legPivotR, armPivotL, armPivotR, headPivot };
}

let shopAvatar = null; // { group, legPivotL, legPivotR, armPivotL, armPivotR, headPivot } — see createShopAvatar
const shopAvatarPosition = new THREE.Vector3(); // feet position, ground truth for both the mesh and the camera
let shopAvatarSwing = 0; // current eased swing amplitude (0 = standing still, see SHOP_AVATAR_SWING_AMPLITUDE_RAD)
let shopAvatarWalkPhase = 0;

// Idle sway state (docs/SPEC.md §2) — see updateShopAvatarIdle.
let shopIdleElapsedS = 0; // seconds since the last real movement input
let shopIdleBlend = 0; // 0..1 eased "how much idle sway is showing"
let shopIdleSwayPhase = 0;
let shopIdleSwayPeriodS = THREE.MathUtils.randFloat(SHOP_IDLE_SWAY_PERIOD_MIN_S, SHOP_IDLE_SWAY_PERIOD_MAX_S);
let shopIdleSwayYawOffset = 0; // read by updateShopMovement to offset the avatar's own facing
let shopIdleHeadCurrentRad = 0;
let shopIdleHeadTargetRad = 0;
let shopIdleHeadTimerS = 0;
let shopIdleHeadIntervalS = THREE.MathUtils.randFloat(SHOP_IDLE_HEAD_TURN_INTERVAL_MIN_S, SHOP_IDLE_HEAD_TURN_INTERVAL_MAX_S);

// Flight state (docs/SPEC.md §2) — see updateShopFlight/toggleShopFlight.
// 'grounded' | 'takingOff' | 'flying' | 'landing'. Toggling mid-transition
// is ignored (see toggleShopFlight) rather than queued or reversed, so
// there's no need to track anything beyond "which transition, how far in."
let shopFlightState = 'grounded';
let shopFlightTransitionElapsedS = 0;
let shopFlightAltitudeM = 0; // authoritative — shopAvatarPosition.z mirrors this every frame
let shopFlightLandingStartAltitudeM = 0; // altitude captured the instant landing begins, so its ramp has a real start point
let shopLastSpacePressAt = -Infinity;
let shopLastFlyBtnTapAt = -Infinity;

// Swing amplitude eases toward its target (moving vs. standing still)
// rather than snapping, so stopping doesn't visibly freeze the legs
// mid-stride — and phase only advances while actually moving, so a full
// stop always eases back toward a neutral standing pose rather than
// leaving a limb stuck part-swung. moveMagnitude (0..1, the move
// joystick's own deflection) scales both the eased-toward amplitude and
// how fast the cycle advances, the same walk-slower/run-faster feel
// SHOP_WALK_SPEED_M_S..SHOP_RUN_SPEED_M_S already gives actual ground speed.
function updateShopAvatarPose(moveMagnitude, dt) {
  const targetSwing = SHOP_AVATAR_SWING_AMPLITUDE_RAD * moveMagnitude;
  shopAvatarSwing += (targetSwing - shopAvatarSwing) * Math.min(1, SHOP_AVATAR_SWING_EASE_PER_S * dt);
  shopAvatarWalkPhase += SHOP_AVATAR_CYCLE_SPEED_RAD_S * moveMagnitude * dt;

  const swing = Math.sin(shopAvatarWalkPhase) * shopAvatarSwing;
  shopAvatar.legPivotL.rotation.x = swing;
  shopAvatar.legPivotR.rotation.x = -swing;
  // Arms swing opposite their same-side leg (left arm forward with right
  // leg forward) — a real walk's natural counter-swing — at a gentler
  // amplitude than the legs.
  shopAvatar.armPivotL.rotation.x = -swing * 0.7;
  shopAvatar.armPivotR.rotation.x = swing * 0.7;
}

// docs/SPEC.md §2: "context-aware idle state machine ... after inactivity,
// with randomization." This pass only covers "stand" — a subtle whole-body
// weight-shift sway plus an occasional head turn, both re-randomized on
// their own cycle so idle never visibly repeats the same motion twice in a
// row. "Sit"/"lean" need a real interaction-target system (e.g. a chair
// prop with an occupancy slot) that doesn't exist yet — future work.
//
// Called every frame right after updateShopAvatarPose, whose walk-cycle
// arm rotations it adds on top of (already ~0 by the time idle sway is
// actually visible, since walking and idling are mutually exclusive in
// practice — see moveMagnitude below). Ends the instant real movement
// resumes (a hard cut, not an ease-out) — a lingering idle sway would read
// as the avatar fighting the player's own input.
function updateShopAvatarIdle(moveMagnitude, dt) {
  if (moveMagnitude > 0) {
    shopIdleElapsedS = 0;
    shopIdleBlend = 0;
  } else {
    shopIdleElapsedS += dt;
    const idleTarget = shopIdleElapsedS >= SHOP_IDLE_DELAY_S ? 1 : 0;
    shopIdleBlend += (idleTarget - shopIdleBlend) * Math.min(1, SHOP_IDLE_BLEND_PER_S * dt);
  }

  shopIdleSwayPhase += (dt / shopIdleSwayPeriodS) * Math.PI * 2;
  if (shopIdleSwayPhase >= Math.PI * 2) {
    shopIdleSwayPhase -= Math.PI * 2;
    shopIdleSwayPeriodS = THREE.MathUtils.randFloat(SHOP_IDLE_SWAY_PERIOD_MIN_S, SHOP_IDLE_SWAY_PERIOD_MAX_S);
  }
  shopIdleHeadTimerS += dt;
  if (shopIdleHeadTimerS >= shopIdleHeadIntervalS) {
    shopIdleHeadTimerS = 0;
    shopIdleHeadIntervalS = THREE.MathUtils.randFloat(SHOP_IDLE_HEAD_TURN_INTERVAL_MIN_S, SHOP_IDLE_HEAD_TURN_INTERVAL_MAX_S);
    shopIdleHeadTargetRad = THREE.MathUtils.randFloatSpread(SHOP_IDLE_HEAD_TURN_MAX_RAD * 2);
  }
  shopIdleHeadCurrentRad +=
    (shopIdleHeadTargetRad * shopIdleBlend - shopIdleHeadCurrentRad) * Math.min(1, SHOP_IDLE_HEAD_TURN_EASE_PER_S * dt);

  shopIdleSwayYawOffset = Math.sin(shopIdleSwayPhase) * SHOP_IDLE_SWAY_AMPLITUDE_RAD * shopIdleBlend;
  const armIdleSway = Math.sin(shopIdleSwayPhase * 0.5) * SHOP_IDLE_ARM_SWAY_AMPLITUDE_RAD * shopIdleBlend;
  shopAvatar.armPivotL.rotation.x += armIdleSway;
  shopAvatar.armPivotR.rotation.x -= armIdleSway;
  shopAvatar.headPivot.rotation.z = shopIdleHeadCurrentRad;
}

// Shared by walking's own floor clamp and the camera-follow height — keeps
// the camera between the ground and comfortably below the dome's current
// apex (see SHOP_DOME_CLEARANCE_MARGIN_M), the same "a real boundary, not
// just a backdrop" treatment the radial wall clamp already gets just below
// this. The dome's own apex can grow over the course of a session (see
// growShopDomeIfNeeded), so this is recomputed fresh each call rather than
// cached.
function clampShopCameraHeight() {
  const maxHeight = SHOP_WALL_HEIGHT_M + shopDomeRiseM - SHOP_DOME_CLEARANCE_MARGIN_M;
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, SHOP_MIN_HEIGHT_M, maxHeight);
}

// The world wall (see enterShopMode) is a real boundary, not just a
// backdrop — pulls (x, y) radially back inside it in place. Shared by the
// avatar's own ground position (so a builder can never walk past the wall)
// and the follow camera (so a follow distance long enough to swing the
// camera past the wall on its own can't peek through it either).
function clampShopRadius(position) {
  if (shopWorldRadiusM === null) return;
  const clearance = Math.max(SHOP_WALL_CLEARANCE_MIN_M, Math.min(SHOP_WALL_CLEARANCE_M, shopWorldRadiusM * 0.15));
  const maxRadius = shopWorldRadiusM - clearance;
  const distance = Math.hypot(position.x, position.y);
  if (distance > maxRadius) {
    const scale = maxRadius / distance;
    position.x *= scale;
    position.y *= scale;
  }
}

// docs/SPEC.md §2's altitude/speed curve — the actual math (a power law
// clamped to the spec's own [1x, 100x] range) now lives in flight.js as a
// pure, directly-unit-tested function (src/flight.test.js); this call site
// just supplies this feature's own spec-derived constants from above.
function shopFlightSpeedMultiplier(altitudeM) {
  return flightSpeedMultiplier(altitudeM, {
    refAltitudeM: SHOP_FLIGHT_SPEED_REF_ALTITUDE_M,
    refMultiplier: SHOP_FLIGHT_SPEED_REF_MULTIPLIER,
    exponent: SHOP_FLIGHT_SPEED_EXPONENT,
    minMultiplier: SHOP_FLIGHT_MIN_SPEED_MULTIPLIER,
    maxMultiplier: SHOP_FLIGHT_MAX_SPEED_MULTIPLIER,
  });
}

// Toggling mid-transition (takingOff/landing) is ignored rather than
// queued or reversed — let the current one finish, then the next press
// starts cleanly from a real grounded/flying state. Landing captures its
// own starting altitude (shopFlightLandingStartAltitudeM) so its descent
// ramps from wherever the player actually was, not always the same height.
function toggleShopFlight() {
  if (shopFlightState === 'grounded') {
    shopFlightState = 'takingOff';
    shopFlightTransitionElapsedS = 0;
    // shop-flying on <body> gates #shop-vertical-controls' own visibility
    // (index.html) — shown for the whole takingOff/flying span, not just
    // once actually airborne, so the ascend/descend buttons are already in
    // place the moment takeoff finishes rather than popping in afterward.
    document.body.classList.add('shop-flying');
    shopFlyBtn.classList.add('active');
  } else if (shopFlightState === 'flying') {
    shopFlightLandingStartAltitudeM = shopFlightAltitudeM;
    shopFlightState = 'landing';
    shopFlightTransitionElapsedS = 0;
    // Landing is an automatic descent (shopVerticalInput is only read
    // while actually 'flying' — see updateShopFlight), so the ascend/
    // descend controls hide the instant it starts, not once it finishes.
    document.body.classList.remove('shop-flying');
    shopFlyBtn.classList.remove('active');
  }
}

// Drives shopFlightAltitudeM through takeoff/landing (smoothstep-eased
// ramps, spec's own ~1s lift / ~2s reverse) and, once actually flying,
// lets the up/down buttons climb or descend within the world's current
// dome ceiling (see the "500m flight ceiling" comment above
// SHOP_FLIGHT_SPEED_EXPONENT for why that's not literally 500m yet).
// Called once per frame from updateShopMovement,
// before movement/pose so everything downstream (flight speed, the
// avatar's own z, the camera that follows it) sees this frame's altitude.
function updateShopFlight(dt) {
  if (shopFlightState === 'takingOff') {
    shopFlightTransitionElapsedS += dt;
    shopFlightAltitudeM = takeoffAltitudeM(
      shopFlightTransitionElapsedS, SHOP_FLIGHT_TAKEOFF_DURATION_S, SHOP_FLIGHT_HOVER_START_ALTITUDE_M,
    );
    if (shopFlightTransitionElapsedS >= SHOP_FLIGHT_TAKEOFF_DURATION_S) shopFlightState = 'flying';
  } else if (shopFlightState === 'landing') {
    shopFlightTransitionElapsedS += dt;
    shopFlightAltitudeM = landingAltitudeM(
      shopFlightTransitionElapsedS, SHOP_FLIGHT_LANDING_DURATION_S, shopFlightLandingStartAltitudeM,
    );
    if (shopFlightTransitionElapsedS >= SHOP_FLIGHT_LANDING_DURATION_S) {
      shopFlightState = 'grounded';
      shopFlightAltitudeM = 0;
    }
  } else if (shopFlightState === 'flying') {
    if (shopVerticalInput !== 0) {
      shopFlightAltitudeM += shopVerticalInput * SHOP_FLIGHT_VERTICAL_SPEED_M_S * dt;
    }
    const maxAltitudeM = SHOP_WALL_HEIGHT_M + shopDomeRiseM - SHOP_DOME_CLEARANCE_MARGIN_M;
    shopFlightAltitudeM = THREE.MathUtils.clamp(shopFlightAltitudeM, SHOP_FLIGHT_HOVER_START_ALTITUDE_M * 0.5, maxAltitudeM);
  }
}

// The classic over-the-shoulder third-person rig: orbits the camera around
// a fixed-radius sphere (SHOP_CAMERA_FOLLOW_DISTANCE_M) centered on the
// avatar's own head-height anchor, using the exact look direction
// (shopViewDirection, full 3D — unlike shopForward/shopRight below, this
// one is deliberately *not* flattened) already established by
// applyShopCameraOrientation. Subtracting that direction from the anchor
// means looking down swings the camera up and back over the avatar's
// shoulder, looking up swings it down and in toward the avatar's own back —
// exactly what a shoulder-cam should do, with no separate orbit math needed
// beyond the walking camera's own existing yaw/pitch state.
function positionShopCamera() {
  camera.getWorldDirection(shopViewDirection);
  shopCameraAnchor.copy(shopAvatarPosition);
  shopCameraAnchor.z += SHOP_CAMERA_ANCHOR_HEIGHT_M;
  camera.position.copy(shopCameraAnchor).addScaledVector(shopViewDirection, -SHOP_CAMERA_FOLLOW_DISTANCE_M);
  clampShopCameraHeight();
  clampShopRadius(camera.position);
}

// Shopper-vs-placed-item collision (docs/SPEC.md §3's "Shopper collision
// still prevents walking through items") — reuses the same rotated-
// rectangle SAT test Build mode's own item-vs-item collision already uses
// (footprintCorners/footprintsOverlap, near the top of this file),
// approximating the avatar's own footprint as a small square (see
// SHOP_AVATAR_COLLISION_HALF_M) rather than writing separate circle-vs-
// polygon math. Only checks *loaded* landlets' objects (entry.objects) —
// exactly the ones close enough to matter (see updateShopProximity). Each
// object's position is landlet-local (see loadShopLandletInstances), so
// it's translated into world space by adding the landlet group's own
// position before testing.
function shopAvatarFootprintCorners(x, y) {
  const half = SHOP_AVATAR_COLLISION_HALF_M;
  return [
    [x + half, y + half],
    [x + half, y - half],
    [x - half, y - half],
    [x - half, y + half],
  ];
}

function shopPositionBlocked(x, y, z) {
  const avatarCorners = shopAvatarFootprintCorners(x, y);
  for (const entry of shopLandlets.values()) {
    if (!entry.loaded) continue;
    for (const mesh of entry.objects) {
      const worldX = entry.group.position.x + mesh.position.x;
      const worldY = entry.group.position.y + mesh.position.y;
      const { height } = meshDimensions(mesh);
      const itemZMin = mesh.position.z - height / 2;
      const itemZMax = mesh.position.z + height / 2;
      if (z + SHOP_AVATAR_HEIGHT_M < itemZMin || z > itemZMax) continue; // no vertical overlap — e.g. flying above it
      if (footprintsOverlap(avatarCorners, footprintCorners(mesh, worldX, worldY))) return true;
    }
  }
  return false;
}

// Tries the full requested move first; if that's blocked, slides along
// whichever single axis is still open (the same axis-separated collision
// response resolveByAxis/sweepAxis use for Build mode) so grazing a wall
// at an angle slows the shopper down rather than stopping them dead.
function moveShopAvatarWithCollision(dx, dy) {
  const { x, y, z } = shopAvatarPosition;
  if (!shopPositionBlocked(x + dx, y + dy, z)) {
    shopAvatarPosition.x += dx;
    shopAvatarPosition.y += dy;
    return;
  }
  if (!shopPositionBlocked(x + dx, y, z)) {
    shopAvatarPosition.x += dx;
  } else if (!shopPositionBlocked(x, y + dy, z)) {
    shopAvatarPosition.y += dy;
  }
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

  updateShopFlight(dt);
  const airborne = shopFlightState !== 'grounded';

  let moveMagnitude = 0;
  if (shopMoveX !== 0 || shopMoveY !== 0) {
    // Movement stays in the horizontal plane (forward/right with their Z
    // dropped) so looking up or down while walking/flying doesn't also
    // steer altitude — that's updateShopFlight's own separate concern.
    camera.getWorldDirection(shopForward);
    shopForward.z = 0;
    if (shopForward.lengthSq() > 1e-6) shopForward.normalize();
    shopRight.setFromMatrixColumn(camera.matrixWorld, 0);
    shopRight.z = 0;
    if (shopRight.lengthSq() > 1e-6) shopRight.normalize();

    moveMagnitude = Math.min(1, Math.hypot(shopMoveX, shopMoveY));
    // Grounded: the walk/run blend. Airborne (including mid-takeoff/
    // landing, so horizontal speed ramps up smoothly alongside altitude
    // rather than jumping to full flight speed the instant takeoff
    // finishes): docs/SPEC.md §2's altitude/speed curve — see
    // shopFlightSpeedMultiplier and SHOP_FLIGHT_SPEED_EXPONENT's own comment.
    const speed = airborne
      ? SHOP_WALK_SPEED_M_S * shopFlightSpeedMultiplier(shopFlightAltitudeM) * moveMagnitude
      : THREE.MathUtils.lerp(SHOP_WALK_SPEED_M_S, SHOP_RUN_SPEED_M_S, moveMagnitude);
    shopMoveDir
      .set(0, 0, 0)
      .addScaledVector(shopForward, -shopMoveY)
      .addScaledVector(shopRight, shopMoveX);
    if (shopMoveDir.lengthSq() > 1e-6) {
      shopMoveDir.normalize();
      moveShopAvatarWithCollision(shopMoveDir.x * speed * dt, shopMoveDir.y * speed * dt);
      // Turn to face the actual movement direction (left stick), independent
      // of the right stick's camera-look yaw (shopYaw) — the signed angle
      // between shopForward (the world direction shopYaw currently faces)
      // and shopMoveDir gives the facing delta without needing to know the
      // avatar mesh's own local-forward convention. Eased rather than
      // snapped (see SHOP_AVATAR_TURN_EASE_PER_S), and via the shortest
      // angular distance so a near-180-degree reversal doesn't spin the
      // long way around.
      const facingDelta = Math.atan2(
        shopForward.x * shopMoveDir.y - shopForward.y * shopMoveDir.x,
        shopForward.x * shopMoveDir.x + shopForward.y * shopMoveDir.y,
      );
      const targetFacing = shopYaw + facingDelta;
      const turnDelta = Math.atan2(
        Math.sin(targetFacing - shopAvatarFacing),
        Math.cos(targetFacing - shopAvatarFacing),
      );
      shopAvatarFacing += turnDelta * Math.min(1, SHOP_AVATAR_TURN_EASE_PER_S * dt);
    }
    clampShopRadius(shopAvatarPosition);
  }
  shopAvatarPosition.z = shopFlightAltitudeM;

  // The walk-cycle and idle sway are both ground-only poses — flying holds
  // a plain neutral pose instead (a real flight pose, arms/legs extended,
  // is future work alongside the rest of a real character rig). Passing
  // moveMagnitude 0 while airborne eases the legs/arms back to neutral the
  // same way stopping on the ground already does, rather than needing a
  // separate code path.
  updateShopAvatarPose(airborne ? 0 : moveMagnitude, dt);
  updateShopAvatarIdle(airborne ? 0 : moveMagnitude, dt);
  // The avatar faces its own movement direction (shopAvatarFacing, turned
  // by the left stick above), not the camera's look direction (shopYaw,
  // the right stick) — a standard third-person rig where free-look and
  // facing are independent. Plus a small idle weight-shift offset when
  // standing still.
  shopAvatar.group.rotation.z = shopAvatarFacing + shopIdleSwayYawOffset;
  shopAvatar.group.position.copy(shopAvatarPosition);
  positionShopCamera();

  if (now - shopLastProximityCheck >= SHOP_PROXIMITY_INTERVAL_MS) {
    shopLastProximityCheck = now;
    updateShopProximity();
  }
  updateSignFade();
  updateCalendarFade();
  updateReviewFade();
  if (now - lastScheduledEventCheck >= SCHEDULED_EVENT_CHECK_INTERVAL_MS) {
    lastScheduledEventCheck = now;
    checkScheduledCalendarEvents();
  }
  updateConfettiBursts(dt);
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
    // A landlet that's actually been published (see the Build settings
    // tab's "Publish"/Version History) shows shoppers a frozen snapshot,
    // not the builder's own live in-progress edits — the whole point of a
    // draft/publish split. A landlet with no activeVersionId has never
    // been published, so this falls back to the live draft (today's
    // behavior for every landlet that existed before this feature).
    instances = entry.record.activeVersionId
      ? (await fetchLandletVersion(entry.record.landletId, entry.record.activeVersionId)).instances
      : await fetchInstances(entry.record.landletId);
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
    if (object.userData.isCommunitySign) registerShopSign(object, entry);
    if (object.userData.isCommunityCalendar) registerShopCalendar(object, entry);
    // Unlike signs/calendar above, reviews have no builder opt-in flag at
    // all — every placed instance's underlying catalog template is
    // reviewable by definition (see docs/API.md's "Product reviews"), so
    // this registers unconditionally.
    registerShopReview(object, entry);
  }
}

// A sign starts with no posts loaded — fetched once, here, right as it
// enters the world (rather than re-fetched on every proximity tick), then
// kept in sync locally by promptLeaveNote's own optimistic append. If the
// fetch loses the race with the landlet being unloaded again (camera
// wandered off before it resolved), the `shopSigns.includes` check drops
// the result on the floor rather than resurrecting sprites for a sign
// that's no longer in the scene.
function registerShopSign(mesh, entry) {
  const sign = { mesh, group: entry.group, instanceId: mesh.userData.instanceId, posts: [], sprites: [] };
  shopSigns.push(sign);
  fetchSignPosts(sign.instanceId).then((posts) => {
    if (!shopSigns.includes(sign)) return;
    sign.posts = posts;
    rebuildSignSprites(sign);
  }).catch(() => {});
}

function disposeSignSprites(sign) {
  for (const sprite of sign.sprites) {
    sign.group.remove(sprite);
    sprite.material.map?.dispose();
    sprite.material.dispose();
  }
  sign.sprites = [];
}

// Renders a canvas-texture Sprite per post (THREE Sprites always face the
// camera on their own, so this needs no manual billboarding) stacked
// vertically above the sign's own footprint. Capped at
// SIGN_MAX_VISIBLE_POSTS most-recent posts — an unbounded stack would
// eventually tower well past where the fade radius could ever make it
// readable anyway. Opacity starts at 0 and is driven entirely by
// updateSignFade() every frame, not set here.
function rebuildSignSprites(sign) {
  disposeSignSprites(sign);
  const baseHeight = meshDimensions(sign.mesh).height;
  const recent = sign.posts.slice(-SIGN_MAX_VISIBLE_POSTS);
  recent.forEach((post, i) => {
    const sprite = makeSignPostSprite(`${post.authorLabel}: ${post.text}`);
    sprite.position.set(sign.mesh.position.x, sign.mesh.position.y, sign.mesh.position.z + baseHeight + 0.4 + i * 0.5);
    sprite.material.opacity = 0;
    sign.group.add(sprite);
    sign.sprites.push(sprite);
  });
}

// A single line of white-on-dark text baked into a canvas texture — the
// simplest possible in-world text rendering, and enough for a short social
// post. Long posts (up to 280 chars server-side) are truncated for display;
// this is a floating nameplate-style sign, not a page to scroll.
function makeSignPostSprite(text) {
  const display = text.length > 70 ? `${text.slice(0, 69)}…` : text;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = 48;
  ctx.font = `${fontSize}px sans-serif`;
  const paddingX = 20;
  canvas.width = Math.ceil(ctx.measureText(display).width) + paddingX * 2;
  canvas.height = Math.round(fontSize * 1.7);
  // Sizing the canvas above resets its 2D context — font has to be set again
  // before the actual draw calls below.
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = 'rgba(20, 24, 18, 0.85)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f5f5f0';
  ctx.textBaseline = 'middle';
  ctx.fillText(display, paddingX, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  const WORLD_UNITS_PER_PX = 0.012; // tuned so a typical post reads clearly from SIGN_INTERACT_RADIUS_M away
  sprite.scale.set(canvas.width * WORLD_UNITS_PER_PX, canvas.height * WORLD_UNITS_PER_PX, 1);
  return sprite;
}

// Community calendar — same lifecycle/rendering as the community-sign
// functions just above (registerShopSign/disposeSignSprites/
// rebuildSignSprites), reusing makeSignPostSprite directly since it's
// generic single-line text-sprite rendering with nothing sign-specific in
// its implementation despite the name.
function registerShopCalendar(mesh, entry) {
  const calendar = { mesh, group: entry.group, instanceId: mesh.userData.instanceId, events: [], sprites: [] };
  shopCalendars.push(calendar);
  fetchCalendarEvents(calendar.instanceId).then((events) => {
    if (!shopCalendars.includes(calendar)) return;
    calendar.events = events;
    rebuildCalendarSprites(calendar);
  }).catch(() => {});
}

function disposeCalendarSprites(calendar) {
  for (const sprite of calendar.sprites) {
    calendar.group.remove(sprite);
    sprite.material.map?.dispose();
    sprite.material.dispose();
  }
  calendar.sprites = [];
}

function rebuildCalendarSprites(calendar) {
  disposeCalendarSprites(calendar);
  const baseHeight = meshDimensions(calendar.mesh).height;
  const recent = calendar.events.slice(-SIGN_MAX_VISIBLE_POSTS);
  recent.forEach((event, i) => {
    const sprite = makeSignPostSprite(`${event.authorLabel}: ${event.text}`);
    sprite.position.set(calendar.mesh.position.x, calendar.mesh.position.y, calendar.mesh.position.z + baseHeight + 0.4 + i * 0.5);
    sprite.material.opacity = 0;
    calendar.group.add(sprite);
    calendar.sprites.push(sprite);
  });
}

// Called every Shop-mode frame (not throttled like updateShopProximity —
// opacity needs to read as a smooth fade, not a 400ms-stepped one). Two
// independent jobs: fade every loaded sign's post sprites by the camera's
// distance to that sign, and track which single nearest in-range sign (if
// any) #shop-sign-hint currently targets.
function updateSignFade() {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const sign of shopSigns) {
    const world = sign.mesh.getWorldPosition(scratchSignWorldPos);
    const distance = world.distanceTo(camera.position);
    const opacity = 1 - THREE.MathUtils.clamp(
      (distance - SIGN_FADE_NEAR_M) / (SIGN_FADE_FAR_M - SIGN_FADE_NEAR_M), 0, 1,
    );
    for (const sprite of sign.sprites) sprite.material.opacity = opacity;
    if (distance <= SIGN_INTERACT_RADIUS_M && distance < nearestDistance) {
      nearest = sign;
      nearestDistance = distance;
    }
  }
  if (nearest !== nearestActiveSign) {
    nearestActiveSign = nearest;
    shopSignHintEl.classList.toggle('visible', !!nearest);
  }
}
const scratchSignWorldPos = new THREE.Vector3();

// Community calendar's own per-frame fade — identical logic to
// updateSignFade above, over shopCalendars instead of shopSigns.
function updateCalendarFade() {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const calendar of shopCalendars) {
    const world = calendar.mesh.getWorldPosition(scratchSignWorldPos);
    const distance = world.distanceTo(camera.position);
    const opacity = 1 - THREE.MathUtils.clamp(
      (distance - SIGN_FADE_NEAR_M) / (SIGN_FADE_FAR_M - SIGN_FADE_NEAR_M), 0, 1,
    );
    for (const sprite of calendar.sprites) sprite.material.opacity = opacity;
    if (distance <= SIGN_INTERACT_RADIUS_M && distance < nearestDistance) {
      nearest = calendar;
      nearestDistance = distance;
    }
  }
  if (nearest !== nearestActiveCalendar) {
    nearestActiveCalendar = nearest;
    shopCalendarHintEl.classList.toggle('visible', !!nearest);
  }
}

// Every placed instance starts with no reviews loaded — fetched once, here,
// right as it enters the world, keyed by the instance's underlying
// templateId (the product), not its own instanceId, since the same review
// list is shared by every placement of that product. Each placement fetches
// independently rather than sharing a per-template cache — a shopper
// posting a review near one placement won't instantly update another
// loaded instance of the same product elsewhere (an edge case rare enough,
// and purely cosmetic enough, that a shared cache isn't worth the added
// bookkeeping here).
function registerShopReview(mesh, entry) {
  const review = { mesh, group: entry.group, templateId: mesh.userData.template.templateId, reviews: [], sprites: [] };
  shopReviews.push(review);
  fetchProductReviews(review.templateId).then(({ reviews }) => {
    if (!shopReviews.includes(review)) return;
    review.reviews = reviews;
    rebuildReviewSprites(review);
  }).catch(() => {});
}

function disposeReviewSprites(review) {
  for (const sprite of review.sprites) {
    review.group.remove(sprite);
    sprite.material.map?.dispose();
    sprite.material.dispose();
  }
  review.sprites = [];
}

function rebuildReviewSprites(review) {
  disposeReviewSprites(review);
  const baseHeight = meshDimensions(review.mesh).height;
  const recent = review.reviews.slice(-SIGN_MAX_VISIBLE_POSTS);
  recent.forEach((r, i) => {
    const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
    const label = r.text ? `${r.authorLabel} ${stars}: ${r.text}` : `${r.authorLabel} ${stars}`;
    const sprite = makeSignPostSprite(label);
    sprite.position.set(review.mesh.position.x, review.mesh.position.y, review.mesh.position.z + baseHeight + 0.4 + i * 0.5);
    sprite.material.opacity = 0;
    review.group.add(sprite);
    review.sprites.push(sprite);
  });
}

// Product reviews' own per-frame fade — identical logic to updateSignFade/
// updateCalendarFade above, over shopReviews instead of shopSigns.
function updateReviewFade() {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const review of shopReviews) {
    const world = review.mesh.getWorldPosition(scratchSignWorldPos);
    const distance = world.distanceTo(camera.position);
    const opacity = 1 - THREE.MathUtils.clamp(
      (distance - SIGN_FADE_NEAR_M) / (SIGN_FADE_FAR_M - SIGN_FADE_NEAR_M), 0, 1,
    );
    for (const sprite of review.sprites) sprite.material.opacity = opacity;
    if (distance <= SIGN_INTERACT_RADIUS_M && distance < nearestDistance) {
      nearest = review;
      nearestDistance = distance;
    }
  }
  if (nearest !== nearestActiveReview) {
    nearestActiveReview = nearest;
    shopReviewHintEl.classList.toggle('visible', !!nearest);
    // Only a priced product has anything to "buy" — an unpriced one (the
    // common case for most placeholder catalog items) shows no buy hint at
    // all rather than one that would just 400 on click.
    shopBuyHintEl.classList.toggle('visible', !!nearest && nearest.mesh.userData.template.priceCents != null);
  }
}

// Shared by the tap handler below and formerly by proximity — the actual
// "name — price (disclaimer)" line #shop-product-info shows once tapped.
function productInfoText(template) {
  const { name, priceCents, metadata } = template;
  let text = priceCents == null ? name : `${name} — ${formatPriceCents(priceCents)}`;
  // The "clear higglehaven-controlled disclaimer" digital goods require
  // (docs/SPEC.md §4) — shown to the shopper right where they'd otherwise
  // assume every placed item is a physical one.
  const disclaimerKey = metadata?.digitalGoodDisclaimer;
  if (disclaimerKey) text += ` (${DIGITAL_GOOD_DISCLAIMER_TEXT[disclaimerKey]})`;
  // docs/SPEC.md §5's shipping disclosure ("ships to United States only")
  // — same tap-to-inspect treatment as the digital-goods disclaimer above,
  // shown right where a shopper would otherwise assume every item ships
  // internationally like the rest of the catalog.
  if (metadata?.domesticOnly) text += ' (ships to United States only)';
  return text;
}

// Walks up from a raycast hit (a model's own nested child mesh — see
// loadModelInstance) to whichever shopReviews entry's root mesh is its
// ancestor, the same findRootProduct pattern Build mode's own click
// handler uses against productMeshes.
function findTappedShopProduct(object) {
  let current = object;
  while (current) {
    const review = shopReviews.find((r) => r.mesh === current);
    if (review) return review;
    current = current.parent;
  }
  return null;
}

// Tap-to-inspect: Shop mode has no other use for a plain single-finger tap
// on open canvas (movement/look are joystick-driven, pinch-zoom needs two
// fingers — see the pointerdown/pointermove pair just above), so this is
// free to use for "what is this." Tapping a product shows its info;
// tapping anything else (ground, sky, empty space) dismisses whatever was
// showing, the same "tap away to close" a shopper would expect.
renderer.domElement.addEventListener('click', (event) => {
  if (!shopActive) return;
  if (pointerDownPos) {
    const dx = event.clientX - pointerDownPos.x;
    const dy = event.clientY - pointerDownPos.y;
    if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) return;
  }
  raycaster.setFromCamera(ndcFromEvent(event), camera);
  const hits = raycaster.intersectObjects(shopReviews.map((r) => r.mesh), true);
  const review = hits.length > 0 ? findTappedShopProduct(hits[0].object) : null;
  shopTappedProduct = review;
  shopProductInfoEl.classList.toggle('visible', !!review);
  if (review) shopProductInfoEl.textContent = productInfoText(review.mesh.userData.template);
});

// The creative-tool trigger itself (docs/SPEC.md §6's own "scheduled
// confetti-cannon" example, docs/API.md's "Community calendar"). Checked
// periodically (SCHEDULED_EVENT_CHECK_INTERVAL_MS) across every currently-
// loaded calendar's already-fetched events, rather than re-fetching the
// events list itself — a stale local isCommunityCalendar event cache
// missing a brand-new event from another session is an acceptable gap for
// a purely-cosmetic effect, and re-fetching every check would mean a
// network round trip per calendar every 10 seconds regardless of whether
// anything's actually due.
const SCHEDULED_EVENT_CHECK_INTERVAL_MS = 10000;
let lastScheduledEventCheck = 0;
function checkScheduledCalendarEvents() {
  const nowIso = new Date().toISOString();
  for (const calendar of shopCalendars) {
    for (const event of calendar.events) {
      if (!event.scheduledAt || event.triggeredAt || event.scheduledAt > nowIso) continue;
      triggerCalendarEvent(calendar.instanceId, event.eventId).then(({ event: updated, triggered }) => {
        // Cache the server's own triggeredAt locally regardless of who
        // actually won the race, so a lost race doesn't keep retrying
        // this same event every 10 seconds for the rest of the visit.
        event.triggeredAt = updated.triggeredAt;
        if (triggered) spawnConfettiBurst(calendar.mesh.position, calendar.group);
      }).catch(() => {});
    }
  }
}

// A lightweight, dependency-free particle burst — small flat tumbling
// squares with an outward+upward launch velocity and simple downward
// gravity, faded out and disposed once their short lifespan ends. Not
// literally "a confetti cannon" (the spec's own phrase is one illustrative
// example of "creative-tool support," not a specific effect to replicate
// pixel-for-pixel) — this is the same idea in the simplest form this
// app's existing rendering toolkit (plain THREE.Mesh, no particle-system
// library) can produce cheaply.
const CONFETTI_COLORS = [0xff6b6b, 0xffd93d, 0x6bcb77, 0x4d96ff, 0xff922b, 0xda77f2];
const CONFETTI_PARTICLE_COUNT = 24;
const CONFETTI_GRAVITY_M_S2 = 4;
const CONFETTI_LIFESPAN_S = 2.5;
const confettiBursts = [];

function spawnConfettiBurst(localPosition, group) {
  const particles = [];
  for (let i = 0; i < CONFETTI_PARTICLE_COUNT; i++) {
    const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    const geometry = new THREE.PlaneGeometry(0.12, 0.12);
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(localPosition);
    mesh.position.z += 0.3; // launches from just above the calendar's own footprint, not its exact center
    group.add(mesh);
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.5 + Math.random() * 2;
    particles.push({
      mesh,
      velocity: new THREE.Vector3(Math.cos(angle) * speed, Math.sin(angle) * speed, 3 + Math.random() * 2),
      spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8),
    });
  }
  confettiBursts.push({ particles, group, elapsed: 0 });
}

function disposeConfettiBurst(burst) {
  for (const particle of burst.particles) {
    burst.group.remove(particle.mesh);
    particle.mesh.geometry.dispose();
    particle.mesh.material.dispose();
  }
}

function updateConfettiBursts(dt) {
  for (const burst of [...confettiBursts]) {
    burst.elapsed += dt;
    const fade = 1 - THREE.MathUtils.clamp(burst.elapsed / CONFETTI_LIFESPAN_S, 0, 1);
    for (const particle of burst.particles) {
      particle.velocity.z -= CONFETTI_GRAVITY_M_S2 * dt;
      particle.mesh.position.addScaledVector(particle.velocity, dt);
      particle.mesh.rotation.x += particle.spin.x * dt;
      particle.mesh.rotation.y += particle.spin.y * dt;
      particle.mesh.rotation.z += particle.spin.z * dt;
      particle.mesh.material.opacity = fade;
    }
    if (burst.elapsed >= CONFETTI_LIFESPAN_S) {
      disposeConfettiBurst(burst);
      confettiBursts.splice(confettiBursts.indexOf(burst), 1);
    }
  }
}

// Remembered across visits (but not required — a fresh prompt() with no
// stored value just asks each time) so a shopper leaving several notes in
// one session, or returning later, isn't re-asked their name every time —
// the same lightweight "no real accounts" convention as everything else in
// this dev-mode identity story.
function shopperLabel() {
  const existing = localStorage.getItem(SHOPPER_LABEL_KEY);
  const label = prompt('Your name (shown on the sign):', existing || '');
  if (!label || !label.trim()) return null;
  localStorage.setItem(SHOPPER_LABEL_KEY, label.trim());
  return label.trim();
}

shopSignHintEl.addEventListener('click', async () => {
  const sign = nearestActiveSign;
  if (!sign) return;
  const authorLabel = shopperLabel();
  if (!authorLabel) return;
  const text = prompt('Your note (up to 280 characters):', '');
  if (!text || !text.trim()) return;
  shopSignHintEl.disabled = true;
  try {
    const post = await createSignPost(sign.instanceId, { authorLabel, text: text.trim() });
    sign.posts.push(post);
    rebuildSignSprites(sign);
  } catch (err) {
    alert(err.message || 'Could not post to this sign.');
  } finally {
    shopSignHintEl.disabled = false;
  }
});

shopCalendarHintEl.addEventListener('click', async () => {
  const calendar = nearestActiveCalendar;
  if (!calendar) return;
  const authorLabel = shopperLabel();
  if (!authorLabel) return;
  const text = prompt('Event details (up to 280 characters):', '');
  if (!text || !text.trim()) return;
  // Optional third step — most events are just a plain announcement (the
  // two prompts above already cover that), a real scheduled moment (the
  // spec's own "creative-tool support like a scheduled confetti-cannon
  // trigger") is an explicit extra ask. Left blank, this posts exactly
  // like it always has.
  const scheduleInput = prompt(
    'Schedule a special moment? Enter a date/time (e.g. 2026-08-26T20:00), or leave blank for just a note:', '',
  );
  let scheduledAt;
  if (scheduleInput && scheduleInput.trim()) {
    const parsed = new Date(scheduleInput.trim());
    if (Number.isNaN(parsed.getTime())) {
      alert('Could not understand that date/time — try a format like 2026-08-26T20:00. Posting without a scheduled moment.');
    } else {
      scheduledAt = parsed.toISOString();
    }
  }
  shopCalendarHintEl.disabled = true;
  try {
    const event = await createCalendarEvent(calendar.instanceId, { authorLabel, text: text.trim(), scheduledAt });
    calendar.events.push(event);
    rebuildCalendarSprites(calendar);
  } catch (err) {
    alert(err.message || 'Could not post to this calendar.');
  } finally {
    shopCalendarHintEl.disabled = false;
  }
});

shopReviewHintEl.addEventListener('click', async () => {
  const review = nearestActiveReview;
  if (!review) return;
  const authorLabel = shopperLabel();
  if (!authorLabel) return;
  const ratingInput = prompt('Rate this product 1-5 stars:', '5');
  if (!ratingInput || !ratingInput.trim()) return;
  const rating = Number(ratingInput.trim());
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    alert('Please enter a whole number from 1 to 5.');
    return;
  }
  // A star rating alone is already a complete, useful review — this text
  // prompt is an optional extra, same as the calendar hint's own scheduling
  // step above.
  const text = prompt('Add a comment (up to 280 characters), or leave blank:', '');
  shopReviewHintEl.disabled = true;
  try {
    const posted = await createProductReview(review.templateId, { authorLabel, rating, text: text?.trim() || undefined });
    review.reviews.push(posted);
    rebuildReviewSprites(review);
  } catch (err) {
    alert(err.message || 'Could not review this product.');
  } finally {
    shopReviewHintEl.disabled = false;
  }
});

shopBuyHintEl.addEventListener('click', async () => {
  const review = nearestActiveReview;
  if (!review) return;
  const { name, priceCents } = review.mesh.userData.template;
  if (priceCents == null) return;
  const confirmed = confirm(
    `Simulate buying "${name}" for ${formatPriceCents(priceCents)}? This is a dev-mode simulation — no real money is ever charged, but the seller's dállers balance is credited for real.`,
  );
  if (!confirmed) return;
  shopBuyHintEl.disabled = true;
  try {
    await purchaseInstance(review.mesh.userData.instanceId);
    alert('Purchase simulated — the seller has been credited.');
  } catch (err) {
    alert(err.message || 'Could not simulate this purchase.');
  } finally {
    shopBuyHintEl.disabled = false;
  }
});

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
  for (const sign of [...shopSigns]) {
    if (sign.group !== entry.group) continue;
    disposeSignSprites(sign);
    shopSigns.splice(shopSigns.indexOf(sign), 1);
    if (nearestActiveSign === sign) {
      nearestActiveSign = null;
      shopSignHintEl.classList.remove('visible');
    }
  }
  for (const calendar of [...shopCalendars]) {
    if (calendar.group !== entry.group) continue;
    disposeCalendarSprites(calendar);
    shopCalendars.splice(shopCalendars.indexOf(calendar), 1);
    if (nearestActiveCalendar === calendar) {
      nearestActiveCalendar = null;
      shopCalendarHintEl.classList.remove('visible');
    }
  }
  for (const review of [...shopReviews]) {
    if (review.group !== entry.group) continue;
    disposeReviewSprites(review);
    shopReviews.splice(shopReviews.indexOf(review), 1);
    if (nearestActiveReview === review) {
      nearestActiveReview = null;
      shopReviewHintEl.classList.remove('visible');
      shopBuyHintEl.classList.remove('visible');
    }
    // The tapped product's own mesh is about to be disposed below — clear
    // the reference and hide its info rather than leaving #shop-product-info
    // pointing at (and this landlet's next load potentially reusing) a
    // stale entry.
    if (shopTappedProduct === review) {
      shopTappedProduct = null;
      shopProductInfoEl.classList.remove('visible');
    }
  }
  // Any confetti burst still mid-flight on this landlet would otherwise
  // keep animating on (and eventually try to remove itself from) a group
  // whose other contents just got disposed above.
  for (const burst of [...confettiBursts]) {
    if (burst.group !== entry.group) continue;
    disposeConfettiBurst(burst);
    confettiBursts.splice(confettiBursts.indexOf(burst), 1);
  }
}

// The normal builder UI (toolbar, product hint, camera debug, undo/redo)
// belongs to the single-landlet editing experience — none of it applies
// while visiting, and left showing it would just overlap Shop's own
// overlay. There's nothing to restore on the way out: leaving Shop mode
// (via #mode-nav's Build/Sell buttons) reloads the page rather than
// trying to undo this.
const SHOP_HIDDEN_BUILDER_UI_IDS = [
  'notifications-btn', 'friends-btn', 'undo-redo-panel', 'product-info', 'gizmo-mode-controls', 'add-item-panel', 'camera-debug-panel',
];

async function enterShopMode() {
  for (const el of [shopStatusEl, shopHintEl, shopMoveJoystickEl, shopLookJoystickEl, shopFlyBtn, shopVerticalControlsEl]) {
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
  // from leaving a seam right at the wall's own base. Uses the same brand
  // green as the UI's own "active" accent (index.html's --brand-green) —
  // this used to be a much darker forest green that read as a heavy,
  // ominous swath across an otherwise bright scene once every visible
  // landlet resolves against it.
  const wildGround = new THREE.Mesh(
    new THREE.CircleGeometry(shopWorldRadiusM + SHOP_WALL_MARGIN_M, 64),
    new THREE.MeshStandardMaterial({ color: 0x6ca42e }),
  );
  scene.add(wildGround);
  shopWorldObjects.push(wildGround);

  const wallGeometry = new THREE.CylinderGeometry(shopWorldRadiusM, shopWorldRadiusM, SHOP_WALL_HEIGHT_M, 64, 1, true);
  paintVerticalGradient(wallGeometry, (localY, out) => {
    const t = THREE.MathUtils.clamp((localY + SHOP_WALL_HEIGHT_M / 2) / SHOP_WALL_HEIGHT_M, 0, 1);
    out.copy(SHOP_GROUND_HORIZON_COLOR).lerp(SHOP_HAZY_HORIZON_COLOR, t);
  });
  // A custom shader (unlit, like the MeshBasicMaterial this replaced) so a
  // soft swirling cloud layer can be painted over the vertex-color gradient
  // below — see createShopSkyMaterial's own comment. Shared with the dome
  // (created just below) so both animate in perfect sync off one clock.
  shopSkyMaterial = createShopSkyMaterial(shopWorldRadiusM);
  shopSkyClockStart = null;
  const wall = new THREE.Mesh(wallGeometry, shopSkyMaterial);
  wall.rotation.x = Math.PI / 2; // THREE's cylinder stands along local Y by default — this world is Z-up
  wall.position.z = SHOP_WALL_HEIGHT_M / 2;
  scene.add(wall);
  shopWorldObjects.push(wall);
  shopWallMesh = wall;

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
  shopDomeMesh = new THREE.Mesh(domeGeometry, shopSkyMaterial);
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

  // Shop mode can be (re-)entered without a reload (see this function's own
  // opening comment) — remove any avatar left over from a previous round
  // trip before building a fresh one, rather than ending up with two
  // overlapping bodies.
  if (shopAvatar) scene.remove(shopAvatar.group);
  shopAvatar = createShopAvatar();
  scene.add(shopAvatar.group);
  shopAvatarPosition.set(0, 0, 0);
  shopAvatarSwing = 0;
  shopAvatarWalkPhase = 0;
  shopIdleElapsedS = 0;
  shopIdleBlend = 0;
  shopIdleSwayYawOffset = 0;
  shopIdleHeadCurrentRad = 0;
  shopIdleHeadTargetRad = 0;
  shopIdleHeadTimerS = 0;
  // First-ever Shop-mode visit on this device spawns already flying, above
  // the world (docs/SPEC.md §1) — every later visit starts grounded as
  // before. Skips the takingOff ramp entirely (that's for a player-
  // initiated toggle mid-session, not this one-time spawn), landing in
  // 'flying' directly the same way toggleShopFlight's own takingOff path
  // eventually would.
  const isFirstShopVisit = !localStorage.getItem(SHOP_VISITED_BEFORE_KEY);
  if (isFirstShopVisit) localStorage.setItem(SHOP_VISITED_BEFORE_KEY, '1');
  shopFlightState = isFirstShopVisit ? 'flying' : 'grounded';
  shopFlightTransitionElapsedS = 0;
  shopFlightAltitudeM = isFirstShopVisit ? SHOP_NEW_VISITOR_START_ALTITUDE_M : 0;
  // Normally kept in sync every frame by the update loop (see
  // shopFlightAltitudeM's own comment) — set once here too so the
  // positionShopCamera() call below (synchronous, before that loop's first
  // tick) doesn't position the camera against the stale z=0 this function's
  // own shopAvatarPosition.set(0, 0, 0) just above left it at.
  shopAvatarPosition.z = shopFlightAltitudeM;
  shopUpHeld = false;
  shopDownHeld = false;
  shopVerticalInput = 0;
  document.body.classList.toggle('shop-flying', isFirstShopVisit);
  shopFlyBtn.classList.toggle('active', isFirstShopVisit);

  shopYaw = 0;
  shopPitch = -0.12;
  shopAvatarFacing = 0;
  applyShopCameraOrientation();
  positionShopCamera();
  setShopFov(camera.fov); // re-clamp in case a previous Shop session left it zoomed
  shopLastFrameTime = null;
  shopLastProximityCheck = 0;
  // Not just clearing the text — an empty .visible pill still shows its
  // own padding/background as a small blank rectangle, which sat directly
  // on top of the wordmark (both anchored at the same top:10/left:12 spot)
  // once the world finished loading. Hiding it outright once there's
  // nothing left to say is the actual fix; the "Loading the world…"/error
  // paths above re-add .visible themselves whenever there's real text.
  shopStatusEl.textContent = '';
  shopStatusEl.classList.remove('visible');
  shopActive = true;
}

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
      // Sell is a modal overlay, not a real mode transition (currentMode
      // never becomes 'sell' — see updateModeNavUI's own comment), so its
      // nav button needs to be marked active here explicitly rather than
      // through the usual currentMode-driven highlighting; closeSellerModal
      // restores the real Shop/Build highlighting once it closes.
      for (const b of modeNavButtons) b.classList.toggle('active', b.dataset.mode === 'sell');
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
const claimSelectionNameEl = document.getElementById('claim-selection-name');
const claimConfirmBtn = document.getElementById('claim-confirm-btn');

function runClaimFlow() {
  return new Promise((resolve) => {
    claimModalEl.classList.add('visible');
    loadLandletMap(resolve);
    claimRefreshBtn.onclick = () => loadLandletMap(resolve);
    // A reload rather than trying to unwind this modal in place — the
    // same clean-slate escape hatch #mode-nav's own Shop/Build switching
    // uses, and for the same reason: there's nothing built yet here to
    // preserve, so starting bootstrap() over from scratch is simpler than
    // reasoning about every way this could be left dangling (the builder
    // this flow is claiming for getting deleted out from under it, say).
    // Explicitly targeting 'build' keeps this landing back in the
    // login/claim flow rather than the bare reload's own default of Shop.
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

// loadLandletMap awaits a fetch before building its scene; if Refresh is
// clicked again before that fetch resolves, disposeClaimFlyover() at the
// new call's start is a no-op (claimFlyover is still null either way), so
// without this guard both calls would go on to build a full scene, attach
// their own canvas click/resize listeners, and race to overwrite the
// shared claimFlyover — leaking one call's listeners/RAF loop forever.
// Each call captures the token's value *before* it starts awaiting, then
// checks it's still the latest afterward; a superseded call bails out
// quietly instead of building anything.
let claimMapLoadToken = 0;

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
// A landlet without a real generated polygon still actually renders as a
// plain area-sized square (see shapeForLandlet's own fallback) — computing
// coverage against real polygons only, while excluding those squares
// entirely, used to make computeGaplessWorldRadius think there was a gap
// exactly where starter-landlet's own square visibly sits. Worse than
// merely inaccurate: starter-landlet ships with an empty polygon by
// default and only ever gets a real one via the one-time /land-candidates/
// generate-mosaic call, which the automatic world-growth job (see
// worker/index.js's autoGrowWorldIfNeeded) never runs — so in a real
// deployment relying solely on that automatic growth, the origin's
// "coverage" would come entirely from this fallback square, permanently.
// Mirrors shapeForLandlet's exact fallback math so this never disagrees
// with what's actually drawn.
function landletWorldPolygon(record) {
  if (record.polygon && record.polygon.length >= 3) {
    return record.polygon.map((p) => ({ x: record.center.x + p.x, y: record.center.y + p.y }));
  }
  const half = Math.sqrt(record.areaM2) / 2;
  return [
    { x: record.center.x - half, y: record.center.y - half },
    { x: record.center.x + half, y: record.center.y - half },
    { x: record.center.x + half, y: record.center.y + half },
    { x: record.center.x - half, y: record.center.y + half },
  ];
}

function computeGaplessWorldRadius(landlets, worldRadiusM) {
  const worldPolygons = landlets.map(landletWorldPolygon);
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

// Matches SHOP_PLOT_COLORS' own claimed color (see its comment) so the
// claim-map flyover and the real 3D world it's picking a plot in agree.
const CLAIM_PLOT_COLORS = { greenbelt: 0x6ca42e, claimed: 0xc2a878 };

// A navigable overhead flyover: an orbit-controlled camera looking down at
// a flat rendering of the whole world circle and every landlet in it, each
// shape/position/color drawn straight from real world data (no separate 2D
// projection math — a landlet's plot sits at its own center_x_m/center_y_m
// on the same X/Y ground plane the builder scene itself uses). Tapping a
// plot previews it below regardless of status; only an available
// (greenbelt) one enables the Claim button.
async function loadLandletMap(resolve) {
  const myLoadToken = ++claimMapLoadToken;
  claimStatusEl.textContent = 'Loading the world…';
  claimStatusEl.classList.remove('error');
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
    if (myLoadToken !== claimMapLoadToken) return; // superseded — a newer load owns the UI now
    claimStatusEl.textContent = err.message || 'Could not load the world.';
    claimStatusEl.classList.add('error');
    return;
  }
  if (myLoadToken !== claimMapLoadToken) return; // superseded while fetching — abandon quietly, nothing built yet

  const radiusM = world.radiusM;
  const scene = new THREE.Scene();
  // Bright pale sky + soft green ground — this map used to be a near-black
  // "radar" backdrop, which read as ominous rather than the lighthearted,
  // bright feel the rest of the world now goes for (see the day-night
  // removal and index.html's own brand-color comment).
  scene.background = new THREE.Color(0x87ceeb);
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(radiusM, -radiusM, radiusM * 2);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(radiusM * 1.4, 64),
    new THREE.MeshBasicMaterial({ color: 0xa8d98a }),
  );
  scene.add(ground);

  const boundary = new THREE.Mesh(
    new THREE.RingGeometry(radiusM * 0.99, radiusM * 1.01, 128),
    new THREE.MeshBasicMaterial({ color: 0x16240a, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
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
  // applyLandletShape() swaps the main builder scene's ground geometry. A
  // bold yellow ring (the brand's secondary pale-yellow hue, saturated up
  // for a "this one's selected" highlight) rather than white, which would
  // barely register against this map's now-bright ground colors.
  const selectionOutlineMaterial = new THREE.LineBasicMaterial({ color: 0xf5c518 });
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

  // The world now grows itself on a schedule (see worker/index.js's
  // scheduled() export) rather than needing a player to trigger it by
  // hand — this can only actually show right after a fresh deployment, in
  // the brief window before the first automatic growth cycle runs.
  claimStatusEl.textContent = anyAvailable
    ? ''
    : 'No landlets are ready to claim yet — check back again shortly.';
}

async function claimSelectedLandlet(landlet, resolve) {
  claimConfirmBtn.disabled = true;
  claimStatusEl.textContent = `Claiming ${landlet.name}…`;
  claimStatusEl.classList.remove('error');
  try {
    const claimed = await claimLandlet(landlet.landletId);
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

  // Only Build/Sell actually need currentAuthUser settled before
  // proceeding (see authInitPromise's own comment on the race this
  // avoids) — deliberately not awaited above, so a Shop-mode visit (the
  // majority of traffic, and the one path this file already goes out of
  // its way to render instantly without waiting on the network) is never
  // held up by it.
  await authInitPromise;
  currentMode = 'build';
  updateModeNavUI();
  builderId = await ensureBuilderIdentity();
  if (!builderId) {
    // Declined to log in (closed #auth-modal without signing in/up) —
    // Build/Sell both require a real account now (docs/API.md's
    // "Authentication"), so there's nothing left to build on. Falls back
    // to Shop mode rather than proceeding with no identity at all.
    currentMode = 'shop';
    updateModeNavUI();
    await enterShopMode();
    return;
  }
  refreshNotificationsBadge();
  refreshFriendsBadge();
  let instances;
  try {
    currentLandletId = await resolveLandletId();
    const [catalog, remoteInstances, landletRecord, bundles, shared] = await Promise.all([
      fetchCatalog(), fetchInstances(currentLandletId), fetchLandlet(currentLandletId), fetchBundles(), fetchSharedBundles(),
    ]);
    activeCatalog = catalog;
    instances = remoteInstances;
    myBundles = bundles;
    communityBundles = shared;
    applyLandletShape(landletRecord);
  } catch (err) {
    console.warn('Backend unreachable, falling back to local/placeholder data:', err);
    activeCatalog = FALLBACK_CATALOG;
    myBundles = [];
    communityBundles = [];
    currentLandletId = 'starter-landlet';
    // A previously-saved instance list (builder additions/removals/moves)
    // entirely replaces the starter set — not merged with it — since the
    // starter set is just a first-visit default, not content to preserve
    // alongside whatever the builder has actually done.
    instances = loadInstances() ?? DEFAULT_INSTANCES;
  }

  buildCatalogPickerButtons();
  renderBundlePicker();
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
