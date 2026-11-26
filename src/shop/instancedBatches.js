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
  const batch = allocateInstancedBatch(parts, handles);
  fillInstancedBatch(batch, parts, 0, handles.length);
  return batch;
}

// #4483: the same build in pieces, so a batch of thousands is not one long task (the loader works in small
// units inside a per-frame budget, #3396). allocateInstancedBatch makes the meshes (instance matrices all
// identity); fillInstancedBatch writes the matrices of handles[from, to) -- call it over consecutive ranges
// until `to` reaches handles.length. Nothing is drawn until the meshes are added to the scene, so a batch
// that is only partly filled is never seen.
export function allocateInstancedBatch(parts, handles) {
  const meshes = parts.map((part) => {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, handles.length);
    // Read back by tap resolution (handleForInstanceHit).
    mesh.userData.instanceHandles = handles;
    return mesh;
  });
  return { meshes, handles };
}

export function fillInstancedBatch(batch, parts, from, to) {
  const { meshes, handles } = batch;
  const end = Math.min(to, handles.length);
  meshes.forEach((mesh, partIndex) => {
    for (let index = from; index < end; index++) {
      const handle = handles[index];
      handle.updateMatrix();
      scratch.multiplyMatrices(handle.matrix, parts[partIndex].matrix);
      mesh.setMatrixAt(index, scratch);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });
}
