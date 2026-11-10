import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  anglesFromQuaternion,
  formatRotationReadout,
  referenceOrientation,
  snapAxisComponent,
  snapDeltaToAbsolute,
  ROTATION_SNAP_STEP_DEG,
} from './rotationReadout.js';
import { rotateMembersRigidly } from './bundleRotation.js';

const DEG = Math.PI / 180;
const quat = (xDeg, yDeg, zDeg) => new THREE.Quaternion().setFromEuler(new THREE.Euler(xDeg * DEG, yDeg * DEG, zDeg * DEG, 'XYZ'));
const axisAngle = (axis, deg) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0), deg * DEG);
const eulerDeg = (q) => {
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return { x: e.x / DEG, y: e.y / DEG, z: e.z / DEG };
};

describe('anglesFromQuaternion (#3376)', () => {
  it('reads an item at rest as 0, 0, 0 (never "-0")', () => {
    const a = anglesFromQuaternion(new THREE.Quaternion());
    expect(a).toEqual({ turn: 0, tiltRed: 0, tiltGreen: 0 });
    expect(Object.is(a.turn, -0)).toBe(false);
  });
  it('reads Z as the turn and X / Y as the two tilts, to one decimal', () => {
    expect(anglesFromQuaternion(quat(0, 0, 90))).toEqual({ turn: 90, tiltRed: 0, tiltGreen: 0 });
    expect(anglesFromQuaternion(quat(12.34, 0, 0))).toEqual({ turn: 0, tiltRed: 12.3, tiltGreen: 0 });
    expect(anglesFromQuaternion(quat(0, -30, 0))).toEqual({ turn: 0, tiltRed: 0, tiltGreen: -30 });
  });
  it('keeps angles in (-180, 180]', () => {
    expect(anglesFromQuaternion(quat(0, 0, 270)).turn).toBe(-90);
  });
});

describe('formatRotationReadout (#3376)', () => {
  it('names the angles by the gizmo ring colour, in degrees', () => {
    expect(formatRotationReadout({ turn: 90, tiltRed: 0, tiltGreen: -2.5 }))
      .toBe('Turn 90.0° (blue ring) · Tilt 0.0° (red ring) · Tilt -2.5° (green ring)');
  });
  it('uses no axis letters or internal vocabulary', () => {
    expect(formatRotationReadout({ turn: 1, tiltRed: 2, tiltGreen: 3 })).not.toMatch(/\b[xyz]\b|quaternion|euler/i);
  });
});

describe('referenceOrientation (#3376)', () => {
  it('is identity for no members', () => {
    expect(referenceOrientation([]).angleTo(new THREE.Quaternion())).toBe(0);
  });
  it('is the orientation most members share', () => {
    const tilted = quat(20, 0, 0);
    const result = referenceOrientation([new THREE.Quaternion(), tilted, quat(20, 0, 0), quat(20, 0, 0), quat(0, 0, 45)]);
    expect(result.angleTo(tilted)).toBeLessThan(1e-6);
  });
  it('breaks a tie with the earliest member', () => {
    const first = quat(0, 0, 10);
    expect(referenceOrientation([first, quat(0, 0, 80)]).angleTo(first)).toBeLessThan(1e-6);
  });
  it('treats members within a hair of each other as the same orientation', () => {
    const near = quat(0, 0, 30.0001);
    const result = referenceOrientation([quat(0, 0, 30), near, quat(0, 0, 90)]);
    expect(result.angleTo(quat(0, 0, 30))).toBeLessThan(1e-3);
  });
  it('counts q and -q as the same orientation', () => {
    const q = quat(0, 0, 30);
    const negated = new THREE.Quaternion(-q.x, -q.y, -q.z, -q.w);
    expect(referenceOrientation([q, negated, quat(0, 0, 80)]).angleTo(q)).toBeLessThan(1e-6);
  });
  it('composes across successive bundle rotations and returns to upright after a rotation and its inverse', () => {
    const members = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(2, 0, 1), new THREE.Vector3(4, 0, 1)]
      .map((position) => ({ position, quaternion: new THREE.Quaternion() }));
    const pivot = new THREE.Vector3(2, 0, 1);
    const forward = rotateMembersRigidly(members, pivot, axisAngle('x', 25));
    expect(anglesFromQuaternion(referenceOrientation(forward.map((m) => m.quaternion))).tiltRed).toBe(25);
    const further = rotateMembersRigidly(forward, pivot, axisAngle('x', 10));
    expect(anglesFromQuaternion(referenceOrientation(further.map((m) => m.quaternion))).tiltRed).toBe(35);
    const back = rotateMembersRigidly(further, pivot, axisAngle('x', -35));
    expect(referenceOrientation(back.map((m) => m.quaternion)).angleTo(new THREE.Quaternion())).toBeLessThan(1e-9);
  });
});

describe('snapAxisComponent (#3376)', () => {
  it('Snap on: lands on a multiple of the step, from a start that is not on one', () => {
    for (const startDeg of [3, 37, 44.9, 98, -61]) {
      const snapped = eulerDeg(snapAxisComponent(quat(0, 0, startDeg), 'Z', { snap: true }));
      const steps = snapped.z / ROTATION_SNAP_STEP_DEG;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
    }
    expect(eulerDeg(snapAxisComponent(quat(0, 0, 37), 'Z', { snap: true })).z).toBeCloseTo(30, 6);
  });
  it('Snap on: 0 and 90 are reachable from any start (they are multiples of the step)', () => {
    expect(eulerDeg(snapAxisComponent(quat(0.4, 0, 0), 'X', { snap: true })).x).toBeCloseTo(0, 9);
    expect(eulerDeg(snapAxisComponent(quat(0, 0, 88.2), 'Z', { snap: true })).z).toBeCloseTo(90, 6);
  });
  it('Snap off: settles onto a right angle inside a degree, and is free elsewhere', () => {
    expect(eulerDeg(snapAxisComponent(quat(0.6, 0, 0), 'X', { snap: false })).x).toBeCloseTo(0, 9);
    expect(eulerDeg(snapAxisComponent(quat(0, 0, 89.3), 'Z', { snap: false })).z).toBeCloseTo(90, 6);
    expect(eulerDeg(snapAxisComponent(quat(0, 0, 5), 'Z', { snap: false })).z).toBeCloseTo(5, 6);
    expect(eulerDeg(snapAxisComponent(quat(7.5, 0, 0), 'X', { snap: false })).x).toBeCloseTo(7.5, 6);
  });
  it('changes only the axis being turned', () => {
    const snapped = eulerDeg(snapAxisComponent(quat(7, 4, 0), 'X', { snap: true }));
    expect(snapped.x).toBeCloseTo(0, 6);
    expect(snapped.y).toBeCloseTo(4, 6);
  });
  it('leaves a free-form axis (screen ring, none) alone', () => {
    const q = quat(7, 4, 33);
    for (const axis of ['E', 'XYZE', null, undefined]) {
      expect(snapAxisComponent(q, axis, { snap: true }).angleTo(q)).toBeLessThan(1e-6);
    }
  });
});

describe('snapDeltaToAbsolute (#3376)', () => {
  it('lands the bundle on an exact absolute angle when the drag starts tilted', () => {
    const reference = axisAngle('x', 7); // left 7 degrees off upright last session
    const delta = axisAngle('x', 5); // the finger turned it 5 more: 12 absolute
    const adjusted = snapDeltaToAbsolute(reference, delta, 'X', { snap: true });
    const absolute = adjusted.clone().multiply(reference);
    expect(anglesFromQuaternion(absolute).tiltRed).toBe(15);
  });
  it('can bring a slightly-off bundle back to exactly upright', () => {
    const reference = axisAngle('x', 0.4);
    const delta = axisAngle('x', -0.3); // lands at 0.1 absolute
    for (const snap of [true, false]) {
      const absolute = snapDeltaToAbsolute(reference, delta, 'X', { snap }).multiply(reference);
      expect(anglesFromQuaternion(absolute)).toEqual({ turn: 0, tiltRed: 0, tiltGreen: 0 });
    }
  });
  it('is the same delta when nothing needs snapping', () => {
    const reference = quat(0, 0, 37);
    const delta = axisAngle('z', 3.3);
    expect(snapDeltaToAbsolute(reference, delta, 'Z', { snap: false }).angleTo(delta)).toBeLessThan(1e-6);
  });
});
