// #4208 (a check its review left open): the hold on items no finished set job has covered ends after
// BUILD_SETS_HOLD_MAX_MS, so a lándlet whose set job never finishes (or keeps starting over) cannot pin items at
// full detail past the cap. The job is made never to finish here by replacing its step, which the real code
// cannot be made to do on a small wall in a test.
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

globalThis.window ??= {};
const noop = () => {};
globalThis.document ??= {
  createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: () => noop, set: () => true }) }),
};
vi.mock('../shop/lodSets.js', async (importOriginal) => ({
  ...(await importOriginal()),
  stepLodSetsJob: () => null, // never done
}));
const { createBuildLod, BUILD_SETS_HOLD_MAX_MS } = await import('./lod.js');

const template = { templateId: 'brick', modelUrl: '', dimensions: { width: 1, depth: 1, height: 1 } };
function brick(x, z) {
  const object = new THREE.Group();
  const make = () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
    group.visible = false;
    return group;
  };
  const model = new THREE.Group();
  model.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 10, 10, 10), new THREE.MeshBasicMaterial()));
  const mid = make();
  const far = make();
  object.add(model, mid, far);
  object.userData = { instanceId: `b-${x}-${z}`, template, model, lodTiers: { mid, far }, lodTiersState: 'ready' };
  object.position.set(x, 0, z);
  object.updateMatrixWorld(true);
  return object;
}

describe('the hold on items no set job has covered ends after its limit (#4208)', () => {
  it('holds a wall at what is drawn while its job runs, then lets every item be judged by its own size', () => {
    const objects = [];
    for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) objects.push(brick(x, z));
    const scene = new THREE.Scene();
    objects.forEach((object) => scene.add(object));
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, -40, 0); // far enough that a brick alone is on a reduced version
    camera.updateMatrixWorld(true);
    const lod = createBuildLod({ camera, target: new THREE.Vector3(500, 500, 0), getMeshes: () => objects, isSelected: () => false, viewportHeight: () => 844 });
    const tiers = () => new Set(objects.map((object) => object.userData.lodApplied ?? 'full'));
    let clock = 1000;
    const tickTo = (ms) => { while (clock < ms) { clock += 300; lod.update(clock, true); } };

    tickTo(1000 + BUILD_SETS_HOLD_MAX_MS - 600); // inside the limit
    expect(lod.setCount()).toBe(0); // the job has not finished
    expect(tiers()).toEqual(new Set(['full'])); // so no item has changed version: all held
    tickTo(1000 + BUILD_SETS_HOLD_MAX_MS + 1500); // past it
    expect(lod.setCount()).toBe(0);
    expect(tiers().has('full') && tiers().size === 1).toBe(false); // the hold ended: items are judged by size again
  });
});
