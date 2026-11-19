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
//
// isLoggedIn is a boolean, or a function asked again before each fetch (#3498:
// a logout that lands between the two fetches, or while Shop mode is still
// starting on a slow machine, must not send the next one; it would 401 and show
// up as a console error even when caught).
let mountGeneration = 0; // each mount supersedes the background swap of the one before it

export async function mountShopAvatar({ scene, isLoggedIn }, deps) {
  const loggedIn = () => (typeof isLoggedIn === 'function' ? Boolean(isLoggedIn()) : Boolean(isLoggedIn));
  const {
    fetchMyEquippedAvatar, fetchMyEquippedAnimation, setEquippedAvatarSkeletonSignature,
    getShopAvatar, setShopAvatar, disposeObject3D, createCustomShopAvatar, createShopAvatar,
    shopAvatarHeightM, shopAvatarCollisionHalfM, shopCameraAnchorHeightM,
    resetShopAvatarIdleState, win = globalThis.window,
  } = deps;

  // #3905 (leaf of #3873, the mode-switch wait): the world no longer waits for the equipped avatar. The
  // default avatar is mounted at once and the screen can lift; the equipped avatar's fetches and its
  // model download then run in the background and the real body is swapped in when it is ready
  // (`settled` resolves then). A person with no custom avatar sees no change at all: the default avatar
  // is theirs, and they save the two request round trips that used to sit in front of the first frame.
  setEquippedAvatarSkeletonSignature(null);
  const generation = ++mountGeneration;

  // Re-entering without a reload: remove (and dispose, #1358) any avatar left
  // from a previous round trip before building a fresh one.
  const previous = getShopAvatar();
  if (previous) {
    scene.remove(previous.group);
    disposeObject3D(previous.group);
  }
  setShopAvatar(null);
  const startAvatar = createShopAvatar();
  setShopAvatar(startAvatar);
  scene.add(startAvatar.group);
  publishAvatar(win, startAvatar, { shopAvatarHeightM, shopAvatarCollisionHalfM, shopCameraAnchorHeightM });
  resetShopAvatarIdleState(); // src/shop/avatar.js (#2623): zeroes every idle/sway/sit/lean field it owns

  win.__shopAvatarSettled = false; // e2e: true once the equipped avatar (if any) is the one on screen
  const settled = upgradeToEquippedAvatar().then(
    () => { win.__shopAvatarSettled = true; },
    (err) => { console.warn('Equipped avatar upgrade failed, keeping the default avatar:', err); win.__shopAvatarSettled = true; },
  );
  return { avatar: startAvatar, settled };

  async function upgradeToEquippedAvatar() {
    let equippedAvatarModelUrl = null;
    let equippedAvatarClipRoles = null; // #3314: the seller's chosen idle/walk/fly clips, if any
    // #1165: the applied animation (if any and still owned), fetched alongside
    // the equipped avatar: createCustomShopAvatar needs both together to decide
    // whether the animation's clips apply (#1162's compatibility check) or the
    // avatar falls back to its own.
    let equippedAnimation = null;
    if (loggedIn()) {
      try {
        const avatar = await fetchMyEquippedAvatar();
        equippedAvatarModelUrl = avatar.modelUrl;
        equippedAvatarClipRoles = avatar.clipRoles ?? null;
        setEquippedAvatarSkeletonSignature(avatar.skeletonSignature);
      } catch (err) {
        console.warn('Could not fetch equipped avatar, using the default avatar:', err);
      }
      if (loggedIn()) {
        try {
          const animation = await fetchMyEquippedAnimation();
          if (animation.equippedTemplateId) equippedAnimation = animation;
        } catch (err) {
          console.warn('Could not fetch applied animation, falling back to the equipped avatar\'s own clips:', err);
        }
      }
    }
    if (!equippedAvatarModelUrl) return; // nothing equipped: the default avatar stays
    let custom;
    try {
      custom = await createCustomShopAvatar(equippedAvatarModelUrl, equippedAnimation, equippedAvatarClipRoles);
    } catch (err) {
      console.warn(`Failed to load equipped avatar model (${equippedAvatarModelUrl}), falling back to the default avatar:`, err);
      return;
    }
    // Something else replaced the avatar while this loaded (the person equipped one, or left the mode and
    // came back): this one is stale, drop it rather than put an old body on screen.
    if (generation !== mountGeneration || getShopAvatar() !== startAvatar) {
      disposeObject3D(custom.group);
      return;
    }
    scene.remove(startAvatar.group);
    disposeObject3D(startAvatar.group);
    setShopAvatar(custom);
    scene.add(custom.group);
    publishAvatar(win, custom, { shopAvatarHeightM, shopAvatarCollisionHalfM, shopCameraAnchorHeightM });
  }
}

// The window.__shopAvatar* diagnostics (e2e tests read what is actually live-rendered).
function publishAvatar(win, avatar, { shopAvatarHeightM, shopAvatarCollisionHalfM, shopCameraAnchorHeightM }) {
  win.__shopAvatarModelUrl = avatar.modelUrl; // see refreshEquippedShopAvatar's own comment on this (#982)
  win.__shopAvatarMetrics = { heightM: shopAvatarHeightM(), collisionHalfM: shopAvatarCollisionHalfM(), cameraAnchorHeightM: shopCameraAnchorHeightM() }; // (#1091)
  win.__shopAvatarAnimationSource = avatar.animationSource ?? null; // see createCustomShopAvatar's own comment on this (#1165)
  win.__shopAvatarBuiltinMotion = !!avatar.builtinMotion; // #3777: an avatar with no clips wears the built-in motion
}
