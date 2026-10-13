import { describe, expect, it } from 'vitest';
import { sampleUniformDiskRadiusM } from './spawnLocation.js';

describe('sampleUniformDiskRadiusM', () => {
  it('maps a 0 draw to the center', () => {
    expect(sampleUniformDiskRadiusM(50, 0)).toBe(0);
  });

  it('maps a draw of 1 to the full max radius', () => {
    expect(sampleUniformDiskRadiusM(50, 1)).toBe(50);
  });

  it('scales by sqrt of the draw, not the draw itself', () => {
    // sqrt(0.25) = 0.5, so a quarter-way-through draw lands at half radius.
    expect(sampleUniformDiskRadiusM(100, 0.25)).toBeCloseTo(50, 10);
  });

  it('regression (#1816): a uniform [0,1) draw produces a uniform-over-area radius, not a uniform-over-radius one', () => {
    // Sampling radiusM = Math.random() * maxRadiusM directly (the pre-fix
    // behavior) put 50% of draws within the inner half of the radius, since
    // area scales with r. The corrected sqrt mapping should instead put
    // roughly 25% of draws that close in, matching the disk's own area
    // fraction out to half radius ((maxRadiusM/2)^2 / maxRadiusM^2 = 0.25).
    const maxRadiusM = 50;
    const samples = 20000;
    let withinHalf = 0;
    for (let i = 0; i < samples; i++) {
      // A deterministic, evenly-spread stand-in for Math.random() so this
      // test doesn't depend on actual randomness to land close to 0.25.
      const randomValue = i / samples;
      const radiusM = sampleUniformDiskRadiusM(maxRadiusM, randomValue);
      if (radiusM <= maxRadiusM / 2) withinHalf++;
    }
    expect(withinHalf / samples).toBeCloseTo(0.25, 2);
  });
});
