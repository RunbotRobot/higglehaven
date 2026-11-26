// #3403: the books of a batch's levels of detail: one instanced set per version of the model, a
// placement in exactly one, moved by swapping the last live instance into its slot.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildInstancedBatch } from './instancedBatches.js';
import {
  initBatchTiers, addBatchTier, moveBatchHandle, resolveBatchTier, batchTierCounts, disposeBatchTiers, partitionBatch,
  beginBatchTiers, stepBatchTiers, beginPartition, stepPartition, endPartition,
  BATCH_TIER_FULL, BATCH_TIER_MID, BATCH_TIER_FAR,
} from './batchTiers.js';

function handleAt(i) {
  const handle = new THREE.Object3D();
  handle.position.set(i * 2, (i % 7) * 3, 1 + (i % 3));
  handle.rotation.z = i * 0.1;
  handle.userData.id = `h${i}`;
  handle.updateMatrix();
  return handle;
}

const part = (matrix = new THREE.Matrix4(), size = 1) => ({
  geometry: new THREE.BoxGeometry(size, size, size), material: new THREE.MeshStandardMaterial(), matrix,
});

function makeBatch(count, { withMid = true, withFar = true } = {}) {
  const handles = Array.from({ length: count }, (_, i) => handleAt(i));
  const fullParts = [part(new THREE.Matrix4().makeTranslation(0, 0, 0.5)), part()];
  const batch = buildInstancedBatch(fullParts, handles);
  batch.root = new THREE.Group();
  for (const mesh of batch.meshes) batch.root.add(mesh);
  initBatchTiers(batch, fullParts);
  if (withMid) addBatchTier(batch, BATCH_TIER_MID, [part(new THREE.Matrix4().makeTranslation(0, 0, 0.25))]);
  if (withFar) addBatchTier(batch, BATCH_TIER_FAR, [part()]);
  return { batch, handles, fullParts };
}

// Every placement is in exactly one set, its slot points back at it, and the matrix in that slot is
// the placement's own through that version's part.
function expectConsistent(batch, handles) {
  const seen = new Set();
  const m = new THREE.Matrix4();
  const expected = new THREE.Matrix4();
  for (const [name, tier] of Object.entries(batch.tiers)) {
    for (const mesh of tier.meshes) {
      expect(mesh.count).toBe(tier.live.length);
      expect(mesh.visible).toBe(tier.live.length > 0);
      expect(mesh.userData.instanceHandles).toBe(tier.live);
    }
    tier.live.forEach((handle, slot) => {
      expect(seen.has(handle)).toBe(false);
      seen.add(handle);
      expect(handle.userData.batchTier).toBe(name);
      expect(handle.userData.batchSlot).toBe(slot);
      tier.meshes.forEach((mesh, index) => {
        mesh.getMatrixAt(slot, m);
        handle.updateMatrix();
        expected.multiplyMatrices(handle.matrix, tier.parts[index].matrix);
        for (let k = 0; k < 16; k++) expect(m.elements[k]).toBeCloseTo(expected.elements[k], 5);
      });
    });
  }
  expect(seen.size).toBe(handles.length);
}

describe('batch tiers', () => {
  it('starts with every placement in the full set, in instance order', () => {
    const { batch, handles } = makeBatch(10);
    expect(batchTierCounts(batch)).toEqual({ full: 10, mid: 0, far: 0 });
    expect(batch.tiers.full.live).toEqual(handles);
    expect(batch.tiers.mid.meshes[0].count).toBe(0);
    expect(batch.tiers.mid.meshes[0].visible).toBe(false);
    expectConsistent(batch, handles);
  });

  it('moves a placement between sets and keeps the counts summing to the placements', () => {
    const { batch, handles } = makeBatch(6);
    expect(moveBatchHandle(batch, handles[2], BATCH_TIER_MID)).toBe(BATCH_TIER_MID);
    expect(moveBatchHandle(batch, handles[0], BATCH_TIER_FAR)).toBe(BATCH_TIER_FAR);
    expect(batchTierCounts(batch)).toEqual({ full: 4, mid: 1, far: 1 });
    expectConsistent(batch, handles);
    moveBatchHandle(batch, handles[2], BATCH_TIER_FULL);
    expect(batchTierCounts(batch)).toEqual({ full: 5, mid: 0, far: 1 });
    expectConsistent(batch, handles);
  });

  it('is a no-op to ask for the tier a placement is already in', () => {
    const { batch, handles } = makeBatch(3);
    moveBatchHandle(batch, handles[1], BATCH_TIER_MID);
    const slot = handles[1].userData.batchSlot;
    expect(moveBatchHandle(batch, handles[1], BATCH_TIER_MID)).toBe(BATCH_TIER_MID);
    expect(handles[1].userData.batchSlot).toBe(slot);
    expectConsistent(batch, handles);
  });

  it('loses and duplicates nothing across thousands of random moves (swap-with-last)', () => {
    const { batch, handles } = makeBatch(40);
    let seed = 12345;
    const random = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const names = [BATCH_TIER_FULL, BATCH_TIER_MID, BATCH_TIER_FAR];
    for (let step = 0; step < 4000; step++) {
      const handle = handles[Math.floor(random() * handles.length)];
      moveBatchHandle(batch, handle, names[Math.floor(random() * 3)]);
      if (step % 250 === 0) expectConsistent(batch, handles);
    }
    expectConsistent(batch, handles);
    const counts = batchTierCounts(batch);
    expect(counts.full + counts.mid + counts.far).toBe(40);
  });

  it('empties a set from the first slot, the last slot and the only slot', () => {
    const { batch, handles } = makeBatch(3);
    for (const handle of handles) moveBatchHandle(batch, handle, BATCH_TIER_FAR);
    expect(batchTierCounts(batch)).toEqual({ full: 0, mid: 0, far: 3 });
    expect(batch.tiers.full.meshes.every((mesh) => mesh.visible === false && mesh.count === 0)).toBe(true);
    expectConsistent(batch, handles);
    moveBatchHandle(batch, handles[1], BATCH_TIER_FULL); // from the middle of the far set
    moveBatchHandle(batch, handles[0], BATCH_TIER_FULL); // from the first slot
    moveBatchHandle(batch, handles[2], BATCH_TIER_FULL); // the only one left
    expect(batchTierCounts(batch)).toEqual({ full: 3, mid: 0, far: 0 });
    expectConsistent(batch, handles);
  });

  it('falls back: far to mid when there is one, then the full model; a missing mid is the full model', () => {
    const noFar = makeBatch(2, { withFar: false });
    expect(resolveBatchTier(noFar.batch, BATCH_TIER_FAR)).toBe(BATCH_TIER_MID);
    const noMid = makeBatch(2, { withMid: false });
    expect(resolveBatchTier(noMid.batch, BATCH_TIER_MID)).toBe(BATCH_TIER_FULL); // #4111: never down to far
    expect(resolveBatchTier(noMid.batch, BATCH_TIER_FAR)).toBe(BATCH_TIER_FAR);
    const none = makeBatch(2, { withMid: false, withFar: false });
    expect(resolveBatchTier(none.batch, BATCH_TIER_FAR)).toBe(BATCH_TIER_FULL);
    expect(moveBatchHandle(none.batch, none.handles[0], BATCH_TIER_FAR)).toBe(BATCH_TIER_FULL);
    expect(batchTierCounts(none.batch)).toEqual({ full: 2, mid: 0, far: 0 });
    expect(moveBatchHandle(noFar.batch, noFar.handles[0], BATCH_TIER_FAR)).toBe(BATCH_TIER_MID);
    expectConsistent(noFar.batch, noFar.handles);
  });

  it('resets the bounds of a set that changed so culling and raycasts follow what is live', () => {
    const { batch, handles } = makeBatch(4);
    for (const mesh of batch.tiers.full.meshes) mesh.computeBoundingSphere();
    moveBatchHandle(batch, handles[3], BATCH_TIER_MID);
    for (const mesh of batch.tiers.full.meshes) expect(mesh.boundingSphere).toBeNull();
    for (const mesh of batch.tiers.mid.meshes) expect(mesh.boundingSphere).toBeNull();
  });

  it('draws far fewer triangles once most of a big wall is on the reduced versions', () => {
    const handles = Array.from({ length: 1655 }, (_, i) => handleAt(i));
    const fullParts = [{ geometry: new THREE.SphereGeometry(1, 40, 36), material: new THREE.MeshStandardMaterial(), matrix: new THREE.Matrix4() }];
    const batch = buildInstancedBatch(fullParts, handles);
    batch.root = new THREE.Group();
    initBatchTiers(batch, fullParts);
    addBatchTier(batch, BATCH_TIER_MID, [{ geometry: new THREE.SphereGeometry(1, 10, 8), material: new THREE.MeshStandardMaterial(), matrix: new THREE.Matrix4() }]);
    addBatchTier(batch, BATCH_TIER_FAR, [{ geometry: new THREE.SphereGeometry(1, 6, 4), material: new THREE.MeshStandardMaterial(), matrix: new THREE.Matrix4() }]);
    const triangles = () => Object.values(batch.tiers).reduce((sum, tier) => sum + tier.meshes.reduce((s, mesh) => s + mesh.count * (mesh.geometry.index.count / 3), 0), 0);
    const before = triangles();
    for (const handle of handles) moveBatchHandle(batch, handle, BATCH_TIER_FAR);
    expect(triangles()).toBeLessThan(before / 50);
    expect(batchTierCounts(batch)).toEqual({ full: 0, mid: 0, far: 1655 });
  });

  it('disposes the reduced sets only; the full set is the batch\'s own', () => {
    const { batch } = makeBatch(3);
    let disposed = 0;
    for (const tier of Object.values(batch.tiers)) for (const mesh of tier.meshes) mesh.addEventListener('dispose', () => { disposed += 1; });
    disposeBatchTiers(batch);
    expect(disposed).toBe(batch.tiers.mid.meshes.length + batch.tiers.far.meshes.length);
  });

  it('partitions a fresh batch straight into the sets it is asked for, in one pass', () => {
    const { batch, handles } = makeBatch(30);
    const wanted = handles.map((_, i) => (i % 3 === 0 ? BATCH_TIER_FULL : i % 3 === 1 ? BATCH_TIER_MID : BATCH_TIER_FAR));
    const resolved = partitionBatch(batch, wanted);
    expect(resolved).toEqual(wanted);
    expect(batchTierCounts(batch)).toEqual({ full: 10, mid: 10, far: 10 });
    expect(batch.tiers.full.live).toBe(batch.tiers.full.meshes[0].userData.instanceHandles); // same array the meshes read
    expectConsistent(batch, handles);
    // and it keeps working as a normal batch afterwards
    moveBatchHandle(batch, handles[0], BATCH_TIER_FAR);
    expectConsistent(batch, handles);
  });

  it('partition applies the fallback and puts everything on the full set when there are no other versions', () => {
    const { batch, handles } = makeBatch(5, { withMid: false, withFar: false });
    const resolved = partitionBatch(batch, handles.map(() => BATCH_TIER_FAR));
    expect(resolved.every((name) => name === BATCH_TIER_FULL)).toBe(true);
    expect(batchTierCounts(batch)).toEqual({ full: 5, mid: 0, far: 0 });
    expectConsistent(batch, handles);
  });
});

describe('the books built in pieces (#4483)', () => {
  it('beginBatchTiers + stepBatchTiers over ranges equal initBatchTiers', () => {
    const handles = Array.from({ length: 130 }, (_, i) => handleAt(i));
    const fullParts = [part()];
    const batch = buildInstancedBatch(fullParts, handles);
    beginBatchTiers(batch, fullParts);
    for (let from = 0; from < handles.length; from += 50) stepBatchTiers(batch, from, from + 50);
    expect(batch.tiers[BATCH_TIER_FULL].live).toEqual(handles);
    handles.forEach((handle, slot) => {
      expect(handle.userData.batch).toBe(batch);
      expect(handle.userData.batchTier).toBe(BATCH_TIER_FULL);
      expect(handle.userData.batchSlot).toBe(slot);
    });
    expect(batch.tiersState).toBeUndefined();
  });

  it('beginPartition + stepPartition over ranges + endPartition equal partitionBatch', () => {
    const wanted = Array.from({ length: 140 }, (_, i) => [BATCH_TIER_FULL, BATCH_TIER_MID, BATCH_TIER_FAR][i % 3]);
    const whole = makeBatch(140);
    const wholeResolved = partitionBatch(whole.batch, wanted);
    const pieces = makeBatch(140);
    const resolved = beginPartition(pieces.batch, wanted);
    for (let from = 0; from < 140; from += 32) stepPartition(pieces.batch, resolved, from, from + 32);
    endPartition(pieces.batch);
    expect(resolved).toEqual(wholeResolved);
    expect(batchTierCounts(pieces.batch)).toEqual(batchTierCounts(whole.batch));
    for (const name of [BATCH_TIER_FULL, BATCH_TIER_MID, BATCH_TIER_FAR]) {
      pieces.batch.tiers[name].meshes.forEach((mesh, partIndex) => {
        const other = whole.batch.tiers[name].meshes[partIndex];
        expect(mesh.count).toBe(other.count);
        expect(Array.from(mesh.instanceMatrix.array)).toEqual(Array.from(other.instanceMatrix.array));
      });
    }
    pieces.handles.forEach((handle, index) => {
      expect(handle.userData.batchTier).toBe(whole.handles[index].userData.batchTier);
      expect(handle.userData.batchSlot).toBe(whole.handles[index].userData.batchSlot);
    });
  });
});
