// #3478 (2/4 of #3418, part of #3412): turns the far-view plan (farViewPlan.js)
// into instanced meshes. Imports only three.js so it runs in the unit-test
// pool; loading models and wiring into the scene lives in farView.js.
//
// One InstancedMesh per drawable part of a product's far model, one matrix per
// distant placement of that product, across every landlet in view: about one
// draw call per product however many landlets use it.
import * as THREE from 'three';

const placement = new THREE.Matrix4();
const partMatrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();
const euler = new THREE.Euler();

// Same transform createPlacementHandle (src/world/placementHandle.js) gives a
// placement inside its landlet's group, with the group's own offset (the
// landlet's centre, already in item.x/y, and its elevation) applied. A cropped
// placement is the whole-product model stretched to the cropped size per axis;
// `dimensions` is the product's declared { width, depth, height }.
export function farItemMatrix(item, elevationM = 0, dimensions = null, target = new THREE.Matrix4()) {
  position.set(item.x, item.y, item.z + elevationM);
  euler.set(item.rotationX ?? 0, item.rotationY ?? 0, item.rotationZ ?? 0);
  quaternion.setFromEuler(euler);
  const s = item.scale ?? 1;
  const crop = item.crop;
  if (crop && dimensions) {
    scale.set(
      s * ratio(crop.x, dimensions.width), s * ratio(crop.y, dimensions.depth), s * ratio(crop.z, dimensions.height),
    );
  } else {
    scale.set(s, s, s);
  }
  return target.compose(position, quaternion, scale);
}

function ratio(cropped, declared) {
  return cropped > 0 && declared > 0 ? cropped / declared : 1;
}

// parts: [{ geometry, material, matrix }] (loadFarViewSource). items: the plan's
// items for one product. elevationFor(landletId) -> the landlet group's z.
// Returns the meshes, ready to add to one root group.
export function buildFarMeshes(parts, items, elevationFor, dimensions) {
  const meshes = parts.map((part) => {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, items.length);
    items.forEach((item, index) => {
      farItemMatrix(item, elevationFor(item.landletId), dimensions, placement);
      partMatrix.multiplyMatrices(placement, part.matrix);
      mesh.setMatrixAt(index, partMatrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    // Far, instanced, and never tapped: bounds are the whole tile range, so the
    // default per-mesh frustum cull (a sphere around the origin) would wrongly
    // hide it.
    mesh.frustumCulled = false;
    mesh.raycast = () => false;
    return mesh;
  });
  return meshes;
}

export function triangleCount(parts) {
  let total = 0;
  for (const { geometry } of parts) {
    total += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
  }
  return Math.round(total);
}

// Cheap identity of a plan list for one product, to tell whether its meshes
// need rebuilding: same count and same placements means same drawing.
export function farItemsSignature(items) {
  let hash = items.length;
  for (const item of items) {
    hash = (Math.imul(hash, 31) + Math.round(item.x * 10)) | 0;
    hash = (Math.imul(hash, 31) + Math.round(item.y * 10)) | 0;
    hash = (Math.imul(hash, 31) + Math.round(item.z * 10)) | 0;
    hash = (Math.imul(hash, 31) + Math.round((item.rotationZ ?? 0) * 1000)) | 0;
    hash = (Math.imul(hash, 31) + Math.round((item.scale ?? 1) * 1000)) | 0;
  }
  return `${items.length}:${hash}`;
}
