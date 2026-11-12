// #3373: Shop's level of detail for a placed item is decided by how big the item
// looks on screen, not by a fixed distance. A fixed 75 m swapped a teacup and an
// item many metres tall at the same range, so a huge item turned into a plain box
// while it was still a prominent object on the shopper's screen (owner report,
// 2026-11-10). #3412 (Model tiers) then removed the box: an item is always its
// own model, in one of three versions of it. 'full' is the model as uploaded,
// 'mid' is about a tenth of its triangles, and 'far' is a few dozen to about two
// hundred (src/modelTiers.js). The tier an item needs is "would the cheaper
// version be told apart from the better one": that depends on its size over its
// distance, and on the lens.
//
// Pure (no three.js, no DOM) so the rule is unit-tested directly
// (src/shop/lodTier.test.js); src/shop/presenceAndContent.js feeds it the real
// camera and item sizes.

export const TIER_FULL = 'full';
export const TIER_MID = 'mid';
export const TIER_FAR = 'far';

// An item steps down to the next cheaper version when its diameter on screen
// falls below an ENTER size in CSS pixels, and back up once it is above the
// matching EXIT size. The gap between the two is the hysteresis: an item
// hovering at a boundary does not flip every tick.
//   full <-> mid: below MID_ENTER_PX a tenth of the triangles reads the same.
//   mid  <-> far: below FAR_ENTER_PX only the silhouette and colour read, which
//                 is what the far version keeps (the sizes the old stand-in box
//                 used, a few dozen pixels).
export const LOD_MID_ENTER_PX = 80;
export const LOD_MID_EXIT_PX = 110;
export const LOD_FAR_ENTER_PX = 24;
export const LOD_FAR_EXIT_PX = 36;

// The most items kept at each detail level at once, however big they look: the
// budget that stands in for the old fixed distance as the cost bound on a phone.
// When more want full detail than MAX_FULL_DETAIL_ITEMS, the smallest on screen
// drop to mid; when more want mid (including those just dropped) than
// MAX_MID_DETAIL_ITEMS, the smallest of those drop to far. Nothing drops to a
// box. Well above anything on screen in an ordinary build; they exist so one
// enormous build (hundreds of large items in view) cannot ask the GPU for all
// of them.
export const MAX_FULL_DETAIL_ITEMS = 600;
export const MAX_MID_DETAIL_ITEMS = 1500;

// #3443: what is right beside the person is always the real model. An item
// within this many metres (along the ground) of the avatar never takes a cheaper version,
// neither from the per-item size rule (a single brick is small, so it sits near
// the enter/exit sizes even at close range) nor from the cap. The owner stood
// next to an 829-brick wall and watched bricks flip between textured and plain
// as he moved a metre; the cap's ranking by apparent size reshuffled which 229
// bricks were simplified at every step. Protected items do not count against the cap
// either, so the rest of the world's budget is what is left over.
export const NEAR_FULL_DETAIL_M = 10;
// #3443: the protection has its own hysteresis, like every other boundary here.
// An item enters it at NEAR_FULL_DETAIL_M and leaves only past this distance, so
// standing, or walking back and forth, at the 10 m line does not toggle the
// bricks that straddle it (a simulation of the 829-brick wall flipped thousands
// of tier changes in 200 ticks of a few centimetres' jitter without this).
export const NEAR_FULL_DETAIL_EXIT_M = 13;

// `wasNear` is whether the item was protected on the previous tick (false for
// an item with no history, which uses the plain enter distance).
export function isNearFullDetail(groundDistanceM, wasNear = false) {
  return groundDistanceM <= (wasNear ? NEAR_FULL_DETAIL_EXIT_M : NEAR_FULL_DETAIL_M);
}

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

// The tier an item should be in now, from its current tier (null/undefined for
// an item with no tier yet, which starts at the plain enter sizes with no
// hysteresis) and its apparent size in CSS pixels. Hysteresis applies at each
// boundary separately: an item in 'mid' stays there until it falls below the far
// enter size or rises above the mid exit size.
export function nextTier(currentTier, apparentPx) {
  if (currentTier === TIER_FAR) {
    if (apparentPx < LOD_FAR_EXIT_PX) return TIER_FAR;
    return apparentPx < LOD_MID_EXIT_PX ? TIER_MID : TIER_FULL;
  }
  if (currentTier === TIER_MID) {
    if (apparentPx < LOD_FAR_ENTER_PX) return TIER_FAR;
    return apparentPx < LOD_MID_EXIT_PX ? TIER_MID : TIER_FULL;
  }
  // 'full', or no tier yet: both step down at the plain enter sizes.
  if (apparentPx < LOD_FAR_ENTER_PX) return TIER_FAR;
  return apparentPx < LOD_MID_ENTER_PX ? TIER_MID : TIER_FULL;
}

// The tier every item ends up in once the budget is applied. `items` is a list
// of { px, wanted, protected }: its apparent size, the tier nextTier asked for,
// and whether it is protected (beside the avatar: always full, outside the
// budget). Returns an array of the final tiers in the same order. The smallest
// on screen drop first: full overflow goes to mid, and mid overflow (the items
// that wanted mid plus those just dropped) goes to far.
export function budgetedTiers(items, fullCap = MAX_FULL_DETAIL_ITEMS, midCap = MAX_MID_DETAIL_ITEMS) {
  let protectedCount = 0;
  const fullPxs = [];
  for (const item of items) {
    if (item.protected) protectedCount += 1;
    else if (item.wanted === TIER_FULL) fullPxs.push(item.px);
  }
  const fullFloorPx = fullDetailFloorPx(fullPxs, Math.max(fullCap - protectedCount, 0));
  const afterFull = items.map((item) => {
    if (item.protected) return TIER_FULL;
    if (item.wanted === TIER_FULL && item.px < fullFloorPx) return TIER_MID;
    return item.wanted;
  });
  const midPxs = [];
  items.forEach((item, index) => {
    if (!item.protected && afterFull[index] === TIER_MID) midPxs.push(item.px);
  });
  const midFloorPx = fullDetailFloorPx(midPxs, midCap);
  return items.map((item, index) => {
    if (afterFull[index] === TIER_MID && item.px < midFloorPx) return TIER_FAR;
    return afterFull[index];
  });
}

// Given the apparent sizes (px) of every item that wants a detail level, the
// size below which items must drop to the next cheaper level so no more than
// `cap` stay at it: the cap-th largest size (items strictly smaller drop). 0 when they all
// fit. Ties at the boundary keep full detail, so the count can exceed the cap by
// the size of the tie; that is cheaper than splitting equals arbitrarily.
export function fullDetailFloorPx(nearPxs, cap = MAX_FULL_DETAIL_ITEMS) {
  if (nearPxs.length <= cap) return 0;
  if (cap <= 0) return Infinity; // no budget left: every unprotected item simplifies
  const sorted = Float64Array.from(nearPxs).sort();
  return sorted[sorted.length - cap];
}

// #3443: items placed together as one bundle (a wall of bricks that are not all
// the same product, a house) change detail together: one decision for the whole
// set, from the set's size on screen, not item by item. "A wall is a wall; it
// does not dissolve piecemeal." Each member is { x, y, z, radiusM } in a common
// space (its landlet's local coordinates, the same space for every member of a
// set). Returns the smallest axis-aligned box's centre and half-diagonal around
// every member's own bounding sphere, which is cheap and never smaller than the
// set. An empty list is a zero sphere.
export function setBoundingSphere(members) {
  if (members.length === 0) return { x: 0, y: 0, z: 0, radiusM: 0 };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const member of members) {
    if (member.x - member.radiusM < minX) minX = member.x - member.radiusM;
    if (member.y - member.radiusM < minY) minY = member.y - member.radiusM;
    if (member.z - member.radiusM < minZ) minZ = member.z - member.radiusM;
    if (member.x + member.radiusM > maxX) maxX = member.x + member.radiusM;
    if (member.y + member.radiusM > maxY) maxY = member.y + member.radiusM;
    if (member.z + member.radiusM > maxZ) maxZ = member.z + member.radiusM;
  }
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    z: (minZ + maxZ) / 2,
    radiusM: 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ),
  };
}
