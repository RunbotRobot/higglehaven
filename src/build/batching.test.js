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
});
