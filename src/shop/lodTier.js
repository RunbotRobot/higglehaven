// #3373: Shop's level of detail for a placed item is decided by how big the item
// looks on screen, not by a fixed distance. A fixed 75 m swapped a teacup and an
// item many metres tall at the same range, so a huge item turned into a plain box
// while it was still a prominent object on the shopper's screen (owner report,
// 2026-11-10). The tier an item needs is "would the box be told apart from the
// model": that depends on its size over its distance, and on the lens.
//
// Pure (no three.js, no DOM) so the rule is unit-tested directly
// (src/shop/lodTier.test.js); src/shop/presenceAndContent.js feeds it the real
// camera and item sizes.

// An item swaps to its simplified box when its diameter on screen falls below
// ENTER_PX CSS pixels, and back to the full model once it is above EXIT_PX. The
// gap is the hysteresis: an item hovering at the boundary does not flip every
// tick. A few dozen pixels is where a box and a model stop being distinguishable.
export const LOD_ENTER_PX = 24;
export const LOD_EXIT_PX = 36;

// The most items kept at full detail at once, however big they look: the budget
// that stands in for the old fixed distance as the cost bound on a phone. When
// more want full detail than this, the smallest on screen drop to the box first.
// Well above anything on screen in an ordinary build; it exists so one enormous
// build (hundreds of large items in view) cannot ask the GPU for all of them.
export const MAX_FULL_DETAIL_ITEMS = 600;

// The item's diameter on screen in CSS pixels: a sphere of `radiusM` at
// `distanceM`, seen through a vertical field of view of `fovDeg` on a viewport
// `viewportHeightPx` tall. Distance is floored so an item the camera is inside
// reads as very large, not infinite.
export function apparentSizePx(radiusM, distanceM, fovDeg, viewportHeightPx) {
  const distance = Math.max(distanceM, 0.1);
  const halfFovRad = (fovDeg * Math.PI) / 360;
  const pxPerMetre = viewportHeightPx / (2 * distance * Math.tan(halfFovRad));
  return 2 * radiusM * pxPerMetre;
}

// Should the item now be on the simplified box? `isMiddle` is its current tier
// (null/undefined for an item with no tier yet, which starts at the plain
// threshold with no hysteresis).
export function nextIsMiddle(isMiddle, apparentPx) {
  if (isMiddle === true) return apparentPx < LOD_EXIT_PX;
  if (isMiddle === false) return apparentPx < LOD_ENTER_PX;
  return apparentPx < LOD_ENTER_PX;
}

// Given the apparent sizes (px) of every item that wants full detail, the size
// below which items must drop to the box so no more than `cap` stay at full
// detail: the cap-th largest size (items strictly smaller drop). 0 when they all
// fit. Ties at the boundary keep full detail, so the count can exceed the cap by
// the size of the tie; that is cheaper than splitting equals arbitrarily.
export function fullDetailFloorPx(nearPxs, cap = MAX_FULL_DETAIL_ITEMS) {
  if (nearPxs.length <= cap) return 0;
  const sorted = Float64Array.from(nearPxs).sort();
  return sorted[sorted.length - cap];
}
