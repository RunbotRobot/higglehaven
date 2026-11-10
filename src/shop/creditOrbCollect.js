// #3392: the pure parts of collecting a credit orb, so they can be unit-tested
// without the scene. An orb pops the instant the avatar's body meets it and the
// server confirms afterwards (AGENTS.md: "An action in the world is felt the
// instant it happens"); these decide when contact happened and what a refusal
// from the server means for the orb that already popped.

// Furthest the avatar may have moved in one frame for the swept test to apply.
// A longer jump is a teleport (go to last location, a respawn), not a flight
// through the orb, so it is judged at its end point only and cannot collect
// everything along the way.
export const CREDIT_ORB_SWEEP_MAX_STEP_M = 8;

// How long a refused-for-now or unreachable collect keeps being retried, quietly
// and with the orb still popped, before the orb comes back (403: the server's
// presence record has not caught up with the walk-in yet, #2222; network blips).
export const CREDIT_ORB_RETRY_WINDOW_MS = 4000;
export const CREDIT_ORB_RETRY_INTERVAL_MS = 400;

// Shortest distance from (px, py) to the segment (ax, ay)-(bx, by).
function distanceToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lengthSq));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

// True when the avatar's body has met the orb's surface this frame: the orb is
// within `reachM` (the avatar's footprint half-width plus the orb's radius) of
// where the avatar is now or of any point on the way here from `from`. `from`
// may be null (first frame) and is ignored across a teleport-sized jump.
export function creditOrbContact({ orbX, orbY, from, to, reachM }) {
  if (Math.hypot(orbX - to.x, orbY - to.y) <= reachM) return true;
  if (!from) return false;
  if (Math.hypot(to.x - from.x, to.y - from.y) > CREDIT_ORB_SWEEP_MAX_STEP_M) return false;
  return distanceToSegment(orbX, orbY, from.x, from.y, to.x, to.y) <= reachM;
}

// What the server's answer to a collect request means for an orb that has
// already popped on the client:
//   'gone'    404: someone else collected it first; it stays gone, visibly reversed
//   'limited' 429: the collect limit; the orb comes back, the limit is explained
//   'retry'   403 (presence behind), a 5xx, or no response at all: keep it popped
//             and retry for CREDIT_ORB_RETRY_WINDOW_MS, then bring it back
export function creditOrbRefusalKind(error) {
  if (error?.status === 404) return 'gone';
  if (error?.status === 429) return 'limited';
  return 'retry';
}

// Whether another quiet retry is allowed `elapsedMs` after the first attempt.
export function creditOrbMayRetry(elapsedMs) {
  return elapsedMs + CREDIT_ORB_RETRY_INTERVAL_MS < CREDIT_ORB_RETRY_WINDOW_MS;
}
