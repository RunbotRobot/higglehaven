// #4115 (part of #4062): Build judges a bundle, and loose items that stand together, as one set, so a wall
// changes version as one and no edge runs through it. These use real objects with versions attached.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

// The pass counts version changes on window for e2e; the node environment has none.
globalThis.window ??= {};
const noop = () => {};
globalThis.document ??= {
  createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: () => noop, set: () => true }) }),
};
const { createBuildLod } = await import('./lod.js');

const templateOf = (id) => ({ templateId: id, modelUrl: '', dimensions: { width: 1, depth: 1, height: 1 } });

// A placed item as createMeshForInstance builds it: a container whose model is the full version, with a
// mid and a far version attached and ready. One metre box, so its radius is about 0.87 m.
function brick(templateId, x, y, z, groupId) {
  const object = new THREE.Group();
  const make = () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
    return group;
  };
  // The full model is heavy, like the real brick (about 5,000 triangles), so a wall of them costs more than a set
  // is judged whole for (src/shop/lodTier.js SET_WHOLE_JUDGEMENT_MAX_TRIANGLES) and is judged by its biggest member.
  const model = new THREE.Group();
  model.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 10, 10, 10), new THREE.MeshBasicMaterial()));
  const mid = make();
  const far = make();
  mid.visible = false;
  far.visible = false;
  object.add(model, mid, far);
  object.userData = {
    instanceId: `${templateId}-${x}-${y}-${z}`, template: templateOf(templateId), model, lodTiers: { mid, far }, lodTiersState: 'ready', groupId,
  };
  object.position.set(x, y, z);
  object.updateMatrixWorld(true);
  return object;
}

function wall(templateId, width, height, { x0 = 0, y = 0, groupId } = {}) {
  const out = [];
  for (let i = 0; i < width; i++) for (let k = 0; k < height; k++) out.push(brick(templateId, x0 + i, y, k, groupId));
  return out;
}

function setup(objects, { target = new THREE.Vector3(500, 500, 0), selected = new Set() } = {}) {
  const scene = new THREE.Scene();
  objects.forEach((object) => scene.add(object));
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, -30, 20);
  camera.updateMatrixWorld(true);
  const lod = createBuildLod({
    camera, target, getMeshes: () => objects, isSelected: (object) => selected.has(object), viewportHeight: () => 844,
  });
  const look = (x, y, z) => {
    camera.position.set(x, y, z);
    camera.updateMatrixWorld(true);
  };
  let clock = 1000;
  const tick = (times = 2) => { for (let n = 0; n < times; n++) { clock += 300; lod.update(clock, true); } };
  const place = (more) => { more.forEach((object) => scene.add(object)); objects.push(...more); };
  return { lod, camera, look, tick, place };
}

const tierOf = (object) => object.userData.lodApplied ?? 'full';
const tiersOf = (objects) => new Set(objects.map(tierOf));

describe('Build judges a wall as one set (#4115)', () => {
  afterEach(() => vi.restoreAllMocks());

  // The camera stands close to one end of the wall and above it: bricks nearest are 12 m away and the far end
  // is 31 m away, which spans the full, mid and far steps for a brick of this size.
  const positions = [[0, -12, 0], [0, -14, 6], [3, -16, 12], [10, -20, 18], [19, -25, 3], [-6, -10, 8]];

  it('would give a wall more than one version at these distances when each brick is judged alone', () => {
    const objects = wall('brick', 20, 20);
    const { lod, look, tick } = setup(objects);
    lod.setImplicitSets(false);
    let mixed = 0;
    for (const position of positions) {
      look(...position);
      tick(3);
      if (tiersOf(objects).size > 1) mixed += 1;
    }
    expect(mixed).toBeGreaterThan(0); // the premise: this is the edge the owner saw
  });

  it('gives every brick of a loose wall the same version, whatever height the camera is at', () => {
    const objects = wall('brick', 20, 20);
    const { lod, look, tick } = setup(objects);
    for (const position of positions) {
      look(...position);
      tick(3);
      expect(tiersOf(objects).size).toBe(1);
    }
    expect(lod.setCount()).toBe(1);
  });

  it('does the same for a bundle (the items sharing a group)', () => {
    const objects = wall('brick', 20, 20, { groupId: 'wall-1' });
    const { look, tick } = setup(objects);
    for (const position of positions) {
      look(...position);
      tick(3);
      expect(tiersOf(objects).size).toBe(1);
    }
  });

  it('leaves a loose item far from the wall to be judged on its own', () => {
    const objects = [...wall('brick', 6, 6), brick('brick', 40, 0, 0)];
    const lone = objects[objects.length - 1];
    const { lod, look, tick } = setup(objects);
    look(0, -14, 3);
    tick(3);
    expect(lod.setCount()).toBe(1);
    expect(lone.userData.lodSetId).toBeUndefined();
    expect(objects[0].userData.lodSetId).toBeDefined();
  });

  it('keeps two products side by side as two sets, each on one version', () => {
    const objects = [...wall('brick', 10, 10), ...wall('stone', 10, 10, { x0: 10 })];
    const { lod, look, tick } = setup(objects);
    look(0, -14, 3);
    tick(3);
    expect(lod.setCount()).toBe(2);
    expect(tiersOf(objects.slice(0, 100)).size).toBe(1);
    expect(tiersOf(objects.slice(100)).size).toBe(1);
  });

  it('holds the whole set at full detail when any member is beside the point being looked at', () => {
    const objects = wall('brick', 20, 20);
    const { look, tick } = setup(objects, { target: new THREE.Vector3(2, 0, 0) });
    look(0, -60, 30); // far: every brick alone would be far
    tick(3);
    expect(tiersOf(objects)).toEqual(new Set(['full']));
  });

  it('never spends a budget on a set it does not fit: the wall drops as one, not half of it', () => {
    const objects = wall('brick', 16, 16); // 256 bricks of 1,200 triangles = 307k, with a budget of 100k
    const { lod, look, tick } = setup(objects);
    lod.setFullTriangleCap(100_000);
    look(0, -14, 6); // close enough that every brick alone would want full detail
    tick(3);
    const tiers = tiersOf(objects);
    expect(tiers.size).toBe(1);
    expect(tiers.has('full')).toBe(false); // over the budget: reduced, all of it
  });

  it('judges the selected item on its own: always full, while the rest of the wall stays together', () => {
    const objects = wall('brick', 20, 20);
    const selected = new Set([objects[399]]);
    const { look, tick } = setup(objects, { selected });
    look(0, -60, 30);
    tick(3);
    expect(tierOf(objects[399])).toBe('full');
    expect(tiersOf(objects.slice(0, 399)).size).toBe(1);
    expect(tiersOf(objects.slice(0, 399)).has('full')).toBe(false);
  });

  it('keeps the set on one version across several passes when the time slice runs out', () => {
    const left = wall('brick', 16, 16); // 256 bricks of 1,200 triangles: more than a set is judged whole for
    const right = wall('stone', 16, 16, { x0: 20 });
    const objects = [...left, ...right];
    const { look, tick } = setup(objects);
    look(10, -90, 40); // far away: both on far
    tick(3);
    expect(tiersOf(objects)).toEqual(new Set(['far']));
    // Every call to the clock advances 5 ms, so a pass flips only a couple of items before its slice is spent.
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 5));
    look(10, -14, 6); // close: both want to change
    const partlyChanged = () => [left, right].filter((set) => tiersOf(set).size > 1).length;
    let sawPartial = false;
    for (let n = 0; n < 800 && tiersOf(objects).size > 0; n++) {
      tick(1);
      // At most one set is part way over at any frame, and the other is either all changed or not started.
      expect(partlyChanged()).toBeLessThanOrEqual(1);
      if (partlyChanged() === 1) sawPartial = true;
      if (tiersOf(left).size === 1 && tiersOf(right).size === 1 && tiersOf(objects).size <= 2 && !tiersOf(objects).has('far')) break;
    }
    expect(sawPartial).toBe(true); // the premise: a set did take more than one pass
    expect(tiersOf(left).size).toBe(1);
    expect(tiersOf(right).size).toBe(1);
  });

  it('works the sets out again after the layout changes and stands still', () => {
    const objects = wall('brick', 6, 6);
    const { lod, look, tick, place } = setup(objects);
    look(0, -14, 3);
    tick(3);
    expect(lod.setCount()).toBe(1);
    // A second wall is placed beside it.
    place(wall('stone', 6, 6, { x0: 10 }));
    tick(1); // changed this pass
    tick(2); // and unchanged since: the sets are found again
    expect(lod.setCount()).toBe(2);
  });

  it('leaves no trace on what the builder sees: no bundle id appears on a loose item, and each stays its own item', () => {
    const objects = wall('brick', 6, 6);
    const ids = objects.map((object) => object.userData.instanceId);
    const { look, tick } = setup(objects);
    look(0, -14, 3);
    tick(3);
    for (const object of objects) expect(object.userData.groupId).toBeUndefined();
    expect(objects.map((object) => object.userData.instanceId)).toEqual(ids);
    expect(objects.every((object) => object.parent !== null)).toBe(true);
  });
});
