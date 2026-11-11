import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { farItemMatrix, buildFarMeshes, triangleCount, farItemsSignature } from './farViewDraw.js';

const box = () => new THREE.BoxGeometry(1, 1, 1);

describe('farItemMatrix (#3478)', () => {
  it('places an item at its world position plus the landlet elevation', () => {
    const m = farItemMatrix({ x: 10, y: 20, z: 1, scale: 2 }, 5);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect([p.x, p.y, p.z]).toEqual([10, 20, 6]);
    expect(new THREE.Vector3(1, 0, 0).applyMatrix4(m).x).toBeCloseTo(12);
  });

  it('turns about z like a placement handle', () => {
    const m = farItemMatrix({ x: 0, y: 0, z: 0, rotationZ: Math.PI / 2 });
    const v = new THREE.Vector3(1, 0, 0).applyMatrix4(m);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(1);
  });

  it('stretches a cropped item to its cropped size', () => {
    const m = farItemMatrix({ x: 0, y: 0, z: 0, scale: 1, crop: { z: 1 } }, 0, { width: 2, depth: 2, height: 4 });
    const s = new THREE.Vector3(); m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    expect([s.x, s.y, s.z]).toEqual([1, 1, 0.25]);
  });
});

describe('buildFarMeshes (#3478)', () => {
  it('makes one instanced mesh per part with one matrix per item', () => {
    const parts = [
      { geometry: box(), material: new THREE.MeshBasicMaterial(), matrix: new THREE.Matrix4() },
      { geometry: box(), material: new THREE.MeshBasicMaterial(), matrix: new THREE.Matrix4().makeTranslation(0, 0, 2) },
    ];
    const items = [{ x: 1, y: 2, z: 3, landletId: 'a' }, { x: 4, y: 5, z: 6, landletId: 'b' }];
    const meshes = buildFarMeshes(parts, items, (id) => (id === 'b' ? 10 : 0), null);
    expect(meshes).toHaveLength(2);
    expect(meshes[0].count).toBe(2);
    const m = new THREE.Matrix4();
    meshes[1].getMatrixAt(1, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect([p.x, p.y, p.z]).toEqual([4, 5, 18]);
    expect(meshes[0].frustumCulled).toBe(false);
  });

  it('counts triangles', () => {
    expect(triangleCount([{ geometry: box() }])).toBe(12);
  });

  it('signs a list so equal placements compare equal and a change does not', () => {
    const a = [{ x: 1, y: 2, z: 3 }];
    expect(farItemsSignature(a)).toBe(farItemsSignature([{ x: 1, y: 2, z: 3 }]));
    expect(farItemsSignature(a)).not.toBe(farItemsSignature([{ x: 1.5, y: 2, z: 3 }]));
  });
});
