// Real-world terrain/hydrology data ingestion primitives (#219, sub-issue of
// #206 macro-geography). Pure, network-free logic only — the actual live
// data fetch (USGS elevation, NHD waterbody geometry) lives in
// scripts/ingest-geo-data.mjs, which imports this module. Splitting it this
// way keeps the real-world-to-world-coordinate math and the pre-human-water
// classification rule unit-testable without a network, the same boundary
// earthCurvature.js already draws between pure math and its callers.
//
// Coordinate mapping: WORLD_ORIGIN_LATITUDE/LONGITUDE (worker/earthCurvature.js,
// #138's owner decision) is this world's flat-map origin (0, 0). A real-world
// point's distance from that origin becomes its distance from world (0, 0);
// its true compass bearing from the origin becomes its world bearing, after
// applying docs/SPEC.md §2's "210-degree rotational offset applied once
// during real-world-to-higglehaven coordinate mapping" — this module is that
// one application site. This is exactly earthCurvature.js's own azimuthal-
// equidistant model (distance from origin preserved, only direction
// reprojected), now grounded to real compass bearings instead of an
// arbitrary in-world one. Distance/bearing themselves use the same sphere
// model (DEFAULT_EARTH_RADIUS_M) #138 already settled on, not a real
// ellipsoid, for consistency with every other real-world-facing calculation
// this app makes.
import { DEFAULT_EARTH_RADIUS_M, WORLD_ORIGIN_LATITUDE, WORLD_ORIGIN_LONGITUDE } from './earthCurvature.js';

export const ROTATIONAL_OFFSET_DEG = 210;

// Lake Washington's pre-1916 level was ~29 ft above sea level; the Lake
// Washington Ship Canal (completed 1916, cutting through at Montlake) lowered
// it ~9 ft to match Lake Union's ~20 ft level — docs/SPEC.md §1's own named
// example of the "recreate pre-human natural geology, exclude man-made
// terraforming" rule. Sourced from HistoryLink.org's Lake Washington Ship
// Canal and Montlake Cut essays (historylink.org/File/1444,
// historylink.org/File/686, historylink.org/File/10221) and corroborated by
// Seattle's own city-archives account of the 1916 lowering
// (seattle.gov/city-archives — "Life on the Cut"). The lake's level
// fluctuated seasonally by several feet even before 1916, so this is a
// representative figure, not a precise year-round constant — appropriate
// for this app's own "lower fidelity bar" (docs/SPEC.md §8) than a real
// hydrology product would need.
export const PRE_1916_LAKE_WASHINGTON_LEVEL_M = 8.8392; // 29 ft

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

// Great-circle distance between two lat/lon points (haversine), on a sphere
// of the given radius — matches earthCurvature.js's own sphere model.
export function haversineDistanceM(lat1, lon1, lat2, lon2, earthRadiusM = DEFAULT_EARTH_RADIUS_M) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Initial compass bearing (degrees, 0 = true north, clockwise) from point 1
// to point 2, along the great circle.
export function initialBearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Inverse of the pair above: the lat/lon reached by travelling distanceM
// along the given compass bearing from (lat, lon), on a sphere of
// earthRadiusM.
export function destinationPoint(lat, lon, bearingDeg, distanceM, earthRadiusM = DEFAULT_EARTH_RADIUS_M) {
  const delta = distanceM / earthRadiusM;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lon);
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
    );
  return { lat: toDeg(phi2), lon: ((toDeg(lambda2) + 540) % 360) - 180 };
}

// Real-world (lat, lon) -> this world's flat (x, y) meters, per this
// module's own top-of-file comment.
export function latLonToWorld(
  lat,
  lon,
  { originLat = WORLD_ORIGIN_LATITUDE, originLon = WORLD_ORIGIN_LONGITUDE, earthRadiusM = DEFAULT_EARTH_RADIUS_M } = {}
) {
  const d = haversineDistanceM(originLat, originLon, lat, lon, earthRadiusM);
  if (d === 0) return { x: 0, y: 0 };
  const compassBearing = initialBearingDeg(originLat, originLon, lat, lon);
  const worldAngleRad = toRad(90 - compassBearing + ROTATIONAL_OFFSET_DEG);
  return { x: d * Math.cos(worldAngleRad), y: d * Math.sin(worldAngleRad) };
}

// Inverse of latLonToWorld.
export function worldToLatLon(
  x,
  y,
  { originLat = WORLD_ORIGIN_LATITUDE, originLon = WORLD_ORIGIN_LONGITUDE, earthRadiusM = DEFAULT_EARTH_RADIUS_M } = {}
) {
  const d = Math.hypot(x, y);
  if (d === 0) return { lat: originLat, lon: originLon };
  const worldAngleDeg = toDeg(Math.atan2(y, x));
  const compassBearing = (((90 - worldAngleDeg + ROTATIONAL_OFFSET_DEG) % 360) + 360) % 360;
  return destinationPoint(originLat, originLon, compassBearing, d, earthRadiusM);
}

// Standard ray-casting point-in-polygon test. point is {x, y}; polygon is an
// array of {x, y} vertices (need not be explicitly closed). Works in
// whatever coordinate system both share — this module always calls it in
// world meters, converting a real-world polygon (e.g. NHD's lon/lat
// waterbody rings) via latLonToWorld first, so a single consistent unit
// backs both the polygon test and the reclamation-distance check below.
export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const vi = polygon[i];
    const vj = polygon[j];
    const intersects =
      vi.y > point.y !== vj.y > point.y &&
      point.x < ((vj.x - vi.x) * (point.y - vi.y)) / (vj.y - vi.y) + vi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

// docs/SPEC.md §1's "recreate natural pre-human Earth geology... exclude
// man-made terraforming" rule, applied to Lake Washington's 1916 lowering:
// a point counts as water under the pre-human model if it's within today's
// actual lake polygon (unconditionally — the lake only ever shrank, never
// grew, so today's water was certainly water before too), OR it sits within
// reclamationRadiusM of today's shoreline and its real ground elevation is
// at or below PRE_1916_LAKE_WASHINGTON_LEVEL_M (the strip of now-dry land
// the 1916 drop exposed). reclamationRadiusM bounds the correction to the
// lake's own margin — an unrelated low-lying point far from the lake isn't
// reclassified just because its elevation happens to be low too; the right
// radius is regional (a broad, gently-sloping wetland like Union Bay
// reclaims much further than a steep bank does), so this takes it as a
// caller-supplied parameter rather than one hardcoded value pretending to
// fit every shoreline segment.
export function classifyPreHumanWaterType({
  elevationM,
  inCurrentWaterbody,
  distanceToShorelineM,
  reclamationRadiusM,
}) {
  if (inCurrentWaterbody) return 'water';
  if (distanceToShorelineM <= reclamationRadiusM && elevationM <= PRE_1916_LAKE_WASHINGTON_LEVEL_M) {
    return 'water';
  }
  return 'buildable';
}

// Minimum distance from a point to any edge of a polygon (world meters) —
// classifyPreHumanWaterType's distanceToShorelineM input when the point
// isn't already inside the polygon.
export function distanceToPolygonM(point, polygon) {
  let min = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    min = Math.min(min, distanceToSegmentM(point, polygon[j], polygon[i]));
  }
  return min;
}

function distanceToSegmentM(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}
