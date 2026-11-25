// #4198: the one definition of where an item may stand on a lándlet: inside the lándlet's own outline, not inside
// a square. Both the Worker (which refuses a save outside it) and Build (which will stop a move at it) read this
// file, so the client can never accept a move the server then refuses ("A gesture is constrained while it
// happens"). Until now both used a 31.62 m square (LANDLET_SIDE_M) centred on the lándlet, the same for every
// lándlet, though the lándlet the world draws is `landlets.polygon_json`, an irregular shape of the same area: on
// one real lándlet 119 m2 of the square lay outside the outline (items could stand off it) and 111 m2 of the
// lándlet lay outside the square (its owner could not build there).
//
// Everything here is in the lándlet's own coordinates, the same ones `polygon_json` and a placed item's x and y use
// (the lándlet's centre is the origin). Pure functions with no dependencies, so the browser and the Worker load the
// same file.

// A polygon as stored: [{ x, y }, ...] or its JSON text; anything unusable is null (the caller keeps whatever
// check it had before rather than guessing).
export function parseOutline(polygon) {
  let points = polygon;
  if (typeof polygon === 'string') {
    try { points = JSON.parse(polygon); } catch (_) { return null; }
  }
  if (!Array.isArray(points) || points.length < 3) return null;
  const outline = [];
  for (const point of points) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    outline.push({ x: point.x, y: point.y });
  }
  return outline;
}

// The outline grown or shrunk about the origin: `scale` is footprintScaleAtHeight(z), the cross-section of the
// buildable cone at the item's height (1 at ground, a hair under or over elsewhere).
export function scaleOutline(outline, scale) {
  if (scale === 1) return outline;
  return outline.map((point) => ({ x: point.x * scale, y: point.y * scale }));
}

// The four corners of an item's footprint: its width by depth rectangle, turned by its rotation about the vertical
// axis (radians, the same rotation_z_rad a placed item stores), centred on (x, y). Tilts are not applied: the
// footprint an item claims is its flat rectangle, as the old square check took it.
export function footprintCorners({ x, y, width, depth, rotationZ = 0 }) {
  const hw = width / 2;
  const hd = depth / 2;
  const cos = Math.cos(rotationZ);
  const sin = Math.sin(rotationZ);
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([cx, cy]) => ({
    x: x + cx * cos - cy * sin,
    y: y + cx * sin + cy * cos,
  }));
}

// How close to an edge still counts as on it. A move that stops at the outline (Build's clamp) lands exactly on it,
// and floating point must not turn that into "outside" by a hair.
export const OUTLINE_EDGE_TOLERANCE_M = 1e-6;

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

export function pointInOutline(point, outline) {
  for (let index = 0, previous = outline.length - 1; index < outline.length; previous = index++) {
    if (distanceToSegment(point, outline[index], outline[previous]) <= OUTLINE_EDGE_TOLERANCE_M) return true;
  }
  let inside = false;
  for (let index = 0, previous = outline.length - 1; index < outline.length; previous = index++) {
    const a = outline[index];
    const b = outline[previous];
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function orientation(a, b, c) {
  const value = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

// Do two segments cross each other (touching at an end does not count: an item may stand with a corner exactly on
// the line).
function segmentsCross(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

// Is the whole footprint inside the outline? Every corner must be inside, and no edge of the footprint may cross an
// edge of the outline (a corner-only test would let a rectangle straddle a dent in a concave outline).
export function footprintInsideOutline(outline, corners) {
  for (const corner of corners) {
    if (!pointInOutline(corner, outline)) return false;
  }
  for (let i = 0; i < corners.length; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    for (let j = 0; j < outline.length; j += 1) {
      const c = outline[j];
      const d = outline[(j + 1) % outline.length];
      if (segmentsCross(a, b, c, d)) return false;
    }
  }
  return true;
}

// The whole check an item goes through: its stored polygon, its footprint and its height's scale. `outline` null
// (a lándlet with no usable polygon) answers true here; the caller decides what to fall back to.
export function itemInsideLandletOutline(polygon, { x, y, width, depth, rotationZ = 0 }, scale = 1) {
  const outline = parseOutline(polygon);
  if (!outline) return true;
  return footprintInsideOutline(scaleOutline(outline, scale), footprintCorners({ x, y, width, depth, rotationZ }));
}
