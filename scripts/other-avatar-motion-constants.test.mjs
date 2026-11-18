// #3777: another person's default body is drawn with the same limb swing as the
// shopper's own (src/main.js), so a person looks the same to themselves and to
// others. The two copies of the numbers live in different files because
// otherAvatarMotion.js is pure; this fails if one drifts from the other.
import { describe, it, expect } from 'vitest';
import MAIN_JS from '../src/main.js?raw';
import AVATAR_JS from '../src/shop/avatar.js?raw';
import {
  OTHER_LIMB_SWING_AMPLITUDE_RAD, OTHER_LIMB_CYCLE_SPEED_RAD_S, OTHER_LIMB_SWING_EASE_PER_S,
} from '../src/shop/otherAvatarMotion.js';

function mainConstant(name) {
  const match = MAIN_JS.match(new RegExp(`export const ${name} = ([0-9.]+);`));
  return match ? Number(match[1]) : null;
}

describe("another person's limb swing matches the shopper's own", () => {
  it('uses the same amplitude, cycle speed and ease', () => {
    expect(OTHER_LIMB_SWING_AMPLITUDE_RAD).toBe(mainConstant('SHOP_AVATAR_SWING_AMPLITUDE_RAD'));
    expect(OTHER_LIMB_CYCLE_SPEED_RAD_S).toBe(mainConstant('SHOP_AVATAR_CYCLE_SPEED_RAD_S'));
    expect(OTHER_LIMB_SWING_EASE_PER_S).toBe(mainConstant('SHOP_AVATAR_SWING_EASE_PER_S'));
  });

  it('swings the arms at the same ratio to the legs', () => {
    expect(AVATAR_JS).toContain('-swing * 0.7');
    expect(AVATAR_JS).toContain('swing * 0.7');
  });
});
