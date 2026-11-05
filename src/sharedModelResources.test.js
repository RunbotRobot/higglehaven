import { describe, expect, it } from 'vitest';
import {
  disposeOwnedMeshResources, markSharedModelResources, markSharedModelTextures, ownsGeometry, ownsGeometryAndTextures,
  ownsTextures,
} from './sharedModelResources.js';

describe('shared model resources (#1560)', () => {
  it('treats an unmarked mesh as owning its geometry and textures', () => {
    expect(ownsGeometryAndTextures({ userData: {} })).toBe(true);
    expect(ownsGeometryAndTextures({})).toBe(true);
  });

  it('treats a marked mesh as sharing them with its cached source and sibling clones', () => {
    const mesh = { userData: {} };
    markSharedModelResources(mesh);
    expect(ownsGeometryAndTextures(mesh)).toBe(false);
    expect(ownsGeometry(mesh)).toBe(false);
    expect(ownsTextures(mesh)).toBe(false);
  });

  it('treats a cropped instance as owning its geometry but sharing its textures', () => {
    const mesh = { userData: {} };
    markSharedModelTextures(mesh);
    expect(ownsGeometry(mesh)).toBe(true);
    expect(ownsTextures(mesh)).toBe(false);
    expect(ownsGeometryAndTextures(mesh)).toBe(false);
  });
});

describe('disposeOwnedMeshResources (#1560)', () => {
  function fakeMesh(mark) {
    const calls = [];
    const material = (name) => ({ dispose: () => calls.push(`material:${name}`) });
    const mesh = {
      userData: {},
      geometry: { dispose: () => calls.push('geometry') },
      material: [material('real'), material('backing')],
    };
    if (mark) mark(mesh);
    return { mesh, calls, disposeTextures: () => calls.push('textures') };
  }

  it('frees geometry, textures and materials for a mesh that owns everything', () => {
    const { mesh, calls, disposeTextures } = fakeMesh();
    disposeOwnedMeshResources(mesh, disposeTextures);
    expect(calls).toEqual(['geometry', 'textures', 'material:real', 'textures', 'material:backing']);
  });

  it('frees only the cloned materials for a clone sharing geometry and textures with the cache', () => {
    const { mesh, calls, disposeTextures } = fakeMesh(markSharedModelResources);
    disposeOwnedMeshResources(mesh, disposeTextures);
    expect(calls).toEqual(['material:real', 'material:backing']);
  });

  it('frees a cropped instance\'s own geometry and materials but not the textures it shares with the cache', () => {
    const { mesh, calls, disposeTextures } = fakeMesh(markSharedModelTextures);
    disposeOwnedMeshResources(mesh, disposeTextures);
    expect(calls).toEqual(['geometry', 'material:real', 'material:backing']);
  });

  it('copes with a single material and a missing one', () => {
    const calls = [];
    disposeOwnedMeshResources({ userData: {}, geometry: null, material: { dispose: () => calls.push('m') } }, () => calls.push('t'));
    expect(calls).toEqual(['t', 'm']);
    expect(() => disposeOwnedMeshResources({ userData: {}, material: null }, () => {})).not.toThrow();
  });
});
