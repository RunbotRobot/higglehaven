// #2624 (leaf of #2563, itself part of #2504/#2500's src/main.js module
// split -- see #2503's design comment and #2563's own breakdown comment
// for the full dependency map): Shop mode's flight physics, free-look/
// third-person camera, collision movement, sustained-attention tracking,
// and item-handling pose -- the per-frame orchestrator (updateShopMovement)
// that ties all of it together each frame, plus the spawn-orbit and
// "Go to Last Location" sequences layered on top of flight state.
// Depends on the shop/avatar.js leaf (#2623) having landed first --
// updateShopMovement calls into updateShopAvatarPose/
// setShopAvatarAnimationState/updateShopAvatarIdle, and several functions
// here read shopAvatarCollisionHalfM/shopAvatarHeightM.
//
// Not contiguous in main.js -- was interleaved with the shop/sky.js leaf's
// own functions (e.g. clampShopCameraHeight sat right after
// growShopDomeIfNeeded there, before #2625 moved it out) and with several
// other not-yet-extracted concerns (world-content/shopLandlets, presence/
// shopOtherAvatars, signs/calendars/credit-orbs/reviews). Each function
// below was traced individually against main.js's full usage, not assumed
// contiguous.
//
// shopDomeRiseM (owned by the shop/sky.js leaf, #2625) is read directly by
// clampShopCameraHeight/shopMaxRadiusAtWorldZM/shopMaxFlightAltitudeM/
// positionShopCamera -- per #2563's own design-comment finding, this
// cross-coupling is preserved exactly as it exists today via a (now
// sibling-module, not reverse-) import, not copied. shopWorldRadiusM/
// shopDomeMesh stay owned by main.js (reverse-imported, same as before).
// Likewise shopLandlets (world-content), shopOtherAvatars (presence), shopActive
// (general Shop-mode-active flag), and shopLastLocation (presence-fetched,
// written only by enterShopMode's own async fetch) all stay in main.js,
// reverse-imported read-only -- none of this leaf's functions ever write
// them. shopAvatarPosition/shopAvatarFacing also stay in main.js (same
// precedent shop/avatar.js's own header comment already documents) --
// shopAvatarPosition is mutated in place (no setter needed, same object
// reference throughout), but shopAvatarFacing is a primitive reassigned in
// several places here, so main.js exports a setShopAvatarFacing setter
// alongside the live read-only binding.
//
// window.__testTeleportShopAvatar/__testShopFlightState move here too (not
// explicitly named in #2624's own issue body, but both read/write this
// leaf's own flight state directly, and shop/avatar.js's header comment
// already flagged them as this leaf's to claim). window.__testShopAvatarPosition/
// __testForceShopProximityCheck/__testShopInstanceLodBand/HitSource/
// __rescaleModelFileForTests/__optimizeModelFileForTests stay in main.js --
// each either reads only main.js's own already-exported state, or (the
// proximity-check hook) just needs a forward import of positionShopCamera.
//
// beginShopSpawn is new -- not a straight move. enterShopMode's own spawn
// sequence used to assign ~15 of this leaf's now-private state fields
// directly (shopYaw, shopSpawnOrbitRadiusM, shopFlightState, etc.), which
// an ES import binding can't do from outside this module. Bundling that
// reset into one exported function mirrors shop/avatar.js's own
// resetShopAvatarIdleState() precedent for the identical problem.
import * as THREE from 'three';
import { camera, renderer } from '../world/scene.js';
import { curvatureDropM } from '../../worker/earthCurvature.js';
import { takeoffAltitudeM, clampedLandingAltitudeM, flightSpeedMultiplier } from '../flight.js';
import { attentionDistanceAndDot, hasSustainedAttention, nextAttentionElapsedS, pickNearestInRange, yawRotatedForward } from '../attention.js';
import { classifyHandlingKind, nextHandlingBlend, nextPhase, shouldEndItemHandling } from '../itemHandling.js';
import { meshDimensions, isFlooringTemplate } from '../world/models.js';
import { footprintsOverlap, footprintCorners } from '../build/scene.js';
import {
  shopAvatar, shopAvatarCollisionHalfM, shopAvatarHeightM, shopCameraAnchorHeightM,
  updateShopAvatarPose, setShopAvatarAnimationState, updateShopAvatarIdle,
  addShopIdleSwayYawOffset, shopIdleSwayYawOffset,
  shopSitYawOffset, shopSitHeightOffset, shopLeanBlend, shopLeanYawOffset, shopLeanPositionOffset,
} from './avatar.js';
import {
  shopAvatarPosition, shopAvatarFacing, setShopAvatarFacing,
  shopActive, shopLastLocation,
  shopWorldRadiusM, shopDomeMesh, SHOP_MAX_PITCH,
  SHOP_WALL_HEIGHT_M, SHOP_DOME_CLEARANCE_MARGIN_M,
  SHOP_AVATAR_COLLISION_HALF_M, SHOP_AVATAR_HEAD_RADIUS_M, SHOP_AVATAR_TORSO_LENGTH_M,
  shopFlyBtn, shopFlyBtnIcon, shopLastLocationBtn, shopVerticalControlsEl,
  shopUpBtn, shopDownBtn, shopMoveJoystickEl, shopMoveKnobEl, shopLookJoystickEl, shopLookKnobEl,
} from '../main.js';
// #2628: updateConfettiBursts now lives in src/shop/productCheckout.js.
import { updateConfettiBursts } from './productCheckout.js';
// #2625: shopDomeRiseM now lives in ./sky.js (this leaf's own
// clampShopCameraHeight/updateShopFlight/shopAvatarFootprintCorners read
// it directly — a plain exported `let` binding is a live reference, so a
// read-only consumer needs nothing more than importing it by name).
import { shopDomeRiseM } from './sky.js';
// #2626: Shop mode's proximity-driven landlet loading, multiplayer
// presence, and credit orbs now live in src/shop/presenceAndContent.js --
// see that module's own comment for its dependency notes.
import {
  shopLandlets, shopOtherAvatars, shopCurrentLandletEntry,
  reportOwnPresenceIfNeeded, pollNearbyPresenceIfNeeded, updateOtherShopAvatars,
  updateCreditOrbs, updateCreditOrbPopEffects,
  updateShopProximity, updateShopLandletInfo,
} from './presenceAndContent.js';
// #2779 (sub-issue of #2777): nearby-avatars-only text chat, a fully
// self-contained leaf with no main.js/presenceAndContent.js legacy to
// respect -- see that module's own header comment.
import { pollNearbyChatIfNeeded } from './nearbyChat.js';
import { updateShopVoiceChatIfNeeded } from './voiceChat.js';
// #2627: the sign/calendar/review sprite fade loops and the scheduled-
// calendar-event trigger check now live in src/shop/worldSprites.js.
import { updateSignFade, updateCalendarFade, updateReviewFade, checkScheduledCalendarEvents } from './worldSprites.js';

// docs/SPEC.md §2's confirmed ground speeds: 1.8 m/s walking, 4.4704 m/s
// (10 mph, v17 — raised from 2.7 m/s/~6 mph, which the owner found still
// read as a slow walk against a measured brick wall; "feels right" over
// "is realistic") running. There's no separate run input (a run key/button)
// — the move joystick's own deflection doubles as intensity, so pushing it
// all the way out runs and a gentle nudge walks, the same analog feel a
// real joystick gamepad gives a run.
const SHOP_WALK_SPEED_M_S = 1.8;
const SHOP_RUN_SPEED_M_S = 4.4704; // docs/SPEC.md §2 (v17): 10 mph
const SHOP_LOOK_SPEED_RAD_S = 1.8;
const SHOP_MIN_HEIGHT_M = 1.5;

// Flight (docs/SPEC.md §2) — see updateShopFlight/bindShopFlyToggle.
// "Occupied landing spots offset to nearest open space" is now built
// (#2044, nearestOpenLandingSpot below) now that real multiplayer presence
// (#1095) gives it another avatar to actually collide with. "Flying
// avatars are invisible to other users" is still deliberately not built
// here — a separate, still-open gap (#2043) about *other* players seeing
// you, which takeoff/landing's own plain altitude ramps (no fade) don't
// address.
const SHOP_FLIGHT_TAKEOFF_DURATION_S = 1; // spec's "~1s lift"
const SHOP_FLIGHT_LANDING_DURATION_S = 2; // spec's "~2s reverse"
const SHOP_FLIGHT_HOVER_START_ALTITUDE_M = 3; // altitude reached at the end of takeoff, before the player climbs further
const SHOP_FLIGHT_VERTICAL_SPEED_M_S = 8; // ascend/descend rate once actually flying (the up/down buttons)
const SHOP_FLIGHT_DOUBLE_PRESS_WINDOW_MS = 400;

// docs/SPEC.md §1/§2 (#1175): every Shop-mode spawn (not just a first-ever
// visit) starts zoomed-out in flight mode above the world — see
// enterShopMode's own spawn block. Below the initial flight ceiling
// (SHOP_WALL_HEIGHT_M + SHOP_DOME_INITIAL_RISE_M - SHOP_DOME_CLEARANCE_
// MARGIN_M = 115 at launch) with real clearance to spare, comfortably above
// "building height" (SHOP_FLIGHT_SPEED_REF_ALTITUDE_M, 10) so the view
// actually reads as "above the world," not just a slightly-elevated hover.
const SHOP_SPAWN_START_ALTITUDE_M = 80;

// #1175: the clockwise orbit around the world center that every spawn
// starts in, until the shopper gives any navigation input (see
// updateShopSpawnRotation/stopShopSpawnRotation). "Slowly" per the spec —
// a full revolution takes a couple of minutes, plenty of time to take in
// the view before (or without ever) touching a control.
const SHOP_SPAWN_ORBIT_ANGULAR_SPEED_RAD_S = 0.05;

// #1176 (owner, live Control Room conversation): the button disappears
// "automatically five seconds after the shopper begins navigating on their
// own" — i.e. ignores the rotating spawn view and starts moving/flying
// themselves instead, as opposed to tapping the button itself (which hides
// it immediately, no countdown — see startGoToLastLocation).
const SHOP_LAST_LOCATION_BUTTON_HIDE_DELAY_S = 5;

// #1176: how long the avatar takes to fade out before it's teleported
// above the last location, and again to fade back in once there — two
// separate fades, each this long, not one round trip of this total length.
const SHOP_LAST_LOCATION_AVATAR_FADE_S = 0.6;

// Speed-vs-altitude curve: spec's own two data points — "~10x walking
// speed near building-height" and "up to ~100x at max altitude" — plus its
// governing rule, "each doubling of altitude ≈ 50% more max ground speed."
// That rule alone fixes the curve's shape as a power law (speed ∝
// altitude^p) with p = log2(1.5) ≈ 0.585 (a whole doubling of the input
// giving exactly a 1.5x — not 2x — output is the definition of that
// exponent). Anchoring it at "~10x at building height" (SHOP_FLIGHT_
// SPEED_REF_ALTITUDE_M/MULTIPLIER below) and solving for where it reaches
// 100x lands at ~500m — the spec's own max-altitude figure — which is a
// strong confirmation this is the curve the spec's numbers actually
// describe, not just a guess fitted after the fact.
const SHOP_FLIGHT_SPEED_EXPONENT = Math.log2(1.5);
const SHOP_FLIGHT_SPEED_REF_ALTITUDE_M = 10; // "building height"
const SHOP_FLIGHT_SPEED_REF_MULTIPLIER = 10;
const SHOP_FLIGHT_MIN_SPEED_MULTIPLIER = 1; // just after takeoff, before climbing
const SHOP_FLIGHT_MAX_SPEED_MULTIPLIER = 100; // spec's "up to ~100x at max altitude"

// How fast the avatar's body turns to face its own movement direction
// (see updateShopMovement) — high enough to read as responsive, not
// instant, similar to every other "ease toward a target per second"
// treatment in this file (e.g. SHOP_AVATAR_SWING_EASE_PER_S).
const SHOP_AVATAR_TURN_EASE_PER_S = 12;
// #1588: opt-in setting — when on, free-look (shopYaw) eases back toward
// the avatar's own facing (shopAvatarFacing) whenever the shopper isn't
// actively steering the right stick, instead of the two staying fully
// independent forever. Deliberately much slower than
// SHOP_AVATAR_TURN_EASE_PER_S's near-instant body turn: the owner's own
// requirement was that this read as a smooth re-center (Dysmantle cited
// as the UX precedent), never a snap.
const SHOP_CAMERA_LOCK_TO_FACING_KEY = 'higglehaven.shopCameraLockToFacing';
const SHOP_CAMERA_LOCK_TO_FACING_EASE_PER_S = 3;

export function getShopCameraLockToFacing() {
  return localStorage.getItem(SHOP_CAMERA_LOCK_TO_FACING_KEY) === '1';
}

export function setShopCameraLockToFacing(enabled) {
  localStorage.setItem(SHOP_CAMERA_LOCK_TO_FACING_KEY, enabled ? '1' : '0');
}

// A fixed-radius orbit around that anchor (`positionShopCamera` below) — the
// classic over-the-shoulder third-person rig: subtracting the look
// direction from the anchor means looking down swings the camera up and
// back, looking up swings it down and in, all without a separate
// "collision" pass (clampShopCameraHeight/the wall-radius clamp still catch
// the rare pose that would otherwise dip the camera underground or past the
// world wall — see updateShopMovement).
const SHOP_CAMERA_FOLLOW_DISTANCE_M = 4.2;

// Owner (Control Room, N46): flying should tip the avatar into a
// Superman-style posture instead of staying upright — nose (head) forward
// and down. Composed as a quaternion in the main per-frame update — yaw
// (world Z, the avatar's current heading) applied first, then pitch around
// the local left-right axis that yaw just established — so the tilt leans
// toward wherever the avatar is actually facing, same as a real flight rig
// would compose it. First shipped at ~80deg (near-horizontal); owner
// follow-up (2026-09-12) asked for 45deg, "halfway between vertical and
// horizontal," instead.
//
// #1168: this used to be set as independent Euler fields
// (`group.rotation.x = pitch; group.rotation.z = yaw;`) — intending
// exactly the composition described above, but Euler fields on the same
// object don't compose that way. THREE's default 'XYZ' Euler order builds
// the rotation matrix as Rx * Ry * Rz applied to a vector (see
// applyShopCameraOrientation's own SHOP_BASE_QUAT comment above for the
// same "which axis is actually local after a prior rotation" trap), which
// pitches around a fixed world axis with yaw rotated separately underneath
// it — not pitch-in-the-frame-yaw-just-produced. The owner's bug report
// matched exactly: the tilt always leaned the same way regardless of which
// direction the avatar was flying. Two intrinsic (body-frame) rotations
// applied in sequence — yaw first, pitch second — compose as
// `yawQuat.multiply(pitchQuat)` (yaw written first/outermost since it's
// applied first, pitch second/innermost since it happens in the frame yaw
// already established), not `pitchQuat.multiply(yawQuat)`.
const SHOP_AVATAR_FLIGHT_PITCH_RAD = -(45 * Math.PI) / 180;
// Matches the plain rotation.z/rotation.x axes the old Euler-based code
// used (world Z for yaw, since this is a Z-up world; local X for pitch,
// the same left-right hinge every limb's walk-cycle swing already rotates
// around) — no base-quat reorientation needed here the way
// applyShopCameraOrientation's SHOP_BASE_QUAT needs one, since the avatar
// model's own rest pose already faces correctly along these axes with no
// rotation applied, unlike the camera's default -Z-forward/Y-up convention.
const SHOP_AVATAR_YAW_AXIS = new THREE.Vector3(0, 0, 1);
const SHOP_AVATAR_PITCH_AXIS = new THREE.Vector3(1, 0, 0);
// Reused across frames rather than allocated fresh each one — same
// reasoning as every other scratch object in this file (e.g.
// scratchAttentionWorldPos above).
const scratchAvatarYawQuat = new THREE.Quaternion();
const scratchAvatarPitchQuat = new THREE.Quaternion();
// Eases shopAvatarPitch toward the target above (or back to 0 on landing)
// each frame — same idea as SHOP_AVATAR_SWING_EASE_PER_S, tuned to settle
// over roughly the same ~1s span as SHOP_FLIGHT_TAKEOFF_DURATION_S so the
// tilt reads as part of the same takeoff motion rather than snapping in
// separately once altitude ramp-up finishes.
const SHOP_AVATAR_FLIGHT_PITCH_EASE_PER_S = 5;
// #682: the named clips (idle/walk/fly, docs/SPEC.md's own "Avatar rig/
// animation clip convention") a custom avatar model's own AnimationMixer
// crossfades between as the locomotion state below changes — see
// setShopAvatarAnimationState. Same moveMagnitude threshold style as the
// walk/run blend just above; below it reads as "not really moving" for
// clip-switching purposes even though the procedural walk-cycle itself
// (SHOP_AVATAR_SWING_AMPLITUDE_RAD) already scales continuously to zero.
const SHOP_AVATAR_ANIM_WALK_THRESHOLD = 0.05;

// #2479 (sub-issue of #2475): lean pose -- how far the whole body tilts
// back against a leanTarget's surface at full idle blend. Same local-X
// axis/eased-toward-a-target idiom as SHOP_AVATAR_FLIGHT_PITCH_RAD just
// above, opposite sign (that one tilts forward into a dive; this tilts
// backward into a wall behind the avatar, matching a leanTarget's own
// facingRad -- "the direction the avatar faces while leaning," i.e. away
// from whatever it's leaning against).
const SHOP_LEAN_PITCH_RAD = (12 * Math.PI) / 180;

const SHOP_JOYSTICK_MAX_PX = 46;
const SHOP_JOYSTICK_DEADZONE_PX = 6;

const SHOP_PROXIMITY_INTERVAL_MS = 400;

// How far the camera must stay from the wall's own radius. Separate from
// (and much larger than) SHOP_WALL_MARGIN_M above: that one only needs to
// hide a cosmetic seam between the ground and the wall's base, but standing
// right up against the wall and swinging the camera from looking straight
// down back up past horizontal let a viewer glimpse past the wall — right
// at a grazing, near-tangent angle the wall's own paper-thin (zero
// thickness, single-sided) geometry doesn't reliably cover the view the
// way a real solid wall would. Keeping the camera meaningfully back from
// the wall means that grazing angle is never actually reachable by normal
// look input. Scales down for a small gapless world (see
// computeGaplessWorldRadius) so it can't eat most of a tiny world's
// playable area, but never drops below a floor that's still enough to
// avoid the grazing-angle case on any world.
const SHOP_WALL_CLEARANCE_M = 6;
const SHOP_WALL_CLEARANCE_MIN_M = 2;

// A wide range on purpose — Shop's "zoom" is a pure lens effect (the
// free-flying camera never actually moves closer/farther, see setShopFov's
// own comment), so there's no dolly-clipping-through-geometry risk that
// would otherwise argue for a narrower range. 6deg is a strong telephoto
// (roughly 10x magnification versus the 60deg default), 100deg is past
// human peripheral vision into genuine ultra-wide territory.
const SHOP_MIN_FOV_DEG = 6;
const SHOP_MAX_FOV_DEG = 100;
const SHOP_WHEEL_ZOOM_SENSITIVITY = 0.05;
const SHOP_PINCH_ZOOM_SENSITIVITY = 0.05;

let shopYaw = 0;
let shopPitch = -0.12;
// The avatar's own facing (docs/SPEC.md §2) — deliberately separate from
// shopYaw (the camera's look direction, right-stick-driven): the left
// stick turns the avatar to face wherever it's actually walking, while the
// right stick free-looks independently, the standard third-person control
// scheme. Only updated while moving (see updateShopMovement) — standing
// still and looking around doesn't spin the avatar in place.

// Current eased flight-pose pitch (0 = upright, SHOP_AVATAR_FLIGHT_PITCH_RAD
// = full tilt) — see SHOP_AVATAR_FLIGHT_PITCH_RAD's own comment and the
// per-frame ease in updateShopMovement.
let shopAvatarPitch = 0;
// -1..1 each, driven continuously by joystick deflection (see
// bindShopJoystick below) and consumed every animate() frame in
// updateShopMovement — not per-pointer-move deltas like the old
// whole-screen drag-to-steer this replaced.
let shopMoveX = 0;
let shopMoveY = 0;
let shopLookX = 0;
let shopLookY = 0;
let shopLastFrameTime = null;
let shopLastProximityCheck = 0;

// Sustained view-attention tracking (#215, sub-issue of #207 — docs/SPEC.md
// §2's item-handling animations trigger "on sustained view-attention," not
// just proximity). Distinct from updateShopProximity's nearest-in-range
// pattern above (throttled, and only over the curated sign/calendar/review
// lists): this runs every frame over every currently-loaded placed item —
// the same set shopPositionBlocked already walks for collision — and
// additionally requires the avatar to actually be looking toward the item,
// not merely standing near it. Consumed by updateShopItemHandling below
// (#216).
const SHOP_ATTENTION_RADIUS_M = 4; // matches SIGN_FADE_NEAR_M's own "close enough to interact" scale
const SHOP_ATTENTION_FOV_COS = Math.cos(THREE.MathUtils.degToRad(20)); // within ~20 degrees of dead-center
const SHOP_ATTENTION_DWELL_S = 1.5; // how long a target must hold attention before it counts as "sustained"
let shopAttentionTarget = null; // mesh currently accumulating attention, or null
let shopAttentionElapsedS = 0; // seconds shopAttentionTarget has held it, continuously — reset the instant the target changes
const scratchAttentionWorldPos = new THREE.Vector3();
const scratchAttentionForward = new THREE.Vector3();

// Item-handling animations (#216, sub-issue of #207 — docs/SPEC.md §2:
// "pick-up-and-turn for small items, walk-around for furniture-scale"),
// triggered by hasSustainedShopAttention() above. Both are pose-only —
// deliberately not moving shopAvatarPosition at all (no orbiting toward
// the item, no real "walking"): actually relocating the avatar
// autonomously is real, riskier scope (camera/collision/player-control
// interplay) this pass isn't taking on — see updateShopItemHandling's own
// comment. shopHandlingTarget is captured once when a play starts and
// held steady through that whole play (including its ease-out), rather
// than tracking shopAttentionTarget live — so a play already in progress
// can't stutter if the avatar's own animation briefly nudges it out of
// updateShopAttention's FOV cone.
const SHOP_ITEM_SMALL_MAX_DIMENSION_M = 0.5; // at/under this on every axis: pick-up-and-turn; above: walk-around
const SHOP_HANDLING_MAX_DURATION_S = 4; // caps any single play — see shouldEndItemHandling's own comment
const SHOP_HANDLING_BLEND_PER_S = 4; // ease in/out of the handling pose — matches SHOP_IDLE_BLEND_PER_S's own feel
const SHOP_HANDLING_ARM_RAISE_RAD = 1.1; // pick-up-and-turn: how far the arms lift toward a chest-height "holding" pose
const SHOP_HANDLING_TURN_AMPLITUDE_RAD = 0.5; // pick-up-and-turn: how far the "turning it over" yaw sway swings each way
const SHOP_HANDLING_TURN_PERIOD_S = 2.4; // pick-up-and-turn: one full back-and-forth cycle
const SHOP_HANDLING_SPIN_PERIOD_S = 5; // walk-around: one full circling rotation
let shopHandlingActive = false; // true while a play is running (not yet ended, even if still easing in)
let shopHandlingTarget = null; // mesh the current/fading-out play is about, or null once fully eased out
let shopHandlingElapsedS = 0; // seconds since this play started — see SHOP_HANDLING_MAX_DURATION_S
let shopHandlingBlend = 0; // 0..1, eased toward 1 while playing, 0 otherwise
let shopHandlingPhase = 0; // radians — see nextPhase's own comment for how each kind uses it

// THREE's camera looks down its own local -Z by default, with +Y as local
// "up" — a convention for a Y-up world, not this app's Z-up one. Composing
// yaw (world Z) and pitch (local X) directly on top of that default, with
// no correction, points "yaw=0, pitch=0" straight down at the ground
// instead of level at the horizon: pitch's rotation axis is fine (X stays
// X either way), but the *forward* it's pitching away from is wrong.
// SHOP_BASE_QUAT reorients the default forward from world -Z to world +Y
// (level, matching camera.up.set(0,0,1)'s Z-up convention already used
// everywhere else in this app) before yaw/pitch are ever applied, so
// pitch=0 means level and pitch's sign means what it looks like it means.
const SHOP_BASE_QUAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

export function applyShopCameraOrientation() {
  const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), shopYaw);
  const pitchQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), shopPitch);
  camera.quaternion.copy(yawQuat).multiply(pitchQuat).multiply(SHOP_BASE_QUAT);
}

// A standard dual-joystick mobile scheme: the left stick walks (forward/
// back/strafe, relative to the camera's current facing), the right stick
// looks (yaw/pitch). Each joystick tracks its own pointer via
// setPointerCapture so both thumbs work at once regardless of where the
// finger wanders once it's down — and each calls stopPropagation() so the
// builder scene's own product-drag/multi-select/gizmo listeners (registered
// on the canvas and on window) never see these events, without needing
// every one of those individually guarded against firing during Shop mode.
function bindShopJoystick(baseEl, knobEl, onChange) {
  let pointerId = null;
  let originX = 0;
  let originY = 0;

  function setKnob(x, y) {
    knobEl.style.transform = `translate(${x}px, ${y}px)`;
  }

  function update(clientX, clientY) {
    const dx = clientX - originX;
    const dy = clientY - originY;
    const dist = Math.hypot(dx, dy);
    if (dist < SHOP_JOYSTICK_DEADZONE_PX) {
      setKnob(0, 0);
      onChange(0, 0);
      return;
    }
    const clamped = Math.min(dist, SHOP_JOYSTICK_MAX_PX);
    const knobX = (dx / dist) * clamped;
    const knobY = (dy / dist) * clamped;
    setKnob(knobX, knobY);
    onChange(knobX / SHOP_JOYSTICK_MAX_PX, knobY / SHOP_JOYSTICK_MAX_PX);
  }

  function end(event) {
    if (event.pointerId !== pointerId) return;
    event.stopPropagation();
    pointerId = null;
    setKnob(0, 0);
    onChange(0, 0);
  }

  baseEl.addEventListener('pointerdown', (event) => {
    if (!shopActive || pointerId !== null) return;
    event.stopPropagation();
    event.preventDefault();
    pointerId = event.pointerId;
    originX = event.clientX;
    originY = event.clientY;
    baseEl.setPointerCapture(pointerId);
  });
  baseEl.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    event.stopPropagation();
    update(event.clientX, event.clientY);
  });
  baseEl.addEventListener('pointerup', end);
  baseEl.addEventListener('pointercancel', end);
}
// Flight (docs/SPEC.md §2): double-tap the fly button, or double-press
// space on desktop, toggles takeoff/landing (toggleShopFlight). Ascend/
// descend while actually flying is a separate, ordinary press-and-hold
// pair — shopVerticalInput/bindShopVerticalButton, +1 while Up is held,
// -1 while Down, consumed every frame in updateShopFlight exactly like
// shopMoveX/Y already are for the move joystick.
//
// Each button's own held-state is tracked independently (shopUpHeld/
// shopDownHeld) rather than shopVerticalInput itself recording "who's
// holding" — holding both and releasing just one used to silently stick
// the other off, since the second press's pointerdown would overwrite the
// first's contribution to the one shared variable, and the first button's
// own pointerup only ever cleared it if it still matched that button's own
// direction. Deriving shopVerticalInput as a sum of both held-flags means
// either button's press/release only ever touches its own flag.
let shopUpHeld = false;
let shopDownHeld = false;
let shopVerticalInput = 0;
function updateShopVerticalInput() {
  shopVerticalInput = (shopUpHeld ? 1 : 0) + (shopDownHeld ? -1 : 0);
}
function bindShopVerticalButton(el, direction) {
  let pointerId = null;
  el.addEventListener('pointerdown', (event) => {
    if (!shopActive) return;
    event.stopPropagation();
    pointerId = event.pointerId;
    el.setPointerCapture(pointerId);
    el.classList.add('active');
    if (direction === 1) shopUpHeld = true;
    else shopDownHeld = true;
    updateShopVerticalInput();
  });
  const end = (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    el.classList.remove('active');
    if (direction === 1) shopUpHeld = false;
    else shopDownHeld = false;
    updateShopVerticalInput();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// Owner (u7rvtz1jn1wchfsz6c1o): "The bird icon should be a single tap
// instead of a double-tap." The double-press requirement below (spacebar/
// mobile jump) exists to protect an overloaded gesture — spacebar/jump
// does other things too, so a stray press needs guarding against launching
// flight unintentionally. The bird button has no such risk: it's a
// dedicated, visible control the player has to deliberately aim for and
// tap, so requiring a double-tap there was just friction, not protection.
function bindShopFlyToggle(el) {
  el.addEventListener('pointerdown', (event) => {
    if (!shopActive) return;
    event.preventDefault();
    event.stopPropagation();
    toggleShopFlight();
  });
}

// #1176: "Go to Last Location" — see startGoToLastLocation's own comment.
// A plain click, not pointerdown like the fly button above: this one has
// no in-air-vs-grounded ambiguity to resolve quickly, and it's only ever
// shown during the spawn orbit anyway, never competing with another
// control for the same tap.

// #2624: the six bindings above (both joysticks, both vertical buttons,
// the fly toggle, the last-location click) all read a reverse-imported
// DOM-element binding directly at their own top-level call site -- main.js
// imports this module well before it reaches its own `const shopFlyBtn =
// document.getElementById(...)`-style declarations (circular import, same
// shape shop/avatar.js's own header comment documents), so evaluating
// these calls at this module's own top level throws a TDZ ReferenceError
// that crashes the entire bundle, same root cause shop/avatar.js's own
// shopIdleSwayPeriodS/shopIdleHeadIntervalS fix (#2623) already hit.
// Bundled into one function main.js calls once its own DOM consts are
// ready, rather than left as top-level side effects here.
export function initShopFlightInputBindings() {
  bindShopJoystick(shopMoveJoystickEl, shopMoveKnobEl, (x, y) => {
    shopMoveX = x;
    shopMoveY = y;
  });
  bindShopJoystick(shopLookJoystickEl, shopLookKnobEl, (x, y) => {
    shopLookX = x;
    shopLookY = y;
  });
  bindShopVerticalButton(shopUpBtn, 1);
  bindShopVerticalButton(shopDownBtn, -1);
  bindShopFlyToggle(shopFlyBtn);
  shopLastLocationBtn.addEventListener('click', () => {
    if (!shopActive) return;
    startGoToLastLocation();
  });
}

// A double-tap/double-press, not a single one, so an ordinary spacebar
// press while, say, a builder is just looking around with keyboard focus
// on the page never launches the player into the air unintentionally —
// matches docs/SPEC.md §2's own wording exactly ("double-press spacebar
// (desktop)"). The bird button (bindShopFlyToggle, above) is a single tap
// instead — see its own comment for why the two gestures differ.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || !shopActive) return;
  const target = event.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  event.preventDefault(); // stop the page's own default scroll-on-space
  // OS key-auto-repeat fires further keydowns (no keyup in between) well
  // inside SHOP_FLIGHT_DOUBLE_PRESS_WINDOW_MS while the key is held, which
  // would otherwise read as a rapid double-press and keep re-toggling
  // flight for as long as spacebar stays down — holding is not the
  // deliberate double-press this gesture requires.
  if (event.repeat) return;
  const now = performance.now();
  if (now - shopLastSpacePressAt <= SHOP_FLIGHT_DOUBLE_PRESS_WINDOW_MS) {
    shopLastSpacePressAt = -Infinity;
    toggleShopFlight();
  } else {
    shopLastSpacePressAt = now;
  }
});

// Zoom: narrows/widens the camera's own field of view rather than moving
// it — the camera's own position is derived every frame from the avatar it
// follows (positionShopCamera), not something a dolly could move
// independently, so a lens-zoom is the natural equivalent. Wheel for
// desktop, pinch for touch. Both live on the canvas itself
// rather than the joysticks, so a thumb already on either stick never
// fights with a zoom gesture — pinching needs both fingers on open canvas,
// exactly where a joystick drag isn't.
export function setShopFov(fov) {
  camera.fov = THREE.MathUtils.clamp(fov, SHOP_MIN_FOV_DEG, SHOP_MAX_FOV_DEG);
  camera.updateProjectionMatrix();
}
renderer.domElement.addEventListener('wheel', (event) => {
  if (!shopActive) return;
  event.preventDefault();
  setShopFov(camera.fov + event.deltaY * SHOP_WHEEL_ZOOM_SENSITIVITY);
}, { passive: false });

const shopPinchPointers = new Map(); // pointerId -> {x, y}
let shopPinchStartDistance = null;
let shopPinchStartFov = null;
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (!shopActive) return;
  shopPinchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (shopPinchPointers.size === 2) {
    const [a, b] = [...shopPinchPointers.values()];
    shopPinchStartDistance = Math.hypot(a.x - b.x, a.y - b.y);
    shopPinchStartFov = camera.fov;
  }
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!shopActive || !shopPinchPointers.has(event.pointerId)) return;
  shopPinchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (shopPinchPointers.size === 2 && shopPinchStartDistance !== null) {
    const [a, b] = [...shopPinchPointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    setShopFov(shopPinchStartFov - (distance - shopPinchStartDistance) * SHOP_PINCH_ZOOM_SENSITIVITY);
  }
});
function shopPinchEnd(event) {
  shopPinchPointers.delete(event.pointerId);
  if (shopPinchPointers.size < 2) {
    shopPinchStartDistance = null;
    shopPinchStartFov = null;
  }
}
renderer.domElement.addEventListener('pointerup', shopPinchEnd);
renderer.domElement.addEventListener('pointercancel', shopPinchEnd);

const shopForward = new THREE.Vector3();
const shopRight = new THREE.Vector3();
const shopViewDirection = new THREE.Vector3();
const shopMoveDir = new THREE.Vector3();
const shopCameraAnchor = new THREE.Vector3();

// #1445: e2e-only hook for forcing a deterministic cross of
// SHOP_LOAD_RADIUS_M/SHOP_UNLOAD_RADIUS_M without racing real joystick/
// flight movement choreography against a tight artificial network delay.
// Sets shopAvatarPosition directly rather than camera.position -- Shop
// mode's own per-frame positionShopCamera() derives camera.position fresh
// from shopAvatarPosition every single frame (see its own definition), so
// writing camera.position here would just be silently overwritten on the
// very next frame. updateShopProximity reads camera.position.x/y, and
// positionShopCamera runs unconditionally ahead of it in the same
// updateShopMovement tick, so this still lands before the next proximity
// check sees it. Always inert unless a test calls it, same convention as
// window.__testAvatarLoadDelayMs.
window.__testTeleportShopAvatar = (x, y, z) => {
  shopAvatarPosition.x = x;
  shopAvatarPosition.y = y;
  // #1829: optional third arg, added so a test can land the avatar exactly
  // on an object's own top surface (itemZMax) to reproduce the
  // can't-walk-after-landing-on-top bug without racing real flight descent
  // choreography. Every existing caller passes only (x, y); leaving z
  // (and flight state) untouched when omitted keeps that behavior unchanged.
  // shopFlightAltitudeM, not shopAvatarPosition.z, is authoritative --
  // updateShopMovement's own per-frame sync (shopAvatarPosition.z =
  // shopFlightAltitudeM - curvatureDropM(...), see that assignment's own
  // comment) overwrites a bare z write here within the very next frame,
  // snapping back to whatever stale altitude flight was last left at. Also
  // forcing shopFlightState to 'grounded' (the state updateShopFlight
  // itself settles into once a real landing finishes, per its own
  // `if (landed) shopFlightState = 'grounded'`) keeps this a genuine
  // "already landed" snapshot rather than momentarily-still-flying.
  if (z !== undefined) {
    shopAvatarPosition.z = z;
    shopFlightAltitudeM = z + curvatureDropM(Math.hypot(x, y));
    shopFlightState = 'grounded';
  }
};

// #2423: read-only counterpart for shopFlightState itself -- a test waiting
// for a real landing/takeoff to finish can't just wait out
// SHOP_FLIGHT_*_DURATION_S in real time and assume that's enough: dt each
// frame is clamped to 0.1s (updateShopMovement's own "clamp against
// tab-switch-sized gaps" comment), so under a CPU-starved CI run where
// requestAnimationFrame ticks arrive sparsely, *simulated* flight time can
// fall arbitrarily far behind real time -- a fixed real-time wait sized for
// the simulated duration is never actually guaranteed to be enough. Polling
// this instead of guessing a bigger timeout is the robust fix.
window.__testShopFlightState = () => shopFlightState;

// Flight state (docs/SPEC.md §2) — see updateShopFlight/toggleShopFlight.
// 'grounded' | 'takingOff' | 'flying' | 'landing'. Toggling mid-transition
// is ignored (see toggleShopFlight) rather than queued or reversed, so
// there's no need to track anything beyond "which transition, how far in."
export let shopFlightState = 'grounded';
let shopFlightTransitionElapsedS = 0;
export let shopFlightAltitudeM = 0; // authoritative — shopAvatarPosition.z mirrors this (offset by ground curvature) every frame
let shopFlightLandingStartAltitudeM = 0; // altitude captured the instant landing begins, so its ramp has a real start point
let shopLastSpacePressAt = -Infinity;

// #1175: true for the span right after spawn during which the avatar
// orbits the world center hands-off (see updateShopSpawnRotation) — ends
// the instant the shopper gives any navigation input (stopShopSpawnRotation).
// shopSpawnOrbitRadiusM is the (fixed, spawn-time-random) distance from the
// center the orbit holds; shopYaw/shopAvatarFacing/shopAvatarPosition are
// all driven directly off the shared angle tracked in updateShopSpawnRotation
// rather than a separate angle field, since "facing the center" and "the
// camera's own look direction" and "the orbit's own angle" are all the same
// angle throughout the orbit (see that function's own comment).
let shopSpawnRotating = false;
let shopSpawnOrbitRadiusM = 0;

// #1176: the shopper's own last-reported avatar_presence position (fetched
// once in enterShopMode via fetchOwnLastPresence), or null when there is
// none (a brand-new account, or one that's never entered Shop mode
// before) — the "Go to Last Location" button is only ever shown when this
// is non-null. shopLastLocationHideTimerS counts seconds since the
// shopper began navigating on their own (null while not counting — see
// stopShopSpawnRotationForNavigation); shopGoToLastLocationPhase/
// ElapsedS drive the click-triggered fade-out/teleport/fade-in sequence
// (see updateGoToLastLocation) — null/0 while no such sequence is running.
let shopLastLocationHideTimerS = null;
let shopGoToLastLocationPhase = null; // null | 'fadingOut' | 'fadingIn'
let shopGoToLastLocationElapsedS = 0;

// Shared by walking's own floor clamp and the camera-follow height — keeps
// the camera between the ground and comfortably below the dome's current
// apex (see SHOP_DOME_CLEARANCE_MARGIN_M), the same "a real boundary, not
// just a backdrop" treatment the radial wall clamp already gets just below
// this. The dome's own apex can grow over the course of a session (see
// growShopDomeIfNeeded), so this is recomputed fresh each call rather than
// cached.
//
// #1631: unlike shopFlightAltitudeM (an *altitude* above local ground,
// converted to world z via shopAvatarPosition.z's own -curvatureDropM(...)
// term), camera.position.z is already a world z value — so the bound here
// needs the dome's actual world-z apex directly (SHOP_WALL_HEIGHT_M sagged
// by curvatureDropM(shopWorldRadiusM), the same wallGroundDropM term
// enterShopMode bakes into shopDomeMesh.position.z/wall.position.z, plus
// shopDomeRiseM), not shopMaxFlightAltitudeM's altitude-domain value
// (which still needs its own +curvatureDropM(avatar distance) term to
// correctly cancel out once *that* value gets converted to world z) --
// reusing it here directly would double-count the correction instead of
// cancelling it.
function clampShopCameraHeight() {
  const maxHeight = SHOP_WALL_HEIGHT_M + shopDomeRiseM - SHOP_DOME_CLEARANCE_MARGIN_M - curvatureDropM(shopWorldRadiusM);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, SHOP_MIN_HEIGHT_M, maxHeight);
}

// The world wall (see enterShopMode) is a real boundary, not just a
// backdrop — pulls (x, y) radially back inside it in place. This is the
// *camera's* own clearance (see SHOP_WALL_CLEARANCE_M's comment — a
// grazing-angle concern that's specific to the follow camera's own offset
// from the avatar, never meant to also hold the avatar's own position
// back). Used for the follow camera itself (positionShopCamera) and for
// #1175's spawn-location pick (enterShopMode), which needs the same "how
// far from center can the camera-anchored avatar comfortably orbit"
// formula just used in the opposite direction (picking a fresh random
// radius there vs. clamping an existing position here).
export function shopMaxRadiusM() {
  if (shopWorldRadiusM === null) return 0;
  const clearance = Math.max(SHOP_WALL_CLEARANCE_MIN_M, Math.min(SHOP_WALL_CLEARANCE_M, shopWorldRadiusM * 0.15));
  return shopWorldRadiusM - clearance;
}

// #1595: the avatar's own movement used to share shopMaxRadiusM (the
// camera's much larger grazing-angle clearance) above, which stopped the
// avatar ~6m short of the actual wall on top of the camera's own separate
// pull-back when looking toward center — a doubled-up buffer, not two
// intentional ones. The avatar only needs to stay inside the wall by its
// own footprint half-width, just enough that it doesn't visually clip
// through the wall mesh.
function shopAvatarMaxRadiusM() {
  if (shopWorldRadiusM === null) return 0;
  return shopWorldRadiusM - shopAvatarCollisionHalfM();
}

// #1840: shopAvatarMaxRadiusM above only ever bounded the avatar group's
// own origin (its feet/hip pivot), not the mesh hanging off it -- flying
// tips the whole group into a ~45deg forward lean
// (SHOP_AVATAR_FLIGHT_PITCH_RAD, around that same origin), so the
// torso/head reach forward past the clamped pivot by roughly
// (TORSO_LENGTH + HEAD_RADIUS*2) * sin(lean angle), confirmed by the
// owner's own report (#1828): "his feet stay inside the dome, only his
// lean makes the rest of him go outside." #1839 closed the separate gap
// between the flat clamps and the dome's real curved shape at altitude,
// but left this one as a follow-up -- a leaning avatar can poke through
// even at low altitude, where the clamp is still just the flat wall
// radius. Reserving this extra clearance whenever airborne (the lean
// target is always this same full angle the instant takeoff starts, see
// targetAvatarPitch/shopAvatarPitch -- no need to track the eased
// in-between value here, since even a partial lean reaches less than this
// worst case, not more) keeps the whole leaning body inside the boundary,
// not just its pivot.
// #2624: a function rather than a cached module-level constant -- computed
// from SHOP_AVATAR_TORSO_LENGTH_M/SHOP_AVATAR_HEAD_RADIUS_M, reverse-
// imported from main.js, which (same TDZ-class hazard as the DOM-element
// bindings this module's own initShopFlightInputBindings comment
// documents) still read as undefined at this module's own top-level
// evaluation time -- main.js hasn't reached their declarations yet when
// the circular import resolves. The call site is the one place this is
// ever needed, every frame, so there's no real cost to just computing it
// fresh there instead of caching a value that would otherwise be NaN.
function shopAvatarFlightLeanClearanceM() {
  return (SHOP_AVATAR_TORSO_LENGTH_M + SHOP_AVATAR_HEAD_RADIUS_M * 2) * Math.sin(Math.abs(SHOP_AVATAR_FLIGHT_PITCH_RAD));
}

function clampShopRadius(position, maxRadius) {
  if (shopWorldRadiusM === null) return;
  const distance = Math.hypot(position.x, position.y);
  if (distance > maxRadius) {
    const scale = maxRadius / distance;
    position.x *= scale;
    position.y *= scale;
  }
}

// #1828: shopMaxRadiusM/shopAvatarMaxRadiusM above are each one flat
// radius regardless of height, which only matches the world's real
// boundary down at ground level -- the wall is a true vertical cylinder
// there, but above the wall's rim the boundary is shopDomeMesh's own
// curved dome (an ellipsoid cap: horizontal radius shopWorldRadiusM,
// vertical rise shopDomeRiseM -- see its own scale.set() call), which
// narrows in radius as height increases. Clamping to the flat radius at
// every height let the avatar/camera sit inside the cylindrical bounding
// box those two flat clamps (this one and clampShopCameraHeight) form
// together while already outside the dome's actual curved surface, worst
// right at the top. Derives the dome's own real cross-section radius at a
// given world z from the same ellipse equation the mesh's own non-uniform
// scale encodes, then applies the caller's existing clearance
// (baseMaxRadiusM is already shopWorldRadiusM minus whatever clearance
// that caller wants) by subtracting that same clearance from the dome
// radius instead of from the flat shopWorldRadiusM -- continuous with the
// flat formula right at the wall's own rim (heightAboveDomeBaseM <= 0),
// where it returns baseMaxRadiusM unchanged.
function shopMaxRadiusAtWorldZM(worldZ, baseMaxRadiusM) {
  if (shopWorldRadiusM === null) return 0;
  const heightAboveDomeBaseM = worldZ - (SHOP_WALL_HEIGHT_M - curvatureDropM(shopWorldRadiusM));
  if (heightAboveDomeBaseM <= 0) return baseMaxRadiusM;
  const clearanceM = shopWorldRadiusM - baseMaxRadiusM;
  const domeRadiusAtHeightM = shopWorldRadiusM *
    Math.sqrt(Math.max(0, 1 - (heightAboveDomeBaseM / shopDomeRiseM) ** 2));
  return Math.max(0, domeRadiusAtHeightM - clearanceM);
}

// docs/SPEC.md §2's altitude/speed curve — the actual math (a power law
// clamped to the spec's own [1x, 100x] range) now lives in flight.js as a
// pure, directly-unit-tested function (src/flight.test.js); this call site
// just supplies this feature's own spec-derived constants from above.
function shopFlightSpeedMultiplier(altitudeM) {
  return flightSpeedMultiplier(altitudeM, {
    refAltitudeM: SHOP_FLIGHT_SPEED_REF_ALTITUDE_M,
    refMultiplier: SHOP_FLIGHT_SPEED_REF_MULTIPLIER,
    exponent: SHOP_FLIGHT_SPEED_EXPONENT,
    minMultiplier: SHOP_FLIGHT_MIN_SPEED_MULTIPLIER,
    maxMultiplier: SHOP_FLIGHT_MAX_SPEED_MULTIPLIER,
  });
}

// N45 (Control Room, 2026-09-11): originally swapped the icon to a
// standing bird (🐦) for the whole takingOff/flying span so it read as
// "you're up — tap to land," distinct from the grounded dove's "tap to
// fly." Owner follow-up (2026-09-12): "make the in-flight bird and the
// standing bird look like the same bird" — 🕊️ and 🐦 render as visibly
// different species/colors across platforms (white dove vs. a often-blue
// generic bird), which read as a mismatch rather than a state change. That
// problem was specific to native emoji glyphs, not to having two icons —
// owner-supplied custom artwork (Control Room, 2026-10-01, a matching
// flying/standing pair of the same bird) fixes it at the source, so the
// icon itself can carry the state again, same as before N45, with no CSS
// tilt needed to compensate (see #shop-fly-btn-icon/.active in index.html).
const SHOP_FLY_BTN_ICON_FLYING = '/bird-flying.png';
const SHOP_FLY_BTN_ICON_STANDING = '/bird-standing.png';
// #1815: both owner-supplied PNGs bake in their own circular card/ring
// backdrop (a separate, smaller circle than #shop-fly-btn's own 56x56
// clip), which read as a "ring within a ring" / "hole in the ozone layer"
// artifact. Zooming each icon in via a CSS transform (clipped back down to
// the button's own circle by its new `overflow: hidden`, see index.html)
// crops that inner ring out of view entirely, without touching the source
// artwork. transform-origin doubles as the owner's requested per-icon
// nudge: scaling pushes content *away* from the fixed origin point, so an
// origin offset toward one corner shifts the bird toward the opposite
// corner. Tuned directly against screenshots of the real rendered button,
// not derived analytically — a quick visual check after any future artwork
// swap is cheap insurance that these still land right.
//
// #2750: one shared zoom for both icons assumed they had similar margin
// around the bird within their own 512x559 canvas -- they don't.
// bird-standing.png has generous empty margin around a small bird, so a
// 1.6x zoom comfortably crops its own baked-in ring out while leaving the
// bird itself fully framed. bird-flying.png's wings already spread nearly
// to the canvas edges with almost no margin at all, so that same 1.6x zoom
// (tuned against the standing bird, never separately verified against this
// one) pushed its wingtips well past the button's own circular clip --
// exactly the "images are too large to fit in their circle" the owner
// reported. Screenshotting the real rendered button at a range of zoom
// values (not derived analytically, same methodology as the original
// tuning) showed bird-flying.png needs no extra zoom at all: plain
// object-fit: cover already frames it fully and cleanly, with no visible
// ring artifact left over (its own margin is thin enough that the square
// crop alone removes it).
const SHOP_FLY_BTN_ICON_STANDING_ZOOM = 1.6;
const SHOP_FLY_BTN_ICON_FLYING_ZOOM = 1.0;
const SHOP_FLY_BTN_ICON_STANDING_ORIGIN = '38% 62%'; // standing bird: shift right + up
const SHOP_FLY_BTN_ICON_FLYING_ORIGIN = '50% 50%'; // in-flight bird: no zoom applied, so no offset needed
export function setShopFlyBtnFlying(flying) {
  document.body.classList.toggle('shop-flying', flying);
  shopFlyBtn.classList.toggle('active', flying);
  shopFlyBtn.setAttribute('aria-pressed', String(flying));
  // #1589: the icon shows the action a press performs, not the current
  // state — a standing bird (press to take off) while grounded, a flying
  // bird (press to land) while flying, i.e. the inverse of `flying`.
  shopFlyBtnIcon.src = flying ? SHOP_FLY_BTN_ICON_STANDING : SHOP_FLY_BTN_ICON_FLYING;
  shopFlyBtnIcon.style.transformOrigin = flying ? SHOP_FLY_BTN_ICON_STANDING_ORIGIN : SHOP_FLY_BTN_ICON_FLYING_ORIGIN;
  shopFlyBtnIcon.style.transform = `scale(${flying ? SHOP_FLY_BTN_ICON_STANDING_ZOOM : SHOP_FLY_BTN_ICON_FLYING_ZOOM})`;
}

// Toggling mid-takeoff is ignored — let it finish, then the next press
// starts cleanly from a real flying state (resuming mid-ascent isn't
// needed: taking off is already what a tap during it would ask for).
// Landing captures its own starting altitude (shopFlightLandingStartAltitudeM)
// so its descent ramps from wherever the player actually was, not always
// the same height. #2446: toggling mid-landing resumes flight immediately
// from the current altitude instead of being ignored like takeoff — a
// player who tapped fly by mistake, or wants back up before fully
// grounding, shouldn't have to wait out the whole descent first.
function toggleShopFlight() {
  // #1175/#1176: a deliberate tap of the fly button is navigation input
  // same as any joystick deflection — stop the hands-off spawn orbit
  // immediately rather than leaving it fighting the player's own
  // takeoff/landing, and start the "Go to Last Location" button's own
  // auto-hide countdown the same way (see stopShopSpawnRotationForNavigation).
  stopShopSpawnRotationForNavigation();
  if (shopFlightState === 'grounded') {
    shopFlightState = 'takingOff';
    shopFlightTransitionElapsedS = 0;
    // shop-flying on <body> gates #shop-vertical-controls' own visibility
    // (index.html) — shown for the whole takingOff/flying span, not just
    // once actually airborne, so the ascend/descend buttons are already in
    // place the moment takeoff finishes rather than popping in afterward.
    setShopFlyBtnFlying(true);
  } else if (shopFlightState === 'flying') {
    shopFlightLandingStartAltitudeM = shopFlightAltitudeM;
    shopFlightState = 'landing';
    shopFlightTransitionElapsedS = 0;
    // Landing is an automatic descent (shopVerticalInput is only read
    // while actually 'flying' — see updateShopFlight), so the ascend/
    // descend controls hide the instant it starts, not once it finishes.
    setShopFlyBtnFlying(false);
  } else if (shopFlightState === 'landing') {
    // #2446: shopFlightAltitudeM is already the live, current altitude —
    // updateShopFlight's own 'landing' branch has been writing it every
    // frame since the descent started — so resuming 'flying' here needs no
    // ramp/elapsed-time reset of its own, unlike takeoff: the 'flying'
    // branch above never reads shopFlightTransitionElapsedS at all.
    shopFlightState = 'flying';
    setShopFlyBtnFlying(true);
  }
}

// #1175: ends the hands-off spawn orbit the instant it's actually rotating
// — a no-op otherwise, so every navigation-input path (joystick deflection,
// vertical flight buttons, the fly-button tap in toggleShopFlight above)
// can call this unconditionally without first checking shopSpawnRotating
// itself.
function stopShopSpawnRotation() {
  shopSpawnRotating = false;
}


// #1176: the navigation-input-specific wrapper around stopShopSpawnRotation
// above — also starts the "Go to Last Location" button's own 5-second
// auto-hide countdown, but only the first time (shopLastLocationHideTimerS
// stays non-null once started, so a second navigation input while it's
// already counting down doesn't restart the clock), and only when the
// orbit was actually still running (a tap/deflection that arrives after the
// orbit already stopped itself isn't a new "the shopper began navigating"
// moment) and there's a button showing at all to hide. Every navigation-
// input path (the joystick/vertical-button checks in updateShopMovement,
// the fly-button tap in toggleShopFlight) calls this instead of the bare
// stopShopSpawnRotation — the one exception is startGoToLastLocation
// below, since clicking that button is not "navigating on their own."
function stopShopSpawnRotationForNavigation() {
  const wasRotating = shopSpawnRotating;
  stopShopSpawnRotation();
  if (wasRotating && shopLastLocation && shopLastLocationHideTimerS === null) {
    shopLastLocationHideTimerS = 0;
  }
}

// #1495: remembers each material's own transparent flag from just before
// setShopAvatarOpacity first forces it to true, so restoreShopAvatarTransparency
// (called once the fade sequence completes) can put it back rather than
// leaving every material permanently reclassified into Three.js's
// back-to-front transparent render pass. A WeakMap rather than a plain
// property so it never needs explicit cleanup when a material is replaced
// wholesale (re-equip builds fresh materials — see refreshEquippedShopAvatar).
let shopAvatarOriginalTransparent = new WeakMap();

// #1176: fades every material in the avatar's own group uniformly — used
// by the "Go to Last Location" sequence's fade-out/fade-in (see
// updateGoToLastLocation). Skips the AFK sprite: that one already drives
// its own opacity every frame from shopAfkBlend (updateShopAvatarIdle),
// independently of this sequence, and fighting it here would just lose to
// whichever ran later this same frame.
function setShopAvatarOpacity(opacity) {
  shopAvatar.group.traverse((object) => {
    if (object === shopAvatar.afkSprite || !object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!shopAvatarOriginalTransparent.has(material)) {
        shopAvatarOriginalTransparent.set(material, material.transparent);
      }
      material.transparent = true;
      material.opacity = opacity;
    }
  });
}

// #1495: restores each material's pre-fade transparent flag once the "Go to
// Last Location" sequence is fully back to opacity 1 — see
// shopAvatarOriginalTransparent's own comment above for why setShopAvatarOpacity
// never resets this on its own.
function restoreShopAvatarTransparency() {
  shopAvatar.group.traverse((object) => {
    if (object === shopAvatar.afkSprite || !object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (shopAvatarOriginalTransparent.has(material)) {
        material.transparent = shopAvatarOriginalTransparent.get(material);
      }
    }
  });
}

// #1176: click handler for #shop-last-location-btn. Stops the spawn orbit
// (plain stopShopSpawnRotation — clicking this button is the shopper
// choosing the rotating view's own offered alternative, not "navigating on
// their own," so it must never start the auto-hide countdown) and hides
// the button immediately (no fade, no countdown — it's served its purpose
// the instant it's tapped), then hands off to updateGoToLastLocation for
// the actual fade-out/teleport/fade-in/auto-land sequence.
function startGoToLastLocation() {
  if (!shopLastLocation || shopGoToLastLocationPhase) return;
  stopShopSpawnRotation();
  shopLastLocationHideTimerS = null;
  shopLastLocationBtn.classList.remove('visible');
  shopGoToLastLocationPhase = 'fadingOut';
  shopGoToLastLocationElapsedS = 0;
}

// #1176: the click-triggered sequence itself — fade the avatar out, jump
// it (and the camera, via shopYaw/shopAvatarFacing) above the last
// reported location once fully invisible, fade back in, then hand off to
// the ordinary 'landing' flight state (updateShopFlight already knows how
// to fly that down to the real ground/obstruction top — see its own
// comment) so the rest of the descent is exactly the same code path a
// manual fly-button landing already uses, not a parallel one. Called every
// frame from updateShopMovement; a no-op whenever no sequence is running.
function updateGoToLastLocation(dt) {
  if (!shopGoToLastLocationPhase) return;
  shopGoToLastLocationElapsedS += dt;
  const t = Math.min(1, shopGoToLastLocationElapsedS / SHOP_LAST_LOCATION_AVATAR_FADE_S);
  if (shopGoToLastLocationPhase === 'fadingOut') {
    setShopAvatarOpacity(1 - t);
    if (t < 1) return;
    shopAvatarPosition.x = shopLastLocation.x;
    shopAvatarPosition.y = shopLastLocation.y;
    shopFlightState = 'flying';
    shopFlightTransitionElapsedS = 0;
    shopFlightAltitudeM = SHOP_SPAWN_START_ALTITUDE_M;
    shopAvatarPosition.z =
      shopFlightAltitudeM - curvatureDropM(Math.hypot(shopAvatarPosition.x, shopAvatarPosition.y));
    // Face whichever direction the shopper was last facing, if known —
    // falls back to whatever shopYaw already was (invisible either way at
    // this exact instant, so it's never a visible jump) rather than
    // guessing a direction that isn't actually meaningful here.
    if (shopLastLocation.heading !== null && shopLastLocation.heading !== undefined) {
      shopYaw = shopLastLocation.heading;
    }
    setShopAvatarFacing(shopYaw);
    applyShopCameraOrientation();
    shopGoToLastLocationPhase = 'fadingIn';
    shopGoToLastLocationElapsedS = 0;
    setShopAvatarOpacity(0);
  } else {
    setShopAvatarOpacity(t);
    if (t < 1) return;
    shopGoToLastLocationPhase = null;
    restoreShopAvatarTransparency(); // #1495: see its own comment
    // Auto-begin the descent the instant the fade-in finishes — same
    // landing ramp a manual fly-button tap starts (see toggleShopFlight),
    // just triggered automatically instead of waiting for one.
    shopFlightLandingStartAltitudeM = shopFlightAltitudeM;
    shopFlightState = 'landing';
    shopFlightTransitionElapsedS = 0;
    setShopFlyBtnFlying(false);
  }
}

// #1175: drives the spawn-time "slow clockwise rotating aerial shot at a
// random location" (docs/SPEC.md §1) each frame until navigation input
// stops it. shopYaw doubles as the orbit's own angle here — at any point on
// the circle, the camera direction that faces the world center IS the
// orbit angle itself (see applyShopCameraOrientation's own SHOP_BASE_QUAT
// comment: forward at yaw θ is (-sin θ, cos θ), so a position of
// (r sin θ, -r cos θ) always has that forward vector pointing straight at
// the origin). Decreasing θ over time therefore both turns the view
// clockwise (as seen from above, looking down +Z) and swings the position
// clockwise around the same center in lockstep — one angle, no separate
// "facing" and "orbit position" math to keep in sync.
function updateShopSpawnRotation(dt) {
  if (!shopSpawnRotating) return;
  shopYaw -= SHOP_SPAWN_ORBIT_ANGULAR_SPEED_RAD_S * dt;
  shopAvatarPosition.x = shopSpawnOrbitRadiusM * Math.sin(shopYaw);
  shopAvatarPosition.y = -shopSpawnOrbitRadiusM * Math.cos(shopYaw);
  setShopAvatarFacing(shopYaw);
  applyShopCameraOrientation();
}

// Drives shopFlightAltitudeM through takeoff/landing (smoothstep-eased
// ramps, spec's own ~1s lift / ~2s reverse) and, once actually flying,
// lets the up/down buttons climb or descend within the world's current
// dome ceiling (see the "500m flight ceiling" comment above
// SHOP_FLIGHT_SPEED_EXPONENT for why that's not literally 500m yet).
// Called once per frame from updateShopMovement,
// before movement/pose so everything downstream (flight speed, the
// avatar's own z, the camera that follows it) sees this frame's altitude.
function updateShopFlight(dt) {
  if (shopFlightState === 'takingOff') {
    shopFlightTransitionElapsedS += dt;
    shopFlightAltitudeM = takeoffAltitudeM(
      shopFlightTransitionElapsedS, SHOP_FLIGHT_TAKEOFF_DURATION_S, SHOP_FLIGHT_HOVER_START_ALTITUDE_M,
    );
    if (shopFlightTransitionElapsedS >= SHOP_FLIGHT_TAKEOFF_DURATION_S) shopFlightState = 'flying';
  } else if (shopFlightState === 'landing') {
    shopFlightTransitionElapsedS += dt;
    // #1090/#2852: minAltitudeM is this landlet's own bare-ground height
    // (see bareGroundAltitudeM's own comment) unless there's a placed item
    // directly under the avatar's current (x, y), in which case it's that
    // item's own top surface (converted from world z into this frame's
    // altitude terms, same as shopAvatarPosition.z's own formula below) —
    // the floor this descent should stop at instead of passing through.
    const obstructionTopZ = shopLandingObstructionTopZ(shopAvatarPosition.x, shopAvatarPosition.y);
    const minAltitudeM = obstructionTopZ === null
      ? bareGroundAltitudeM(shopAvatarPosition.x, shopAvatarPosition.y)
      : obstructionTopZ + curvatureDropM(Math.hypot(shopAvatarPosition.x, shopAvatarPosition.y));
    const { altitudeM, landed } = clampedLandingAltitudeM(
      shopFlightTransitionElapsedS, SHOP_FLIGHT_LANDING_DURATION_S, shopFlightLandingStartAltitudeM, minAltitudeM,
    );
    shopFlightAltitudeM = altitudeM;
    if (landed) {
      // #2044: nudge away from another avatar occupying this exact spot,
      // the same moment the vertical ramp above finishes -- mirrors #1090's
      // item-collision handling (which already stopped the *descent* short
      // of a solid object) but for the *landing spot itself*, against a
      // live player instead of static geometry.
      const openSpot = nearestOpenLandingSpot(shopAvatarPosition.x, shopAvatarPosition.y);
      // #2362: obstructionTopZ/minAltitudeM above were computed at the
      // pre-nudge (x, y) -- if the nudge actually moved the avatar, that
      // floor belongs to the spot it's leaving, not the one it's landing
      // on. Recompute it for the real landing spot, or the avatar can end
      // up clipped into (floating above, or sunk into) whatever's really
      // there instead of resting on its own top surface, the same way
      // #1090 already rests it correctly when there's no nudge at all.
      if (openSpot.x !== shopAvatarPosition.x || openSpot.y !== shopAvatarPosition.y) {
        const nudgedObstructionTopZ = shopLandingObstructionTopZ(openSpot.x, openSpot.y);
        shopFlightAltitudeM = nudgedObstructionTopZ === null
          ? bareGroundAltitudeM(openSpot.x, openSpot.y)
          : nudgedObstructionTopZ + curvatureDropM(Math.hypot(openSpot.x, openSpot.y));
      }
      shopAvatarPosition.x = openSpot.x;
      shopAvatarPosition.y = openSpot.y;
      // #2080: nearestOpenLandingSpot only checks clearance from other
      // avatars, not the world boundary -- without this, a nudge taken near
      // the wall could push shopAvatarPosition outside shopAvatarMaxRadiusM,
      // left unclamped (clampShopRadius is otherwise only ever called from
      // updateShopMovement, gated on actual movement input) until the
      // player's next WASD/joystick move.
      clampShopRadius(shopAvatarPosition, shopMaxRadiusAtWorldZM(shopAvatarPosition.z, shopAvatarMaxRadiusM()));
      shopFlightState = 'grounded';
    }
  } else if (shopFlightState === 'flying') {
    if (shopVerticalInput !== 0) {
      shopFlightAltitudeM += shopVerticalInput * SHOP_FLIGHT_VERTICAL_SPEED_M_S * dt;
    }
    const maxAltitudeM = shopMaxFlightAltitudeM();
    shopFlightAltitudeM = THREE.MathUtils.clamp(shopFlightAltitudeM, SHOP_FLIGHT_HOVER_START_ALTITUDE_M * 0.5, maxAltitudeM);
  }
}

// #1631: the dome/wall's own world-z position sags below SHOP_WALL_HEIGHT_M
// by curvatureDropM(shopWorldRadiusM) -- the same ground-curvature term
// enterShopMode bakes into shopDomeMesh.position.z/wall.position.z when it
// builds them (see wallGroundDropM there), evaluated at the *wall's* own
// distance from the origin since the wall/dome sit at a fixed radius. But
// "altitude" here is relative to *local* ground at the avatar's own (x, y)
// -- shopAvatarPosition.z's own comment -- which sags by only
// curvatureDropM(avatar's own distance from origin), strictly less than the
// wall's sag for anywhere inside the wall. The old maxAltitudeM/maxHeight
// formula used by updateShopFlight/clampShopCameraHeight ignored this
// difference entirely, so it clamped altitude as if local ground were as
// low as the wall's ground -- letting the avatar (and the camera that
// follows it) climb to a world z genuinely above the dome's real apex by
// up to that whole gap, worst a world center where the avatar's own sag is
// zero. Correcting for it (adding back the avatar's own, smaller sag, after
// removing the wall's) keeps the clamp pinned to the dome's actual surface
// regardless of how large the world has grown.
function shopMaxFlightAltitudeM() {
  const avatarDistanceFromOriginM = Math.hypot(shopAvatarPosition.x, shopAvatarPosition.y);
  return SHOP_WALL_HEIGHT_M + shopDomeRiseM - SHOP_DOME_CLEARANCE_MARGIN_M
    - curvatureDropM(shopWorldRadiusM) + curvatureDropM(avatarDistanceFromOriginM);
}

// The classic over-the-shoulder third-person rig: orbits the camera around
// a fixed-radius sphere (SHOP_CAMERA_FOLLOW_DISTANCE_M) centered on the
// avatar's own head-height anchor, using the exact look direction
// (shopViewDirection, full 3D — unlike shopForward/shopRight below, this
// one is deliberately *not* flattened) already established by
// applyShopCameraOrientation. Subtracting that direction from the anchor
// means looking down swings the camera up and back over the avatar's
// shoulder, looking up swings it down and in toward the avatar's own back —
// exactly what a shoulder-cam should do, with no separate orbit math needed
// beyond the walking camera's own existing yaw/pitch state.
export function positionShopCamera() {
  camera.getWorldDirection(shopViewDirection);
  shopCameraAnchor.copy(shopAvatarPosition);
  shopCameraAnchor.z += shopCameraAnchorHeightM();
  camera.position.copy(shopCameraAnchor).addScaledVector(shopViewDirection, -SHOP_CAMERA_FOLLOW_DISTANCE_M);
  clampShopCameraHeight();
  clampShopRadius(camera.position, shopMaxRadiusAtWorldZM(camera.position.z, shopMaxRadiusM()));
  // #1631: e2e-only hook (same "expose computed state purely for
  // verification" convention as window.__shopInstanceDisposedCount) --
  // lets a test confirm the avatar/camera's real world z stays under the
  // dome's own real world-space apex (independently recomputed here from
  // shopDomeMesh itself, not from the clamp formula under test) regardless
  // of how large the world has grown, without needing visual inspection.
  window.__shopFlightCeilingDebug = {
    avatarZ: shopAvatarPosition.z,
    cameraZ: camera.position.z,
    domeApexWorldZ: (shopDomeMesh?.position.z ?? 0) + shopDomeRiseM,
    // #1828: lets a test independently verify the avatar/camera stay
    // inside the dome's actual curved cross-section at their own height,
    // not just under its flat apex (which the fields above alone can't
    // distinguish from poking through the dome's curved side lower down).
    avatarRadiusM: Math.hypot(shopAvatarPosition.x, shopAvatarPosition.y),
    cameraRadiusM: Math.hypot(camera.position.x, camera.position.y),
    domeBaseWorldZ: shopDomeMesh?.position.z ?? 0,
    domeRadiusM: shopWorldRadiusM,
    domeRiseM: shopDomeRiseM,
    // #1840: avatarX/avatarY let a test independently reconstruct the
    // leaning avatar mesh's own farthest world-space point (pivot + lean
    // reach in the facing direction, from
    // window.__shopAvatarOrientation's pitchRad/facingRad) and confirm it
    // stays inside the wall's real radius -- not just the clamped pivot
    // itself, which avatarRadiusM above alone can verify.
    avatarX: shopAvatarPosition.x,
    avatarY: shopAvatarPosition.y,
  };
}

// Shopper-vs-placed-item collision (docs/SPEC.md §3's "Shopper collision
// still prevents walking through items") — reuses the same rotated-
// rectangle SAT test Build mode's own item-vs-item collision already uses
// (footprintCorners/footprintsOverlap, near the top of this file),
// approximating the avatar's own footprint as a small square (see
// SHOP_AVATAR_COLLISION_HALF_M) rather than writing separate circle-vs-
// polygon math. Only checks *loaded* landlets' objects (entry.objects) —
// exactly the ones close enough to matter (see updateShopProximity). Each
// object's position is landlet-local (see loadShopLandletInstances), so
// it's translated into world space by adding the landlet group's own
// position before testing.
function shopAvatarFootprintCorners(x, y) {
  const half = shopAvatarCollisionHalfM();
  return [
    [x + half, y + half],
    [x + half, y - half],
    [x - half, y - half],
    [x - half, y + half],
  ];
}

function shopPositionBlocked(x, y, z) {
  const avatarCorners = shopAvatarFootprintCorners(x, y);
  for (const entry of shopLandlets.values()) {
    if (!entry.loaded) continue;
    for (const mesh of entry.objects) {
      // Flooring always renders flush with the ground (see isFlooringTemplate)
      // — it's a walkable surface replacing the default grass, not an
      // obstacle, so it never blocks the shopper the way a real object
      // would (#530).
      if (isFlooringTemplate(mesh.userData.template)) continue;
      const worldX = entry.group.position.x + mesh.position.x;
      const worldY = entry.group.position.y + mesh.position.y;
      const { height } = meshDimensions(mesh);
      // #2852: entry.group.position.z now carries this landlet's real
      // terrain elevation (#2851) -- worldX/worldY above already add the
      // group's own x/y, so z needs the same treatment, or every item on
      // an elevated/sunken landlet collides at its old flat-baseline
      // height instead of its real one.
      const itemZMin = entry.group.position.z + mesh.position.z - height / 2;
      const itemZMax = entry.group.position.z + mesh.position.z + height / 2;
      // #1829: landing (the clamp at #1090, just below) rests the avatar at
      // exactly z === itemZMax -- standing on an object's own top surface,
      // not overlapping it, so this exclusion has to be >= here too, or
      // every subsequent horizontal move at that same z reads as blocked by
      // the very object the avatar is standing on.
      if (z + shopAvatarHeightM() < itemZMin || z >= itemZMax) continue; // no vertical overlap — e.g. flying above it, or standing on top of it
      if (footprintsOverlap(avatarCorners, footprintCorners(mesh, worldX, worldY))) return true;
    }
  }
  return false;
}

// #1090: shopPositionBlocked above only ever gets consulted for horizontal
// moves (moveShopAvatarWithCollision below) — a straight-down landing never
// checks it at all, so descending onto a placed item carries the avatar
// through its solid geometry instead of stopping on top of it the way
// ordinary walking already would. Finds the highest top surface of any
// (non-flooring) object under the avatar's own footprint at world (x, y),
// deliberately ignoring the avatar's current z entirely (unlike
// shopPositionBlocked, which also gates on vertical overlap with a specific
// z) — that's exactly the floor a straight-down descent needs to stop at,
// regardless of how high above it the avatar currently is.
// #2852: the floor a landing (or #2044's landing-spot nudge) rests on
// when there's no placed item underneath -- before #2851's real terrain,
// this was always exactly world z 0 everywhere; now it's this landlet's
// own real elevation (#2851's already-baselined record.elevationM).
// shopCurrentLandletEntry is whichever landlet updateShopLandletInfo last
// resolved the avatar as standing on/near -- close enough for both call
// sites below (the original spot and a #2044 nudge a few meters away,
// never far enough to cross into a different landlet's own elevation in
// practice) without re-deriving "which landlet is (x, y) actually inside"
// from scratch here. Converts world z into this frame's altitude terms,
// same as shopAvatarPosition.z's own formula (curvatureDropM subtracted
// there, so added back here to invert it).
function bareGroundAltitudeM(x, y) {
  return (shopCurrentLandletEntry?.record.elevationM ?? 0) + curvatureDropM(Math.hypot(x, y));
}

function shopLandingObstructionTopZ(x, y) {
  const avatarCorners = shopAvatarFootprintCorners(x, y);
  let topZ = null;
  for (const entry of shopLandlets.values()) {
    if (!entry.loaded) continue;
    for (const mesh of entry.objects) {
      if (isFlooringTemplate(mesh.userData.template)) continue;
      const worldX = entry.group.position.x + mesh.position.x;
      const worldY = entry.group.position.y + mesh.position.y;
      if (!footprintsOverlap(avatarCorners, footprintCorners(mesh, worldX, worldY))) continue;
      const { height } = meshDimensions(mesh);
      // #2852: same entry.group.position.z addition shopPositionBlocked's
      // own itemZMin/itemZMax just above now make -- without it, landing
      // on an item on an elevated/sunken landlet rests at the item's old
      // flat-baseline top instead of its real one.
      const itemZMax = entry.group.position.z + mesh.position.z + height / 2;
      if (topZ === null || itemZMax > topZ) topZ = itemZMax;
    }
  }
  return topZ;
}

// #2477 (sub-issue of #2475): nearest valid sit/lean target (docs/API.md's
// "Sit/lean interaction targets (#2476)") within range of (x, y), for
// updateShopAvatarIdle below to select once an idle episode begins. Scope
// is selection only -- the sit/lean poses that would actually consume this
// are separate, later sub-issues; returning a target here doesn't change
// any currently-visible avatar behavior yet.
//
// offsetXM/offsetYM/facingRad are stored in the template's own local,
// un-rotated model space (docs/API.md's own wording) -- the same centered-
// at-origin space shopPositionBlocked/shopLandingObstructionTopZ above
// already read mesh.position/meshDimensions in, so the offset has to be
// rotated by the placed instance's own mesh.rotation.z before adding it to
// the instance's world position, and heightM (0..height, ground-up in that
// same local space) only ever needs mesh.position.z - height/2 (itemZMin,
// same term shopLandingObstructionTopZ's own itemZMax uses the + half of)
// added to it, not any rotation.
//
// Prefers sit over lean when both are in range (sitting reads as a
// stronger "resting" signal than leaning); within whichever kind,
// #2480 (sub-issue of #2475) picks uniformly at random among every
// in-range candidate of that kind, rather than deterministic nearest-
// wins -- so standing idle in the same spot near several chairs doesn't
// always settle into the exact same one, matching docs/SPEC.md §2's own
// "with randomization" line (the same spirit as the existing stand-sway's
// randomized sway period/head-turn interval just below, applied here to
// *which* target gets picked instead of an ongoing motion parameter).
// Still no pathfinding, matching #2044's own "keep it simple" precedent
// for the sibling landing-spot search above.
const SHOP_IDLE_INTERACTION_SEARCH_RADIUS_M = 3;
export function findShopIdleInteractionTarget(x, y) {
  const sitCandidates = [];
  const leanCandidates = [];
  for (const entry of shopLandlets.values()) {
    if (!entry.loaded) continue;
    for (const mesh of entry.objects) {
      const metadata = mesh.userData.template?.metadata;
      if (!metadata) continue;
      for (const [metadataKey, kind] of [['sitTarget', 'sit'], ['leanTarget', 'lean']]) {
        const target = metadata[metadataKey];
        if (!target) continue;
        const cos = Math.cos(mesh.rotation.z);
        const sin = Math.sin(mesh.rotation.z);
        const worldX = entry.group.position.x + mesh.position.x + (target.offsetXM * cos - target.offsetYM * sin);
        const worldY = entry.group.position.y + mesh.position.y + (target.offsetXM * sin + target.offsetYM * cos);
        const distance = Math.hypot(worldX - x, worldY - y);
        if (distance > SHOP_IDLE_INTERACTION_SEARCH_RADIUS_M) continue;
        const { height } = meshDimensions(mesh);
        (kind === 'sit' ? sitCandidates : leanCandidates).push({
          kind,
          instanceId: mesh.userData.instanceId,
          worldX,
          worldY,
          // #2852: same entry.group.position.z addition shopPositionBlocked
          // and shopLandingObstructionTopZ now make for the same reason --
          // a sit/lean target on an elevated/sunken landlet otherwise
          // resolves to its old flat-baseline height.
          worldZ: entry.group.position.z + mesh.position.z - height / 2 + target.heightM,
          worldFacingRad: mesh.rotation.z + target.facingRad,
          distance,
        });
      }
    }
  }
  const candidates = sitCandidates.length > 0 ? sitCandidates : leanCandidates;
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
// #2477: e2e-only hook, same convention as window.__testNearestOpenLandingSpot
// above -- lets a test drive the real search function directly against
// whatever placed items/metadata a test has actually set up, without
// needing to wait out a real idle episode.
window.__testFindShopIdleInteractionTarget = (x, y) => findShopIdleInteractionTarget(x, y);

// #2044: the spec line SHOP_FLIGHT_TAKEOFF_DURATION_S's own comment above
// flags as deferred ("occupied landing spots offset to nearest open
// space... nothing to occupy a spot with yet") -- now actionable since
// shopOtherAvatars (#1100) tracks other builders' live positions in this
// same landlet. entry.group.position is each one's current interpolated
// render position (updateOtherShopAvatars keeps it live every frame), not
// just its last poll snapshot. Purely horizontal and purely a clearance
// *radius* around each other avatar -- deliberately not reusing
// shopPositionBlocked's rectangular-footprint/vertical-overlap machinery
// (that's #1090's domain, solid placed items, already handled upstream of
// this check), since a landing-spot nudge away from another player doesn't
// need that precision.
function landingSpotOccupiedByAvatar(x, y) {
  const clearanceM = shopAvatarCollisionHalfM() + SHOP_AVATAR_COLLISION_HALF_M;
  for (const entry of shopOtherAvatars.values()) {
    if (Math.hypot(entry.group.position.x - x, entry.group.position.y - y) < clearanceM) return true;
  }
  return false;
}

// Ring search outward from the original landing spot -- kept deliberately
// simple per #2044's own framing ("keep it simple... rather than
// over-engineering") since this only ever needs to nudge a landing a few
// meters, not solve general pathfinding. Gives up and returns the original
// spot past LANDING_SPOT_SEARCH_MAX_RADIUS_M rather than searching forever;
// landing on top of another avatar in that vanishingly unlikely case is no
// worse than today's pre-#2044 behavior.
const LANDING_SPOT_SEARCH_DIRECTIONS = 8;
const LANDING_SPOT_SEARCH_STEP_M = 0.5;
const LANDING_SPOT_SEARCH_MAX_RADIUS_M = 5;
function nearestOpenLandingSpot(x, y) {
  if (!landingSpotOccupiedByAvatar(x, y)) return { x, y };
  for (let radius = LANDING_SPOT_SEARCH_STEP_M; radius <= LANDING_SPOT_SEARCH_MAX_RADIUS_M; radius += LANDING_SPOT_SEARCH_STEP_M) {
    for (let i = 0; i < LANDING_SPOT_SEARCH_DIRECTIONS; i++) {
      const angle = (i / LANDING_SPOT_SEARCH_DIRECTIONS) * Math.PI * 2;
      const candidateX = x + radius * Math.cos(angle);
      const candidateY = y + radius * Math.sin(angle);
      if (!landingSpotOccupiedByAvatar(candidateX, candidateY)) return { x: candidateX, y: candidateY };
    }
  }
  return { x, y };
}
// #2044: e2e-only hook, same convention as window.__testMoveShopAvatarWithCollision
// below -- lets a test drive the search directly (against whatever
// shopOtherAvatars a real second browser session's presence reports have
// actually populated) without needing to choreograph exact flight-landing
// timing against that second session.
window.__testNearestOpenLandingSpot = (x, y) => nearestOpenLandingSpot(x, y);
// #2080: e2e-only hook, same convention as __testNearestOpenLandingSpot
// above -- lets a test compute the real world-boundary radius a landing
// should be clamped to, instead of hardcoding/guessing it.
window.__testShopAvatarMaxRadiusM = () => shopAvatarMaxRadiusM();
// #2852: same e2e-only convention -- lets a test read the real floor a
// landing/item-collision check resolves to at (x, y), to confirm it
// tracks a landlet's own real terrain elevation rather than the old
// flat-baseline-everywhere assumption.
window.__testBareGroundAltitudeM = (x, y) => bareGroundAltitudeM(x, y);
window.__testShopLandingObstructionTopZ = (x, y) => shopLandingObstructionTopZ(x, y);

// Tries the full requested move first; if that's blocked, slides along
// whichever single axis is still open (the same axis-separated collision
// response resolveByAxis/sweepAxis use for Build mode) so grazing a wall
// at an angle slows the shopper down rather than stopping them dead.
function moveShopAvatarWithCollision(dx, dy) {
  const { x, y, z } = shopAvatarPosition;
  if (!shopPositionBlocked(x + dx, y + dy, z)) {
    shopAvatarPosition.x += dx;
    shopAvatarPosition.y += dy;
    return;
  }
  if (!shopPositionBlocked(x + dx, y, z)) {
    shopAvatarPosition.x += dx;
  } else if (!shopPositionBlocked(x, y + dy, z)) {
    shopAvatarPosition.y += dy;
  }
}
// #1829: e2e-only hook for driving the exact real move the joystick
// triggers each frame, without needing a held pointer gesture to actually
// out-race the per-frame updateShopMovement loop. Always inert unless a
// test calls it, same convention as window.__testForceShopProximityCheck.
window.__testMoveShopAvatarWithCollision = (dx, dy) => moveShopAvatarWithCollision(dx, dy);

export function updateShopMovement(now) {
  if (shopLastFrameTime === null) {
    shopLastFrameTime = now;
    return;
  }
  const dt = Math.min((now - shopLastFrameTime) / 1000, 0.1); // clamp against tab-switch-sized gaps
  shopLastFrameTime = now;

  // #1175: any continuous navigation input (look, move, or vertical flight)
  // stops the spawn orbit immediately, the same frame it starts — the
  // discrete fly-button tap handles itself via toggleShopFlight's own
  // stopShopSpawnRotation() call. While the orbit is still running, the
  // blocks below see shopLookX/shopMoveX/shopVerticalInput all still at 0
  // (that's exactly what "no navigation input yet" means) and simply don't
  // fire, so no extra guard is needed to keep them from fighting the orbit.
  if (shopSpawnRotating) {
    if (shopLookX !== 0 || shopLookY !== 0 || shopMoveX !== 0 || shopMoveY !== 0 || shopVerticalInput !== 0) {
      stopShopSpawnRotationForNavigation();
    } else {
      updateShopSpawnRotation(dt);
    }
  }
  // #1176: counts down to the "Go to Last Location" button's own auto-hide
  // (started by stopShopSpawnRotationForNavigation above, or by the fly
  // button's own tap in toggleShopFlight — either way, "the shopper began
  // navigating on their own") independently of whichever phase the orbit
  // or the button's own click sequence is in.
  if (shopLastLocationHideTimerS !== null) {
    shopLastLocationHideTimerS += dt;
    if (shopLastLocationHideTimerS >= SHOP_LAST_LOCATION_BUTTON_HIDE_DELAY_S) {
      shopLastLocationBtn.classList.remove('visible');
      shopLastLocationHideTimerS = null;
    }
  }
  updateGoToLastLocation(dt);

  // #1176: the fade-out/teleport/fade-in sequence owns the camera/avatar
  // completely once it's running (startGoToLastLocation already stopped
  // the spawn orbit before this point) — "no further input needed
  // mid-sequence" per the owner's own spec means real joystick/look input
  // is simply ignored for its duration, rather than fighting a predetermined
  // teleport the moment it lands.
  if (!shopGoToLastLocationPhase && (shopLookX !== 0 || shopLookY !== 0)) {
    shopYaw -= shopLookX * SHOP_LOOK_SPEED_RAD_S * dt;
    shopPitch = Math.max(
      -SHOP_MAX_PITCH,
      Math.min(SHOP_MAX_PITCH, shopPitch - shopLookY * SHOP_LOOK_SPEED_RAD_S * dt),
    );
    applyShopCameraOrientation();
  }

  updateShopFlight(dt);
  const airborne = shopFlightState !== 'grounded';

  let moveMagnitude = 0;
  if (!shopGoToLastLocationPhase && (shopMoveX !== 0 || shopMoveY !== 0)) {
    // Movement stays in the horizontal plane (forward/right with their Z
    // dropped) so looking up or down while walking/flying doesn't also
    // steer altitude — that's updateShopFlight's own separate concern.
    camera.getWorldDirection(shopForward);
    shopForward.z = 0;
    if (shopForward.lengthSq() > 1e-6) shopForward.normalize();
    shopRight.setFromMatrixColumn(camera.matrixWorld, 0);
    shopRight.z = 0;
    if (shopRight.lengthSq() > 1e-6) shopRight.normalize();

    moveMagnitude = Math.min(1, Math.hypot(shopMoveX, shopMoveY));
    // Grounded: the walk/run blend. Airborne (including mid-takeoff/
    // landing, so horizontal speed ramps up smoothly alongside altitude
    // rather than jumping to full flight speed the instant takeoff
    // finishes): docs/SPEC.md §2's altitude/speed curve — see
    // shopFlightSpeedMultiplier and SHOP_FLIGHT_SPEED_EXPONENT's own comment.
    const speed = airborne
      ? SHOP_WALK_SPEED_M_S * shopFlightSpeedMultiplier(shopFlightAltitudeM) * moveMagnitude
      : THREE.MathUtils.lerp(SHOP_WALK_SPEED_M_S, SHOP_RUN_SPEED_M_S, moveMagnitude);
    shopMoveDir
      .set(0, 0, 0)
      .addScaledVector(shopForward, -shopMoveY)
      .addScaledVector(shopRight, shopMoveX);
    if (shopMoveDir.lengthSq() > 1e-6) {
      shopMoveDir.normalize();
      moveShopAvatarWithCollision(shopMoveDir.x * speed * dt, shopMoveDir.y * speed * dt);
      // Turn to face the actual movement direction (left stick), independent
      // of the right stick's camera-look yaw (shopYaw) — the signed angle
      // between shopForward (the world direction shopYaw currently faces)
      // and shopMoveDir gives the facing delta without needing to know the
      // avatar mesh's own local-forward convention. Eased rather than
      // snapped (see SHOP_AVATAR_TURN_EASE_PER_S), and via the shortest
      // angular distance so a near-180-degree reversal doesn't spin the
      // long way around.
      const facingDelta = Math.atan2(
        shopForward.x * shopMoveDir.y - shopForward.y * shopMoveDir.x,
        shopForward.x * shopMoveDir.x + shopForward.y * shopMoveDir.y,
      );
      const targetFacing = shopYaw + facingDelta;
      const turnDelta = Math.atan2(
        Math.sin(targetFacing - shopAvatarFacing),
        Math.cos(targetFacing - shopAvatarFacing),
      );
      setShopAvatarFacing(shopAvatarFacing + turnDelta * Math.min(1, SHOP_AVATAR_TURN_EASE_PER_S * dt));
    }
    // #1840: the extra lean clearance (reserved whenever airborne) is
    // folded into baseMaxRadiusM *before* shopMaxRadiusAtWorldZM (#1839)
    // derives its own clearanceM from it, so the leaning-body margin holds
    // consistently at every height -- both down at the flat wall (this
    // issue's own low-altitude case) and up where the dome's real curved
    // cross-section already narrows the radius on its own (#1839's case).
    clampShopRadius(
      shopAvatarPosition,
      shopMaxRadiusAtWorldZM(shopAvatarPosition.z, shopAvatarMaxRadiusM() - (airborne ? shopAvatarFlightLeanClearanceM() : 0)),
    );
  }

  // #1588: with the setting on, and only while the shopper isn't actively
  // free-looking this frame (shopLookX/shopLookY both 0 — the block above
  // already owns shopYaw whenever that's not true), ease shopYaw toward
  // shopAvatarFacing instead of leaving the camera wherever free-look last
  // pointed it.
  if (!shopGoToLastLocationPhase && shopLookX === 0 && shopLookY === 0 && getShopCameraLockToFacing()) {
    const cameraFacingDelta = Math.atan2(
      Math.sin(shopAvatarFacing - shopYaw),
      Math.cos(shopAvatarFacing - shopYaw),
    );
    if (Math.abs(cameraFacingDelta) > 1e-4) {
      shopYaw += cameraFacingDelta * Math.min(1, SHOP_CAMERA_LOCK_TO_FACING_EASE_PER_S * dt);
      applyShopCameraOrientation();
    }
  }
  // shopFlightAltitudeM is height above *local* ground (unchanged meaning —
  // takeoff/landing, the flight ceiling, and the speed curve all still
  // reason in these terms); the ground itself already sags below the flat
  // z=0 plane by curvatureDropM(distance from origin) everywhere else in
  // this app (landlet ground meshes, the Shop-mode wildGround fill circle —
  // see worker/earthCurvature.js), so the avatar's actual z needs that same
  // term added or it (and the camera anchored to it) floats above ground
  // that's visibly curving away underneath it as it moves outward. z-only,
  // deliberately not reprojecting x/y here too — same "differential sag,
  // not a full re-projection" scope cut relativeCurvatureDropM already
  // documents for ground meshes; see #166.
  shopAvatarPosition.z =
    shopFlightAltitudeM - curvatureDropM(Math.hypot(shopAvatarPosition.x, shopAvatarPosition.y));

  // The walk-cycle and idle sway are both ground-only poses — flying holds
  // a plain neutral pose instead (a real flight pose, arms/legs extended,
  // is future work alongside the rest of a real character rig). Passing
  // moveMagnitude 0 while airborne eases the legs/arms back to neutral the
  // same way stopping on the ground already does, rather than needing a
  // separate code path.
  updateShopAvatarPose(airborne ? 0 : moveMagnitude, dt);
  // #1586: looking around (shopLookX/shopLookY, set above from either
  // joystick) counts as real input too, even when it's the only input and
  // moveMagnitude is 0 — a shopper panning the camera is obviously not AFK.
  const hasActiveInput = moveMagnitude > 0 || shopLookX !== 0 || shopLookY !== 0;
  updateShopAvatarIdle(hasActiveInput, dt);
  // #682: a custom avatar's own named clips, crossfaded to match the same
  // grounded-idle/grounded-moving/airborne state the procedural pose just
  // above already reflects — see setShopAvatarAnimationState's own
  // comment. mixer.update always runs (a fading-out action's own blend
  // still needs frames after the state that started it has already
  // changed), setShopAvatarAnimationState only changes anything on an
  // actual state transition.
  shopAvatar.mixer?.update(dt);
  setShopAvatarAnimationState(shopAvatar, airborne ? 'fly' : (moveMagnitude > SHOP_AVATAR_ANIM_WALK_THRESHOLD ? 'walk' : 'idle'));
  updateShopItemHandling(dt, airborne ? 0 : moveMagnitude, airborne);
  // Owner (N46): flying tips the avatar toward SHOP_AVATAR_FLIGHT_PITCH_RAD
  // instead of staying upright; landing eases it back to 0. The avatar
  // faces its own movement direction (shopAvatarFacing, turned by the left
  // stick above), not the camera's look direction (shopYaw, the right
  // stick) — a standard third-person rig where free-look and facing are
  // independent. Plus a small idle weight-shift offset when standing still.
  //
  // #1168: yaw and pitch are composed as a single quaternion, yaw applied
  // first (establishing which way the body faces) and pitch second (tilting
  // around the local left-right axis that yaw just produced) — see
  // SHOP_AVATAR_FLIGHT_PITCH_RAD's own comment above for why two
  // independent `.rotation.x`/`.rotation.z` Euler fields (the old code
  // here) can't express this and always tilted the same way regardless of
  // facing direction.
  // #2479: leanBlend is shopIdleBlend's own ease-in/hard-cut-out, gated to
  // only the frames a lean target is actually active for this idle episode
  // (shopLeanBlend, same shape as shopSitBlend -- 0 whenever
  // shopIdleInteractionTarget is null or 'sit'), so this term is a harmless
  // no-op outside an actual lean.
  const targetAvatarPitch = airborne ? SHOP_AVATAR_FLIGHT_PITCH_RAD : SHOP_LEAN_PITCH_RAD * shopLeanBlend;
  shopAvatarPitch += (targetAvatarPitch - shopAvatarPitch) * Math.min(1, SHOP_AVATAR_FLIGHT_PITCH_EASE_PER_S * dt);
  scratchAvatarYawQuat.setFromAxisAngle(SHOP_AVATAR_YAW_AXIS, shopAvatarFacing + shopIdleSwayYawOffset + shopSitYawOffset + shopLeanYawOffset);
  scratchAvatarPitchQuat.setFromAxisAngle(SHOP_AVATAR_PITCH_AXIS, shopAvatarPitch);
  shopAvatar.group.quaternion.copy(scratchAvatarYawQuat).multiply(scratchAvatarPitchQuat);
  // #1168: same reasoning as window.__shopAvatarMetrics above — this file's
  // own three.js-dependent orientation math has no unit-test pool to live
  // in (vitest.config.js's own note), so e2e is how it gets verified. A
  // plain, frame-updated snapshot (not the live THREE.Quaternion itself,
  // which Playwright's page.evaluate can't structured-clone) is enough for
  // a test to confirm the tilt direction actually tracks shopAvatarFacing
  // rather than staying fixed. leanBlend (#2479) lets a test confirm the
  // lean pose is actually easing in/out rather than just checking the
  // position/facing ended up in the right place.
  window.__shopAvatarOrientation = { facingRad: shopAvatarFacing, pitchRad: shopAvatarPitch, quaternion: shopAvatar.group.quaternion.toArray(), leanBlend: shopLeanBlend };
  // #2744: same reasoning as window.__shopAvatarOrientation above — a
  // custom avatar's own idle/walk/fly crossfade (setShopAvatarAnimationState)
  // has no other way for a test to confirm it's actually transitioning
  // states as movement starts/stops, not just that an action exists.
  window.__shopAvatarAnimState = shopAvatar.animState;
  // #1588: same reasoning as window.__shopAvatarOrientation above — shopYaw
  // (the free-look camera's own heading) has no other way for a test to
  // read it, and the camera-lock-to-facing setting needs to confirm it
  // actually moves (or doesn't) relative to shopAvatarFacing.
  window.__shopCameraYaw = shopYaw;
  // #1586: same reasoning as window.__shopAvatarOrientation just above —
  // the AFK sprite's own opacity is otherwise only checkable by eye.
  window.__shopAfkOpacity = shopAvatar.afkSprite.material.opacity;
  shopAvatar.group.position.copy(shopAvatarPosition);
  // #2478: visual-only (see shopSitHeightOffset's own declaration for why
  // this never touches the real shopAvatarPosition.z that positionShopCamera
  // and collision/curvature code key off just below/above).
  shopAvatar.group.position.z += shopSitHeightOffset;
  // #2479: same visual-only discipline as #2478's height offset just
  // above, extended to all three axes (see shopLeanPositionOffset's own
  // declaration for why).
  shopAvatar.group.position.x += shopLeanPositionOffset.x;
  shopAvatar.group.position.y += shopLeanPositionOffset.y;
  shopAvatar.group.position.z += shopLeanPositionOffset.z;
  positionShopCamera();

  if (now - shopLastProximityCheck >= SHOP_PROXIMITY_INTERVAL_MS) {
    shopLastProximityCheck = now;
    updateShopProximity();
    updateShopLandletInfo();
  }
  // #1100: updateShopLandletInfo just above has already refreshed
  // shopCurrentLandletEntry for this frame, so both the report (which
  // landlet to tag this position with) and the poll (which landlet's other
  // avatars to ask for) below see the current one.
  reportOwnPresenceIfNeeded(now);
  pollNearbyPresenceIfNeeded(now);
  pollNearbyChatIfNeeded(now);
  updateOtherShopAvatars(now);
  // #2818: after updateOtherShopAvatars above, so this frame's distance
  // checks read this tick's own smoothed/interpolated positions, not last
  // frame's stale ones.
  updateShopVoiceChatIfNeeded(now);
  updateSignFade();
  updateCalendarFade();
  updateReviewFade();
  updateCreditOrbs(dt);
  updateCreditOrbPopEffects(dt);
  if (now - lastScheduledEventCheck >= SCHEDULED_EVENT_CHECK_INTERVAL_MS) {
    lastScheduledEventCheck = now;
    checkScheduledCalendarEvents();
  }
  updateConfettiBursts(dt);
  updateShopAttention(dt);
}

// Every frame's own nearest-in-view-and-range placed item, with how long
// it's continuously held that spot — see shopAttentionTarget's own comment
// above for why this is separate from updateShopProximity/updateXFade's
// nearest-in-range-only pattern. "In view" is a plain FOV cone test (the
// vector from the shopper's own head anchor to the item's world position
// falls within SHOP_ATTENTION_FOV_COS of the camera's own forward
// direction), not a real occlusion/raycast check — deliberately cheap, and
// good enough for "is the shopper roughly looking this way," which is all
// sustained attention actually needs.
//
// #1592: anchored on shopCameraAnchor (the shopper's own head position,
// already refreshed for this frame by positionShopCamera() just above in
// updateShopMovement), not camera.position — Shop mode's camera is a chase
// camera trailing SHOP_CAMERA_FOLLOW_DISTANCE_M *behind* that anchor, and
// using the camera's own, further-back position here let an item sitting
// just behind the shopper still register as "ahead" of the camera. See
// attention.js's own attentionDistanceAndDot comment for the full math.
//
// #1814: the in-view direction itself must be the avatar's own body facing
// (shopAvatarFacing), not the camera's look direction — #1592 fixed only
// the anchor *position*, so a camera-only glance (right-stick free-look
// without the avatar's body actually turning that way) could still trigger
// sustained attention, and so the item-handling reach pose, while the
// avatar's body faced some other way entirely. yawRotatedForward derives
// the equivalent body-facing-horizontal forward from the camera's own
// forward — see its own comment for why that's exact, not a guess.
function updateShopAttention(dt) {
  camera.getWorldDirection(scratchAttentionForward);
  scratchAttentionForward.z = 0;
  if (scratchAttentionForward.lengthSq() > 1e-6) scratchAttentionForward.normalize();
  const bodyForward = yawRotatedForward(scratchAttentionForward, shopYaw, shopAvatarFacing);
  const candidates = [];
  for (const entry of shopLandlets.values()) {
    if (!entry.loaded) continue;
    for (const mesh of entry.objects) {
      const world = mesh.getWorldPosition(scratchAttentionWorldPos);
      const { distanceM, dot } = attentionDistanceAndDot(shopCameraAnchor, bodyForward, world);
      if (distanceM > SHOP_ATTENTION_RADIUS_M) continue;
      candidates.push({ id: mesh, distanceM, dot });
    }
  }
  const candidateId = pickNearestInRange(candidates, { radiusM: SHOP_ATTENTION_RADIUS_M, fovCos: SHOP_ATTENTION_FOV_COS });
  shopAttentionElapsedS = nextAttentionElapsedS(candidateId, shopAttentionTarget, shopAttentionElapsedS, dt);
  shopAttentionTarget = candidateId;
}

// The actual trigger #216's item-handling animations (and any future
// consumer) should check, rather than reaching into shopAttentionTarget/
// shopAttentionElapsedS's raw values directly.
function hasSustainedShopAttention() {
  return hasSustainedAttention(shopAttentionTarget, shopAttentionElapsedS, SHOP_ATTENTION_DWELL_S);
}

// Called every frame right after updateShopAvatarPose/updateShopAvatarIdle,
// whose arm/yaw values it adds on top of — see shopHandlingTarget's own
// comment above for why this doesn't touch shopAvatarPosition at all.
// Starting a play requires being grounded and not already moving (walking
// and item-handling are mutually exclusive, the same rule
// updateShopAvatarIdle's own comment already documents for idle); once
// started, shouldEndItemHandling decides when it stops.
function updateShopItemHandling(dt, moveMagnitude, airborne) {
  if (!shopHandlingActive && !airborne && moveMagnitude === 0 && hasSustainedShopAttention()) {
    shopHandlingActive = true;
    shopHandlingTarget = shopAttentionTarget;
    shopHandlingElapsedS = 0;
    shopHandlingPhase = 0;
  }
  if (shopHandlingActive) {
    shopHandlingElapsedS += dt;
    if (shouldEndItemHandling({ airborne, moveMagnitude, elapsedS: shopHandlingElapsedS, maxDurationS: SHOP_HANDLING_MAX_DURATION_S })) {
      shopHandlingActive = false;
    }
  }

  shopHandlingBlend = nextHandlingBlend(shopHandlingBlend, shopHandlingActive, SHOP_HANDLING_BLEND_PER_S, dt);
  if (shopHandlingBlend < 1e-3) {
    shopHandlingTarget = null;
    return;
  }

  const { width, depth, height } = meshDimensions(shopHandlingTarget);
  const kind = classifyHandlingKind(Math.max(width, depth, height), SHOP_ITEM_SMALL_MAX_DIMENSION_M);

  if (kind === 'pick-up-and-turn') {
    shopHandlingPhase = nextPhase(shopHandlingPhase, SHOP_HANDLING_TURN_PERIOD_S, dt);
    const raise = SHOP_HANDLING_ARM_RAISE_RAD * shopHandlingBlend;
    shopAvatar.armPivotL.rotation.x -= raise;
    shopAvatar.armPivotR.rotation.x -= raise;
    addShopIdleSwayYawOffset(Math.sin(shopHandlingPhase) * SHOP_HANDLING_TURN_AMPLITUDE_RAD * shopHandlingBlend);
  } else {
    // walk-around: a continuous one-direction spin (phase used directly as
    // a yaw angle, not run through sin like the back-and-forth sway
    // above) — reads as circling the item to view every side, purely
    // through body rotation. No arm raise: nothing's being held.
    shopHandlingPhase = nextPhase(shopHandlingPhase, SHOP_HANDLING_SPIN_PERIOD_S, dt);
    addShopIdleSwayYawOffset(shopHandlingPhase * shopHandlingBlend);
  }
}

// The creative-tool trigger itself (docs/SPEC.md §6's own "scheduled
// confetti-cannon" example, docs/API.md's "Community calendar"). Checked
// periodically (SCHEDULED_EVENT_CHECK_INTERVAL_MS) across every currently-
// loaded calendar's already-fetched events, rather than re-fetching the
// events list itself — a stale local isCommunityCalendar event cache
// missing a brand-new event from another session is an acceptable gap for
// a purely-cosmetic effect, and re-fetching every check would mean a
// network round trip per calendar every 10 seconds regardless of whether
// anything's actually due.
const SCHEDULED_EVENT_CHECK_INTERVAL_MS = 10000;
let lastScheduledEventCheck = 0;


// #1175 (docs/SPEC.md §1/§2): bundles enterShopMode's own spawn-sequence
// reset -- every spawn (not just a first-ever visit) starts already
// flying, above a random world location, facing the world center, and
// slowly orbiting it clockwise until the shopper gives any navigation
// input (see updateShopSpawnRotation/stopShopSpawnRotation). Takes the
// caller's own pickShopSpawnLocation() result directly rather than
// reaching for it itself, since that function (water-avoidance rerolling)
// stays in main.js. Mirrors shop/avatar.js's own resetShopAvatarIdleState()
// precedent: an exported reset function in place of enterShopMode directly
// assigning ~15 of this leaf's own now-private fields, which an ES import
// binding can't do from outside this module.
export function beginShopSpawn(spawnOrbitRadiusM, yaw) {
  shopSpawnOrbitRadiusM = spawnOrbitRadiusM;
  shopYaw = yaw;
  shopSpawnRotating = true;
  shopAvatarPosition.x = shopSpawnOrbitRadiusM * Math.sin(shopYaw);
  shopAvatarPosition.y = -shopSpawnOrbitRadiusM * Math.cos(shopYaw);
  shopFlightState = 'flying';
  shopFlightTransitionElapsedS = 0;
  shopFlightAltitudeM = SHOP_SPAWN_START_ALTITUDE_M;
  // Normally kept in sync every frame by the update loop (see
  // shopFlightAltitudeM's own comment) — set once here too so the
  // positionShopCamera() call below (synchronous, before that loop's first
  // tick) doesn't position the camera against a stale z.
  shopAvatarPosition.z =
    shopFlightAltitudeM - curvatureDropM(Math.hypot(shopAvatarPosition.x, shopAvatarPosition.y));
  shopUpHeld = false;
  shopDownHeld = false;
  shopVerticalInput = 0;
  setShopFlyBtnFlying(true);
  // #1176: the "Go to Last Location" button, offered only when there's
  // actually somewhere to offer — reset alongside the rest of this
  // function's own re-entrant spawn state (Shop mode being re-enterable
  // without a reload) rather than carrying over a previous round trip's
  // now-stale countdown/sequence state.
  shopLastLocationHideTimerS = null;
  shopGoToLastLocationPhase = null;
  shopGoToLastLocationElapsedS = 0;
  shopLastLocationBtn.classList.toggle('visible', !!shopLastLocation);

  // #1591: this used to reuse shopPitch's own default grounded value
  // (-0.12 rad, ~7deg down — a natural "standing and looking slightly
  // down" neutral), nowhere near enough tilt to actually see the world
  // below from SHOP_SPAWN_START_ALTITUDE_M. At that near-level angle the
  // "aerial shot" spent its whole orbit looking at the horizon/wall ring
  // instead of down at the world it's supposed to be showing off.
  // SHOP_MAX_PITCH itself — the same "looking well down" extreme normal
  // free-look is already bounded to — is the right pitch here too: the
  // camera is looking down at the whole world from above, not at a nearby
  // build.
  shopPitch = -SHOP_MAX_PITCH;
  // shopYaw (set above, the orbit's starting angle) already faces the
  // world center — see updateShopSpawnRotation's own comment on why that
  // single angle does double duty as both the camera's look direction and
  // the orbit position.
  setShopAvatarFacing(shopYaw);
  shopAvatarPitch = 0;
  applyShopCameraOrientation();
  positionShopCamera();
  setShopFov(camera.fov); // re-clamp in case a previous Shop session left it zoomed
  shopLastFrameTime = null;
  shopLastProximityCheck = 0;
}
