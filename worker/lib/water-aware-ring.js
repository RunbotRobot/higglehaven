// #2821 (sub-issue of #2804, water-first/variable-size landlet generation):
// makes the growth-time RING path (generateLandletRing, landGenerator.js)
// water-aware, mirroring #2811's own disc-mosaic water-awareness but using
// a structurally different approach.
//
// generateOrganicMosaic's successor (#2806's weightedVoronoiGenerator.js)
// tiles a *disc* via 2D power-diagram relaxation: every cell's polygon
// comes from clipping a convex boundary by half-plane bisectors, which
// only stays correct because a convex region clipped by any number of
// half-planes is still convex -- Sutherland-Hodgman's own single-pass
// clipping relies on that invariant, and doesn't handle a clip splitting a
// polygon into multiple disjoint pieces. An annulus (a ring has a hole) is
// fundamentally NOT convex -- the straight line between two points on its
// own inner edge passes outside the ring, through the hole -- so reusing
// the 2D Voronoi core directly for a ring risks exactly that failure mode
// (a half-plane clip corrupting a cell into something self-intersecting)
// the moment a bisector happens to cross the concave inner boundary.
// Worse, even a version that avoided that specific risk (e.g. treating the
// already-materialized interior as one giant fixed site, the same trick
// #2811 uses for water) still couldn't guarantee its resulting cell's edge
// lands EXACTLY on the true inner radius -- a power-diagram cell boundary
// is a polygon from half-plane intersections, never a literal circle. For
// water that approximation is fine (#2811's own scope note: water's
// *classification* matters, its exact shoreline doesn't) -- but here the
// "hole" is real, already-placed, already-owned land from an earlier
// growth cycle; any mismatch would mean new ring candidates either
// overlapping it or leaving a gap, not a cosmetic inaccuracy.
//
// generateLandletRing (landGenerator.js) sidesteps all of this because
// it's a completely different, much simpler algorithm: a pure 1D angular
// partition. Every plot shares the exact same [innerRadiusM, outerRadiusM]
// radial band by construction (no relaxation, no clipping) -- only each
// plot's ANGULAR WIDTH varies, derived straight from its target area via
// ringAreaScale. That's why it's already gap-free/non-overlapping with no
// hole-topology risk at all: there's no hole-aware boundary to get wrong.
// Making water-awareness work here means keeping that same 1D structure,
// not forcing a 2D tessellation onto it.
//
// Approach: detect real water along the ring's own circumference
// (detectWaterArcs, below) as a set of fixed angular arcs (position
// dictated by real geography, like #2811's water blobs); reduce the land
// plots' own angular budget by however much those arcs consume (via
// ringAreaScale's newly-generalized angleBudget parameter) so the SAME
// shared scale/radius still governs every plot, water included; then walk
// the circle once, placing land plots and water arcs in angular order.
// Since a land plot's own fixed width has no relationship to where a real
// water arc happens to sit, a plot that would straddle one gets split into
// two (or more) smaller fragments around it -- a fragment loses its exact
// target-area match (an accepted approximation, same spirit as #2811's own
// "cell polygon never reshaped to the real shoreline" scope note), but the
// ring stays gap-free and non-overlapping by construction either way,
// since every unit of angle around the full circle is always accounted
// for by exactly one placed shape.
//
// Not wired into generateLandletRingCandidates/generateRingAtWorldBoundary
// (worker/lib/world-generation.js) here -- same scope split #2810/#2811
// used before #2812's own wiring leaf -- this issue's own text left it
// genuinely open whether this needed its own breakdown; having built the
// algorithm, wiring is a small enough follow-up to track as its own leaf
// rather than growing this module further.
import { pointInPolygon } from '../geometry.js';
import { GEO_WATER_FINE_GRID_SPACING_M } from '../geoData.js';
import { polygonArea } from '../weightedVoronoiGenerator.js';
import { polygonCentroid, ringAreaScale } from '../landGenerator.js';

const TAU = Math.PI * 2;

// Mirrors the same "predominantly water" threshold #2811's own disc path
// uses (water-aware-mosaic.js) -- kept as its own constant here rather
// than importing that module's, since the two files are otherwise
// unrelated siblings (this one never touches the 2D Voronoi core at all,
// per this module's own header comment).
export const PREDOMINANTLY_WATER_THRESHOLD = 0.5;

function polar(radius, angle) {
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

// The same construction generateLandletRing's own inline polygon-building
// uses (landGenerator.js) -- an annular sector's boundary: the outer arc
// forward, then the inner arc backward, each discretized into `segments`
// straight pieces (never a literal arc), closing a simple shape that tiles
// gap-free with its angular neighbors exactly the way that function's own
// landlets already do.
function annularSectorPolygon(innerRadiusM, outerRadiusM, startAngle, endAngle, segments = 4) {
  const polygon = [];
  for (let step = 0; step <= segments; step += 1) {
    polygon.push(polar(outerRadiusM, startAngle + ((endAngle - startAngle) * step) / segments));
  }
  for (let step = segments; step >= 0; step -= 1) {
    polygon.push(polar(innerRadiusM, startAngle + ((endAngle - startAngle) * step) / segments));
  }
  return polygon;
}

async function fetchWaterKeySet(db, outerRadiusM) {
  const rows = await db.prepare(`
    SELECT x_m, y_m FROM geo_water_cells_fine
    WHERE x_m >= ? AND x_m <= ? AND y_m >= ? AND y_m <= ?
  `).bind(-outerRadiusM, outerRadiusM, -outerRadiusM, outerRadiusM).all();
  const spacing = GEO_WATER_FINE_GRID_SPACING_M;
  return new Set((rows.results || []).map((row) => `${Math.round(row.x_m / spacing)},${Math.round(row.y_m / spacing)}`));
}

// A local mirror of fractionOfRegionWater's own lattice-enumeration math
// (worker/lib/world-generation.js), checked against an already-fetched,
// in-memory key set rather than a fresh DB query every call -- scanning a
// whole ring's circumference means checking many (sliceCount) small
// sectors, and a separate round-trip per sector would multiply query
// volume for nothing when one bounding-box fetch already covers the
// entire ring (same shape fetchWaterBlobs, water-aware-mosaic.js, already
// uses for its own single-query-then-process-locally pattern).
function fractionOfRegionWaterLocal(polygon, waterKeys) {
  const spacing = GEO_WATER_FINE_GRID_SPACING_M;

  // Found via #2805's own real-seed-data follow-up: geo_water_cells_fine
  // only ever stores WATER points (sparse), so if none of waterKeys' own
  // real points fall inside this slice's polygon, the fraction is
  // unambiguously 0 regardless of how many lattice points the polygon
  // itself contains -- checking the (small, already-fetched-once-per-
  // ring) water set directly skips the full bounding-box lattice walk
  // below entirely in the common "no water in this slice" case. That
  // walk's cost scales with the polygon's own bounding-box AREA, which
  // for a thin angular ring slice far from the origin can be enormous
  // even though its angular span is tiny -- arc length (and so bbox
  // size) grows with radius, so a 5-degree slice at a multi-hundred-km
  // ring radius enumerates tens of millions of points for a result that
  // was always going to be 0. Reconstructing each key back to real
  // coordinates is exact: every stored x_m/y_m is already an exact
  // multiple of spacing (the fixed-origin lattice scripts/
  // ingest-geo-data.mjs samples on), so key = round(coord/spacing) round-
  // trips losslessly.
  let anyWaterInside = false;
  for (const key of waterKeys) {
    const [kx, ky] = key.split(',').map(Number);
    if (pointInPolygon({ x: kx * spacing, y: ky * spacing }, polygon)) {
      anyWaterInside = true;
      break;
    }
  }
  if (!anyWaterInside) return 0;

  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const minX = Math.floor(Math.min(...xs) / spacing) * spacing;
  const maxX = Math.ceil(Math.max(...xs) / spacing) * spacing;
  const minY = Math.floor(Math.min(...ys) / spacing) * spacing;
  const maxY = Math.ceil(Math.max(...ys) / spacing) * spacing;
  let insideCount = 0;
  let waterCount = 0;
  for (let x = minX; x <= maxX; x += spacing) {
    for (let y = minY; y <= maxY; y += spacing) {
      if (!pointInPolygon({ x, y }, polygon)) continue;
      insideCount += 1;
      if (waterKeys.has(`${Math.round(x / spacing)},${Math.round(y / spacing)}`)) waterCount += 1;
    }
  }
  return insideCount === 0 ? 0 : waterCount / insideCount;
}

// Scans the ring's full circumference in `sliceCount` equal angular slices
// (each spanning the full [innerRadiusM, outerRadiusM] band), classifying
// a slice 'water' once at least `waterThreshold` of its own sampled area is
// real water -- then merges adjacent water slices into contiguous arcs
// (correctly handling a water body that straddles the startAngleRad seam,
// via the rotate-to-a-known-non-water-anchor trick below) so a real water
// body crossing the ring produces one arc, not many single-slice slivers.
// Returned arcs are absolute angles and may extend past
// `startAngleRad + TAU` when an arc wraps across the seam -- callers
// already expect this (generateLandletRing's own nextAngle accumulates the
// same way, never wrapping mod TAU either); generateWaterAwareLandletRing
// below normalizes that back into its own walk's bounds itself.
//
// sliceCount's default (72, i.e. 5-degree slices) is a reasonable-looking
// starting point, not a value tuned against real data. geo_water_cells_
// fine now carries real seed data (#2805's own NHD-outage follow-up,
// migrations/0167), but tuning this default needs a real ring generation
// run against it to reveal whether 5-degree slices are too coarse
// (missing a narrow water feature) or too fine (wasted iteration) in
// practice -- not attempted here, left as a follow-up once that's
// observed.
export async function detectWaterArcs(db, {
  innerRadiusM, outerRadiusM, startAngleRad = 0, sliceCount = 72, waterThreshold = PREDOMINANTLY_WATER_THRESHOLD,
}) {
  const waterKeys = await fetchWaterKeySet(db, outerRadiusM);
  if (waterKeys.size === 0) return [];

  const sliceAngle = TAU / sliceCount;
  const isWater = [];
  for (let index = 0; index < sliceCount; index += 1) {
    const start = startAngleRad + index * sliceAngle;
    const polygon = annularSectorPolygon(innerRadiusM, outerRadiusM, start, start + sliceAngle);
    isWater.push(fractionOfRegionWaterLocal(polygon, waterKeys) >= waterThreshold);
  }
  if (!isWater.some(Boolean)) return [];
  if (isWater.every(Boolean)) return [{ startAngle: startAngleRad, endAngle: startAngleRad + TAU }];

  // Rotate the scan to start at a known non-water slice so a run is only
  // ever "wrapping" relative to the real angular seam (handled via
  // unbounded slot+length arithmetic below), never relative to this
  // array's own arbitrary indexing.
  const firstNonWater = isWater.indexOf(false);
  const arcs = [];
  let i = 0;
  while (i < sliceCount) {
    const slot = (firstNonWater + i) % sliceCount;
    if (!isWater[slot]) {
      i += 1;
      continue;
    }
    let length = 0;
    while (length < sliceCount && isWater[(firstNonWater + i + length) % sliceCount]) length += 1;
    arcs.push({
      startAngle: startAngleRad + slot * sliceAngle,
      endAngle: startAngleRad + (slot + length) * sliceAngle,
    });
    i += length;
  }
  return arcs;
}

// generateWaterAwareLandletRing's own placement walk only ever runs from
// startAngleRad to startAngleRad + TAU, so a water arc detectWaterArcs
// reported as wrapping past that point (its own contract: an arc may
// extend past startAngleRad + TAU to represent a water body straddling the
// seam) needs splitting into the piece before the seam and the piece right
// after it, each independently within the walk's own bounds -- otherwise
// the single wrapping arc, placed wherever its own startAngle falls (near
// the end of the walk), would push the walk's cursor past its intended end
// instead of correctly also covering the ring's very first few degrees.
function splitWrappingArcs(arcs, startAngleRad) {
  const end = startAngleRad + TAU;
  const result = [];
  for (const arc of arcs) {
    if (arc.endAngle > end + 1e-9) {
      result.push({ startAngle: arc.startAngle, endAngle: end });
      result.push({ startAngle: startAngleRad, endAngle: arc.endAngle - TAU });
    } else {
      result.push(arc);
    }
  }
  return result;
}

// Given the land plots' own areas, the shared scale (and hence
// outerRadiusM) once `waterAngleTotal` of the circle is already spoken for
// by real water, leaving `TAU - waterAngleTotal` for land -- floored the
// same generous-but-real way #2811's own water-aware-mosaic.js floors its
// land budget (`Math.max(..., boundaryAreaM2 * 0.01)`), so a pathological
// near-fully-submerged ring still resolves to *something* rather than a
// zero/negative budget, instead of throwing.
function landScaleAndRadius(innerRadiusM, areas, arcSegments, waterAngleTotal) {
  const angleBudget = Math.max(TAU - waterAngleTotal, TAU * 0.01);
  const scale = ringAreaScale(areas, arcSegments, angleBudget);
  return { scale, outerRadiusM: Math.sqrt(innerRadiusM ** 2 + 2 * scale) };
}

// Main entry point -- a water-aware drop-in replacement for
// generateLandletRing's own call shape (landGenerator.js), returning the
// same { landlets, outerRadiusM, boundarySignature } shape. `plots`
// defaults the same way generateLandletRing's own does (uniform
// 1000m^2/landClass 1 definitions) when omitted, matching
// generateRingAtWorldBoundary's own automatic-growth call shape today.
//
// Unlike generateWaterAwareMosaic's one-pass water detection (water-aware-
// mosaic.js -- its boundary's own outer radius is already fixed before any
// water lookup happens), this ring's own outerRadiusM is *derived from* how
// much angular room water leaves for land, which in turn depends on
// outerRadiusM (the band water gets detected against) -- a genuine fixed
// point, not a one-shot calculation. Resolved the same way #2810's own 2D
// relaxation resolves its own analogous fixed point: iterate (detect water
// in the current band -> shrink land's angular budget -> grow outerRadiusM
// to compensate -> re-detect against the now-wider band) until outerRadiusM
// stops moving, bounded by maxIterations so a pathological input can never
// loop forever. The gap-free/non-overlapping guarantee below holds
// regardless of how well this particular fixed point converges -- it only
// affects how precisely the detected water arcs match the *final*
// outerRadiusM's own band, not whether placement itself tiles correctly.
export async function generateWaterAwareLandletRing(db, {
  prefix, count, innerRadiusM, startAngleRad = 0, areaM2 = 1000, plots,
  waterThreshold = PREDOMINANTLY_WATER_THRESHOLD, sliceCount = 72,
  maxIterations = 6, radiusToleranceM = 0.01,
}) {
  const arcSegments = 4;
  const definitions = plots || Array.from({ length: count }, () => ({ areaM2, landClass: 1, landType: 'buildable' }));
  const areas = definitions.map((plot) => plot.areaM2);

  let { outerRadiusM } = landScaleAndRadius(innerRadiusM, areas, arcSegments, 0);
  let waterArcs = [];
  let scale;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    waterArcs = await detectWaterArcs(db, { innerRadiusM, outerRadiusM, startAngleRad, sliceCount, waterThreshold });
    const waterAngleTotal = waterArcs.reduce((sum, arc) => sum + (arc.endAngle - arc.startAngle), 0);
    const next = landScaleAndRadius(innerRadiusM, areas, arcSegments, waterAngleTotal);
    scale = next.scale;
    const converged = Math.abs(next.outerRadiusM - outerRadiusM) <= radiusToleranceM;
    outerRadiusM = next.outerRadiusM;
    if (converged) break;
  }
  waterArcs = splitWrappingArcs(waterArcs, startAngleRad).sort((a, b) => a.startAngle - b.startAngle);

  const angles = areas.map((area) => arcSegments * Math.asin(Math.min(1, area / (scale * arcSegments))));

  // One entry per final placed shape -- a land plot that never meets a
  // water arc becomes exactly one; a water arc becomes exactly one; a land
  // plot interrupted by one or more water arcs becomes one entry per
  // fragment (see this module's own header comment on why that's an
  // accepted approximation, not a bug).
  const shapes = [];
  let cursor = startAngleRad;
  let waterIndex = 0;
  for (let plotIndex = 0; plotIndex < definitions.length; plotIndex += 1) {
    let remaining = angles[plotIndex];
    let fragmentIndex = 0;
    while (remaining > 1e-12) {
      const nextWater = waterArcs[waterIndex];
      const gapToWater = nextWater ? nextWater.startAngle - cursor : Infinity;
      if (nextWater && gapToWater <= 1e-9) {
        shapes.push({
          startAngle: nextWater.startAngle, endAngle: nextWater.endAngle,
          landClass: null, landType: 'water',
          metadata: { generated: true, generator: 'water-aware-ring-v1', waterArc: true },
        });
        cursor = nextWater.endAngle;
        waterIndex += 1;
        continue;
      }
      const take = Math.min(remaining, gapToWater);
      // A plot that never met a water arc keeps reporting its own exact
      // target area (targetAreaM2 below), the same convention
      // generateLandletRing's own plots always use -- needed so the
      // adjacentToRingId reuse feature (worker/lib/world-generation.js),
      // which reads a stored candidate's own area_m2 straight back into
      // the uniform area-to-angle formula to reproduce the same width, gets
      // *exactly* the same width back, not one perturbed by this shape's
      // own real discretized-polygon area. A fragment split off by a water
      // arc has no single clean target any more, so it falls back to the
      // real computed polygon area instead (set in the landlets map below).
      const isFragment = fragmentIndex > 0 || take < angles[plotIndex] - 1e-9;
      shapes.push({
        startAngle: cursor, endAngle: cursor + take,
        landClass: definitions[plotIndex].landClass, landType: definitions[plotIndex].landType || 'buildable',
        targetAreaM2: isFragment ? null : definitions[plotIndex].areaM2,
        metadata: {
          generated: true, generator: 'water-aware-ring-v1', ringIndex: plotIndex,
          ...(isFragment ? { waterSplitFragment: true, fragmentIndex } : {}),
          ...definitions[plotIndex].metadata,
        },
      });
      cursor += take;
      remaining -= take;
      fragmentIndex += 1;
    }
  }
  // Any water arc(s) sitting entirely past the last land plot's own span
  // (e.g. the ring's very last few degrees are water) still need placing.
  while (waterIndex < waterArcs.length) {
    const nextWater = waterArcs[waterIndex];
    shapes.push({
      startAngle: nextWater.startAngle, endAngle: nextWater.endAngle,
      landClass: null, landType: 'water',
      metadata: { generated: true, generator: 'water-aware-ring-v1', waterArc: true },
    });
    waterIndex += 1;
  }

  const landlets = shapes.map((shape, index) => {
    const polygon = annularSectorPolygon(innerRadiusM, outerRadiusM, shape.startAngle, shape.endAngle);
    const center = polygonCentroid(polygon);
    return {
      landletId: `${prefix}-${String(index + 1).padStart(3, '0')}`,
      name: `${prefix} ${index + 1}`,
      areaM2: shape.targetAreaM2 ?? polygonArea(polygon),
      center,
      landClass: shape.landClass,
      landType: shape.landType,
      polygon: polygon.map((point) => ({ x: point.x - center.x, y: point.y - center.y })),
      // #3011: widthRad is this shape's own exact angular width -- land
      // fragment or water arc alike. An adjacentToRingId reuse call
      // (worker/lib/world-generation.js) reads it straight back and feeds
      // it to generateLandletRing (worker/landGenerator.js) verbatim,
      // instead of that function re-deriving an angle from areaM2 via the
      // asin formula -- re-deriving can't reproduce this ring's own real
      // angular budget (reduced by whatever water actually occupied), and
      // a water-arc shape's own areaM2 (a back-computed real polygon area,
      // set above) was never asin-invertible to begin with.
      metadata: { ...shape.metadata, widthRad: shape.endAngle - shape.startAngle },
    };
  });

  // Exactly generateLandletRing's own boundarySignature shape
  // (landGenerator.js) -- normalized start angle + each shape's own
  // angular width, nothing else. The adjacent-ring DB trigger
  // (migrations/0019) that reads this only ever cares about geometric
  // gap-freeness at the shared seam (do the two rings' angular widths
  // line up), never content -- a buildable plot on one side of a seam
  // bordering a water plot on the other is a perfectly valid seam, not a
  // mismatch. Including landType here would make a *correctly* adjacent
  // ring built via the old generateLandletRing (the adjacentToRingId
  // reuse path, which never carries landType into its own signature)
  // spuriously fail this check the moment any plot along the seam is
  // water -- confirmed by worker-api.test.js's own adjacent-ring
  // coverage, which exercises exactly that case.
  const boundarySignature = JSON.stringify([
    Number((((startAngleRad % TAU) + TAU) % TAU).toPrecision(15)),
    ...shapes.map((shape) => Number((shape.endAngle - shape.startAngle).toPrecision(15))),
  ]);

  return { landlets, outerRadiusM, boundarySignature, waterArcCount: waterArcs.length };
}
