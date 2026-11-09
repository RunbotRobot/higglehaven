// #3294 (leaf 3/6 of #3291, part of #3253): the one place that builds the
// shopper's equipped avatar and mounts it in a scene, extracted unchanged from
// enterShopMode (src/shop/mode.js) so Shop and the Sell-mode world view (leaf
// 4/6) build it the same way. Dependency-injected and import-free so it is unit
// testable without the DOM or three.js; mode.js passes the real functions.
//
// Behaviour kept exactly as it was inline in enterShopMode:
// - the equipped avatar and applied animation are fetched only when logged in
//   (an anonymous visit mid verify-email/password-reset must not call the
//   endpoints: a 401 shows up as a console error even when caught);
// - each fetch failing is logged and never blocks entry, falling back to the
//   default avatar / the avatar's own clips;
// - an avatar left from a previous round trip is removed and disposed first
//   (#1358) so two bodies never overlap or leak;
// - a custom avatar that fails to load falls back to the default avatar;
// - the window.__shopAvatar* diagnostics are published and the idle state is
//   reset (#2623).
export async function mountShopAvatar({ scene, isLoggedIn }, deps) {
  const {
    fetchMyEquippedAvatar, fetchMyEquippedAnimation, setEquippedAvatarSkeletonSignature,
    getShopAvatar, setShopAvatar, disposeObject3D, createCustomShopAvatar, createShopAvatar,
    shopAvatarHeightM, shopAvatarCollisionHalfM, shopCameraAnchorHeightM,
    resetShopAvatarIdleState, win = globalThis.window,
  } = deps;

  let equippedAvatarModelUrl = null;
  setEquippedAvatarSkeletonSignature(null);
  // #1165: the applied animation (if any and still owned), fetched alongside
  // the equipped avatar: createCustomShopAvatar needs both together to decide
  // whether the animation's clips apply (#1162's compatibility check) or the
  // avatar falls back to its own.
  let equippedAnimation = null;
  if (isLoggedIn) {
    try {
      const avatar = await fetchMyEquippedAvatar();
      equippedAvatarModelUrl = avatar.modelUrl;
      setEquippedAvatarSkeletonSignature(avatar.skeletonSignature);
    } catch (err) {
      console.warn('Could not fetch equipped avatar, using the default avatar:', err);
    }
    try {
      const animation = await fetchMyEquippedAnimation();
      if (animation.equippedTemplateId) equippedAnimation = animation;
    } catch (err) {
      console.warn('Could not fetch applied animation, falling back to the equipped avatar\'s own clips:', err);
    }
  }

  // Re-entering without a reload: remove (and dispose, #1358) any avatar left
  // from a previous round trip before building a fresh one.
  const previous = getShopAvatar();
  if (previous) {
    scene.remove(previous.group);
    disposeObject3D(previous.group);
  }
  setShopAvatar(null);
  if (equippedAvatarModelUrl) {
    try {
      setShopAvatar(await createCustomShopAvatar(equippedAvatarModelUrl, equippedAnimation));
    } catch (err) {
      console.warn(`Failed to load equipped avatar model (${equippedAvatarModelUrl}), falling back to the default avatar:`, err);
    }
  }
  if (!getShopAvatar()) setShopAvatar(createShopAvatar());
  const avatar = getShopAvatar();
  scene.add(avatar.group);
  win.__shopAvatarModelUrl = avatar.modelUrl; // see refreshEquippedShopAvatar's own comment on this (#982)
  win.__shopAvatarMetrics = { heightM: shopAvatarHeightM(), collisionHalfM: shopAvatarCollisionHalfM(), cameraAnchorHeightM: shopCameraAnchorHeightM() }; // (#1091)
  win.__shopAvatarAnimationSource = avatar.animationSource ?? null; // see createCustomShopAvatar's own comment on this (#1165)
  resetShopAvatarIdleState(); // src/shop/avatar.js (#2623): zeroes every idle/sway/sit/lean field it owns
  return avatar;
}
