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

function setup(count, triangles) {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, -30, 20);
  camera.updateMatrixWorld(true);
  const objects = Array.from({ length: count }, (_, index) => item(index, triangles));
  const scene = new THREE.Scene();
  objects.forEach((object) => scene.add(object));
  const lod = createBuildLod({
    camera, target: new THREE.Vector3(0, 0, 0), getMeshes: () => objects, isSelected: () => false, viewportHeight: () => 844,
  });
  return { lod, objects };
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
});
