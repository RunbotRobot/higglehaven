// #2559 (part of #2504/#2500's src/main.js module split, see #2503's design
// comment for the full dependency map): Build mode's core editor
// internals, extracted from src/main.js — gizmos/collision/snap/alignment/
// trim, undo/redo, measure mode, selection + selection outlines, low-stock/
// sold-out highlighting, clipboard (copy/paste), levels (vertical
// construction), and sync/connectivity state.
//
// Owner-input item (design comment's item #5, still open): enterShopMode/
// enterSellMode in main.js currently reach directly into this module's own
// exports (clearSelection, productMeshes, etc.) to tear Build's state down
// on mode switch, rather than through one clean exported
// teardownBuildScene(). That requires confirming with the owner first
// whether "always full-reload on mode switch" is still the settled design
// (weakening this defensive teardown risks reintroducing a real cross-mode
// state-leak bug per #1950/#2068) — this leaf deliberately preserves
// today's direct-reach teardown shape unchanged, just via imports instead
// of same-file access, and does not introduce teardownBuildScene().
//
// src/claim/flow.js's own click-pointer dispatcher and the single shared
// `click` listener in main.js (which also branches into Sell mode's own
// showcase-picking) stay in main.js rather than moving here, since they
// genuinely span both Build and Sell concerns (design comment's finding
// #6, confirmed during this extraction: it is a real shared dispatcher,
// not a click handler doing double duty by accident) — this module exports
// raycaster/ndcFromEvent/pointerDownPos/CLICK_DRAG_THRESHOLD_PX/
// measureMode/measureMarkerWasDragged/handleMeasureClick/pendingPlacement/
// handlePlacementClick/findRootProduct/multiSelectMode/toggleInSelection/
// selectOnly back to main.js for that one listener to keep calling into,
// unchanged in behavior.
//
// shapeForLandlet still physically lives in main.js and gets imported back
// here — same temporary circular-import pattern account/auth.js, identity.js,
// menu.js and build/layoutPreview.js already use for their own
// not-yet-extracted dependencies (pending claim/flow.js's own future
// extraction of it). addItemBtn/closeCatalogPicker, by contrast, landed in
// src/catalog/picker.js (#2558, merged after this leaf's own implementation
// was done) — imported from there directly rather than through main.js's
// own now-stale re-export. Safe since every cross-reference is inside a
// function body, never evaluated at module-top-level — confirmed by a
// clean `vite build`.
//
// src/build/layoutPreview.js (#2561) previously imported several of these
// exports (controls/rotateControls/translateControls/clearSelection/
// addSelectionOutline/removeSelectionOutline/buildModeFrameUpdate/
// setLastKnownDistance) from main.js as its own stopgap, pending this
// leaf — that import is repointed to this module as part of this PR.
//
// Settings' Build tab (renderBuildSettingsSection, main.js) stays out of
// this leaf's scope entirely — it's Version History/Publish/Saved Layouts,
// none of which touch this module's own state. Its sibling Low Stock/Sold
// Out Markers sections (renderLowStockSection/renderSoldOutMarkersSection,
// also main.js) do read/write this module's lowStockFilterMaxQty/
// lowStockFilterMaxDays/showSoldOutMarkers/soldOutMarkers and call its
// updateLowStockHighlights/applySoldOutMarkerVisibility/
// removeSoldOutMarkerMesh — exported here for that reason, imported back
// into main.js. Per the design comment's item #2 (still unresolved, #2565's
// own question), whether render*SettingsSection functions should move
// into their own feature modules isn't decided here.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
  createInstanceRemote, updateInstanceRemote, deleteInstanceRemote,
  createInstancesRemote, upsertInstancesRemote, deleteInstancesRemote,
  fetchLandlets, fetchLandletLevels, addLandletLevel, deleteLandletLevel,
  groupInstancesRemote, ungroupInstancesRemote,
} from '../api.js';
import { toDisplayLength, fromDisplayLength, formatLength, formatArea } from '../settings.js';
import { saveInstances } from '../layoutStorage.js';
import { footprintScaleAtHeight } from '../../worker/earthCurvature.js';
import {
  curveGroundGeometry, flatGroundHitPoint, createGroundTexture, normalizeGroundShapeUVs,
  landlet, findTemplate, loadModelAnimations, computeSkeletonSignature, loadModelInstance,
  extensibleAxes, effectiveLength, meshDimensions, buildInstanceLodProxy, setInstanceLodState,
  AXIS_DIMENSION_KEY, AXIS_LIST, FLOORING_THICKNESS_M, isFlooringTemplate,
  createMeshForInstance, disposeMaterialTextures, disposeObject,
} from '../world/models.js';
import { builderId, currentLandletId, LANDLET_AREA_M2, LANDLET_SIDE_M, LANDLET_HEIGHT_M } from '../world/state.js';
import { scene, camera, renderer, canvas, registerModeFrameUpdate } from '../world/scene.js';
import { runClaimFlow } from '../claim/flow.js';
import { shapeForLandlet, BUILD_TARGET_LANDLET_ID_KEY } from '../main.js';
import { addItemBtn, closeCatalogPicker } from '../catalog/picker.js';

// Vertical construction (issue #167/#168/#169): the current lándlet's own
// ground-level area (needed to preview a level's cap cost client-side
// before committing, matching worker/index.js's levelCapConsumedM2 exactly)
// and its already-built levels beyond ground (worker/index.js's
// landlet_levels, fetched alongside landletRecord in bootstrap() — see
// fetchLandletLevels). currentLevelIndex is which one Build mode is
// currently viewing/editing — 0 is the ground level every lándlet already
// has (never a real landlet_levels row); see renderLevelControls. Levels
// stack directly with no gaps (matching the backend's own assumption),
// each occupying [levelIndex * LANDLET_HEIGHT_M, (levelIndex + 1) *
// LANDLET_HEIGHT_M) — level 0 is exactly today's existing [0, 10) range.
export let currentLandletAreaM2 = LANDLET_AREA_M2;
export let currentLandletLevels = [];
export let currentLevelIndex = 0;

// #2871: every placed product (plus the group-move pivot, trim preview,
// alignment guides, and sold-out ghost markers -- anything positioned
// relative to a real product's own x/y/z) lives inside this group rather
// than directly in `scene`, so a landlet's real elevationM (set on this
// group's own position.z by applyLandletShape, below) lifts all of them
// together with the ground. `landlet` itself stays out of this group --
// its own elevation lift is baked straight into its geometry instead (see
// applyLandletShape's own curveGroundGeometry call) -- so nothing here
// double-counts that offset. Selection outlines/low-stock highlights and
// the measure tool are deliberately NOT in this group: the former track
// their target's *world* bounding box every frame regardless of parent,
// and the latter is positioned from raycast hit points, which are already
// world-space and therefore already elevation-correct once the meshes
// they're cast against are.
export const landletElevationGroup = new THREE.Group();
scene.add(landletElevationGroup);
export function setCurrentLandletAreaM2(value) {
  currentLandletAreaM2 = value;
}
export function setCurrentLandletLevels(value) {
  currentLandletLevels = value;
}
export function setCurrentLevelIndex(value) {
  currentLevelIndex = value;
}

function levelFloorZ(levelIndex) {
  return levelIndex * LANDLET_HEIGHT_M;
}

// Mirrors worker/index.js's own levelCapConsumedM2 exactly (same formula,
// same sampling point) so the cost this previews before a builder commits
// to a new level is never off from what the server will actually charge.
function levelCapConsumedM2(landletAreaM2, levelIndex) {
  const scale = footprintScaleAtHeight(levelIndex * LANDLET_HEIGHT_M);
  return landletAreaM2 * scale * scale;
}

function levelExtent() {
  const indices = currentLandletLevels.map((level) => level.levelIndex);
  return { top: Math.max(0, ...indices), bottom: Math.min(0, ...indices) };
}

function levelLabel(levelIndex) {
  if (levelIndex === 0) return 'Ground';
  return levelIndex > 0 ? `Level +${levelIndex}` : `Level ${levelIndex}`;
}


// Dev-only orbit camera so the scene is inspectable on a phone (pinch/drag)
// before any real avatar movement exists. Not part of the in-world control scheme.
export const controls = new OrbitControls(camera, renderer.domElement);
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
export function footprintCorners(mesh, x, y) {
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

export function footprintsOverlap(cornersA, cornersB) {
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
// clamped between the ground and the buildable volume's ceiling — see
// LANDLET_HEIGHT_M. Collision with other products (resolveByAxis, above)
// is applied separately, after this.
//
// docs/SPEC.md §3's radial-cone correction (issue #136): a fixed *angular*
// footprint's cross-section grows moving away from Earth's center, not the
// flat-cylinder assumption a constant halfSpanX/halfSpanY would make. Z is
// clamped first, then that height feeds footprintScaleAtHeight
// (worker/earthCurvature.js) to widen the X/Y bounds by exactly the same
// factor a real fixed-angular-footprint lándlet would have at that height —
// genuinely tiny at this scale (LANDLET_HEIGHT_M=10 against Earth's ~6.371
// million meter radius is a ~0.00016% change), but the correct shape rather
// than a flat placeholder. footprintScaleAtHeight's own formula already
// covers both directions (> 1 above ground, < 1 below), so below-ground
// levels (vertical digging, currentLevelIndex < 0 — see #169's own comment
// just below) narrow correctly here too, not just the above-ground case.
//
// Widening around THIS lándlet's own local center, rather than around the
// single shared point (Earth's center, projected as the world origin) a
// true fixed-angular cone widens from, isn't exactly gap/overlap-free
// against a neighboring lándlet doing the same (issue #170) —
// worker/earthCurvature.js's neighborAdjacencyErrorM quantifies exactly
// how far off, and its own tests show it's the same order of magnitude as
// #135's already-accepted vertical sag at today's scale. Build mode never
// renders two lándlets' buildable volumes together to make this visible
// anyway; the real fix is the same reprojection-from-Earth's-center #166
// already defers, not something to half-solve here.
//
// issue #169: the floor/ceiling used to be hardcoded to ground level's own
// [0, LANDLET_HEIGHT_M) — now taken from whichever level Build mode is
// currently viewing/editing (currentLevelIndex/levelFloorZ), so an item
// placed while looking at Level +1 or Level -1 clamps into *that* level's
// own 10m slab instead of always snapping back into ground's. z itself
// stays an absolute height above ground throughout (matching how a level
// is identified purely by z falling in its own range — see
// currentLandletLevels' own comment), so footprintScaleAtHeight below still
// gets the real, correct height for the cone's cross-section at that
// point, continuously, exactly as it always has for ground level.
function clampToLandlet(mesh, x, y, z) {
  const { width, depth, height } = meshDimensions(mesh);
  const floorZ = levelFloorZ(currentLevelIndex);
  const ceilingZ = floorZ + LANDLET_HEIGHT_M;
  const clampedZ = THREE.MathUtils.clamp(z, floorZ + height / 2, ceilingZ - height / 2);
  const footprintScale = footprintScaleAtHeight(clampedZ);
  const halfSpanX = (LANDLET_SIDE_M / 2) * footprintScale - width / 2;
  const halfSpanY = (LANDLET_SIDE_M / 2) * footprintScale - depth / 2;
  return {
    x: THREE.MathUtils.clamp(x, -halfSpanX, halfSpanX),
    y: THREE.MathUtils.clamp(y, -halfSpanY, halfSpanY),
    z: clampedZ,
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
      // #402: pushUndoSnapshot captures productMeshes as it stands right
      // now — skip it while another action (Undo/Redo, a trim commit,
      // Paste, tap-to-place) is still mid-flight rebuilding that same
      // array, so a bad-timing drag doesn't push a torn, partially-
      // rebuilt snapshot onto the undo stack. The drag itself still
      // proceeds either way — it only repositions the one mesh already
      // being dragged, not the productMeshes array's own membership, so
      // it isn't itself part of the race #402 is about.
      if (!sceneMutationBusy) pushUndoSnapshot();
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
export const rotateControls = new TransformControls(camera, renderer.domElement);
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
export const translateControls = new TransformControls(camera, renderer.domElement);
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
// #2871: its own position is set directly from getSelectionPivot(), a
// centroid of selected meshes' own (landletElevationGroup-local)
// positions -- living in that same group keeps the gizmo's visual
// position matching the real meshes it's attached to, rather than
// rendering elevationM off from them.
landletElevationGroup.add(groupMovePivot);
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
  // #2871: drawn from a dragged mesh's own (now landletElevationGroup-
  // local) position.z -- lives in that same group so the guide stays
  // visually level with the item it's guiding, not stranded at the old
  // pre-elevation baseline.
  landletElevationGroup.add(line);
  return line;
}
const alignmentGuideX = makeAlignmentGuide(); // shown when the dragged item's X is currently snapped — drawn running along Y, at the shared X coordinate
const alignmentGuideY = makeAlignmentGuide(); // same, for a Y snap — drawn running along X

// null per axis when nothing's currently snapped; otherwise
// { guideCoordinate, snappedValue, capturedRawValue } — guideCoordinate is
// the target edge/center coordinate the snap matched against (drawn as the
// guide line), snappedValue is what the dragged mesh's own center gets set
// to so its matching edge/center actually lands there, and capturedRawValue
// is the raw drag position at the moment this snap was captured — what the
// hysteresis check below measures the current raw drag against. That has
// to be capturedRawValue rather than guideCoordinate: an edge-matched snap
// (see findAlignmentSnap's own min/center/max candidates) has a
// guideCoordinate offset from the dragged mesh's own center by its
// half-extent, a different coordinate space than the raw center-drag
// position resolveAlignmentAxis is called with — comparing rawValue
// against guideCoordinate directly made the release band effectively
// never apply to edge snaps (the common case), since that offset is
// almost always bigger than ALIGNMENT_RELEASE_M.
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
  if (held && Math.abs(rawValue - held.capturedRawValue) < ALIGNMENT_RELEASE_M) {
    return held.snappedValue; // still within the release band — keep holding, ignore rawValue entirely
  }
  const found = findAlignmentSnap(movingMesh, axis, rawValue);
  if (found) found.capturedRawValue = rawValue;
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
      // issue #169: bounded by whichever level is currently being viewed/
      // edited, same as clampToLandlet's own single-item case.
      minOffsetZ = Math.max(minOffsetZ, levelFloorZ(currentLevelIndex) + height / 2 - start.z);
      maxOffsetZ = Math.min(maxOffsetZ, levelFloorZ(currentLevelIndex) + LANDLET_HEIGHT_M - height / 2 - start.z);
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
    // #1770: the single-item branch below clamps a flooring instance's Z to
    // stay flush with the ground (see isFlooringTemplate) -- apply the same
    // override here per-mesh, after the shared group offset above, so a
    // flooring tile in a multi-select group can't be lifted into the air
    // along with the rest of the group.
    for (const mesh of meshes) {
      if (isFlooringTemplate(mesh.userData.template)) mesh.position.z = FLOORING_THICKNESS_M / 2;
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

// #1770: same reasoning as window.__testTeleportShopAvatar and the other
// window.__test* hooks elsewhere in this file -- lets a test move a multi-
// select group's Z precisely, without needing to mouse-drag the 3D gizmo's
// own blue arrow handle (whose screen-space position depends on camera
// framing). Only does anything once translateControls is already attached
// to groupMovePivot (i.e. 2+ items are selected in Move mode, the normal
// precondition for a real group drag) -- inert otherwise.
window.__testDragGroupMoveZ = (offsetZ) => {
  if (translateControls.object !== groupMovePivot) return false;
  translateControls.dispatchEvent({ type: 'dragging-changed', value: true });
  groupMovePivot.position.z += offsetZ;
  translateControls.dispatchEvent({ type: 'objectChange' });
  translateControls.dispatchEvent({ type: 'dragging-changed', value: false });
  return true;
};

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

// A trim commit (drag-release below, or a typed length in the axis-length
// fields further down) calls replaceMeshWithCrop, which awaits a full
// model rebuild before swapping the result into productMeshes/scene/
// selectedMeshes. Two commits close enough together — e.g. tabbing from
// one axis field to another, or a fast second drag, before the first
// rebuild resolves — would otherwise both read the *same* pre-edit mesh
// and crop, race to swap it in, and leave one commit's result an orphaned
// mesh: visible in the scene but never written into productMeshes, so
// unreachable by undo/redo, persistLayout, or syncUpdate, while silently
// losing that commit's crop change. Funneling every trim commit through
// this single promise chain serializes them — each waits for the
// previous one's full swap to finish before it starts — and
// queueTrimEdit's callers re-resolve the *current* mesh by instanceId
// from productMeshes right before building on it, rather than closing
// over a mesh reference that may already be stale by the time its turn
// comes up.
let trimEditQueue = Promise.resolve();
function queueTrimEdit(task) {
  const run = trimEditQueue.then(task, task);
  trimEditQueue = run.catch((err) => console.error('Trim edit failed:', err));
  return run;
}

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
    landletElevationGroup.remove(trimPreviewMesh);
    disposeObject(trimPreviewMesh);
  }
  trimPreviewMesh = preview;
  trimPreviewLength = clampedLength;
  // #2871: instanceLike.z above was copied straight from object.position.z
  // (already landletElevationGroup-local post-reparenting), so the
  // preview needs to live in that same group to render at the matching
  // height rather than the old un-lifted baseline.
  landletElevationGroup.add(trimPreviewMesh);
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
    landletElevationGroup.remove(trimPreviewMesh);
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

trimControls.addEventListener('dragging-changed', (event) => {
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
    // #402's own fix for this exact race (a drag-start pushUndoSnapshot()
    // capturing productMeshes while another mutation — Undo/Redo, Paste,
    // tap-to-place — is still mid-flight rebuilding it) only reached
    // wireDraggingBehavior's Move/Rotate listener; this separate Trim
    // listener's own drag-start call was missed.
    if (!sceneMutationBusy) pushUndoSnapshot();
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
  const axis = trimAxis;
  const instanceId = object.userData.instanceId;
  clearTrimPreview(object);
  object.scale.set(1, 1, 1);
  queueTrimEdit(async () => {
    const current = productMeshes.find((m) => m.userData.instanceId === instanceId);
    if (!current) return; // deleted, or otherwise gone, since this drag ended
    // #402: replaceMeshWithCrop's own await is exactly the gap Undo/Redo
    // (or another mutating action) could interleave a productMeshes
    // change across — hold the shared gate for it, same reasoning as the
    // other call sites below.
    if (!beginSceneMutation()) return;
    try {
      const updated = await replaceMeshWithCrop(current, { ...current.userData.crop, [axis]: clampedLength });
      if (!updated) return; // deleted while this crop's model was loading
      const clamped = clampToLandlet(updated, updated.position.x, updated.position.y, updated.position.z);
      updated.position.set(clamped.x, clamped.y, clamped.z);
      updated.userData.safePosition = updated.position.clone();
      // The await above is a real gap a builder can select a different item
      // across — only re-attach the trim gizmo here if `updated` is still
      // that selection (replaceMeshWithCrop itself already made that same
      // call for selectedMeshes/its outline; this mirrors it for the
      // gizmo). Otherwise whatever's actually selected now already has its
      // own correct gizmo attached, and forcing this one back on would
      // silently swap it out from under the builder mid-edit.
      if (selectedMeshes.has(updated)) trimControls.attach(updated);
      persistLayout();
      syncUpdate(updated);
      updateTrimLengthInput();
    } finally {
      endSceneMutation();
    }
  });
});


// Swaps the ground mesh's geometry for the landlet's real polygon (plot-
// local offsets from its own center, per docs/API.md) once bootstrap() has
// fetched it — a plain square fallback (shapeForLandlet's own fallback) for
// legacy/placeholder landlets that predate real procedural generation.
// landlet/createGroundTexture/normalizeGroundShapeUVs/curveGroundGeometry
// now live in src/world/models.js (#2553); shapeForLandlet is still here,
// pending claim/flow.js's own extraction of it.
export function applyLandletShape(landletRecord) {
  const oldGeometry = landlet.geometry;
  landlet.geometry = new THREE.ShapeGeometry(shapeForLandlet(landletRecord));
  normalizeGroundShapeUVs(landlet.geometry);
  // #2851: real terrain elevation, already baselined server-side
  // (worker/lib/world-generation.js), composed with this geometry's own
  // Earth-curvature sag rather than replacing it.
  curveGroundGeometry(landlet.geometry, landletRecord.elevationM ?? 0);
  // #2871: the same lift, applied to every placed product (and anything
  // positioned relative to one) via landletElevationGroup's own position
  // instead of baking it into each one's own geometry/position -- see
  // that group's own declaration comment for why this doesn't double up
  // with the line just above.
  landletElevationGroup.position.z = landletRecord.elevationM ?? 0;
  oldGeometry.dispose();
  // #2371: landletMaterial starts out on the default/unclassified texture
  // (created before any real landlet is known) -- swap to this landlet's
  // own real biome once it's actually loaded. Textures themselves are
  // cached by createGroundTexture, so there's nothing to dispose here.
  landlet.material.map = createGroundTexture(landletRecord.biome);
  landlet.material.needsUpdate = true;
}

// loadModelGltf/loadModelScene/loadModelAnimations/computeSkeletonSignature/
// loadModelInstance/extensibleAxes/effectiveLength/meshDimensions/
// buildInstanceLodProxy/setLodChildHitTestable/setInstanceLodState/
// AXIS_DIMENSION_KEY/AXIS_LIST/FLOORING_THICKNESS_M/isFlooringTemplate all
// now live in src/world/models.js (#2553).

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
    label: mesh.userData.label ?? null,
    crop: nextCrop,
    scale: mesh.userData.scale ?? 1,
    isCommunitySign: mesh.userData.isCommunitySign ?? false,
    isCommunityCalendar: mesh.userData.isCommunityCalendar ?? false,
  };
  const newMesh = await createMeshForInstance(instanceLike);
  if (!newMesh) return mesh;

  // The await above is a real gap the original instance can be deleted
  // across (e.g. a Delete press while this crop's model is still
  // loading) — `mesh` itself already got spliced out of productMeshes,
  // removed from the scene, and disposed by deleteInstance in that case.
  // Discard the now-orphaned newMesh instead of unconditionally adding it
  // to the scene: without this check it would still land in `scene`
  // despite never being registered in productMeshes, becoming a
  // permanently unselectable "ghost" (every raycast targets
  // productMeshes, never the raw scene graph) until reload. Returning
  // null lets every caller bail out the same way they already do for a
  // deletion caught *before* this function was even called.
  const index = productMeshes.indexOf(mesh);
  if (index === -1) {
    disposeObject(newMesh);
    return null;
  }
  productMeshes[index] = newMesh;
  landletElevationGroup.remove(mesh);
  disposeObject(mesh);
  landletElevationGroup.add(newMesh);
  newMesh.userData.safePosition = newMesh.position.clone();

  if (selectedMeshes.has(mesh)) {
    removeSelectionOutline(mesh);
    selectedMeshes.delete(mesh);
    selectedMeshes.add(newMesh);
    addSelectionOutline(newMesh);
  }
  // #2342: addLowStockHighlight is keyed on the mesh object itself, and
  // addInstanceToScene's own "single choke point" comment only covers the
  // other three ways a mesh enters productMeshes -- this swap is a fourth,
  // so without this transfer the old mesh's helper/fill (if any) would
  // orphan permanently in `scene` (updateLowStockHighlights only ever
  // iterates the current productMeshes, never finds it again) and the
  // trimmed replacement would silently lose its highlight.
  if (lowStockHighlights.has(mesh)) {
    removeLowStockHighlight(mesh);
    addLowStockHighlight(newMesh);
  }
  return newMesh;
}

// averageTextureColor/loadCroppedModelInstance/createMeshForInstance now
// live in src/world/models.js (#2553).

// Populated by bootstrap() once instance data (API or fallback) is
// available. Declared here, empty, so everything below that references it
// — the click/raycast handler in particular — can be wired up immediately;
// none of that code runs until the user actually interacts, by which point
// bootstrap() has long since filled it in.
export const productMeshes = [];

export async function addInstanceToScene(instance) {
  const object = await createMeshForInstance(instance);
  if (!object) return null;
  // #2871: lives in landletElevationGroup, not `scene` directly, so this
  // single choke point's own "covers every way a new mesh can appear"
  // guarantee also means every placed product picks up the current
  // landlet's real elevationM lift for free, bootstrap's initial batch
  // included.
  landletElevationGroup.add(object);
  productMeshes.push(object);
  // #1950: covers every way a new mesh can appear -- bootstrap()'s initial
  // batch, placing a fresh item from the catalog, and undo/redo recreating
  // one -- through this one choke point, so a low-stock filter that was
  // already active before this instance existed still highlights it the
  // moment it appears, with no separate case needed per call site.
  if (activeLowStockTemplateIds?.has(object.userData.template?.templateId)) {
    addLowStockHighlight(object);
  }
  return object;
}

export function persistLayout() {
  const instances = productMeshes.map((mesh) => ({
    id: mesh.userData.instanceId,
    templateId: mesh.userData.template.templateId,
    x: mesh.position.x,
    y: mesh.position.y,
    z: mesh.position.z,
    rotationX: mesh.rotation.x,
    rotationY: mesh.rotation.y,
    rotationZ: mesh.rotation.z,
    label: mesh.userData.label ?? null,
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
    label: mesh.userData.label ?? null,
    crop: mesh.userData.crop,
    scale: mesh.userData.scale ?? 1,
    isCommunitySign: mesh.userData.isCommunitySign ?? false,
    isCommunityCalendar: mesh.userData.isCommunityCalendar ?? false,
  };
}

// #545: the batch siblings below already surface a sync failure loudly via
// alert() — the single-item ones (this trio) deliberately don't, since
// alerting on every routine move/rotate/place would be far too noisy (see
// their own comment). Owner-clarified UX for the gap that leaves: a single
// small icon reflecting whether the backend was reachable as of the most
// recent sync attempt (any of the six functions below), not a per-action
// alert — shown only while unreachable, explained on tap, and hidden the
// moment any subsequent sync (from any of them) succeeds again. persistLayout
// (this device's own localStorage save) already runs before any of these are
// even called, so nothing here is ever a data-loss risk — purely a "the
// server copy might be stale" signal.
const connectivityIndicatorEl = document.getElementById('connectivity-indicator');
let serverReachable = true;

function setServerReachable(reachable) {
  if (reachable === serverReachable) return;
  serverReachable = reachable;
  connectivityIndicatorEl.hidden = reachable;
}

// Backlog audit: the six sync* functions below all fire fire-and-forget
// (never awaited by their own callers — see spawnInstanceAt's own `if
// (sync) syncCreate(mesh)`), so several can be in flight at once, and
// nothing guarantees they RESOLVE in the order they were ISSUED —
// especially not during the exact connectivity blip this indicator exists
// to show. A request sent right as the connection drops can sit retrying
// long after a later request, sent once the connection came back, has
// already succeeded — if that straggler's failure were applied on
// arrival, it would flip the indicator back to "unreachable" even though
// a more recent attempt already proved the server responds fine again.
// Same supersede-guard idiom as sellerShowcaseLoadToken/
// catalogThumbnailPersistTokens elsewhere in this file: each attempt gets
// a monotonic id at issue time, and a result is only applied if no
// later-issued attempt's result has already landed — an out-of-order
// straggler is silently dropped instead of overwriting fresher info.
let syncAttemptSeq = 0;
let lastAppliedSyncAttempt = 0;
function nextSyncAttempt() {
  return ++syncAttemptSeq;
}
function reportSyncResult(attemptId, reachable) {
  if (attemptId < lastAppliedSyncAttempt) return;
  lastAppliedSyncAttempt = attemptId;
  setServerReachable(reachable);
}

connectivityIndicatorEl.addEventListener('click', () => {
  alert("Can't reach the higglehaven server right now. Your changes are still being saved to this device and will sync automatically once the connection comes back.");
});

// A fetch() call rejects with a TypeError specifically when it never
// reached a server at all (offline, DNS failure, connection refused, CORS) —
// per the Fetch spec, that's the one case this indicator should react to.
// requestJson (src/api.js) throws a plain Error for an HTTP-level failure
// (400/500/...) once a response has actually come back, which means the
// server IS reachable and just rejected the request for its own reason —
// not what this icon is about.
export function isNetworkError(err) {
  return err instanceof TypeError;
}

async function syncCreate(mesh) {
  const attemptId = nextSyncAttempt();
  try {
    await createInstanceRemote(instanceFromMesh(mesh));
    reportSyncResult(attemptId, true);
  } catch (err) {
    console.warn('Failed to sync new instance to backend:', err);
    if (isNetworkError(err)) reportSyncResult(attemptId, false);
  }
}

export async function syncUpdate(mesh) {
  const attemptId = nextSyncAttempt();
  try {
    const { instanceId, ...patch } = instanceFromMesh(mesh);
    await updateInstanceRemote(instanceId, patch);
    reportSyncResult(attemptId, true);
  } catch (err) {
    console.warn('Failed to sync instance update to backend:', err);
    if (isNetworkError(err)) reportSyncResult(attemptId, false);
  }
}

async function syncDelete(instanceId) {
  const attemptId = nextSyncAttempt();
  try {
    await deleteInstanceRemote(instanceId);
    reportSyncResult(attemptId, true);
  } catch (err) {
    console.warn('Failed to sync instance delete to backend:', err);
    if (isNetworkError(err)) reportSyncResult(attemptId, false);
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
  const attemptId = nextSyncAttempt();
  try {
    await createInstancesRemote(meshes.map(instanceFromMesh));
    reportSyncResult(attemptId, true);
  } catch (err) {
    console.warn('Failed to sync new instances to backend:', err);
    if (isNetworkError(err)) reportSyncResult(attemptId, false);
    // #903: a chunked create can fail partway through with earlier chunks
    // already saved — err.succeededCount (set by createInstancesRemote)
    // says how many, so this doesn't claim the whole placement failed when
    // most of it actually made it to the server.
    const failedCount = meshes.length - (err.succeededCount ?? 0);
    alert(`Couldn't save ${failedCount} placed item(s) to the server — they may not survive a reload. ${err.message || ''}`.trim());
  }
}

async function syncBatchUpdate(meshes) {
  if (meshes.length === 0) return;
  const attemptId = nextSyncAttempt();
  try {
    await upsertInstancesRemote(meshes.map(instanceFromMesh));
    reportSyncResult(attemptId, true);
  } catch (err) {
    console.warn('Failed to sync instance updates to backend:', err);
    if (isNetworkError(err)) reportSyncResult(attemptId, false);
    // #1380: same reasoning as syncBatchCreate's own #903 fix above —
    // err.succeededCount (set by upsertInstancesRemote) says how many of a
    // large group-move/undo-redo batch already landed before the chunk
    // that failed, so this doesn't overstate how much was actually lost.
    const failedCount = meshes.length - (err.succeededCount ?? 0);
    alert(`Couldn't save ${failedCount} moved item(s) to the server — they may not survive a reload. ${err.message || ''}`.trim());
  }
}

async function syncBatchDelete(instanceIds) {
  if (instanceIds.length === 0) return;
  const attemptId = nextSyncAttempt();
  try {
    await deleteInstancesRemote(instanceIds);
    reportSyncResult(attemptId, true);
  } catch (err) {
    console.warn('Failed to sync instance deletes to backend:', err);
    if (isNetworkError(err)) reportSyncResult(attemptId, false);
    // #1380: same reasoning as syncBatchCreate's own #903 fix above —
    // err.succeededCount (set by deleteInstancesRemote) says how many of a
    // large multi-delete/undo-redo batch already landed before the chunk
    // that failed, so this doesn't overstate how much was actually lost.
    const failedCount = instanceIds.length - (err.succeededCount ?? 0);
    alert(`Couldn't save the deletion of ${failedCount} item(s) to the server — they may reappear on reload. ${err.message || ''}`.trim());
  }
}

// Places a fresh instance at an exact spot — the world position the
// builder just tapped (see handlePlacementClick) — rather than a random
// offset near the center that then has to be dragged into place.
let instanceCounter = 0;
// sync: false lets a caller placing many instances at once (see
// placeClipboardItems) skip the per-item network request here and batch
// them all into one call itself instead — see syncBatchCreate's doc
// comment for why that distinction matters. clamp: false likewise lets a
// caller placing a whole *group* at once (also placeClipboardItems) skip
// this per-item clamp and apply one shared offset across the group after
// every mesh exists instead — see that call site's own comment for why an
// independent per-item clamp here would squish the group's shape.
async function spawnInstanceAt(template, x, y, z, overrides = {}, { sync = true, clamp = true } = {}) {
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
  if (clamp) {
    const clamped = clampToLandlet(mesh, mesh.position.x, mesh.position.y, mesh.position.z);
    mesh.position.set(clamped.x, clamped.y, clamped.z);
  }
  mesh.userData.safePosition = mesh.position.clone();
  persistLayout();
  if (sync) syncCreate(mesh);
  return mesh;
}

// disposeMaterialTextures/disposeObject now live in src/world/models.js
// (#2553).

// sync: false is the multi-item counterpart to spawnInstanceAt's own —
// used wherever several instances are deleted in one action (multi-delete,
// undo/redo) so the caller can batch the network side into one request.
function deleteInstance(mesh, { sync = true } = {}) {
  const index = productMeshes.indexOf(mesh);
  if (index === -1) return;
  const instanceId = mesh.userData.instanceId;
  productMeshes.splice(index, 1);
  // #1950: unlike selectionOutlines (cleared by the caller via
  // clearSelection() before every delete path), the low-stock highlight
  // isn't selection-coupled, so this one true removal choke point is where
  // it needs to go -- otherwise a highlighted item's BoxHelper/fill mesh
  // would keep floating in the scene, pointing at nothing, after the item
  // itself is gone.
  removeLowStockHighlight(mesh);
  landletElevationGroup.remove(mesh);
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
export function setProductInfo(text) {
  productInfoEl.textContent = text;
  productInfoEl.hidden = !text;
}
productInfoEl.hidden = true;

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
// Community Sign/Calendar/Backup Chain buttons belong to #2560's own
// src/build/metadataModals.js -- updateSelectionUI below needs to reflect
// their enabled/active state
// off the current selection the same way it does for this module's own
// gizmo buttons, so these are the same element re-queried locally rather
// than threaded through as an export, same precedent as #2550's
// accountMenuToggle fallback and this module's own addItemBtn import.
const communitySignBtn = document.getElementById('toggle-community-sign');
const communityCalendarBtn = document.getElementById('toggle-community-calendar');
const backupChainBtn = document.getElementById('toggle-backup-chain');
// #2764
const groupBtn = document.getElementById('group-item');
const ungroupBtn = document.getElementById('ungroup-item');

const deleteBtn = document.getElementById('delete-item');
const multiSelectBtn = document.getElementById('toggle-multiselect');
const measureBtn = document.getElementById('toggle-measure');
const pasteBtn = document.getElementById('paste-btn');
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');

// Vertical construction (issue #169) — Build-mode controls for digging
// down/building up a level and navigating between whichever ones already
// exist on this lándlet. See LANDLET_HEIGHT_M's own block comment above for
// currentLevelIndex/currentLandletLevels/levelFloorZ/levelCapConsumedM2.
const levelLabelEl = document.getElementById('level-label');
const levelDownBtn = document.getElementById('level-down-btn');
const levelUpBtn = document.getElementById('level-up-btn');
const levelBuildBtn = document.getElementById('level-build-btn');
const levelDigBtn = document.getElementById('level-dig-btn');
const levelRemoveBtn = document.getElementById('level-remove-btn');
const levelStatusEl = document.getElementById('level-status');

// #1153: collapses the nav/build/dig/remove/status controls above into one
// small toggle (showing just the current level) that expands a dropdown on
// tap — the same expand-on-demand idiom #account-menu uses elsewhere in
// this file, adapted to open upward since this control sits at the bottom
// of the screen. Deliberately doesn't close on an inner button click the
// way #account-menu's rows do: Up/Down/Build/Dig get used repeatedly while
// reviewing levelStatusEl's own result, which renders inside this same
// panel, so auto-closing on click would hide the very message a failed
// Build/Dig needs to show.
const levelMenuToggle = document.getElementById('level-menu-toggle');
const levelMenuPanel = document.getElementById('level-menu-panel');
levelMenuToggle.addEventListener('click', () => {
  levelMenuPanel.classList.toggle('expanded');
  levelMenuToggle.classList.toggle('active', levelMenuPanel.classList.contains('expanded'));
  levelMenuToggle.setAttribute('aria-expanded', String(levelMenuPanel.classList.contains('expanded')));
});
document.addEventListener('click', (event) => {
  if (!levelMenuPanel.classList.contains('expanded')) return;
  // .contains(), not a strict === against the toggle itself — unlike
  // #account-menu-toggle (plain text, so it's always its own click
  // target), this toggle wraps #level-label in a child <span> so its text
  // can be updated independently; a click landing on that span would
  // otherwise read as an outside click and immediately re-close the panel
  // this same click just opened, in the same tick.
  if (levelMenuToggle.contains(event.target) || levelMenuPanel.contains(event.target)) return;
  levelMenuPanel.classList.remove('expanded');
  levelMenuToggle.classList.remove('active');
  levelMenuToggle.setAttribute('aria-expanded', 'false');
});

function setLevelStatus(message, { isError = false } = {}) {
  levelStatusEl.textContent = message ?? '';
  levelStatusEl.classList.toggle('error', isError);
}

// How far the camera/orbit target have already been shifted for whichever
// level was last rendered — renderLevelControls applies only the
// *additional* delta each time, on top of the camera position/orbit
// target's own value (itself free to have moved via ordinary
// pinch/drag/scroll since), rather than resetting either outright and
// discarding wherever the builder was actually looking.
let lastAppliedLevelFloorZ = 0;

// Shared across addLevel (Build Level Above / Dig Level Below) and the
// Remove handler below — all three mutate currentLevelIndex/
// currentLandletLevels from an async server round-trip, and each handler
// used to disable only its own button while in flight, leaving the other
// two clickable. Two concurrent requests (e.g. Build then Dig before the
// first resolves) could each independently set currentLevelIndex from
// their own response, with whichever resolves second winning regardless
// of click order — UI-state confusion, not data corruption (the server's
// own depth/footprint/extent-consistency checks still protect that). Same
// single-flag-across-multiple-triggers idiom as undoRedoBusy below.
let levelActionBusy = false;

// Re-renders the nav/build/dig/remove controls from currentLevelIndex +
// currentLandletLevels, and moves the ground mesh to visually sit at
// whichever level's own floor is now being viewed — a plain vertical
// translation of the already-curved geometry (see curveGroundGeometry's own
// comment on why a rigid shift like this doesn't need to redo that curving
// work: at most a few dozen meters even after digging/building several
// levels, against Earth's ~6.371 million meter radius, the same
// "genuinely tiny at this scale" trade-off #135/#136 already accepted).
// levelBuildBtn/levelDigBtn always preview the cost of extending the
// lándlet's *true* top/bottom by one — not whichever level currentLevelIndex
// happens to be viewing — since that's what POSTing 'up'/'down' actually
// does server-side regardless of where the builder is currently looking.
export function renderLevelControls() {
  const { top, bottom } = levelExtent();
  currentLevelIndex = THREE.MathUtils.clamp(currentLevelIndex, bottom, top);
  levelLabelEl.textContent = levelLabel(currentLevelIndex);
  levelDownBtn.disabled = currentLevelIndex <= bottom;
  levelUpBtn.disabled = currentLevelIndex >= top;
  const upCostM2 = levelCapConsumedM2(currentLandletAreaM2, top + 1);
  const downCostM2 = levelCapConsumedM2(currentLandletAreaM2, bottom - 1);
  levelBuildBtn.textContent = `Build Level Above (${formatArea(upCostM2)})`;
  levelDigBtn.textContent = `Dig Level Below (${formatArea(downCostM2)})`;
  // Only the outermost existing level (in whichever direction it's on) can
  // actually be removed (worker/index.js's own 409 otherwise) — ground
  // (index 0) is never a real row and can never be removed at all.
  levelRemoveBtn.hidden = currentLevelIndex === 0;
  const floorZ = levelFloorZ(currentLevelIndex);
  landlet.position.z = floorZ;
  const cameraDeltaZ = floorZ - lastAppliedLevelFloorZ;
  if (cameraDeltaZ !== 0) {
    camera.position.z += cameraDeltaZ;
    controls.target.z += cameraDeltaZ;
    controls.update();
  }
  lastAppliedLevelFloorZ = floorZ;
}

function navigateToLevel(levelIndex) {
  const { top, bottom } = levelExtent();
  currentLevelIndex = THREE.MathUtils.clamp(levelIndex, bottom, top);
  setLevelStatus('');
  renderLevelControls();
}
levelDownBtn.addEventListener('click', () => navigateToLevel(currentLevelIndex - 1));
levelUpBtn.addEventListener('click', () => navigateToLevel(currentLevelIndex + 1));

function setLevelButtonsDisabled(disabled) {
  levelBuildBtn.disabled = disabled;
  levelDigBtn.disabled = disabled;
  levelRemoveBtn.disabled = disabled;
  // #1077: Up/Down were never part of this gate, so navigating to a
  // different level while a Build/Dig/Remove was still in flight let that
  // action's own completion handler (currentLevelIndex = ...;
  // renderLevelControls()) unconditionally snap the camera back to the
  // level it just created/removed, discarding the manual navigation with
  // no warning.
  levelUpBtn.disabled = disabled;
  levelDownBtn.disabled = disabled;
}

async function addLevel(direction, failureMessage) {
  if (levelActionBusy) return;
  levelActionBusy = true;
  setLevelButtonsDisabled(true);
  try {
    const level = await addLandletLevel(currentLandletId, direction);
    currentLandletLevels.push(level);
    currentLevelIndex = level.levelIndex;
    setLevelStatus('');
    renderLevelControls();
  } catch (err) {
    // A 409 here (the two hard limits — depth/10m² footprint — worker/
    // index.js's handleLandletLevels enforces) is expected, normal input
    // rejection, not a bug: surfaced inline exactly as the server phrased
    // it, same as every other builder-facing action's error handling here.
    setLevelStatus(err.message || failureMessage, { isError: true });
  } finally {
    levelActionBusy = false;
    setLevelButtonsDisabled(false);
  }
}
levelBuildBtn.addEventListener('click', () => addLevel('up', 'Could not build a new level.'));
levelDigBtn.addEventListener('click', () => addLevel('down', 'Could not dig a new level.'));

levelRemoveBtn.addEventListener('click', async () => {
  if (levelActionBusy) return;
  // #1077: this handler prunes swept instances out of productMeshes
  // (below, #901) after a real await, the same "mutates the shared array
  // across an await" shape #402/PR #413's shared gate exists to serialize
  // against Undo/Redo/Place/Paste/Trim-commit — missed here since the
  // pruning loop was added after that gate already existed on the other
  // paths. Without it, an Undo clicked while the delete request is still
  // in flight races restoreSnapshot() against this loop, both splicing
  // productMeshes, reproducing #402's orphaned-mesh failure.
  if (!beginSceneMutation()) return;
  levelActionBusy = true;
  setLevelButtonsDisabled(true);
  try {
    const sweptInstanceIds = await deleteLandletLevel(currentLandletId, currentLevelIndex);
    // #901: the server already deleted these instances (archiving them into
    // a saved layout first) — without pruning them here too, their meshes
    // stay selectable/draggable in the scene and can later get swept into
    // an undo snapshot or group move, failing an otherwise-unrelated sync.
    // #1078: a swept mesh may still be the one attached to the Move/Rotate/
    // Trim gizmo — drop it from selectedMeshes (mirroring restoreSnapshot's
    // own handling) and refresh the selection UI so the gizmo detaches
    // before the mesh leaves the scene graph, instead of being left
    // attached to an object TransformControls no longer considers valid.
    let selectionChanged = false;
    for (const instanceId of sweptInstanceIds || []) {
      const mesh = productMeshes.find((m) => m.userData.instanceId === instanceId);
      if (!mesh) continue;
      if (selectedMeshes.has(mesh)) {
        removeSelectionOutline(mesh);
        selectedMeshes.delete(mesh);
        selectionChanged = true;
      }
      deleteInstance(mesh, { sync: false });
    }
    if (selectionChanged) updateSelectionUI();
    currentLandletLevels = currentLandletLevels.filter((level) => level.levelIndex !== currentLevelIndex);
    currentLevelIndex += currentLevelIndex > 0 ? -1 : 1;
    setLevelStatus('');
    renderLevelControls();
  } catch (err) {
    setLevelStatus(err.message || 'Could not remove this level.', { isError: true });
  } finally {
    levelActionBusy = false;
    setLevelButtonsDisabled(false);
    endSceneMutation();
  }
});

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

// Set for the duration of any action with a real await gap that mutates
// productMeshes in place — restoreSnapshot's own mesh rebuilding plus batch
// create/update/delete calls, a trim commit's model reload, Paste, and
// tap-to-place. Originally scoped to just Undo/Redo (hence the name), but
// #402 found that restoreSnapshot racing any of Delete/Trim/Place/Paste —
// not just another Undo/Redo click — could orphan a mesh from
// productMeshes the same way #398's narrower Trim-vs-Delete fix did: any
// of those can start their own async mutation while restoreSnapshot (or
// another one of them) is still mid-flight, interleaving writes to the
// same shared productMeshes/selectedMeshes/undoStack/redoStack and firing
// overlapping batch requests, potentially for the same instance IDs.
// beginSceneMutation()/endSceneMutation() below are the shared gate every
// such entry point now goes through instead of touching this flag
// directly — see their own comment.
let sceneMutationBusy = false;

// Claims the mutation gate for an action with an async body that mutates
// productMeshes (a real await, not just a synchronous splice) — returns
// false without side effects if another such action is already in
// flight, so the caller can bail out exactly like Undo/Redo already did.
// Callers must release the gate via endSceneMutation() in a `finally`.
function beginSceneMutation() {
  if (sceneMutationBusy) return false;
  sceneMutationBusy = true;
  updateUndoRedoButtons();
  return true;
}

function endSceneMutation() {
  sceneMutationBusy = false;
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  undoBtn.disabled = sceneMutationBusy || undoStack.length === 0;
  redoBtn.disabled = sceneMutationBusy || redoStack.length === 0;
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
      // A null here means `mesh` was deleted by some other in-flight
      // action (e.g. a concurrent Delete) while this crop's model was
      // still loading — nothing left to restore state onto for this
      // instance, so skip it rather than crash on the null below.
      if (!mesh) continue;
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
      // Same reasoning as scale above: replaceMeshWithCrop only reconciles
      // crop, so it carries the mesh's own (pre-restore) flag values
      // forward rather than the snapshot's — a reused mesh needs these
      // explicitly re-applied too, or an undo/redo jump across a
      // Community Sign/Calendar flag change leaves the flag untouched.
      mesh.userData.isCommunitySign = inst.isCommunitySign ?? false;
      mesh.userData.isCommunityCalendar = inst.isCommunityCalendar ?? false;
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
  if (undoStack.length === 0 || !beginSceneMutation()) return;
  try {
    const previous = undoStack.pop();
    redoStack.push(captureSnapshot());
    await restoreSnapshot(previous);
  } finally {
    endSceneMutation();
  }
}

async function redo() {
  if (redoStack.length === 0 || !beginSceneMutation()) return;
  try {
    const next = redoStack.pop();
    undoStack.push(captureSnapshot());
    await restoreSnapshot(next);
  } finally {
    endSceneMutation();
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
export function updateTrimLengthInput() {
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
  // #1503: aria-pressed mirrors .active so the current tool is announced to
  // a screen reader, not just styled -- same idiom as updateSellerViewToggleUI
  // and updateModeNavUI's own toggle groups.
  modeMoveBtn.classList.toggle('active', mode === 'translate');
  modeMoveBtn.setAttribute('aria-pressed', String(mode === 'translate'));
  modeRotateBtn.classList.toggle('active', mode === 'rotate');
  modeRotateBtn.setAttribute('aria-pressed', String(mode === 'rotate'));
  modeTrimBtn.classList.toggle('active', mode === 'trim');
  modeTrimBtn.setAttribute('aria-pressed', String(mode === 'trim'));
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
export let measureMode = false;
export let measurePointA = null;
export let measurePointB = null;

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
export function updateMeasureResultText() {
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
  if (groundHits.length > 0) return flatGroundHitPoint(groundHits[0]);
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

export function handleMeasureClick() {
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
export let measureMarkerWasDragged = false;
export function setMeasureMarkerWasDragged(value) {
  measureMarkerWasDragged = value;
}

// Registered on window with capture, not as a plain listener on
// renderer.domElement — OrbitControls attaches its own pointerdown handler
// directly to that same element (in its constructor, long before this
// code runs), and two listeners on one element always fire in
// *registration* order regardless of capture/bubble (that distinction only
// applies between an element and its ancestors). Only a capture-phase
// listener on an ancestor is guaranteed to see the event, and be able to
// act on it (disabling rotate) before OrbitControls' own listener does —
// the same ordering problem, and the same fix, as the free-look wheel
// listener above.
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
  // Grabbing an endpoint is not a one-finger-rotate gesture, but it must
  // not block a *two*-finger pan/pinch either (#1593) — so this disables
  // only OrbitControls' own rotate, the same way multiSelectMode's own
  // swipe-to-select already does (see multiSelectBtn's handler), rather
  // than the old `controls.enabled = false` + stopPropagation, which shut
  // out every camera gesture for the whole drag. Deliberately NOT calling
  // stopPropagation here (or in the pointermove handler below): OrbitControls
  // needs to keep seeing this pointer's own down/move events to correctly
  // recognize a second finger landing as the start of a two-finger pan,
  // rather than miscounting it as a lone first touch.
  controls.enableRotate = false;
}, { capture: true });
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!draggingMeasureMarker) return;
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
  controls.enableRotate = true;
}
window.addEventListener('pointerup', endMeasureMarkerDrag);
window.addEventListener('pointercancel', endMeasureMarkerDrag);

// #1894: lets an e2e test force the exact "mid-drag, interrupted before
// pointerup" state exitMeasureMode's own defensive cleanup guards against,
// without needing to raycast a real hit on a marker's 3D hitbox (the
// position hitTestMeasureMarkerAt needs is impractical to target reliably
// from a test) -- same reasoning as window.__testDragGroupMoveZ and this
// file's other window.__test* hooks elsewhere.
window.__testStartMeasureMarkerDrag = () => {
  draggingMeasureMarker = 'A';
  controls.enableRotate = false;
};
window.__testControlsEnableRotate = () => controls.enableRotate;

// Multi-Select and Move/Rotate are sibling tools that can't both be active
// (see updateSelectionUI's multiSelectMode branch) — pressing either gizmo
// button while multi-select is on exits multi-select first, without
// touching the selection it just built, so "whatever's already selected"
// is exactly what ends up under the gizmo.
function exitMultiSelectMode() {
  if (!multiSelectMode) return;
  multiSelectMode = false;
  multiSelectBtn.classList.remove('active');
  multiSelectBtn.setAttribute('aria-pressed', 'false');
  controls.enableRotate = true;
  multiselectBrushControlEl.classList.remove('visible');
  multiselectBrushIndicatorEl.classList.remove('visible');
}
// Measure is its own sibling tool too — taps while it's on place ruler
// points rather than selecting or swiping, so switching to any selection-
// based tool exits it first (and clears whatever half-finished measurement
// was on screen), the same hand-off exitMultiSelectMode gives Move/Rotate.
function exitMeasureMode() {
  if (!measureMode) return;
  measureMode = false;
  measureBtn.classList.remove('active');
  measureBtn.setAttribute('aria-pressed', 'false');
  clearMeasurement();
  // Defensive, not expected in normal single-pointer use (releasing a drag
  // always fires pointerup first, which already restores this via
  // endMeasureMarkerDrag) — but leaving controls.enableRotate disabled if
  // this were ever reached mid-drag would strand one-finger camera rotate
  // with nothing left to re-enable it (#1894: this used to reset
  // controls.enabled, a stale leftover from the pre-#1593 approach the drag
  // handler itself no longer uses -- dragging only ever touches enableRotate,
  // per endMeasureMarkerDrag's own restore just above).
  if (draggingMeasureMarker) {
    draggingMeasureMarker = null;
    controls.enableRotate = true;
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
  input.addEventListener('change', () => {
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
    const instanceId = mesh.userData.instanceId;
    // #402's shared-gate fix for this exact race (a drag-start pushUndoSnapshot()
    // capturing productMeshes while another mutation is still mid-flight
    // rebuilding it) reached wireDraggingBehavior and trimControls' own
    // drag-start listener (#1295), but missed this typed-length alternative.
    if (!sceneMutationBusy) pushUndoSnapshot();
    queueTrimEdit(async () => {
      const current = productMeshes.find((m) => m.userData.instanceId === instanceId);
      if (!current) return; // deleted, or otherwise gone, since this edit was queued
      // #402: same shared-gate reasoning as the drag-release handler above.
      if (!beginSceneMutation()) return;
      try {
        const updated = await replaceMeshWithCrop(current, { ...current.userData.crop, [axis]: clampedLength });
        if (!updated) return; // deleted while this crop's model was loading
        const clamped = clampToLandlet(updated, updated.position.x, updated.position.y, updated.position.z);
        updated.position.set(clamped.x, clamped.y, clamped.z);
        updated.userData.safePosition = updated.position.clone();
        // Same stale-selection guard as the drag-release handler above — see
        // its own comment. The typed-value path awaits the same
        // replaceMeshWithCrop model rebuild, so the same race applies here.
        if (selectedMeshes.has(updated)) trimControls.attach(updated);
        persistLayout();
        syncUpdate(updated);
        updateTrimLengthInput();
      } finally {
        endSceneMutation();
      }
    });
  });
}

// Colliding with other products (see resolveByAxis above) is a helpful
// default, not a hard rule — a builder might genuinely want a sign embedded
// in a wall, or a rug overlapping a table leg. Snap starts on; toggling it
// off skips collision resolution entirely, letting the selected item
// overlap anything freely until it's switched back on.
snapToggleBtn.classList.add('active');
snapToggleBtn.setAttribute('aria-pressed', 'true');
snapToggleBtn.addEventListener('click', () => {
  snapToSurfaces = !snapToSurfaces;
  snapToggleBtn.classList.toggle('active', snapToSurfaces);
  snapToggleBtn.setAttribute('aria-pressed', String(snapToSurfaces));
});

export const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

// Selection is always a set, even for the common "just tapped one thing"
// case — multi-select mode (below) just changes how a tap modifies it
// (replace vs. add/remove) rather than needing two entirely separate
// selection systems. The move/rotate gizmos can only ever attach to one
// object, so they're only shown when the set holds exactly one.
export const selectedMeshes = new Set();
export let multiSelectMode = false;

// #1945: an adjustable-size brush, shown only while multi-select is on,
// lets a swipe sweep up every placed item within a screen-space radius of
// the cursor rather than requiring the drag to pass exactly over each one
// — the "mass-selecting bricks in a wall is difficult" ask. Screen-space
// pixels (not a 3D-world radius) so the brush's own on-screen size (the
// indicator below) always matches what it actually sweeps regardless of
// zoom/distance, and the slider's range is a fixed, predictable pixel
// scale rather than one that behaves differently depending on camera
// distance from the current selection.
const multiselectBrushControlEl = document.getElementById('multiselect-brush-control');
const multiselectBrushSizeInput = document.getElementById('multiselect-brush-size-input');
const multiselectBrushSizeLabelEl = document.getElementById('multiselect-brush-size-label');
const multiselectBrushIndicatorEl = document.getElementById('multiselect-brush-indicator');
let multiselectBrushRadiusPx = Number(multiselectBrushSizeInput.value);

function updateBrushIndicatorSize() {
  const diameter = multiselectBrushRadiusPx * 2;
  multiselectBrushIndicatorEl.style.width = `${diameter}px`;
  multiselectBrushIndicatorEl.style.height = `${diameter}px`;
}
updateBrushIndicatorSize();

multiselectBrushSizeInput.addEventListener('input', () => {
  multiselectBrushRadiusPx = Number(multiselectBrushSizeInput.value);
  multiselectBrushSizeLabelEl.textContent = `${multiselectBrushRadiusPx}px`;
  updateBrushIndicatorSize();
});

// Follows the cursor/finger across the canvas, visible the whole time
// multi-select is on (not just mid-drag) — like an image editor's own
// eraser/brush cursor, so the builder can see and judge the brush's reach
// before committing to a drag, not just discover it after the fact.
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!multiSelectMode) return;
  multiselectBrushIndicatorEl.classList.add('visible');
  multiselectBrushIndicatorEl.style.left = `${event.clientX}px`;
  multiselectBrushIndicatorEl.style.top = `${event.clientY}px`;
});
renderer.domElement.addEventListener('pointerleave', () => {
  multiselectBrushIndicatorEl.classList.remove('visible');
});

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

export function addSelectionOutline(mesh) {
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

export function removeSelectionOutline(mesh) {
  const entry = selectionOutlines.get(mesh);
  if (!entry) return;
  scene.remove(entry.helper);
  entry.helper.geometry.dispose();
  entry.helper.material.dispose();
  scene.remove(entry.fill);
  entry.fill.material.dispose();
  selectionOutlines.delete(mesh);
}

// #1950 (sub-issue of #1947): a second, independent highlight for placed
// items matching the active low-stock filter in Settings > Build --
// deliberately not reusing selectionOutlines above, since an item can be
// simultaneously selected AND low-stock-matching and the two states need
// to stack rather than collide. Same BoxHelper-plus-fill mechanism, for the
// same "works on any material, including unlit/baked builder-uploaded
// models" reasoning the comment above already explains -- just its own
// color (and its own Map) so the two never read as the same thing. Reuses
// selectionFillGeometry (a plain unit cube, rescaled per mesh below) rather
// than allocating a second identical buffer.
const LOW_STOCK_HIGHLIGHT_COLOR = 0xe08a1e;
const lowStockHighlights = new Map(); // mesh -> { helper: THREE.BoxHelper, fill: THREE.Mesh }

function addLowStockHighlight(mesh) {
  if (lowStockHighlights.has(mesh)) return;
  const helper = new THREE.BoxHelper(mesh, LOW_STOCK_HIGHLIGHT_COLOR);
  scene.add(helper);
  const fillMaterial = new THREE.MeshBasicMaterial({
    color: LOW_STOCK_HIGHLIGHT_COLOR,
    transparent: true,
    opacity: SELECTION_FILL_OPACITY,
    depthWrite: false,
  });
  const fill = new THREE.Mesh(selectionFillGeometry, fillMaterial);
  scene.add(fill);
  lowStockHighlights.set(mesh, { helper, fill });
}

export function removeLowStockHighlight(mesh) {
  const entry = lowStockHighlights.get(mesh);
  if (!entry) return;
  scene.remove(entry.helper);
  entry.helper.geometry.dispose();
  entry.helper.material.dispose();
  scene.remove(entry.fill);
  entry.fill.material.dispose();
  lowStockHighlights.delete(mesh);
}

// null = no active filter (nothing highlighted). Persisted at module scope
// (not just inside renderLowStockSection) so a freshly placed/undo-
// restored item picks up an already-active filter immediately via
// addInstanceToScene's own check below, and so the highlight survives
// closing the Settings modal entirely -- the whole point of #1950 is
// finding a matching item in the live 3D view without the list still open.
export let activeLowStockTemplateIds = null;
export function setActiveLowStockTemplateIds(value) {
  activeLowStockTemplateIds = value;
}
// Mirrors the currently-active filter thresholds so reopening Settings (or
// switching tabs and back) restores the same inputs instead of silently
// resetting to "Any" and clearing the highlight -- read back by
// renderLowStockSection's own input values above.
export let lowStockFilterMaxQty = null;
export let lowStockFilterMaxDays = null;
export function setLowStockFilterMaxQty(value) {
  lowStockFilterMaxQty = value;
}
export function setLowStockFilterMaxDays(value) {
  lowStockFilterMaxDays = value;
}

export function updateLowStockHighlights(templateIds) {
  activeLowStockTemplateIds = templateIds && templateIds.size > 0 ? templateIds : null;
  for (const mesh of productMeshes) {
    const matches = !!activeLowStockTemplateIds && activeLowStockTemplateIds.has(mesh.userData.template?.templateId);
    if (matches) addLowStockHighlight(mesh);
    else removeLowStockHighlight(mesh);
  }
}

// #1950: test-only hook (the window.__test* convention already used
// throughout this file for otherwise-unreachable 3D scene state, e.g.
// __testProductScreenPositions) -- exposes which currently-placed
// instances have the low-stock highlight applied right now.
window.__testLowStockHighlightedInstanceIds = () => [...lowStockHighlights.keys()].map((mesh) => mesh.userData.instanceId);

// #2342: the hook above reads instanceId off the Map's own mesh keys, so it
// can't by itself distinguish a correctly-tracked live mesh from a stale,
// already-disposed one left behind by a swap (e.g. replaceMeshWithCrop)
// that skipped transferring the highlight -- both report the same
// instanceId. This checks the *live* mesh for a given instanceId (the one
// actually in productMeshes right now) is the one lowStockHighlights
// tracks, and the total entry count, so a test can catch either failure
// mode: wrong mesh tracked, or an orphaned entry nothing ever cleans up.
window.__testLowStockHighlightTracksLiveMesh = (instanceId) => {
  const live = productMeshes.find((mesh) => mesh.userData.instanceId === instanceId);
  return !!live && lowStockHighlights.has(live);
};
window.__testLowStockHighlightCount = () => lowStockHighlights.size;

// #2068: grayed-out placeholder markers for sold-out items that used to be
// placed on this landlet. Unlike lowStockHighlights above (which decorates
// an EXISTING, still-live mesh), there's no live instance left to attach
// to here -- each marker gets its own standalone ghost box at its own
// recorded position instead, keyed by markerId rather than by mesh.
const SOLD_OUT_MARKER_COLOR = 0x888888;
const soldOutMarkerMeshes = new Map(); // markerId -> THREE.Mesh
// Build-mode-only state, same "nothing to show once the scene is torn
// down" reasoning activeLowStockTemplateIds' own comment gives -- reset
// alongside it at both of Build mode's own exits (enterShopMode/
// enterSellMode below) so re-entering Build later starts clean rather than
// silently reapplying a stale toggle with no meshes behind it yet.
export let showSoldOutMarkers = false;
export let soldOutMarkers = []; // the list renderSoldOutMarkersSection last fetched
export function setShowSoldOutMarkers(value) {
  showSoldOutMarkers = value;
}
export function setSoldOutMarkers(value) {
  soldOutMarkers = value;
}

function addSoldOutMarkerMesh(marker) {
  if (soldOutMarkerMeshes.has(marker.markerId)) return;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial({
    color: SOLD_OUT_MARKER_COLOR, transparent: true, opacity: 0.35, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  // marker.x/y/z is the sold-out item's own last-recorded, pre-elevation
  // position (same convention every live instance's own x/y/z already
  // uses) -- #2871: lives in landletElevationGroup so this ghost marker
  // rises/sinks with the real ground the same way a still-live instance
  // at that same spot would.
  mesh.position.set(marker.x, marker.y, marker.z || 0.5);
  mesh.userData.markerId = marker.markerId;
  landletElevationGroup.add(mesh);
  soldOutMarkerMeshes.set(marker.markerId, mesh);
}

export function removeSoldOutMarkerMesh(markerId) {
  const mesh = soldOutMarkerMeshes.get(markerId);
  if (!mesh) return;
  landletElevationGroup.remove(mesh);
  mesh.geometry.dispose();
  mesh.material.dispose();
  soldOutMarkerMeshes.delete(markerId);
}

export function clearSoldOutMarkerMeshes() {
  for (const markerId of [...soldOutMarkerMeshes.keys()]) removeSoldOutMarkerMesh(markerId);
}

// Reconciles the 3D scene with showSoldOutMarkers/soldOutMarkers -- called
// whenever either changes (the toggle flips, or a fresh list just loaded).
export function applySoldOutMarkerVisibility() {
  clearSoldOutMarkerMeshes();
  if (!showSoldOutMarkers) return;
  for (const marker of soldOutMarkers) addSoldOutMarkerMesh(marker);
}

// #2068: same window.__test* convention as __testLowStockHighlightedInstanceIds
// above -- exposes which sold-out markers are currently rendered as ghost
// boxes, for e2e coverage that can't otherwise inspect the 3D scene.
window.__testSoldOutMarkerMeshIds = () => [...soldOutMarkerMeshes.keys()];

// Reconciles every visible bit of "what's selected" UI (highlight already
// applied by the caller — this only handles text/panels/gizmo) with the
// current selectedMeshes set. Called after any change to that set.
export function updateSelectionUI() {
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
  // #1946 (owner correction): a builder selecting a test/demo model needs
  // the same "not a real product" disclosure a shopper gets from
  // productInfoText's own isTestModel note — this pill only ever shows a
  // bare name today (no price/metadata disclosures at all), so there's no
  // existing multi-note pattern to extend, just this one flag.
  let singleSelectionInfo = '';
  if (count === 1) {
    const template = [...selectedMeshes][0].userData.template;
    singleSelectionInfo = template.isTestModel ? `${template.name} (Testing Model — not a real product)` : template.name;
  }
  setProductInfo(count === 1 ? singleSelectionInfo : `${count} items selected`);
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
  const isCommunitySign = !!singleMesh?.userData.isCommunitySign;
  communitySignBtn.classList.toggle('active', isCommunitySign);
  communitySignBtn.setAttribute('aria-pressed', String(isCommunitySign));
  // Once flagged, this same button opens the Manage Posts panel instead of
  // un-flagging directly (see its own click handler) — the label makes
  // that click destination explicit rather than reading like a second
  // identical toggle.
  communitySignBtn.textContent = singleMesh?.userData.isCommunitySign ? 'Community Sign ✓ (Manage)' : 'Community Sign';
  // Community Calendar (docs/API.md's "Community calendar") — same
  // reasoning and same toggle-then-manage button design as Community Sign
  // just above, independent of it.
  communityCalendarBtn.disabled = !singleMesh;
  const isCommunityCalendar = !!singleMesh?.userData.isCommunityCalendar;
  communityCalendarBtn.classList.toggle('active', isCommunityCalendar);
  communityCalendarBtn.setAttribute('aria-pressed', String(isCommunityCalendar));
  communityCalendarBtn.textContent = singleMesh?.userData.isCommunityCalendar ? 'Community Calendar ✓ (Manage)' : 'Community Calendar';
  // Backup Chain (#2050/#2051): every placed instance can have one, not
  // just flagged ones, so this is a plain "open the manage panel" button —
  // same single-selection-only gating as Trim/Community Sign/Calendar
  // above, but no toggle/active state of its own to reflect.
  backupChainBtn.disabled = !singleMesh;
  // #2764: Group needs 2+ items to form anything; Ungroup needs the
  // selection to include at least one already-grouped item (every member
  // of that group is in the selection too, per selectOnly/toggleInSelection's
  // own expansion above, so this always targets a whole group).
  groupBtn.disabled = count < 2;
  ungroupBtn.disabled = ![...selectedMeshes].some((mesh) => mesh.userData.groupId);
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
    modeMoveBtn.setAttribute('aria-pressed', 'false');
    modeRotateBtn.classList.remove('active');
    modeRotateBtn.setAttribute('aria-pressed', 'false');
    modeTrimBtn.classList.remove('active');
    modeTrimBtn.setAttribute('aria-pressed', 'false');
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

export function clearSelection() {
  for (const mesh of selectedMeshes) removeSelectionOutline(mesh);
  selectedMeshes.clear();
}

// #2764: every other currently-loaded mesh sharing `mesh`'s own groupId
// (itself, included) — a plain [mesh] for an ungrouped item (groupId
// null), which lets selectOnly/toggleInSelection below call this
// unconditionally rather than branching on whether mesh is grouped at all.
// Looked up fresh on every call (not cached) since productMeshes/each
// mesh's own userData.groupId can change between selections (a Group/
// Ungroup action, or a different landlet's instances loading in).
function groupMembers(mesh) {
  if (!mesh.userData.groupId) return [mesh];
  return productMeshes.filter((other) => other.userData.groupId === mesh.userData.groupId);
}

// Single-select: replaces the whole selection with just this one item (or
// clears it, for `mesh === null`) — the ordinary tap-a-product behavior,
// used whether or not multi-select mode happens to be on (e.g. right after
// a fresh placement). #2764: when the tapped item is part of a persisted
// group, the whole group is selected together, not just the tapped item —
// selecting any one member selects/moves the whole group.
export function selectOnly(mesh) {
  const targetMeshes = mesh ? groupMembers(mesh) : [];
  if (selectedMeshes.size === targetMeshes.length && targetMeshes.every((m) => selectedMeshes.has(m))) return;
  clearSelection();
  for (const target of targetMeshes) {
    selectedMeshes.add(target);
    addSelectionOutline(target);
  }
  updateSelectionUI();
}

// Multi-select: adds or removes just this one item (and, #2764, every other
// member of its group, if it has one), leaving the rest of the selection
// alone. Expanding here too (not just in selectOnly above) keeps the
// invariant that the active selection is always a union of whole groups —
// without it, a builder could use multi-select to pick out a strict subset
// of an existing group, which Group (see its own worker-side comment)
// isn't designed to split cleanly.
export function toggleInSelection(mesh) {
  const members = groupMembers(mesh);
  const nowSelected = !selectedMeshes.has(mesh);
  for (const member of members) {
    if (nowSelected) {
      if (!selectedMeshes.has(member)) {
        selectedMeshes.add(member);
        addSelectionOutline(member);
      }
    } else if (selectedMeshes.has(member)) {
      selectedMeshes.delete(member);
      removeSelectionOutline(member);
    }
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
  multiSelectBtn.setAttribute('aria-pressed', String(multiSelectMode));
  multiselectBrushControlEl.classList.toggle('visible', multiSelectMode);
  if (!multiSelectMode) multiselectBrushIndicatorEl.classList.remove('visible');
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
  measureBtn.setAttribute('aria-pressed', String(measureMode));
  if (measureMode) {
    // Same swallowed-tap problem as enterPlacementMode's own exitMeasureMode
    // call above, reached from the other direction (#422): a placement
    // already pending (Add Item/Paste) when Measure turns on would
    // otherwise sit there un-cancelable, since the canvas click handler
    // always checks Measure first and swallows every tap into it.
    if (pendingPlacement) cancelPlacementMode();
    updateSelectionUI(); // hides the gizmo panel; see its own measureMode branch
    updateMeasureInfo();
  } else {
    clearMeasurement();
    updateSelectionUI();
  }
});

deleteBtn.addEventListener('click', () => {
  // #402: bail out (rather than mutate productMeshes) while another
  // mutating action (Undo/Redo, a trim commit, Paste, tap-to-place) is
  // still mid-flight — this handler is otherwise fully synchronous, so it
  // never needs to *hold* the gate itself, only check it.
  if (selectedMeshes.size === 0 || sceneMutationBusy) return;
  pushUndoSnapshot();
  const meshes = [...selectedMeshes];
  const instanceIds = meshes.map((mesh) => mesh.userData.instanceId);
  clearSelection();
  updateSelectionUI();
  for (const mesh of meshes) deleteInstance(mesh, { sync: false });
  syncBatchDelete(instanceIds);
});

// #2764: Group/Ungroup aren't wired into Undo/Redo (unlike Delete above) —
// captureSnapshot/restoreSnapshot round-trip position/rotation/crop/scale,
// not arbitrary userData, and teaching them to also carry groupId is more
// than this leaf's own scope ("core schema + actions") asks for. Left as a
// follow-up for whoever revisits this, same as #2763's other explicitly
// open owner-judgment items.
// Feedback is the same brief press-flash copyBtn's own handler uses (see
// its comment), not a delayed setProductInfo message like Save Bundle's —
// unlike Copy, forming/dissolving a group is a real persisted state change
// that Ungroup/Group's own enabled state needs to reflect the instant it
// lands, so updateSelectionUI() runs synchronously right after, not behind
// a setTimeout that would leave the toolbar briefly out of sync with what
// just happened.
groupBtn.addEventListener('click', async () => {
  if (selectedMeshes.size < 2 || sceneMutationBusy) return;
  const meshes = [...selectedMeshes];
  const instanceIds = meshes.map((mesh) => mesh.userData.instanceId);
  groupBtn.disabled = true;
  try {
    const { groupId } = await groupInstancesRemote(instanceIds);
    for (const mesh of meshes) mesh.userData.groupId = groupId;
    groupBtn.classList.add('pressed');
    setTimeout(() => groupBtn.classList.remove('pressed'), 150);
  } catch (err) {
    console.error('Could not group selection:', err);
    setProductInfo(err.message || 'Could not group selection.');
  } finally {
    updateSelectionUI();
  }
});

ungroupBtn.addEventListener('click', async () => {
  const groupedMesh = [...selectedMeshes].find((mesh) => mesh.userData.groupId);
  if (!groupedMesh || sceneMutationBusy) return;
  const groupId = groupedMesh.userData.groupId;
  ungroupBtn.disabled = true;
  try {
    const { ungroupedInstanceIds } = await ungroupInstancesRemote(groupId);
    const ungroupedSet = new Set(ungroupedInstanceIds);
    for (const mesh of productMeshes) {
      if (mesh.userData.groupId === groupId && ungroupedSet.has(mesh.userData.instanceId)) {
        mesh.userData.groupId = null;
      }
    }
    ungroupBtn.classList.add('pressed');
    setTimeout(() => ungroupBtn.classList.remove('pressed'), 150);
  } catch (err) {
    console.error('Could not ungroup selection:', err);
    setProductInfo(err.message || 'Could not ungroup selection.');
  } finally {
    updateSelectionUI();
  }
});

// Each selected item's position/rotation *relative* to the group — offset
// from the group's centroid in X/Y, and height above the group's lowest
// bottom surface in Z (its "base") — rather than absolute coordinates, so
// the result can be re-anchored wherever a builder taps next (see
// handlePlacementClick/placeClipboardItems). Shared by Copy (kept in the
// in-memory clipboard for this session only) and Save Bundle (persisted to
// the backend so it survives a reload and works on any landlet) — both
// just want "this exact arrangement, portable."
export function relativeItemsForMeshes(meshes) {
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

// Placement-pending state: set by tapping a catalog item, the upload
// flow's freshly-created product, or Paste — none of those place anything
// immediately anymore. The next world tap (see the click handler below)
// consumes this and does the actual placing.
export let pendingPlacement = null;

export function enterPlacementMode(pending, statusText) {
  clearSelection();
  // Multi-select repurposes a one-finger drag into a selection swipe (see
  // the swipe-select handlers below) instead of orbiting the camera —
  // useful while building a selection, but there's nothing left to select
  // during placement (the pending items are already captured), so leaving
  // it on would just strand the builder without the ability to rotate the
  // view while lining up where to place/paste.
  exitMultiSelectMode();
  // Measure repurposes a world tap into placing/moving a ruler point (see
  // exitMeasureMode's own comment) instead of placing the pending item —
  // nothing stops it from still being on when a placement flow starts, and
  // when both are active the canvas click handler always checks Measure
  // first, silently swallowing every placement tap until Measure is
  // toggled off (#422). Exiting it here, the same way exitMultiSelectMode
  // already is, keeps entering a placement flow a clean hand-off away from
  // every other tap-driven tool.
  exitMeasureMode();
  modeControlsEl.classList.remove('visible');
  translateControls.detach();
  rotateControls.detach();
  pendingPlacement = pending;
  setProductInfo(statusText);
  addItemBtn.textContent = '✕ Cancel';
}

export function cancelPlacementMode() {
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
  closeCatalogPicker();
  // Something's already selected — paste right there instead of making the
  // builder tap a second time to say where, the same way pasting next to
  // what you just copied would work in any other editor.
  const anchor = selectionPlacementAnchor();
  if (anchor) {
    // #402: placeClipboardItems has a real await per item, so (unlike
    // deleteBtn's fully-synchronous handler above) this needs to hold the
    // gate for that whole span, not just check it once up front.
    if (!beginSceneMutation()) return;
    try {
      exitMultiSelectMode();
      pushUndoSnapshot();
      await placeClipboardItems(clipboard, anchor.x, anchor.y, anchor.supportZ);
    } finally {
      endSceneMutation();
    }
    return;
  }
  const count = clipboard.length;
  enterPlacementMode({ type: 'clipboard', items: clipboard }, `Tap a spot to paste ${count} item${count === 1 ? '' : 's'}`);
});

// A raycast hit against a model's nested mesh (see loadModelInstance)
// returns that inner mesh, not the top-level product Object3D tracked in
// productMeshes — walk back up the parent chain to find it.
export function findRootProduct(object) {
  let current = object;
  while (current && !productMeshes.includes(current)) {
    current = current.parent;
  }
  return current;
}

export function ndcFromEvent(event) {
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
export const CLICK_DRAG_THRESHOLD_PX = 8;
export let pointerDownPos = null;

renderer.domElement.addEventListener('pointerdown', (event) => {
  pointerDownPos = { x: event.clientX, y: event.clientY };
});

// Spawns a copied group anchored at (x, y, supportZ) — shared by both ways
// a paste can be anchored: tapping a spot in the world (handlePlacementClick)
// and pasting directly at whatever's already selected (see pasteBtn above).
// Caller is responsible for pushUndoSnapshot() beforehand, since the
// tap-a-spot flow shares that snapshot with the template-placement branch
// alongside it.
// #2766: `group` defaults newly-placed items to a persisted group (#2764)
// right after they land -- only passed true from the catalog picker's bundle
// "place" button (via enterPlacementMode's own `group` field, threaded
// through handlePlacementClick below), never from pasteBtn's ordinary
// clipboard paste, which should keep placing an ad-hoc copied selection as
// independent items like it always has.
async function placeClipboardItems(items, x, y, supportZ, { group = false } = {}) {
  const placed = [];
  // #469: a saved bundle can outlive the catalog templates its items point
  // at (deleting a template only checks for currently-*placed* instances,
  // not a bundle's own items_json), so findTemplate returning null here is
  // a real, reachable case, not just defensive coding — silently
  // `continue`-ing past it made placing such a bundle either drop pieces
  // with zero indication, or (if every item was affected) look completely
  // indistinguishable from tapping empty sky. Counted and surfaced below
  // instead, the same way syncBatchCreate already surfaces its own
  // failures for this exact call site.
  let skippedCount = 0;
  for (const item of items) {
    const template = findTemplate(item.templateId);
    if (!template) { skippedCount += 1; continue; }
    const mesh = await spawnInstanceAt(template, x + item.dx, y + item.dy, supportZ + item.dz, {
      rotationX: item.rotationX,
      rotationY: item.rotationY,
      rotationZ: item.rotationZ,
      crop: item.crop,
      scale: item.scale,
    }, { sync: false, clamp: false });
    if (mesh) placed.push(mesh);
  }
  // #903: clamp the whole placed group with one shared offset instead of
  // each item independently — an independent per-item clamp (what used to
  // happen here via spawnInstanceAt's own clamp) lets an item near a
  // landlet boundary get pushed in while others just inside stay put,
  // squishing the group's saved relative arrangement out of shape. Same
  // technique (per-item bounds intersected into one [min, max] per axis,
  // one shared offset applied to everyone) the group-move handler already
  // uses for the identical problem — see its own "group-squish" comment,
  // groupMovePivot's objectChange listener above.
  if (placed.length > 0) {
    const floorZ = levelFloorZ(currentLevelIndex);
    const ceilingZ = floorZ + LANDLET_HEIGHT_M;
    let minOffsetX = -Infinity, maxOffsetX = Infinity;
    let minOffsetY = -Infinity, maxOffsetY = Infinity;
    let minOffsetZ = -Infinity, maxOffsetZ = Infinity;
    for (const mesh of placed) {
      const { width, depth, height } = meshDimensions(mesh);
      const halfSpanX = LANDLET_SIDE_M / 2 - width / 2;
      const halfSpanY = LANDLET_SIDE_M / 2 - depth / 2;
      minOffsetX = Math.max(minOffsetX, -halfSpanX - mesh.position.x);
      maxOffsetX = Math.min(maxOffsetX, halfSpanX - mesh.position.x);
      minOffsetY = Math.max(minOffsetY, -halfSpanY - mesh.position.y);
      maxOffsetY = Math.min(maxOffsetY, halfSpanY - mesh.position.y);
      minOffsetZ = Math.max(minOffsetZ, floorZ + height / 2 - mesh.position.z);
      maxOffsetZ = Math.min(maxOffsetZ, ceilingZ - height / 2 - mesh.position.z);
    }
    const offsetX = THREE.MathUtils.clamp(0, minOffsetX, maxOffsetX);
    const offsetY = THREE.MathUtils.clamp(0, minOffsetY, maxOffsetY);
    const offsetZ = THREE.MathUtils.clamp(0, minOffsetZ, maxOffsetZ);
    for (const mesh of placed) {
      mesh.position.x += offsetX;
      mesh.position.y += offsetY;
      mesh.position.z += offsetZ;
      mesh.userData.safePosition = mesh.position.clone();
    }
    persistLayout();
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
  // Only after syncBatchCreate resolves -- POST /instances/group 404s unless
  // every instanceId already exists in placed_instances server-side, and
  // grouping a single surviving item (e.g. the rest were skippedCount above)
  // isn't meaningful either. A failure here (syncBatchCreate's own partial
  // failure left some member unsaved, or a landlet-ownership race) is a
  // "didn't get the default grouping" miss, not a reason to break placement
  // itself or pile a second alert on top of syncBatchCreate's own.
  if (group && placed.length >= 2) {
    try {
      const { groupId } = await groupInstancesRemote(placed.map((mesh) => mesh.userData.instanceId));
      for (const mesh of placed) mesh.userData.groupId = groupId;
      // The toolbar's Ungroup-enabled state was already computed by the
      // updateSelectionUI() call above, before groupId existed on any of
      // these meshes -- recompute now that it does, same as groupBtn's own
      // click handler calling this again right after setting userData.groupId.
      updateSelectionUI();
    } catch (err) {
      console.warn('Could not default the placed bundle to grouped:', err);
    }
  }
  if (skippedCount > 0) {
    alert(`${skippedCount} item${skippedCount === 1 ? '' : 's'} couldn't be placed — the product ${skippedCount === 1 ? 'it references' : 'they reference'} no longer exists in the catalog.`);
  }
}

// Places whatever's pending (a fresh catalog template, or a copied group)
// at wherever was just tapped — the ground, or directly on top of another
// product if that's what the raycast actually hit, so tapping a tabletop
// rests the new item there instead of on the ground beneath it.
export async function handlePlacementClick() {
  // #402: leave pendingPlacement untouched (rather than silently
  // consuming the tap) while another mutating action is mid-flight, so
  // the builder's pending placement survives for a retry tap once it
  // clears — checked before claiming the gate below since spawnInstanceAt/
  // placeClipboardItems both have a real await per item.
  if (sceneMutationBusy) return;
  const productHits = raycaster.intersectObjects(productMeshes, true);
  const groundHits = raycaster.intersectObject(landlet);

  let point;
  let supportingMesh = null;
  if (productHits.length > 0 && (groundHits.length === 0 || productHits[0].distance < groundHits[0].distance)) {
    point = productHits[0].point;
    supportingMesh = findRootProduct(productHits[0].object);
  } else if (groundHits.length > 0) {
    point = flatGroundHitPoint(groundHits[0]);
  } else {
    return; // tapped empty sky — nothing to place onto, leave placement pending
  }

  // issue #169: tapping bare ground (no supporting product beneath the
  // click) places onto whichever level's own floor is currently being
  // viewed/edited, not always ground's z=0.
  const supportZ = supportingMesh
    ? supportingMesh.position.z + meshDimensions(supportingMesh).height / 2
    : levelFloorZ(currentLevelIndex);

  const pending = pendingPlacement;
  if (!beginSceneMutation()) return;
  pendingPlacement = null;
  addItemBtn.textContent = '+ Add Item';
  pushUndoSnapshot();
  try {
    if (pending.type === 'template') {
      const mesh = await spawnInstanceAt(pending.template, point.x, point.y, supportZ + pending.template.dimensions.height / 2);
      selectOnly(mesh);
    } else {
      await placeClipboardItems(pending.items, point.x, point.y, supportZ, { group: pending.group });
    }
  } finally {
    endSceneMutation();
  }
}


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

// #1945: screen-space distance from each candidate's own projected
// position, rather than a real raycast against its geometry (the
// alternative the issue itself flags as an open, non-blocking
// implementation choice) — this runs over every placed item on every
// pointermove while a swipe is live, so the cheaper test matters, and an
// item showing its highlight once any part of the brush circle nears its
// own placement point is exactly the mass-selection behavior being asked
// for here.
const brushScratchVec = new THREE.Vector3();
// Null for something behind the camera, whose projected x/y would
// otherwise alias onto some unrelated on-screen pixel.
function projectMeshToScreen(mesh) {
  brushScratchVec.copy(mesh.position).project(camera);
  if (brushScratchVec.z < -1 || brushScratchVec.z > 1) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  return {
    x: rect.left + (brushScratchVec.x * 0.5 + 0.5) * rect.width,
    y: rect.top + (-brushScratchVec.y * 0.5 + 0.5) * rect.height,
  };
}

function addEverythingInBrushAtClientPos(x, y) {
  const radiusSq = multiselectBrushRadiusPx * multiselectBrushRadiusPx;
  for (const mesh of productMeshes) {
    if (selectedMeshes.has(mesh)) continue;
    const screenPos = projectMeshToScreen(mesh);
    if (!screenPos) continue;
    const dx = screenPos.x - x;
    const dy = screenPos.y - y;
    if (dx * dx + dy * dy <= radiusSq) addToSelectionBySwipe(mesh);
  }
}

// #1945: lets a test read back each placed item's own real current
// screen-space position (the same projection addEverythingInBrushAtClientPos
// uses to decide what a brush drag sweeps up) rather than assuming it
// coincides with wherever it was originally clicked to place — a tall
// model's own footprint renders well above its flat ground-click point
// once the camera's perspective is applied (see handlePlacementClick and
// e2e/bundles.test.mjs's own note on the same effect), so a test needs the
// real value, not the click coordinates, to build a reliable brush-radius
// assertion. Same "inert unless a test calls it" convention as this file's
// other window.__test* hooks.
window.__testProductScreenPositions = () => productMeshes.map((mesh) => ({
  instanceId: mesh.userData.instanceId,
  ...projectMeshToScreen(mesh),
}));

// #2871: lets a test confirm every placed product's own elevationM lift
// (landletElevationGroup.position.z, read here directly since that's the
// exact same value applyLandletShape also bakes into the ground mesh's
// own geometry -- see that group's own declaration comment) actually
// reaches world space: worldZ for a product should equal its own
// (landletElevationGroup-local) position.z plus the group's own offset,
// not just the local value alone. Same window.__test* convention as this
// file's other hooks, inert unless a test calls it.
window.__testLandletElevationWorldZ = () => ({
  elevationGroupZ: landletElevationGroup.position.z,
  products: productMeshes.map((mesh) => {
    const worldPos = new THREE.Vector3();
    mesh.getWorldPosition(worldPos);
    return { instanceId: mesh.userData.instanceId, localZ: mesh.position.z, worldZ: worldPos.z };
  }),
});

window.addEventListener('pointermove', (event) => {
  if (event.pointerId !== swipePointerId || !swipeStartPos) return;
  if (translateControls.dragging || rotateControls.dragging) return;
  const dx = event.clientX - swipeStartPos.x;
  const dy = event.clientY - swipeStartPos.y;
  if (!swipeArmed) {
    if (Math.hypot(dx, dy) <= CLICK_DRAG_THRESHOLD_PX) return;
    swipeArmed = true;
    // A real swipe starts by touching down near an item — without this,
    // whatever was already under/near the brush before crossing the
    // tap-vs-drag threshold above never gets a chance to be swept at all
    // and silently drops out of the swipe, which is exactly wrong for
    // closely-packed items like a course of bricks where the threshold
    // alone can already cover the gap to the *next* one.
    addEverythingInBrushAtClientPos(swipeStartPos.x, swipeStartPos.y);
  }
  addEverythingInBrushAtClientPos(event.clientX, event.clientY);
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
// src/build/layoutPreview.js (#2561) needs to resync this on its own
// one-time camera jump (see that module's own comment) — an ES import
// binding is read-only from its side, so it goes through this setter
// rather than a direct assignment.
export function setLastKnownDistance(value) {
  lastKnownDistance = value;
}

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

// #2552: Build mode (and layout-preview, which shares this same camera/
// selection-adjacent machinery) registers this once on entry via
// registerModeFrameUpdate (world/scene.js) — see that module's own
// comment for why a single registered callback replaced animate()'s old
// `if (shopActive) {...} else {...}` branch. Shop mode registers its own
// movement+sky callback instead (see enterShopMode); Sell mode has no
// per-frame work of its own (paginated, static between page turns) and
// registers null (see enterSellMode).
export function buildModeFrameUpdate(now) {
  updateTargetTween(now);
  applyEdgePanWhileDraggingProduct();
  controls.update();
  updateCameraDebug(now);
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
  // #1950: same "recomputed every frame, not just on change" reasoning as
  // selectionOutlines just above -- a highlighted item being dragged by the
  // gizmo (it can be selected and low-stock-matching at once) needs its
  // highlight to track it live too.
  for (const [mesh, { helper, fill }] of lowStockHighlights) {
    helper.update();
    scratchBox.setFromObject(mesh);
    scratchBox.getSize(scratchBoxSize);
    scratchBox.getCenter(scratchBoxCenter);
    fill.scale.copy(scratchBoxSize).multiplyScalar(SELECTION_FILL_PADDING);
    fill.position.copy(scratchBoxCenter);
  }
}

// Which landlet this session builds on: a builder's own claimed landlet if
// they already have one, otherwise a modal letting them claim a fresh one
// from whatever's currently available. Landlets start as `greenbelt`
// (claimable) once procedurally generated and enclosed by the growing world
// circle — see docs/API.md's world/landlet sections. If the backend is
// unreachable, this throws and bootstrap()'s own fallback below takes over
// before the modal is ever shown, same as it always has for catalog/instance
// fetches — there's nothing to claim in offline/local-fallback mode.
export async function resolveLandletId() {
  // #1150: "My Lands" (a builder can own more than one claimed landlet —
  // auctions can transfer extra ones in, see ownedLandletsByBuilderId's own
  // comment in worker/index.js) sets this to jump straight to a specific
  // one rather than always landing on whichever this plain `limit: 1`
  // query happens to return first.
  const targetLandletId = sessionStorage.getItem(BUILD_TARGET_LANDLET_ID_KEY);
  sessionStorage.removeItem(BUILD_TARGET_LANDLET_ID_KEY);
  if (targetLandletId) return targetLandletId;
  const owned = await fetchLandlets({ status: 'claimed', ownerBuilderId: builderId, limit: 1 });
  if (owned.length > 0) return owned[0].landletId;
  return runClaimFlow();
}

