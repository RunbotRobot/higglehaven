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

  it('changes a set whole, in one pass, even when it is larger than the slice and another set waits its turn', () => {
    const left = wall('brick', 16, 16); // 256 bricks
    const right = wall('stone', 16, 16, { x0: 20 });
    const objects = [...left, ...right];
    const { look, tick } = setup(objects);
    look(10, -90, 40); // far away: both on far
    // 512 bricks are over SMALL_JOB_ITEMS, so the sets are found in slices of the real clock; with a loaded machine
    // three ticks are not always enough. A clock that does not move gives every slice the whole job, so the start
    // does not depend on how fast the machine is (the assertion below is unchanged).
    const frozen = vi.spyOn(performance, 'now').mockReturnValue(0);
    tick(3);
    expect(tiersOf(objects)).toEqual(new Set(['far']));
    frozen.mockRestore();
    // Every call to the clock advances 50 ms, so a pass is out of slice after its first set.
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 50));
    look(10, -14, 6); // close: both want to change
    let passes = 0;
    for (let n = 0; n < 40 && !(tiersOf(left).size === 1 && tiersOf(right).size === 1 && !tiersOf(objects).has('far')); n++) {
      tick(1);
      passes += 1;
      expect(tiersOf(left).size).toBe(1); // never part way over
      expect(tiersOf(right).size).toBe(1);
    }
    expect(tiersOf(objects).has('far')).toBe(false);
    expect(passes).toBeGreaterThan(1); // the second set did wait for a later pass
  });

  const fullTriangles = (objects) => objects.filter((object) => tierOf(object) === 'full').length * 1200;

  it('keeps a selection inside the triangle budget: selecting everything does not draw it all in full', () => {
    const objects = wall('brick', 20, 15); // 300 bricks of 1,200 triangles
    const { lod, look, tick } = setup(objects, { selected: new Set(objects) });
    lod.setFullTriangleCap(100_000);
    look(0, -14, 6);
    tick(3);
    expect(fullTriangles(objects)).toBeLessThanOrEqual(100_000 + 1200);
    expect(fullTriangles(objects)).toBeGreaterThan(0);
  });

  it('keeps a selected bundle inside the triangle budget', () => {
    const objects = wall('brick', 20, 15, { groupId: 'big' });
    const { lod, look, tick } = setup(objects, { selected: new Set(objects) });
    lod.setFullTriangleCap(100_000);
    look(0, -14, 6);
    tick(3);
    expect(fullTriangles(objects)).toBeLessThanOrEqual(100_000 + 1200);
  });

  it('keeps the selected item full while a wall beside it competes for the budget', () => {
    const objects = wall('brick', 12, 12);
    const far = objects[objects.length - 1]; // the far corner, not the one nearest the target
    const { lod, look, tick } = setup(objects, { selected: new Set([far]), target: new THREE.Vector3(0, 0, 0) });
    lod.setFullTriangleCap(3 * 1200);
    look(0, -14, 6);
    tick(3);
    expect(tierOf(far)).toBe('full');
  });

  it('keeps the part of a too-heavy set around the orbit target full, within the budget, and drops the rest as one', () => {
    const objects = wall('brick', 20, 15); // 300 bricks, 360k triangles
    const { lod, look, tick } = setup(objects, { target: new THREE.Vector3(2, 0, 0) });
    lod.setFullTriangleCap(100_000); // the set does not fit
    look(2, -4, 3);
    tick(3);
    const full = objects.filter((object) => tierOf(object) === 'full');
    expect(full.length).toBeGreaterThan(0); // the nearest bricks are not all dropped
    expect(full.length * 1200).toBeLessThanOrEqual(100_000 + 1200);
    const dropped = objects.filter((object) => tierOf(object) !== 'full');
    expect(new Set(dropped.map(tierOf)).size).toBe(1); // the far part is on one version
    // and they are the ones near the target that stayed
    expect(Math.max(...full.map((object) => Math.hypot(object.position.x - 2, object.position.y)))).toBeLessThan(Math.min(...dropped.map((object) => Math.hypot(object.position.x - 2, object.position.y))) + 0.01);
  });

  it('holds several near sets whole together only while they fit the budget, nearest first', () => {
    const a = wall('brick', 6, 6); // 36 bricks, 43k triangles
    const b = wall('stone', 6, 6, { x0: 20 }); // outside the 13 m ring
    const objects = [...a, ...b];
    const { lod, look, tick } = setup(objects, { target: new THREE.Vector3(3, 0, 0) });
    lod.setFullTriangleCap(60_000); // room for one
    look(3, -10, 5);
    tick(3);
    expect(tiersOf(a)).toEqual(new Set(['full'])); // the nearer one
    expect(tiersOf(b).has('full')).toBe(true); // what the budget has room for, nearest first, as for a loose wall
    expect(tiersOf(b.filter((object) => tierOf(object) !== 'full')).size).toBe(1); // and the rest of it on one version
    expect(fullTriangles(objects)).toBeLessThanOrEqual(60_000 + 1200);
  });

  it('does not flip a whole wall that is full for a marginal overflow', () => {
    const objects = wall('brick', 12, 12); // 144 bricks, 172,800 triangles
    const { lod, look, tick } = setup(objects, { target: new THREE.Vector3(500, 500, 0) });
    lod.setFullTriangleCap(1_000_000);
    look(0, -14, 6);
    tick(3);
    expect(tiersOf(objects)).toEqual(new Set(['full']));
    lod.setFullTriangleCap(160_000); // the budget now cuts about 7% of the wall
    tick(3);
    expect(tiersOf(objects)).toEqual(new Set(['full']));
    lod.setFullTriangleCap(60_000); // a real overflow
    tick(3);
    expect(tiersOf(objects).has('mid')).toBe(true);
    expect(fullTriangles(objects)).toBeLessThanOrEqual(60_000 + 1200);
    expect(tiersOf(objects.filter((object) => tierOf(object) !== 'full')).size).toBe(1);
  });

  it('keeps a brick just outside the ring full where the budget has room, and drops only the far part', () => {
    // A line of 40 bricks, the target at x=5: the ring covers x up to about 15, a brick at 17 is just outside it.
    const objects = Array.from({ length: 40 }, (_, i) => brick('brick', i, 0, 0));
    const { lod, look, tick } = setup(objects, { target: new THREE.Vector3(5, 0, 0) });
    lod.setFullTriangleCap(40_000); // the 48k wall does not fit whole; 33 bricks do
    look(5, -6, 3);
    tick(4);
    expect(tierOf(objects[17])).toBe('full'); // main drew it full: so does this
    expect(tierOf(objects[39])).not.toBe('full');
    expect(tiersOf(objects.slice(36)).size).toBe(1);
    expect(fullTriangles(objects)).toBeLessThanOrEqual(40_000 + 1200);
  });

  it('does not swap two near sets between full and reduced as the target moves a few centimetres', () => {
    const a = wall('brick', 6, 6); // x 0..5
    const b = wall('stone', 6, 6, { x0: 7 }); // x 7..12
    const objects = [...a, ...b];
    const target = new THREE.Vector3(6, 0, 0); // between them
    const { lod, look, tick } = setup(objects, { target });
    lod.setFullTriangleCap(60_000); // one of them fits whole, not both
    look(6, -12, 5);
    tick(4);
    const snapshot = () => objects.map(tierOf).join(',');
    const settled = snapshot();
    for (let n = 0; n < 24; n++) {
      target.x = 6 + (n % 2 === 0 ? 0.04 : -0.04) + (n % 4 < 2 ? 0.01 : -0.01);
      tick(1);
      expect(snapshot()).toBe(settled);
    }
  });

  it('does not let a set whose versions never arrive hold up another set', () => {
    const stuck = wall('brick', 6, 6);
    const free = wall('stone', 6, 6, { x0: 20 });
    stuck[0].userData.lodTiersState = 'loading'; // never becomes ready
    const objects = [...stuck, ...free];
    const { look, tick } = setup(objects);
    look(10, -90, 40);
    tick(4);
    expect(tiersOf(free).has('full')).toBe(false); // it changed, the stuck set did not hold it
    expect(tiersOf(stuck.slice(1)).has('far')).toBe(false); // the stuck set waits as a whole, unchanged
  });

  it('is not reset by a member without a tier yet: a newly placed item does not change the wall', () => {
    const objects = wall('brick', 6, 6);
    const { look, tick, place } = setup(objects);
    look(0, -14, 3);
    tick(3);
    const before = [...tiersOf(objects)];
    const fresh = brick('brick', 6, 0, 0);
    delete fresh.userData.lodTier;
    place([fresh]);
    tick(1);
    expect([...tiersOf(objects.slice(0, 36))]).toEqual(before);
  });

  // #4208: the first pass has found no sets yet, so no item changes version in it; the wall then changes as one.
  it('changes nothing in the first pass, then gives the whole wall one version', () => {
    const objects = wall('brick', 20, 20);
    const { lod, look, tick } = setup(objects);
    look(0, -12, 0);
    tick(1);
    expect(tiersOf(objects)).toEqual(new Set(['full']));
    tick(3);
    expect(lod.setCount()).toBe(1);
    expect(tiersOf(objects).size).toBe(1);
  });

  // #4208 (review): the hold is per item, as Shop's is: an item no finished set job has looked at keeps what it is drawn at.
  it('holds a wall that arrives after an empty first layout until a job has covered it', () => {
    const objects = [];
    const { lod, look, tick, place } = setup(objects);
    look(0, -12, 0);
    tick(2); // an empty layout: its job finishes at once, and says nothing about a wall that is not there yet
    place(wall('brick', 20, 20));
    tick(1);
    expect(tiersOf(objects)).toEqual(new Set(['full']));
    tick(3);
    expect(lod.setCount()).toBe(1);
    expect(tiersOf(objects).size).toBe(1);
  });

  it('holds items that stream in later until a job has covered them, then they join the wall', () => {
    const objects = wall('brick', 10, 20);
    const { lod, look, tick, place } = setup(objects);
    look(0, -12, 0);
    tick(4);
    const more = wall('brick', 10, 20, { x0: 10 });
    place(more);
    tick(1);
    expect(tiersOf(more)).toEqual(new Set(['full']));
    tick(4);
    expect(lod.setCount()).toBe(1);
    expect(tiersOf(objects).size).toBe(1);
  });

  it('lets a held item in at the version it is drawn at, not at a version no set has judged', () => {
    const objects = wall('brick', 20, 20);
    const late = objects[objects.length - 1];
    late.userData.lodTiersState = 'loading'; // its versions are still on their way
    const { lod, look, tick } = setup(objects);
    look(0, -12, 0);
    lod.holdNew(late);
    late.userData.lodTiersState = 'ready'; // they have attached
    tick(1);
    expect(tierOf(late)).toBe('full');
  });

  it('serves a selected item in the first pass, and a reset starts a first load again', () => {
    const objects = wall('brick', 20, 20);
    const selected = new Set([objects[0]]);
    const { lod, look, tick } = setup(objects, { selected });
    look(0, -12, 0);
    tick(1);
    expect(tierOf(objects[0])).toBe('full');
    tick(4);
    expect(lod.setCount()).toBe(1);
    lod.reset();
    expect(lod.setCount()).toBe(0);
    look(0, -40, 10);
    tick(1);
    const before = objects.map(tierOf);
    expect(objects.map(tierOf)).toEqual(before);
    tick(4);
    expect(lod.setCount()).toBe(1);
  });

  // #4208 (review): the hold must not take the selected item's first call on the cap, and the cap holds once released.
  it('keeps a selected item at full under the cap while the wall is held, and the cap holds once the wall is covered', () => {
    const objects = wall('brick', 20, 20);
    const selected = new Set([objects[objects.length - 1]]); // the far end of the wall
    const { lod, look, tick } = setup(objects, { selected });
    lod.setProtectNear(false);
    lod.setFullTriangleCap(24 * 1200); // room for about twenty of these bricks in full
    look(0, -12, 0);
    tick(1);
    expect(tierOf(objects[objects.length - 1])).toBe('full');
    tick(5); // the set job has finished and covered the wall
    expect(lod.setCount()).toBe(1);
    expect(tierOf(objects[objects.length - 1])).toBe('full'); // still first on the cap
    const others = objects.slice(0, -1);
    expect(tiersOf(others).has('full')).toBe(false); // the wall itself no longer fits, so it is on one reduced version
    expect(tiersOf(others).size).toBe(1);
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
