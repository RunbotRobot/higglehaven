// #4062 (from the owner's wall recording): when a batch of identical placements (batchTiers.js)
// changes version with distance, the placements that change dissolve from the old version into the
// new one instead of swapping in a single frame. Per-item models already do this (tierCrossfade.js,
// #3494); a batched placement has no children of its own to dissolve between, so the swap was
// instant, and a wall that crosses a distance threshold set by set showed bricks solidifying one
// group at a time. "Things arrive in the world through fog; nothing pops in."
//
//   const fades = createBatchCrossfades();
//   fades.move(batch, handle, wantedTier, { instant });   // instead of moveBatchHandle
//   fades.update();                                        // every frame
//   fades.finishBatch(batch);                              // before the batch is unloaded
//
// How: a COHORT is the placements of one batch that move from one set to another within the same
// short window. The books (batchTiers.js) change at once, exactly as before: the placement is in the
// new set, its slot and tier say so, taps resolve to it, the counts add up. What the shopper sees is
// different for the length of the fade only:
//   - the OUTGOING version stays drawn, from a transient InstancedMesh that holds the old matrices
//     (the same geometry and materials as the old set, so nothing is cloned for it);
//   - the new set's own slot for the placement is written as a zero-scale matrix, so it draws
//     nothing, and the INCOMING version is drawn from a second transient InstancedMesh whose
//     materials are one dissolve clone per original material (arrivalEffect.js, discard-based: no
//     transparency, no sorting) with one level for the whole cohort, rising 0 -> 1;
//   - when it ends the transient meshes and the clones are given back and the new set's real
//     matrices are written into the slots the placements hold NOW.
// A landlet at rest has no cohorts and costs one comparison per frame.
//
// Both versions draw while a cohort runs, so the work is bounded: a few cohorts at once, a ceiling on
// the triangles of the two versions together, and the placements over the ceiling swap instantly as
// they always did (the caller flips the biggest first, so those are the ones that get a fade). A
// placement beside the avatar swaps instantly (`instant`), and so does everything for a person who
// prefers reduced motion. Imports only three.js and the batch books, so it runs in the unit-test pool.
import * as THREE from 'three';
import { moveBatchHandle, resolveBatchTier } from './batchTiers.js';
import { createArrivalDissolve } from './arrivalEffect.js';

export const BATCH_CROSSFADE_MS = 400;
export const BATCH_CROSSFADE_MAX_COHORTS = 4;
// Triangles of the outgoing and incoming versions of everything fading at once (the same size as the
// full-detail budget, src/shop/lodTier.js MAX_FULL_DETAIL_TRIANGLES).
export const BATCH_CROSSFADE_MAX_TRIANGLES = 1_200_000;
// A placement joins a running cohort while it is still this early in its fade, so the late ones do
// not appear part way through the dissolve; after that they start a cohort of their own (or swap).
const JOIN_UNTIL_LEVEL = 0.2;
const REDUCED_MOTION_RECHECK_MS = 1000;

const scratch = new THREE.Matrix4();
const hidden = new THREE.Matrix4().makeScale(0, 0, 0);

function readReducedMotion() {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function geometryTriangles(geometry) {
  const index = geometry.index;
  if (index) return index.count / 3;
  const position = geometry.attributes?.position;
  return position ? position.count / 3 : 0;
}

function setTriangles(tier) {
  return tier.parts.reduce((sum, part) => sum + geometryTriangles(part.geometry), 0);
}

// A transient InstancedMesh like `source` (same geometry and material, same flags) with room for
// `capacity` placements and none drawn yet.
function transientMesh(source, geometry, material, capacity, handles) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  mesh.castShadow = source.castShadow;
  mesh.receiveShadow = source.receiveShadow;
  mesh.renderOrder = source.renderOrder;
  mesh.layers.mask = source.layers.mask;
  // Taps on a fading placement resolve like any batch placement: instance n is members[n].
  mesh.userData.instanceHandles = handles;
  return mesh;
}

// A transient mesh drew `count` placements now: its bounds follow (the sphere is rebuilt from the
// live instances the next time the renderer asks).
function grew(mesh, count) {
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.boundingSphere = null;
  mesh.boundingBox = null;
}

export function createBatchCrossfades({
  createDissolve = (root) => createArrivalDissolve(root, { uniformName: 'uTierFadeLevel' }),
  clock = () => performance.now(),
  durationMs = BATCH_CROSSFADE_MS,
  maxCohorts = BATCH_CROSSFADE_MAX_COHORTS,
  maxTriangles = BATCH_CROSSFADE_MAX_TRIANGLES,
  reducedMotion = readReducedMotion,
  move = moveBatchHandle,
} = {}) {
  const cohorts = new Set();
  let reduced = false;
  let reducedReadMs = -Infinity;
  let trianglesInFlight = 0;
  let started = 0;

  // matchMedia allocates a MediaQueryList per read, and a tick can move hundreds of placements:
  // read it at most once a second.
  function prefersReduced(nowMs) {
    if (nowMs - reducedReadMs >= REDUCED_MOTION_RECHECK_MS) {
      reducedReadMs = nowMs;
      reduced = reducedMotion();
    }
    return reduced;
  }

  function settle(cohort) {
    if (!cohorts.delete(cohort)) return;
    trianglesInFlight -= cohort.triangles;
    const { toTier, members } = cohort;
    // The new set's real matrices go back into the slots its placements hold now.
    for (const handle of members) {
      if (handle.userData.batchFade !== cohort) continue;
      handle.userData.batchFade = undefined;
      if (handle.userData.batchTier !== toTier.name) continue; // cannot happen: a move settles first
      handle.updateMatrix();
      const slot = handle.userData.batchSlot;
      toTier.meshes.forEach((mesh, index) => {
        const partMatrix = toTier.parts ? toTier.parts[index].matrix : null;
        if (partMatrix) scratch.multiplyMatrices(handle.matrix, partMatrix);
        else scratch.copy(handle.matrix);
        mesh.setMatrixAt(slot, scratch);
      });
    }
    for (const mesh of toTier.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      // The bounds were taken while the fading placements were zero-scale: rebuild them from the real
      // matrices, or the set is culled and raycast (a tap) by stale bounds.
      mesh.boundingSphere = null;
      mesh.boundingBox = null;
    }
    cohort.dissolve.restore();
    for (const mesh of [...cohort.outgoing, ...cohort.incoming]) {
      cohort.batch.fadeMeshes?.delete(mesh);
      mesh.removeFromParent();
      mesh.dispose();
    }
    cohort.incomingRoot.removeFromParent();
    members.length = 0;
  }

  function startCohort(batch, fromTier, toTier, nowMs) {
    const root = batch.root;
    if (!root) return null;
    const capacity = Math.max(1, fromTier.live.length);
    const handles = [];
    const outgoing = fromTier.meshes.map((mesh) => transientMesh(mesh, mesh.geometry, mesh.material, capacity, handles));
    const incoming = toTier.meshes.map((mesh) => transientMesh(mesh, mesh.geometry, mesh.material, capacity, handles));
    // The incoming meshes sit in their own group so the dissolve swaps only their materials.
    const incomingRoot = new THREE.Group();
    for (const mesh of incoming) incomingRoot.add(mesh);
    const dissolve = createDissolve(incomingRoot);
    dissolve.setLevel(0);
    for (const mesh of outgoing) root.add(mesh);
    root.add(incomingRoot);
    // A tap on a placement that is fading resolves through these (main.js's tap targets): the set's own
    // slot for it is hidden until the fade ends.
    batch.fadeMeshes ??= new Set();
    for (const mesh of [...outgoing, ...incoming]) batch.fadeMeshes.add(mesh);
    const cohort = {
      batch, fromTier, toTier, members: handles, outgoing, incoming, incomingRoot, dissolve, capacity,
      startMs: nowMs, triangles: 0,
      perPlacementTriangles: setTriangles(fromTier) + setTriangles(toTier),
    };
    cohorts.add(cohort);
    started++;
    return cohort;
  }

  return {
    get inFlightCount() {
      return cohorts.size;
    },
    // How many cohorts have been started (e2e: a fade happened).
    get startedCount() {
      return started;
    },
    get trianglesInFlight() {
      return trianglesInFlight;
    },
    // Moves one placement to `wanted` (after the batch's own fallback). Returns the tier it is in.
    move(batch, handle, wanted, { instant = false } = {}) {
      const toName = resolveBatchTier(batch, wanted);
      const fromName = handle.userData.batchTier;
      if (toName === fromName) return toName;
      // A placement that is still fading and changes again finishes its fade first (rare: the
      // tiers have hysteresis).
      const open = handle.userData.batchFade;
      if (open) settle(open);

      const nowMs = clock();
      const fromTier = batch.tiers[fromName];
      const toTier = batch.tiers[toName];
      if (instant || !batch.root || prefersReduced(nowMs)) return move(batch, handle, toName);

      // Which cohort does it join? One of this batch, for this pair of sets, still at the start.
      let cohort = null;
      for (const candidate of cohorts) {
        if (candidate.batch === batch && candidate.fromTier === fromTier && candidate.toTier === toTier
          && (nowMs - candidate.startMs) / durationMs < JOIN_UNTIL_LEVEL && candidate.members.length < candidate.capacity) {
          cohort = candidate;
          break;
        }
      }
      const perPlacement = cohort ? cohort.perPlacementTriangles : setTriangles(fromTier) + setTriangles(toTier);
      if (trianglesInFlight + perPlacement > maxTriangles) return move(batch, handle, toName);
      if (!cohort) {
        if (cohorts.size >= maxCohorts) return move(batch, handle, toName);
        cohort = startCohort(batch, fromTier, toTier, nowMs);
        if (!cohort) return move(batch, handle, toName);
      }

      // The outgoing version keeps this placement: its matrices as drawn now, before the books move.
      const n = cohort.members.length;
      const fromSlot = handle.userData.batchSlot;
      cohort.outgoing.forEach((mesh, index) => {
        fromTier.meshes[index].getMatrixAt(fromSlot, scratch);
        mesh.setMatrixAt(n, scratch);
        grew(mesh, n + 1);
      });
      // The books move; the new set's slot is then written hidden, and its real matrix is what the
      // incoming (dissolving) version draws.
      move(batch, handle, toName);
      const toSlot = handle.userData.batchSlot;
      cohort.incoming.forEach((mesh, index) => {
        toTier.meshes[index].getMatrixAt(toSlot, scratch);
        mesh.setMatrixAt(n, scratch);
        grew(mesh, n + 1);
        toTier.meshes[index].setMatrixAt(toSlot, hidden);
        toTier.meshes[index].instanceMatrix.needsUpdate = true;
        toTier.meshes[index].boundingSphere = null;
        toTier.meshes[index].boundingBox = null;
      });
      cohort.members.push(handle);
      cohort.triangles += perPlacement;
      trianglesInFlight += perPlacement;
      handle.userData.batchFade = cohort;
      return toName;
    },
    finishAll() {
      for (const cohort of [...cohorts]) settle(cohort);
    },
    // Ends every fade of a batch at once (its unload, or a rebuild).
    finishBatch(batch) {
      for (const cohort of [...cohorts]) if (cohort.batch === batch) settle(cohort);
    },
    update() {
      if (!cohorts.size) return;
      const nowMs = clock();
      for (const cohort of [...cohorts]) {
        const level = (nowMs - cohort.startMs) / durationMs;
        // A batch whose root left the scene has nothing left to fade.
        if (level >= 1 || !cohort.batch.root?.parent) settle(cohort);
        else cohort.dissolve.setLevel(level);
      }
    },
  };
}
