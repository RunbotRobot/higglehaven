// docs/SPEC.md §1: "World built on an Earth-curvature coordinate system
// from day one." This module is the shared primitive every other
// Earth-curvature sub-issue (see issue #133) builds on: converting between
// the flat, landlet-local (x, y, z) meters this app already uses
// everywhere (docs/API.md's "Coordinates and dimensions" — x/y ground-
// plane, z vertical) and each position's true 3D location relative to
// Earth's center. Nothing here renders or generates anything — pure
// geometry, mirroring worker/geometry.js's own "pure functions + a
// dedicated .test.js" pattern.
//
// The flat (x, y) plane is centered on a single fixed reference point on
// Earth's surface (this frame's own origin, an arbitrary placeholder until
// #138 settles what it actually maps to) and is an azimuthal-equidistant
// projection around it: straight-line distance from the origin in the flat
// plane (hypot(x, y)) equals true great-circle surface distance from that
// point, and bearing (atan2(y, x)) equals true compass bearing from it.
// That's the same shape flat local (x, y) already assumes today (see
// worker/geometry.js's own world-radius helpers, which treat hypot(x, y)
// as real-world distance) — this module's whole job is to stop treating
// that flat plane as literally flat past a certain distance and instead
// wrap it around Earth's actual curvature. z stays "meters above the local
// surface", extended radially outward from Earth's center rather than
// straight up in a fixed direction once curvature applies.
//
// EARTH_RADIUS_M is a plain-sphere placeholder (Earth's mean radius,
// 6,371,000 m) rather than the real WGS84 ellipsoid or any project-
// specific model — #138 is explicitly an owner-judgment call on which
// model this project actually wants (a real Earth? a stylized smaller one
// for gameplay pacing? an ellipsoid at all, given the added complexity for
// likely-imperceptible benefit at any plausible in-game travel distance?).
// Every function below takes earthRadiusM as a parameter (defaulting to
// this placeholder) specifically so swapping in the real decision later is
// a one-constant change at every call site, not a rewrite of the math.
export const EARTH_RADIUS_M = 6_371_000;

// Converts local (x, y, z) meters into a true Cartesian position in
// meters, relative to Earth's center, where this frame's own origin sits
// at (0, 0, earthRadiusM) — i.e. the +Z axis of this frame runs from
// Earth's center through the local-coordinate origin. That's an arbitrary
// but convenient choice of axis, not a real-world latitude/longitude;
// #138 decides whether/how this frame maps onto real geographic
// coordinates at all.
//
// Math: flat-plane distance r = hypot(x, y) is the great-circle arc length
// from the origin (by the azimuthal-equidistant assumption above), so the
// angle subtended at Earth's center between the origin and this point is
// simply r / earthRadiusM radians. Standard spherical-to-Cartesian
// conversion from there (polar angle = that subtended angle, azimuth =
// bearing), with the point then pushed outward along the same radial
// direction by z to account for height above the surface.
export function localToEarthCentered(x, y, z, earthRadiusM = EARTH_RADIUS_M) {
  const flatDistanceM = Math.hypot(x, y);
  const bearing = Math.atan2(y, x);
  const angle = flatDistanceM / earthRadiusM;
  const radiusFromCenter = earthRadiusM + z;
  const horizontal = radiusFromCenter * Math.sin(angle);
  return {
    x: horizontal * Math.cos(bearing),
    y: horizontal * Math.sin(bearing),
    z: radiusFromCenter * Math.cos(angle),
  };
}

// The exact inverse of localToEarthCentered: given a true Earth-centered
// Cartesian position, recovers the flat local (x, y, z) an unmodified
// flat-plane caller would still expect. Round-tripping through both
// functions is the identity (up to floating-point error) for any point
// not past Earth's exact antipode from the origin (a subtended angle of
// precisely π, where bearing becomes undefined) — never reachable at any
// plausible in-game world radius.
export function earthCenteredToLocal(earthPosition, earthRadiusM = EARTH_RADIUS_M) {
  const radiusFromCenter = Math.hypot(earthPosition.x, earthPosition.y, earthPosition.z);
  const angle = Math.acos(clamp(earthPosition.z / radiusFromCenter, -1, 1));
  const bearing = Math.atan2(earthPosition.y, earthPosition.x);
  const flatDistanceM = angle * earthRadiusM;
  return {
    x: flatDistanceM * Math.cos(bearing),
    y: flatDistanceM * Math.sin(bearing),
    z: radiusFromCenter - earthRadiusM,
  };
}

// The local "up" direction (unit vector, in the same Earth-centered frame
// localToEarthCentered outputs into) at a given flat (x, y) — the
// direction z actually extends along at that position once curvature
// applies, and the surface normal a curved ground mesh or the cone-shaped
// buildable volume (#135/#136) will need to orient itself, without either
// of those duplicating this trig themselves. At the frame's own origin
// (x = y = 0) this is exactly (0, 0, 1); it tilts further away from that
// the farther out (x, y) is, exactly matching a real sphere's surface
// normal.
export function localUpDirection(x, y, earthRadiusM = EARTH_RADIUS_M) {
  const flatDistanceM = Math.hypot(x, y);
  if (flatDistanceM === 0) return { x: 0, y: 0, z: 1 };
  const bearing = Math.atan2(y, x);
  const angle = flatDistanceM / earthRadiusM;
  return {
    x: Math.sin(angle) * Math.cos(bearing),
    y: Math.sin(angle) * Math.sin(bearing),
    z: Math.cos(angle),
  };
}

// How far a flat, uncurved reading of height (i.e. treating the ground as
// exactly flat — the placeholder every other part of this codebase still
// uses) would be wrong by, at a given flat-plane distance from the frame's
// origin: the classic "how far below the tangent plane does the real
// surface sag" curvature-drop figure. Lets #137 (LOD/backdrop bands)
// decide how far out the flat approximation stays visually
// indistinguishable from the real curve without running the full 3D
// transform just to answer that.
export function curvatureDropM(flatDistanceM, earthRadiusM = EARTH_RADIUS_M) {
  const angle = flatDistanceM / earthRadiusM;
  return earthRadiusM * (1 - Math.cos(angle));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
