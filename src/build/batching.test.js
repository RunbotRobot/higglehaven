import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createBuildBatching, shownRoot } from './batching.js';

const template = { templateId: 'brick', modelUrl: '/models/brick.glb', dimensions: { width: 1, depth: 1, height: 1 } };
const sharedGeometry = new THREE.BoxGeometry(1, 1, 1);
const sharedMaterial = new THREE.MeshStandardMaterial();

// An item the way createMeshForInstance builds it: a container whose userData.model is the full
// version and whose mid version is a hidden child.
function item(id, x, { withMid = false } = {}) {
  const object = new THREE.Group();
  const model = new THREE.Group();
  model.add(new THREE.Mesh(sharedGeometry, sharedMaterial));
  object.add(model);
  object.userData = { instanceId: id, template, crop: {}, scale: 1, model };
  if (withMid) {
    const mid = new THREE.Group();
    mid.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), sharedMaterial));
    mid.visible = false;
    object.add(mid);
    object.userData.lodTiers = { mid };
  }
  object.position.set(x, 0, 0);
  object.updateMatrixWorld(true);
  return object;
}

function setup(count, options) {
  const scene = new THREE.Scene();
  const selected = new Set();
  const batching = createBuildBatching({ scene, isSelected: (object) => selected.has(object) });
  const objects = Array.from({ length: count }, (_, index) => item(`i${index}`, index * 2, options));
  objects.forEach((object) => scene.add(object));
  return { scene, selected, batching, objects };
}

describe('Build batching', () => {
  it('splits a long row into batches by the square of ground the items stand on', () => {
    const { batching, objects } = setup(24); // 2 m apart: x from 0 to 46, three 16 m squares
    batching.sync(objects);
    const counts = batching.counts();
    expect(counts.groups).toBe(3);
    expect(counts.items).toBe(24);
  });


  it('draws identical unselected items with one instanced mesh and hides their own copies', () => {
    const { scene, batching, objects } = setup(6);
    batching.sync(objects);
    expect(batching.counts()).toEqual({ groups: 1, items: 6, drawCalls: 1 });
    const instanced = scene.children.filter((child) => child.isInstancedMesh);
    expect(instanced).toHaveLength(1);
    expect(instanced[0].count).toBe(6);
    for (const object of objects) expect(object.userData.model.visible).toBe(false);
  });

  it('puts each item at its own place: instance i is item i, parts offset included', () => {
    const { scene, batching, objects } = setup(5);
    batching.sync(objects);
    const mesh = scene.children.find((child) => child.isInstancedMesh);
    const out = new THREE.Matrix4();
    const position = new THREE.Vector3();
    objects.forEach((object, index) => {
      mesh.getMatrixAt(index, out);
      position.setFromMatrixPosition(out);
      expect(position.x).toBeCloseTo(object.position.x);
    });
  });

  it('keeps every item in the scene with its raycast intact, so a tap still finds it', () => {
    const { batching, objects } = setup(5);
    batching.sync(objects);
    const raycaster = new THREE.Raycaster(new THREE.Vector3(2, -5, 0), new THREE.Vector3(0, 1, 0));
    const hits = raycaster.intersectObjects(objects, true);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].object.parent.parent).toBe(objects[1]);
  });

  it('leaves a selected item alone and batches the rest', () => {
    const { batching, selected, objects } = setup(6);
    selected.add(objects[2]);
    batching.sync(objects);
    expect(batching.counts().items).toBe(5);
    expect(objects[2].userData.model.visible).toBe(true);
    expect(objects[0].userData.model.visible).toBe(false);
  });

  it('gives an item back its own copy when it is selected, and rebuilds the batch without it', () => {
    const { scene, batching, selected, objects } = setup(6);
    batching.sync(objects);
    selected.add(objects[0]);
    batching.sync(objects);
    expect(objects[0].userData.model.visible).toBe(true);
    expect(batching.counts().items).toBe(5);
    expect(scene.children.filter((child) => child.isInstancedMesh)).toHaveLength(1);
  });

  it('does not batch a handful: below the minimum every item draws itself', () => {
    const { scene, batching, objects } = setup(3);
    batching.sync(objects);
    expect(batching.counts().items).toBe(0);
    expect(scene.children.some((child) => child.isInstancedMesh)).toBe(false);
    for (const object of objects) expect(object.userData.model.visible).toBe(true);
  });

  it('restores items when a batch shrinks below the minimum', () => {
    const { batching, selected, objects } = setup(5);
    batching.sync(objects);
    selected.add(objects[0]);
    selected.add(objects[1]);
    batching.sync(objects);
    expect(batching.counts().items).toBe(0);
    for (const object of objects) expect(object.userData.model.visible).toBe(true);
  });

  it('follows a moved item: the matrix is rewritten on the next sync', () => {
    const { scene, batching, objects } = setup(5);
    batching.sync(objects);
    objects[3].position.x = 12; // still inside the same 16 m square
    objects[3].updateMatrixWorld(true);
    batching.sync(objects);
    const mesh = scene.children.find((child) => child.isInstancedMesh);
    const out = new THREE.Matrix4();
    mesh.getMatrixAt(3, out);
    expect(new THREE.Vector3().setFromMatrixPosition(out).x).toBeCloseTo(12);
  });

  it('moves an item into the batch of the square it was moved to', () => {
    const { batching, objects } = setup(14); // x 0..26: squares 0 and 1
    batching.sync(objects);
    expect(batching.counts().groups).toBe(2);
    objects[0].position.x = 20;
    objects[0].updateMatrixWorld(true);
    batching.sync(objects);
    expect(batching.counts()).toEqual({ groups: 2, items: 14, drawCalls: 2 });
  });

  it('does not rebuild a batch that has not changed', () => {
    const { scene, batching, objects } = setup(5);
    batching.sync(objects);
    const first = scene.children.find((child) => child.isInstancedMesh);
    batching.sync(objects);
    expect(scene.children.find((child) => child.isInstancedMesh)).toBe(first);
  });

  it('drops a removed item from the batch', () => {
    const { scene, batching, objects } = setup(6);
    batching.sync(objects);
    scene.remove(objects[5]);
    batching.sync(objects.slice(0, 5));
    expect(batching.counts().items).toBe(5);
    expect(scene.children.find((child) => child.isInstancedMesh).count).toBe(5);
  });

  it('batches by the version being shown: a mid-version item is drawn from its mid copy', () => {
    const { scene, batching, objects } = setup(6, { withMid: true });
    for (const object of objects.slice(0, 4)) {
      object.userData.lodShown = 'mid';
      object.userData.model.visible = false;
      object.userData.lodTiers.mid.visible = true;
    }
    batching.sync(objects);
    expect(batching.counts().groups).toBe(1);
    expect(batching.counts().items).toBe(4);
    expect(shownRoot(objects[0])).toBe(objects[0].userData.lodTiers.mid);
    expect(objects[0].userData.lodTiers.mid.visible).toBe(false);
    expect(objects[5].userData.model.visible).toBe(true); // two full ones: below the minimum
    expect(scene.children.filter((child) => child.isInstancedMesh)).toHaveLength(1);
  });

  it('batches items near the orbit target too: they draw in full, identically', () => {
    const { batching, objects } = setup(6);
    objects[1].userData.lodProtected = true;
    batching.sync(objects);
    expect(batching.counts().items).toBe(6);
  });

  it('releaseNow gives an item its own copy at once and silences its instance', () => {
    const { scene, batching, selected, objects } = setup(6);
    batching.sync(objects);
    selected.add(objects[2]);
    batching.releaseNow(objects[2]);
    expect(objects[2].userData.model.visible).toBe(true);
    const mesh = scene.children.find((child) => child.isInstancedMesh);
    const out = new THREE.Matrix4();
    mesh.getMatrixAt(2, out);
    expect(out.elements[0]).toBe(0); // scaled to nothing
    mesh.getMatrixAt(3, out);
    expect(out.elements[0]).toBe(1); // the others still draw
    batching.sync(objects);
    expect(batching.counts().items).toBe(5);
    expect(objects[2].userData.model.visible).toBe(true);
  });

  it('releaseNow on an item that is not batched only shows it', () => {
    const { batching, objects } = setup(2);
    batching.sync(objects);
    batching.releaseNow(objects[0]);
    expect(objects[0].userData.model.visible).toBe(true);
  });

  it('never batches a cropped item, a sign or an item without a model', () => {
    const { batching, objects } = setup(8);
    objects[0].userData.crop = { x: 0.5 };
    objects[1].userData.isCommunitySign = true;
    objects[2].userData.model = undefined;
    batching.sync(objects);
    expect(batching.counts().items).toBe(5);
  });

  it('does nothing while switched off', () => {
    const { batching, objects } = setup(6);
    batching.setEnabled(false);
    batching.sync(objects);
    expect(batching.counts().items).toBe(0);
    for (const object of objects) expect(object.userData.model.visible).toBe(true);
  });

  // #4003: an item waiting for its simpler versions is not drawn at all, so it is never batched.
  it('leaves an item that is held back out of every batch and keeps it undrawn', () => {
    const { batching, objects } = setup(6);
    objects[2].userData.lodHeld = true;
    objects[2].userData.model.visible = false;
    batching.sync(objects);
    expect(batching.counts().items).toBe(5);
    expect(objects[2].userData.model.visible).toBe(false);
    expect(objects[2].userData.batchRoot).toBeUndefined();
  });

  it('does not batch an item whose materials are dissolving in, and batches it once it has arrived (#4003)', () => {
    const { scene, batching, objects } = setup(6);
    objects[0].userData.lodArriving = true;
    batching.sync(objects);
    expect(batching.counts().items).toBe(5);
    expect(objects[0].userData.model.visible).toBe(true);
    objects[0].userData.lodArriving = false;
    batching.sync(objects);
    expect(batching.counts().items).toBe(6);
    expect(scene.children.filter((child) => child.isInstancedMesh)).toHaveLength(1);
  });
});

// #4115 (part 2): a change of version dissolves in Build as it does in Shop.
describe('Build batching: a change of version dissolves (#4115)', () => {
  function fadeSetup(count, options = {}) {
    const scene = new THREE.Scene();
    let now = 1000;
    const levels = [];
    let restored = 0;
    const batching = createBuildBatching({
      scene, isSelected: () => false, clock: () => now, reducedMotion: () => false,
      createDissolve: () => ({ setLevel: (level) => levels.push(level), restore: () => { restored += 1; } }),
      ...options,
    });
    const objects = Array.from({ length: count }, (_, index) => item(`f${index}`, index * 2, { withMid: true }));
    objects.forEach((object) => scene.add(object));
    return { scene, batching, objects, levels, tick: (ms) => { now += ms; batching.update(now); }, restoredCount: () => restored };
  }
  const flipToMid = (objects) => objects.forEach((object) => { object.userData.lodShown = 'mid'; });
  const instanced = (scene) => scene.children.filter((child) => child.isInstancedMesh);

  it('keeps the old version drawing while the new one dissolves in, then gives the old one back', () => {
    const { scene, batching, objects, levels, tick, restoredCount } = fadeSetup(6);
    batching.sync(objects);
    expect(instanced(scene)).toHaveLength(1);
    flipToMid(objects);
    batching.sync(objects);
    expect(batching.fadesInFlight).toBe(1);
    expect(instanced(scene)).toHaveLength(2); // the full version and the mid version
    expect(levels[0]).toBe(0);
    tick(200);
    expect(levels[levels.length - 1]).toBeCloseTo(0.5);
    expect(batching.fadesInFlight).toBe(1);
    tick(250);
    expect(batching.fadesInFlight).toBe(0);
    expect(restoredCount()).toBe(1);
    expect(instanced(scene)).toHaveLength(1);
    expect(batching.counts().items).toBe(6);
  });

  it('does not fade a group that only changed its members, not its version', () => {
    const { scene, batching, objects } = fadeSetup(6);
    batching.sync(objects);
    objects[0].userData.lodHeld = true; // leaves the batch; the rest stay on the same version
    batching.sync(objects);
    expect(batching.fadesInFlight).toBe(0);
    expect(instanced(scene)).toHaveLength(1);
  });

  it('swaps at once under reduced motion', () => {
    const { scene, batching, objects } = fadeSetup(6, { reducedMotion: () => true });
    batching.sync(objects);
    flipToMid(objects);
    batching.sync(objects);
    expect(batching.fadesInFlight).toBe(0);
    expect(instanced(scene)).toHaveLength(1);
  });

  it('swaps at once when both versions together would pass the triangle bound', () => {
    const { scene, batching, objects } = fadeSetup(6, { maxTriangles: 10 });
    batching.sync(objects);
    flipToMid(objects);
    batching.sync(objects);
    expect(batching.fadesInFlight).toBe(0);
    expect(instanced(scene)).toHaveLength(1);
  });

  it('swaps at once when no more fades may run', () => {
    const { batching, objects } = fadeSetup(6, { maxCohorts: 0 });
    batching.sync(objects);
    flipToMid(objects);
    batching.sync(objects);
    expect(batching.fadesInFlight).toBe(0);
  });

  it('zeroes an item that is selected mid-fade in the old version too, so nothing is left under a drag', () => {
    const { scene, batching, objects } = fadeSetup(6);
    batching.sync(objects);
    flipToMid(objects);
    batching.sync(objects);
    batching.releaseNow(objects[0]);
    const out = new THREE.Matrix4();
    for (const mesh of instanced(scene)) {
      mesh.getMatrixAt(0, out);
      expect(out.elements[0]).toBe(0); // zero scale: not drawn
    }
  });

  it('finishAll settles a running fade', () => {
    const { scene, batching, objects, restoredCount } = fadeSetup(6);
    batching.sync(objects);
    flipToMid(objects);
    batching.sync(objects);
    batching.finishAll();
    expect(batching.fadesInFlight).toBe(0);
    expect(restoredCount()).toBe(1);
    expect(instanced(scene)).toHaveLength(1);
  });
});

describe('Build batching: what the bounds cannot take yet waits (#4235)', () => {
  // Two squares of ground (BATCH_CELL_M is 16 m), so two groups that can change version on their own.
  function twoCells(options = {}) {
    const scene = new THREE.Scene();
    let now = 1000;
    const batching = createBuildBatching({
      scene, isSelected: () => false, clock: () => now, reducedMotion: () => false,
      createDissolve: () => ({ setLevel: () => {}, restore: () => {} }),
      ...options,
    });
    const near = Array.from({ length: 6 }, (_, index) => item(`n${index}`, index * 2, { withMid: true }));
    const far = Array.from({ length: 6 }, (_, index) => item(`w${index}`, 32 + index * 2, { withMid: true }));
    const objects = [...near, ...far];
    objects.forEach((object) => scene.add(object));
    const flip = (list, tier = 'mid') => list.forEach((object) => { object.userData.lodShown = tier; });
    const instanced = () => scene.children.filter((child) => child.isInstancedMesh);
    const m = new THREE.Matrix4();
    // The instanced meshes drawing the items whose first instance stands near x.
    const meshesAt = (x) => instanced().filter((mesh) => { mesh.getMatrixAt(0, m); return Math.abs(m.elements[12] - x) < 0.5; });
    return { scene, batching, near, far, meshesAt, objects, flip, instanced, at: (ms) => { now = ms; batching.update(now); }, now: () => now };
  }

  it('keeps the old version drawing while the fade caps are busy, then fades it in when there is room', () => {
    const w = twoCells({ maxCohorts: 1 });
    w.batching.sync(w.objects);
    w.flip(w.near);
    w.batching.sync(w.objects); // the first group fades: the only cohort allowed
    w.flip(w.far);
    w.batching.sync(w.objects); // the second must wait
    expect(w.batching.fadesInFlight).toBe(1);
    expect(w.batching.hardSwapCount).toBe(0);
    expect(w.batching.waitingGroups).toBe(true);
    // near: full + mid; far: still its full version only (the new mid group was taken back)
    expect(w.instanced()).toHaveLength(3);
    expect(w.batching.counts().items).toBe(12);
    w.at(w.now() + 450); // the first fade ends
    w.batching.sync(w.objects);
    expect(w.batching.fadesInFlight).toBe(1); // the second fades now
    expect(w.batching.fadesStarted).toBe(2);
    expect(w.batching.hardSwapCount).toBe(0);
    expect(w.batching.waitingGroups).toBe(false);
    w.at(w.now() + 450);
    expect(w.batching.fadesInFlight).toBe(0);
    expect(w.instanced()).toHaveLength(2);
  });

  it('swaps at once, and counts it, when the change could never fit', () => {
    const w = twoCells({ maxTriangles: 10 });
    w.batching.sync(w.objects);
    w.flip(w.near);
    w.batching.sync(w.objects);
    expect(w.batching.fadesInFlight).toBe(0);
    expect(w.batching.hardSwapCount).toBe(6);
    expect(w.batching.waitingGroups).toBe(false);
  });

  it('swaps at once when nothing is running to make room', () => {
    const w = twoCells({ maxCohorts: 0 });
    w.batching.sync(w.objects);
    w.flip(w.near);
    w.batching.sync(w.objects);
    expect(w.batching.hardSwapCount).toBe(6);
  });

  it('gives up waiting only when no fade has been admitted for the wait limit', () => {
    const w = twoCells({ maxCohorts: 1, durationMs: 1e9, maxWaitMs: 100 });
    w.batching.sync(w.objects);
    w.flip(w.near);
    w.batching.sync(w.objects); // admitted; it never ends
    w.flip(w.far);
    w.at(w.now() + 50);
    w.batching.sync(w.objects); // waits
    expect(w.batching.hardSwapCount).toBe(0);
    w.at(w.now() + 60);
    w.batching.sync(w.objects); // still within the limit
    expect(w.batching.hardSwapCount).toBe(0);
    w.at(w.now() + 200);
    w.batching.sync(w.objects); // the limit passed with nothing admitted
    expect(w.batching.hardSwapCount).toBe(6);
    expect(w.batching.waitingGroups).toBe(false);
  });

  it('does not carry an old wait over to a later change', () => {
    const w = twoCells({ maxCohorts: 1, maxWaitMs: 100 });
    w.batching.sync(w.objects);
    w.flip(w.near);
    w.batching.sync(w.objects);
    w.flip(w.far);
    w.batching.sync(w.objects); // waits
    w.at(w.now() + 450);
    w.batching.sync(w.objects); // admitted: the wait is over
    expect(w.batching.waitingGroups).toBe(false);
    w.at(w.now() + 450);
    w.flip(w.near, 'full'); // a new change much later: it fades at once, no stale timer
    w.batching.sync(w.objects);
    expect(w.batching.hardSwapCount).toBe(0);
    expect(w.batching.fadesStarted).toBe(3);
  });

  it('stops drawing, in the old group, an item that is held while its group waits', () => {
    const w = twoCells({ maxCohorts: 1 });
    w.batching.sync(w.objects);
    w.flip(w.near);
    w.batching.sync(w.objects);
    w.flip(w.far);
    w.far[1].userData.lodHeld = true; // leaves the batch while its group waits
    w.batching.sync(w.objects);
    const out = new THREE.Matrix4();
    const oldFar = w.meshesAt(32);
    expect(oldFar).toHaveLength(1); // only the old version draws there; the mid group was taken back
    oldFar[0].getMatrixAt(1, out);
    expect(out.elements[0]).toBe(0); // zero scale: not drawn
  });

  it('an item selected while its group waits is zeroed in the old group and drawn as itself', () => {
    const w = twoCells({ maxCohorts: 1 });
    w.batching.sync(w.objects);
    w.flip(w.near);
    w.batching.sync(w.objects);
    w.flip(w.far);
    w.batching.sync(w.objects); // waits
    w.batching.releaseNow(w.far[1]);
    const out = new THREE.Matrix4();
    const oldFar = w.meshesAt(32);
    expect(oldFar).toHaveLength(1);
    oldFar[0].getMatrixAt(1, out);
    expect(out.elements[0]).toBe(0);
    expect(w.far[1].userData.lodTiers.mid.visible).toBe(true); // its own copy of what it now shows
  });

  it('makes the biggest waiting group go first', () => {
    const w = twoCells({ maxCohorts: 1, maxTriangles: 200 }); // room for one of the two at a time
    w.far.push(item('w6', 44, { withMid: true }), item('w7', 46, { withMid: true }));
    w.far.slice(6).forEach((object) => { w.scene.add(object); w.objects.push(object); });
    w.batching.sync(w.objects);
    w.flip(w.near);
    w.batching.sync(w.objects); // the near group fades; the cohort slot is busy
    w.flip(w.far); // eight bricks wait
    w.flip(w.near, 'full');
    w.batching.sync(w.objects); // both want a turn; both wait
    w.at(w.now() + 450);
    w.batching.sync(w.objects);
    expect(w.batching.fadesInFlight).toBe(1);
    // the far group (8 items) was admitted before the near one (6): it has its old and new version drawing
    expect(w.meshesAt(32)).toHaveLength(2);
    expect(w.meshesAt(0)).toHaveLength(1);
  });
  it('an 829-brick wall changing version in slices has no item that swaps in one frame', () => {
    // The real sizes: 5,320 / 1,282 / 34 triangles. Walking up to the wall, far to mid: before #4235 about 120 to 190
    // bricks of it swapped at once.
    const geometryOf = (triangles) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(triangles * 3), 1));
      return geometry;
    };
    const full = geometryOf(5320);
    const mid = geometryOf(1282);
    const far = geometryOf(34);
    const scene = new THREE.Scene();
    let now = 1000;
    const batching = createBuildBatching({ scene, isSelected: () => false, clock: () => now, reducedMotion: () => false, createDissolve: () => ({ setLevel: () => {}, restore: () => {} }) });
    const wall = [];
    for (let row = 0; row < 21; row++) {
      for (let column = 0; column < 40 && wall.length < 829; column++) {
        const object = new THREE.Group();
        const model = new THREE.Group();
        model.add(new THREE.Mesh(full, sharedMaterial));
        const reduced = new THREE.Group();
        reduced.add(new THREE.Mesh(mid, sharedMaterial));
        reduced.visible = false;
        const distant = new THREE.Group();
        distant.add(new THREE.Mesh(far, sharedMaterial));
        object.add(model, reduced, distant);
        model.visible = false;
        object.userData = { instanceId: `wall${wall.length}`, template, crop: {}, scale: 1, model, lodTiers: { mid: reduced, far: distant }, lodShown: 'far' };
        object.position.set(column * 0.7, 0, row * 0.3);
        object.updateMatrixWorld(true);
        scene.add(object);
        wall.push(object);
      }
    }
    batching.sync(wall);
    let flipped = 0;
    while (flipped < wall.length) {
      for (let k = 0; k < 20 && flipped < wall.length; k++) {
        const object = wall[flipped++];
        object.userData.lodShown = 'mid';
        object.userData.lodTiers.far.visible = false;
        object.userData.lodTiers.mid.visible = true;
      }
      batching.sync(wall);
      now += 250;
      batching.update(now);
    }
    expect(batching.hardSwapCount).toBe(0);
    expect(batching.fadesStarted).toBeGreaterThan(10);
  });
  // Items whose full version is dearer than their mid one (the usual case), in two squares of ground.
  function dearFull(options = {}) {
    const geometryOf = (triangles) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(triangles * 3), 1));
      return geometry;
    };
    const full = geometryOf(100);
    const mid = geometryOf(10);
    const scene = new THREE.Scene();
    let now = 1000;
    const added = [];
    const baseAdd = scene.add.bind(scene);
    scene.add = (...objects) => { added.push(...objects.filter((object) => object.isInstancedMesh)); return baseAdd(...objects); };
    const batching = createBuildBatching({ scene, isSelected: () => false, clock: () => now, reducedMotion: () => false, createDissolve: () => ({ setLevel: () => {}, restore: () => {} }), ...options });
    const make = (id, x) => {
      const object = new THREE.Group();
      const model = new THREE.Group();
      model.add(new THREE.Mesh(full, sharedMaterial));
      const reduced = new THREE.Group();
      reduced.add(new THREE.Mesh(mid, sharedMaterial));
      reduced.visible = false;
      object.add(model, reduced);
      object.userData = { instanceId: id, template, crop: {}, scale: 1, model, lodTiers: { mid: reduced }, lodShown: 'full' };
      object.position.set(x, 0, 0);
      object.updateMatrixWorld(true);
      scene.add(object);
      return object;
    };
    const near = Array.from({ length: 6 }, (_, index) => make(`dn${index}`, index * 2));
    const far = Array.from({ length: 6 }, (_, index) => make(`dw${index}`, 32 + index * 2));
    const set = (list, tier) => list.forEach((object) => {
      object.userData.lodShown = tier;
      object.userData.model.visible = tier === 'full';
      object.userData.lodTiers.mid.visible = tier === 'mid';
    });
    return { scene, batching, near, far, objects: [...near, ...far], set, added: () => added.length, at: (ms) => { now = ms; batching.update(now); }, now: () => now };
  }

  it('a change that sheds triangles never waits: the dearer old group must not draw on top of the budget', () => {
    const w = dearFull({ maxCohorts: 1 });
    w.batching.sync(w.objects);
    w.set(w.near, 'mid');
    w.batching.sync(w.objects); // admitted: the only cohort allowed
    w.set(w.far, 'mid'); // the pass is over its budget and drops the far group too
    w.batching.sync(w.objects);
    expect(w.batching.deferredCount).toBe(0);
    expect(w.batching.hardSwapCount).toBe(6);
    expect(w.batching.waitingGroups).toBe(false);
  });

  it('a change that costs more triangles still waits (the same caps)', () => {
    const w = dearFull({ maxCohorts: 1 });
    w.set(w.near, 'mid');
    w.set(w.far, 'mid');
    w.batching.sync(w.objects);
    w.set(w.near, 'full');
    w.batching.sync(w.objects); // admitted
    w.set(w.far, 'full');
    w.batching.sync(w.objects);
    expect(w.batching.deferredCount).toBe(1);
    expect(w.batching.waitingGroups).toBe(true);
    expect(w.batching.hardSwapCount).toBe(0);
  });

  it('builds nothing again while a change waits and the room has not changed', () => {
    const w = dearFull({ maxCohorts: 1 });
    w.set(w.near, 'mid');
    w.set(w.far, 'mid');
    w.batching.sync(w.objects);
    w.set(w.near, 'full');
    w.batching.sync(w.objects);
    w.set(w.far, 'full');
    w.batching.sync(w.objects); // waits: built once, taken back
    const built = w.added();
    for (let i = 0; i < 5; i++) { w.at(w.now() + 10); w.batching.sync(w.objects); }
    expect(w.added()).toBe(built); // no mesh built for the waiting group in five more ticks
    expect(w.batching.waitingGroups).toBe(true);
    w.at(w.now() + 450); // the fade ends: room
    w.batching.sync(w.objects);
    expect(w.added()).toBeGreaterThan(built);
    expect(w.batching.fadesStarted).toBe(2);
    expect(w.batching.hardSwapCount).toBe(0);
  });

  it('an item that was moved without being selected while its group waits cannot stay in the old group: the change swaps', () => {
    const w = dearFull({ maxCohorts: 1 });
    w.set(w.near, 'mid');
    w.set(w.far, 'mid');
    w.batching.sync(w.objects);
    w.set(w.near, 'full');
    w.batching.sync(w.objects);
    w.far[2].position.x += 1; // undo/redo, a programmatic move
    w.far[2].updateMatrixWorld(true);
    w.set(w.far, 'full');
    w.batching.sync(w.objects);
    expect(w.batching.deferredCount).toBe(0);
    expect(w.batching.hardSwapCount).toBe(6);
  });

  it('finishAll and switching off forget what waits', () => {
    const w = dearFull({ maxCohorts: 1 });
    w.set(w.near, 'mid');
    w.set(w.far, 'mid');
    w.batching.sync(w.objects);
    w.set(w.near, 'full');
    w.batching.sync(w.objects);
    w.set(w.far, 'full');
    w.batching.sync(w.objects);
    expect(w.batching.waitingGroups).toBe(true);
    w.batching.setEnabled(false);
    expect(w.batching.waitingGroups).toBe(false);
    w.batching.setEnabled(true);
    w.batching.sync(w.objects);
    w.batching.finishAll();
    expect(w.batching.waitingGroups).toBe(false);
  });
});
