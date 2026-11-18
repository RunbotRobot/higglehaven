import { describe, it, expect } from 'vitest';
import {
  createOtherLimbMotion, stepOtherLimbMotion, shouldAnimateOtherAvatar,
  OTHER_LIMB_SWING_AMPLITUDE_RAD,
  OTHER_AVATAR_WALK_MAGNITUDE, OTHER_AVATAR_MOTION_RADIUS_M,
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
