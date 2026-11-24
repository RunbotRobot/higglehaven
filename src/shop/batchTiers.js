// #3403 (part of #3398, found under #3902): level of detail for a batch of identical placements.
//
// A batch (src/shop/instancedBatches.js) used to be one InstancedMesh per model part drawn from the
// product's FULL model, so every placement in it was full detail at any distance: a wall of 1,655
// bricks of 5,320 triangles was one draw call of 8.8 million triangles per frame, wherever the
// shopper stood. Now a batch has up to three InstancedMesh sets, one per version of the model (full,
// and the mid and far versions the model tiers make, src/modelTiers.js), each with the batch's
// capacity and a live `count`. A placement is in exactly one set; a tier change moves its matrix
// from one set to another by swapping the last live instance into the vacated slot and shrinking
// the count, so a change is O(1) per placement and nothing is rebuilt or reallocated.
//
// Imports only three.js so it runs in the unit-test pool, like instancedBatches.js. Which tier a
// placement should be in (apparent size, hysteresis, the full-detail budget) is decided by the
// existing per-item pass in presenceAndContent.js; this file only keeps the books.
import * as THREE from 'three';

export const BATCH_TIER_FULL = 'full';
export const BATCH_TIER_MID = 'mid';
export const BATCH_TIER_FAR = 'far';

const scratch = new THREE.Matrix4();
const moved = new THREE.Matrix4();

// Sets up the books for a batch built by buildInstancedBatch: every placement starts in the full
// set, in the order the instance matrices were written. `batch.handles` is the placements' list
// (unchanged); the full set's own `live` array is the one tap resolution reads
// (handleForInstanceHit), kept in step with the instance slots. `fullParts` are the parts the
// full meshes were built from (their matrices are needed to move a placement back into it).
export function initBatchTiers(batch, fullParts) {
  const live = batch.handles.slice();
  batch.tiers = { [BATCH_TIER_FULL]: { name: BATCH_TIER_FULL, meshes: batch.meshes, live, parts: fullParts } };
  for (const mesh of batch.meshes) mesh.userData.instanceHandles = live;
  live.forEach((handle, slot) => {
    handle.userData.batch = batch;
    handle.userData.batchTier = BATCH_TIER_FULL;
    handle.userData.batchSlot = slot;
  });
  batch.tiersState = undefined; // undefined: not asked for yet; 'loading'; 'ready'; 'none'
}

// Adds the set for one reduced version: an InstancedMesh per drawable part with room for every
// placement of the batch and none live yet. `parts` is [{ geometry, material, matrix }] of that
// version's model (loadBatchTierSources, models.js). `root` is the group the batch's meshes live
// under. Returns the new set.
export function addBatchTier(batch, name, parts, root = batch.root) {
  const capacity = batch.handles.length;
  const live = [];
  const meshes = parts.map((part) => {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
    mesh.count = 0;
    mesh.visible = false;
    mesh.userData.instanceHandles = live;
    return mesh;
  });
  if (root) for (const mesh of meshes) root.add(mesh);
  const tier = { name, meshes, live, parts };
  batch.tiers[name] = tier;
  return tier;
}

// The tier a placement can actually be shown in: a version the product does not have falls back
// far to mid when there is one, otherwise the full model; mid to the full model, as setInstanceLodState does for
// a single item.
export function resolveBatchTier(batch, wanted) {
  const tiers = batch.tiers;
  let shown = wanted;
  if (shown === BATCH_TIER_FAR && !tiers[BATCH_TIER_FAR]) shown = tiers[BATCH_TIER_MID] ? BATCH_TIER_MID : BATCH_TIER_FULL;
  // #4111: a missing mid is the full model, never far (see setInstanceLodState).
  if (shown === BATCH_TIER_MID && !tiers[BATCH_TIER_MID]) shown = BATCH_TIER_FULL;
  return shown;
}

function markChanged(tier) {
  for (const mesh of tier.meshes) {
    mesh.count = tier.live.length;
    mesh.visible = tier.live.length > 0;
    mesh.instanceMatrix.needsUpdate = true;
    // The bounds follow what is live: a set that lost its far end must not stay culled by, or
    // reported (raycast) at, the old bounds.
    mesh.boundingSphere = null;
  }
}

// Moves one placement to `wanted` (after the fallback). Returns the tier it is in now. Nothing
// happens if it is already there.
export function moveBatchHandle(batch, handle, wanted) {
  const toName = resolveBatchTier(batch, wanted);
  const fromName = handle.userData.batchTier;
  if (toName === fromName) return toName;
  const from = batch.tiers[fromName];
  const to = batch.tiers[toName];

  // Out of the old set: the last live placement takes the vacated slot.
  const slot = handle.userData.batchSlot;
  const lastSlot = from.live.length - 1;
  if (slot !== lastSlot) {
    for (const mesh of from.meshes) {
      mesh.getMatrixAt(lastSlot, moved);
      mesh.setMatrixAt(slot, moved);
    }
    const last = from.live[lastSlot];
    from.live[slot] = last;
    last.userData.batchSlot = slot;
  }
  from.live.pop();
  markChanged(from);

  // Into the new set: this placement's own matrix through each part of that version.
  handle.updateMatrix();
  const newSlot = to.live.length;
  to.meshes.forEach((mesh, index) => {
    const partMatrix = to.parts ? to.parts[index].matrix : null;
    if (partMatrix) scratch.multiplyMatrices(handle.matrix, partMatrix);
    else scratch.copy(handle.matrix);
    mesh.setMatrixAt(newSlot, scratch);
  });
  to.live.push(handle);
  handle.userData.batchTier = toName;
  handle.userData.batchSlot = newSlot;
  markChanged(to);
  return toName;
}

// Puts every placement of a freshly built batch straight into the set its first decision calls for,
// in one pass, so a batch arrives drawn from the right versions instead of being drawn at full
// detail for its first frames and then converted placement by placement. `wanted[i]` is the tier
// asked for the i-th placement (batch.handles order); each goes through the same fallback as
// moveBatchHandle. Returns the tier each placement ended in.
export function partitionBatch(batch, wanted) {
  const resolved = batch.handles.map((handle, index) => resolveBatchTier(batch, wanted[index] ?? BATCH_TIER_FULL));
  for (const tier of Object.values(batch.tiers)) tier.live.length = 0; // the full set's array is the one its meshes read: keep it
  batch.handles.forEach((handle, index) => {
    const name = resolved[index];
    const tier = batch.tiers[name];
    handle.updateMatrix();
    const slot = tier.live.length;
    tier.meshes.forEach((mesh, partIndex) => {
      const partMatrix = tier.parts ? tier.parts[partIndex].matrix : null;
      if (partMatrix) scratch.multiplyMatrices(handle.matrix, partMatrix);
      else scratch.copy(handle.matrix);
      mesh.setMatrixAt(slot, scratch);
    });
    tier.live.push(handle);
    handle.userData.batchTier = name;
    handle.userData.batchSlot = slot;
  });
  for (const tier of Object.values(batch.tiers)) markChanged(tier);
  return resolved;
}

// How many placements are drawn in each set right now: the numbers sum to the batch's placements.
export function batchTierCounts(batch) {
  const counts = { [BATCH_TIER_FULL]: 0, [BATCH_TIER_MID]: 0, [BATCH_TIER_FAR]: 0 };
  for (const [name, tier] of Object.entries(batch.tiers ?? {})) counts[name] = tier.live.length;
  return counts;
}

// Frees the reduced sets' instance buffers (the full set's are the batch's own, freed with it).
export function disposeBatchTiers(batch) {
  for (const [name, tier] of Object.entries(batch.tiers ?? {})) {
    if (name === BATCH_TIER_FULL) continue;
    for (const mesh of tier.meshes) mesh.dispose();
  }
}
