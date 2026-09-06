// Pure geometry behind #221's shoreline-scarcity discoverability signal
// (docs/SPEC.md §1: "shoreline lánds are highly coveted once circle-
// exposed... anticipated organic 'gold rush'" — this only makes the fact
// findable, per #221's own scope, not a mechanical price boost). Computed
// fresh from each lándlet's own existing center/polygon/areaM2 — the same
// data the claim-map flyover already fetches to render every plot — never
// a stored flag that could go stale as water geometry or land generation
// changes around it.
//
// True adjacency would mean walking real polygon edges; instead each
// lándlet is approximated by a bounding circle centered on it, sized to
// its own farthest vertex (landletReachM) — the same "do these two
// circles touch" test bounding-circle collision checks already use
// elsewhere, just sized per-lándlet instead of a fixed radius. Since
// docs/SPEC.md §1 already commits to a puzzle-piece tiling with no gaps
// between adjacent lánds at ground level, two truly-neighboring lándlets'
// bounding circles always overlap (their shared edge sits inside both);
// the only false positives this can produce are two lándlets that are
// merely near each other without ever sharing an edge — an acceptable
// looseness for a discoverability aid, not a hard rule.

export function landletReachM(polygon, areaM2) {
  if (polygon && polygon.length >= 3) {
    return polygon.reduce((max, point) => Math.max(max, Math.hypot(point.x, point.y)), 0);
  }
  // No stored polygon — landletContainsPoint's own default square
  // fallback (half the diagonal of a square with this area).
  return Math.sqrt(areaM2 / 2);
}

export function areLandletsAdjacent(a, b, toleranceM = 0.5) {
  const distanceM = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y);
  return distanceM <= landletReachM(a.polygon, a.areaM2) + landletReachM(b.polygon, b.areaM2) + toleranceM;
}

// True if any other lándlet in `candidates` is water-type and adjacent to
// `landlet` — never true for a water lándlet itself (it doesn't "border"
// water, it is water; #220 owns surfacing that distinction visually).
export function bordersWater(landlet, candidates, toleranceM = 0.5) {
  if (landlet.landType === 'water') return false;
  return candidates.some(
    (other) => other.landType === 'water' && other.landletId !== landlet.landletId && areLandletsAdjacent(landlet, other, toleranceM),
  );
}
