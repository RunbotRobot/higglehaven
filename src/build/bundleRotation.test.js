import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { rotateMembersRigidly, bundlePivot } from './bundleRotation.js';

const members = [
  { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
  { position: new THREE.Vector3(2, 0, 0), quaternion: new THREE.Quaternion() },
  { position: new THREE.Vector3(1, 1, 3), quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.1, 0.3)) },
];
const pivot = bundlePivot(members.map((m) => m.position));

describe('rotateMembersRigidly', () => {
  for (const [name, axis] of [['X', [1, 0, 0]], ['Y', [0, 1, 0]], ['Z', [0, 0, 1]]]) {
    it(`preserves pairwise distances and relative orientation about ${name}`, () => {
      const delta = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), Math.PI / 2);
      const out = rotateMembersRigidly(members, pivot, delta);
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          expect(out[i].position.distanceTo(out[j].position)).toBeCloseTo(members[i].position.distanceTo(members[j].position), 6);
          const before = members[i].quaternion.clone().invert().multiply(members[j].quaternion);
          const after = out[i].quaternion.clone().invert().multiply(out[j].quaternion);
          expect(Math.abs(before.dot(after))).toBeCloseTo(1, 6);
        }
      }
    });
  }

  it('turns a wall 90 degrees about Z so the pair ends up along Y with each piece turned 90 degrees', () => {
    const wall = [
      { position: new THREE.Vector3(-1, 0, 0), quaternion: new THREE.Quaternion() },
      { position: new THREE.Vector3(1, 0, 0), quaternion: new THREE.Quaternion() },
    ];
    const delta = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const [a, b] = rotateMembersRigidly(wall, new THREE.Vector3(), delta);
    expect(a.position.x).toBeCloseTo(0, 6); expect(a.position.y).toBeCloseTo(-1, 6);
    expect(b.position.x).toBeCloseTo(0, 6); expect(b.position.y).toBeCloseTo(1, 6);
    expect(new THREE.Euler().setFromQuaternion(a.quaternion).z).toBeCloseTo(Math.PI / 2, 6);
  });

  it('does not mutate its inputs and is the identity for a zero rotation', () => {
    const before = members[1].position.clone();
    const out = rotateMembersRigidly(members, pivot, new THREE.Quaternion());
    expect(members[1].position.equals(before)).toBe(true);
    expect(out[1].position.distanceTo(before)).toBeCloseTo(0, 9);
  });
});

describe('bundlePivot', () => {
  it('is the centre of the bounding box of the positions', () => {
    expect(bundlePivot([new THREE.Vector3(0, 0, 0), new THREE.Vector3(4, 2, 6)]).toArray()).toEqual([2, 1, 3]);
  });
});
