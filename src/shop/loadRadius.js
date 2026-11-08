// #3261: Shop-mode content load/unload radii, as pure functions (no three.js,
// no DOM) so they are unit-testable (src/shop/loadRadius.test.js) and shared
// by src/shop/presenceAndContent.js's updateShopProximity.
//
// The bug this exists for: a landlet's placed content was only requested once
// the *camera* was within a fixed 60 m of its centre. In flight the chase
// camera sits behind and above the avatar, and from altitude the frustum
// covers far more than 60 m of ground, so content plainly on screen (a brick
// wall right under the avatar) was never drawn until the shopper flew down.
// Now: distance is measured from the avatar, and the load radius grows with
// altitude up to a hard cap.

// Ground-level radii: unchanged from before #3261 (load inside 60 m, unload
// past 90 m), and still what Build mode's neighbour outlines reuse via
// SHOP_LOAD_RADIUS_M in presenceAndContent.js.
export const SHOP_BASE_LOAD_RADIUS_M = 60;
export const SHOP_BASE_UNLOAD_RADIUS_M = 90;

// Each metre of altitude widens the load radius by this much. The chase camera
// looks down at the island from behind; ~2 m of visible ground per metre of
// height roughly matches what the frustum sees from a few tens of metres up.
export const SHOP_LOAD_RADIUS_PER_ALTITUDE_M = 2;

// Hard ceiling on the load radius, however high the shopper flies. Bounds how
// many landlets' instance lists get fetched and built: a landlet is ~30 m
// across, so this is on the order of a few dozen landlets, not the whole world.
export const SHOP_MAX_LOAD_RADIUS_M = 240;

// Hard ceiling on how many landlets may be loaded at once (nearest first).
// Ground-level play stays well under it (~11 landlets fit inside 60 m); it only
// binds at altitude, where it keeps the fetch/mesh/GPU cost bounded on the
// free tier and on phones regardless of how dense the world is.
export const SHOP_MAX_LOADED_LANDLETS = 40;

// Unload sits above load so an avatar hovering at the boundary doesn't
// thrash load/unload. The gap is the original 30 m, widened a little as the
// load radius grows so a quick altitude change can't swing the load radius
// across the whole band between two proximity checks.
const BASE_HYSTERESIS_M = SHOP_BASE_UNLOAD_RADIUS_M - SHOP_BASE_LOAD_RADIUS_M;
const HYSTERESIS_GROWTH_PER_M = 0.25;

function clampAltitude(altitudeM) {
  return Number.isFinite(altitudeM) && altitudeM > 0 ? altitudeM : 0;
}

export function shopLoadRadiusM(altitudeM) {
  const radius = SHOP_BASE_LOAD_RADIUS_M + SHOP_LOAD_RADIUS_PER_ALTITUDE_M * clampAltitude(altitudeM);
  return Math.min(SHOP_MAX_LOAD_RADIUS_M, radius);
}

export function shopUnloadRadiusM(altitudeM) {
  const load = shopLoadRadiusM(altitudeM);
  return load + BASE_HYSTERESIS_M + HYSTERESIS_GROWTH_PER_M * (load - SHOP_BASE_LOAD_RADIUS_M);
}

// Horizontal (x/y) distance; the scene is Z-up, so altitude never counts here.
export function horizontalDistanceM(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

// Which not-yet-loaded landlets to start loading this tick: those inside the
// load radius, nearest first, never letting the total loaded exceed
// SHOP_MAX_LOADED_LANDLETS. `candidates` is any array of objects with a
// numeric `distance`; the chosen objects are returned as-is.
export function pickLandletsToLoad(candidates, loadedCount, altitudeM) {
  const radius = shopLoadRadiusM(altitudeM);
  const room = Math.max(0, SHOP_MAX_LOADED_LANDLETS - loadedCount);
  return candidates
    .filter((candidate) => candidate.distance < radius)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, room);
}
