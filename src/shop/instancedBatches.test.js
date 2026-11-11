// #3402: one InstancedMesh per model part, one matrix per placement.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildInstancedBatch } from './instancedBatches.js';

function handleAt(x, y, z, rotationZ = 0, scale = 1) {
  const handle = new THREE.Object3D();
  handle.position.set(x, y, z);
  handle.rotation.z = rotationZ;
  handle.scale.setScalar(scale);
  return handle;
}

const part = (matrix = new THREE.Matrix4()) => ({
  geometry: new THREE.BoxGeometry(1, 1, 1), material: new THREE.MeshStandardMaterial(), matrix,
});

describe('buildInstancedBatch', () => {
  it('makes one instanced mesh per part with one instance per handle, sharing geometry and material', () => {
    const parts = [part(), part(new THREE.Matrix4().makeTranslation(0, 0, 1))];
    const handles = [handleAt(1, 2, 3), handleAt(4, 5, 6), handleAt(7, 8, 9)];
    const { meshes } = buildInstancedBatch(parts, handles);
    expect(meshes).toHaveLength(2);
    meshes.forEach((mesh, i) => {
      expect(mesh.isInstancedMesh).toBe(true);
      expect(mesh.count).toBe(3);
      expect(mesh.geometry).toBe(parts[i].geometry);
      expect(mesh.material).toBe(parts[i].material);
    });
  });

  it("writes each placement's matrix composed with the part's own matrix", () => {
    const partMatrix = new THREE.Matrix4().makeTranslation(0, 0, 1);
    const handles = [handleAt(10, 0, 0), handleAt(0, 20, 0, Math.PI / 2, 2)];
    const { meshes } = buildInstancedBatch([part(partMatrix)], handles);
    const m = new THREE.Matrix4();
    const point = new THREE.Vector3();
    meshes[0].getMatrixAt(0, m);
    point.set(0, 0, 0).applyMatrix4(m);
    expect(point.toArray()).toEqual([10, 0, 1]);
    // second: scale 2 and a quarter turn about z, then translated: part origin (0,0,1) -> (0,0,2) then placed at (0,20,0)
    meshes[0].getMatrixAt(1, m);
    point.set(0, 0, 0).applyMatrix4(m);
    expect(point.x).toBeCloseTo(0);
    expect(point.y).toBeCloseTo(20);
    expect(point.z).toBeCloseTo(2);
    point.set(1, 0, 0).applyMatrix4(m); // a point one unit along the part's x: turned to +y and doubled
    expect(point.x).toBeCloseTo(0);
    expect(point.y).toBeCloseTo(22);
  });

  it('records the handle list on every mesh, in instance order, for tap resolution', () => {
    const handles = [handleAt(0, 0, 0), handleAt(1, 1, 1)];
    const { meshes } = buildInstancedBatch([part(), part()], handles);
    for (const mesh of meshes) expect(mesh.userData.instanceHandles).toBe(handles);
  });
});
