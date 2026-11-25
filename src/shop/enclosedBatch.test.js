// #4365: the join between the enclosure rule and a Shop batch (src/shop/enclosedBatch.js).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildInstancedBatch } from './instancedBatches.js';
import { initBatchTiers, addBatchTier, moveBatchHandle, partitionBatch, batchTierCounts, batchHiddenCount, hideBatchHandle, BATCH_TIER_HIDDEN, BATCH_TIER_FULL, BATCH_TIER_MID, BATCH_TIER_FAR } from './batchTiers.js';
import { createBatchCrossfades } from './batchCrossfade.js';
import { advanceBatchEnclosure, batchSolidBox, materialIsOpaque, MIN_ENCLOSURE_BATCH } from './enclosedBatch.js';

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
const runToEnd = (batch) => { let state; for (let i = 0; i < 100; i++) { state = advanceBatchEnclosure(batch, { deadline: Infinity }); if (state === 'done' || state === 'off') break; } return state; };

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
    const { batch } = makeBatch(64, { parts: spherePart, withTiers: false });
    batch.tiersState = undefined;
    expect(advanceBatchEnclosure(batch, { deadline: Infinity })).toBe('off'); // never 'needTiers': nothing is downloaded for it
  });

  it('asks for the reduced versions only after the full model has passed', () => {
    const { batch } = makeBatch(64);
    batch.tiersState = undefined;
    expect(advanceBatchEnclosure(batch, { deadline: Infinity })).toBe('needTiers');
    batch.tiersState = 'loading';
    expect(advanceBatchEnclosure(batch, { deadline: Infinity })).toBe('full-ok');
  });
});

describe('opacity: a see-through neighbour hides nothing behind it', () => {
  const makers = {
    transparent: () => new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 }),
    'transparent flag alone': () => new THREE.MeshStandardMaterial({ transparent: true }),
    'opacity under 1': () => new THREE.MeshStandardMaterial({ opacity: 0.9 }),
    'alpha test (a cut-out)': () => new THREE.MeshStandardMaterial({ alphaTest: 0.5 }),
    'alpha map': () => new THREE.MeshStandardMaterial({ alphaMap: new THREE.Texture() }),
    transmission: () => new THREE.MeshPhysicalMaterial({ transmission: 0.6 }),
    'depth write off': () => new THREE.MeshStandardMaterial({ depthWrite: false }),
  };
  it('recognises an opaque material and each kind of see-through one', () => {
    expect(materialIsOpaque(new THREE.MeshStandardMaterial())).toBe(true);
    for (const [name, make] of Object.entries(makers)) expect(materialIsOpaque(make()), name).toBe(false);
    expect(materialIsOpaque([new THREE.MeshStandardMaterial(), makers.transparent()])).toBe(false);
    expect(materialIsOpaque([])).toBe(false);
  });
  for (const [name, make] of Object.entries(makers)) {
    it(`a batch whose full model is ${name} culls nothing and never asks for its versions`, () => {
      const { batch } = makeBatch(64, { parts: () => ({ ...boxPart(2), material: make() }), withTiers: false });
      batch.tiersState = undefined;
      expect(advanceBatchEnclosure(batch, { deadline: Infinity })).toBe('off');
      expect(batch.enclosure.state).toBe('off');
    });
  }
  it('a batch whose far version is see-through culls nothing', () => {
    const { batch } = makeBatch(64, { far: () => ({ ...boxPart(1), material: makers.transparent() }) });
    expect(runToEnd(batch)).toBe('off');
    expect(batchHiddenCount(batch)).toBe(0);
  });
  it('a batch whose mid version is see-through culls nothing', () => {
    const { batch } = makeBatch(64, { mid: () => ({ ...boxPart(2), material: makers['alpha test (a cut-out)']() }) });
    expect(runToEnd(batch)).toBe('off');
    expect(batchHiddenCount(batch)).toBe(0);
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
    expect(advanceBatchEnclosure(batch, { deadline: Infinity })).toBe('full-ok');
    batch.tiersState = 'ready';
    batch.arrivalRun = { settled: () => false };
    expect(advanceBatchEnclosure(batch, { deadline: Infinity })).toBe('full-ok');
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
    while (state !== 'done') { state = advanceBatchEnclosure(batch, { now, deadline: t + 1 }); slices++; if (state !== 'done') expect(batchHiddenCount(batch)).toBe(0); }
    expect(slices).toBeGreaterThan(3);
    expect(batchHiddenCount(batch)).toBe(8);
  });

  it('puts off a placement that is part way through a version change, and does it when the change ends', () => {
    const { batch, handles } = makeBatch(64);
    const inside = handles.filter((h) => { const p = h.position; return p.x > 0 && p.x < 1.5 && p.y > 0 && p.y < 1.5 && p.z > 0 && p.z < 1.5; });
    expect(inside).toHaveLength(8);
    inside[0].userData.batchFade = {};
    expect(advanceBatchEnclosure(batch, { deadline: Infinity })).toBe('applying');
    expect(batchHiddenCount(batch)).toBe(7);
    inside[0].userData.batchFade = undefined;
    expect(advanceBatchEnclosure(batch, { deadline: Infinity })).toBe('done');
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

describe('the work never holds a frame', () => {
  it('every stage is sliced: a big batch (1,650 bricks, three versions) takes many slices, each of bounded real time', () => {
    const { batch } = makeBatch(1650, { parts: () => boxPart(21), mid: () => boxPart(10), far: () => boxPart(1), side: 55 });
    let worst = 0;
    let slices = 0;
    let state = 'new';
    while (state !== 'done' && state !== 'off' && slices < 5000) {
      const start = performance.now();
      state = advanceBatchEnclosure(batch, { deadline: start + 1.5 });
      worst = Math.max(worst, performance.now() - start);
      slices++;
    }
    expect(state).toBe('done');
    expect(slices).toBeGreaterThan(10);
    expect(worst).toBeLessThan(30); // a slice is about 1.5 ms; a generous ceiling for a loaded test machine
  });

  it('a spent deadline does no work at all (the budget is shared by every batch of the tick)', () => {
    const { batch } = makeBatch(64);
    const t = performance.now();
    expect(advanceBatchEnclosure(batch, { deadline: t - 1 })).toBe('new');
    expect(batch.enclosure.state).toBe('new');
    expect(batch.enclosure.job).toBeNull();
  });

  it('two batches share one deadline: the second only gets what the first left', () => {
    const a = makeBatch(64).batch;
    const b = makeBatch(64).batch;
    let t = 0;
    const now = () => t;
    const deadline = 1; // one unit of time
    // The first batch spends the whole slice (each read of the clock advances it by a full unit).
    const spend = () => { t += 1; return t; };
    advanceBatchEnclosure(a, { now: spend, deadline });
    expect(advanceBatchEnclosure(b, { now, deadline })).toBe('new');
    expect(b.enclosure.job).toBeNull();
  });
});
