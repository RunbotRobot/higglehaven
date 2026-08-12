import { describe, expect, it } from 'vitest';
import { generateOrganicMosaic } from './organicLandGenerator.js';

function area(landlet) {
  return Math.abs(landlet.polygon.reduce((sum, point, index, points) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}

describe('organic land generation', () => {
  it('is deterministic and produces curved, near-target-area puzzle pieces', () => {
    const first = generateOrganicMosaic({ prefix: 'organic', count: 16 });
    const second = generateOrganicMosaic({ prefix: 'organic', count: 16 });
    expect(first).toEqual(second);
    expect(first).toHaveLength(16);
    first.forEach((landlet) => {
      expect(landlet.polygon.length).toBeGreaterThanOrEqual(12);
      expect(area(landlet)).toBeCloseTo(1000, 2);
      expect(landlet.metadata.generator).toBe('organic-mosaic-v1');
    });
  });

  it('rejects shapes that do not have a precomputed free-tier template', () => {
    expect(() => generateOrganicMosaic({ prefix: 'large', count: 50 })).toThrow(/exactly 16/);
  });
});
