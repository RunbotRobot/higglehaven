// #2623 (leaf of #2563, itself part of #2504/#2500's src/main.js module
// split -- see #2503's design comment and #2563's own breakdown comment
// for the full dependency map): Shop mode's avatar -- mesh/skeleton
// creation (procedural default body and custom-model equip), per-frame
// pose (walk-cycle swing, animation-clip crossfade), and the idle state
// machine (sway, head turns, AFK fade, sit/lean target blending).
// Foundational -- every other #2563 leaf reads shopAvatar or the exported
// idle-pose offsets this module owns.
//
// Deliberately NOT included here, even though they're declared right in
// the middle of this same contiguous block in main.js -- genuinely
// different concerns that happen to be interleaved with the avatar code
// there, not avatar state: Shop flight (shopFlightState/Altitude/etc.),
// spawn-orbit (shopSpawnRotating/OrbitRadiusM), and "Go to Last Location"
// (shopLastLocationHideTimerS/etc.) now live in shop/flightMovement.js
// (#2624), along with window.__testTeleportShopAvatar/__testShopFlightState
// (both read/write that leaf's own state). window.__testForceShopProximityCheck/
// __testShopInstanceLodBand/HitSource/__rescaleModelFileForTests/
// __optimizeModelFileForTests stay in main.js, each either reading only
// main.js's own state or needing just a forward import -- each leaf's own
// future extraction (or none) to claim.
//
// shopAvatarPosition/shopAvatarFacing (the avatar's own real, authoritative
// ground-truth position/facing) also stay in main.js -- read here (never
// reassigned by this module), but written by not-yet-extracted flight/
// movement code, so main.js keeps owning them and this module reverse-
// imports a read-only live binding.
//
// The SHOP_AVATAR_*/SHOP_IDLE_*/SHOP_AFK_*/SHOP_CAMERA_ANCHOR_HEIGHT_*
// constants stay declared in main.js rather than moving here too, since
// several of them (SHOP_AVATAR_COLLISION_HALF_M particularly) are also
// read directly by shop/flightMovement.js's own movement/collision code --
// a reverse-import precedent, just for consts.
//
// findShopIdleInteractionTarget is a forward import from
// './flightMovement.js' (#2624) -- that module's own updateShopMovement
// calls back into this one (updateShopAvatarPose/setShopAvatarAnimationState/
// updateShopAvatarIdle), so the two are mutually dependent, same shape
// claim/flow.js's own header comment already documents for an analogous
// pair of modules.
import * as THREE from 'three';
import { loadModelInstance, computeSkeletonSignature, loadModelAnimations } from '../world/models.js';
import { scene } from '../world/scene.js';
import { currentMode } from '../world/state.js';
import { fetchMyEquippedAnimation } from '../api.js';
import { findShopIdleInteractionTarget } from './flightMovement.js';
import {
  SHOP_AFK_BLEND_PER_S, SHOP_AFK_DELAY_S, SHOP_AVATAR_ANIM_CROSSFADE_S,
  SHOP_AVATAR_ARM_LENGTH_M, SHOP_AVATAR_ARM_RADIUS_M, SHOP_AVATAR_COLLISION_HALF_M,
  SHOP_AVATAR_CYCLE_SPEED_RAD_S, SHOP_AVATAR_HEAD_RADIUS_M, SHOP_AVATAR_HEIGHT_M,
  SHOP_AVATAR_HIP_WIDTH_M, SHOP_AVATAR_LEG_LENGTH_M, SHOP_AVATAR_LEG_RADIUS_M,
  SHOP_AVATAR_SHOULDER_WIDTH_M, SHOP_AVATAR_SWING_AMPLITUDE_RAD, SHOP_AVATAR_SWING_EASE_PER_S,
  SHOP_AVATAR_TORSO_LENGTH_M, SHOP_AVATAR_TORSO_RADIUS_M, SHOP_CAMERA_ANCHOR_HEIGHT_M,
  SHOP_CAMERA_ANCHOR_HEIGHT_RATIO, SHOP_IDLE_ARM_SWAY_AMPLITUDE_RAD, SHOP_IDLE_BLEND_PER_S,
  SHOP_IDLE_DELAY_S, SHOP_IDLE_HEAD_TURN_EASE_PER_S, SHOP_IDLE_HEAD_TURN_INTERVAL_MAX_S,
  SHOP_IDLE_HEAD_TURN_INTERVAL_MIN_S, SHOP_IDLE_HEAD_TURN_MAX_RAD, SHOP_IDLE_SWAY_AMPLITUDE_RAD,
  SHOP_IDLE_SWAY_PERIOD_MAX_S, SHOP_IDLE_SWAY_PERIOD_MIN_S, SHOP_SIT_ARM_ROTATION_RAD,
  SHOP_SIT_LEG_ROTATION_RAD,
  shopAvatarPosition, shopAvatarFacing,
} from '../main.js';
// #2629: disposeObject3D/reportRendererMemoryDiagnostic now live in
// src/shop/mode.js (a sibling-module, not reverse-, import) -- mode.js's
// own enterShopMode in turn imports createShopAvatar/createCustomShopAvatar/
// etc. from this module, same mutually-dependent shape
// flightMovement.js's own header comment already documents for this
// module and that one.
import { disposeObject3D, reportRendererMemoryDiagnostic } from './mode.js';

// #1587 (owner feedback): the original "AFK" label was a full-size
// makeSignPostSprite — the same dark nameplate treatment used for
// community sign posts, floating well above the avatar's head on its own
// sign-post. Too garish, and the wrong shape for what's meant to be a
// small shoulder badge, not a sign. Rebuilt as a small on-brand pill:
// same rounded-rect-on-canvas technique makeDimensionLabelSprite already
// established in this file, using this app's actual pill colors
// (index.html's --pill-rgb/--ink-rgb) rather than inventing new ones, and
// lowercase "afk" to match the lowercase higglehaven wordmark convention.
function makeAfkBadgeSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = 104;
  canvas.height = 44;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(214, 232, 190, 0.92)'; // --pill-rgb
  ctx.beginPath();
  ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, (canvas.height - 4) / 2);
  ctx.fill();
  ctx.fillStyle = '#16240a'; // --ink-rgb
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('afk', canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  // Much smaller than makeSignPostSprite's own 0.012 world-units-per-px —
  // a shoulder badge, not a sign meant to read from across a landlet.
  const WORLD_UNITS_PER_PX = 0.0022;
  sprite.scale.set(canvas.width * WORLD_UNITS_PER_PX, canvas.height * WORLD_UNITS_PER_PX, 1);
  return sprite;
}

// The default avatar (docs/SPEC.md §2: "a single, standard, deliberately
// non-gendered avatar assigned instantly at registration"). No character
// asset/rig exists yet, so this is a plain, neutral placeholder built from
// primitives — a real modeled-and-rigged replacement is future work, not
// this pass's job. Limbs are each their own pivot Group (hip/shoulder
// height, empty at the pivot's own local origin) with the limb mesh hung
// below it (`mesh.position.z = -length / 2`), so a walk cycle can just
// rotate the pivot about local X — swinging the limb through the
// forward/back-and-up/down sagittal plane exactly like a real hip/shoulder
// joint — rather than needing a skeleton for one swinging joint per limb.
export function createShopAvatar() {
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x5b8dc9 });
  const headMaterial = new THREE.MeshStandardMaterial({ color: 0xe8c9a0 });

  function limb(radius, length, material) {
    const pivot = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 8), material);
    mesh.rotation.x = Math.PI / 2; // stand the cylinder's local-Y axis up along world Z
    mesh.position.z = -length / 2; // hang it below the pivot rather than centered on it
    pivot.add(mesh);
    return pivot;
  }

  const group = new THREE.Group();

  const legPivotL = limb(SHOP_AVATAR_LEG_RADIUS_M, SHOP_AVATAR_LEG_LENGTH_M, bodyMaterial);
  legPivotL.position.set(-SHOP_AVATAR_HIP_WIDTH_M, 0, SHOP_AVATAR_LEG_LENGTH_M);
  group.add(legPivotL);
  const legPivotR = limb(SHOP_AVATAR_LEG_RADIUS_M, SHOP_AVATAR_LEG_LENGTH_M, bodyMaterial);
  legPivotR.position.set(SHOP_AVATAR_HIP_WIDTH_M, 0, SHOP_AVATAR_LEG_LENGTH_M);
  group.add(legPivotR);

  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(SHOP_AVATAR_TORSO_RADIUS_M, SHOP_AVATAR_TORSO_LENGTH_M, 4, 8),
    bodyMaterial,
  );
  torso.rotation.x = Math.PI / 2;
  torso.position.z = SHOP_AVATAR_LEG_LENGTH_M + SHOP_AVATAR_TORSO_LENGTH_M / 2 + SHOP_AVATAR_TORSO_RADIUS_M;
  group.add(torso);

  const shoulderZ = SHOP_AVATAR_LEG_LENGTH_M + SHOP_AVATAR_TORSO_LENGTH_M + SHOP_AVATAR_TORSO_RADIUS_M * 0.6;
  const armPivotL = limb(SHOP_AVATAR_ARM_RADIUS_M, SHOP_AVATAR_ARM_LENGTH_M, bodyMaterial);
  armPivotL.position.set(-SHOP_AVATAR_SHOULDER_WIDTH_M, 0, shoulderZ);
  group.add(armPivotL);
  const armPivotR = limb(SHOP_AVATAR_ARM_RADIUS_M, SHOP_AVATAR_ARM_LENGTH_M, bodyMaterial);
  armPivotR.position.set(SHOP_AVATAR_SHOULDER_WIDTH_M, 0, shoulderZ);
  group.add(armPivotR);

  // Its own pivot (rather than a bare mesh straight on `group`, like the
  // torso) purely so the idle "look around" behavior (updateShopAvatarIdle)
  // can turn just the head about local Z without touching the rest of the
  // body.
  const headPivot = new THREE.Group();
  headPivot.position.z =
    SHOP_AVATAR_LEG_LENGTH_M + SHOP_AVATAR_TORSO_LENGTH_M + SHOP_AVATAR_TORSO_RADIUS_M * 2 + SHOP_AVATAR_HEAD_RADIUS_M;
  const head = new THREE.Mesh(new THREE.SphereGeometry(SHOP_AVATAR_HEAD_RADIUS_M, 16, 12), headMaterial);
  headPivot.add(head);

  // Face + hair (owner Control Room feedback: "give him a face and hair so
  // we can tell which is his front and which is his back") — the body was
  // otherwise fully symmetric front-to-back, so neither the walk cycle nor
  // the idle look-around ever needed to define which local axis was
  // "front" (see the sagittal-plane comment on `limb` above: rotating a
  // pivot about local X swings it through the Y-Z plane, so Y is the
  // forward/back axis — arbitrarily picking +Y as front here, since
  // nothing else in this file depended on a convention existing yet).
  // Both are simple offset/scaled spheres, matching this placeholder
  // avatar's existing "primitives only" style rather than needing any new
  // geometry.
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: 0x1a1a1a });
  const eyeRadius = SHOP_AVATAR_HEAD_RADIUS_M * 0.12;
  const eyeY = SHOP_AVATAR_HEAD_RADIUS_M * 0.85;
  const eyeZ = SHOP_AVATAR_HEAD_RADIUS_M * 0.1;
  const eyeSpacingX = SHOP_AVATAR_HEAD_RADIUS_M * 0.4;
  for (const sign of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(eyeRadius, 8, 6), eyeMaterial);
    eye.position.set(sign * eyeSpacingX, eyeY, eyeZ);
    head.add(eye);
  }
  // Owner (Control Room feedback): "more stylish hair... I don't want him
  // to be balding!" The original cap sat too far back and too flat (scale
  // 0.85/0.65, offset -0.25R/+0.3R) to reach the crown/hairline at all —
  // its own front edge stopped well short of the eyes (at y=+0.85R),
  // leaving the whole forehead-to-crown area bare skin-colored sphere from
  // straight on, which read as a receding hairline/bald spot rather than a
  // flat-cap silhouette. Pulled forward and enlarged so it now reaches
  // right up to the eye line at the front, still tapers off before the
  // back of the neck, and pokes very slightly above the head's own crown
  // (z max ~1.03R vs the head's 1R) for a bit of volume instead of a
  // shrink-wrapped skullcap.
  const hairMaterial = new THREE.MeshStandardMaterial({ color: 0x4a3626 });
  const hair = new THREE.Mesh(new THREE.SphereGeometry(SHOP_AVATAR_HEAD_RADIUS_M * 0.95, 12, 8), hairMaterial);
  hair.scale.set(1, 0.95, 0.75);
  hair.position.set(0, -SHOP_AVATAR_HEAD_RADIUS_M * 0.05, SHOP_AVATAR_HEAD_RADIUS_M * 0.32);
  head.add(hair);

  group.add(headPivot);

  // On `group` rather than `headPivot` so idle's own head-turn sway
  // (updateShopAvatarIdle) doesn't drag the badge along with it — a sprite
  // always faces the camera regardless of parent rotation anyway, but its
  // *position* still would inherit headPivot's yaw if parented there.
  // Starts invisible; updateShopAvatarIdle fades it in/out with SHOP_AFK_BLEND_PER_S.
  // #1587: shoulder-mounted (the right shoulder joint's own x/z, reused
  // from armPivotR's position just above) rather than floating above the
  // head on a sign-post.
  const afkSprite = makeAfkBadgeSprite();
  afkSprite.position.set(SHOP_AVATAR_SHOULDER_WIDTH_M * 1.15, 0, shoulderZ + SHOP_AVATAR_TORSO_RADIUS_M * 0.5);
  afkSprite.material.opacity = 0;
  group.add(afkSprite);

  // #1091: no real geometry to measure for the procedural default body —
  // collision/camera code falls back to the SHOP_AVATAR_* constants above
  // whenever these are null, exactly today's behavior.
  return { group, legPivotL, legPivotR, armPivotL, armPivotR, headPivot, afkSprite, modelUrl: null, measuredHeightM: null, measuredCollisionHalfM: null };
}

// #681 (sub-issue of #679/#680): the account's own equipped custom avatar
// model, loaded via the same loadModelInstance pipeline every placed
// product's real model already goes through (Y-up correction, recenter on
// bounding-box center). Returns the exact same shape createShopAvatar does
// so every existing walk/idle/pitch/position call site below keeps working
// completely unchanged — legPivotL/legPivotR/armPivotL/armPivotR/headPivot
// are real THREE.Group instances, just never attached to the visible scene
// graph, so rotating them for limb/head animation is a harmless no-op. That
// matches this issue's own scope: a custom avatar moves correctly as a
// rigid whole (root position/rotation on `group`), but per-bone limb
// animation on its own skeleton is #682's job, not this one's.
export async function createCustomShopAvatar(modelUrl, appliedAnimation = null) {
  // #982: lets an e2e test simulate a slow model load (a real network fetch
  // + GLTF parse can take a while) deterministically, without depending on
  // how long an actual fetch takes or on Playwright's own route-
  // interception timing (which was found to hold up unrelated same-origin
  // requests for as long as a route handler delays a response, making a
  // network-level delay here an unreliable way to construct this race in a
  // test). Always undefined outside of that one test.
  if (window.__testAvatarLoadDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, window.__testAvatarLoadDelayMs));
  }
  const container = await loadModelInstance(modelUrl);
  // loadModelInstance recenters the model on its own bounding-box center,
  // so (unlike the procedural avatar, whose local z=0 is already its feet)
  // this container's local origin sits at its vertical mid-point. Shifting
  // it up by half its own measured height puts its feet at z=0 instead,
  // matching shopAvatarPosition's own "feet position" contract — the same
  // ground-rest convention createMeshForInstance applies to every other
  // placed model, just measured from the real geometry here rather than a
  // catalog template's declared height (this endpoint doesn't return one).
  const box = new THREE.Box3().setFromObject(container);
  const height = Math.max(box.max.z - box.min.z, 0);
  container.position.z = height / 2;
  // #1091: real horizontal footprint (approximated as a square, same
  // SHOP_AVATAR_COLLISION_HALF_M convention as the default body) so
  // collision/camera code can scale to this specific model's own measured
  // size instead of always assuming the default body's proportions.
  const horizontalHalfM = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) / 2;

  const group = new THREE.Group();
  group.add(container);

  // #1587: shoulder-mounted rather than floating above the head. A custom
  // model has no known shoulder joint to anchor to (unlike the procedural
  // body above), so this approximates one from its measured bounding box:
  // roughly shoulder-height up the model's own height, offset to one side
  // by a fraction of its own horizontal footprint.
  const afkSprite = makeAfkBadgeSprite();
  afkSprite.position.set(horizontalHalfM * 0.6, 0, height * 0.82);
  afkSprite.material.opacity = 0;
  group.add(afkSprite);

  const legPivotL = new THREE.Group();
  const legPivotR = new THREE.Group();
  const armPivotL = new THREE.Group();
  const armPivotR = new THREE.Group();
  const headPivot = new THREE.Group();

  // #682: named idle/walk/fly clips, if the model carries any (see
  // docs/SPEC.md's "Avatar rig/animation clip convention"). mixer/actions
  // stay null when the model has none — setShopAvatarAnimationState below
  // already no-ops on a null actions map, so an avatar with no matching
  // clips still moves correctly as a rigid whole (today's #681 behavior),
  // it just never plays anything. Bound to container.userData.model (the
  // actual loaded node), not container itself, which is only a wrapper
  // this function added and was never part of the clip-authored hierarchy.
  //
  // #1165 (sub-issue of #1161, last piece): a purchased standalone
  // animation (#1163/#1164) *replaces* this set when one is applied and
  // compatible — appliedAnimation's own idle/walk/fly clips (loaded from
  // its own, separately-uploaded file) bind against this exact same
  // mixer/root, which works precisely because #1162's compatibility
  // signature guarantees the two files share the exact same bone names/
  // hierarchy: THREE.AnimationMixer resolves a clip's tracks by bone name
  // against whatever root it was constructed with, never by which file
  // originally parsed the clip. Falls back to this avatar's own clips —
  // the exact behavior above, unchanged — for an incompatible or absent
  // applied animation, which is this issue's own "sane fallback, don't
  // just break silently" requirement: switching to an avatar the
  // currently-applied animation no longer matches just quietly reverts to
  // that avatar's own clips (or none) rather than erroring, leaving the
  // animation's own `owned_animations`/equipped-choice untouched for next
  // time a compatible avatar is equipped again.
  const avatarSignature = await computeSkeletonSignature(modelUrl);
  const animationIsCompatible = !!appliedAnimation && !!avatarSignature && appliedAnimation.skeletonSignature === avatarSignature;
  const animations = animationIsCompatible
    ? await loadModelAnimations(appliedAnimation.modelUrl)
    : await loadModelAnimations(modelUrl);
  let mixer = null;
  let actions = null;
  if (animations.length > 0) {
    mixer = new THREE.AnimationMixer(container.userData.model);
    actions = {};
    for (const state of ['idle', 'walk', 'fly']) {
      const clip = THREE.AnimationClip.findByName(animations, state);
      if (clip) actions[state] = mixer.clipAction(clip);
    }
    if (Object.keys(actions).length === 0) { mixer = null; actions = null; }
  }

  return {
    group, legPivotL, legPivotR, armPivotL, armPivotR, headPivot, afkSprite, mixer, actions, animState: null, modelUrl,
    measuredHeightM: height, measuredCollisionHalfM: horizontalHalfM,
    // #1165: which file `actions` above was actually bound from, for the
    // same "nothing in the DOM reflects this" e2e-diagnostic reasoning
    // __shopAvatarModelUrl/__shopAvatarMetrics already use — null when
    // `actions` itself is null (no clips from either source).
    animationSource: !actions ? null : (animationIsCompatible ? 'applied' : 'own'),
  };
}

export let shopAvatar = null; // { group, legPivotL, legPivotR, armPivotL, armPivotR, headPivot, afkSprite, mixer, actions, animState, modelUrl, measuredHeightM, measuredCollisionHalfM } — see createShopAvatar/createCustomShopAvatar
// #2623: enterShopMode (src/main.js) reassigns shopAvatar directly (a
// fresh-load swap, not a per-frame mutation) -- an ES import binding is
// read-only from outside this module, so that reassignment goes through
// this setter instead, same shape src/world/state.js's own setActiveCatalog
// etc. already established for exactly this situation.
export function setShopAvatar(avatar) {
  shopAvatar = avatar;
}

// #1091: the currently-equipped avatar's own measured size when it's a
// custom model (measuredHeightM/measuredCollisionHalfM are null for the
// default procedural body, which has no real geometry to measure) — these
// fall back to the default body's own fixed SHOP_AVATAR_* constants
// whenever no avatar is loaded yet or the equipped one is the default.
export function shopAvatarCollisionHalfM() {
  return shopAvatar?.measuredCollisionHalfM ?? SHOP_AVATAR_COLLISION_HALF_M;
}
export function shopAvatarHeightM() {
  return shopAvatar?.measuredHeightM ?? SHOP_AVATAR_HEIGHT_M;
}
export function shopCameraAnchorHeightM() {
  return shopAvatar?.measuredHeightM != null
    ? shopAvatar.measuredHeightM * SHOP_CAMERA_ANCHOR_HEIGHT_RATIO
    : SHOP_CAMERA_ANCHOR_HEIGHT_M;
}

// #713 (sub-issue of #710): swaps the live Shop-mode avatar the instant the
// "My Avatars" settings picker equips a different one, so a builder standing
// in the world sees the change immediately rather than needing to leave and
// re-enter Shop mode. enterShopMode's own equipped-avatar fetch already
// covers every other entry path (a fresh Shop-mode entry always asks the
// server itself), so this only matters while currentMode is already 'shop'
// with a shopAvatar already built — a no-op otherwise, the same as equipping
// from Build/Sell just quietly taking effect next time Shop is entered.
// updateShopMovement drives group.position/rotation from shopAvatarPosition/
// shopAvatarFacing/shopAvatarPitch every frame regardless of which avatar
// instance is in the scene, so the swap itself needs no position handoff.
// #982: same out-of-order-resolution hazard as sellerShowcaseLoadToken/
// syncCreate/etc elsewhere in this file — a custom model's load (the
// `modelUrl` branch below) is a real network fetch + GLTF parse that can
// take a while, so an earlier Equip click can still be mid-flight when a
// later Equip click (e.g. the synchronous default-avatar branch) has
// already resolved and swapped shopAvatar. Without this guard, the earlier
// call would resume and silently overwrite the newer, correct equip.
let shopAvatarEquipToken = 0;
// #1165: called both when the "My Avatars" picker equips a different
// avatar (modelUrl changes, the applied animation doesn't) and when the
// new "My Animations" picker applies/clears an animation (modelUrl stays
// the same, re-fetched fresh here either way) — either trigger needs the
// exact same rebuild, since compatibility depends on both together.
export async function refreshEquippedShopAvatar(modelUrl) {
  if (currentMode !== 'shop' || !shopAvatar) return;
  const myToken = ++shopAvatarEquipToken;
  let appliedAnimation = null;
  try {
    const animation = await fetchMyEquippedAnimation();
    if (animation.equippedTemplateId) appliedAnimation = animation;
  } catch (err) {
    console.warn('Could not fetch applied animation, falling back to this avatar\'s own clips:', err);
  }
  if (myToken !== shopAvatarEquipToken) return; // a newer equip superseded this one while fetching
  let nextAvatar;
  if (modelUrl) {
    try {
      nextAvatar = await createCustomShopAvatar(modelUrl, appliedAnimation);
    } catch (err) {
      console.warn(`Failed to load newly-equipped avatar model (${modelUrl}), falling back to the default avatar:`, err);
      nextAvatar = createShopAvatar();
    }
  } else {
    nextAvatar = createShopAvatar();
  }
  if (myToken !== shopAvatarEquipToken) {
    // #1426: nextAvatar was already fully built (a real GLTF load, for the
    // custom-model branch) before this guard ever runs -- without disposing
    // it here, the superseded-but-already-built avatar's geometry/materials/
    // textures leak for the rest of the tab's lifetime, since nothing else
    // ever references it once this function returns.
    disposeObject3D(nextAvatar.group);
    // Nothing else observes this branch (nextAvatar is never added to the
    // scene, so it's never drawn and therefore never counted by
    // reportRendererMemoryDiagnostic's renderer.info.memory snapshot either)
    // -- exposed purely so an e2e test can confirm the dispose above actually
    // ran, the same reasoning as every other window.__test*-style hook in
    // this file.
    window.__supersededAvatarDisposals = (window.__supersededAvatarDisposals ?? 0) + 1;
    return;
  }
  scene.remove(shopAvatar.group);
  // #1358: the outgoing avatar's own meshes/materials are being discarded
  // either way (every call site that swaps or removes a group elsewhere in
  // this file disposes it the same way) — without this, every re-equip
  // leaks the previous avatar's geometry/material (and, for a custom GLTF
  // avatar, its textures) for the lifetime of the tab.
  disposeObject3D(shopAvatar.group);
  shopAvatar = nextAvatar;
  scene.add(shopAvatar.group);
  // Nothing in the DOM reflects which avatar is actually live-rendered
  // (the Settings picker only ever shows server truth) -- exposed here so
  // this exact race (#982) is observable from an e2e test.
  window.__shopAvatarModelUrl = shopAvatar.modelUrl;
  // #1091: same reasoning as __shopAvatarModelUrl above — nothing in the DOM
  // reflects the collision/camera sizing actually in effect for whichever
  // avatar just got equipped, so an e2e test can't otherwise tell a custom
  // model's real measured size got threaded through instead of the default
  // body's fixed constants.
  window.__shopAvatarMetrics = { heightM: shopAvatarHeightM(), collisionHalfM: shopAvatarCollisionHalfM(), cameraAnchorHeightM: shopCameraAnchorHeightM() };
  // #1165: same reasoning again — see createCustomShopAvatar's own
  // animationSource comment.
  window.__shopAvatarAnimationSource = shopAvatar.animationSource ?? null;
  await reportRendererMemoryDiagnostic();
}

let shopAvatarSwing = 0; // current eased swing amplitude (0 = standing still, see SHOP_AVATAR_SWING_AMPLITUDE_RAD)
let shopAvatarWalkPhase = 0;

// Idle sway state (docs/SPEC.md §2) — see updateShopAvatarIdle.
let shopIdleElapsedS = 0; // seconds since the last real movement input
let shopIdleBlend = 0; // 0..1 eased "how much idle sway is showing"
let shopAfkBlend = 0; // 0..1 eased "how visible the AFK label is" — see SHOP_AFK_DELAY_S
let shopIdleSwayPhase = 0;
// #2623: randomized in resetShopAvatarIdleState (called once main.js has
// finished loading), not here at module top level -- SHOP_IDLE_SWAY_PERIOD_
// MIN_S/MAX_S are reverse-imported from main.js, which hasn't evaluated its
// own top-level const declarations yet at the point this module's own
// top-level code runs during the circular import main.js -> this module ->
// main.js. Accessing them here would throw ("Cannot access ... before
// initialization"); 0 is a harmless placeholder until the first real reset.
let shopIdleSwayPeriodS = 0;
export let shopIdleSwayYawOffset = 0; // read by updateShopMovement to offset the avatar's own facing
let shopIdleHeadCurrentRad = 0;
let shopIdleHeadTargetRad = 0;
let shopIdleHeadTimerS = 0;
let shopIdleHeadIntervalS = 0; // see shopIdleSwayPeriodS's own comment just above -- same reason, same fix
// #2477 (sub-issue of #2475): the sit/lean target selected once per idle
// episode, the instant idle sway begins -- null until then, and reset to
// null the moment real movement resumes (re-armed for the next idle
// episode). Consumed by the (not yet built) sit/lean pose sub-issues;
// today's existing stand sway below runs unconditionally regardless of
// this value, matching #2477's own "fall back to stand sway unchanged"
// scope -- this sub-issue is selection only, not the pose itself.
export let shopIdleInteractionTarget = null;
// #2478 (sub-issue of #2475): how much of the seated pose is currently
// showing -- 0 whenever the selected interaction target (just above) isn't
// a 'sit' one (ordinary stand sway runs instead), eased toward 1 at the
// same SHOP_IDLE_BLEND_PER_S rate the stand sway above already uses, and
// hard-cut back to 0 the instant real input resumes — same ease-in-on-
// stillness/instant-ease-out-on-movement discipline as shopIdleBlend
// itself (a separate blend, not a reuse of shopIdleBlend, since idle sway
// still runs underneath a seated pose too — see updateShopAvatarIdle).
export let shopSitBlend = 0;
// Visual-only offsets layered on top of the avatar's own authoritative
// shopAvatarFacing/shopAvatarPosition at the point they're actually
// rendered (same additive convention shopIdleSwayYawOffset above already
// uses for yaw) -- so sitting never touches movement, collision,
// curvature, or camera-follow code, all of which key off the real
// shopAvatarFacing/shopAvatarPosition directly. Both are pure functions of
// shopSitBlend and the current idle target recomputed fresh each frame
// (see updateShopAvatarIdle), not independently-eased state of their own —
// the avatar doesn't move at all while idle, so there's nothing chasing a
// moving target to smooth out.
export let shopSitYawOffset = 0;
export let shopSitHeightOffset = 0;
// #2480 (sub-issue of #2475): randomized once per sit episode, the instant
// a 'sit' target is selected (same moment shopIdleInteractionTarget itself
// gets set) -- shopSitBlend stays suppressed at 0 until this many seconds
// of that same episode have elapsed, so the avatar doesn't always commit
// to sitting at the exact same instant idle sway begins; sometimes it
// lingers standing a bit first. Timing-side counterpart to the random
// target selection in findShopIdleInteractionTarget above. Lean (just
// below) gets the identical pattern applied to its own blend, per #2480's
// own "across repeated idle cycles" scope covering both poses equally.
const SHOP_SIT_SETTLE_DELAY_MIN_S = 0;
const SHOP_SIT_SETTLE_DELAY_MAX_S = 2;
// #2480: read by window.__testShopSitPose (main.js) to confirm the delay
// itself varies across repeated episodes.
export let shopSitSettleDelayS = 0;
export let shopSitSettleElapsedS = 0; // seconds of real idle time with a 'sit' target selected, this episode
// #2479 (sub-issue of #2475): same shape as #2478's own shopSitBlend/
// shopSitYawOffset/shopSitHeightOffset just above, for a 'lean' target
// instead of 'sit' -- a dedicated ease (not a reuse of shopIdleBlend) so
// ordinary idle sway keeps running underneath a lean too, and the same
// visual-only-offset discipline (never touches shopAvatarPosition/
// shopAvatarFacing/camera-follow/collision) for the same reason sit's own
// declaration gives. Unlike sit's height-only offset, leaning against a
// surface needs horizontal displacement too, so this carries a full x/y/z
// offset rather than just height.
export let shopLeanBlend = 0;
export let shopLeanYawOffset = 0;
export let shopLeanPositionOffset = { x: 0, y: 0, z: 0 };
// #2480: lean's own settle-delay counterpart to shopSitSettleDelayS/
// shopSitSettleElapsedS above -- identical pattern, separate state, since
// a sit episode and a lean episode are never the same episode (sit always
// outranks lean within one idle episode per findShopIdleInteractionTarget).
// #2480: read by window.__testShopLeanPose (main.js), same reasoning as
// shopSitSettleDelayS/shopSitSettleElapsedS above.
export let shopLeanSettleDelayS = 0;
export let shopLeanSettleElapsedS = 0; // seconds of real idle time with a 'lean' target selected, this episode

// Swing amplitude eases toward its target (moving vs. standing still)
// rather than snapping, so stopping doesn't visibly freeze the legs
// mid-stride — and phase only advances while actually moving, so a full
// stop always eases back toward a neutral standing pose rather than
// leaving a limb stuck part-swung. moveMagnitude (0..1, the move
// joystick's own deflection) scales both the eased-toward amplitude and
// how fast the cycle advances, the same walk-slower/run-faster feel
// SHOP_WALK_SPEED_M_S..SHOP_RUN_SPEED_M_S already gives actual ground speed.
export function updateShopAvatarPose(moveMagnitude, dt) {
  const targetSwing = SHOP_AVATAR_SWING_AMPLITUDE_RAD * moveMagnitude;
  shopAvatarSwing += (targetSwing - shopAvatarSwing) * Math.min(1, SHOP_AVATAR_SWING_EASE_PER_S * dt);
  shopAvatarWalkPhase += SHOP_AVATAR_CYCLE_SPEED_RAD_S * moveMagnitude * dt;

  const swing = Math.sin(shopAvatarWalkPhase) * shopAvatarSwing;
  shopAvatar.legPivotL.rotation.x = swing;
  shopAvatar.legPivotR.rotation.x = -swing;
  // Arms swing opposite their same-side leg (left arm forward with right
  // leg forward) — a real walk's natural counter-swing — at a gentler
  // amplitude than the legs.
  shopAvatar.armPivotL.rotation.x = -swing * 0.7;
  shopAvatar.armPivotR.rotation.x = swing * 0.7;
}

// #682: crossfades a custom avatar's AnimationMixer from whichever named
// clip (idle/walk/fly) was playing to `state`'s own, driven by the exact
// same airborne/moveMagnitude locomotion state updateShopAvatarPose's own
// root-motion pose already reflects — so a model with matching clips
// plays them in sync with its procedural root movement, not just
// alongside it. No-ops entirely for the default procedural avatar (no
// `actions` at all) and for a custom avatar missing every one of the
// three clips (`actions` null, per createCustomShopAvatar's own comment)
// — either way it just keeps moving as a rigid whole via root motion,
// same as before this clip convention existed. Missing only SOME clips
// (e.g. idle+walk but no fly) is handled per-transition below: fading out
// whatever was playing still happens, but fading in only happens if the
// new state actually has a clip, so at worst a still frame holds where a
// missing clip's action would have taken over — deliberately not falling
// back to a different state's own clip in that gap, since a fly-less
// avatar suddenly still doing its walk-cycle mid-air would read as more
// broken, not less.
export function setShopAvatarAnimationState(shopAvatar, state) {
  if (!shopAvatar.actions || shopAvatar.animState === state) return;
  const previousAction = shopAvatar.actions[shopAvatar.animState];
  if (previousAction) previousAction.fadeOut(SHOP_AVATAR_ANIM_CROSSFADE_S);
  const nextAction = shopAvatar.actions[state];
  if (nextAction) nextAction.reset().fadeIn(SHOP_AVATAR_ANIM_CROSSFADE_S).play();
  shopAvatar.animState = state;
}

// docs/SPEC.md §2: "context-aware idle state machine ... after inactivity,
// with randomization." This pass only covers "stand" — a subtle whole-body
// weight-shift sway plus an occasional head turn, both re-randomized on
// their own cycle so idle never visibly repeats the same motion twice in a
// row. "Sit"/"lean" need a real interaction-target system (e.g. a chair
// prop with an occupancy slot) that doesn't exist yet — future work.
//
// Called every frame right after updateShopAvatarPose, whose walk-cycle
// arm rotations it adds on top of (already ~0 by the time idle sway is
// actually visible, since walking and idling are mutually exclusive in
// practice — see hasActiveInput below). Ends the instant real input
// resumes (a hard cut, not an ease-out) — a lingering idle sway would read
// as the avatar fighting the player's own input.
//
// #1586: hasActiveInput is "any real input," not just movement — an
// active look-only joystick/mouse-drag used to be invisible here (this
// used to take moveMagnitude alone), so a shopper who was only looking
// around still got timed out to AFK despite being clearly at the
// controls. moveMagnitude itself is no longer needed by this function;
// the walk-cycle pose that actually depends on it lives in
// updateShopAvatarPose instead.
export function updateShopAvatarIdle(hasActiveInput, dt) {
  if (hasActiveInput) {
    shopIdleElapsedS = 0;
    shopIdleBlend = 0;
    shopAfkBlend = 0;
    shopIdleInteractionTarget = null; // re-arm (#2477) for the next idle episode
    shopSitBlend = 0; // #2478: instant ease-out, same as shopIdleBlend/shopAfkBlend just above
    shopSitYawOffset = 0;
    shopSitHeightOffset = 0;
    shopSitSettleElapsedS = 0; // #2480: re-armed for the next sit episode's own randomized delay
    shopLeanBlend = 0; // #2479: same instant ease-out, mirroring sit's own just above
    shopLeanYawOffset = 0;
    shopLeanPositionOffset = { x: 0, y: 0, z: 0 };
    shopLeanSettleElapsedS = 0; // #2480: re-armed for the next lean episode's own randomized delay
  } else {
    // #2477: fires exactly once per idle episode, the instant elapsed time
    // first crosses SHOP_IDLE_DELAY_S -- not every frame afterward, since
    // shopIdleElapsedS keeps growing past that threshold for as long as
    // the avatar stays idle.
    const wasIdle = shopIdleElapsedS >= SHOP_IDLE_DELAY_S;
    shopIdleElapsedS += dt;
    const idleTarget = shopIdleElapsedS >= SHOP_IDLE_DELAY_S ? 1 : 0;
    if (!wasIdle && idleTarget === 1) {
      shopIdleInteractionTarget = findShopIdleInteractionTarget(shopAvatarPosition.x, shopAvatarPosition.y);
      // #2480: re-randomized every time a fresh episode selects a new sit
      // or lean target (including re-selecting the same one next time
      // around) — see shopSitSettleDelayS's own declaration for why. Both
      // get randomized here regardless of which kind was actually
      // selected (the unused one's delay just sits idle until its own
      // kind is picked in some future episode) — simpler than branching
      // on kind here, and harmless since each only ever gates its own
      // blend below.
      shopSitSettleDelayS = THREE.MathUtils.randFloat(SHOP_SIT_SETTLE_DELAY_MIN_S, SHOP_SIT_SETTLE_DELAY_MAX_S);
      shopSitSettleElapsedS = 0;
      shopLeanSettleDelayS = THREE.MathUtils.randFloat(SHOP_SIT_SETTLE_DELAY_MIN_S, SHOP_SIT_SETTLE_DELAY_MAX_S);
      shopLeanSettleElapsedS = 0;
    }
    shopIdleBlend += (idleTarget - shopIdleBlend) * Math.min(1, SHOP_IDLE_BLEND_PER_S * dt);
    const afkTarget = shopIdleElapsedS >= SHOP_AFK_DELAY_S ? 1 : 0;
    shopAfkBlend += (afkTarget - shopAfkBlend) * Math.min(1, SHOP_AFK_BLEND_PER_S * dt);

    // #2478/#2480: eases in only once this idle episode's own selected
    // target (above) is a sit one *and* its own randomized settle delay
    // has elapsed — stays at 0, same as always, for a lean target, no
    // target, or a sit target still within its settle delay (ordinary
    // stand sway keeps running regardless, same "fall back to stand sway
    // unchanged" scope #2477 already cut).
    if (shopIdleInteractionTarget?.kind === 'sit') shopSitSettleElapsedS += dt;
    const sitTarget =
      shopIdleInteractionTarget?.kind === 'sit' && shopSitSettleElapsedS >= shopSitSettleDelayS ? 1 : 0;
    shopSitBlend += (sitTarget - shopSitBlend) * Math.min(1, SHOP_IDLE_BLEND_PER_S * dt);
    if (shopIdleInteractionTarget?.kind === 'sit') {
      // Hip height (local z = SHOP_AVATAR_LEG_LENGTH_M above the group's
      // own origin, same convention createShopAvatar's own comment
      // documents) needs to land exactly on the target's own worldZ (the
      // seat surface, already the right height for *hips*, not feet — see
      // findShopIdleInteractionTarget's own heightM comment) once fully
      // blended in; solving that backwards for the group-position offset
      // this adds on top of the real (unmoved) shopAvatarPosition.z gives
      // this term, same shape regardless of whether the seat sits above or
      // below standing hip height.
      shopSitHeightOffset =
        (shopIdleInteractionTarget.worldZ - SHOP_AVATAR_LEG_LENGTH_M - shopAvatarPosition.z) * shopSitBlend;
      // Shortest-angle delta so turning to face a target behind the
      // avatar doesn't spin the long way around — same atan2-of-sin/cos
      // idiom the real facing turn above (shopAvatarFacing) already uses.
      const yawDelta = Math.atan2(
        Math.sin(shopIdleInteractionTarget.worldFacingRad - shopAvatarFacing),
        Math.cos(shopIdleInteractionTarget.worldFacingRad - shopAvatarFacing),
      );
      shopSitYawOffset = yawDelta * shopSitBlend;
    } else {
      shopSitHeightOffset = 0;
      shopSitYawOffset = 0;
    }

    // #2479/#2480: same shape as #2478's sit block just above, for a
    // 'lean' target -- eases in only once this idle episode's own
    // selected target is a lean one *and* its own randomized settle
    // delay has elapsed (sit always outranks lean within the same
    // episode per findShopIdleInteractionTarget, so these two blends are
    // never both nonzero at once). Visual-only offset recomputed fresh
    // each frame as a pure function of shopLeanBlend and the current
    // target, same reasoning shopSitYawOffset/shopSitHeightOffset's own
    // declaration gives -- never touches shopAvatarPosition/
    // shopAvatarFacing, so leaning never affects movement, collision,
    // curvature, or camera-follow code either.
    if (shopIdleInteractionTarget?.kind === 'lean') shopLeanSettleElapsedS += dt;
    const leanTarget =
      shopIdleInteractionTarget?.kind === 'lean' && shopLeanSettleElapsedS >= shopLeanSettleDelayS ? 1 : 0;
    shopLeanBlend += (leanTarget - shopLeanBlend) * Math.min(1, SHOP_IDLE_BLEND_PER_S * dt);
    if (shopIdleInteractionTarget?.kind === 'lean') {
      shopLeanPositionOffset = {
        x: (shopIdleInteractionTarget.worldX - shopAvatarPosition.x) * shopLeanBlend,
        y: (shopIdleInteractionTarget.worldY - shopAvatarPosition.y) * shopLeanBlend,
        z: (shopIdleInteractionTarget.worldZ - shopAvatarPosition.z) * shopLeanBlend,
      };
      const leanYawDelta = Math.atan2(
        Math.sin(shopIdleInteractionTarget.worldFacingRad - shopAvatarFacing),
        Math.cos(shopIdleInteractionTarget.worldFacingRad - shopAvatarFacing),
      );
      shopLeanYawOffset = leanYawDelta * shopLeanBlend;
    } else {
      shopLeanPositionOffset = { x: 0, y: 0, z: 0 };
      shopLeanYawOffset = 0;
    }
  }
  shopAvatar.afkSprite.material.opacity = shopAfkBlend;

  shopIdleSwayPhase += (dt / shopIdleSwayPeriodS) * Math.PI * 2;
  if (shopIdleSwayPhase >= Math.PI * 2) {
    shopIdleSwayPhase -= Math.PI * 2;
    shopIdleSwayPeriodS = THREE.MathUtils.randFloat(SHOP_IDLE_SWAY_PERIOD_MIN_S, SHOP_IDLE_SWAY_PERIOD_MAX_S);
  }
  shopIdleHeadTimerS += dt;
  if (shopIdleHeadTimerS >= shopIdleHeadIntervalS) {
    shopIdleHeadTimerS = 0;
    shopIdleHeadIntervalS = THREE.MathUtils.randFloat(SHOP_IDLE_HEAD_TURN_INTERVAL_MIN_S, SHOP_IDLE_HEAD_TURN_INTERVAL_MAX_S);
    shopIdleHeadTargetRad = THREE.MathUtils.randFloatSpread(SHOP_IDLE_HEAD_TURN_MAX_RAD * 2);
  }
  shopIdleHeadCurrentRad +=
    (shopIdleHeadTargetRad * shopIdleBlend - shopIdleHeadCurrentRad) * Math.min(1, SHOP_IDLE_HEAD_TURN_EASE_PER_S * dt);

  shopIdleSwayYawOffset = Math.sin(shopIdleSwayPhase) * SHOP_IDLE_SWAY_AMPLITUDE_RAD * shopIdleBlend;
  const armIdleSway = Math.sin(shopIdleSwayPhase * 0.5) * SHOP_IDLE_ARM_SWAY_AMPLITUDE_RAD * shopIdleBlend;
  shopAvatar.armPivotL.rotation.x += armIdleSway;
  shopAvatar.armPivotR.rotation.x -= armIdleSway;
  shopAvatar.headPivot.rotation.z = shopIdleHeadCurrentRad;

  // #2478: layered on top of the counter-swing arm sway and the (always
  // ~0 while idle) walk-cycle leg rotation just above/in updateShopAvatarPose
  // — both pivots turn the same direction (unlike the arms' own idle
  // counter-sway) since a seated silhouette has both legs/arms forward
  // together, not alternating.
  shopAvatar.legPivotL.rotation.x += SHOP_SIT_LEG_ROTATION_RAD * shopSitBlend;
  shopAvatar.legPivotR.rotation.x += SHOP_SIT_LEG_ROTATION_RAD * shopSitBlend;
  shopAvatar.armPivotL.rotation.x += SHOP_SIT_ARM_ROTATION_RAD * shopSitBlend;
  shopAvatar.armPivotR.rotation.x += SHOP_SIT_ARM_ROTATION_RAD * shopSitBlend;
}

// #2623: shopIdleSwayYawOffset is reassigned from outside this module (the
// item-handling-blend code in main.js, which layers its own turn/spin on
// top via `+=`) -- a setter, same reasoning as setShopAvatar above, since
// a plain import binding can't be written to from outside its own module.
export function addShopIdleSwayYawOffset(delta) {
  shopIdleSwayYawOffset += delta;
}

// #2629 (enterShopMode, src/main.js) calls this once on every fresh Shop-
// mode entry to zero out every idle/sway/sit/lean field this module owns --
// the exact same reset enterShopMode's own inline block already did before
// this state lived in a separate module (reassigning an imported binding
// isn't possible from outside, so that block moved here as one call
// instead of a dozen individual setters). Also re-rolls shopIdleSwayPeriodS/
// shopIdleHeadIntervalS -- see their own top-level declaration comment for
// why they're left at a placeholder 0 until the first call here (by which
// point main.js has long finished evaluating, so the circular-import
// hazard no longer applies) rather than randomized at module load.
export function resetShopAvatarIdleState() {
  shopAvatarSwing = 0;
  shopAvatarWalkPhase = 0;
  shopIdleElapsedS = 0;
  shopIdleBlend = 0;
  shopAfkBlend = 0;
  shopIdleSwayPhase = 0;
  shopIdleSwayPeriodS = THREE.MathUtils.randFloat(SHOP_IDLE_SWAY_PERIOD_MIN_S, SHOP_IDLE_SWAY_PERIOD_MAX_S);
  shopIdleSwayYawOffset = 0;
  shopIdleHeadCurrentRad = 0;
  shopIdleHeadTargetRad = 0;
  shopIdleHeadTimerS = 0;
  shopIdleHeadIntervalS = THREE.MathUtils.randFloat(SHOP_IDLE_HEAD_TURN_INTERVAL_MIN_S, SHOP_IDLE_HEAD_TURN_INTERVAL_MAX_S);
  shopIdleInteractionTarget = null;
  shopSitBlend = 0;
  shopSitYawOffset = 0;
  shopSitHeightOffset = 0;
  shopSitSettleDelayS = 0;
  shopSitSettleElapsedS = 0;
  shopLeanBlend = 0;
  shopLeanYawOffset = 0;
  shopLeanPositionOffset = { x: 0, y: 0, z: 0 };
  shopLeanSettleDelayS = 0;
  shopLeanSettleElapsedS = 0;
}

// #1495: reports whether any material on the current shop avatar is still
// flagged transparent -- used to confirm setShopAvatarOpacity's "Go to Last
// Location" fade sequence actually restores this when it completes, rather
// than leaving it stuck true. Always inert (read-only), same convention as
// the other window.__test* hooks in this file.
window.__testShopAvatarHasTransparentMaterial = () => {
  let found = false;
  shopAvatar.group.traverse((object) => {
    if (object === shopAvatar.afkSprite || !object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (materials.some((material) => material.transparent)) found = true;
  });
  return found;
};
