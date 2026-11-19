import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { nudgeVector, nudgeStepMeters, heightAboveFloor, NUDGE_DIRECTIONS } from './nudge.js';

const near = (v, x, y, z) => {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
};

describe('nudgeVector', () => {
  const upright = new THREE.Quaternion();
  it('moves along the item\'s own ground axes, and the world\'s vertical for up and down', () => {
    near(nudgeVector(upright, 'right'), 1, 0, 0);
    near(nudgeVector(upright, 'left'), -1, 0, 0);
    near(nudgeVector(upright, 'forward'), 0, 1, 0);
    near(nudgeVector(upright, 'back'), 0, -1, 0);
    near(nudgeVector(upright, 'up'), 0, 0, 1);
    near(nudgeVector(upright, 'down'), 0, 0, -1);
  });
  it('turns with the item: a wall turned 90 degrees slides along the wall', () => {
    const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    near(nudgeVector(turned, 'right'), 0, 1, 0);
    near(nudgeVector(turned, 'forward'), -1, 0, 0);
    near(nudgeVector(turned, 'up'), 0, 0, 1);
  });
  it('stays on the ground for a tilted item', () => {
    const tilted = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5);
    const v = nudgeVector(tilted, 'forward');
    expect(v.z).toBe(0);
    expect(v.length()).toBeCloseTo(1, 6);
  });
  it('falls back to the world\'s axis for an item on its side', () => {
    const onSide = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    near(nudgeVector(onSide, 'forward'), 0, 1, 0);
  });
  it('has a vector for every direction and none for a made-up one', () => {
    for (const d of NUDGE_DIRECTIONS) expect(nudgeVector(upright, d).length()).toBeGreaterThan(0.99);
    expect(nudgeVector(upright, 'sideways').length()).toBe(0);
  });
});

describe('step and height', () => {
  it('is a tenth of a metre, or a quarter of a foot', () => {
    expect(nudgeStepMeters('m')).toBeCloseTo(0.1, 9);
    expect(nudgeStepMeters('ft')).toBeCloseTo(0.0762, 6);
  });
  it('reads the underside above the floor, never "-0"', () => {
    expect(heightAboveFloor(0.6, 1.2, 0)).toBe(0);
    expect(heightAboveFloor(1.7, 1.2, 0)).toBeCloseTo(1.1, 9);
    expect(heightAboveFloor(3.1, 1.2, 2)).toBeCloseTo(0.5, 9);
  });
});
