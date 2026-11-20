// #3929 (follows #3902, #3403): level of detail in Build mode.
//
// Build drew every placement of the builder's own lándlet from its full model, every frame: a wall of
// 1,650 bricks of 5,120 triangles was about 1,350 draw calls and 6.4 million triangles standing still
// (8.5 million orbiting), where Shop had already been bounded by apparent size and a triangle budget
// (src/shop/lodTier.js). This runs the same rule over Build's items, so "Everything built is always
// shown as itself: simplified with distance, never replaced by a stand-in and never left out" holds
// where the builder works too.
//
// What differs from Shop, on purpose:
//   - Items are protected (always their real model, outside the budget) when they are selected, or
//     within NEAR_FULL_DETAIL_M of the point the orbit camera looks at, which is where the builder is
//     working; Shop protects the neighbourhood of the avatar.
//   - An item is one Object3D that stays the item's identity (selection, the gizmos, undo): its mid and
//     far versions are hidden children (attachInstanceTiers), and the one shown is the only one a tap
//     can hit (setInstanceLodState keeps hit-testability in step with visibility). A tap on a far item
//     therefore selects it by the version that is drawn, and the moment it is selected it is protected,
//     so the next tick (a quarter of a second) draws it in full.
//   - No cross-fade and no bundle sets yet: a flip is an instant swap.
//   - The pass runs on a quarter-second tick inside the frame loop, and its work (attaching versions,
//     flipping items) stops when its slice of a frame is spent (#3396); what it did not reach waits for
//     the next tick, and the biggest on screen go first.
import * as THREE from 'three';
import {
  apparentSizePx, nextTier, budgetedTiers, isNearFullDetail, TIER_FULL, largestFirst,
  MAX_FULL_DETAIL_TRIANGLES, countModelTriangles, holdBackUnready,
} from '../shop/lodTier.js';
import { attachInstanceTiers, setInstanceLodState, loadTierScenes, extensibleAxes, meshDimensions } from '../world/models.js';

export const BUILD_LOD_INTERVAL_MS = 250;
export const BUILD_LOD_SLICE_MS = 4; // the part of a frame one tick's attaching and flipping may use
// #4003: items whose versions have not attached yet are drawn from their full model, so on a heavy
// lándlet the way in drew up to 8.4 million triangles in a frame. Those beyond this many triangles
// (nearest first, and an item already drawn stays drawn) wait, undrawn, until their versions attach
// and then arrive in the version they should be in; a wait never lasts longer than HOLD_MAX_MS.
export const BUILD_HOLD_BACK_TRIANGLES = MAX_FULL_DETAIL_TRIANGLES;
export const BUILD_HOLD_MAX_MS = 20000;

const scratchPosition = new THREE.Vector3();

// A placed model that is not cropped to a per-placement shape has versions to switch between (a box
// fallback or flooring has no loaded model container).
function hasLodTiers(object) {
  return Boolean(object.userData.model) && !extensibleAxes(object.userData.template);
}

function radiusOf(object) {
  let radiusM = object.userData.lodRadiusM;
  if (radiusM === undefined) {
    const { width, depth, height } = meshDimensions(object);
    radiusM = 0.5 * Math.hypot(width, depth, height);
    object.userData.lodRadiusM = radiusM;
  }
  return radiusM;
}

function fullTrianglesOf(object) {
  let triangles = object.userData.lodFullTris;
  if (triangles === undefined) {
    triangles = countModelTriangles(object, new Set(Object.values(object.userData.lodTiers ?? {})));
    object.userData.lodFullTris = triangles;
  }
  return triangles;
}

// getMeshes(): the placed items. isSelected(mesh): whether the builder has it selected. target: the
// orbit camera's look-at point (world space). Returns { update(now, force), counts() }.
// onTicked(objects): called at the end of every pass with the items it considered, after any version
// flips, so what draws them (src/build/batching.js) is brought in step in the same synchronous step.
export function createBuildLod({ camera, target, getMeshes, isSelected, onTicked = null, viewportHeight = () => window.innerHeight }) {
  let lastTickMs = -Infinity;
  let fullTriangleCap = MAX_FULL_DETAIL_TRIANGLES;
  let protectNear = true; // e2e-only switch: false leaves only the selected items protected
  const items = [];
  const objects = [];
  const flips = [];
  const attachQueue = [];

  function requestTiers(object) {
    object.userData.lodTiersState = 'loading';
    loadTierScenes(object.userData.template).then((scenes) => {
      if (!object.parent) { object.userData.lodTiersState = 'none'; return; }
      object.userData.lodScenes = scenes;
      object.userData.lodTiersState = 'loaded';
      attachQueue.push(object);
      scheduleDrain();
    });
  }

  // The queue drains on its own short timeouts, not on frame ticks: a slow frame (a phone drawing a
  // heavy lándlet, or software GL) would otherwise leave it a few items per second, and the frames only
  // get cheap once the versions are attached. Each slice is BUILD_LOD_SLICE_MS, so nothing holds the
  // main thread (#3396).
  let drainScheduled = false;
  function scheduleDrain() {
    if (drainScheduled || attachQueue.length === 0) return;
    drainScheduled = true;
    setTimeout(() => {
      drainScheduled = false;
      drainAttachQueue(performance.now());
      scheduleDrain();
    }, 0);
  }

  // Nearest first: what the builder looks at gets its simpler versions (and so leaves the wait) first.
  function drainAttachQueue(startMs) {
    if (attachQueue.length > 1) attachQueue.sort((a, b) => (a.userData.lodDistM ?? Infinity) - (b.userData.lodDistM ?? Infinity));
    while (attachQueue.length > 0 && performance.now() - startMs < BUILD_LOD_SLICE_MS) {
      const object = attachQueue.shift();
      const scenes = object.userData.lodScenes;
      object.userData.lodScenes = undefined;
      if (!object.parent) { object.userData.lodTiersState = 'none'; continue; }
      object.userData.lodTiersState = attachInstanceTiers(object, scenes) ? 'ready' : 'none';
    }
  }

  // #4003: what has no versions yet and does not fit the triangle budget is not drawn until they are
  // there. A held item is unready, unprotected and has never been drawn; everything else draws.
  function applyHoldBack(list, listItems, nowMs) {
    const candidates = [];
    list.forEach((object, i) => {
      const data = object.userData;
      const waiting = data.lodTiersState !== 'ready' && data.lodTiersState !== 'none';
      if (!waiting) { setHeld(object, false); return; }
      // A protected item (selected, or where the builder works) is always drawn, but its triangles
      // still count against the budget, so what is held back is what is left after them.
      if (listItems[i].protected) { setHeld(object, false); candidates.push(i); return; }
      if (data.lodHeldSinceMs !== undefined && nowMs - data.lodHeldSinceMs > BUILD_HOLD_MAX_MS) { data.lodDrawnWaiting = true; setHeld(object, false); return; }
      candidates.push(i);
    });
    const flags = holdBackUnready(candidates.map((i) => ({
      tris: listItems[i].tris, dist: listItems[i].dist, sticky: listItems[i].protected || list[i].userData.lodDrawnWaiting === true,
    })), BUILD_HOLD_BACK_TRIANGLES);
    candidates.forEach((i, k) => {
      const object = list[i];
      if (listItems[i].protected) return;
      if (flags[k]) {
        if (object.userData.lodHeldSinceMs === undefined) object.userData.lodHeldSinceMs = nowMs;
        setHeld(object, true);
        // The versions of a held item must be on their way, whichever tier it will end up in.
        if (object.userData.lodTiersState === undefined) requestTiers(object);
      } else {
        object.userData.lodDrawnWaiting = true;
        setHeld(object, false);
      }
    });
  }

  function setHeld(object, held) {
    const data = object.userData;
    if (data.lodHeld === held || (!held && !data.lodHeld)) return;
    data.lodHeld = held;
    if (data.model) data.model.visible = !held;
  }

  function update(now = performance.now(), force = false) {
    if (!force && now - lastTickMs < BUILD_LOD_INTERVAL_MS) return;
    lastTickMs = now;
    const startMs = performance.now();
    drainAttachQueue(startMs);
    items.length = 0;
    objects.length = 0;
    const height = viewportHeight();
    for (const object of getMeshes()) {
      if (!hasLodTiers(object) || !object.parent) continue;
      scratchPosition.setFromMatrixPosition(object.matrixWorld);
      const px = apparentSizePx(radiusOf(object), scratchPosition.distanceTo(camera.position), camera.fov, height);
      const groundDistanceM = Math.hypot(scratchPosition.x - target.x, scratchPosition.y - target.y);
      const near = isNearFullDetail(groundDistanceM, object.userData.lodNear === true);
      object.userData.lodNear = near;
      object.userData.lodDistM = groundDistanceM;
      const protectedItem = (protectNear && near) || isSelected(object);
      object.userData.lodProtected = protectedItem; // read by src/build/batching.js: protected items are never batched
      items.push({
        px,
        protected: protectedItem,
        wanted: protectedItem ? TIER_FULL : nextTier(object.userData.lodTier, px),
        tris: fullTrianglesOf(object),
        dist: groundDistanceM,
        current: object.userData.lodApplied ?? TIER_FULL,
      });
      objects.push(object);
    }
    const tiers = budgetedTiers(items, undefined, undefined, fullTriangleCap);
    applyHoldBack(objects, items, now);
    flips.length = 0;
    for (let i = 0; i < objects.length; i++) {
      const object = objects[i];
      const tier = tiers[i];
      object.userData.lodTier = tier;
      if (tier !== TIER_FULL && object.userData.lodTiersState === undefined) requestTiers(object);
      if (object.userData.lodTiersState !== 'ready' || tier === (object.userData.lodApplied ?? TIER_FULL)) continue;
      flips.push(i);
    }
    for (const i of largestFirst(flips, items)) {
      const object = objects[i];
      object.userData.lodApplied = tiers[i];
      setInstanceLodState(object, tiers[i]);
      window.__buildLodFlipCount = (window.__buildLodFlipCount ?? 0) + 1; // e2e counts tier changes
      if (performance.now() - startMs > BUILD_LOD_SLICE_MS * 2) break;
    }
    onTicked?.(objects);
  }

  // How many items are drawn in each version now (only items that have versions attached).
  function counts() {
    const out = { full: 0, mid: 0, far: 0, withoutVersions: 0, held: 0 };
    for (const object of getMeshes()) {
      if (object.userData.lodHeld) out.held += 1;
      if (object.userData.lodTiersState !== 'ready') { out.withoutVersions += 1; continue; }
      out[object.userData.lodApplied ?? TIER_FULL] += 1;
    }
    return out;
  }

  return {
    update,
    counts,
    setFullTriangleCap(triangles) { fullTriangleCap = triangles ?? MAX_FULL_DETAIL_TRIANGLES; },
    setProtectNear(on) { protectNear = on !== false; },
  };
}
