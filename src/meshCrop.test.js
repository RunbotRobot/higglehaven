import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { cropGeometryFromEnd } from './meshCrop.js';

// #1463: chainEdgesIntoLoop's boundary walk reconnects to its own start
// point, leaving it duplicated in the loop it returns -- triangulateCap's
// fan then closes on (centroid, p, p), a zero-area triangle, every time.
function degenerateTriangleCount(geometry) {
  const pos = geometry.getAttribute('position');
  const triCount = pos.count / 3;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();
  let degenerate = 0;
  for (let i = 0; i < triCount; i++) {
    a.fromBufferAttribute(pos, i * 3 + 0);
    b.fromBufferAttribute(pos, i * 3 + 1);
    c.fromBufferAttribute(pos, i * 3 + 2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    cross.crossVectors(ab, ac);
    if (cross.length() / 2 < 1e-9) degenerate++;
  }
  return degenerate;
}

describe('cropGeometryFromEnd', () => {
  it('produces no degenerate (zero-area) triangles when cropping a simple box', () => {
    const box = new THREE.BoxGeometry(2, 2, 2);
    const cropped = cropGeometryFromEnd(box, 0, 1, 2);
    expect(degenerateTriangleCount(cropped)).toBe(0);
  });

  it.each([0, 1, 2])('produces no degenerate triangles cropping on axis %i', (axis) => {
    const box = new THREE.BoxGeometry(2, 2, 2);
    const cropped = cropGeometryFromEnd(box, axis, 1, 2);
    expect(degenerateTriangleCount(cropped)).toBe(0);
  });
});
