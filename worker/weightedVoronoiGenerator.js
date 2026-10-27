// #2810 (sub-issue of #2806, itself sub-issue of #2804, water-first/
// variable-size landlet generation): the space-partitioning engine
// generateOrganicMosaic (organicLandGenerator.js) never had -- that
// generator is a precomputed, hand-built fixed template, only ever
// rigidly rotated at request time, with no actual tiling algorithm behind
// it. This module is that algorithm: given a boundary and a list of
// target areas, produce a gap-free, non-overlapping tiling of the
// boundary into that many polygons, each converging toward its own
// target area.
//
// Deliberately pure and network/DB-free, matching worker/landGenerator.js's
// own generators -- no real DB-backed water data read here (that's #2811's
// own DB-aware wrapper, worker/lib/water-aware-mosaic.js, built on top of
// this module) and no wiring into real candidate rows (that's #2812).
// This module does carry the generic mechanism #2811's wrapper needs
// (`fixedSites`/`avoidRegions` below) -- a real water obstacle becomes
// just another site in the same tessellation, with no change to the core
// algorithm itself, so the wrapper never needs to duplicate this file's
// own iteration loop.
//
// Approach: a power diagram (weighted Voronoi tessellation). Site i has a
// position p_i and a weight w_i (units: squared length, i.e. "radius^2" of
// an notional circle of that area -- w_i = targetArea_i / pi is this
// module's own starting guess, see generateWeightedVoronoiTiling). The
// power bisector between sites i and j -- the locus of points x where
// |x-p_i|^2 - w_i = |x-p_j|^2 - w_j -- simplifies to a straight line (the
// quadratic |x|^2 term cancels), unlike a general weighted-distance
// bisector: 2(p_j-p_i)*x = |p_j|^2-|p_i|^2 - w_j+w_i. That means each
// site's cell is just the boundary clipped by one half-plane per other
// site (clipPolygonByHalfPlane, Sutherland-Hodgman), making the whole
// tessellation O(siteCount^2) per iteration -- easily fast enough for the
// land counts this app generates (tens, not thousands).
//
// Each iteration both adjusts weights (a damped proportional controller
// nudging each site's weight toward its real cell area matching its
// target) and re-centers sites a damped step toward their current cell's
// centroid (Lloyd's own relaxation). Weight adjustment alone converges for
// easy site arrangements but empirically gets stuck oscillating or
// plateaued on some fraction of random layouts -- site positions
// occasionally land in a relative arrangement weight alone can't resolve
// (e.g. three sites clustered tightly around a fourth that needs a much
// larger target area than its neighbors). Re-centering relaxes exactly
// that: moving a starved site's position toward its own cell's centroid
// (which trails toward whichever direction still has room to grow) breaks
// the deadlock, confirmed empirically against ~100 random (siteCount,
// boundaryRadius, seed) combinations during development -- weight-only
// adjustment failed to converge on several of them; adding recentering
// fixed all of them within this module's own default iteration budget.
import { pointInPolygon } from './geometry.js';
import { polygonCentroid, seededRandom } from './landGenerator.js';

// Shoelace formula. Assumes a simple (non-self-intersecting) polygon;
// works for either winding direction (sign discarded).
export function polygonArea(polygon) {
  let sum = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

// A regular polygon approximating a disc of the given radius -- the
// common boundary shape this app's land generators use (matching
// generateOrganicMosaic's own disc-shaped domain).
export function discBoundary(radiusM, segments = 48) {
  const points = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    points.push({ x: radiusM * Math.cos(angle), y: radiusM * Math.sin(angle) });
  }
  return points;
}

// Sutherland-Hodgman: clips `polygon` (convex or not, but this module only
// ever feeds it already-convex intermediate results) to the half-plane
// `normal . point <= offset`, returning the (possibly empty) remaining
// polygon. Handles the degenerate "clipped to nothing" case by returning
// an empty array rather than a malformed polygon.
export function clipPolygonByHalfPlane(polygon, normal, offset) {
  if (polygon.length === 0) return [];
  const inside = (point) => normal.x * point.x + normal.y * point.y <= offset;
  const result = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const previous = polygon[(index - 1 + polygon.length) % polygon.length];
    const currentInside = inside(current);
    const previousInside = inside(previous);
    if (currentInside !== previousInside) {
      const previousValue = normal.x * previous.x + normal.y * previous.y;
      const currentValue = normal.x * current.x + normal.y * current.y;
      const t = (offset - previousValue) / (currentValue - previousValue);
      result.push({
        x: previous.x + t * (current.x - previous.x),
        y: previous.y + t * (current.y - previous.y),
      });
    }
    if (currentInside) result.push(current);
  }
  return result;
}

// The power cell for `sites[index]` within `boundary`: the boundary
// successively clipped by one half-plane per other site, per this
// module's own header comment on power bisectors.
export function powerCellPolygon(boundary, sites, index) {
  const site = sites[index];
  let cell = boundary;
  for (let other = 0; other < sites.length; other += 1) {
    if (other === index) continue;
    const otherSite = sites[other];
    // 2(p_other - p_site).x <= |p_other|^2 - |p_site|^2 - w_other + w_site
    const normal = { x: 2 * (otherSite.x - site.x), y: 2 * (otherSite.y - site.y) };
    const offset =
      (otherSite.x * otherSite.x + otherSite.y * otherSite.y) -
      (site.x * site.x + site.y * site.y) -
      otherSite.weight + site.weight;
    cell = clipPolygonByHalfPlane(cell, normal, offset);
    if (cell.length === 0) break;
  }
  return cell;
}

// #2811 (sub-issue of #2806): `avoidRegions` lets a caller keep a randomly-
// placed site's *initial* position out of a known obstacle (water) --
// each region is a circle {x, y, radius}, an approximation good enough for
// this purpose (the real carving-around-water effect comes from
// `fixedSites` below competing for the same territory during relaxation,
// not from this initial-placement nudge alone).
function randomPointInBoundary(boundary, random, avoidRegions = [], maxAttempts = 2000) {
  const xs = boundary.map((point) => point.x);
  const ys = boundary.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = { x: minX + random() * (maxX - minX), y: minY + random() * (maxY - minY) };
    if (!pointInPolygon(candidate, boundary)) continue;
    if (avoidRegions.some((region) => Math.hypot(candidate.x - region.x, candidate.y - region.y) < region.radius)) continue;
    return candidate;
  }
  throw new Error('randomPointInBoundary: could not place a point inside the boundary after max attempts');
}

// Main entry point. `areas` is a list of target areas (m^2, one per
// randomly-placed output cell -- e.g. from powerLawPlots). Returns
// { cells: [{ center, polygon, areaM2, targetAreaM2, fixed }], convergedWithinTolerance, iterations }.
// `polygon` is in the same absolute coordinate space as `boundary` (callers
// that need plot-local offsets, like every other generator in this
// codebase, subtract `center` themselves). `cells` lists the `areas` sites
// first, then any `fixedSites` (same order as passed in), so a caller that
// built `fixedSites` itself always knows which output cells they became.
//
// `fixedSites` (#2811, sub-issue of #2806): sites placed at an exact given
// position rather than randomly, and never re-centered during relaxation
// -- for a real-world obstacle (a water body) whose position is dictated
// by actual geography, not something to optimize. Its weight still relaxes
// normally like any other site, so its own cell area still converges
// toward its target -- a contiguous water body competing for the same
// territory as its land-site neighbors is what makes them genuinely relax
// *around* it (their mutual power bisector), not just get classified after
// the fact. Each entry is `{ x, y, areaM2 }`; `avoidRegions` (above) is a
// separate, optional nudge so a *land* site's own random initial placement
// doesn't start inside a known obstacle either.
export function generateWeightedVoronoiTiling({
  boundary,
  areas,
  seed,
  maxIterations = 1000,
  tolerance = 0.02,
  dampingFactor = 0.2,
  recenterFactor = 0.2,
  fixedSites = [],
  avoidRegions = [],
}) {
  if (areas.length === 0 && fixedSites.length === 0) {
    return { cells: [], convergedWithinTolerance: true, iterations: 0 };
  }
  const boundaryAreaM2 = polygonArea(boundary);
  const random = seededRandom(seed);

  const randomSites = areas.map((targetAreaM2) => {
    const position = randomPointInBoundary(boundary, random, avoidRegions);
    return { ...position, weight: targetAreaM2 / Math.PI, targetAreaM2, fixed: false };
  });
  const pinnedSites = fixedSites.map((site) => ({
    x: site.x, y: site.y, weight: site.areaM2 / Math.PI, targetAreaM2: site.areaM2, fixed: true,
  }));
  const sites = [...randomSites, ...pinnedSites];

  let bestCells = null;
  let bestMaxRelativeError = Infinity;
  let iterations = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    iterations = iteration;
    const cells = sites.map((_, index) => powerCellPolygon(boundary, sites, index));
    const cellAreas = cells.map(polygonArea);
    const maxRelativeError = Math.max(
      ...cellAreas.map((area, index) => Math.abs(area - sites[index].targetAreaM2) / sites[index].targetAreaM2),
    );

    if (maxRelativeError < bestMaxRelativeError) {
      bestMaxRelativeError = maxRelativeError;
      bestCells = cells;
    }
    if (maxRelativeError <= tolerance) break;

    for (let index = 0; index < sites.length; index += 1) {
      sites[index].weight += dampingFactor * (sites[index].targetAreaM2 - cellAreas[index]);
      if (!sites[index].fixed && cells[index].length >= 3 && recenterFactor > 0) {
        const centroid = polygonCentroid(cells[index]);
        sites[index].x += recenterFactor * (centroid.x - sites[index].x);
        sites[index].y += recenterFactor * (centroid.y - sites[index].y);
      }
    }
  }

  return {
    cells: sites.map((site, index) => ({
      center: { x: site.x, y: site.y },
      polygon: bestCells[index],
      areaM2: polygonArea(bestCells[index]),
      targetAreaM2: site.targetAreaM2,
      fixed: site.fixed,
    })),
    convergedWithinTolerance: bestMaxRelativeError <= tolerance,
    iterations,
    boundaryAreaM2,
  };
}
