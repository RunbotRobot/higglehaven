// #3929 (follows the level of detail in src/build/lod.js): draw calls in Build.
//
// After level of detail a wall of 1,650 bricks is a few hundred thousand triangles but still about
// 1,300 draw calls, one per item, because every item is its own Object3D with its own meshes. Shop
// answered this with instanced batches (src/shop/instancedBatches.js); Build cannot swap an item's
// object for a handle, because selection, the gizmos, undo and about sixty other places hold the
// item's own object. So this leaves every item exactly as it is and changes only what draws it:
//   - Items that look the same (same template, same scale, same version shown) and that the builder
//     is not working on are drawn by ONE InstancedMesh per part, one matrix per item.
//   - The item's own copy of that version stays in the scene with `visible = false`. A tap still hits
//     it (three.js's raycaster does not look at `visible`), so selecting, moving, deleting and undo
//     find the same object as before.
//   - Selected items are never batched. The moment an item is selected or deleted `releaseNow` zeroes
//     its instance and shows its own copy, so a drag starts on the real object with nothing left
//     behind; the next tick rebuilds the batch without it.
//   - Items near the orbit target are batched too (they are drawn in full, identically): the batch
//     is what makes a dense wall cheap where the builder works.
// Runs at the end of every level-of-detail tick, so a version flip and the batch it moves into happen
// in the same synchronous step and no frame draws both.
//
// #4115 (part 2): a change of version dissolves instead of swapping in one frame, as it does in Shop
// (src/shop/batchCrossfade.js, #4093; the dissolve itself is shared, src/shop/arrivalEffect.js). When a
// tick moves items from one group into a group of another version, the OLD group's meshes are kept drawing
// while the NEW group's meshes dissolve in over them (a discard-based dissolve: no transparency, no
// sorting), and the old ones are given back when it ends. Both versions draw for the length of a fade,
// so the work is bounded exactly as Shop's is (cohorts, meshes and triangles in flight; the same
// constants); under reduced motion, or when a change could never fit (over a bound on its own, or nothing running
// to make room), it swaps at once as it always did. #4235: a change the bounds cannot take YET waits for the
// running fades to end (the old version keeps drawing, the new groups are taken back, tried again on the next tick,
// biggest first), as Shop's placements do since #4113; it swaps at once only when no fade has been admitted for
// BATCH_CROSSFADE_MAX_WAIT_MS. `hardSwapCount` counts what still changed in one frame. An item
// that is selected or deleted while a fade runs is zeroed in the old group too (releaseNow), so nothing
// is left behind under a drag.
import * as THREE from 'three';
import { batchKey, MIN_BATCH_SIZE } from '../shop/instanceBatching.js';
import { TIER_FULL, TIER_MID, TIER_FAR } from '../shop/lodTier.js';
import { createArrivalDissolve } from '../shop/arrivalEffect.js';
import { BATCH_CROSSFADE_MS, BATCH_CROSSFADE_MAX_COHORTS, BATCH_CROSSFADE_MAX_TRANSIENT_MESHES, BATCH_CROSSFADE_MAX_TRIANGLES, BATCH_CROSSFADE_MAX_WAIT_MS } from '../shop/batchCrossfade.js';

// A batch is culled as a whole, so one batch for a whole wall is drawn while any of it is in view.
// Items are grouped by the square of the ground they stand on (identical items in one square share a
// batch), so a batch whose square is off screen is skipped. Measured on the 1,690-item heavy lándlet.
export const BATCH_CELL_M = 16;

const scratch = new THREE.Matrix4();
const inverse = new THREE.Matrix4();

// The subtree that draws the version an item is showing now.
export function shownRoot(object) {
  const shown = object.userData.lodShown ?? TIER_FULL;
  if (shown === TIER_MID || shown === TIER_FAR) {
    const root = object.userData.lodTiers?.[shown];
    if (root) return root;
  }
  return object.userData.model ?? null;
}

// The drawable parts of a subtree: geometry, material and where the mesh sits relative to the item.
function partsOf(object, root) {
  object.updateMatrixWorld(true);
  inverse.copy(object.matrixWorld).invert();
  const parts = [];
  root.traverse((child) => {
    if (!child.isMesh || child.isSkinnedMesh || child.isInstancedMesh) return;
    parts.push({
      geometry: child.geometry,
      material: child.material,
      matrix: new THREE.Matrix4().multiplyMatrices(inverse, child.matrixWorld),
      castShadow: child.castShadow,
      receiveShadow: child.receiveShadow,
    });
  });
  return parts;
}

function sameMatrices(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function eligible(object, isSelected) {
  const data = object.userData;
  if (!object.parent || !data.template || !data.model) return false;
  if (isSelected(object)) return false;
  if (data.lodHeld) return false; // #4003: waiting for its versions, not drawn at all
  if (data.lodArriving) return false; // #4003: its own materials are dissolving in; batched once it has arrived
  const root = shownRoot(object);
  return Boolean(root);
}

// scene: where the instanced meshes go. getMeshes(): the placed items. isSelected(mesh).
// minBatchSize: groups smaller than this stay as they are.
function meshTriangles(mesh) {
  const index = mesh.geometry.index;
  const perInstance = index ? index.count / 3 : (mesh.geometry.attributes?.position?.count ?? 0) / 3;
  return perInstance * mesh.count;
}

function readReducedMotion() {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function createBuildBatching({
  scene, isSelected, minBatchSize = MIN_BATCH_SIZE,
  createDissolve = (root) => createArrivalDissolve(root, { uniformName: 'uTierFadeLevel' }),
  clock = () => performance.now(),
  durationMs = BATCH_CROSSFADE_MS,
  maxCohorts = BATCH_CROSSFADE_MAX_COHORTS,
  maxTransientMeshes = BATCH_CROSSFADE_MAX_TRANSIENT_MESHES,
  maxTriangles = BATCH_CROSSFADE_MAX_TRIANGLES,
  maxWaitMs = BATCH_CROSSFADE_MAX_WAIT_MS,
  reducedMotion = readReducedMotion,
}) {
  // key -> { members: Object3D[], roots: Object3D[], matrices: Float32Array, meshes: InstancedMesh[] }
  const groups = new Map();
  const slots = new Map(); // item -> { group, index }, rewritten by every sync
  let fadesStarted = 0;
  // #4235: changes that wait for room. key of the NEW group -> { members, roots, matrices, epoch, cohorts, old, since }:
  // what was tried last and not admitted. While the room has not changed (no fade ended, the same number running) and
  // the same items stand in the same places, the next tick does not build it again: the answer would be the same.
  let waiting = new Map();
  let nextWaiting = new Map();
  let roomEpoch = 0; // moves every time a fade ends: room may have opened
  let deferrals = 0;
  let hardSwaps = 0; // #4235: items whose group changed version in one frame (no fade): the cap, a limit or reduced motion said so
  const cohorts = new Set(); // #4115: fades in flight: { dissolve, entering: group[], leaving: group[], startMs }
  let enabled = true;

  function dispose(group) {
    for (const mesh of group.meshes) {
      scene.remove(mesh);
      mesh.dispose();
    }
  }

  const zero = new THREE.Matrix4().makeScale(0, 0, 0);

  // At once, without waiting for the next tick: the item draws itself and its instance stops drawing.
  function releaseNow(object) {
    for (const cohort of cohorts) {
      for (const group of cohort.leaving) {
        const at = group.members.indexOf(object);
        if (at < 0) continue;
        for (const mesh of group.meshes) {
          mesh.setMatrixAt(at, zero);
          mesh.instanceMatrix.needsUpdate = true;
        }
      }
    }
    const slot = slots.get(object);
    if (slot) {
      for (const mesh of slot.group.meshes) {
        mesh.setMatrixAt(slot.index, zero);
        mesh.instanceMatrix.needsUpdate = true;
      }
      slots.delete(object);
      slot.group.members[slot.index] = null; // the next sync sees the group changed and rebuilds it
    }
    unhide(object);
  }

  function unhide(object) {
    const root = object.userData.batchRoot;
    object.userData.batchRoot = undefined;
    if (!root) return;
    if (object.userData.lodHeld) return; // #4003: a held item stays undrawn until it is let in
    // Drawn as itself again if the version it hid is still the one it shows (a version the item has
    // since left was already hidden by the level of detail pass).
    if (shownRoot(object) === root) root.visible = true;
  }

  function finishCohort(cohort) {
    roomEpoch += 1;
    cohort.dissolve.restore();
    for (const group of cohort.leaving) dispose(group);
    cohorts.delete(cohort);
  }

  // Every frame: the incoming versions rise, and a fade that has run its length gives back what it held.
  function update(now = clock()) {
    for (const cohort of [...cohorts]) {
      const level = (now - cohort.startMs) / durationMs;
      if (level >= 1) finishCohort(cohort);
      else cohort.dissolve.setLevel(level);
    }
  }

  function inFlight() {
    let meshes = 0;
    let triangles = 0;
    for (const cohort of cohorts) {
      for (const group of [...cohort.entering, ...cohort.leaving]) {
        meshes += group.meshes.length;
        for (const mesh of group.meshes) triangles += meshTriangles(mesh);
      }
    }
    return { meshes, triangles };
  }

  function sync(objects) {
    const before = new Map(slots); // where each item was drawn until now
    const leaving = []; // groups this sync replaces or removes: given back now, or kept for a fade
    const created = []; // groups this sync draws that did not exist before
    const wanted = new Map();
    if (enabled) {
      for (const object of objects) {
        if (!eligible(object, isSelected)) continue;
        const data = object.userData;
        const key = batchKey({ crop: data.crop, scale: data.scale, isCommunitySign: data.isCommunitySign, isCommunityCalendar: data.isCommunityCalendar }, data.template);
        if (key === null) continue;
        const e = object.matrixWorld.elements;
        const cell = `${Math.floor(e[12] / BATCH_CELL_M)},${Math.floor(e[13] / BATCH_CELL_M)}`;
        const full = `${key}|${data.lodShown ?? TIER_FULL}|${cell}`;
        if (!wanted.has(full)) wanted.set(full, []);
        wanted.get(full).push(object);
      }
    }
    const kept = new Set();
    const heldOld = new Set(); // old groups a waiting change keeps drawing: not to be given back below
    nextWaiting = new Map();
    for (const [key, members] of [...wanted]) {
      if (members.length < minBatchSize) { wanted.delete(key); continue; }
      for (const member of members) member.updateMatrixWorld(true);
      const matrices = new Float32Array(members.length * 16);
      members.forEach((member, index) => member.matrixWorld.toArray(matrices, index * 16));
      const roots = members.map(shownRoot);
      const attempt = waiting.get(key);
      if (attempt && attempt.epoch === roomEpoch && attempt.cohorts === cohorts.size
        && clock() - attempt.since <= maxWaitMs
        && attempt.members.length === members.length
        && attempt.members.every((member, index) => member === members[index] && attempt.roots[index] === roots[index])
        && sameMatrices(attempt.matrices, matrices)
        && attempt.old.every((was) => groups.get(was.key) === was)) {
        // Still waiting, nothing changed: the old groups keep drawing, nothing is built.
        nextWaiting.set(key, attempt);
        for (const was of attempt.old) heldOld.add(was);
        for (let i = 0; i < members.length; i++) {
          members[i].userData.batchRoot = roots[i];
          roots[i].visible = false;
        }
        continue;
      }
      const old = groups.get(key);
      const unchanged = old && old.members.length === members.length
        && old.members.every((member, index) => member === members[index] && old.roots[index] === roots[index])
        && sameMatrices(old.matrices, matrices);
      if (!unchanged) {
        if (old) leaving.push(old);
        const parts = partsOf(members[0], roots[0]);
        const meshes = parts.map((part) => {
          const mesh = new THREE.InstancedMesh(part.geometry, part.material, members.length);
          members.forEach((member, index) => {
            scratch.fromArray(matrices, index * 16).multiply(part.matrix);
            mesh.setMatrixAt(index, scratch);
          });
          mesh.instanceMatrix.needsUpdate = true;
          mesh.castShadow = part.castShadow;
          mesh.receiveShadow = part.receiveShadow;
          scene.add(mesh);
          return mesh;
        });
        const group = { key, members, roots, matrices, meshes, tier: members[0].userData.lodShown ?? TIER_FULL };
        groups.set(key, group);
        created.push(group);
      }
      for (let i = 0; i < members.length; i++) {
        members[i].userData.batchRoot = roots[i];
        roots[i].visible = false;
      }
      kept.add(key);
    }
    // A group that no longer exists: its meshes go, and its members draw themselves again unless
    // they moved into another group above (their batchRoot was then set to a hidden root).
    for (const [key, group] of [...groups]) {
      if (kept.has(key) || heldOld.has(group)) continue;
      leaving.push(group);
      groups.delete(key);
    }
    startFade(before, leaving, created);
    waiting = nextWaiting;
    const batched = new Set();
    slots.clear();
    for (const group of groups.values()) {
      group.members.forEach((member, index) => { batched.add(member); slots.set(member, { group, index }); });
    }
    for (const object of objects) {
      if (object.userData.batchRoot && !batched.has(object)) unhide(object);
    }
  }

  // #4115: the groups that replace ones of another version dissolve in over them, within the bounds; everything
  // else is given back now.
  // #4235: what the bounds cannot take YET waits instead of swapping in one frame (as Shop's placements do since
  // #4113): the component of old and new groups stays as it was (the old version keeps drawing, the new groups
  // are taken back) and is tried again on the next tick, biggest first, while a running fade makes room. A wait
  // ends in a swap only when no fade at all has been admitted for `maxWaitMs`, or when the change could never
  // fit (over a bound alone, or nothing running to make room), as it always did. Reduced motion swaps at once.
  function startFade(before, leaving, created) {
    const now = clock();
    const reduced = created.length > 0 && reducedMotion();
    const leavingSet = new Set(leaving);
    // Components: new groups and the old groups their members were drawn from.
    const parent = new Map();
    const find = (group) => {
      let root = group;
      while (parent.get(root) !== root) root = parent.get(root);
      parent.set(group, root);
      return root;
    };
    const entersFrom = new Map(); // new group -> old groups of another version its members came from
    if (!reduced && leaving.length > 0 && created.length > 0) {
      for (const group of created) parent.set(group, group);
      for (const group of created) {
        for (const member of group.members) {
          const was = before.get(member)?.group;
          if (!was || !leavingSet.has(was)) continue;
          if (!parent.has(was)) parent.set(was, was);
          parent.set(find(group), find(was));
          if (was.tier !== group.tier) {
            if (!entersFrom.has(group)) entersFrom.set(group, new Set());
            entersFrom.get(group).add(was);
          }
        }
      }
    }
    const components = new Map();
    for (const group of parent.keys()) {
      const root = find(group);
      if (!components.has(root)) components.set(root, { created: [], old: [], entering: [], keep: new Set(), items: 0 });
      const component = components.get(root);
      if (created.includes(group)) {
        component.created.push(group);
        if (entersFrom.has(group)) {
          component.entering.push(group);
          component.items += group.members.length;
          for (const was of entersFrom.get(group)) component.keep.add(was);
        }
      } else component.old.push(group);
    }
    const trianglesOf = (groups) => {
      let meshes = 0;
      let triangles = 0;
      for (const group of groups) {
        meshes += group.meshes.length;
        for (const mesh of group.meshes) triangles += meshTriangles(mesh);
      }
      return { meshes, triangles };
    };
    // Triangles one item costs in these groups (a group with fewer items than another is not cheaper for that).
    const perItemTriangles = (list) => list.reduce((sum, group) => sum + group.meshes.reduce((inner, mesh) => inner + meshTriangles(mesh) / Math.max(1, mesh.count), 0), 0) / Math.max(1, list.length);
    const candidates = [...components.values()].filter((component) => component.entering.length > 0).sort((a, b) => b.items - a.items);
    const used = inFlight();
    const runningBefore = cohorts.size > 0;
    const canStart = cohorts.size < maxCohorts;
    let meshes = used.meshes;
    let triangles = used.triangles;
    const fadingIn = [];
    const keep = new Set();
    const deferred = [];
    for (const component of candidates) {
      const own = trianglesOf([...component.entering, ...component.keep]);
      if (canStart && meshes + own.meshes <= maxTransientMeshes && triangles + own.triangles <= maxTriangles) {
        meshes += own.meshes;
        triangles += own.triangles;
        fadingIn.push(...component.entering);
        for (const was of component.keep) keep.add(was);
        continue;
      }
      const fitsAlone = own.meshes <= maxTransientMeshes && own.triangles <= maxTriangles;
      // Only this component's own wait counts (a small one admitted every tick must not keep a big one waiting for ever).
      const since = Math.min(now, ...component.old.map((old) => old.waitSince ?? now));
      const stalled = now - since > maxWaitMs;
      // A change that SHEDS triangles (the pass is over its budget) never waits: the old, dearer group would keep
      // drawing on top of the budget for the whole wait.
      const sheds = perItemTriangles(component.entering) < perItemTriangles([...component.keep]);
      let restorable = component.old.every((old) => {
        const current = groups.get(old.key);
        return current === undefined || current === old || component.created.includes(current);
      });
      // An item that stands somewhere else than the old group drew it (undo, a programmatic move) cannot be left in it.
      if (restorable) {
        for (const group of component.created) {
          for (const member of group.members) {
            const slot = before.get(member);
            if (!slot || !leavingSet.has(slot.group)) continue;
            const at = slot.index * 16;
            const elements = member.matrixWorld.elements;
            for (let k = 0; k < 16 && restorable; k++) if (slot.group.matrices[at + k] !== Math.fround(elements[k])) restorable = false;
            if (!restorable) break;
          }
          if (!restorable) break;
        }
      }
      if (fitsAlone && !sheds && (runningBefore || fadingIn.length > 0) && !stalled && restorable) {
        for (const old of component.old) old.waitSince = since;
        deferred.push(component);
      }
    }
    // A component that waits: the old groups go back as they were, the new ones are taken back.
    const restored = new Set();
    const takenBack = new Set();
    for (const component of deferred) {
      const stays = new Set();
      for (const group of component.created) for (const member of group.members) stays.add(member);
      for (const group of component.created) {
        if (groups.get(group.key) === group) groups.delete(group.key);
        takenBack.add(group);
      }
      for (const old of component.old) {
        groups.set(old.key, old);
        restored.add(old);
        // What the old group drew but no new group of this component takes (selected, held, removed, below the minimum): stops drawing.
        old.members.forEach((member, index) => {
          if (member && stays.has(member)) return;
          for (const mesh of old.meshes) mesh.setMatrixAt(index, zero);
          for (const mesh of old.meshes) mesh.instanceMatrix.needsUpdate = true;
          old.members[index] = null;
        });
      }
    }
    // Remember what waits, so the next tick does not build it again while the room is the same.
    const cohortsAfter = cohorts.size + (fadingIn.length > 0 ? 1 : 0);
    for (const component of deferred) {
      deferrals += 1;
      const since = Math.min(now, ...component.old.map((old) => old.waitSince ?? now));
      for (const group of component.created) {
        nextWaiting.set(group.key, { members: group.members, roots: group.roots, matrices: group.matrices, epoch: roomEpoch, cohorts: cohortsAfter, old: component.old, since });
      }
    }
    // Counted: what changes version in this frame without a fade (reduced motion is the person's own choice).
    if (!reduced) {
      const fading = new Set(fadingIn);
      for (const group of created) {
        if (fading.has(group) || takenBack.has(group)) continue;
        for (const member of group.members) {
          const was = before.get(member)?.group;
          if (was && was.tier !== group.tier) hardSwaps += 1;
        }
      }
    }
    for (const group of takenBack) dispose(group);
    for (const group of leaving) if (!keep.has(group) && !restored.has(group)) dispose(group);
    if (fadingIn.length === 0) return;
    // One dissolve over every incoming group: only their materials are swapped, level 0 shows none of them yet.
    const incoming = fadingIn.flatMap((group) => group.meshes);
    const dissolve = createDissolve({ traverse(visit) { for (const mesh of incoming) visit(mesh); } });
    dissolve.setLevel(0);
    cohorts.add({ dissolve, entering: fadingIn, leaving: [...keep], startMs: clock() });
    fadesStarted += 1;
  }

  // Settles every fade now (a teardown, or a test that wants the end state).
  function finishAll() {
    for (const cohort of [...cohorts]) finishCohort(cohort);
    waiting = new Map();
  }

  function counts() {
    let items = 0;
    let drawCalls = 0;
    for (const group of groups.values()) { items += group.members.length; drawCalls += group.meshes.length; }
    return { groups: groups.size, items, drawCalls };
  }

  return {
    sync,
    update,
    finishAll,
    get fadesInFlight() { return cohorts.size; },
    get fadesStarted() { return fadesStarted; },
    get hardSwapCount() { return hardSwaps; },
    get waitingGroups() { return waiting.size > 0; },
    get deferredCount() { return deferrals; },
    releaseNow,
    counts,
    setEnabled(on) { enabled = on !== false; if (!enabled) waiting = new Map(); },
  };
}
