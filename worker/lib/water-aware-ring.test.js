// #2821 (sub-issue of #2804, water-first/variable-size landlet generation):
// water-aware generation for the growth-time RING path, mirroring #2811's
// own water-aware-mosaic.test.js shape but against a fundamentally
// different algorithm -- see water-aware-ring.js's own header comment for
// why this isn't just a ring-shaped reuse of the 2D Voronoi core. Tests
// against synthetic seeded geo_water_cells_fine rows, same as #2811's own
// suite -- that table is still empty in production pending #2805's own
// NHD-outage follow-up.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { polygonsOverlap } from '../geometry.js';
import { powerLawPlots, ringAreaScale } from '../landGenerator.js';
import {
  detectWaterArcs, generateWaterAwareLandletRing, PREDOMINANTLY_WATER_THRESHOLD,
} from './water-aware-ring.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// Every ring in this file is centered on the world origin by construction
// (that's what a ring is), so unlike water-aware-mosaic.test.js's own
// tests -- each a disc placeable anywhere -- these can't rely on using a
// different location per test to avoid collisions. fetchWaterKeySet's own
// bounding-box query is always centered at the origin too, so leftover
// water from an earlier test would otherwise leak into a later one.
beforeEach(async () => {
  await env.DB.exec('DELETE FROM geo_water_cells_fine');
});

const SPACING_M = 5;
const TAU = Math.PI * 2;

// Seeds every real fine-grid lattice point (the same Cartesian, spacing-
// aligned lattice detectWaterArcs' own sampling enumerates) that falls
// inside the given annular sector -- walking the lattice directly (rather
// than a polar sweep rounded onto it) guarantees exact, complete coverage
// of the target region with no density/rounding-alignment gap, and a
// single batched insert keeps it fast even across a wide span.
async function seedWaterArc(innerRadiusM, outerRadiusM, startAngle, endAngle) {
  const now = new Date().toISOString();
  const spacing = SPACING_M;
  const span = endAngle - startAngle;
  const minX = Math.floor(-outerRadiusM / spacing) * spacing;
  const maxX = Math.ceil(outerRadiusM / spacing) * spacing;
  const statements = [];
  for (let x = minX; x <= maxX; x += spacing) {
    for (let y = minX; y <= maxX; y += spacing) {
      const radius = Math.hypot(x, y);
      if (radius < innerRadiusM || radius > outerRadiusM) continue;
      const angle = Math.atan2(y, x);
      const diff = (((angle - startAngle) % TAU) + TAU) % TAU;
      if (diff > span) continue;
      statements.push(env.DB.prepare(
        'INSERT OR IGNORE INTO geo_water_cells_fine (x_m, y_m, spacing_m, generated_at) VALUES (?, ?, ?, ?)',
      ).bind(x, y, spacing, now));
    }
  }
  if (statements.length > 0) await env.DB.batch(statements);
}

function area(landlet) {
  return Math.abs(landlet.polygon.reduce((sum, point, index, points) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
}

function absolutePolygon(landlet) {
  return landlet.polygon.map((point) => ({ x: point.x + landlet.center.x, y: point.y + landlet.center.y }));
}

function assertGapFreeAndNonOverlapping(landlets, innerRadiusM, outerRadiusM) {
  const totalArea = landlets.reduce((sum, landlet) => sum + area(landlet), 0);
  const expectedArea = 0.5 * TAU * (outerRadiusM ** 2 - innerRadiusM ** 2);
  expect(Math.abs(totalArea - expectedArea) / expectedArea).toBeLessThan(0.01);

  const polygons = landlets.map(absolutePolygon);
  for (let i = 0; i < polygons.length; i += 1) {
    for (let j = i + 1; j < polygons.length; j += 1) {
      expect(polygonsOverlap(polygons[i], polygons[j])).toBe(false);
    }
  }
}

describe('detectWaterArcs (#2821)', () => {
  const innerRadiusM = 1000;
  const outerRadiusM = 1050;

  it('returns no arcs against an empty table', async () => {
    expect(await detectWaterArcs(env.DB, { innerRadiusM, outerRadiusM, startAngleRad: 10 })).toEqual([]);
  });

  it('detects a single contiguous arc away from the seam', async () => {
    const startAngleRad = 20; // far from any real seam concern in this test's own frame
    await seedWaterArc(innerRadiusM, outerRadiusM, startAngleRad + 1.0, startAngleRad + 1.3);
    const arcs = await detectWaterArcs(env.DB, { innerRadiusM, outerRadiusM, startAngleRad, sliceCount: 72 });
    expect(arcs).toHaveLength(1);
    expect(arcs[0].startAngle).toBeGreaterThanOrEqual(startAngleRad + 1.0 - TAU / 72);
    expect(arcs[0].startAngle).toBeLessThanOrEqual(startAngleRad + 1.0 + TAU / 72);
    expect(arcs[0].endAngle).toBeGreaterThan(arcs[0].startAngle);
    expect(arcs[0].endAngle).toBeLessThanOrEqual(startAngleRad + 1.3 + TAU / 72);
  });

  it('detects a water arc that straddles the startAngleRad seam, extending past startAngleRad + TAU', async () => {
    const startAngleRad = 30;
    // Seed water spanning the seam itself (startAngleRad + TAU), so the
    // underlying real arc covers slices on both sides of slot 0.
    await seedWaterArc(innerRadiusM, outerRadiusM, startAngleRad + TAU - 0.1, startAngleRad + TAU + 0.1);
    const arcs = await detectWaterArcs(env.DB, { innerRadiusM, outerRadiusM, startAngleRad, sliceCount: 72 });
    expect(arcs).toHaveLength(1);
    // A wrapping arc's own endAngle extends past startAngleRad + TAU --
    // this module's own contract (generateWaterAwareLandletRing normalizes
    // it back into its own walk's bounds itself, see splitWrappingArcs).
    expect(arcs[0].endAngle).toBeGreaterThan(startAngleRad + TAU);
    expect(arcs[0].startAngle).toBeLessThan(startAngleRad + TAU);
  });

  it('keeps two separate arcs distinct', async () => {
    const startAngleRad = 50;
    await seedWaterArc(innerRadiusM, outerRadiusM, startAngleRad + 0.5, startAngleRad + 0.7);
    await seedWaterArc(innerRadiusM, outerRadiusM, startAngleRad + 3.0, startAngleRad + 3.2);
    const arcs = await detectWaterArcs(env.DB, { innerRadiusM, outerRadiusM, startAngleRad, sliceCount: 72 });
    expect(arcs).toHaveLength(2);
  });

  it('treats an entirely submerged ring as a single full-circle arc', async () => {
    const startAngleRad = 70;
    await seedWaterArc(innerRadiusM, outerRadiusM, startAngleRad, startAngleRad + TAU);
    const arcs = await detectWaterArcs(env.DB, {
      innerRadiusM, outerRadiusM, startAngleRad, sliceCount: 36, waterThreshold: PREDOMINANTLY_WATER_THRESHOLD,
    });
    expect(arcs).toEqual([{ startAngle: startAngleRad, endAngle: startAngleRad + TAU }]);
  });
});

describe('generateWaterAwareLandletRing (#2821)', () => {
  it('matches plain uniform generation when no water is seeded', async () => {
    const result = await generateWaterAwareLandletRing(env.DB, {
      prefix: 'no-water-ring', count: 12, innerRadiusM: 50, startAngleRad: 90,
    });
    expect(result.waterArcCount).toBe(0);
    expect(result.landlets).toHaveLength(12);
    for (const landlet of result.landlets) {
      expect(area(landlet)).toBeCloseTo(1000, 6);
      expect(landlet.landType).toBe('buildable');
    }
    assertGapFreeAndNonOverlapping(result.landlets, 50, result.outerRadiusM);

    // Should also closely match generateLandletRing's own (non-water-aware)
    // outer radius for the identical no-water input, confirmed via the
    // same ringAreaScale this module reuses.
    const scale = ringAreaScale(Array.from({ length: 12 }, () => 1000), 4);
    expect(result.outerRadiusM).toBeCloseTo(Math.sqrt(50 ** 2 + 2 * scale), 6);
  });

  it('classifies a real seeded water arc as water, carving land away from it', async () => {
    const startAngleRad = 110;
    const innerRadiusM = 1000;
    // A generous, uniform ring sized well past the water's own angular
    // span below, so the land plots clearly have room to carve around it.
    const plots = powerLawPlots(20, 'ring-water-seed');
    const scale = ringAreaScale(plots.map((plot) => plot.areaM2), 4);
    const roughOuterRadiusM = Math.sqrt(innerRadiusM ** 2 + 2 * scale);
    await seedWaterArc(innerRadiusM, roughOuterRadiusM + 50, startAngleRad + 0.3, startAngleRad + 0.4);

    const result = await generateWaterAwareLandletRing(env.DB, {
      prefix: 'water-carve-ring', count: 20, innerRadiusM, startAngleRad, plots,
    });
    expect(result.waterArcCount).toBeGreaterThanOrEqual(1);
    const waterLandlets = result.landlets.filter((landlet) => landlet.landType === 'water');
    expect(waterLandlets.length).toBeGreaterThanOrEqual(1);
    assertGapFreeAndNonOverlapping(result.landlets, innerRadiusM, result.outerRadiusM);

    // The ring should have grown a little to make room for the water
    // without shrinking any land plot's own target area.
    expect(result.outerRadiusM).toBeGreaterThanOrEqual(roughOuterRadiusM - 1e-6);
  });

  it('splits a land plot straddling a water arc into fragments that still sum to its full width', async () => {
    const startAngleRad = 150;
    const innerRadiusM = 1000;
    const count = 36;
    // Uniform, ordinary-sized plots (same default shape generateLandletRing
    // itself defaults to) -- unlike a single plot spanning almost the whole
    // ring, each one here has a small, realistic angular share, so
    // annularSectorPolygon's fixed 4-segment chord approximation stays
    // accurate (the same precision generateLandletRing's own tests already
    // rely on for ordinary plots -- it only breaks down for an
    // unrealistically wide single span, not the case this module actually
    // needs to handle well).
    const noWaterScale = ringAreaScale(Array.from({ length: count }, () => 1000), 4);
    const plotAngle = 4 * Math.asin(Math.min(1, 1000 / (noWaterScale * 4)));
    // The middle of plot index 5's own expected span, narrow enough (10%
    // of one plot's own width) to stay inside it even after water shifts
    // the shared scale slightly during convergence.
    const mid = startAngleRad + 5.5 * plotAngle;
    const roughOuterRadiusM = Math.sqrt(innerRadiusM ** 2 + 2 * noWaterScale);
    // Wide enough to clearly push at least one of detectWaterArcs' own
    // (TAU/72-wide) slices past its 50% threshold, narrow enough to still
    // leave real buildable margin on both sides within this one plot.
    await seedWaterArc(innerRadiusM, roughOuterRadiusM + 50, mid - plotAngle * 0.3, mid + plotAngle * 0.3);

    const result = await generateWaterAwareLandletRing(env.DB, {
      prefix: 'split-ring', count, innerRadiusM, startAngleRad,
    });
    expect(result.waterArcCount).toBeGreaterThanOrEqual(1);
    const fragments = result.landlets.filter(
      (landlet) => landlet.landType === 'buildable' && landlet.metadata.waterSplitFragment,
    );
    expect(fragments.length).toBeGreaterThanOrEqual(2);
    assertGapFreeAndNonOverlapping(result.landlets, innerRadiusM, result.outerRadiusM);
  });

  it('is deterministic for the same inputs', async () => {
    const startAngleRad = 200;
    const innerRadiusM = 2000;
    await seedWaterArc(innerRadiusM, innerRadiusM + 60, startAngleRad + 0.6, startAngleRad + 0.75);
    const first = await generateWaterAwareLandletRing(env.DB, {
      prefix: 'det-ring-a', count: 10, innerRadiusM, startAngleRad,
    });
    const second = await generateWaterAwareLandletRing(env.DB, {
      prefix: 'det-ring-b', count: 10, innerRadiusM, startAngleRad,
    });
    expect(first.outerRadiusM).toBeCloseTo(second.outerRadiusM, 9);
    expect(first.waterArcCount).toBe(second.waterArcCount);
    expect(first.landlets.map((landlet) => landlet.landType)).toEqual(second.landlets.map((landlet) => landlet.landType));
  });

  it('defaults to uniform 1000m^2 plots when no plots are given, matching generateLandletRing\'s own default', async () => {
    const result = await generateWaterAwareLandletRing(env.DB, {
      prefix: 'default-ring', count: 5, innerRadiusM: 500, startAngleRad: 0,
    });
    expect(result.landlets.every((landlet) => landlet.landClass === 1)).toBe(true);
    for (const landlet of result.landlets) {
      expect(area(landlet)).toBeCloseTo(1000, 6);
    }
  });
});
