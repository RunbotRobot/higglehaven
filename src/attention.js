// Pure logic behind #215's sustained view-attention tracking (docs/SPEC.md
// §2 — item-handling animations trigger "on sustained view-attention," not
// mere proximity). src/main.js's own per-frame loop supplies world
// positions/vectors (three.js math, which can't run in this pool — see
// settings.js/flight.js's own header comments for why this repo pulls
// side-effect-free logic out into small modules like this one); this file
// only does the plain-number selection/accumulation math, so it can be
// tested directly instead of only through a live three.js scene.

// True if a single candidate — already reduced to its distance from the
// observation point and the dot product of (observation point → candidate)
// with the viewer's own forward direction — is both close enough and
// roughly centered enough in view to count as a plausible attention target
// this frame.
export function isWithinAttentionRange(distanceM, dot, { radiusM, fovCos }) {
  return distanceM <= radiusM && dot >= fovCos;
}

// #1592: owner report — the "inspect product" animation played with the
// avatar facing AWAY from the product. Root cause: main.js's own per-frame
// loop used to measure distanceM/dot from `camera.position`, but Shop
// mode's camera is a chase camera trailing SHOP_CAMERA_FOLLOW_DISTANCE_M
// *behind* the shopper's own head anchor (positionShopCamera) — not
// colocated with it. That trailing offset means a product sitting just
// behind the shopper can still be further *ahead* of the camera's own,
// even-further-back position, and so register as "in view" from the
// camera even though it's behind the shopper who's supposedly reaching for
// it. Anchoring this math on the shopper's own head position (whatever
// main.js passes as `anchor` — the camera's trailing offset never enters
// into it) instead of the camera's own position avoids that: an item
// behind the shopper always reports a negative dot, full stop.
// #1814: owner decision -- sustained attention (and so item-handling) must
// gate on the avatar's own body facing (shopAvatarFacing), not the camera's
// look direction, so a camera-only glance (right-stick free-look without
// the avatar's body turning that way) never triggers the reach animation.
// shopAvatarFacing and the camera's own yaw (shopYaw) already share the
// same global Z-axis rotation convention in main.js -- confirmed by the
// atan2(sin(a-b), cos(a-b)) comparisons that mix the two directly -- but
// only the camera's horizontal forward vector is readily computed each
// frame (via camera.getWorldDirection()); there's no separate "avatar rig's
// own local-forward axis" constant available to rotate by instead. Since a
// fixed Z-axis rotation is linear, rotating the camera's already-correct
// horizontal forward by the angular difference between the two yaws
// produces the equally-correct body forward, without needing that local-
// forward convention at all.
export function yawRotatedForward(forward, fromYaw, toYaw) {
  const delta = toYaw - fromYaw;
  const cosDelta = Math.cos(delta);
  const sinDelta = Math.sin(delta);
  return {
    x: forward.x * cosDelta - forward.y * sinDelta,
    y: forward.x * sinDelta + forward.y * cosDelta,
    z: forward.z,
  };
}

export function attentionDistanceAndDot(anchor, forward, itemWorldPosition) {
  const dx = itemWorldPosition.x - anchor.x;
  const dy = itemWorldPosition.y - anchor.y;
  const dz = itemWorldPosition.z - anchor.z;
  const distanceM = Math.hypot(dx, dy, dz);
  const dot = distanceM > 0 ? (dx * forward.x + dy * forward.y + dz * forward.z) / distanceM : 1;
  return { distanceM, dot };
}

// Picks the nearest in-range-and-in-view candidate, or null if none
// qualify. candidates: an array of { id, distanceM, dot }, in any order —
// ties (equal distanceM) keep whichever was seen first.
export function pickNearestInRange(candidates, { radiusM, fovCos }) {
  let best = null;
  for (const candidate of candidates) {
    if (!isWithinAttentionRange(candidate.distanceM, candidate.dot, { radiusM, fovCos })) continue;
    if (best === null || candidate.distanceM < best.distanceM) best = candidate;
  }
  return best ? best.id : null;
}

// How long the (possibly new) candidate has now held continuous attention:
// keeps accumulating only while the same target stays current frame to
// frame; any change — a different target, or none at all — resets to 0
// rather than carrying over a previous target's dwell time.
export function nextAttentionElapsedS(candidateId, previousTargetId, previousElapsedS, dt) {
  return candidateId !== null && candidateId === previousTargetId ? previousElapsedS + dt : 0;
}

// The actual trigger a consumer (e.g. #216's item-handling animations)
// should check, rather than comparing elapsedS to a threshold itself.
export function hasSustainedAttention(targetId, elapsedS, dwellS) {
  return targetId !== null && elapsedS >= dwellS;
}
