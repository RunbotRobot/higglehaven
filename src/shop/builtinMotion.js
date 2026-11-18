// #3777: the built-in motion a custom avatar wears when it carries no clips of
// its own. Such an avatar used to slide across the ground with a still body
// (the owner, testing as a new person: "he just kind of glides"). This is a
// small, playful, rigid whole-body motion: a bob and a lean and a sway when
// walking, a slow breath when standing, a gentle drift and bank in the air.
//
// It is deliberately plain. It only ever applies to an avatar with no clips, a
// model with its own clips or an animation the person applied from My
// Animations replaces it entirely (src/shop/avatar.js decides), so bought
// animations stay worth buying.
//
// Pure and allocation-free: createBuiltinMotion() makes one small state object,
// stepBuiltinMotion(motion, dt, state, moveMagnitude, scaleM) advances it and
// returns the same `pose` object each call. Nothing here touches three.js, the
// DOM or the clock, so it is deterministic from the sequence of calls.

// Walk cycle: one full stride (both feet) per cycle. The cycle speeds up with
// the stick's deflection, the same walk-slower/run-faster feel as ground speed.
const WALK_CYCLE_RAD_S_MIN = 7;
const WALK_CYCLE_RAD_S_MAX = 12;
// Bob is a few centimetres on a person-sized avatar: a fraction of its height.
const WALK_BOB_FRACTION = 0.022;
const WALK_LEAN_RAD = 0.09; // about 5 degrees forward at a full run
const WALK_SWAY_RAD = 0.05; // about 3 degrees side to side, once per stride
const IDLE_BREATH_HZ = 0.35;
const IDLE_BOB_FRACTION = 0.006;
const IDLE_SWAY_RAD = 0.012;
const FLY_DRIFT_HZ = 0.3;
const FLY_BOB_FRACTION = 0.014;
const FLY_BANK_RAD = 0.035;
// How quickly the blend between idle/walk/fly follows the state (per second),
// so stopping or taking off eases rather than snapping.
const BLEND_EASE_PER_S = 9;
const TAU = Math.PI * 2;

export function createBuiltinMotion() {
  return {
    // Blend weights, eased toward 0 or 1 each step; they sum to about 1.
    idleWeight: 1,
    walkWeight: 0,
    flyWeight: 0,
    walkPhase: 0,
    timeS: 0,
    // What the caller reads each frame (the same object every time).
    pose: { bobM: 0, leanRad: 0, swayRad: 0 },
  };
}

// state: 'idle' | 'walk' | 'fly'. moveMagnitude is the move stick's 0..1
// deflection. scaleM is the avatar's measured height in metres (a stand-in of
// 1 when unknown), so a small model bobs a little and a tall one a bit more.
export function stepBuiltinMotion(motion, dt, state, moveMagnitude, scaleM) {
  const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
  const mag = Math.min(Math.max(moveMagnitude || 0, 0), 1);
  const scale = scaleM > 0 ? scaleM : 1;

  const ease = Math.min(1, BLEND_EASE_PER_S * step);
  const targetWalk = state === 'walk' ? 1 : 0;
  const targetFly = state === 'fly' ? 1 : 0;
  const targetIdle = state === 'idle' ? 1 : 0;
  motion.walkWeight += (targetWalk - motion.walkWeight) * ease;
  motion.flyWeight += (targetFly - motion.flyWeight) * ease;
  motion.idleWeight += (targetIdle - motion.idleWeight) * ease;

  motion.timeS += step;
  // The stride only advances while walking, so a full stop eases back to the
  // standing pose and does not leave a lean part-way through a step.
  if (state === 'walk') {
    motion.walkPhase = (motion.walkPhase + (WALK_CYCLE_RAD_S_MIN + (WALK_CYCLE_RAD_S_MAX - WALK_CYCLE_RAD_S_MIN) * mag) * step) % TAU;
  }

  const walkAmp = 0.4 + 0.6 * mag; // a slow walk is gentler than a run
  // Two bobs per stride (one per foot), never below the standing height.
  const walkBob = WALK_BOB_FRACTION * scale * walkAmp * (1 - Math.cos(motion.walkPhase * 2)) * 0.5;
  const walkLean = -WALK_LEAN_RAD * walkAmp; // negative about +X is forward
  const walkSway = Math.sin(motion.walkPhase) * WALK_SWAY_RAD * walkAmp;

  const breath = Math.sin(motion.timeS * TAU * IDLE_BREATH_HZ);
  const idleBob = IDLE_BOB_FRACTION * scale * (breath + 1) * 0.5;
  const idleSway = breath * IDLE_SWAY_RAD;

  const drift = Math.sin(motion.timeS * TAU * FLY_DRIFT_HZ);
  const flyBob = FLY_BOB_FRACTION * scale * (drift + 1) * 0.5;
  const flyBank = drift * FLY_BANK_RAD;

  const pose = motion.pose;
  pose.bobM = motion.walkWeight * walkBob + motion.idleWeight * idleBob + motion.flyWeight * flyBob;
  pose.leanRad = motion.walkWeight * walkLean;
  pose.swayRad = motion.walkWeight * walkSway + motion.idleWeight * idleSway + motion.flyWeight * flyBank;
  return pose;
}
