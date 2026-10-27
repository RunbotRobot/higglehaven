// #2811 (sub-issue of #2806, itself sub-issue of #2804, water-first/
// variable-size landlet generation): the DB-aware wrapper that makes
// #2810's weighted-Voronoi space-partitioning engine
// (worker/weightedVoronoiGenerator.js) water-aware. That module stays
// pure and network/DB-free -- this one reads real water data
// (geo_water_cells_fine, #2805) and feeds it in through the generic
// mechanism #2810 already exposes for exactly this (fixedSites/
// avoidRegions), rather than duplicating or modifying its iteration loop.
//
// Uses both of #2805's query primitives, but for different jobs:
// fractionOfRegionWater classifies each *finished* cell's own polygon
// (below); isWaterAtFinePoint's own per-point precision isn't needed
// here, because avoiding water at the *seed-placement* stage (this
// issue's own first scope bullet) comes from a coarser, cheaper check --
// fetchWaterBlobs clusters the real sample grid into blobs once per call,
// then random land-site placement just stays outside each blob's own
// approximate radius (avoidRegions, a circle test) rather than querying
// per candidate point.
//
// Scope decision (this issue's own text flags this as an implementation
// choice, not an owner-judgment one): a cell's stored polygon is never
// reshaped against the real water boundary -- only its landType changes
// (water vs. buildable), the same binary classification
// applyRealWaterClassification already uses for the coarse path. Real
// shoreline-following polygon edges would need actual water *polygon*
// geometry (a vector boundary), not just the sample-point grid
// geo_water_cells_fine stores -- building that extraction is real scope
// beyond this issue's own text, and isn't attempted here. What this issue
// asks for instead -- a contiguous water body genuinely "pulling" the
// tiling to carve around it, not just getting silently swallowed by one
// oversized cell -- comes from a different mechanism: each clustered
// water body becomes its own *site* in the same tessellation as the real
// land sites (generateWeightedVoronoiTiling's new fixedSites param), so
// land sites relax away from it through the exact same power-bisector
// math that already keeps any two land sites from overlapping. The
// now-classified-water cell's own polygon can still look like an ordinary
// (if oddly-shaped) tile -- that's the accepted limitation above, not a
// bug in the clustering.
import { fractionOfRegionWater } from './world-generation.js';
import { GEO_WATER_FINE_GRID_SPACING_M } from '../geoData.js';
import { pointInPolygon } from '../geometry.js';
import { powerLawPlots } from '../landGenerator.js';
import { discBoundary, generateWeightedVoronoiTiling, polygonArea } from '../weightedVoronoiGenerator.js';

export { discBoundary };

// A cell is reclassified from the usual 'buildable' default to 'water'
// once at least this fraction of its sampled area is water -- the same
// "predominantly water" phrase #2805/#2806's own issue text uses for this
// decision. A fixed-site (water-blob) cell is always 'water' regardless of
// this threshold (its whole reason for existing).
export const PREDOMINANTLY_WATER_THRESHOLD = 0.5;

// Union-find over `geo_water_cells_fine` rows within `boundary`'s own
// bounding box, connecting two rows whenever they're within
// clusterDistanceM of each other -- turning the sparse, unordered sample
// grid into a set of real contiguous water-body blobs (lakes, river
// stretches) rather than one site per isolated sample point. O(n^2) pairs
// -- fine at this dataset's real size (the fine grid is sparse, water-only
// rows; see geo_water_cells_fine's own migration comment), revisit with a
// spatial bucket only if that ever stops being true.
export async function fetchWaterBlobs(db, boundary, clusterDistanceM = GEO_WATER_FINE_GRID_SPACING_M * 1.5) {
  const xs = boundary.map((point) => point.x);
  const ys = boundary.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const rows = await db.prepare(`
    SELECT x_m, y_m, spacing_m FROM geo_water_cells_fine
    WHERE x_m >= ? AND x_m <= ? AND y_m >= ? AND y_m <= ?
  `).bind(minX, maxX, minY, maxY).all();
  const points = (rows.results || []).filter((row) => pointInPolygon({ x: row.x_m, y: row.y_m }, boundary));
  if (points.length === 0) return [];

  const parent = points.map((_, index) => index);
  function find(index) {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  }
  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootA] = rootB;
  }
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      if (Math.hypot(points[i].x_m - points[j].x_m, points[i].y_m - points[j].y_m) <= clusterDistanceM) {
        union(i, j);
      }
    }
  }

  const blobsByRoot = new Map();
  points.forEach((point, index) => {
    const root = find(index);
    if (!blobsByRoot.has(root)) blobsByRoot.set(root, []);
    blobsByRoot.get(root).push(point);
  });

  return Array.from(blobsByRoot.values()).map((members) => {
    const x = members.reduce((sum, point) => sum + point.x_m, 0) / members.length;
    const y = members.reduce((sum, point) => sum + point.y_m, 0) / members.length;
    // Each sampled point stands in for one spacing x spacing cell of real
    // water -- the same area convention scripts/ingest-geo-data.mjs's own
    // fine pass and this table's sparse "water cells only" format imply.
    const spacingM = members[0].spacing_m;
    const areaM2 = members.length * spacingM * spacingM;
    return { x, y, areaM2, radiusM: Math.sqrt(areaM2 / Math.PI) };
  });
}

// #2812 (sub-issue of #2806): the boundary a caller should generate
// `landletCount` cells into, sized so the Voronoi tessellation's own
// target areas exactly sum to the boundary's own area when no water is
// present (the algorithm has no "leftover" concept -- every unit of
// boundary area belongs to some site). Ignores any real water that might
// turn out to be inside this boundary by construction -- there's no way
// to know that without already having a boundary to query against, and
// #2807's own auto-widening precompute buffer is where correcting for a
// consistently-undersized yield belongs, not here.
export function defaultMosaicBoundaryRadiusM(landletCount, seed) {
  const totalAreaM2 = powerLawPlots(landletCount, seed).reduce((sum, plot) => sum + plot.areaM2, 0);
  return Math.sqrt(totalAreaM2 / Math.PI);
}

// Main entry point: a water-aware replacement for generateOrganicMosaic's
// own call shape, but variable-count/variable-size (#2806's own
// power-law size mix, via powerLawPlots) instead of a fixed 16x1000m2
// template, and with real water blobs (if any exist within `boundary`)
// competing for territory in the same tessellation as the ordinary land
// sites. `landletCount` draws from powerLawPlots the same way #2806's own
// scope describes; their total target area is scaled down by however much
// of `boundary` real water already accounts for, so the land sites are
// never asked to converge on more buildable area than is actually left.
// Each returned cell carries `landClass`/`plotMetadata` straight from its
// own powerLawPlots draw (null/`{waterBlob: true}` for a water cell) --
// #2812's own wiring (worker/lib/world-generation.js) needs these to shape
// a real landlet_candidates row, the same way generateOrganicMosaic's own
// candidates always carried a landClass.
export async function generateWaterAwareMosaic(db, {
  boundary, landletCount, seed, waterThreshold = PREDOMINANTLY_WATER_THRESHOLD,
}) {
  const boundaryAreaM2 = polygonArea(boundary);
  const waterBlobs = await fetchWaterBlobs(db, boundary);
  const totalWaterAreaM2 = waterBlobs.reduce((sum, blob) => sum + blob.areaM2, 0);
  // Never let real (or, near the edge of this script's own water-pass
  // coverage, over-estimated) water area claim the *entire* boundary --
  // land sites still need some real territory to converge on. 1% of the
  // boundary is a generous floor at this app's own land-generation scale
  // (hundreds to thousands of m2 minimum), not a meaningful cap in practice.
  const buildableBudgetM2 = Math.max(boundaryAreaM2 - totalWaterAreaM2, boundaryAreaM2 * 0.01);

  const rawPlots = powerLawPlots(landletCount, seed);
  const rawTotalM2 = rawPlots.reduce((sum, plot) => sum + plot.areaM2, 0);
  const landAreas = rawTotalM2 > 0
    ? rawPlots.map((plot) => (plot.areaM2 / rawTotalM2) * buildableBudgetM2)
    : [];

  const fixedSites = waterBlobs.map((blob) => ({ x: blob.x, y: blob.y, areaM2: blob.areaM2 }));
  const avoidRegions = waterBlobs.map((blob) => ({ x: blob.x, y: blob.y, radius: blob.radiusM }));

  const result = generateWeightedVoronoiTiling({
    boundary, areas: landAreas, seed, fixedSites, avoidRegions,
  });

  // result.cells lists the randomly-placed land sites first, then the
  // fixed water-blob sites, in the same order generateWeightedVoronoiTiling
  // itself builds them (`[...randomSites, ...pinnedSites]`) -- so index i
  // for i < landAreas.length is always rawPlots[i]'s own cell, letting
  // landClass/metadata (#2812's own wiring needs these to shape a real
  // candidate row) carry through from the power-law draw.
  const cells = await Promise.all(result.cells.map(async (cell, index) => {
    if (cell.fixed) {
      return { ...cell, landType: 'water', waterFraction: 1, landClass: null, plotMetadata: { waterBlob: true } };
    }
    const plot = rawPlots[index];
    const waterFraction = await fractionOfRegionWater(db, cell.polygon);
    return {
      ...cell,
      landType: waterFraction >= waterThreshold ? 'water' : 'buildable',
      waterFraction,
      landClass: plot.landClass,
      plotMetadata: plot.metadata,
    };
  }));

  return {
    cells,
    convergedWithinTolerance: result.convergedWithinTolerance,
    iterations: result.iterations,
    waterBlobCount: waterBlobs.length,
  };
}
