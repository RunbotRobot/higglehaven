// #3777 (slice 2): the walk another person's avatar wears on your screen. A
// default body used to slide across the ground with its legs still, and so did
// a custom body with no clips of its own: presence only carries positions, so
// nothing ever drove a pose for them. The shopper's own default body already
// swings its limbs (updateShopAvatarPose, src/shop/avatar.js); this is the same
// swing for the others, plus the cutoff that keeps a crowd cheap.
//
// Pure and allocation-free after createOtherLimbMotion(): nothing here touches
// three.js, the DOM or the clock. The caller (updateOtherShopAvatars) writes the
// angles onto the limb pivots, and for a custom body with no clips uses
// stepBuiltinMotion (src/shop/builtinMotion.js) instead.

// The same swing the shopper's own body uses, so a person looks the same to
// themselves and to others. src/shop/otherAvatarMotion.test.js reads main.js and
// fails if these drift from SHOP_AVATAR_SWING_AMPLITUDE_RAD,
// SHOP_AVATAR_CYCLE_SPEED_RAD_S and SHOP_AVATAR_SWING_EASE_PER_S.
export const OTHER_LIMB_SWING_AMPLITUDE_RAD = 0.55;
export const OTHER_LIMB_CYCLE_SPEED_RAD_S = 7;
export const OTHER_LIMB_SWING_EASE_PER_S = 8;
// Arms swing opposite their same-side leg at a gentler amplitude (as the
// shopper's own, updateShopAvatarPose).
export const OTHER_ARM_SWING_RATIO = 0.7;

// Presence only says whether someone is walking, not how fast, so a walker is
// drawn at a steady, moderate stride: 0.7 of the shopper's own full-run swing.
export const OTHER_AVATAR_WALK_MAGNITUDE = 0.7;

// Beyond this distance (metres, horizontal) from the shopper an avatar keeps
// the pose it last had: a few centimetres of limb are not visible there, and
// the per-frame budget (#3396) is better spent on the avatars near enough to
// read. Well inside the distance people are drawn at all.
export const OTHER_AVATAR_MOTION_RADIUS_M = 45;

export function createOtherLimbMotion() {
  return { swing: 0, phase: 0, legL: 0, legR: 0, armL: 0, armR: 0 };
}

// Advances the swing one frame. `moving` is whether the avatar is walking now.
// The amplitude eases toward its target rather than snapping, and the phase
// only advances while walking, so a stop always settles back to a neutral
// stance and never leaves a limb part-swung. Writes the four pivot angles
// (radians about local X) onto `motion` and returns it.
export function stepOtherLimbMotion(motion, dt, moving) {
  const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
  const target = moving ? OTHER_LIMB_SWING_AMPLITUDE_RAD * OTHER_AVATAR_WALK_MAGNITUDE : 0;
  motion.swing += (target - motion.swing) * Math.min(1, OTHER_LIMB_SWING_EASE_PER_S * step);
  if (moving) motion.phase += OTHER_LIMB_CYCLE_SPEED_RAD_S * OTHER_AVATAR_WALK_MAGNITUDE * step;
  const swing = Math.sin(motion.phase) * motion.swing;
  motion.legL = swing;
  motion.legR = -swing;
  motion.armL = -swing * OTHER_ARM_SWING_RATIO;
  motion.armR = swing * OTHER_ARM_SWING_RATIO;
  return motion;
}

// Whether to spend this frame's work on an avatar: it is drawn, and near enough
// to the shopper (dx, dy are the horizontal offset from the shopper to it).
export function shouldAnimateOtherAvatar(dx, dy, visible) {
  if (visible === false) return false;
  return dx * dx + dy * dy <= OTHER_AVATAR_MOTION_RADIUS_M * OTHER_AVATAR_MOTION_RADIUS_M;
}

// #4509: what a person who has stepped away looks like on another shopper's
// screen. Presence carries one fact, `afk` (#4390), and #4441 removed the label:
// a person's state is shown by the avatar itself. The shopper's own default body
// does a small standing fidget when idle (updateShopAvatarIdle in
// src/shop/avatar.js: a slow whole-body weight shift, a gentle counter-sway of
// the arms, an occasional glance of the head). This is the same fidget for the
// others, so a person looks the same to themselves and to everyone else.
//
// Pure and allocation-free after createOtherIdleMotion(seed): no three.js, DOM or
// clock. Randomness (the sway period and where the head glances) comes from a
// small seeded generator so one avatar's fidget is its own and the whole thing
// is deterministic from the sequence of calls.
//
// The numbers mirror SHOP_IDLE_* in src/main.js (otherAvatarMotion.test.js reads
// main.js and fails if they drift).
export const OTHER_IDLE_SWAY_AMPLITUDE_RAD = 0.035;
export const OTHER_IDLE_SWAY_PERIOD_MIN_S = 3.5;
export const OTHER_IDLE_SWAY_PERIOD_MAX_S = 6;
export const OTHER_IDLE_ARM_SWAY_AMPLITUDE_RAD = 0.05;
export const OTHER_IDLE_HEAD_TURN_MAX_RAD = 0.4;
export const OTHER_IDLE_HEAD_TURN_INTERVAL_MIN_S = 2.5;
export const OTHER_IDLE_HEAD_TURN_INTERVAL_MAX_S = 5;
export const OTHER_IDLE_HEAD_TURN_EASE_PER_S = 1.5;
// Fades in as slowly as the shopper's own (SHOP_IDLE_BLEND_PER_S). Your own
// fidget stops the instant you move; for someone else it eases out quickly
// instead (a person stepping back in is seen coming back, not snapping to
// attention), and the same rate takes the head glance back to centre.
export const OTHER_IDLE_BLEND_IN_PER_S = 0.6;
export const OTHER_IDLE_BLEND_OUT_PER_S = 4;

const TAU = Math.PI * 2;

// xorshift32: a state in, the next state out; `unit` turns it into [0, 1).
function nextSeed(seed) {
  let x = seed | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x | 0 || 1;
}
function unit(seed) {
  return (seed >>> 0) / 4294967296;
}

// A small integer hash of a person's id (a string or a number), for createOtherIdleMotion.
export function idleSeedFor(key) {
  const text = String(key ?? '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

// `seed` is any integer (a hash of the person's id): it keeps two people's
// fidgets from running in step.
export function createOtherIdleMotion(seed) {
  const motion = {
    blend: 0, // 0..1, how much of the fidget is showing
    phase: 0,
    periodS: OTHER_IDLE_SWAY_PERIOD_MIN_S,
    headTimerS: 0,
    headIntervalS: OTHER_IDLE_HEAD_TURN_INTERVAL_MIN_S,
    headTargetRad: 0,
    headRad: 0,
    seed: nextSeed((seed | 0) || 0x9e3779b9),
    // What the caller reads each frame.
    yawRad: 0, // whole-body weight shift, about local Z
    armRad: 0, // added to the left arm's pivot, taken from the right's
    headOutRad: 0, // the head's turn about local Z, as read by the caller
  };
  motion.seed = nextSeed(motion.seed);
  motion.phase = unit(motion.seed) * TAU; // two people never start in step
  motion.seed = nextSeed(motion.seed);
  motion.periodS = OTHER_IDLE_SWAY_PERIOD_MIN_S + unit(motion.seed) * (OTHER_IDLE_SWAY_PERIOD_MAX_S - OTHER_IDLE_SWAY_PERIOD_MIN_S);
  return motion;
}

// Whether there is anything to draw or to advance: the fidget is showing, or it
// is about to start. Lets the caller skip an avatar that is standing normally.
export function otherIdleActive(motion, away) {
  return away === true || motion.blend > 0.0005 || Math.abs(motion.headRad) > 0.0005;
}

// Advances one frame. `away` is whether the person is away now and still (a
// walking person is not fidgeting). Fills yawRad, armRad and headOutRad (radians)
// on `motion` and returns it.
export function stepOtherIdleMotion(motion, dt, away) {
  const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
  const target = away ? 1 : 0;
  const rate = away ? OTHER_IDLE_BLEND_IN_PER_S : OTHER_IDLE_BLEND_OUT_PER_S;
  motion.blend += (target - motion.blend) * Math.min(1, rate * step);
  if (motion.blend < 0.0005 && !away) motion.blend = 0;

  motion.phase += (step / motion.periodS) * TAU;
  if (motion.phase >= TAU) {
    motion.phase -= TAU;
    motion.seed = nextSeed(motion.seed);
    motion.periodS = OTHER_IDLE_SWAY_PERIOD_MIN_S + unit(motion.seed) * (OTHER_IDLE_SWAY_PERIOD_MAX_S - OTHER_IDLE_SWAY_PERIOD_MIN_S);
  }
  motion.headTimerS += step;
  if (motion.headTimerS >= motion.headIntervalS) {
    motion.headTimerS = 0;
    motion.seed = nextSeed(motion.seed);
    motion.headIntervalS = OTHER_IDLE_HEAD_TURN_INTERVAL_MIN_S + unit(motion.seed) * (OTHER_IDLE_HEAD_TURN_INTERVAL_MAX_S - OTHER_IDLE_HEAD_TURN_INTERVAL_MIN_S);
    motion.seed = nextSeed(motion.seed);
    motion.headTargetRad = (unit(motion.seed) * 2 - 1) * OTHER_IDLE_HEAD_TURN_MAX_RAD;
  }
  // The head follows its glance only as far as the fidget shows, so it comes
  // back to centre as the person returns.
  const headEase = Math.min(1, (away ? OTHER_IDLE_HEAD_TURN_EASE_PER_S : OTHER_IDLE_BLEND_OUT_PER_S) * step);
  motion.headRad += (motion.headTargetRad * motion.blend - motion.headRad) * headEase;
  if (!away && motion.blend === 0 && Math.abs(motion.headRad) < 0.0005) motion.headRad = 0;

  motion.yawRad = Math.sin(motion.phase) * OTHER_IDLE_SWAY_AMPLITUDE_RAD * motion.blend;
  motion.armRad = Math.sin(motion.phase * 0.5) * OTHER_IDLE_ARM_SWAY_AMPLITUDE_RAD * motion.blend;
  motion.headOutRad = motion.headRad;
  return motion;
}
