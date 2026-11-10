// #3376: what angle is this item (or bundle) at, and how does a turn land on an
// exact one. Pure maths on THREE types so it is unit-testable without the
// scene; src/build/scene.js wires it to the rotate gizmo and the readout.
//
// Angles are absolute, measured from upright, in the same Euler order the
// server stores an item's rotation in (rotationX/Y/Z, three.js 'XYZ'). The
// scene is Z-up, so Z is the turn (yaw) and X / Y are the two tilts. The
// gizmo's rings are coloured X red, Y green, Z blue; the readout names its
// angles by ring colour so a builder needs no axis vocabulary.
import * as THREE from 'three';

export const ROTATION_SNAP_STEP_DEG = 15; // Snap on: rotation lands on multiples of this
export const UPRIGHT_SETTLE_DEG = 1; // Snap off: within this of a right angle, settle onto it

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
const AXES = ['x', 'y', 'z'];

function normalizeDeg(deg) {
  let d = ((deg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

// { turn, tiltRed, tiltGreen } in degrees, each in (-180, 180], one decimal.
export function anglesFromQuaternion(quaternion) {
  const e = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
  const round = (rad) => {
    const d = Math.round(normalizeDeg(rad * RAD_TO_DEG) * 10) / 10;
    return d === 0 ? 0 : d; // never "-0.0"
  };
  return { turn: round(e.z), tiltRed: round(e.x), tiltGreen: round(e.y) };
}

export function formatRotationReadout({ turn, tiltRed, tiltGreen }) {
  const f = (n) => `${n.toFixed(1)}°`;
  return `Turn ${f(turn)} (blue ring) · Tilt ${f(tiltRed)} (red ring) · Tilt ${f(tiltGreen)} (green ring)`;
}

// A bundle has no stored orientation of its own: every member's orientation is
// composed with each rotation applied to the bundle (rotateMembersRigidly), so
// the members that agree with each other carry it. The bundle's orientation is
// the one most members share, ties going to the earliest member. A bundle made
// of members that were placed upright therefore reads as its true angle, even
// one rotated in an earlier session, copied, or saved and placed again.
// Members within CLUSTER_TOLERANCE_RAD of each other count as the same.
// (A bundle whose members were deliberately placed at different tilts reads as
// the most common one.)
const CLUSTER_TOLERANCE_RAD = 0.0005;
const MAX_CLUSTERS = 64; // bounds the work for a bundle of all-different members
export function referenceOrientation(quaternions) {
  if (!quaternions.length) return new THREE.Quaternion();
  const clusters = []; // { quaternion, count }
  const minDot = Math.cos(CLUSTER_TOLERANCE_RAD / 2);
  for (const q of quaternions) {
    const cluster = clusters.find((c) => Math.abs(c.quaternion.dot(q)) >= minDot);
    if (cluster) cluster.count += 1;
    else if (clusters.length < MAX_CLUSTERS) clusters.push({ quaternion: q, count: 1 });
  }
  let best = clusters[0];
  for (const c of clusters) if (c.count > best.count) best = c;
  return best.quaternion.clone();
}

// Snap (on) or settle (off) ONE Euler component of an absolute orientation:
// the one the gizmo is turning ('X' | 'Y' | 'Z'). Any other axis value ('E',
// 'XYZE', null) leaves it alone. Returns the same quaternion object's value
// unchanged (a clone) when nothing needs to move, so a free drag is not
// perturbed by float noise.
export function snapAxisComponent(quaternion, axis, { snap, stepDeg = ROTATION_SNAP_STEP_DEG, settleDeg = UPRIGHT_SETTLE_DEG } = {}) {
  const key = typeof axis === 'string' ? axis.toLowerCase() : '';
  if (!AXES.includes(key)) return quaternion.clone();
  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
  const deg = euler[key] * RAD_TO_DEG;
  let target = deg;
  if (snap) {
    target = Math.round(deg / stepDeg) * stepDeg;
  } else {
    const nearestRight = Math.round(deg / 90) * 90;
    if (Math.abs(deg - nearestRight) <= settleDeg) target = nearestRight;
  }
  if (Math.abs(target - deg) < 1e-9) return quaternion.clone();
  euler[key] = target * DEG_TO_RAD;
  return new THREE.Quaternion().setFromEuler(euler);
}

// A bundle drag turns the gizmo's pivot by `delta` (world space) from the
// orientation `reference` the bundle started the drag at. This returns the
// delta that lands the bundle's ABSOLUTE angle on the snapped (or settled)
// value instead, so 0 and 90 are reachable whatever angle the drag began at.
export function snapDeltaToAbsolute(reference, delta, axis, options) {
  const absolute = delta.clone().multiply(reference);
  const snapped = snapAxisComponent(absolute, axis, options);
  return snapped.multiply(reference.clone().invert());
}
