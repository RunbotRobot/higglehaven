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

// #3371: a rotation must never drop a frame. Tilting a tall or wide bundle
// about a horizontal axis sends some members below the floor or past the edge
// at most intermediate angles, so instead of rejecting the frame the whole
// bundle is shifted by the smallest offset that brings every member's CENTRE
// back inside `bounds` ({ minX, maxX, minY, maxY, minZ, maxZ }). The same
// offset applies to every member, so it stays one rigid transform. Member
// extents are not considered (centres only, as the bounds check always was).
// Returns { transforms, fits }: fits is false only when the rotated bundle is
// wider than the bounds on some axis, so no shift can seat it.
export function reseatInBounds(transforms, bounds) {
  if (!transforms.length) return { transforms, fits: true };
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
  const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const { position } of transforms) {
    lo.min(position);
    hi.max(position);
  }
  const limits = [['x', bounds.minX, bounds.maxX], ['y', bounds.minY, bounds.maxY], ['z', bounds.minZ, bounds.maxZ]];
  const offset = new THREE.Vector3();
  for (const [axis, min, max] of limits) {
    if (hi[axis] - lo[axis] > max - min + 1e-9) return { transforms, fits: false };
    if (lo[axis] < min) offset[axis] = min - lo[axis];
    else if (hi[axis] > max) offset[axis] = max - hi[axis];
  }
  if (offset.lengthSq() === 0) return { transforms, fits: true };
  return {
    transforms: transforms.map(({ position, quaternion }) => ({ position: position.clone().add(offset), quaternion })),
    fits: true,
  };
}
