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
// constants); a change over any bound, or under reduced motion, swaps at once as it always did. An item
// that is selected or deleted while a fade runs is zeroed in the old group too (releaseNow), so nothing
// is left behind under a drag.
import * as THREE from 'three';
import { batchKey, MIN_BATCH_SIZE } from '../shop/instanceBatching.js';
import { TIER_FULL, TIER_MID, TIER_FAR } from '../shop/lodTier.js';
import { createArrivalDissolve } from '../shop/arrivalEffect.js';
import { BATCH_CROSSFADE_MS, BATCH_CROSSFADE_MAX_COHORTS, BATCH_CROSSFADE_MAX_TRANSIENT_MESHES, BATCH_CROSSFADE_MAX_TRIANGLES } from '../shop/batchCrossfade.js';

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
  reducedMotion = readReducedMotion,
}) {
  // key -> { members: Object3D[], roots: Object3D[], matrices: Float32Array, meshes: InstancedMesh[] }
  const groups = new Map();
  const slots = new Map(); // item -> { group, index }, rewritten by every sync
  let fadesStarted = 0;
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
    for (const [key, members] of [...wanted]) {
      if (members.length < minBatchSize) { wanted.delete(key); continue; }
      for (const member of members) member.updateMatrixWorld(true);
      const matrices = new Float32Array(members.length * 16);
      members.forEach((member, index) => member.matrixWorld.toArray(matrices, index * 16));
      const roots = members.map(shownRoot);
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
        const group = { members, roots, matrices, meshes, tier: members[0].userData.lodShown ?? TIER_FULL };
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
      if (kept.has(key)) continue;
      leaving.push(group);
      groups.delete(key);
    }
    startFade(before, leaving, created);
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
  function startFade(before, leaving, created) {
    let fadingIn = [];
    if (leaving.length > 0 && created.length > 0 && cohorts.size < maxCohorts && !reducedMotion()) {
      const leavingSet = new Set(leaving);
      fadingIn = created.filter((group) => group.members.some((member) => {
        const was = before.get(member)?.group;
        return was && leavingSet.has(was) && was.tier !== group.tier;
      }));
    }
    let keep = [];
    if (fadingIn.length > 0) {
      const enteringSet = new Set(fadingIn);
      const fromSet = new Set();
      for (const group of enteringSet) {
        for (const member of group.members) {
          const was = before.get(member)?.group;
          if (was && leaving.includes(was) && was.tier !== group.tier) fromSet.add(was);
        }
      }
      keep = [...fromSet];
      const used = inFlight();
      let meshes = used.meshes;
      let triangles = used.triangles;
      for (const group of [...enteringSet, ...keep]) {
        meshes += group.meshes.length;
        for (const mesh of group.meshes) triangles += meshTriangles(mesh);
      }
      if (meshes > maxTransientMeshes || triangles > maxTriangles) {
        fadingIn = [];
        keep = [];
      }
    }
    for (const group of leaving) if (!keep.includes(group)) dispose(group);
    if (fadingIn.length === 0) return;
    // One dissolve over every incoming group: only their materials are swapped, level 0 shows none of them yet.
    const meshes = fadingIn.flatMap((group) => group.meshes);
    const dissolve = createDissolve({ traverse(visit) { for (const mesh of meshes) visit(mesh); } });
    dissolve.setLevel(0);
    cohorts.add({ dissolve, entering: fadingIn, leaving: keep, startMs: clock() });
    fadesStarted += 1;
  }

  // Settles every fade now (a teardown, or a test that wants the end state).
  function finishAll() {
    for (const cohort of [...cohorts]) finishCohort(cohort);
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
    releaseNow,
    counts,
    setEnabled(on) { enabled = on !== false; },
  };
}
