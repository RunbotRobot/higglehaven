// #4365: the join between the enclosure rule and a Shop batch (src/shop/enclosedBatch.js).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildInstancedBatch } from './instancedBatches.js';
import { initBatchTiers, addBatchTier, moveBatchHandle, partitionBatch, batchTierCounts, batchHiddenCount, hideBatchHandle, BATCH_TIER_HIDDEN, BATCH_TIER_FULL, BATCH_TIER_MID, BATCH_TIER_FAR } from './batchTiers.js';
import { createBatchCrossfades } from './batchCrossfade.js';
import { advanceBatchEnclosure, batchFullLooksSolid, batchSolidBox, MIN_ENCLOSURE_BATCH } from './enclosedBatch.js';

const identity = () => new THREE.Matrix4();
const boxPart = (n, size = 0.5) => ({ geometry: new THREE.BoxGeometry(size, size, size, n, n, n), material: new THREE.MeshStandardMaterial(), matrix: identity() });
const spherePart = () => ({ geometry: new THREE.IcosahedronGeometry(0.25, 3), material: new THREE.MeshStandardMaterial(), matrix: identity() });

function makeBatch(count, { parts = () => boxPart(2), mid = () => boxPart(1), far = () => boxPart(1), side = 4, withTiers = true } = {}) {
  const handles = [];
  for (let i = 0; i < count; i++) {
    const h = new THREE.Object3D();
    h.position.set((i % side) * 0.5, Math.floor(i / side) % side * 0.5, Math.floor(i / (side * side)) * 0.5);
    h.updateMatrix();
    handles.push(h);
  }
  const fullParts = [parts()];
  const batch = buildInstancedBatch(fullParts, handles);
  batch.root = new THREE.Group();
  for (const mesh of batch.meshes) batch.root.add(mesh);
  initBatchTiers(batch, fullParts);
  if (withTiers) {
    if (mid) addBatchTier(batch, BATCH_TIER_MID, [mid()]);
    if (far) addBatchTier(batch, BATCH_TIER_FAR, [far()]);
  }
  batch.tiersState = withTiers ? 'ready' : 'none';
  return { batch, handles };
}
const runToEnd = (batch) => { let state; for (let i = 0; i < 100; i++) { state = advanceBatchEnclosure(batch, { sliceMs: 1000 }); if (state === 'done' || state === 'off') break; } return state; };

describe('batchSolidBox', () => {
  it('is a box when every version is a closed box of the same size', () => {
    const { batch } = makeBatch(MIN_ENCLOSURE_BATCH);
    const verdict = batchSolidBox(batch);
    expect(verdict.box).toBe(true);
    expect(verdict.max[0]).toBeCloseTo(0.25, 6);
  });
  it('is not when the far version is not (it would leave a hole where a hidden neighbour showed)', () => {
    const { batch } = makeBatch(MIN_ENCLOSURE_BATCH, { far: spherePart });
    expect(batchSolidBox(batch).box).toBe(false);
  });
  it('is not when a version is a different size', () => {
    const { batch } = makeBatch(MIN_ENCLOSURE_BATCH, { mid: () => boxPart(1, 0.4) });
    expect(batchSolidBox(batch).box).toBe(false);
  });
  it('is not for a round product, which never asks for its versions', () => {
    const { batch } = makeBatch(MIN_ENCLOSURE_BATCH, { parts: spherePart });
    expect(batchFullLooksSolid(batch)).toBe(false);
  });
});

describe('advanceBatchEnclosure', () => {
  it('leaves out only the inside of a 4 x 4 x 4 block: 8 of 64, and every placement keeps its handle', () => {
    const { batch, handles } = makeBatch(64);
    expect(runToEnd(batch)).toBe('done');
    expect(batchHiddenCount(batch)).toBe(8);
    expect(batchTierCounts(batch)).toEqual({ full: 56, mid: 0, far: 0 });
    expect(batch.handles).toHaveLength(64);
    expect(handles.filter((h) => h.userData.batchTier === BATCH_TIER_HIDDEN)).toHaveLength(8);
    // The drawn set is consistent: counts, slots and matrices.
    const m = new THREE.Matrix4();
    const expected = new THREE.Matrix4();
    batch.tiers.full.live.forEach((handle, slot) => {
      expect(handle.userData.batchSlot).toBe(slot);
      batch.tiers.full.meshes[0].getMatrixAt(slot, m);
      handle.updateMatrix();
      expected.copy(handle.matrix);
      expect(m.elements.every((v, i) => Math.abs(v - expected.elements[i]) < 1e-6)).toBe(true);
    });
    expect(batch.tiers.full.meshes[0].count).toBe(56);
  });

  it('never culls anything in a batch that is too small, is not solid, or whose versions are not', () => {
    expect(runToEnd(makeBatch(MIN_ENCLOSURE_BATCH - 1).batch)).toBe('off');
    const round = makeBatch(64, { parts: spherePart }).batch;
    expect(runToEnd(round)).toBe('off');
    expect(batchHiddenCount(round)).toBe(0);
    const badFar = makeBatch(64, { far: spherePart }).batch;
    expect(runToEnd(badFar)).toBe('off');
    expect(batchHiddenCount(badFar)).toBe(0);
  });

  it('waits for the batch\'s versions to be known and for its arrival to finish', () => {
    const { batch } = makeBatch(64);
    batch.tiersState = 'loading';
    expect(advanceBatchEnclosure(batch)).toBe('new');
    batch.tiersState = 'ready';
    batch.arrivalRun = { settled: () => false };
    expect(advanceBatchEnclosure(batch)).toBe('new');
    expect(batchHiddenCount(batch)).toBe(0);
    batch.arrivalRun = { settled: () => true };
    expect(runToEnd(batch)).toBe('done');
    expect(batchHiddenCount(batch)).toBe(8);
  });

  it('works in slices and leaves nothing out until the last one', () => {
    const { batch } = makeBatch(64);
    let t = 0;
    const now = () => (t += 0.4);
    let slices = 0;
    let state = 'new';
    while (state !== 'done') { state = advanceBatchEnclosure(batch, { sliceMs: 1, now }); slices++; if (state !== 'done') expect(batchHiddenCount(batch)).toBe(0); }
    expect(slices).toBeGreaterThan(3);
    expect(batchHiddenCount(batch)).toBe(8);
  });

  it('puts off a placement that is part way through a version change, and does it when the change ends', () => {
    const { batch, handles } = makeBatch(64);
    const inside = handles.filter((h) => { const p = h.position; return p.x > 0 && p.x < 1.5 && p.y > 0 && p.y < 1.5 && p.z > 0 && p.z < 1.5; });
    expect(inside).toHaveLength(8);
    inside[0].userData.batchFade = {};
    expect(advanceBatchEnclosure(batch, { sliceMs: 1000 })).toBe('applying');
    expect(batchHiddenCount(batch)).toBe(7);
    inside[0].userData.batchFade = undefined;
    expect(advanceBatchEnclosure(batch)).toBe('done');
    expect(batchHiddenCount(batch)).toBe(8);
  });
});

describe('a left-out placement stays out', () => {
  it('is not brought back by a version change, a partition or a cross-fade move', () => {
    const { batch, handles } = makeBatch(64);
    runToEnd(batch);
    const hidden = handles.filter((h) => h.userData.batchTier === BATCH_TIER_HIDDEN);
    for (const wanted of [BATCH_TIER_MID, BATCH_TIER_FAR, BATCH_TIER_FULL]) {
      for (const h of hidden) expect(moveBatchHandle(batch, h, wanted)).toBe(BATCH_TIER_HIDDEN);
    }
    const fades = createBatchCrossfades({});
    for (const h of hidden) expect(fades.move(batch, h, BATCH_TIER_MID, { canWait: true })).toBe(BATCH_TIER_HIDDEN);
    partitionBatch(batch, handles.map(() => BATCH_TIER_MID));
    expect(batchHiddenCount(batch)).toBe(8);
    expect(batchTierCounts(batch)).toEqual({ full: 0, mid: 56, far: 0 });
    expect(hideBatchHandle(batch, hidden[0])).toBe(false);
  });

  it('does not stop the others changing version, and the books stay consistent', () => {
    const { batch, handles } = makeBatch(64);
    runToEnd(batch);
    const shown = handles.filter((h) => h.userData.batchTier !== BATCH_TIER_HIDDEN);
    for (const h of shown.slice(0, 20)) moveBatchHandle(batch, h, BATCH_TIER_MID);
    for (const h of shown.slice(10, 15)) moveBatchHandle(batch, h, BATCH_TIER_FAR);
    expect(batchTierCounts(batch)).toEqual({ full: 36, mid: 15, far: 5 });
    for (const tier of Object.values(batch.tiers)) {
      tier.live.forEach((handle, slot) => expect(handle.userData.batchSlot).toBe(slot));
      expect(tier.meshes[0].count).toBe(tier.live.length);
    }
  });
});
