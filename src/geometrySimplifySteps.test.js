// #3483: the model-version builder runs in a shopper's browser inside a
// per-frame budget (#3396), so its heavy steps must be spread out. One
// simplification pass on a 50k-triangle mesh used to be a single task of
// several seconds; these tests pin that the stepped forms give the same results
// as the originals and yield often (the work between two yields is what blocks a
// frame, so many yields mean small slices).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mergeVerticesSteps } from './vendor/mergeVerticesSteps.js';
import {
  countTriangles, simplifyGeometryOnePass, simplifyGeometryOnePassSteps,
} from './geometrySimplify.js';

function runToEnd(generator) {
  let yields = 0;
  for (;;) {
    const step = generator.next();
    if (step.done) return { value: step.value, yields };
    yields += 1;
  }
}

// A terrain-like grid, so collapses have real work to do.
function bumpyGrid(n) {
  const geometry = new THREE.PlaneGeometry(2, 2, n, n);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    position.setZ(i, 0.2 * Math.sin(position.getX(i) * 7) * Math.cos(position.getY(i) * 5));
  }
  geometry.computeVertexNormals();
  return geometry;
}

const arraysEqual = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

describe('mergeVerticesSteps', () => {
  it('returns exactly what three.js mergeVertices returns, attributes and index', () => {
    const geometry = bumpyGrid(30).toNonIndexed(); // every corner its own vertex, so merging has work
    const expected = mergeVertices(geometry);
    const { value: actual } = runToEnd(mergeVerticesSteps(geometry));
    expect(actual.attributes.position.count).toBe(expected.attributes.position.count);
    for (const name of Object.keys(expected.attributes)) {
      expect(arraysEqual(Array.from(actual.attributes[name].array), Array.from(expected.attributes[name].array)), name).toBe(true);
    }
    expect(arraysEqual(Array.from(actual.index.array), Array.from(expected.index.array))).toBe(true);
  });

  it('yields about once per few thousand triangle corners, not once per mesh', () => {
    const geometry = bumpyGrid(60).toNonIndexed(); // 7,200 triangles = 21,600 corners
    const { yields } = runToEnd(mergeVerticesSteps(geometry));
    expect(yields).toBeGreaterThanOrEqual(8);
  });
});

describe('simplifyGeometryOnePassSteps', () => {
  it('gives the same geometry as the one-shot simplifyGeometryOnePass', () => {
    const geometry = bumpyGrid(24);
    const target = Math.round(countTriangles(geometry) * 0.3);
    const oneShot = simplifyGeometryOnePass(geometry, target);
    const { value: stepped } = runToEnd(simplifyGeometryOnePassSteps(geometry, target));
    expect(stepped).not.toBeNull();
    expect(countTriangles(stepped)).toBe(countTriangles(oneShot));
    expect(arraysEqual(Array.from(stepped.attributes.position.array), Array.from(oneShot.attributes.position.array))).toBe(true);
    expect(arraysEqual(Array.from(stepped.index.array), Array.from(oneShot.index.array))).toBe(true);
  });

  it('actually reduces the mesh, within the single-pass removal cap', () => {
    const geometry = bumpyGrid(24);
    const before = countTriangles(geometry);
    const { value } = runToEnd(simplifyGeometryOnePassSteps(geometry, 10));
    expect(countTriangles(value)).toBeLessThan(before);
    expect(countTriangles(value)).toBeGreaterThan(10); // the cap stops one pass short of the target
  });

  it('yields many times within one pass, so a frame budget can cut in anywhere', () => {
    const geometry = bumpyGrid(40); // 3,200 triangles
    const { yields } = runToEnd(simplifyGeometryOnePassSteps(geometry, Math.round(countTriangles(geometry) * 0.3)));
    // One yield per collapse: hundreds, against one task for the whole pass before.
    expect(yields).toBeGreaterThan(400);
  });

  it('does nothing, and says so with null, when already at or under the target or skinned', () => {
    const small = bumpyGrid(3);
    expect(runToEnd(simplifyGeometryOnePassSteps(small, 1000)).value).toBeNull();
    const skinned = bumpyGrid(10);
    skinned.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(skinned.attributes.position.count * 4), 4));
    skinned.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(skinned.attributes.position.count * 4), 4));
    expect(runToEnd(simplifyGeometryOnePassSteps(skinned, 5)).value).toBeNull();
  });
});
