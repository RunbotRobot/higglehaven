// #4062: a batch's change of version dissolves instead of swapping in one frame.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildInstancedBatch } from './instancedBatches.js';
import { initBatchTiers, addBatchTier, batchTierCounts, BATCH_TIER_FULL, BATCH_TIER_MID, BATCH_TIER_FAR } from './batchTiers.js';
import { createBatchCrossfades, BATCH_CROSSFADE_MS } from './batchCrossfade.js';

function handleAt(i) {
  const handle = new THREE.Object3D();
  handle.position.set(i * 2, (i % 7) * 3, 1 + (i % 3));
  handle.rotation.z = i * 0.1;
  handle.userData.id = `h${i}`;
  handle.updateMatrix();
  return handle;
}

const part = (matrix = new THREE.Matrix4(), size = 1, segments = 1) => ({
  geometry: new THREE.BoxGeometry(size, size, size, segments, segments, segments), material: new THREE.MeshStandardMaterial(), matrix,
});

// A batch of `count` placements with its three sets, under a root that is in a scene.
function makeBatch(count) {
  const handles = Array.from({ length: count }, (_, i) => handleAt(i));
  const fullParts = [part(new THREE.Matrix4().makeTranslation(0, 0, 0.5), 1, 4)];
  const batch = buildInstancedBatch(fullParts, handles);
  batch.root = new THREE.Group();
  new THREE.Group().add(batch.root);
  for (const mesh of batch.meshes) batch.root.add(mesh);
  initBatchTiers(batch, fullParts);
  addBatchTier(batch, BATCH_TIER_MID, [part(new THREE.Matrix4().makeTranslation(0, 0, 0.25), 1, 2)]);
  addBatchTier(batch, BATCH_TIER_FAR, [part()]);
  return { batch, handles };
}

function fakeDissolve() {
  const dissolve = { level: null, restored: false, setLevel(l) { dissolve.level = l; }, restore() { dissolve.restored = true; } };
  return dissolve;
}

function makeFades(overrides = {}) {
  const state = { now: 1000, dissolves: [], reducedReads: 0 };
  const fades = createBatchCrossfades({
    createDissolve: () => { const d = fakeDissolve(); state.dissolves.push(d); return d; },
    clock: () => state.now,
    reducedMotion: () => { state.reducedReads++; return false; },
    ...overrides,
  });
  return { fades, state };
}

const m = new THREE.Matrix4();
const expected = new THREE.Matrix4();

// The matrix of `handle` drawn by slot `slot` of `tier`'s first mesh.
function drawnScale(tier, slot) {
  tier.meshes[0].getMatrixAt(slot, m);
  return new THREE.Vector3().setFromMatrixScale(m).x;
}

function expectRealMatrix(batch, handle) {
  const tier = batch.tiers[handle.userData.batchTier];
  tier.meshes.forEach((mesh, index) => {
    mesh.getMatrixAt(handle.userData.batchSlot, m);
    handle.updateMatrix();
    expected.multiplyMatrices(handle.matrix, tier.parts[index].matrix);
    for (let k = 0; k < 16; k++) expect(m.elements[k]).toBeCloseTo(expected.elements[k], 5);
  });
}

describe('a batched placement changes version through a dissolve (#4062)', () => {
  it('moves the books at once but draws the old version until the new one has dissolved in', () => {
    const { batch, handles } = makeBatch(4);
    const { fades, state } = makeFades();
    const before = batch.root.children.length;
    expect(fades.move(batch, handles[1], BATCH_TIER_MID)).toBe(BATCH_TIER_MID);

    // The books: the placement is in the mid set, the counts add up, a tap resolves to it.
    expect(handles[1].userData.batchTier).toBe(BATCH_TIER_MID);
    expect(batchTierCounts(batch)).toEqual({ full: 3, mid: 1, far: 0 });
    expect(fades.inFlightCount).toBe(1);

    // The mid set's own slot draws nothing while the fade runs.
    expect(drawnScale(batch.tiers.mid, handles[1].userData.batchSlot)).toBe(0);
    // Two transient meshes (outgoing, incoming) are in the batch's root, each with one placement.
    const transient = batch.root.children.slice(before);
    const meshes = [];
    for (const child of transient) child.isInstancedMesh ? meshes.push(child) : child.children.forEach((c) => meshes.push(c));
    expect(meshes).toHaveLength(2);
    expect(meshes.every((mesh) => mesh.count === 1)).toBe(true);
    expect(meshes.every((mesh) => mesh.userData.instanceHandles[0] === handles[1])).toBe(true);
    // A tap can hit them: the batch lists them, and instance n is members[n].
    expect([...batch.fadeMeshes]).toHaveLength(2);
    expect(meshes.every((mesh) => batch.fadeMeshes.has(mesh))).toBe(true);
    const dissolve = state.dissolves[0];
    expect(dissolve.level).toBe(0);

    state.now += BATCH_CROSSFADE_MS / 2;
    fades.update();
    expect(dissolve.level).toBeCloseTo(0.5, 5);
    expect(drawnScale(batch.tiers.mid, handles[1].userData.batchSlot)).toBe(0);

    state.now += BATCH_CROSSFADE_MS;
    fades.update();
    expect(fades.inFlightCount).toBe(0);
    expect(dissolve.restored).toBe(true);
    expectRealMatrix(batch, handles[1]);
    expect(handles[1].userData.batchFade).toBeUndefined();
    expect(batch.root.children.length).toBe(before); // transient meshes and their group are gone
    expect(batch.fadeMeshes.size).toBe(0);
  });

  it('rebuilds the set\'s bounds when the fade ends, so it is neither culled nor missed by a tap on stale ones', () => {
    const { batch, handles } = makeBatch(3);
    const { fades, state } = makeFades();
    fades.move(batch, handles[1], BATCH_TIER_MID);
    const mid = batch.tiers.mid.meshes[0];
    mid.computeBoundingSphere(); // a render or raycast mid-fade measures the hidden slot
    expect(mid.boundingSphere).not.toBeNull();
    state.now += BATCH_CROSSFADE_MS + 1;
    fades.update();
    expect(mid.boundingSphere).toBeNull();
    mid.computeBoundingSphere();
    const center = new THREE.Vector3(...[0, 0, 0]);
    handles[1].updateMatrix();
    center.setFromMatrixPosition(handles[1].matrix);
    expect(mid.boundingSphere.center.distanceTo(center)).toBeLessThan(2); // around the placement, not the origin
  });

  it('keeps the outgoing version at the old matrix and the incoming at the new one', () => {
    const { batch, handles } = makeBatch(3);
    const { fades } = makeFades();
    const fromMatrix = new THREE.Matrix4();
    batch.tiers.full.meshes[0].getMatrixAt(handles[2].userData.batchSlot, fromMatrix);
    fades.move(batch, handles[2], BATCH_TIER_FAR);
    const outgoing = batch.root.children.find((c) => c.isInstancedMesh && !batch.meshes.includes(c) && !batch.tiers.mid.meshes.includes(c) && !batch.tiers.far.meshes.includes(c));
    outgoing.getMatrixAt(0, m);
    for (let k = 0; k < 16; k++) expect(m.elements[k]).toBeCloseTo(fromMatrix.elements[k], 5);
    expect(outgoing.geometry).toBe(batch.tiers.full.meshes[0].geometry); // nothing cloned for it
  });

  it('lets placements that change together share one cohort, and later ones start another', () => {
    const { batch, handles } = makeBatch(6);
    const { fades, state } = makeFades();
    fades.move(batch, handles[0], BATCH_TIER_MID);
    fades.move(batch, handles[1], BATCH_TIER_MID);
    state.now += 10;
    fades.move(batch, handles[2], BATCH_TIER_MID);
    expect(fades.inFlightCount).toBe(1);
    expect(state.dissolves).toHaveLength(1);
    state.now += BATCH_CROSSFADE_MS * 0.5; // part-way through: a late one must not appear half dissolved
    fades.update();
    fades.move(batch, handles[3], BATCH_TIER_MID);
    expect(fades.inFlightCount).toBe(2);
    expect(state.dissolves).toHaveLength(2);
    expect(state.dissolves[1].level).toBe(0);
  });

  it('swaps instantly past the number of cohorts at once', () => {
    const { batch, handles } = makeBatch(8);
    const { fades, state } = makeFades({ maxCohorts: 1 });
    fades.move(batch, handles[0], BATCH_TIER_MID);
    state.now += BATCH_CROSSFADE_MS * 0.5;
    fades.move(batch, handles[1], BATCH_TIER_MID); // would need a second cohort
    expect(fades.inFlightCount).toBe(1);
    expect(handles[1].userData.batchTier).toBe(BATCH_TIER_MID);
    expect(handles[1].userData.batchFade).toBeUndefined();
    expectRealMatrix(batch, handles[1]); // drawn at once, as before
  });

  it('swaps instantly past the triangle ceiling', () => {
    const { batch, handles } = makeBatch(10);
    const { fades } = makeFades({ maxTriangles: 200 }); // one box of 4x4 segments is 192 triangles
    fades.move(batch, handles[0], BATCH_TIER_MID);
    expect(fades.inFlightCount).toBe(0); // the first placement alone is over the ceiling
    expectRealMatrix(batch, handles[0]);
    expect(handles[0].userData.batchFade).toBeUndefined();
  });

  it('swaps instantly for a protected placement and for reduced motion, reading the preference rarely', () => {
    const { batch, handles } = makeBatch(8);
    const near = makeFades();
    near.fades.move(batch, handles[0], BATCH_TIER_MID, { instant: true });
    expect(near.fades.inFlightCount).toBe(0);
    expectRealMatrix(batch, handles[0]);

    const reduced = makeFades({ reducedMotion: () => { reduced.state.reducedReads++; return true; } });
    for (let i = 1; i < 6; i++) reduced.fades.move(batch, handles[i], BATCH_TIER_FAR);
    expect(reduced.fades.inFlightCount).toBe(0);
    expect(reduced.state.reducedReads).toBe(1); // five moves, one read
    for (let i = 1; i < 6; i++) expectRealMatrix(batch, handles[i]);
    reduced.state.now += 1500;
    reduced.fades.move(batch, handles[6], BATCH_TIER_FAR);
    expect(reduced.state.reducedReads).toBe(2);
  });

  it('lets one placement change again part way without popping the others in its cohort', () => {
    const { batch, handles } = makeBatch(4);
    const { fades, state } = makeFades();
    for (const i of [0, 1, 2]) fades.move(batch, handles[i], BATCH_TIER_MID);
    expect(state.dissolves).toHaveLength(1);
    const outgoing = batch.root.children.find((c) => c.isInstancedMesh && !batch.meshes.includes(c)
      && !batch.tiers.mid.meshes.includes(c) && !batch.tiers.far.meshes.includes(c));
    const midSlot = (i) => handles[i].userData.batchSlot;
    state.now += 100;
    fades.update();
    fades.move(batch, handles[1], BATCH_TIER_FAR); // the middle one reverses
    // The cohort is still running with the other two, un-popped: their mid slots stay hidden, the
    // dissolve is not restored, and the transient instances follow the swap-remove.
    expect(state.dissolves[0].restored).toBe(false);
    expect(handles[0].userData.batchFade).toBe(handles[2].userData.batchFade);
    expect(handles[0].userData.batchFade).toBeDefined();
    expect(drawnScale(batch.tiers.mid, midSlot(0))).toBe(0);
    expect(drawnScale(batch.tiers.mid, midSlot(2))).toBe(0);
    expect(outgoing.count).toBe(2);
    expect(outgoing.userData.instanceHandles).toEqual([handles[0], handles[2]]);
    const fullMatrix = new THREE.Matrix4();
    handles[2].updateMatrix();
    fullMatrix.multiplyMatrices(handles[2].matrix, batch.tiers.full.parts[0].matrix);
    outgoing.getMatrixAt(1, m);
    for (let k = 0; k < 16; k++) expect(m.elements[k]).toBeCloseTo(fullMatrix.elements[k], 5);
    // The one that reversed is in the far set, fading on its own from its real mid matrix.
    expect(handles[1].userData.batchTier).toBe(BATCH_TIER_FAR);
    expect(batchTierCounts(batch)).toEqual({ full: 1, mid: 2, far: 1 });
    expect(state.dissolves).toHaveLength(2);
    expect(fades.inFlightCount).toBe(2);
    state.now += BATCH_CROSSFADE_MS;
    fades.update();
    expect(fades.inFlightCount).toBe(0);
    for (const handle of handles) expectRealMatrix(batch, handle);
  });

  it('settles a cohort whose last placement leaves it', () => {
    const { batch, handles } = makeBatch(3);
    const { fades, state } = makeFades();
    fades.move(batch, handles[0], BATCH_TIER_MID);
    state.now += 50;
    fades.update();
    fades.move(batch, handles[0], BATCH_TIER_FAR);
    expect(state.dissolves[0].restored).toBe(true);
    expect(fades.inFlightCount).toBe(1); // only the new fade
    expect(fades.transientMeshCount).toBe(2);
  });

  it('keeps the transient meshes within the cap on draw calls', () => {
    const { batch, handles } = makeBatch(6);
    // One cohort full -> mid is two meshes (one part each); a cap of 2 allows only one cohort.
    const { fades, state } = makeFades({ maxTransientMeshes: 2 });
    fades.move(batch, handles[0], BATCH_TIER_MID);
    expect(fades.transientMeshCount).toBe(2);
    state.now += 10;
    fades.update();
    fades.move(batch, handles[1], BATCH_TIER_FAR); // a second cohort would be four meshes
    expect(fades.inFlightCount).toBe(1);
    expect(fades.transientMeshCount).toBe(2);
    expectRealMatrix(batch, handles[1]); // swapped at once
    state.now += BATCH_CROSSFADE_MS + 1;
    fades.update();
    expect(fades.transientMeshCount).toBe(0);
  });

  it('counts the hidden slot in the new set in the triangle ceiling', () => {
    // far (12 triangles) -> mid (48): 12 + 48 = 60 without the hidden slot, 12 + 2 x 48 = 108 with it.
    function inFar() {
      const made = makeBatch(4);
      makeFades().fades.move(made.batch, made.handles[0], BATCH_TIER_FAR, { instant: true });
      return made;
    }
    const tight = inFar();
    const under = makeFades({ maxTriangles: 100 });
    under.fades.move(tight.batch, tight.handles[0], BATCH_TIER_MID);
    expect(under.fades.inFlightCount).toBe(0);
    const roomyBatch = inFar();
    const roomy = makeFades({ maxTriangles: 120 });
    roomy.fades.move(roomyBatch.batch, roomyBatch.handles[0], BATCH_TIER_MID);
    expect(roomy.fades.inFlightCount).toBe(1);
    expect(roomy.fades.trianglesInFlight).toBe(108);
  });

  it('starts at most one cohort per frame; the rest swap at once, and a later frame can start another', () => {
    const { batch, handles } = makeBatch(6);
    const { fades, state } = makeFades();
    fades.move(batch, handles[0], BATCH_TIER_MID); // starts one (full -> mid)
    fades.move(batch, handles[1], BATCH_TIER_FAR); // would start another (full -> far): not this frame
    expect(fades.inFlightCount).toBe(1);
    expectRealMatrix(batch, handles[1]);
    fades.move(batch, handles[2], BATCH_TIER_MID); // joins the running one: costs no start
    expect(fades.inFlightCount).toBe(1);
    expect(handles[2].userData.batchFade).toBe(handles[0].userData.batchFade);
    state.now += 10;
    fades.update(); // the next frame
    fades.move(batch, handles[3], BATCH_TIER_FAR);
    expect(fades.inFlightCount).toBe(2);
  });

  it('swaps at once while the batch arrival dissolve is running, and fades after it', () => {
    const { batch, handles } = makeBatch(4);
    let arriving = true;
    const { fades, state } = makeFades({ isArriving: () => arriving });
    fades.move(batch, handles[0], BATCH_TIER_MID);
    expect(fades.inFlightCount).toBe(0);
    expect(state.dissolves).toHaveLength(0); // nothing cloned from the arrival's materials
    expectRealMatrix(batch, handles[0]);
    arriving = false;
    fades.move(batch, handles[1], BATCH_TIER_MID);
    expect(fades.inFlightCount).toBe(1);
  });

  it('keeps a hidden placement hidden when another placement leaves its set, and shows it at the end', () => {
    const { batch, handles } = makeBatch(4);
    const { fades, state } = makeFades();
    fades.move(batch, handles[0], BATCH_TIER_MID, { instant: true }); // slot 0 of mid, real
    fades.move(batch, handles[1], BATCH_TIER_MID); // slot 1 of mid, hidden while it fades
    expect(drawnScale(batch.tiers.mid, 1)).toBe(0);
    // The placement in slot 0 leaves; the hidden one is last, so it takes slot 0.
    fades.move(batch, handles[0], BATCH_TIER_FAR, { instant: true });
    expect(handles[1].userData.batchSlot).toBe(0);
    expect(drawnScale(batch.tiers.mid, 0)).toBe(0);
    state.now += BATCH_CROSSFADE_MS + 1;
    fades.update();
    expectRealMatrix(batch, handles[1]); // written where it is now
    expectRealMatrix(batch, handles[0]);
  });

  it('gives everything back when the batch is unloaded or its root leaves the scene', () => {
    const { batch, handles } = makeBatch(4);
    const { fades, state } = makeFades();
    const before = batch.root.children.length;
    fades.move(batch, handles[0], BATCH_TIER_MID);
    fades.finishBatch(batch);
    expect(fades.inFlightCount).toBe(0);
    expect(fades.trianglesInFlight).toBe(0);
    expect(state.dissolves[0].restored).toBe(true);
    expect(batch.root.children.length).toBe(before);

    fades.update();
    fades.move(batch, handles[1], BATCH_TIER_MID);
    batch.root.removeFromParent();
    fades.update();
    expect(fades.inFlightCount).toBe(0);
    expect(state.dissolves[1].restored).toBe(true);
  });

  it('uses clones of the incoming materials and puts the originals back (the real dissolve)', () => {
    const { batch, handles } = makeBatch(3);
    const state = { now: 0 };
    const fades = createBatchCrossfades({ clock: () => state.now, reducedMotion: () => false });
    const original = batch.tiers.mid.meshes[0].material;
    fades.move(batch, handles[0], BATCH_TIER_MID);
    const group = batch.root.children.find((c) => !c.isInstancedMesh);
    const incoming = group.children[0];
    expect(incoming.material).not.toBe(original); // a clone, so the set's own material is never touched
    expect(batch.tiers.mid.meshes[0].material).toBe(original);
    expect(batch.tiers.full.meshes[0].material).toBe(batch.meshes[0].material);
    state.now += BATCH_CROSSFADE_MS + 1;
    fades.update();
    expect(batch.root.children.some((c) => !c.isInstancedMesh)).toBe(false);
    expect(batch.tiers.mid.meshes[0].material).toBe(original);
  });

  it('costs nothing at rest and the books always add up', () => {
    const { batch, handles } = makeBatch(5);
    const { fades, state } = makeFades();
    fades.update();
    expect(fades.inFlightCount).toBe(0);
    handles.forEach((handle, i) => fades.move(batch, handle, i % 2 ? BATCH_TIER_MID : BATCH_TIER_FAR));
    const counts = batchTierCounts(batch);
    expect(counts.full + counts.mid + counts.far).toBe(5);
    state.now += BATCH_CROSSFADE_MS + 1;
    fades.update();
    expect(fades.inFlightCount).toBe(0);
    for (const handle of handles) expectRealMatrix(batch, handle);
  });
});
