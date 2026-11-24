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
// #4113: the same two sizes for the members of a set (a wall, a house: things built together). The far
// version keeps a silhouette and a colour, which reads as a different object once a wall's bricks are
// more than a few pixels wide: the owner watched a wall of 14 to 20 px bricks go dull and flat, then
// jump to full in one frame at 10 m. A set steps full, mid, far, and takes the far version only where
// its parts are too small to tell from a colour.
export const LOD_SET_FAR_ENTER_PX = 10;
export const LOD_SET_FAR_EXIT_PX = 14;

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

// #3920: the same bound in triangles, because an item count is no bound on cost: 600 bricks of 5,320
// triangles is 3.2 million, and a bundled wall beside the avatar is protected whole and was outside
// every cap (4.4 to 8.8 million triangles in one frame, seconds in software GL). Protected items
// count against it. Over budget, the items nearest the avatar keep full detail and the farthest drop
// to mid, so a wall steps down from its far end; an item that is already full gets a few metres'
// credit (FULL_TRIANGLE_HYSTERESIS_M) so the boundary does not flicker as the avatar moves a step.
// What a phone draws comfortably in one frame, with the rest of the world's few hundred thousand.
export const MAX_FULL_DETAIL_TRIANGLES = 1_200_000;
export const FULL_TRIANGLE_HYSTERESIS_M = 3;

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
export function nextTier(currentTier, apparentPx, farEnterPx = LOD_FAR_ENTER_PX, farExitPx = LOD_FAR_EXIT_PX) {
  if (currentTier === TIER_FAR) {
    if (apparentPx < farExitPx) return TIER_FAR;
    return apparentPx < LOD_MID_EXIT_PX ? TIER_MID : TIER_FULL;
  }
  if (currentTier === TIER_MID) {
    if (apparentPx < farEnterPx) return TIER_FAR;
    return apparentPx < LOD_MID_EXIT_PX ? TIER_MID : TIER_FULL;
  }
  // 'full', or no tier yet: both step down at the plain enter sizes.
  if (apparentPx < farEnterPx) return TIER_FAR;
  return apparentPx < LOD_MID_ENTER_PX ? TIER_MID : TIER_FULL;
}

// #4113: the tier a member of a set wants (see LOD_SET_FAR_ENTER_PX).
export function nextSetTier(currentTier, apparentPx) {
  return nextTier(currentTier, apparentPx, LOD_SET_FAR_ENTER_PX, LOD_SET_FAR_EXIT_PX);
}

// The tier every item ends up in once the budget is applied. `items` is a list
// of { px, wanted, protected }: its apparent size, the tier nextTier asked for,
// and whether it is protected (beside the avatar: always full, outside the
// budget). Returns an array of the final tiers in the same order. The smallest
// on screen drop first: full overflow goes to mid, and mid overflow (the items
// that wanted mid plus those just dropped) goes to far.
export function budgetedTiers(items, fullCap = MAX_FULL_DETAIL_ITEMS, midCap = MAX_MID_DETAIL_ITEMS, fullTriangleCap = MAX_FULL_DETAIL_TRIANGLES, reasons = null) {
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
  const afterItemCap = reasons ? afterFull.slice() : null;
  applyFullTriangleBudget(items, afterFull, fullTriangleCap);
  const midPxs = [];
  items.forEach((item, index) => {
    if (!item.protected && afterFull[index] === TIER_MID) midPxs.push(item.px);
  });
  const midFloorPx = fullDetailFloorPx(midPxs, midCap);
  const finalTiers = items.map((item, index) => {
    if (afterFull[index] === TIER_MID && item.px < midFloorPx) return TIER_FAR;
    return afterFull[index];
  });
  if (reasons) {
    // #4113: why each item ended where it did, for the read-out (window.__testShopSetTiers). Only filled when asked.
    reasons.length = 0;
    items.forEach((item, index) => {
      let reason;
      if (finalTiers[index] === TIER_FAR && afterFull[index] === TIER_MID && item.wanted !== TIER_FAR) reason = 'mid cap (count)';
      else if (afterFull[index] !== afterItemCap[index]) reason = 'triangle budget';
      else if (afterItemCap[index] !== item.wanted && !item.protected) reason = 'full cap (count)';
      else if (item.protected) reason = 'beside the avatar';
      else reason = 'size';
      reasons.push(reason);
    });
  }
  return finalTiers;
}

// #3920: items may also carry `tris` (the triangle count of the item's full model; 0 or absent when
// unknown, which are not counted), `dist` (its own ground distance to the avatar in metres) and
// `current` (the tier it is drawn in now). Of the items ending up full, the nearest keep full detail
// until `cap` triangles are used; the rest go to mid. Edits `tiers` in place.
function applyFullTriangleBudget(items, tiers, cap) {
  let total = 0;
  const candidates = [];
  items.forEach((item, index) => {
    if (tiers[index] === TIER_FULL && item.tris > 0) {
      total += item.tris;
      candidates.push(index);
    }
  });
  if (total <= cap) return;
  const priority = (index) => (items[index].dist ?? Infinity) - (items[index].current === TIER_FULL ? FULL_TRIANGLE_HYSTERESIS_M : 0);
  candidates.sort((a, b) => priority(a) - priority(b));
  let used = 0;
  for (const index of candidates) {
    used += items[index].tris;
    if (used > cap) tiers[index] = TIER_MID;
  }
}

// #4003: items whose simpler versions have not attached yet can only be drawn from their full
// model, which on a heavy lándlet is millions of triangles in the first frames. This picks which of
// them wait (are not drawn) until their versions are there: `items` is a list of { tris, dist,
// sticky }, the triangle count of the full model (0 when unknown, which is never held), its ground
// distance to the point being looked at, and whether it is already being drawn (an item that is
// drawn stays drawn: nothing that appeared blinks out again). The sticky ones count first, then the
// nearest of the rest are let in while the total stays within `cap`; the nearest is always let in.
// Returns the held flags in the same order. Nothing is ever replaced by a stand-in: a held item is
// drawn, from its own real model, the moment its versions arrive or it is let in.
export function holdBackUnready(items, cap = MAX_FULL_DETAIL_TRIANGLES) {
  const held = items.map(() => false);
  let used = 0;
  items.forEach((item) => {
    if (item.sticky && item.tris > 0) used += item.tris;
  });
  const candidates = [];
  items.forEach((item, index) => {
    if (!item.sticky && item.tris > 0) candidates.push(index);
  });
  candidates.sort((a, b) => (items[a].dist ?? Infinity) - (items[b].dist ?? Infinity));
  for (const index of candidates) {
    const { tris } = items[index];
    if (used === 0 || used + tris <= cap) used += tris;
    else held[index] = true;
  }
  return held;
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

// #4089 (part of #4063): a set's whole size is the right input for keeping every member on one decision
// (no line sweeping across a wall, #4062) and the wrong input for how much detail each member gets: a brick
// 60 m away is a few pixels wide whatever the wall's width, but the 27 m wall it belongs to is hundreds of
// pixels, so judged by its whole size the wall kept most of its bricks on full or mid detail out to 60 m
// (1.66 M triangles a frame on the 1,650-brick wall, above what a phone takes comfortably, #3920).
// So a set that would cost more than this to draw whole in full detail is judged by its biggest member,
// seen from its nearest one. A set that costs less (a house, a short wall) keeps being judged by its whole
// size, exactly as before: drawing it whole is cheap and it reads as one thing at a distance.
export const SET_WHOLE_JUDGEMENT_MAX_TRIANGLES = 300_000;

// The apparent size a set is decided from, in CSS pixels. `set`: { sphere: { radiusM }, centerDistanceM,
// maxMemberRadiusM, nearestMemberDistanceM, fullTriangles }. For a big set the answer is the biggest
// member's size at the nearest member's distance, which is never smaller than any member's own apparent
// size (radius over distance), so no member loses detail it would have had alone; it is still one number
// for the whole set, so all members still make one decision.
export function setApparentPx(set, fovDeg, viewportHeightPx) {
  if (set.fullTriangles > SET_WHOLE_JUDGEMENT_MAX_TRIANGLES) {
    return apparentSizePx(set.maxMemberRadiusM, set.nearestMemberDistanceM, fovDeg, viewportHeightPx);
  }
  return apparentSizePx(set.sphere.radiusM, set.centerDistanceM, fovDeg, viewportHeightPx);
}

// #3494 / #3396: when several items are due to change version in one tick, the
// biggest on screen go first ("nearest and largest first"). That decides which
// of them get one of the few cross-fades that can run at once, and who is
// served before the tick's time slice runs out; the rest follow on later ticks.
// `indices` are positions in `items` ({ px }); returns them, largest first, with
// ties kept in their original order (the sort is stable). Sorts in place.
export function largestFirst(indices, items) {
  return indices.sort((a, b) => items[b].px - items[a].px);
}

// #3920 (moved here by #3929 so Build counts the same way): what a model costs to draw, in triangles.
// `skip` is a set of nodes (the mid and far versions attached to an item) left out of the walk.
export function trianglesOfGeometry(geometry) {
  return (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
}
export function countModelTriangles(node, skip) {
  if (skip.has(node)) return 0;
  let triangles = node.isMesh && node.geometry ? trianglesOfGeometry(node.geometry) : 0;
  for (const child of node.children) triangles += countModelTriangles(child, skip);
  return triangles;
}
