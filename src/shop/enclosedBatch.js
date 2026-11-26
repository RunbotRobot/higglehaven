// #4365: leaves the enclosed placements of a Shop batch out of what is drawn. The rule for which they are is
// src/shop/enclosedPlacements.js (pure); the books that keep a placement out of every instanced set are in
// src/shop/batchTiers.js (hideBatchHandle). This file is the join: it reads the real models and placements,
// works in slices so it never holds a frame, and applies the answer once it is safe to.
//
// Safe means all of:
//  - the model is an OPAQUE solid box in EVERY version the batch can draw (full, mid, far): a version that is not a
//    closed box of the same size (or that is see-through) would show what is behind it where an enclosed
//    neighbour used to be, so the batch waits until its reduced versions are known and culls nothing if one of
//    them fails. The full model is looked at first, so a round product never causes a download;
//  - the landlet's arrival dissolve is over (it swaps materials under the batch's root);
//  - the placement is not part way through a version change (batchFade): that one is tried again next time.
// Shop only: a published landlet is not edited while it is looked at (a change reloads it and the batch is
// built again), so nothing here has to come back. Build has its own batching and is untouched.
import { createSolidFillJob, placementBox, createEnclosureJob, SEAM_TOLERANCE_M, MAX_SOLID_TRIANGLES } from './enclosedPlacements.js';
import { hideBatchHandle } from './batchTiers.js';

// A set this small has no inside worth looking for (the smallest solid with one is 3 x 3 x 3).
export const MIN_ENCLOSURE_BATCH = 27;
// One tick's share of the frame for ALL batches together (the caller passes one deadline per tick).
export const ENCLOSURE_SLICE_MS = 1.5;
const BOX_CHUNK = 256;

const BOUNDS_AGREE_M = 2 * SEAM_TOLERANCE_M;

// Is this material fully opaque? A transparent, cut-out (alphaTest, alphaMap), transmissive or depth-write-off material
// lets what is behind it show, so a placement hidden behind such a neighbour WOULD be seen: none of those may take part.
export function materialIsOpaque(material) {
  if (Array.isArray(material)) return material.length > 0 && material.every(materialIsOpaque);
  if (!material) return false;
  return material.transparent !== true
    && (material.opacity === undefined || material.opacity === 1)
    && !material.alphaTest
    && !material.alphaMap
    && !material.transmission
    && material.depthWrite !== false
    && material.depthTest !== false
    && material.visible !== false;
}

export function partsAreOpaque(parts) {
  return parts.length > 0 && parts.every((part) => materialIsOpaque(part.material));
}

// The model of one version, through its parts' matrices, as flat arrays; null when it cannot be a solid box worth
// examining (not triangles, not opaque, or denser than MAX_SOLID_TRIANGLES: that is drawn whole and never examined).
function versionArrays(parts) {
  if (!partsAreOpaque(parts)) return null;
  let triangles = 0;
  for (const part of parts) {
    const geometry = part.geometry;
    const attribute = geometry?.attributes?.position;
    if (!attribute || attribute.itemSize !== 3) return null;
    triangles += (geometry.index ? geometry.index.count : attribute.count) / 3;
  }
  if (triangles > MAX_SOLID_TRIANGLES) return null;
  const positions = [];
  const indices = [];
  for (const part of parts) {
    const geometry = part.geometry;
    const attribute = geometry.attributes.position;
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
  return { positions, indices };
}

// Combines the verdicts of every version into the one box they share, or { box: false }. They must each be a closed
// solid that fills its own bounding box and agree on it to within BOUNDS_AGREE_M; the bounds returned are the ones
// all of them share.
export function sharedSolidBox(verdicts) {
  let min = null;
  let max = null;
  let first = null;
  for (const verdict of verdicts) {
    if (!verdict?.box) return { box: false };
    if (!first) { first = verdict; min = verdict.min.slice(); max = verdict.max.slice(); continue; }
    for (let a = 0; a < 3; a++) {
      if (Math.abs(verdict.min[a] - first.min[a]) > BOUNDS_AGREE_M || Math.abs(verdict.max[a] - first.max[a]) > BOUNDS_AGREE_M) return { box: false };
      min[a] = Math.max(min[a], verdict.min[a]);
      max[a] = Math.min(max[a], verdict.max[a]);
    }
  }
  return first ? { box: true, min, max } : { box: false };
}

// Not sliced: for tests and tools. The same checks the work below makes, run to the end.
export function batchSolidBox(batch) {
  const verdicts = [];
  for (const tier of Object.values(batch.tiers)) {
    const arrays = versionArrays(tier.parts);
    if (!arrays) return { box: false };
    const job = createSolidFillJob(arrays.positions, arrays.indices);
    verdicts.push(job.step(Infinity));
  }
  return sharedSolidBox(verdicts);
}

export function enclosureStateOf(batch) {
  return batch.enclosure?.state ?? 'new';
}

const off = (batch) => { batch.enclosure = { state: 'off' }; return 'off'; };

// Advances the batch's enclosure work until `deadline` (a time on `now()`'s clock; work is only started while it
// has not passed) and applies what it has found. Every stage is sliced, so nothing here holds a frame:
//   'new'       not started (too early: arrival not over, or versions not asked for yet)
//   'needTiers' the full model is a solid opaque box: the caller should ask for the batch's reduced versions
//   'checking'  looking at the versions' models
//   'boxes'     laying out the placements' boxes
//   'working'   finding the enclosed ones
//   'applying'  some are mid-fade and will be left out when it ends
//   'done' | 'off'
export function advanceBatchEnclosure(batch, { now = () => performance.now(), deadline = now() + ENCLOSURE_SLICE_MS } = {}) {
  let work = batch.enclosure;
  if (work?.state === 'done' || work?.state === 'off') return work.state;
  if (!work) {
    if (batch.handles.length < MIN_ENCLOSURE_BATCH) return off(batch);
    work = batch.enclosure = { state: 'new', verdicts: [], queue: null, job: null, boxes: null, pending: [] };
  }
  const budgetLeft = () => deadline - now();
  const stepMs = () => Math.max(0.2, budgetLeft());
  if (budgetLeft() <= 0) return work.state;

  // 1. The full model alone, before anything is downloaded for a batch that is not a solid opaque box.
  if (work.state === 'new' || work.state === 'checking-full') {
    if (!work.job) {
      const arrays = versionArrays(batch.tiers.full.parts);
      if (!arrays) return off(batch);
      work.job = createSolidFillJob(arrays.positions, arrays.indices);
    }
    work.state = 'checking-full';
    const verdict = work.job.step(stepMs(), now);
    if (!verdict) return work.state;
    work.job = null;
    if (!verdict.box) return off(batch);
    work.verdicts = [verdict];
    work.state = 'full-ok';
  }
  // 2. The reduced versions must be known (the caller asks for them) and the arrival over.
  if (work.state === 'full-ok') {
    if (batch.tiersState === undefined) return 'needTiers';
    if (batch.tiersState !== 'ready' && batch.tiersState !== 'none') return work.state;
    if (batch.arrivalRun && !batch.arrivalRun.settled()) return work.state;
    work.queue = Object.entries(batch.tiers).filter(([name]) => name !== 'full').map(([, tier]) => tier);
    work.state = 'checking';
  }
  if (work.state === 'checking') {
    while (work.queue.length > 0 || work.job) {
      if (!work.job) {
        const arrays = versionArrays(work.queue[0].parts);
        if (!arrays) return off(batch);
        work.queue.shift();
        work.job = createSolidFillJob(arrays.positions, arrays.indices);
      }
      const verdict = work.job.step(stepMs(), now);
      if (!verdict) return work.state;
      work.job = null;
      if (!verdict.box) return off(batch);
      work.verdicts.push(verdict);
      if (budgetLeft() <= 0 && work.queue.length > 0) return work.state;
    }
    const shared = sharedSolidBox(work.verdicts);
    if (!shared.box) return off(batch);
    work.bounds = shared;
    work.boxes = [];
    work.state = 'boxes';
  }
  // 3. Every placement's box, a chunk at a time.
  if (work.state === 'boxes') {
    while (work.boxes.length < batch.handles.length) {
      const end = Math.min(batch.handles.length, work.boxes.length + BOX_CHUNK);
      for (let i = work.boxes.length; i < end; i++) {
        const handle = batch.handles[i];
        handle.updateMatrix();
        work.boxes.push(placementBox(handle.matrix.elements, work.bounds.min, work.bounds.max));
      }
      if (budgetLeft() <= 0 && work.boxes.length < batch.handles.length) return work.state;
    }
    work.job = createEnclosureJob(work.boxes);
    work.boxes = null;
    work.state = 'working';
  }
  // 4. The enclosed ones.
  if (work.state === 'working') {
    if (!work.job.step(stepMs(), now)) return work.state;
    for (const index of work.job.enclosed) work.pending.push(batch.handles[index]);
    work.job = null;
    work.state = 'applying';
  }
  // 5. Apply: a placement in the middle of a version change waits for it to end.
  const waiting = [];
  for (const handle of work.pending) {
    if (handle.userData.batchFade) { waiting.push(handle); continue; }
    if (hideBatchHandle(batch, handle)) handle.userData.batchWaitSince = undefined;
  }
  work.pending = waiting;
  if (waiting.length === 0) work.state = 'done';
  return work.state;
}
