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
import * as THREE from 'three';
import { batchKey, MIN_BATCH_SIZE } from '../shop/instanceBatching.js';
import { TIER_FULL, TIER_MID, TIER_FAR } from '../shop/lodTier.js';

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
export function createBuildBatching({ scene, isSelected, minBatchSize = MIN_BATCH_SIZE }) {
  // key -> { members: Object3D[], roots: Object3D[], matrices: Float32Array, meshes: InstancedMesh[] }
  const groups = new Map();
  const slots = new Map(); // item -> { group, index }, rewritten by every sync
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

  function sync(objects) {
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
        if (old) dispose(old);
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
        groups.set(key, { members, roots, matrices, meshes });
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
      dispose(group);
      groups.delete(key);
    }
    const batched = new Set();
    slots.clear();
    for (const group of groups.values()) {
      group.members.forEach((member, index) => { batched.add(member); slots.set(member, { group, index }); });
    }
    for (const object of objects) {
      if (object.userData.batchRoot && !batched.has(object)) unhide(object);
    }
  }

  function counts() {
    let items = 0;
    let drawCalls = 0;
    for (const group of groups.values()) { items += group.members.length; drawCalls += group.meshes.length; }
    return { groups: groups.size, items, drawCalls };
  }

  return {
    sync,
    releaseNow,
    counts,
    setEnabled(on) { enabled = on !== false; },
  };
}
