// #4389 (docs/SPEC.md §2 "Collision (crowding)"): two people cannot stand inside
// each other. A 0.6 m hard barrier (centre to centre) surrounded by a 0.3 m zone
// where the step toward the other person is progressively resisted: soft at the
// outer edge, nothing left at the barrier. Only the walker is slowed; the other
// avatar is never moved, and a step away from someone is never resisted, so a
// person who is walked into can always leave. Pure maths so it can be tested
// without a scene; flightMovement.js feeds it the avatars presence reports.
export const AVATAR_HARD_RADIUS_M = 0.6;
export const AVATAR_SOFT_ZONE_M = 0.3;

// others: [{ x, y }] in world metres. Returns the (dx, dy) to actually apply.
export function crowdAdjustedStep(x, y, dx, dy, others) {
  let ax = dx;
  let ay = dy;
  for (const other of others) {
    const ox = x - other.x; // from the other person to the walker
    const oy = y - other.y;
    const d = Math.hypot(ox, oy);
    if (d >= AVATAR_HARD_RADIUS_M + AVATAR_SOFT_ZONE_M || d < 1e-6) continue;
    const nx = ox / d;
    const ny = oy / d;
    const toward = -(ax * nx + ay * ny); // how much of the step heads at them
    if (toward <= 0) continue;
    const resistance = d <= AVATAR_HARD_RADIUS_M ? 1 : 1 - (d - AVATAR_HARD_RADIUS_M) / AVATAR_SOFT_ZONE_M;
    ax += nx * toward * resistance;
    ay += ny * toward * resistance;
  }
  return { dx: ax, dy: ay };
}
