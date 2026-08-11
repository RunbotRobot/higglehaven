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
    const first = generateOrganicMosaic({ prefix: 'organic', count: 25 });
    const second = generateOrganicMosaic({ prefix: 'organic', count: 25 });
    expect(first).toEqual(second);
    expect(first).toHaveLength(25);
    first.forEach((landlet) => {
      expect(landlet.polygon.length).toBeGreaterThanOrEqual(12);
      expect(area(landlet)).toBeCloseTo(1000, 2);
      expect(landlet.metadata.generator).toBe('organic-mosaic-v1');
    });
  });
});
