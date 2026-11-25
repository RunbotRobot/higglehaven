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
// Both versions draw while a cohort runs, so the work is bounded, in the three things a fade costs:
// COHORTS (at most four at once, and at most one started per frame, because starting one allocates
// instance buffers, creates the transient meshes and clones the incoming materials), DRAW CALLS (at
// most sixteen transient meshes alive at once: a cohort adds one per part of the old version and one
// per part of the new one), and TRIANGLES (the old version, the new version, and the new set's hidden
// slot, which still costs its vertex work, may not pass 1.2 million together). A placement over any
// bound swaps instantly, as it always did; the caller flips the biggest first, so those are the ones
// that get a fade. A placement beside the avatar swaps at once (`instant`), so does everything for a
// person who prefers reduced motion, and so does a batch whose arrival dissolve (#3407) is still
// running (`isArriving`), because both swap the materials under the batch's root.
// A placement that changes again while it fades leaves its cohort (the others keep fading).
// Known limits: a placement that joins a cohort after the first fifth of its fade starts a cohort of
// its own, so no placement joins part-dissolved, but within a cohort the first and last to join are
// up to a fifth of a fade apart; the dissolve covers the colour pass only, so shadows of both versions
// are at full strength for the 0.4 s (shadows are the part of a version least often seen to differ);
// and while a placement is hidden in its new set the set's bounding sphere includes the origin until
// the fade ends (a little extra culling slack, never a missed draw).
// Imports only three.js and the batch books, so it runs in the unit-test pool.
import * as THREE from 'three';
import { moveBatchHandle, resolveBatchTier } from './batchTiers.js';
import { createArrivalDissolve } from './arrivalEffect.js';

export const BATCH_CROSSFADE_MS = 400;
export const BATCH_CROSSFADE_MAX_COHORTS = 4;
export const BATCH_CROSSFADE_MAX_STARTS_PER_FRAME = 1;
// Transient InstancedMeshes alive at once (each is a draw call while its fade runs).
export const BATCH_CROSSFADE_MAX_TRANSIENT_MESHES = 16;
// Triangles of the outgoing and incoming versions of everything fading at once (the same size as the
// full-detail budget, src/shop/lodTier.js MAX_FULL_DETAIL_TRIANGLES).
export const BATCH_CROSSFADE_MAX_TRIANGLES = 1_200_000;
// A placement joins a running cohort while it is still this early in its fade, so the late ones do
// not appear part way through the dissolve; after that they start a cohort of their own (or swap).
const JOIN_UNTIL_LEVEL = 0.2;
// #4113: a placement the caps cannot take yet WAITS (keeps its old version, books untouched) for the running
// fades to give room, when the caller says it can retry (`canWait`). The owner's 829-brick wall: past the
// triangle ceiling about 90% of the bricks swapped in one frame, a hard-edged wedge across the wall. A wait
// is bounded, but by STALLING, not by age: a wall of thousands of bricks is a sweep of many seconds (about
// a hundred bricks every 0.4 s), and no brick in it may swap at once because it has waited its turn for long.
// A placement swaps at once only when no placement at all has been admitted to a fade for this long, which
// cannot happen while a fade runs (they end in 0.4 s) and is the safety net if it ever does.
export const BATCH_CROSSFADE_MAX_WAIT_MS = 4000;
// What move() answers for a placement that is waiting (nothing changed; call again on a later tick).
export const BATCH_WAITING = 'waiting';
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

// What one fading placement adds to a frame: the old version, the new version, and the new set's own
// slot for it (zero-scale, drawing nothing, but its vertices are still processed).
function placementTriangles(fromTier, toTier) {
  return setTriangles(fromTier) + 2 * setTriangles(toTier);
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
  maxStartsPerFrame = BATCH_CROSSFADE_MAX_STARTS_PER_FRAME,
  maxTransientMeshes = BATCH_CROSSFADE_MAX_TRANSIENT_MESHES,
  maxTriangles = BATCH_CROSSFADE_MAX_TRIANGLES,
  isArriving = () => false,
  reducedMotion = readReducedMotion,
  move = moveBatchHandle,
} = {}) {
  const cohorts = new Set();
  let reduced = false;
  let reducedReadMs = -Infinity;
  let trianglesInFlight = 0;
  let transientMeshes = 0;
  let started = 0;
  let hardSwaps = 0; // placements that changed in one frame because a cap (or the wait limit) said so
  let waitSkips = 0; // retries of a waiting placement answered without looking at anything (nothing had changed)
  // Bumped whenever room may have come back (a fade ended, a placement left one, a new frame's start): a
  // waiting placement is looked at again only after this has moved, so a retry pass over thousands of
  // waiting placements costs a comparison each while nothing has changed.
  let roomEpoch = 0;
  let lastAdmitMs = -Infinity; // when a placement was last admitted to a fade
  let startsSpent = false;
  let startsLeft = maxStartsPerFrame;

  // matchMedia allocates a MediaQueryList per read, and a tick can move hundreds of placements:
  // read it at most once a second.
  function prefersReduced(nowMs) {
    if (nowMs - reducedReadMs >= REDUCED_MOTION_RECHECK_MS) {
      reducedReadMs = nowMs;
      reduced = reducedMotion();
    }
    return reduced;
  }

  function clearWait(handle) {
    handle.userData.batchWaitSince = undefined;
    handle.userData.batchWaitTo = undefined;
    handle.userData.batchWaitEpoch = undefined;
  }

  // A cap says no fade for this placement now. With `canWait`, and when room will come back (a fade is
  // running and ends, or the frame's one start is spent) and it has not waited long, it WAITS; otherwise it
  // swaps at once, exactly as before #4113.
  function overCap(batch, handle, toName, nowMs, canWait, willFit) {
    if (canWait && willFit) {
      // The clock restarts when the target changes (a placement that wanted something else before), and
      // it only runs while nothing is being admitted.
      if (handle.userData.batchWaitTo !== toName || handle.userData.batchWaitSince === undefined) {
        handle.userData.batchWaitSince = nowMs;
        handle.userData.batchWaitTo = toName;
      }
      handle.userData.batchWaitEpoch = roomEpoch;
      if (nowMs - Math.max(handle.userData.batchWaitSince, lastAdmitMs) < BATCH_CROSSFADE_MAX_WAIT_MS) return BATCH_WAITING;
    }
    clearWait(handle);
    hardSwaps++;
    return move(batch, handle, toName);
  }

  // The placement's real matrices in the slots it holds in its set now (a fade writes them hidden).
  function writeReal(tier, handle) {
    handle.updateMatrix();
    const slot = handle.userData.batchSlot;
    tier.meshes.forEach((mesh, index) => {
      const partMatrix = tier.parts ? tier.parts[index].matrix : null;
      if (partMatrix) scratch.multiplyMatrices(handle.matrix, partMatrix);
      else scratch.copy(handle.matrix);
      mesh.setMatrixAt(slot, scratch);
    });
  }

  function boundsChanged(meshes) {
    for (const mesh of meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      // The bounds were taken while the fading placements were zero-scale: rebuild them from the real
      // matrices, or the set is culled and raycast (a tap) by stale bounds.
      mesh.boundingSphere = null;
      mesh.boundingBox = null;
    }
  }

  function settle(cohort) {
    if (!cohorts.delete(cohort)) return;
    roomEpoch++;
    trianglesInFlight -= cohort.triangles;
    transientMeshes -= cohort.outgoing.length + cohort.incoming.length;
    const { toTier, members } = cohort;
    // The new set's real matrices go back into the slots its placements hold now.
    for (const handle of members) {
      if (handle.userData.batchFade !== cohort) continue;
      handle.userData.batchFade = undefined;
      if (handle.userData.batchTier !== toTier.name) continue; // a placement that left was detached first
      writeReal(toTier, handle);
    }
    boundsChanged(toTier.meshes);
    cohort.dissolve.restore();
    for (const mesh of [...cohort.outgoing, ...cohort.incoming]) {
      cohort.batch.fadeMeshes?.delete(mesh);
      mesh.removeFromParent();
      mesh.dispose();
    }
    cohort.incomingRoot.removeFromParent();
    members.length = 0;
  }

  // One placement leaves its cohort (it changes version again part way): its real matrix goes back
  // into its slot (the next fade reads it as the version it leaves), the last member of the cohort
  // takes its instance in the transient meshes, and the rest keep fading.
  function detach(cohort, handle) {
    const { members, toTier } = cohort;
    const k = members.indexOf(handle);
    handle.userData.batchFade = undefined;
    if (k < 0) return;
    writeReal(toTier, handle);
    boundsChanged(toTier.meshes);
    const last = members.length - 1;
    if (k !== last) {
      for (const mesh of [...cohort.outgoing, ...cohort.incoming]) {
        mesh.getMatrixAt(last, scratch);
        mesh.setMatrixAt(k, scratch);
      }
      members[k] = members[last];
    }
    members.pop();
    for (const mesh of [...cohort.outgoing, ...cohort.incoming]) grew(mesh, last);
    cohort.triangles -= cohort.perPlacementTriangles;
    trianglesInFlight -= cohort.perPlacementTriangles;
    roomEpoch++;
    if (!members.length) settle(cohort); // nothing left in it to fade
  }

  function startCohort(batch, fromTier, toTier, nowMs) {
    const root = batch.root;
    if (!root) return null;
    const needed = fromTier.meshes.length + toTier.meshes.length;
    if (startsLeft <= 0 || transientMeshes + needed > maxTransientMeshes) return null;
    startsLeft--;
    startsSpent = true;
    transientMeshes += needed;
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
      perPlacementTriangles: placementTriangles(fromTier, toTier),
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
    get transientMeshCount() {
      return transientMeshes;
    },
    get trianglesInFlight() {
      return trianglesInFlight;
    },
    // #4113 (e2e): placements that swapped in one frame because a cap said so.
    get hardSwapCount() {
      return hardSwaps;
    },
    // Forgets a placement's wait (it no longer wants the change it was waiting for).
    clearWait,
    // #4113 (test): retries answered in O(1) because nothing had changed since the placement last waited.
    get waitSkipCount() {
      return waitSkips;
    },
    // Moves one placement to `wanted` (after the batch's own fallback). Returns the tier it is in.
    // With `canWait` it may answer BATCH_WAITING: the placement was left as it was, to be moved again later.
    move(batch, handle, wanted, { instant = false, canWait = false } = {}) {
      const toName = resolveBatchTier(batch, wanted);
      const fromName = handle.userData.batchTier;
      if (toName === fromName) {
        if (handle.userData.batchWaitSince !== undefined) clearWait(handle);
        return toName;
      }
      // Still waiting and nothing has given room back since it last looked: nothing to decide.
      if (canWait && handle.userData.batchWaitEpoch === roomEpoch && handle.userData.batchWaitTo === toName
        && handle.userData.batchWaitSince !== undefined && clock() - Math.max(handle.userData.batchWaitSince, lastAdmitMs) < BATCH_CROSSFADE_MAX_WAIT_MS) {
        waitSkips++;
        return BATCH_WAITING;
      }
      // A placement that is still fading and changes again leaves its cohort; the others keep fading
      // (rare: the tiers have hysteresis).
      const open = handle.userData.batchFade;
      if (open) detach(open, handle);

      const nowMs = clock();
      const fromTier = batch.tiers[fromName];
      const toTier = batch.tiers[toName];
      if (instant || !batch.root || isArriving(batch) || prefersReduced(nowMs)) {
        clearWait(handle);
        return move(batch, handle, toName);
      }

      // Which cohort does it join? One of this batch, for this pair of sets, still at the start.
      let cohort = null;
      for (const candidate of cohorts) {
        if (candidate.batch === batch && candidate.fromTier === fromTier && candidate.toTier === toTier
          && (nowMs - candidate.startMs) / durationMs < JOIN_UNTIL_LEVEL && candidate.members.length < candidate.capacity) {
          cohort = candidate;
          break;
        }
      }
      const perPlacement = cohort ? cohort.perPlacementTriangles : placementTriangles(fromTier, toTier);
      // Room comes back when a running fade ends (or, for the start limit, next frame), if this placement
      // could ever fit; a placement bigger than the ceiling on its own never waits.
      const needed = fromTier.meshes.length + toTier.meshes.length;
      const couldFit = perPlacement <= maxTriangles && needed <= maxTransientMeshes && (cohorts.size > 0 || startsLeft <= 0);
      if (trianglesInFlight + perPlacement > maxTriangles) return overCap(batch, handle, toName, nowMs, canWait, couldFit);
      if (!cohort) {
        if (cohorts.size >= maxCohorts) return overCap(batch, handle, toName, nowMs, canWait, couldFit);
        cohort = startCohort(batch, fromTier, toTier, nowMs);
        if (!cohort) return overCap(batch, handle, toName, nowMs, canWait, couldFit);
      }
      clearWait(handle);
      lastAdmitMs = nowMs;

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
      startsLeft = maxStartsPerFrame;
      if (startsSpent) { // a new frame gives the one cohort start back: waiting placements may look again
        startsSpent = false;
        roomEpoch++;
      }
      if (!cohorts.size) return;
      const nowMs = clock();
      // A Set can be deleted from while it is iterated, so no copy is made.
      for (const cohort of cohorts) {
        const level = (nowMs - cohort.startMs) / durationMs;
        // A batch whose root left the scene has nothing left to fade.
        if (level >= 1 || !cohort.batch.root?.parent) settle(cohort);
        else cohort.dissolve.setLevel(level);
      }
    },
  };
}
