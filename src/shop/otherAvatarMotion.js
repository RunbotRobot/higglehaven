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
