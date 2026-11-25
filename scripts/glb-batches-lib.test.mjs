// #4111: the scan reads each stored model's colour from its glTF materials, as the generator's own check does.
import { describe, expect, it } from 'vitest';
import { glbBatches } from './glb-batches-lib.mjs';
import { icosphereGlb } from './icosphere-glb.mjs';
import { colorShift } from '../src/tierFidelity.js';

describe('glbBatches colour (#4111)', () => {
  it('gives each batch its area and its lit colour', () => {
    const { batches } = glbBatches(icosphereGlb(2, 1).glb);
    expect(batches).toHaveLength(1);
    // Area of a unit icosphere is a little under 4 pi; the colour is the material's own (metallicFactor 0).
    expect(batches[0].area).toBeGreaterThan(10);
    expect(batches[0].area).toBeLessThan(4 * Math.PI);
    expect(batches[0].color).toEqual([expect.closeTo(0.85, 5), expect.closeTo(0.45, 5), expect.closeTo(0.15, 5)]);
  });

  it('reads a model as its own colour (no shift), the check the scan applies to stored versions', () => {
    const a = glbBatches(icosphereGlb(2, 1).glb).batches;
    const b = glbBatches(icosphereGlb(1, 1).glb).batches;
    expect(colorShift(a, b)).toBeLessThan(1e-6);
  });
});
