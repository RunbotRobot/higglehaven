// #4044 (part of #3539): after landing the view still points at the ground (to come down a person points
// the view down: the pitch is the climb), so a new person stands looking at grass with a product 3 to 15 m
// away just out of frame. On touch-down the view eases up to level over about half a second: only the
// pitch, never the heading, and a held look control always wins. Pure here so it can be unit-tested; the
// frame loop is in flightMovement.js.

// One constant to switch the whole thing off (the owner is given one thing to try, then decides).
export const LANDING_LEVEL_ENABLED = true;
// Level: the view looks along the ground, so a product on it is in frame under its card.
export const LANDING_LEVEL_PITCH = 0;
export const LANDING_LEVEL_EASE_S = 0.5;

// Where the pitch is `elapsedS` into an ease from `from` to `to` over `durationS` (smoothstep: no jolt at
// either end). Never goes past `to`, and a view already at or above `to` is left alone.
export function easedPitch(from, to, elapsedS, durationS) {
  if (from >= to) return from;
  const t = Math.min(1, Math.max(0, elapsedS / durationS));
  const s = t * t * (3 - 2 * t);
  return from + (to - from) * s;
}

// Whether a landing should start the ease: it is on, and the view looks down below level.
export function shouldLevelOnLanding(pitch, enabled = LANDING_LEVEL_ENABLED) {
  return enabled && pitch < LANDING_LEVEL_PITCH;
}
