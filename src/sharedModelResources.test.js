import { describe, expect, it } from 'vitest';
import { markSharedModelResources, ownsGeometryAndTextures } from './sharedModelResources.js';

describe('shared model resources (#1560)', () => {
  it('treats an unmarked mesh as owning its geometry and textures', () => {
    expect(ownsGeometryAndTextures({ userData: {} })).toBe(true);
    expect(ownsGeometryAndTextures({})).toBe(true);
  });

  it('treats a marked mesh as sharing them with its cached source and sibling clones', () => {
    const mesh = { userData: {} };
    markSharedModelResources(mesh);
    expect(ownsGeometryAndTextures(mesh)).toBe(false);
  });
});
