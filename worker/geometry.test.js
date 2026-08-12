import { describe, expect, it } from 'vitest';
import {
  landletMaxWorldRadius,
  landletMinWorldRadius,
  landletWorldPolygon,
  pointInPolygon,
  pointToSegmentDistance,
  polygonsOverlap,
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

  it('translates a landlet row polygon into absolute world coordinates', () => {
    const square = row({ centerX: 10, centerY: -5, polygon: [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }] });
    expect(landletWorldPolygon(square)).toEqual([
      { x: 8, y: -7 }, { x: 12, y: -7 }, { x: 12, y: -3 }, { x: 8, y: -3 },
    ]);
    expect(landletWorldPolygon(row())).toEqual([]);
  });
});

describe('polygonsOverlap', () => {
  const square = (cx, cy, half = 2) => [
    { x: cx - half, y: cy - half }, { x: cx + half, y: cy - half },
    { x: cx + half, y: cy + half }, { x: cx - half, y: cy + half },
  ];

  it('detects overlap when one polygon contains the other', () => {
    expect(polygonsOverlap(square(0, 0, 5), square(0, 0, 1))).toBe(true);
  });

  it('detects overlap when polygons partially intersect with no vertex inside either', () => {
    // Two crosses/plus-shapes offset so their arms cross without either
    // shape's own vertices landing inside the other — only edge crossings.
    const crossA = [
      { x: -1, y: -3 }, { x: 1, y: -3 }, { x: 1, y: 3 }, { x: -1, y: 3 },
    ];
    const crossB = [
      { x: -3, y: -1 }, { x: 3, y: -1 }, { x: 3, y: 1 }, { x: -3, y: 1 },
    ];
    expect(polygonsOverlap(crossA, crossB)).toBe(true);
  });

  it('does not flag adjacent squares that only share an edge as overlapping', () => {
    expect(polygonsOverlap(square(0, 0), square(4, 0))).toBe(false);
  });

  it('does not flag disjoint polygons', () => {
    expect(polygonsOverlap(square(0, 0), square(100, 100))).toBe(false);
  });
});
