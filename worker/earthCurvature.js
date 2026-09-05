// Pure Earth-curvature coordinate math (docs/SPEC.md §1: "World built on an
// Earth-curvature coordinate system from day one — not a flat plane"). No
// rendering or gameplay change lives here — this is the shared primitive
// #135 (curved ground rendering), #136 (radial-cone buildable volume), and
// #137 (LOD-band curvature check) all build on top of. See issue #133
// (tracking) and #134 (this module's own issue).
//
// Earth model: a plain sphere — the same kind of "correct architecture, an
// imperceptible simplification at this scale" call docs/SPEC.md §3 already
// makes for above/below-ground cap asymmetry ("the difference is
// imperceptible at any near-term realistic scale, but the underlying world
// architecture must be built correctly from the start"). DEFAULT_EARTH_RADIUS_M
// is a placeholder pending #138's owner decision (sphere vs. real ellipsoid,
// exact radius constant) — every function below takes earthRadiusM as an
// explicit parameter for exactly that reason: swapping in #138's real
// answer later never touches this module's logic, and tests can use small,
// easy-to-verify radii instead of a real-world-scale one.
//
// Coordinate convention: inputs/outputs are WORLD-flat coordinates — the
// single flat (x, y) plane every landlet's own polygon already gets placed
// into via center_x_m/center_y_m (see geometry.js's worldPoints), not a
// landlet-local frame (whose own origin is itself an arbitrary point
// somewhere out on this same flat plane). A caller starting from
// landlet-local coordinates must add the landlet's own center offset first
// — this module only knows about distance from the single world origin
// (0, 0), which is what curvature is actually measured against. z is
// height above/below local ground, matching this app's existing
// x/y-ground-plane, z-vertical convention (docs/API.md's "Coordinates and
// dimensions").
//
// The model: the world origin (0, 0, 0) sits at a fixed point on the
// sphere's surface, ground-tangent to it, with Earth's center directly
// "below" at local (0, 0, -earthRadiusM). Moving flat-map distance d from
// the origin in some bearing corresponds to walking that same arc distance
// d across the sphere's own surface in that bearing — the standard
// azimuthal-equidistant projection, which is exactly what this world's own
// circular-growth model (a radius measured from one fixed center) already
// assumes on the flat side: distance from the origin reads the same in
// either picture, only where "up" points and how a straight line curves
// changes.

export const DEFAULT_EARTH_RADIUS_M = 6371000; // IUGG mean Earth radius — see #138.

// True 3D position (same units, ground-tangent-at-the-origin frame) for a
// point given in flat map coordinates. Rendering can consume this
// directly: feed it every ground-mesh vertex's flat (x, y) and the mesh
// itself curves; feed it a builder's placed-item position (x, y, z) and it
// sits correctly on the curved ground instead of floating at flat-map
// height.
export function curvedPosition({ x, y, z = 0 }, earthRadiusM = DEFAULT_EARTH_RADIUS_M) {
  const d = Math.hypot(x, y);
  const bearing = Math.atan2(y, x);
  const phi = d / earthRadiusM;
  const radiusFromCenter = earthRadiusM + z;
  return {
    x: radiusFromCenter * Math.sin(phi) * Math.cos(bearing),
    y: radiusFromCenter * Math.sin(phi) * Math.sin(bearing),
    z: radiusFromCenter * Math.cos(phi) - earthRadiusM,
  };
}

// Inverse of curvedPosition: recovers flat map coordinates (and height)
// from a true 3D position in the same frame — e.g. turning a raycast hit
// against curved ground geometry back into this app's existing flat
// landlet/world coordinate space.
export function flatPosition({ x, y, z }, earthRadiusM = DEFAULT_EARTH_RADIUS_M) {
  const fromCenterZ = z + earthRadiusM;
  const radiusFromCenter = Math.hypot(x, y, fromCenterZ);
  if (radiusFromCenter === 0) return { x: 0, y: 0, z: -earthRadiusM };
  const phi = Math.acos(clamp(fromCenterZ / radiusFromCenter, -1, 1));
  const bearing = Math.atan2(y, x);
  const d = phi * earthRadiusM;
  return {
    x: d * Math.cos(bearing),
    y: d * Math.sin(bearing),
    z: radiusFromCenter - earthRadiusM,
  };
}

// docs/SPEC.md §3's buildable-volume correction: "a fixed-angular-footprint
// lándlet extended radially through the Earth is a cone converging on
// Earth's center, not a cylinder... each level above ground consumes
// increasingly more land cap per level (cross-sectional area grows moving
// away from Earth's center); each level below ground consumes increasingly
// less (area shrinks toward the center)." A fixed *angular* footprint's
// linear cross-section scales linearly with distance from Earth's center —
// the same radiusFromCenter = earthRadiusM + z that curvedPosition already
// uses — so this is that ratio isolated as its own reusable factor: 1 at
// ground level (z = 0), > 1 above ground, < 1 below ground. Squaring it
// gives the area ratio the spec describes; callers that only need to widen/
// narrow a horizontal (x, y) span (e.g. #136's buildable-volume clamp) want
// the linear factor itself, not the area, so this returns the linear one
// and leaves squaring to whichever caller actually needs area.
export function footprintScaleAtHeight(z, earthRadiusM = DEFAULT_EARTH_RADIUS_M) {
  return (earthRadiusM + z) / earthRadiusM;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
