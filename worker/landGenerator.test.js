import { describe, expect, it } from 'vitest';
import { generateLandletRing, powerLawPlots } from './landGenerator.js';

function area(landlet) {
  return Math.abs(landlet.polygon.reduce((sum, point, index, points) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
}

describe('procedural land generation', () => {
  it('generates exact-area, centroid-local annular plots deterministically', () => {
    const first = generateLandletRing({ prefix: 'ring', count: 12, innerRadiusM: 50 });
    const second = generateLandletRing({ prefix: 'ring', count: 12, innerRadiusM: 50 });
    expect(first).toEqual(second);
    expect(first.landlets).toHaveLength(12);
    for (const landlet of first.landlets) {
      expect(area(landlet)).toBeCloseTo(1000, 8);
      expect(landlet.landClass).toBe(1);
    }
    const wrapped = generateLandletRing({ prefix: 'ring', count: 12, innerRadiusM: 50, startAngleRad: Math.PI * 2 });
    expect(wrapped.boundarySignature).toBe(first.boundarySignature);
    expect(generateLandletRing({ prefix: 'ring', count: 11, innerRadiusM: 50 }).boundarySignature)
      .not.toBe(first.boundarySignature);
  });

  it('applies the rounded-down power-law distribution without leaving gaps', () => {
    const plots = powerLawPlots(100, 'distribution-seed');
    expect(plots.filter((plot) => plot.landClass === 1)).toHaveLength(91);
    expect(plots.filter((plot) => plot.landClass === 2)).toHaveLength(9);
    expect(plots.filter((plot) => plot.landClass === 2).every(
      (plot) => plot.areaM2 >= 1001 && plot.areaM2 <= 10000,
    )).toBe(true);

    const ring = generateLandletRing({ prefix: 'mixed', count: 100, innerRadiusM: 50, plots });
    ring.landlets.forEach((landlet, index) => expect(area(landlet)).toBeCloseTo(plots[index].areaM2, 7));
    const adjacent = generateLandletRing({ prefix: 'mixed-2', count: 100, innerRadiusM: ring.outerRadiusM, plots });
    expect(adjacent.boundarySignature).toBe(ring.boundarySignature);
  });
});
