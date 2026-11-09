// #3325 (leaf 2/7 of #3323): rotate a bundle as a rigid body. Each member's
// position orbits the shared pivot by `delta` and its own orientation is
// composed with the same `delta`, so the arrangement keeps its shape (a
// rotated wall is still a wall) instead of every brick spinning on its own
// spot. Pure maths on THREE types, any axis, so it is unit-testable without
// the scene.
import * as THREE from 'three';

// members: [{ position: Vector3, quaternion: Quaternion }] as they were when
// the drag began. Returns new objects; inputs are never mutated.
export function rotateMembersRigidly(members, pivot, delta) {
  return members.map(({ position, quaternion }) => ({
    position: position.clone().sub(pivot).applyQuaternion(delta).add(pivot),
    // delta is a world-space rotation, so it premultiplies the member's own.
    quaternion: delta.clone().multiply(quaternion),
  }));
}

// The pivot is the centre of the box that bounds the members' positions.
export function bundlePivot(positions) {
  const box = new THREE.Box3();
  for (const p of positions) box.expandByPoint(p);
  return box.getCenter(new THREE.Vector3());
}
