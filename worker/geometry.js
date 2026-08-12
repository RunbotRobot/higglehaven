export function landletMaxWorldRadius(row) {
  const polygon = parsePolygon(row.polygon_json);
  if (polygon.length === 0) {
    return Math.hypot(row.center_x_m, row.center_y_m) + sameAreaRadius(row.area_m2);
  }
  return Math.max(...worldPoints(row, polygon).map((point) => Math.hypot(point.x, point.y)));
}

export function landletMinWorldRadius(row) {
  const polygon = parsePolygon(row.polygon_json);
  const centerRadius = Math.hypot(row.center_x_m, row.center_y_m);
  if (polygon.length === 0) return Math.max(0, centerRadius - sameAreaRadius(row.area_m2));

  const points = worldPoints(row, polygon);
  if (pointInPolygon({ x: 0, y: 0 }, points)) return 0;
  return Math.min(...points.map((point, index) => pointToSegmentDistance(
    { x: 0, y: 0 },
    point,
    points[(index + 1) % points.length],
  )));
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointToSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

// Absolute-coordinate points for a landlet row's polygon (plot-local offsets
// + the row's own center), or [] when the row has no real polygon yet (the
// plain-square fallback landlets predating procedural generation).
export function landletWorldPolygon(row) {
  return worldPoints(row, parsePolygon(row.polygon_json));
}

// True if two simple polygons (each an array of {x, y}, in order — not
// necessarily convex, per the curved-seam organic generator) share any
// area: either polygon has a vertex inside the other (catches full/partial
// containment), or an edge of one crosses an edge of the other (catches
// overlaps with no vertex inside either polygon, e.g. a shape passing
// through a corner). Two polygons that only touch along a shared edge or
// vertex (the "no gaps, no overlaps" tiling this checks for elsewhere) are
// not considered overlapping — segmentsIntersect treats a shared endpoint
// as a touch, not a crossing.
export function polygonsOverlap(polygonA, polygonB) {
  if (polygonA.length < 3 || polygonB.length < 3) return false;
  if (polygonA.some((point) => strictlyInsidePolygon(point, polygonB))) return true;
  if (polygonB.some((point) => strictlyInsidePolygon(point, polygonA))) return true;
  for (let i = 0; i < polygonA.length; i++) {
    const a1 = polygonA[i];
    const a2 = polygonA[(i + 1) % polygonA.length];
    for (let j = 0; j < polygonB.length; j++) {
      const b1 = polygonB[j];
      const b2 = polygonB[(j + 1) % polygonB.length];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

// pointInPolygon's ray-casting test is unreliable exactly on a boundary
// (which vertex/edge "wins" for a point lying precisely on it depends on
// which direction the ray happens to cross) — a real concern here since
// adjacent tiles from the same generator are designed to share exact
// vertices/edges. Requiring the point to also sit more than a hair's width
// from every edge of the polygon turns "on the boundary" into a reliable
// false rather than a coin flip, without affecting genuine interior points.
const TOUCH_EPSILON_M = 1e-6;

function strictlyInsidePolygon(point, polygon) {
  if (!pointInPolygon(point, polygon)) return false;
  for (let index = 0; index < polygon.length; index++) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    if (pointToSegmentDistance(point, start, end) < TOUCH_EPSILON_M) return false;
  }
  return true;
}

function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

function cross(origin, a, b) {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

function parsePolygon(value) {
  return JSON.parse(value || '[]');
}

function worldPoints(row, polygon) {
  return polygon.map((point) => ({ x: row.center_x_m + point.x, y: row.center_y_m + point.y }));
}

function sameAreaRadius(areaM2) {
  return Math.sqrt(areaM2 / Math.PI);
}
