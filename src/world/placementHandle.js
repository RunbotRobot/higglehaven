// #3401 (part of #3398): a placement with no geometry of its own. Same
// transform and userData as the mesh createMeshForInstance would build (the
// non-flooring path), so everything that walks entry.objects -- collision,
// sit/lean search, attention, level of detail, sign/calendar/review
// registration -- treats it like any other placed object. meshDimensions reads
// only template, crop and scale from userData, never geometry, so the handle
// needs no cached dimensions. Drawing is done by a shared InstancedMesh
// (#3402), which also owns this placement's matrix.
//
// Its own file (importing only three.js) so it is unit-testable: models.js
// touches `document` at import time.
import * as THREE from 'three';
import { placementUserData } from '../shop/instanceBatching.js';

export function createPlacementHandle(instance, template) {
  // Same value as models.js effectiveLength(template, instance, 'z', 'height').
  const height = instance.crop?.z ?? template.dimensions.height;
  const handle = new THREE.Object3D();
  handle.position.set(instance.x ?? 0, instance.y ?? 0, instance.z ?? height / 2);
  handle.rotation.set(instance.rotationX ?? 0, instance.rotationY ?? 0, instance.rotationZ ?? 0);
  Object.assign(handle.userData, placementUserData(instance, template));
  handle.scale.setScalar(handle.userData.scale);
  handle.userData.isPlacementHandle = true;
  return handle;
}
