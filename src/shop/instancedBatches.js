// #3402 (part of #3398): one InstancedMesh per drawable part of a shared model,
// one matrix per placement. Imports only three.js so it runs in the unit-test
// pool; loading the model and wiring a batch into a landlet lives in
// presenceAndContent.js.
import * as THREE from 'three';

const scratch = new THREE.Matrix4();

// parts: [{ geometry, material, matrix }] -- each mesh of the loaded model with
// its matrix inside the model's container (loadBatchSource, models.js).
// handles: the placements' Object3Ds (createPlacementHandle), parented to the
// same group the meshes will be added to, so a handle's local matrix is the
// placement's matrix there. Instance i of every part belongs to handles[i].
// Returns { meshes, handles }.
export function buildInstancedBatch(parts, handles) {
  const meshes = parts.map((part) => {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, handles.length);
    handles.forEach((handle, index) => {
      handle.updateMatrix();
      scratch.multiplyMatrices(handle.matrix, part.matrix);
      mesh.setMatrixAt(index, scratch);
    });
    mesh.instanceMatrix.needsUpdate = true;
    // Read back by tap resolution (handleForInstanceHit).
    mesh.userData.instanceHandles = handles;
    return mesh;
  });
  return { meshes, handles };
}
