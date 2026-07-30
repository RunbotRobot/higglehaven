import { describe, expect, it } from 'vitest';
import {
  landletMaxWorldRadius,
  landletMinWorldRadius,
  pointInPolygon,
  pointToSegmentDistance,
} from './geometry.js';

function row({ centerX = 0, centerY = 0, areaM2 = 4, polygon = [] } = {}) {
  return {
    center_x_m: centerX,
    center_y_m: centerY,
    area_m2: areaM2,
    polygon_json: JSON.stringify(polygon),
  };
}

describe('world-circle geometry', () => {
  it('calculates the nearest polygon edge even when no vertex is nearest', () => {
    const square = row({
      centerX: 10,
      polygon: [
        { x: -2, y: -2 },
        { x: 2, y: -2 },
        { x: 2, y: 2 },
        { x: -2, y: 2 },
      ],
    });

    expect(landletMinWorldRadius(square)).toBe(8);
    expect(landletMaxWorldRadius(square)).toBeCloseTo(Math.hypot(12, 2));
  });

  it('returns zero minimum radius when a polygon contains the world origin', () => {
    const surrounding = row({
      polygon: [
        { x: -2, y: -2 },
        { x: 2, y: -2 },
        { x: 2, y: 2 },
        { x: -2, y: 2 },
      ],
    });
    expect(landletMinWorldRadius(surrounding)).toBe(0);
    expect(pointInPolygon({ x: 0, y: 0 }, JSON.parse(surrounding.polygon_json))).toBe(true);
  });

  it('uses a same-area circle for polygonless placeholders', () => {
    const placeholder = row({ centerX: 10, areaM2: Math.PI * 4 });
    expect(landletMinWorldRadius(placeholder)).toBe(8);
    expect(landletMaxWorldRadius(placeholder)).toBe(12);
  });

  it('handles degenerate and ordinary line segments', () => {
    expect(pointToSegmentDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
    expect(pointToSegmentDistance({ x: 2, y: 3 }, { x: 0, y: 0 }, { x: 4, y: 0 })).toBe(3);
  });
});
