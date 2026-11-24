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
//   - A bundle, and loose items that stand together (a wall the builder never bundled), are one set and
//     change version as one, from the set's size on screen, exactly as in Shop (src/shop/lodSets.js; #4115): without it each brick chose by its own
//     distance from the camera, and a wall was cut by an edge between two versions that swept across it as
//     the camera moved. Nothing about the grouping reaches the builder (no selection, no undo, no saved
//     layout). There is no cross-fade yet: a flip is an instant swap.
//   - The pass runs on a quarter-second tick inside the frame loop, and its work (attaching versions,
//     flipping items) stops when its slice of a frame is spent (#3396); what it did not reach waits for
//     the next tick, and the biggest on screen go first.
import * as THREE from 'three';
import {
  apparentSizePx, nextTier, budgetedTiers, isNearFullDetail, TIER_FULL, TIER_MID, TIER_FAR,
  MAX_FULL_DETAIL_TRIANGLES, countModelTriangles, holdBackUnready, setApparentPx,
} from '../shop/lodTier.js';
import { buildLodSets } from '../shop/lodSets.js';
import { attachInstanceTiers, setInstanceLodState, setLodChildHitTestable, loadTierScenes, extensibleAxes, meshDimensions } from '../world/models.js';

export const BUILD_LOD_INTERVAL_MS = 250;
export const BUILD_LOD_SLICE_MS = 4; // the part of a frame one tick's attaching and flipping may use
// #4003: items whose versions have not attached yet are drawn from their full model, so on a heavy
// lándlet the way in drew up to 8.4 million triangles in a frame. Those beyond this many triangles
// (nearest first, and an item already drawn stays drawn) wait, undrawn, until their versions attach
// and then arrive in the version they should be in. The budget is for the way in: an item counts
// against it, and can be held, only for HOLD_MAX_MS after it was first seen, so a placement or a paste
// long after entering is judged on its own, and a single new item is always drawn.
export const BUILD_HOLD_BACK_TRIANGLES = MAX_FULL_DETAIL_TRIANGLES;
export const BUILD_HOLD_MAX_MS = 20000;

const scratchPosition = new THREE.Vector3();
const scratchSetPosition = new THREE.Vector3();
const TIER_COST = { [TIER_FULL]: 0, [TIER_MID]: 1, [TIER_FAR]: 2 };

// A cheap number for "which product and which bundle this item is", kept on the item and worked out again
// only when either changes, so noticing that the layout changed does not allocate for every item.
function setKeyHashOf(data) {
  if (data.lodSigGroup !== data.groupId || data.lodSigTemplate !== data.template) {
    data.lodSigGroup = data.groupId;
    data.lodSigTemplate = data.template;
    const text = `${data.template?.templateId ?? ''}|${data.groupId ?? ''}`;
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 1000003;
    data.lodSigHash = hash;
  }
  return data.lodSigHash;
}

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
export function createBuildLod({ camera, target, getMeshes, isSelected, onTicked = null, arrival = null, viewportHeight = () => window.innerHeight }) {
  let lastTickMs = -Infinity;
  let fullTriangleCap = MAX_FULL_DETAIL_TRIANGLES;
  let protectNear = true; // e2e-only switch: false leaves only the selected items protected
  const items = [];
  const objects = [];
  const flips = [];
  const attachQueue = [];
  // #4115: the sets of items that change version as one. They are worked out again only once the layout
  // has stood still for a tick (a drag changes it every tick, and the items being dragged are selected
  // and so judged on their own anyway), and each tick only reads them.
  let implicitSets = true; // e2e-only switch: false leaves loose items judged one by one (bundles stay sets)
  let sets = new Map();
  let setsSignature = null; // what `sets` was worked out from
  let lastSignature = null; // what the previous pass saw
  const accs = new Map(); // setId -> what this pass has found out about the members it saw

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
  // there. A held item is unready, unselected and has never been drawn; everything else draws.
  // `tiers` are the versions the budget gave each item, used to show a released item in the right one.
  function applyHoldBack(list, listItems, tiers, nowMs) {
    const candidates = [];
    list.forEach((object, i) => {
      const data = object.userData;
      if (data.lodSeenMs === undefined) data.lodSeenMs = nowMs;
      const waiting = data.lodTiersState !== 'ready' && data.lodTiersState !== 'none';
      const recent = nowMs - data.lodSeenMs <= BUILD_HOLD_MAX_MS;
      if (!waiting || !recent) { setHeld(object, false, tiers[i]); return; }
      // A selected item is always drawn, but its triangles still count against the budget, so what is
      // held back is what is left after them. It is drawn, so it stays drawn when it is deselected.
      // The near ring is not exempt while versions are still attaching (#4003): on a dense wall it is
      // most of the lándlet, 1,000 bricks and 5 million triangles in the first frames. Its nearest items
      // are drawn first, within the same budget, and the rest arrive as their versions attach, nearest
      // first (the attach queue is nearest first too).
      if (listItems[i].selected) { data.lodDrawnWaiting = true; setHeld(object, false, tiers[i]); candidates.push(i); return; }
      candidates.push(i);
    });
    const flags = holdBackUnready(candidates.map((i) => ({
      tris: listItems[i].tris, dist: listItems[i].dist, sticky: listItems[i].selected || list[i].userData.lodDrawnWaiting === true,
    })), BUILD_HOLD_BACK_TRIANGLES);
    candidates.forEach((i, k) => {
      const object = list[i];
      if (listItems[i].selected) return;
      if (flags[k]) {
        setHeld(object, true, tiers[i]);
        // The versions of a held item must be on their way, whichever tier it will end up in.
        if (object.userData.lodTiersState === undefined) requestTiers(object);
      } else {
        object.userData.lodDrawnWaiting = true;
        setHeld(object, false, tiers[i]);
      }
    });
  }

  // A held item is not drawn and cannot be tapped (a hidden object still absorbs a raycast unless its
  // own raycast says no, src/world/models.js). Letting it in shows it in the version it should be in
  // when its versions are there (so it never draws in full for a tick first), else its own model.
  function setHeld(object, held, tier = TIER_FULL) {
    const data = object.userData;
    if (!held && !data.lodHeld) return;
    if (held && data.lodHeld) return;
    data.lodHeld = held;
    if (!data.model) return;
    if (held) {
      data.model.visible = false;
      setLodChildHitTestable(data.model, false);
    } else if (data.lodTiersState === 'ready') {
      data.lodApplied = tier;
      setInstanceLodState(object, tier);
    } else {
      data.model.visible = true;
      setLodChildHitTestable(data.model, true);
    }
  }

  function update(now = performance.now(), force = false) {
    if (!force && now - lastTickMs < BUILD_LOD_INTERVAL_MS) return;
    lastTickMs = now;
    const startMs = performance.now();
    drainAttachQueue(startMs);
    items.length = 0;
    objects.length = 0;
    accs.clear();
    const height = viewportHeight();
    let signatureSum = 0;
    for (const object of getMeshes()) {
      if (!hasLodTiers(object) || !object.parent) { if (object.userData.lodHeld) setHeld(object, false); continue; }
      const data = object.userData;
      scratchPosition.setFromMatrixPosition(object.matrixWorld);
      const radiusM = radiusOf(object);
      const px = apparentSizePx(radiusM, scratchPosition.distanceTo(camera.position), camera.fov, height);
      const groundDistanceM = Math.hypot(scratchPosition.x - target.x, scratchPosition.y - target.y);
      const near = isNearFullDetail(groundDistanceM, data.lodNear === true);
      data.lodNear = near;
      data.lodDistM = groundDistanceM;
      const selectedItem = isSelected(object);
      signatureSum += scratchPosition.x * 1.37 + scratchPosition.y * 2.11 + scratchPosition.z * 3.07 + radiusM * 0.59 + setKeyHashOf(data);
      const own = (protectNear && near) || selectedItem;
      const fullTriangles = fullTrianglesOf(object);
      items.push({
        px,
        protected: own,
        selected: selectedItem,
        wanted: own ? TIER_FULL : nextTier(data.lodTier, px),
        tris: fullTriangles,
        dist: groundDistanceM,
        current: data.lodApplied ?? TIER_FULL,
      });
      objects.push(object);
      // #4115: what this pass sees of the item's set, from the members that are still placed.
      const setId = data.lodSetId;
      if (setId !== undefined && sets.has(setId)) {
        let acc = accs.get(setId);
        if (!acc) {
          acc = {
            members: [], minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
            maxRadiusM: 0, nearestSquared: Infinity, triangles: 0, near: false,
            currentTier: undefined, hasCurrent: false, px: 0,
          };
          accs.set(setId, acc);
        }
        acc.members.push(objects.length - 1);
        acc.minX = Math.min(acc.minX, scratchPosition.x - radiusM); acc.maxX = Math.max(acc.maxX, scratchPosition.x + radiusM);
        acc.minY = Math.min(acc.minY, scratchPosition.y - radiusM); acc.maxY = Math.max(acc.maxY, scratchPosition.y + radiusM);
        acc.minZ = Math.min(acc.minZ, scratchPosition.z - radiusM); acc.maxZ = Math.max(acc.maxZ, scratchPosition.z + radiusM);
        if (radiusM > acc.maxRadiusM) acc.maxRadiusM = radiusM;
        const squared = scratchPosition.distanceToSquared(camera.position);
        if (squared < acc.nearestSquared) acc.nearestSquared = squared;
        acc.triangles += fullTriangles;
        if (near) acc.near = true;
        // The selected item is judged on its own (it is always full, and highlighted); the set's version so far
        // is that of a member that is not selected.
        if (!selectedItem && !acc.hasCurrent) { acc.hasCurrent = true; acc.currentTier = data.lodTier; }
      }
    }
    // #4115: the layout stood still for a tick: work the sets out again. (The first time, at once.)
    const signature = `${objects.length}:${signatureSum.toFixed(3)}`;
    if (signature !== setsSignature && (signature === lastSignature || setsSignature === null)) {
      sets = buildLodSets(objects, {
        hasTiers: () => true,
        groupIdOf: (object) => object.userData.groupId,
        templateKeyOf: (object) => object.userData.template?.templateId,
        positionOf: (object) => scratchSetPosition.setFromMatrixPosition(object.matrixWorld),
        radiusOf,
        implicit: implicitSets,
      });
      setsSignature = signature;
    }
    lastSignature = signature;
    // One decision for a whole set, from its size on screen (src/shop/lodTier.js setApparentPx), and the whole
    // set is beside the builder's work when any member is: "a wall is a wall; it does not dissolve piecemeal."
    for (const acc of accs.values()) {
      if (acc.members.length < 2) continue;
      const centerX = (acc.minX + acc.maxX) / 2;
      const centerY = (acc.minY + acc.maxY) / 2;
      const centerZ = (acc.minZ + acc.maxZ) / 2;
      acc.px = setApparentPx({
        sphere: { radiusM: 0.5 * Math.hypot(acc.maxX - acc.minX, acc.maxY - acc.minY, acc.maxZ - acc.minZ) },
        centerDistanceM: Math.hypot(centerX - camera.position.x, centerY - camera.position.y, centerZ - camera.position.z),
        maxMemberRadiusM: acc.maxRadiusM,
        nearestMemberDistanceM: Math.sqrt(acc.nearestSquared),
        fullTriangles: acc.triangles,
      }, camera.fov, height);
      for (const index of acc.members) {
        const entry = items[index];
        entry.px = acc.px;
        if (protectNear && acc.near && acc.triangles <= fullTriangleCap) entry.protected = true; // a set too heavy to hold in full is not (it would spend the whole budget)
        entry.wanted = entry.protected ? TIER_FULL : nextTier(acc.currentTier, acc.px);
        objects[index].userData.lodProtected = entry.protected; // not set aside for batching: only selected ones are
      }
    }
    for (let i = 0; i < objects.length; i++) objects[i].userData.lodProtected = items[i].protected; // read by src/build/batching.js
    const tiers = budgetedTiers(items, undefined, undefined, fullTriangleCap);
    // The budget serves items nearest first and does not know of sets, so it can give one set two versions.
    // A set beside the builder's work (any member within the full-detail ring of the point being looked at)
    // is always the real model, as a protected item is: it is the work area, and one set is bounded in size
    // (a set wider than 30 m is cut into cells of 20 m, src/shop/implicitLodSets.js). Any other set takes the
    // cheapest version the budget gave any of its members, so the budget is never spent on a set it did not
    // fit, and a wall is on one version, not two.
    for (const acc of accs.values()) {
      if (acc.members.length < 2) continue;
      let tier = TIER_FULL;
      if (!(protectNear && acc.near && acc.triangles <= fullTriangleCap)) {
        for (const index of acc.members) {
          if (!items[index].selected && TIER_COST[tiers[index]] > TIER_COST[tier]) tier = tiers[index];
        }
      }
      for (const index of acc.members) if (!items[index].selected) tiers[index] = tier;
    }
    // The selected item is the builder's own work in hand: always the real model, outside the budget.
    for (let i = 0; i < items.length; i++) if (items[i].selected) tiers[i] = TIER_FULL;
    applyHoldBack(objects, items, tiers, now);
    flips.length = 0;
    for (let i = 0; i < objects.length; i++) {
      const object = objects[i];
      const tier = tiers[i];
      object.userData.lodTier = tier;
      if (tier !== TIER_FULL && object.userData.lodTiersState === undefined) requestTiers(object);
      if (object.userData.lodTiersState !== 'ready' || tier === (object.userData.lodApplied ?? TIER_FULL)) continue;
      flips.push(i);
    }
    // The biggest on screen first; a set's members stay together and go nearest first, so when the slice is
    // spent at most one set is left part way over and the next pass finishes it before starting another.
    flips.sort((a, b) => (items[b].px - items[a].px)
      || ((objects[a].userData.lodSetId ?? '') < (objects[b].userData.lodSetId ?? '') ? -1 : (objects[a].userData.lodSetId ?? '') > (objects[b].userData.lodSetId ?? '') ? 1 : 0)
      || (items[a].dist - items[b].dist));
    for (const i of flips) {
      const object = objects[i];
      object.userData.lodApplied = tiers[i];
      setInstanceLodState(object, tiers[i]);
      window.__buildLodFlipCount = (window.__buildLodFlipCount ?? 0) + 1; // e2e counts tier changes
      if (performance.now() - startMs > BUILD_LOD_SLICE_MS * 2) break;
    }
    // #4003: what was let in this pass from the first load's hold resolves out of fog together.
    if (arrival) {
      const arriving = objects.filter((object) => object.userData.lodArrive && !object.userData.lodHeld);
      if (arriving.length > 0) {
        for (const object of arriving) object.userData.lodArrive = false;
        arrival.start(arriving);
      }
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

  // #4003: an item that arrives while a lándlet is first loading waits, undrawn, for the next pass to
  // decide whether the budget has room for it. Items arrive in bursts between the quarter-second passes
  // (1,400 bricks in one frame), and a burst drawn before a pass is a whole wall at full detail. The pass
  // lets it in at once when it fits or has no versions to wait for.
  function holdNew(object) {
    if (!hasLodTiers(object) || !object.userData.model) return;
    object.userData.lodArrive = true; // #4003: let in later, it arrives through fog; a placement never comes here
    setHeld(object, true);
  }

  return {
    update,
    counts,
    holdNew,
    setFullTriangleCap(triangles) { fullTriangleCap = triangles ?? MAX_FULL_DETAIL_TRIANGLES; },
    setProtectNear(on) { protectNear = on !== false; },
    // #4115: e2e-only switch for the grouping of loose items; the sets are worked out again on the next pass.
    setImplicitSets(on) { implicitSets = on !== false; setsSignature = null; },
    setCount() { return sets.size; },
  };
}
