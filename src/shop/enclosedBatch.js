// #4365: leaves the enclosed placements of a Shop batch out of what is drawn. The rule for which they are is
// src/shop/enclosedPlacements.js (pure); the books that keep a placement out of every instanced set are in
// src/shop/batchTiers.js (hideBatchHandle). This file is the join: it reads the real models and placements,
// works in slices so it never holds a frame, and applies the answer once it is safe to.
//
// Safe means all of:
//  - the model is a solid box in EVERY version the batch can draw (full, mid, far): a version that is not a
//    closed box of the same size would leave a hole where an enclosed neighbour used to show through, so the
//    batch waits until its reduced versions are known and culls nothing if one of them is not a box;
//  - the landlet's arrival dissolve is over (it swaps materials under the batch's root);
//  - the placement is not part way through a version change (batchFade): that one is tried again next time.
// Shop only: a published landlet is not edited while it is looked at (a change reloads it and the batch is
// built again), so nothing here has to come back. Build has its own batching and is untouched.
import { solidFill, placementBox, createEnclosureJob, SEAM_TOLERANCE_M } from './enclosedPlacements.js';
import { hideBatchHandle } from './batchTiers.js';

// A set this small has no inside worth looking for (the smallest solid with one is 3 x 3 x 3).
export const MIN_ENCLOSURE_BATCH = 27;
export const ENCLOSURE_SLICE_MS = 1.5;

const BOUNDS_AGREE_M = 2 * SEAM_TOLERANCE_M;

// The model of one version, through its parts' matrices, as flat arrays; null when a part is not plain
// triangles.
function versionSolid(parts) {
  const positions = [];
  const indices = [];
  for (const part of parts) {
    const geometry = part.geometry;
    const attribute = geometry?.attributes?.position;
    if (!attribute || attribute.itemSize !== 3) return null;
    const e = part.matrix.elements;
    const base = positions.length / 3;
    for (let i = 0; i < attribute.count; i++) {
      const x = attribute.getX(i); const y = attribute.getY(i); const z = attribute.getZ(i);
      positions.push(
        e[0] * x + e[4] * y + e[8] * z + e[12],
        e[1] * x + e[5] * y + e[9] * z + e[13],
        e[2] * x + e[6] * y + e[10] * z + e[14],
      );
    }
    if (geometry.index) for (let i = 0; i < geometry.index.count; i++) indices.push(base + geometry.index.getX(i));
    else for (let i = 0; i < attribute.count; i++) indices.push(base + i);
  }
  return solidFill(positions, indices);
}

// { box: true, min, max } when every version of the batch's model is a closed solid that fills its own bounding
// box and the versions agree on that box to within BOUNDS_AGREE_M; the bounds returned are the ones all of them
// share. { box: false } otherwise.
export function batchSolidBox(batch) {
  let min = null;
  let max = null;
  let first = null;
  for (const tier of Object.values(batch.tiers)) {
    const verdict = versionSolid(tier.parts);
    if (!verdict?.box) return { box: false };
    if (!first) {
      first = verdict;
      min = verdict.min.slice();
      max = verdict.max.slice();
      continue;
    }
    for (let a = 0; a < 3; a++) {
      if (Math.abs(verdict.min[a] - first.min[a]) > BOUNDS_AGREE_M || Math.abs(verdict.max[a] - first.max[a]) > BOUNDS_AGREE_M) return { box: false };
      min[a] = Math.max(min[a], verdict.min[a]);
      max[a] = Math.min(max[a], verdict.max[a]);
    }
  }
  return first ? { box: true, min, max } : { box: false };
}

// Cheap first look, from the full model alone and kept: is this worth asking for the batch's reduced versions
// (which the enclosure rule needs before it culls anything)? A round or irregular product says no and never
// causes a download.
export function batchFullLooksSolid(batch) {
  if (batch.enclosureProbe === undefined) batch.enclosureProbe = !!versionSolid(batch.tiers.full.parts)?.box;
  return batch.enclosureProbe;
}

// Whether the batch is ready to be looked at: not yet asked for its versions (the caller asks), still loading
// them, or settled ('ready' with the reduced sets added, 'none' with only the full model).
export function enclosureStateOf(batch) {
  return batch.enclosure?.state ?? 'new';
}

// Advances the batch's enclosure work by about ENCLOSURE_SLICE_MS and applies what it has found. Returns the
// state: 'new' (not started; waiting for the batch's versions), 'working', 'applying' (some enclosed placements
// are mid-fade and will be left out when it ends), 'done', or 'off' (not a batch this applies to).
export function advanceBatchEnclosure(batch, { now = () => performance.now(), sliceMs = ENCLOSURE_SLICE_MS } = {}) {
  let work = batch.enclosure;
  if (work?.state === 'done' || work?.state === 'off') return work.state;
  if (!work) {
    if (batch.handles.length < MIN_ENCLOSURE_BATCH) { batch.enclosure = { state: 'off' }; return 'off'; }
    if (batch.tiersState !== 'ready' && batch.tiersState !== 'none') return 'new'; // its versions are not known yet
    if (batch.arrivalRun && !batch.arrivalRun.settled()) return 'new';
    const verdict = batchSolidBox(batch);
    if (!verdict.box) { batch.enclosure = { state: 'off' }; return 'off'; }
    const boxes = batch.handles.map((handle) => {
      handle.updateMatrix();
      return placementBox(handle.matrix.elements, verdict.min, verdict.max);
    });
    work = batch.enclosure = { state: 'working', job: createEnclosureJob(boxes), pending: [] };
  }
  if (work.state === 'working') {
    if (!work.job.step(sliceMs, now)) return 'working';
    for (const index of work.job.enclosed) work.pending.push(batch.handles[index]);
    work.job = null;
    work.state = 'applying';
  }
  // Apply: a placement in the middle of a version change waits for it to end.
  const waiting = [];
  for (const handle of work.pending) {
    if (handle.userData.batchFade) { waiting.push(handle); continue; }
    if (hideBatchHandle(batch, handle)) handle.userData.batchWaitSince = undefined;
  }
  work.pending = waiting;
  if (waiting.length === 0) work.state = 'done';
  return work.state;
}
