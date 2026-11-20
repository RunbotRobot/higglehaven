// #4003: what Build draws while the simpler versions of its items are still attaching.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

// models.js builds its ground texture on a canvas when it loads; the node test environment has no
// DOM, so give it a canvas that accepts and ignores drawing (as src/shop/tierCrossfade.test.js does).
const noop = () => {};
globalThis.document ??= {
  createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: () => noop, set: () => true }) }),
};
const { createBuildLod, BUILD_HOLD_BACK_TRIANGLES, BUILD_HOLD_MAX_MS } = await import('./lod.js');

// A placed item the way createMeshForInstance builds it: a container whose userData.model is the full
// version. `triangles` makes the model that heavy.
const template = { templateId: 'brick', modelUrl: '', dimensions: { width: 1, depth: 1, height: 1 } };
function item(index, triangles) {
  const object = new THREE.Group();
  const model = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(triangles * 9), 3));
  model.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  object.add(model);
  object.userData = { instanceId: `i${index}`, template, model };
  object.position.set(index, 0, 0);
  object.updateMatrixWorld(true);
  return object;
}

function setup(count, triangles, selected = new Set()) {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, -30, 20);
  camera.updateMatrixWorld(true);
  const objects = Array.from({ length: count }, (_, index) => item(index, triangles));
  const scene = new THREE.Scene();
  objects.forEach((object) => scene.add(object));
  const lod = createBuildLod({
    camera, target: new THREE.Vector3(0, 0, 0), getMeshes: () => objects, isSelected: (object) => selected.has(object), viewportHeight: () => 844,
  });
  return { lod, objects, scene };
}

const drawn = (objects) => objects.filter((object) => object.userData.model.visible);
const trianglesOf = (objects) => drawn(objects).reduce((sum, object) => sum + object.userData.lodFullTris, 0);

describe('Build level of detail while the versions attach', () => {
  it('holds back what does not fit the triangle budget on the first pass, nearest drawn first', () => {
    const { lod, objects } = setup(400, 5120); // 2,048,000 triangles of full models
    lod.update(1000, true);
    expect(trianglesOf(objects)).toBeLessThanOrEqual(BUILD_HOLD_BACK_TRIANGLES);
    expect(drawn(objects).length).toBeGreaterThan(0);
    expect(lod.counts().held).toBe(objects.length - drawn(objects).length);
    // Nearest first: the first item (at the target) is drawn, the last (far along the row) is held.
    expect(objects[0].userData.model.visible).toBe(true);
    expect(objects[399].userData.model.visible).toBe(false);
  });

  // The wall the builder is standing at is the near ring (within 10 m of the point looked at), which is
  // protected once its versions are there. While they are still attaching it has no exemption from the
  // budget, or a dense wall draws a million triangles a thousand bricks over in the first frames.
  it('holds back the near ring too while versions attach, nearest first, and keeps a selected item', () => {
    const selected = new Set();
    const { lod, objects } = setup(400, 5120, selected);
    objects.forEach((object, index) => { object.position.set(index * 0.01, 0, 0); object.updateMatrixWorld(true); }); // all within 4 m
    selected.add(objects[399]);
    lod.update(1000, true);
    expect(trianglesOf(objects)).toBeLessThanOrEqual(BUILD_HOLD_BACK_TRIANGLES + 5120);
    expect(objects[0].userData.model.visible).toBe(true);
    expect(objects[398].userData.model.visible).toBe(false);
    expect(objects[399].userData.model.visible).toBe(true); // selected: always drawn
  });

  // Items arrive in bursts between passes while a lándlet first loads; they wait undrawn for the pass.
  it('keeps an item that arrives while loading undrawn until a pass judges it, then lets in what fits', () => {
    const { lod, objects } = setup(400, 5120);
    objects.forEach((object) => lod.holdNew(object));
    expect(drawn(objects)).toHaveLength(0);
    expect(objects[0].userData.model.raycast()).toBe(false); // not tappable while undrawn
    lod.update(1000, true);
    expect(trianglesOf(objects)).toBeLessThanOrEqual(BUILD_HOLD_BACK_TRIANGLES);
    expect(objects[0].userData.model.visible).toBe(true);
    const small = setup(20, 5120);
    small.objects.forEach((object) => small.lod.holdNew(object));
    small.lod.update(1000, true);
    expect(drawn(small.objects)).toHaveLength(20);
  });

  it('draws everything when it fits', () => {
    const { lod, objects } = setup(50, 5120);
    lod.update(1000, true);
    expect(drawn(objects)).toHaveLength(50);
    expect(lod.counts().held).toBe(0);
  });

  it('draws every held item again once its versions have been looked for (there are none here)', async () => {
    const { lod, objects } = setup(400, 5120);
    lod.update(1000, true);
    expect(lod.counts().held).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 20)); // the tier scenes resolve, none to attach
    lod.update(2000, true);
    expect(lod.counts().held).toBe(0);
    expect(drawn(objects)).toHaveLength(400);
  });

  it('never holds an item for longer than the limit', () => {
    const { lod, objects } = setup(400, 5120);
    lod.update(1000, true);
    const heldBefore = lod.counts().held;
    expect(heldBefore).toBeGreaterThan(0);
    // Its tier request is still pending as far as the pass knows.
    for (const object of objects) object.userData.lodTiersState = 'loading';
    lod.update(1000 + BUILD_HOLD_MAX_MS + 1, true);
    expect(lod.counts().held).toBe(0);
    expect(drawn(objects)).toHaveLength(400);
  });

  it('asks for the versions of the items it holds back', () => {
    const { lod, objects } = setup(400, 5120);
    lod.update(1000, true);
    const held = objects.filter((object) => object.userData.lodHeld);
    expect(held.length).toBeGreaterThan(0);
    for (const object of held) expect(object.userData.lodTiersState).toBeDefined();
  });

  // A drawn item is never drawn out again: one that was protected (selected) while its versions loaded
  // keeps drawing when the selection moves on.
  it('keeps drawing an item that stopped being protected while its versions still load', () => {
    const selected = new Set();
    const { lod, objects } = setup(400, 5120, selected);
    selected.add(objects[399]); // far along the row, so only its selection protects it
    lod.update(1000, true);
    expect(objects[399].userData.model.visible).toBe(true);
    selected.delete(objects[399]);
    lod.update(1300, true);
    expect(objects[399].userData.model.visible).toBe(true);
    expect(objects[399].userData.lodHeld).toBeFalsy();
  });

  // The budget is for the way in. Long after entering, a new placement is judged on its own.
  it('never holds a new placement made after the lándlet has settled in', () => {
    const { lod, objects, scene } = setup(400, 5120);
    lod.update(1000, true);
    for (const object of objects) object.userData.lodTiersState = 'loading'; // versions still on their way
    const later = 1000 + BUILD_HOLD_MAX_MS + 1000;
    lod.update(later, true); // the entering window is over: everything draws, nothing is counted
    const added = item(500, 5120);
    scene.add(added);
    objects.push(added);
    lod.update(later + 300, true);
    expect(added.userData.model.visible).toBe(true);
    expect(added.userData.lodHeld).toBeFalsy();
    expect(lod.counts().held).toBe(0);
  });

  // A hidden object still absorbs a raycast unless its own raycast says no (src/world/models.js).
  it('does not let a tap land on an item that is held back, and does again once it is let in', () => {
    const { lod, objects } = setup(400, 5120);
    lod.update(1000, true);
    const held = objects.find((object) => object.userData.lodHeld);
    const drawnOne = objects[0];
    expect(held).toBeDefined();
    expect(held.userData.model.raycast()).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(drawnOne.userData.model, 'raycast')).toBe(false);
    lod.update(1000 + BUILD_HOLD_MAX_MS + 1000, true); // let in
    expect(held.userData.lodHeld).toBeFalsy();
    expect(Object.prototype.hasOwnProperty.call(held.userData.model, 'raycast')).toBe(false);
  });

  it('lets in a held item that stops being a placed item with versions to wait for', () => {
    const { lod, objects } = setup(400, 5120);
    lod.update(1000, true);
    const held = objects.find((object) => object.userData.lodHeld);
    held.removeFromParent(); // no longer in the scene
    lod.update(1300, true);
    expect(held.userData.lodHeld).toBeFalsy();
    expect(held.userData.model.visible).toBe(true);
  });

  // Letting a held item in shows it in the version it should be in, never in full for a tick first.
  it('shows a released item whose versions are there in its reduced version straight away', () => {
    const { lod, objects } = setup(400, 5120);
    lod.update(1000, true);
    const held = objects[399];
    expect(held.userData.lodHeld).toBe(true);
    const mid = new THREE.Group();
    mid.visible = false;
    held.add(mid);
    held.userData.lodTiers = { mid };
    held.userData.lodTiersState = 'ready';
    lod.update(1300, true);
    expect(held.userData.lodHeld).toBeFalsy();
    expect(held.userData.model.visible).toBe(false);
    expect(mid.visible).toBe(true);
  });
});
