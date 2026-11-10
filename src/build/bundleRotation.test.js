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

import { reseatInBounds } from './bundleRotation.js';

describe('reseatInBounds (#3371)', () => {
  const bounds = { minX: -10, maxX: 10, minY: -10, maxY: 10, minZ: 0, maxZ: 10 };
  // A wall wider than tall: 9 columns of 3 rows, centred on a pivot at z = 1.
  const wall = [];
  for (let x = -4; x <= 4; x++) for (let z = 0; z <= 2; z++) {
    wall.push({ position: new THREE.Vector3(x, 0, 1 + z - 1), quaternion: new THREE.Quaternion() });
  }
  const wallPivot = bundlePivot(wall.map((m) => m.position));

  for (const [name, axis] of [['X', [1, 0, 0]], ['Y', [0, 1, 0]]]) {
    it(`yields a legal transform at every step of a 0..180 degree sweep about ${name}, never below the floor, shape kept`, () => {
      for (let deg = 0; deg <= 180; deg += 5) {
        const delta = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), (deg * Math.PI) / 180);
        const raw = rotateMembersRigidly(wall, wallPivot, delta);
        const { transforms, fits } = reseatInBounds(raw, bounds);
        expect(fits).toBe(true);
        expect(Math.min(...transforms.map((t) => t.position.z))).toBeGreaterThanOrEqual(-1e-9);
        for (const t of transforms) expect(Math.abs(t.position.x)).toBeLessThanOrEqual(10 + 1e-9);
        for (let i = 1; i < wall.length; i++) {
          expect(transforms[i].position.distanceTo(transforms[0].position)).toBeCloseTo(raw[i].position.distanceTo(raw[0].position), 6);
        }
      }
    });
  }

  it('lifts a tilted wall so its lowest member rests on the floor', () => {
    // Tipping the wide wall about Y swings its far columns below the floor.
    const delta = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const raw = rotateMembersRigidly(wall, wallPivot, delta);
    expect(Math.min(...raw.map((t) => t.position.z))).toBeLessThan(-1);
    const { transforms } = reseatInBounds(raw, bounds);
    expect(Math.min(...transforms.map((t) => t.position.z))).toBeCloseTo(0, 6);
  });

  it('slides a bundle in from an edge by the smallest offset', () => {
    const out = reseatInBounds([{ position: new THREE.Vector3(12, 0, 5), quaternion: new THREE.Quaternion() }, { position: new THREE.Vector3(8, 0, 5), quaternion: new THREE.Quaternion() }], bounds);
    expect(out.fits).toBe(true);
    expect(out.transforms.map((t) => t.position.x)).toEqual([10, 6]);
  });

  it('returns the input unchanged when it already fits', () => {
    const raw = wall.map((m) => ({ ...m, position: m.position.clone().setZ(5) }));
    expect(reseatInBounds(raw, bounds).transforms).toBe(raw);
  });

  it('reports fits=false only when the bundle is bigger than the bounds', () => {
    const tall = [{ position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() }, { position: new THREE.Vector3(0, 0, 11), quaternion: new THREE.Quaternion() }];
    expect(reseatInBounds(tall, bounds).fits).toBe(false);
  });
});
