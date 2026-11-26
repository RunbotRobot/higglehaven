import { describe, it, expect } from 'vitest';
import mainSource from '../main.js?raw';
import {
  createOtherLimbMotion, stepOtherLimbMotion, shouldAnimateOtherAvatar,
  OTHER_LIMB_SWING_AMPLITUDE_RAD,
  OTHER_AVATAR_WALK_MAGNITUDE, OTHER_AVATAR_MOTION_RADIUS_M,
  createOtherIdleMotion, stepOtherIdleMotion, otherIdleActive, idleSeedFor,
  OTHER_IDLE_SWAY_AMPLITUDE_RAD, OTHER_IDLE_SWAY_PERIOD_MIN_S, OTHER_IDLE_SWAY_PERIOD_MAX_S,
  OTHER_IDLE_ARM_SWAY_AMPLITUDE_RAD, OTHER_IDLE_HEAD_TURN_MAX_RAD,
  OTHER_IDLE_HEAD_TURN_INTERVAL_MIN_S, OTHER_IDLE_HEAD_TURN_INTERVAL_MAX_S,
  OTHER_IDLE_HEAD_TURN_EASE_PER_S, OTHER_IDLE_BLEND_IN_PER_S, OTHER_IDLE_BLEND_OUT_PER_S,
} from './otherAvatarMotion.js';
import { createBuiltinMotion, stepBuiltinMotion } from './builtinMotion.js';

function run(motion, seconds, moving) {
  for (let i = 0; i < Math.round(seconds * 60); i++) stepOtherLimbMotion(motion, 1 / 60, moving);
}

describe('another person\'s default body swings like your own', () => {
  it('is still when standing', () => {
    const motion = createOtherLimbMotion();
    run(motion, 2, false);
    expect(motion.legL).toBe(0);
    expect(motion.armR).toBe(0);
  });

  it('swings the legs opposite each other and the arms against the legs while walking', () => {
    const motion = createOtherLimbMotion();
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      stepOtherLimbMotion(motion, 1 / 60, true);
      expect(motion.legR).toBeCloseTo(-motion.legL, 10);
      expect(motion.armL).toBeCloseTo(-motion.legL * 0.7, 10);
      expect(motion.armR).toBeCloseTo(motion.legL * 0.7, 10);
      peak = Math.max(peak, Math.abs(motion.legL));
    }
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThanOrEqual(OTHER_LIMB_SWING_AMPLITUDE_RAD * OTHER_AVATAR_WALK_MAGNITUDE + 1e-9);
  });

  it('eases to a neutral stance after a stop instead of freezing mid-stride', () => {
    const motion = createOtherLimbMotion();
    run(motion, 1, true);
    const swinging = Math.abs(motion.swing);
    expect(swinging).toBeGreaterThan(0.2);
    run(motion, 2, false);
    expect(Math.abs(motion.swing)).toBeLessThan(0.001);
    expect(Math.abs(motion.legL)).toBeLessThan(0.001);
  });

  it('survives a bad time step', () => {
    const motion = createOtherLimbMotion();
    stepOtherLimbMotion(motion, NaN, true);
    stepOtherLimbMotion(motion, -1, true);
    stepOtherLimbMotion(motion, 1000, true); // clamped, not a whole second of swing at once
    expect(Number.isFinite(motion.legL)).toBe(true);
  });

  it('does not allocate: it fills and returns the object it was given', () => {
    const motion = createOtherLimbMotion();
    expect(stepOtherLimbMotion(motion, 1 / 60, true)).toBe(motion);
  });
});

describe('the cutoff', () => {
  it('animates an avatar near the shopper and skips a far or hidden one', () => {
    expect(shouldAnimateOtherAvatar(3, 4, true)).toBe(true);
    expect(shouldAnimateOtherAvatar(OTHER_AVATAR_MOTION_RADIUS_M - 1, 0, true)).toBe(true);
    expect(shouldAnimateOtherAvatar(OTHER_AVATAR_MOTION_RADIUS_M + 1, 0, true)).toBe(false);
    expect(shouldAnimateOtherAvatar(0, -(OTHER_AVATAR_MOTION_RADIUS_M + 1), true)).toBe(false);
    expect(shouldAnimateOtherAvatar(1, 1, false)).toBe(false);
  });
});

describe('what a dozen avatars cost a frame', () => {
  it('keeps a crowd of twelve a small fraction of a frame', () => {
    const limbs = Array.from({ length: 6 }, () => createOtherLimbMotion());
    const rigid = Array.from({ length: 6 }, () => createBuiltinMotion());
    const frames = 4000;
    // warm up, then measure
    for (let i = 0; i < 500; i++) {
      for (const m of limbs) stepOtherLimbMotion(m, 1 / 60, i % 120 < 60);
      for (const m of rigid) stepBuiltinMotion(m, 1 / 60, i % 120 < 60 ? 'walk' : 'idle', 0.7, 1.7);
    }
    const start = performance.now();
    for (let i = 0; i < frames; i++) {
      const moving = i % 120 < 60;
      for (const m of limbs) stepOtherLimbMotion(m, 1 / 60, moving);
      for (const m of rigid) stepBuiltinMotion(m, 1 / 60, moving ? 'walk' : 'idle', 0.7, 1.7);
    }
    const msPerFrame = (performance.now() - start) / frames;
    console.log(`12 avatars (6 default, 6 clip-less custom): ${msPerFrame.toFixed(5)} ms per frame of pure motion maths`);
    // A generous ceiling (a 60 fps frame is 16.7 ms): this fails only if the
    // maths grows an allocation or a loop it should not have.
    expect(msPerFrame).toBeLessThan(0.5);
  });
});

// #4509: what a person who has stepped away looks like to everyone else.
function runIdle(motion, seconds, away, dtS = 1 / 60) {
  const steps = Math.round(seconds / dtS);
  let peakYaw = 0;
  let peakArm = 0;
  let peakHead = 0;
  for (let i = 0; i < steps; i++) {
    stepOtherIdleMotion(motion, dtS, away);
    peakYaw = Math.max(peakYaw, Math.abs(motion.yawRad));
    peakArm = Math.max(peakArm, Math.abs(motion.armRad));
    peakHead = Math.max(peakHead, Math.abs(motion.headOutRad));
  }
  return { peakYaw, peakArm, peakHead };
}

describe('another person who has stepped away fidgets like your own idle body', () => {
  it('shares the numbers your own idle body uses (src/main.js)', () => {
    const main = mainSource;
    const read = (name) => {
      const match = main.match(new RegExp(`export const ${name} = ([0-9.]+)`));
      expect(match, name).not.toBeNull();
      return Number(match[1]);
    };
    expect(OTHER_IDLE_SWAY_AMPLITUDE_RAD).toBe(read('SHOP_IDLE_SWAY_AMPLITUDE_RAD'));
    expect(OTHER_IDLE_SWAY_PERIOD_MIN_S).toBe(read('SHOP_IDLE_SWAY_PERIOD_MIN_S'));
    expect(OTHER_IDLE_SWAY_PERIOD_MAX_S).toBe(read('SHOP_IDLE_SWAY_PERIOD_MAX_S'));
    expect(OTHER_IDLE_ARM_SWAY_AMPLITUDE_RAD).toBe(read('SHOP_IDLE_ARM_SWAY_AMPLITUDE_RAD'));
    expect(OTHER_IDLE_HEAD_TURN_MAX_RAD).toBe(read('SHOP_IDLE_HEAD_TURN_MAX_RAD'));
    expect(OTHER_IDLE_HEAD_TURN_INTERVAL_MIN_S).toBe(read('SHOP_IDLE_HEAD_TURN_INTERVAL_MIN_S'));
    expect(OTHER_IDLE_HEAD_TURN_INTERVAL_MAX_S).toBe(read('SHOP_IDLE_HEAD_TURN_INTERVAL_MAX_S'));
    expect(OTHER_IDLE_HEAD_TURN_EASE_PER_S).toBe(read('SHOP_IDLE_HEAD_TURN_EASE_PER_S'));
    expect(OTHER_IDLE_BLEND_IN_PER_S).toBe(read('SHOP_IDLE_BLEND_PER_S'));
  });

  it('is perfectly still for someone who is not away', () => {
    const motion = createOtherIdleMotion(idleSeedFor('builder-a'));
    const peaks = runIdle(motion, 10, false);
    expect(peaks).toEqual({ peakYaw: 0, peakArm: 0, peakHead: 0 });
    expect(otherIdleActive(motion, false)).toBe(false);
  });

  it('eases in over seconds, then sways, swings the arms and glances', () => {
    const motion = createOtherIdleMotion(idleSeedFor('builder-a'));
    stepOtherIdleMotion(motion, 1 / 60, true);
    expect(motion.blend).toBeGreaterThan(0);
    expect(motion.blend).toBeLessThan(0.05); // not at full strength on the first frame
    const { peakYaw, peakArm, peakHead } = runIdle(motion, 20, true);
    expect(motion.blend).toBeGreaterThan(0.99);
    expect(peakYaw).toBeGreaterThan(OTHER_IDLE_SWAY_AMPLITUDE_RAD * 0.5);
    expect(peakYaw).toBeLessThanOrEqual(OTHER_IDLE_SWAY_AMPLITUDE_RAD + 1e-9);
    expect(peakArm).toBeGreaterThan(OTHER_IDLE_ARM_SWAY_AMPLITUDE_RAD * 0.4);
    expect(peakArm).toBeLessThanOrEqual(OTHER_IDLE_ARM_SWAY_AMPLITUDE_RAD + 1e-9);
    expect(peakHead).toBeGreaterThan(0.02);
    expect(peakHead).toBeLessThanOrEqual(OTHER_IDLE_HEAD_TURN_MAX_RAD + 1e-9);
  });

  it('eases back to neutral when the person returns (no pop), and then costs nothing', () => {
    const motion = createOtherIdleMotion(idleSeedFor('builder-a'));
    runIdle(motion, 20, true);
    const away = motion.blend;
    expect(away).toBeGreaterThan(0.99);
    stepOtherIdleMotion(motion, 1 / 60, false);
    expect(motion.blend).toBeLessThan(away); // eased, not snapped...
    expect(motion.blend).toBeGreaterThan(away * 0.8); // ...and not a single-frame cut either
    runIdle(motion, 3, false);
    expect(motion.blend).toBe(0);
    expect(Math.abs(motion.yawRad)).toBe(0);
    expect(Math.abs(motion.armRad)).toBe(0);
    expect(Math.abs(motion.headOutRad)).toBe(0);
    expect(otherIdleActive(motion, false)).toBe(false);
  });

  it('keeps two people out of step, and each person the same on every run', () => {
    const a = createOtherIdleMotion(idleSeedFor('builder-a'));
    const b = createOtherIdleMotion(idleSeedFor('builder-b'));
    const a2 = createOtherIdleMotion(idleSeedFor('builder-a'));
    runIdle(a, 12, true);
    runIdle(b, 12, true);
    runIdle(a2, 12, true);
    expect(a.yawRad).toBe(a2.yawRad);
    expect(a.headOutRad).toBe(a2.headOutRad);
    expect(a.yawRad).not.toBe(b.yawRad);
  });

  it('survives a bad time step and does not allocate', () => {
    const motion = createOtherIdleMotion(1);
    stepOtherIdleMotion(motion, NaN, true);
    stepOtherIdleMotion(motion, -1, true);
    stepOtherIdleMotion(motion, 1000, true);
    expect(Number.isFinite(motion.yawRad)).toBe(true);
    expect(Number.isFinite(motion.headOutRad)).toBe(true);
    expect(stepOtherIdleMotion(motion, 1 / 60, true)).toBe(motion);
  });

  it('keeps the head glance and sway period inside the same ranges as your own', () => {
    const motion = createOtherIdleMotion(idleSeedFor('builder-c'));
    for (let i = 0; i < 6000; i++) {
      stepOtherIdleMotion(motion, 1 / 60, true);
      expect(motion.periodS).toBeGreaterThanOrEqual(OTHER_IDLE_SWAY_PERIOD_MIN_S);
      expect(motion.periodS).toBeLessThanOrEqual(OTHER_IDLE_SWAY_PERIOD_MAX_S);
      expect(motion.headIntervalS).toBeGreaterThanOrEqual(OTHER_IDLE_HEAD_TURN_INTERVAL_MIN_S);
      expect(motion.headIntervalS).toBeLessThanOrEqual(OTHER_IDLE_HEAD_TURN_INTERVAL_MAX_S);
    }
    expect(OTHER_IDLE_BLEND_OUT_PER_S).toBeGreaterThan(OTHER_IDLE_BLEND_IN_PER_S);
  });
});

describe('what a crowd of people who have stepped away costs a frame (#4509)', () => {
  it('keeps a hundred away fidgets a small fraction of a frame', () => {
    const crowd = Array.from({ length: 100 }, (_, i) => createOtherIdleMotion(idleSeedFor(`person-${i}`)));
    for (let i = 0; i < 300; i++) for (const m of crowd) stepOtherIdleMotion(m, 1 / 60, true);
    const frames = 2000;
    const start = performance.now();
    for (let i = 0; i < frames; i++) for (const m of crowd) stepOtherIdleMotion(m, 1 / 60, i % 600 < 300);
    const msPerFrame = (performance.now() - start) / frames;
    console.log(`100 away fidgets: ${msPerFrame.toFixed(5)} ms per frame of pure motion maths`);
    expect(msPerFrame).toBeLessThan(0.5);
  });
});
