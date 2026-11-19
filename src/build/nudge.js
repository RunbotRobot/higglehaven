// #3689 (Build in the bud, 2/6; the nudge arrows the plan keeps "inside the card's More"): how far and
// which way a small move goes. Pure, so it can be unit-tested without the scene; src/build/scene.js runs
// the move through the same drag pipeline as the gizmo (landlet limits, collision, undo, saving).
//
// The ground nudges work in the item's OWN turned axes, so sliding a bookcase along a wall that is not on
// the world grid is one press (the drag on the item always follows the world's axes). Up and Down are the
// world's vertical. A tilted item's own axes lean up or down, so they are flattened onto the ground first;
// an item lying on its side, whose axes have no ground direction left, falls back to the world's.
import * as THREE from 'three';

export const NUDGE_DIRECTIONS = ['left', 'right', 'forward', 'back', 'up', 'down'];

// The step, in display units: a tenth of a metre, or a quarter of a foot, so a press is a size a person
// can picture in either system.
export const NUDGE_STEP_METRIC = 0.1;
export const NUDGE_STEP_FEET = 0.25;
export const METERS_PER_FOOT = 0.3048;
export function nudgeStepMeters(units) {
  return units === 'ft' ? NUDGE_STEP_FEET * METERS_PER_FOOT : NUDGE_STEP_METRIC;
}

const FLAT_EPSILON = 1e-4;

// A unit vector for `direction`, for an item turned by `quaternion`.
export function nudgeVector(quaternion, direction) {
  if (direction === 'up') return new THREE.Vector3(0, 0, 1);
  if (direction === 'down') return new THREE.Vector3(0, 0, -1);
  const local = {
    left: new THREE.Vector3(-1, 0, 0),
    right: new THREE.Vector3(1, 0, 0),
    forward: new THREE.Vector3(0, 1, 0),
    back: new THREE.Vector3(0, -1, 0),
  }[direction];
  if (!local) return new THREE.Vector3();
  const along = local.clone().applyQuaternion(quaternion);
  along.z = 0;
  if (along.lengthSq() < FLAT_EPSILON) return local.clone(); // on its side: the world's own axis
  return along.normalize();
}

// How high the item's underside is above the floor of the level it stands on, in metres.
export function heightAboveFloor(centreZ, itemHeight, floorZ) {
  const h = centreZ - itemHeight / 2 - floorZ;
  return Math.abs(h) < 1e-6 ? 0 : h;
}
