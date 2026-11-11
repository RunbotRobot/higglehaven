// #3449 (part of #3444): what an assistant on shift does while nobody is talking
// to it. The server places an assistant at a fixed public spot and never moves
// it (the session has no browser); this module gives it a little life on the
// client, computed from nothing but the assistant's name and the clock, so it
// costs the server nothing and every shopper sees the same thing without any
// coordination.
//
// A free assistant stands for a while, takes a few unhurried steps to another
// spot close to where it was placed, stands again, and faces a shopper who
// walks up. A busy one (helping someone) stays where it is, looking occupied.
// It reads as someone at work, not a parade: the whole wander stays within
// IDLE_WANDER_RADIUS_M of the placed spot, so it never drifts onto a product or
// into a doorway the server's spot was chosen to avoid.
//
// Pure and dependency-free, so it runs in the plain vitest pool.

export const IDLE_WANDER_RADIUS_M = 1.1; // never further than this from the placed spot
export const IDLE_SEGMENT_MS = 11000; // one stand-and-step cycle
export const IDLE_WALK_MS = 3000; // the stepping part of each cycle
export const IDLE_FACE_RANGE_M = 6; // a free assistant turns to a shopper this close
export const IDLE_MIN_STEP_M = 0.4; // a wander shorter than this is just standing

// A small, stable 32-bit hash of a string (FNV-1a), then a seeded generator: the
// same name and segment always give the same numbers.
export function hashString(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function seededUnit(seed, k, salt) {
  let t = (hashString(`${seed}:${k}:${salt}`) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// The spot an assistant stands at, relative to its placed spot, at the end of
// segment k. A point in the disc, uniformly (square root on the radius).
export function waypoint(seed, k) {
  const angle = seededUnit(seed, k, 'a') * Math.PI * 2;
  const radius = Math.sqrt(seededUnit(seed, k, 'r')) * IDLE_WANDER_RADIUS_M;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

// Segments are numbered from 0 at an arbitrary epoch; two assistants have
// different seeds so they never move in step. A per-assistant phase offset keeps
// them out of step even when their names hash alike in the low bits.
function segmentPosition(seed, nowMs) {
  const phase = seededUnit(seed, 0, 'phase') * IDLE_SEGMENT_MS;
  const shifted = nowMs + phase;
  const k = Math.floor(shifted / IDLE_SEGMENT_MS);
  const within = shifted - k * IDLE_SEGMENT_MS;
  return { k, within };
}

const smooth = (t) => t * t * (3 - 2 * t);

// Heading that points the avatar's front (+Y) along (dx, dy), same convention
// as every other avatar heading in the app.
export function headingToward(dx, dy) {
  return Math.atan2(-dx, dy);
}

// { x, y } offset from the placed spot, a heading, and whether it is stepping.
//   seed       any stable string: the assistant's name.
//   nowMs      the clock.
//   busy       helping someone: no wandering.
//   toShopper  optional { dx, dy } from the assistant to the nearest shopper.
//   baseHeading  the heading to keep when nothing says otherwise.
export function idleState({ seed, nowMs, busy = false, toShopper = null, baseHeading = 0 }) {
  if (busy) {
    // Occupied: stays put, and faces the person it is with when one is near.
    const heading = toShopper && Math.hypot(toShopper.dx, toShopper.dy) <= IDLE_FACE_RANGE_M
      ? headingToward(toShopper.dx, toShopper.dy)
      : baseHeading;
    return { x: 0, y: 0, heading, moving: false };
  }
  const { k, within } = segmentPosition(seed, nowMs);
  const from = k === 0 ? { x: 0, y: 0 } : waypoint(seed, k - 1);
  const to = waypoint(seed, k);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const wanders = distance >= IDLE_MIN_STEP_M;
  const walking = wanders && within < IDLE_WALK_MS;
  const t = walking ? smooth(within / IDLE_WALK_MS) : 1;
  const x = wanders ? from.x + dx * t : to.x;
  const y = wanders ? from.y + dy * t : to.y;
  let heading = wanders ? headingToward(dx, dy) : baseHeading;
  // Standing and a shopper is close: turn to them. Walking keeps its heading, so
  // it never moonwalks.
  if (!walking && toShopper && Math.hypot(toShopper.dx, toShopper.dy) <= IDLE_FACE_RANGE_M) {
    heading = headingToward(toShopper.dx, toShopper.dy);
  }
  return { x, y, heading, moving: walking };
}
