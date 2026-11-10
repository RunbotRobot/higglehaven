// #3401: a geometry-free placement handle has the same transform and userData
// as the mesh createMeshForInstance builds, and meshDimensions needs nothing
// else from it.
import { describe, expect, it } from 'vitest';
import { createPlacementHandle } from './placementHandle.js';
import { placementUserData } from '../shop/instanceBatching.js';

const template = {
  templateId: 'brick', modelUrl: '/m/brick.glb', color: '#aa5533', metadata: {},
  dimensions: { width: 0.2, depth: 0.1, height: 0.07 },
};

describe('createPlacementHandle', () => {
  it('places and rotates like a built mesh, resting on the ground by default', () => {
    const handle = createPlacementHandle({ instanceId: 'h1', x: 3, y: -2, rotationZ: 1.5 }, template);
    expect(handle.position.toArray()).toEqual([3, -2, 0.035]);
    expect(handle.rotation.z).toBeCloseTo(1.5);
    expect(handle.children).toHaveLength(0);
    expect(handle.geometry).toBeUndefined();
  });

  it('honours a stored z and scale', () => {
    const handle = createPlacementHandle({ instanceId: 'h2', z: 4, scale: 2 }, template);
    expect(handle.position.z).toBe(4);
    expect(handle.scale.x).toBe(2);
  });

  it('carries exactly the shared userData, plus the handle marker', () => {
    const instance = { instanceId: 'h3', groupId: 'g1', bundleId: 'b1', label: 'wall' };
    const handle = createPlacementHandle(instance, template);
    expect(handle.userData).toEqual({ ...placementUserData(instance, template), isPlacementHandle: true });
  });

  it('carries what meshDimensions reads (template, crop, scale), so it measures without geometry', () => {
    const handle = createPlacementHandle({ instanceId: 'h4', scale: 2, crop: { x: 0.1 } }, template);
    expect(handle.userData.template).toBe(template);
    expect(handle.userData.crop).toEqual({ x: 0.1 });
    expect(handle.userData.scale).toBe(2);
  });

  it('rests a cropped-height placement on the ground at half its cropped height', () => {
    const handle = createPlacementHandle({ instanceId: 'h5', crop: { z: 0.04 } }, template);
    expect(handle.position.z).toBeCloseTo(0.02);
  });
});
