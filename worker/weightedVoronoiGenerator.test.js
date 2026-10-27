// #2810 (sub-issue of #2806, itself sub-issue of #2804): the weighted-
// Voronoi/power-diagram space-partitioning engine generateOrganicMosaic
// never had -- see this module's own header comment for the algorithm.
import { describe, expect, it } from 'vitest';
import { polygonsOverlap } from './geometry.js';
import { powerLawPlots } from './landGenerator.js';
import {
  clipPolygonByHalfPlane,
  discBoundary,
  generateWeightedVoronoiTiling,
  polygonArea,
  powerCellPolygon,
} from './weightedVoronoiGenerator.js';

describe('polygonArea', () => {
  it('measures a unit square as 1', () => {
    expect(polygonArea([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }])).toBeCloseTo(1, 10);
  });

  it('is winding-direction-independent', () => {
    const clockwise = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }];
    expect(polygonArea(clockwise)).toBeCloseTo(1, 10);
  });

  it('measures a right triangle correctly', () => {
    expect(polygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }])).toBeCloseTo(6, 10);
  });
});

describe('discBoundary', () => {
  it('approximates a circle\'s area, converging as segment count rises', () => {
    const coarse = polygonArea(discBoundary(100, 8));
    const fine = polygonArea(discBoundary(100, 200));
    const trueArea = Math.PI * 100 * 100;
    expect(Math.abs(fine - trueArea)).toBeLessThan(Math.abs(coarse - trueArea));
    expect(Math.abs(fine - trueArea) / trueArea).toBeLessThan(0.001);
  });
});

describe('clipPolygonByHalfPlane', () => {
  const square = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];

  it('keeps the whole polygon when it is entirely inside the half-plane', () => {
    const clipped = clipPolygonByHalfPlane(square, { x: 1, y: 0 }, 10);
    expect(polygonArea(clipped)).toBeCloseTo(4, 10);
  });

  it('discards the whole polygon when it is entirely outside the half-plane', () => {
    const clipped = clipPolygonByHalfPlane(square, { x: 1, y: 0 }, -10);
    expect(clipped).toEqual([]);
  });

  it('splits the polygon in half across a bisecting plane', () => {
    const clipped = clipPolygonByHalfPlane(square, { x: 1, y: 0 }, 0);
    expect(polygonArea(clipped)).toBeCloseTo(2, 10);
  });
});

describe('powerCellPolygon', () => {
  it('splits a boundary into two equal halves for two equal-weight sites', () => {
    const boundary = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
    const sites = [{ x: -1, y: 0, weight: 0 }, { x: 1, y: 0, weight: 0 }];
    const cellA = powerCellPolygon(boundary, sites, 0);
    const cellB = powerCellPolygon(boundary, sites, 1);
    expect(polygonArea(cellA)).toBeCloseTo(200, 6);
    expect(polygonArea(cellB)).toBeCloseTo(200, 6);
  });

  it('shifts the split toward the lower-weight site when weights differ', () => {
    const boundary = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
    const equalWeight = [{ x: -1, y: 0, weight: 0 }, { x: 1, y: 0, weight: 0 }];
    const skewedWeight = [{ x: -1, y: 0, weight: 0 }, { x: 1, y: 0, weight: 50 }];
    const equalCell = powerCellPolygon(boundary, equalWeight, 1);
    const skewedCell = polygonArea(powerCellPolygon(boundary, skewedWeight, 1));
    expect(skewedCell).toBeGreaterThan(polygonArea(equalCell));
  });
});

describe('generateWeightedVoronoiTiling', () => {
  it('returns an empty tiling for zero target areas', () => {
    const result = generateWeightedVoronoiTiling({ boundary: discBoundary(100), areas: [], seed: 'empty' });
    expect(result.cells).toEqual([]);
    expect(result.convergedWithinTolerance).toBe(true);
  });

  it('returns the whole boundary for a single target area', () => {
    const boundary = discBoundary(50);
    const result = generateWeightedVoronoiTiling({ boundary, areas: [polygonArea(boundary)], seed: 'one-cell' });
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0].areaM2).toBeCloseTo(polygonArea(boundary), 4);
  });

  it('converges 16 equal-area cells each within tolerance of the target', () => {
    const boundary = discBoundary(100);
    const targetEach = polygonArea(boundary) / 16;
    const result = generateWeightedVoronoiTiling({ boundary, areas: Array(16).fill(targetEach), seed: 'equal-16' });
    expect(result.convergedWithinTolerance).toBe(true);
    for (const cell of result.cells) {
      expect(Math.abs(cell.areaM2 - targetEach) / targetEach).toBeLessThanOrEqual(0.02);
    }
  });

  it('converges a realistic power-law size mix within tolerance', () => {
    const boundary = discBoundary(300);
    const boundaryAreaM2 = polygonArea(boundary);
    const plots = powerLawPlots(24, 'power-law-mix');
    const totalRaw = plots.reduce((sum, plot) => sum + plot.areaM2, 0);
    const areas = plots.map((plot) => (plot.areaM2 / totalRaw) * boundaryAreaM2);

    const result = generateWeightedVoronoiTiling({ boundary, areas, seed: 'power-law-mix' });
    expect(result.convergedWithinTolerance).toBe(true);
    for (const cell of result.cells) {
      expect(Math.abs(cell.areaM2 - cell.targetAreaM2) / cell.targetAreaM2).toBeLessThanOrEqual(0.02);
    }
  });

  it('produces a gap-free, non-overlapping tiling (areas sum to the boundary, no pairwise overlap)', () => {
    const boundary = discBoundary(300);
    const boundaryAreaM2 = polygonArea(boundary);
    const plots = powerLawPlots(20, 'no-overlap-check');
    const totalRaw = plots.reduce((sum, plot) => sum + plot.areaM2, 0);
    const areas = plots.map((plot) => (plot.areaM2 / totalRaw) * boundaryAreaM2);

    const result = generateWeightedVoronoiTiling({ boundary, areas, seed: 'no-overlap-check' });
    const sumOfCellAreas = result.cells.reduce((sum, cell) => sum + cell.areaM2, 0);
    expect(Math.abs(sumOfCellAreas - boundaryAreaM2) / boundaryAreaM2).toBeLessThanOrEqual(0.02);

    for (let i = 0; i < result.cells.length; i += 1) {
      for (let j = i + 1; j < result.cells.length; j += 1) {
        expect(polygonsOverlap(result.cells[i].polygon, result.cells[j].polygon)).toBe(false);
      }
    }
  });

  it('is deterministic for the same seed, and varies for a different seed', () => {
    const boundary = discBoundary(150);
    const areas = Array(8).fill(polygonArea(boundary) / 8);

    const first = generateWeightedVoronoiTiling({ boundary, areas, seed: 'determinism-a' });
    const second = generateWeightedVoronoiTiling({ boundary, areas, seed: 'determinism-a' });
    expect(first.cells.map((cell) => cell.center)).toEqual(second.cells.map((cell) => cell.center));

    const third = generateWeightedVoronoiTiling({ boundary, areas, seed: 'determinism-b' });
    expect(third.cells.map((cell) => cell.center)).not.toEqual(first.cells.map((cell) => cell.center));
  });

  // #2811 (sub-issue of #2806): the generic mechanism its own DB-aware
  // water wrapper (worker/lib/water-aware-mosaic.js) builds on, tested
  // here in isolation from any real water data.
  describe('fixedSites / avoidRegions (#2811)', () => {
    it('places a fixed site at its exact given position and never re-centers it', () => {
      const boundary = discBoundary(200);
      const areas = Array(6).fill(1000);
      const fixedSites = [{ x: 50, y: -30, areaM2: 2000 }];

      const result = generateWeightedVoronoiTiling({ boundary, areas, seed: 'fixed-site', fixedSites });
      expect(result.cells).toHaveLength(areas.length + fixedSites.length);
      const fixedCell = result.cells[result.cells.length - 1];
      expect(fixedCell.fixed).toBe(true);
      expect(fixedCell.center).toEqual({ x: 50, y: -30 });
      expect(result.cells.slice(0, areas.length).every((cell) => cell.fixed === false)).toBe(true);
    });

    it('still converges every cell (fixed and random) within tolerance, and the whole tiling still covers the boundary', () => {
      const boundary = discBoundary(300);
      const boundaryAreaM2 = polygonArea(boundary);
      const fixedSites = [{ x: -80, y: 60, areaM2: boundaryAreaM2 * 0.1 }];
      const areas = Array(10).fill((boundaryAreaM2 * 0.9) / 10);

      const result = generateWeightedVoronoiTiling({ boundary, areas, seed: 'fixed-plus-random', fixedSites });
      expect(result.convergedWithinTolerance).toBe(true);
      const sumAreas = result.cells.reduce((sum, cell) => sum + cell.areaM2, 0);
      expect(Math.abs(sumAreas - boundaryAreaM2) / boundaryAreaM2).toBeLessThanOrEqual(0.02);
    });

    it('keeps a randomly-placed site\'s initial position outside every avoidRegions circle', () => {
      const boundary = discBoundary(100);
      const areas = Array(20).fill(polygonArea(boundary) / 20);
      const avoidRegions = [{ x: 0, y: 0, radius: 60 }];

      // recenterFactor: 0 disables relaxation moving sites afterward, so this
      // checks placement itself, not where recentering later moved them.
      const result = generateWeightedVoronoiTiling({
        boundary, areas, seed: 'avoid-regions', avoidRegions, recenterFactor: 0,
      });
      for (const cell of result.cells) {
        expect(Math.hypot(cell.center.x, cell.center.y)).toBeGreaterThanOrEqual(60);
      }
    });
  });
});
