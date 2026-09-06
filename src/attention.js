// Pure logic behind #215's sustained view-attention tracking (docs/SPEC.md
// §2 — item-handling animations trigger "on sustained view-attention," not
// mere proximity). src/main.js's own per-frame loop supplies world
// positions/vectors (three.js math, which can't run in this pool — see
// settings.js/flight.js's own header comments for why this repo pulls
// side-effect-free logic out into small modules like this one); this file
// only does the plain-number selection/accumulation math, so it can be
// tested directly instead of only through a live three.js scene.

// True if a single candidate — already reduced to its distance from the
// camera and the dot product of (camera → candidate) with the camera's own
// forward direction — is both close enough and roughly centered enough in
// view to count as a plausible attention target this frame.
export function isWithinAttentionRange(distanceM, dot, { radiusM, fovCos }) {
  return distanceM <= radiusM && dot >= fovCos;
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
