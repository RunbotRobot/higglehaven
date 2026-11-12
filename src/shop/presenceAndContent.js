// #2626 (leaf of #2563, itself part of #2504/#2500's src/main.js module
// split -- see #2503's design comment and #2563's own breakdown comment
// for the full dependency map): Shop mode's proximity-driven landlet
// instance loading/unloading and LOD banding, multiplayer presence
// (report/poll/smoothing/despawn), and credit orbs (load/unload, shimmer,
// collection, the +1-credit toast and offline notice) -- bundled together
// because updateShopProximity's own landlet load/unload directly drives
// loadCreditOrbsForLandlet/unloadCreditOrbsForLandlet, so splitting credit
// orbs out further would just mean this module importing from both anyway
// with no real decoupling benefit.
//
// Depends on shop/avatar.js (#2623, avatar creation for other shoppers) and
// shop/flightMovement.js (#2624, flight/altitude state for credit-orb
// collection's altitude gate and the spawn-location picker's own max
// radius) -- both already landed.
//
// Deliberately NOT included here, even though it's declared and called
// right alongside this module's own functions in main.js -- a genuinely
// different concern that happens to be interleaved there, not
// presence/content: unloadShopLandletInstances (the claimed-landlet
// counterpart to loadShopLandletInstances above) stays in main.js -- it
// tears down signs/calendars/reviews (now shop/worldSprites.js's own
// territory, #2627, landed) alongside a landlet's placed instances, so
// moving it here would mean importing all of that back just to dispose it.
// This module calls it as a forward import instead, the same shape
// shop/avatar.js's own header comment documents for its own not-yet-
// extracted dependents. growShopDomeIfNeeded (shop/sky.js's own territory,
// #2625) and registerShopSign/registerShopCalendar/registerShopReview
// (shop/worldSprites.js, #2627) are each called here but defined in their
// own leaf modules, not main.js -- imported directly from there below,
// not forwarded through main.js.
//
// shopAvatarPosition/shopAvatarFacing (the avatar's own real, authoritative
// ground-truth position/facing) stay in main.js, same reasoning
// shop/avatar.js's own header comment gives -- read here, never reassigned
// by this module.
//
// shopBuilderLabels/shopCurrentLandletEntry move here (updateShopLandletInfo's
// own state), but main.js's enterShopMode still needs to reset/replace them
// at Shop-mode bootstrap -- an ES import binding is read-only from the
// importing side, so main.js gets setShopBuilderLabel/setShopBuilderLabels/
// resetShopCurrentLandletEntry rather than reassigning directly, same shape
// shop/avatar.js's own setShopAvatar/main.js's own setShopAvatarFacing
// already established. accountSessionEnding/setAccountSessionEnding move
// here too (hasVerifiedSession's own exclusive dependency, flagged by its
// own prior comment as "pending its own future extraction") --
// src/account/auth.js's delete-account flow now imports setAccountSessionEnding
// from here instead of main.js.
//
// pointInPolygonXY stays in main.js -- shared with computeGaplessWorldRadius
// there (an unrelated world-generation-preview calculation), not exclusive
// to this module's own landletContainsPoint. SHOP_LOAD_RADIUS_M is exported
// back to main.js for the same reason -- addBuildModeNeighborOutlines there
// reuses it for an unrelated Build-mode neighbor-outline radius.
import * as THREE from 'three';
import { camera, scene } from '../world/scene.js';
import { worldWorkQueue } from '../world/frameBudgetQueue.js';
import { createArrivalRun, aliveArrivalFogCount } from './arrivalRun.js';
import { setInstanceLodState, attachInstanceTiers, loadTierScenes, loadFarViewSource, disposeObject, extensibleAxes, createMeshForInstance, createPlacementHandle, loadBatchSource, loadModelInstance, loadModelAnimations, meshDimensions, findTemplate } from '../world/models.js';
import { groupPlacements, placementTopZ } from './instanceBatching.js';
import { buildInstancedBatch } from './instancedBatches.js';
import { createFarView } from './farView.js';
import { apparentSizePx, nextTier, budgetedTiers, isNearFullDetail, setBoundingSphere, TIER_FULL } from './lodTier.js';
import { sampleUniformDiskRadiusM } from '../spawnLocation.js';
import { pickAvatarClips } from '../avatarClipNames.js';
import { isNetworkError } from '../build/scene.js';
import { currentAuthUser } from '../account/auth.js';
import {
  fetchLandlet, fetchLandletVersion, fetchInstances, fetchAllLandlets,
  fetchFarPlacements, fetchCreditOrbs, fetchCreditOrbStanding, collectCreditOrb, reportPresence, fetchNearbyPresence,
} from '../api.js';
import { applyAssistantLook } from './assistantAvatar.js';
import { createShopAvatar, setShopAvatarAnimationState, CUSTOM_AVATAR_FRONT_YAW_RAD, shopAvatarCollisionHalfM } from './avatar.js';
import { creditOrbContact, creditOrbRefusalKind, creditOrbMayRetry, CREDIT_ORB_RETRY_INTERVAL_MS } from './creditOrbCollect.js';
import {
  normalizeEquippedAvatar, normalizeEquippedAnimation, chooseAllowedTemplateIds, desiredAvatarFor,
  animationForAvatar, locomotionStateFor,
} from './otherAvatarModels.js';
import { shopMaxRadiusM, shopFlightState, shopFlightAltitudeM } from './flightMovement.js';
import { growShopDomeIfNeeded, growShopDomeToHeight } from './sky.js';
import {
  SHOP_BASE_LOAD_RADIUS_M, SHOP_BASE_UNLOAD_RADIUS_M, shopUnloadRadiusM, horizontalDistanceM, pickLandletsToLoad,
} from './loadRadius.js';
import {
  shopAvatarPosition, shopAvatarFacing, pointInPolygonXY, plotColorKeyForLandlet,
} from '../main.js';
// #2629: disposeObject3D/unloadShopLandletInstances now live in
// src/shop/mode.js (a sibling-module, not reverse-, import) -- mode.js's
// own enterShopMode in turn imports shopLandlets/pickShopSpawnLocation/etc.
// from this module, same mutually-dependent shape flightMovement.js's own
// header comment already documents for shop/avatar.js and itself.
import { disposeObject3D, unloadShopLandletInstances, buildShopGroundMesh } from './mode.js';
import { registerShopSign, registerShopCalendar, registerShopReview } from './worldSprites.js';
import { rateLimitNoticeText } from '../rateLimitNotice.js';
import { creditOrbStandingState, creditOrbLimitNow } from './creditOrbStanding.js';
import { recordVisibleMessage } from '../ui/visibleMessages.js';

const shopCreditOrbToastEl = document.getElementById('shop-credit-orb-toast');
const shopCreditOrbOfflineNoticeEl = document.getElementById('shop-credit-orb-offline-notice');
const shopCreditOrbRateLimitNoticeEl = document.getElementById('shop-credit-orb-rate-limit-notice');
const shopCreditOrbProblemNoticeEl = document.getElementById('shop-credit-orb-problem-notice');
export const accountMenuLandletInfoEl = document.getElementById('account-menu-landlet-info');

// #1630: how many times pickShopSpawnLocation will reroll a candidate that
// landed on a water landlet before giving up and using it anyway -- a
// bound, not a tuned value, purely so a (realistically impossible) world
// that's entirely water can't spin this loop forever.
const SHOP_SPAWN_LOCATION_MAX_ATTEMPTS = 20;

// This near/far load-unload distance (plus the per-item level of detail just
// below, docs/SPEC.md §1 "Chunk loading") is the only chunk loading that
// exists today — the far view of every landlet out to the horizon (#3412,
// #3418) isn't built yet (still just the flat sky-dome color beyond
// SHOP_UNLOAD_RADIUS_M), so there's no per-band curvature concern to check
// for it yet. And even if there were:
// worker/earthCurvature.js's curvatureDropM says the real curved surface
// sags a mere ~0.3-0.6mm below the flat plane at these radii, ~2cm even out
// at 500m, and still only ~8cm at a hypothetical 1km world radius (this
// world starts at ~31.6m and grows just 10m per expansion, so reaching even
// 500m is already a very mature world) — all comfortably imperceptible
// against a 60m-tall wall/dome backdrop and typical camera distances. The
// same conclusion covers the middle-LOD band's own two thresholds below,
// since both sit inside this already-analyzed 60-90m range. Revisit only
// once the far band's actual backdrop rendering exists to hang a per-band
// decision on; there's nothing here today for curvature to change.
// #2626: exported -- main.js's own addBuildModeNeighborOutlines (Build
// mode, unrelated to Shop presence) reuses this same radius for its own
// neighbor-outline cutoff.
// #3261: these two are the GROUND-LEVEL radii (see src/shop/loadRadius.js for
// the altitude-scaled ones updateShopProximity actually uses for claimed
// landlets' content, and why). They still anchor the middle-LOD band below
// and the credit-orb load, and SHOP_LOAD_RADIUS_M is still what main.js reuses.
export const SHOP_LOAD_RADIUS_M = SHOP_BASE_LOAD_RADIUS_M;
const SHOP_UNLOAD_RADIUS_M = SHOP_BASE_UNLOAD_RADIUS_M;
// #2378/#3373: an item's level of detail (full model near, a coloured box once it
// is small on screen) is decided per item by its apparent size, not by a fixed
// distance from the landlet; see src/shop/lodTier.js for the rule, its
// hysteresis and the cap on full-detail items, and updateInstanceLodTiers below.

// #1100 (sub-issue of #1095, multiplayer presence): report/poll cadence
// for seeing other avatars live in Shop mode. Report stays comfortably
// under #1098's own server-side rate limit (600 per the shared 15-minute
// window, ~1 write per 1.5s sustained) even at this interval's floor;
// poll is independent of the report interval -- it only bounds how often
// this client re-renders other avatars, not how often it writes its own.
const SHOP_PRESENCE_REPORT_INTERVAL_MS = 1500;
const SHOP_PRESENCE_POLL_INTERVAL_MS = 1000;
// #2436: how many consecutive polls an avatar must be missing from before
// pollNearbyPresenceIfNeeded actually despawns it -- see that function's
// own comment for why a single missed poll isn't enough.
const SHOP_OTHER_AVATAR_MISSED_POLLS_BEFORE_DESPAWN = 2;
// Below this, a report would just be re-sending the same position/heading
// the server already has -- skip it entirely (client-side throttling,
// #1098's own POST endpoint explicitly left to this sub-issue) rather than
// spending part of the per-builder rate-limit budget on a no-op write.
const SHOP_PRESENCE_MOVE_THRESHOLD_M = 0.1;
const SHOP_PRESENCE_HEADING_THRESHOLD_RAD = 0.05;
// A player who stops moving entirely (reading a sign, browsing a shop
// item) shouldn't silently vanish from everyone else's screen once
// #1099's own PRESENCE_STALE_AFTER_MS (10s) passes with no fresh write —
// that's exactly the "flicker out" migrations/0100 says a few merely-
// missed reports shouldn't cause. This keeps a motionless player's row
// fresh regardless of movement, with 3x margin under that 10s cutoff so
// even one dropped heartbeat doesn't go stale.
const SHOP_PRESENCE_HEARTBEAT_INTERVAL_MS = 3000;

// Credit orbs (#1995, sub-issue of #1976) — a much tighter radius than
// SIGN_INTERACT_RADIUS_M, since collection is automatic on proximity alone
// (the owner's own spec: "the orb stays there until an avatar collects
// it" — no tap required), not a hint a shopper opts into by tapping.
// Floats at a fixed height above the spawned ground position (#1994's own
// z_m is always 0) purely for visual legibility — walking "through" it at
// avatar height is the intended collection gesture, not a bug.
// #3392: horizontal tolerance for the altitude rule below only; contact itself is
// the avatar's body meeting the orb's surface (creditOrbContact, reach =
// avatar footprint half-width + CREDIT_ORB_RADIUS_M), no longer a 1.5 m ring.
const CREDIT_ORB_COLLECT_RADIUS_M = 1.5;
const CREDIT_ORB_FLOAT_HEIGHT_M = 1.2;
// #2443: how far above local ground (shopFlightAltitudeM, not world z --
// a landlet's own group sits at a fixed world z of exactly 0 regardless of
// distance from the origin, per #1871's "addLandletToScene" group.position
// call, while shopAvatarPosition.z is deliberately sunk by
// curvatureDropM(distance from origin) as a pure rendering trick; comparing
// world z values would conflate that offset with real altitude) the avatar
// can be and still have this count as a ground walk-in rather than flying
// over it. Reuses CREDIT_ORB_COLLECT_RADIUS_M's own scale as a reasonable
// near-ground margin (covers the walk cycle's own small vertical bob and any
// ground-incline slack) -- tight enough that a real flight altitude no
// longer collects, per the owner's own report.
const CREDIT_ORB_COLLECT_ALTITUDE_TOLERANCE_M = CREDIT_ORB_COLLECT_RADIUS_M;
const CREDIT_ORB_RADIUS_M = 0.25;
const CREDIT_ORB_ROTATION_SPEED_RAD_S = 1.4;
// Shimmer: emissiveIntensity oscillates between these two bounds rather
// than sitting at one fixed brightness — "shimmery" per the owner's own
// spec, not just "glowing."
const CREDIT_ORB_SHIMMER_SPEED_RAD_S = 3.2;
const CREDIT_ORB_SHIMMER_MIN = 0.6;
const CREDIT_ORB_SHIMMER_MAX = 1.8;
// How long the "+1 free model-generation credit!" toast stays visible
// after a successful collect, matching #shop-last-location-btn's own
// opacity-transition show/auto-hide shape (see its CSS comment in
// index.html) rather than a hard show/hide cutoff.
const CREDIT_ORB_TOAST_VISIBLE_MS = 3000;
// #2447: how long an unbroken streak of genuine network failures (fetch()
// itself rejecting, never a real HTTP response -- see isNetworkError)
// collecting any orb has to persist before this reads as "offline" rather
// than a single dropped frame. A real HTTP response of any status (403/
// 404/429/500) proves the server is reachable and resets this streak --
// only true network errors count toward it.
const CREDIT_ORB_OFFLINE_NOTICE_THRESHOLD_MS = 3000;
// Reported directly by a player ("It won't let me collect more orbs!"):
// a 429 from CREDIT_ORB_COLLECT_RATE_LIMIT_MAX (worker/lib/credit-orbs.js)
// used to fall into the generic "leave it in place, retry next frame"
// branch below with no message at all -- and since updateCreditOrbs runs
// unthrottled every frame, standing near any orb past the limit retried
// (and got 429'd) up to 60 times a second for as long as the shopper stood
// there, not just once. This both surfaces a clear reason and stops that
// retry storm for a cooldown once the limit is actually hit.
const CREDIT_ORB_RATE_LIMIT_RETRY_COOLDOWN_MS = 30000;

export const shopLandlets = new Map(); // landletId -> { record, group, loaded, loadToken, objects }
export let shopBuilderLabels = new Map(); // builderId -> label, fetched once in enterShopMode, patched on an in-session rename (#741) — see updateShopLandletInfo
// #2626: main.js's own enterShopMode replaces this wholesale once the real
// labels are fetched -- an ES import binding is read-only from the
// importing side, so that reassignment needs this setter rather than a
// direct assignment, same shape main.js's own setShopAvatarFacing already
// established.
export function setShopBuilderLabels(map) {
  shopBuilderLabels = map;
}
// #2626: src/build/scene.js's own renderBuilderIdentityField onRenamed
// callback (#2565) patches a single label in place on a successful rename
// (#741) -- a
// dedicated setter rather than exposing the Map itself for `.set()`, same
// "narrow the exposed surface to the one real operation" reasoning as
// shop/avatar.js's own addShopIdleSwayYawOffset.
export function setShopBuilderLabel(builderId, label) {
  shopBuilderLabels.set(builderId, label);
}
// #2852: exported (same plain-`let`-binding shape shopDomeRiseM already
// uses, per that export's own comment -- a live ES binding, no getter
// needed for a read-only consumer) so flightMovement.js's landing code can
// read the current landlet's own elevationM for bare-ground resting
// height, the same landlet updateShopLandletInfo below already resolves
// for presence reporting.
export let shopCurrentLandletEntry = null; // whichever shopLandlets entry the shopper is standing on, else null — see updateShopLandletInfo
// #2626: main.js's own enterShopMode forces this back to null at Shop-mode
// bootstrap (and again once shopBuilderLabels' real labels land) to force
// updateShopLandletInfo's own change-detection to recompute/re-render --
// see that function's own comment. Exported setter, same reasoning as
// setShopBuilderLabels above.
export function resetShopCurrentLandletEntry() {
  shopCurrentLandletEntry = null;
}
// #1100: the own-position report loop's own throttle state — see
// reportOwnPresenceIfNeeded.
let shopLastPresenceReportAt = 0;
let shopLastReportedPosition = null; // { x, y, z }, whatever was last actually sent
let shopLastReportedHeading = null;
let shopLastReportedLandletId; // undefined until the first report ever goes out — see reportOwnPresenceIfNeeded
let shopLastReportedFlying; // #2043: same undefined-until-first-report shape as shopLastReportedLandletId above
// #1100: the other-avatars poll loop's own throttle state and live set —
// see pollNearbyPresenceIfNeeded/updateOtherShopAvatars. builderId -> {
// group, fromX/Y/Z/Heading (previous poll's position, lerp start),
// toX/Y/Z/Heading (latest poll's position, lerp target), receivedAt (when
// the latest poll landed, for timing the lerp against), lerpDurationMs
// (#2864: the real elapsed time since the *previous* snapshot, used as
// this lerp's own duration instead of always assuming exactly
// SHOP_PRESENCE_POLL_INTERVAL_MS — see pollNearbyPresenceIfNeeded's own
// comment on why that fixed assumption produces a visible freeze/catch-up
// snap under an uneven poll cadence) }.
export const shopOtherAvatars = new Map();

// #3447: the assistant, if any, whose drawn avatar a raycast hit belongs to.
// Walks up from the hit mesh to the avatar's group; only assistants answer a tap.
export function assistantFromHit(hit) {
  for (const entry of shopOtherAvatars.values()) {
    if (!entry.assistantName || !entry.userId) continue;
    for (let node = hit.object; node; node = node.parent) {
      if (node === entry.group) return { userId: entry.userId, name: entry.assistantName };
    }
  }
  return null;
}

// #3447: every assistant avatar currently drawn, as raycast targets.
export function assistantGroups() {
  return [...shopOtherAvatars.values()].filter((entry) => entry.assistantName && entry.userId).map((entry) => entry.group);
}
// #2045: templateId -> when its model last failed to load (fail open: the
// default body is shown and the load is retried only after
// CUSTOM_AVATAR_RETRY_AFTER_MS, see otherAvatarModels.js).
const otherAvatarModelFailedAt = new Map();
// #3230: same idea for applied-animation files that failed to load -- the
// avatar plays its own clips until the retry window (see
// CUSTOM_AVATAR_RETRY_AFTER_MS) passes.
const otherAvatarAnimationFailedAt = new Map();
let shopLastPresencePollAt = 0;
let presenceAppliedToken = 0; // #3349: token of the newest poll response applied so far
let presencePollToken = 0; // #1911: guards pollNearbyPresenceIfNeeded against a stale out-of-order response
// #1995: every currently-loaded credit orb: { mesh, group, orbId, landletId }.
// Unlike shopSigns/shopCalendars (main.js, worldSprites.js's own not-yet-
// extracted territory), an orb isn't a placed instance at all (#1994's own
// data model, a separate credit_orbs table keyed only by landlet) — so
// it's fetched and added alongside a landlet's own instances in
// loadShopLandletInstances rather than discovered via any instance's
// userData, but torn down the identical way in unloadShopLandletInstances.
const shopCreditOrbs = [];

// #3261: distance is measured from the AVATAR (horizontal), not the camera --
// in flight the chase camera trails well behind and above the avatar, so a
// camera-based distance left the plot directly under the shopper unloaded. A
// claimed landlet's content loads inside an altitude-scaled radius
// (loadRadius.js: 60 m on the ground, wider from up high, hard-capped, and at
// most SHOP_MAX_LOADED_LANDLETS at once, nearest first) and unloads past that
// radius plus a hysteresis band. Each loaded item's level of detail is then set
// from how big it looks on screen (#3373, updateInstanceLodTiers), so flying
// high doesn't mean full-detail meshes for everything in view, and a large item
// keeps its real model for as long as it is a prominent object. Credit orbs
// keep the ground-level 60/90 m radii.
export function updateShopProximity() {
  const avatarX = shopAvatarPosition.x;
  const avatarY = shopAvatarPosition.y;
  const unloadRadiusM = shopUnloadRadiusM(shopFlightAltitudeM);
  let loadedCount = 0;
  const loadCandidates = [];
  for (const entry of shopLandlets.values()) {
    const distance = horizontalDistanceM(entry.record.center.x, entry.record.center.y, avatarX, avatarY);
    if (entry.record.status === 'claimed') {
      if (entry.loaded && distance > unloadRadiusM) {
        unloadShopLandletInstances(entry);
      } else if (entry.loaded) {
        loadedCount += 1;
      } else {
        loadCandidates.push({ entry, distance });
      }
    } else if (entry.record.status === 'greenbelt') {
      // #1995: credit orbs only ever spawn into greenbelt landlets
      // (spawnCreditOrbIfDue's own `WHERE status = 'greenbelt'`) -- an
      // unclaimed plot otherwise has nothing built on it to load at all
      // (see the claimed-only branch above, and its own "nothing built to
      // show for anything else" precedent), so this is a separate, narrower
      // load/unload decision scoped to orbs alone, independent of
      // entry.loaded/entry.objects (which stay permanently empty/false for
      // every greenbelt landlet).
      if (!entry.orbsLoaded && distance < SHOP_LOAD_RADIUS_M) {
        entry.orbsLoaded = true;
        loadCreditOrbsForLandlet(entry, ++entry.orbLoadToken);
      } else if (entry.orbsLoaded && distance > SHOP_UNLOAD_RADIUS_M) {
        unloadCreditOrbsForLandlet(entry);
      }
    }
  }
  // Unloads above already ran, so loadedCount is what remains loaded.
  for (const { entry, distance } of pickLandletsToLoad(loadCandidates, loadedCount, shopFlightAltitudeM)) {
    entry.loaded = true; // set before awaiting so a second tick can't double-load
    // Each load gets its own token (see loadShopLandletInstances) so a
    // fast unload-then-reload cycle can't let an earlier, still in-flight
    // fetch resurrect itself once entry.loaded flips back to true.
    loadShopLandletInstances(entry, ++entry.loadToken);
  }
  updateInstanceLodTiers();
  updateFarView();
}

// #3478 (part of #3418): distant landlets drawn from their products' far
// models, in one shared group in the scene. Created on first use; the world
// frame budget (#3396) paces every build, so this only schedules work.
let shopFarView = null;
function updateFarView() {
  if (!shopFarView) {
    const root = new THREE.Group();
    root.name = 'shop-far-view';
    scene.add(root);
    shopFarView = createFarView({
      queue: worldWorkQueue,
      root,
      fetchTile: fetchFarPlacements,
      loadSource: async (templateId) => {
        const template = findTemplate(templateId);
        const source = template ? await loadFarViewSource(template) : null;
        return source && { ...source, dispose: () => disposeObject(source.container) };
      },
      dimensionsFor: (templateId) => findTemplate(templateId)?.dimensions ?? null,
      elevationFor: (landletId) => shopLandlets.get(landletId)?.record.elevationM ?? 0,
      loadedLandletIds: () => {
        const ids = new Set();
        // #3479: a landlet counts as loaded for the far view only once its real
        // content has finished arriving out of its fog, so the far models stay
        // until then and nothing is ever missing.
        for (const [id, entry] of shopLandlets) if (entry.loaded && entry.arrivalRun?.settled()) ids.add(id);
        return ids;
      },
      getCamera: () => camera.position,
      getView: () => ({ fovDeg: camera.fov, viewportHeightPx: window.innerHeight }),
    });
    // Read by the 390px e2e (#3480): draw calls and instances in view.
    window.__shopFarViewStats = () => shopFarView.stats();
  }
  shopFarView.update();
}

// #3373: how big a placed item looks on screen right now (its bounding sphere's
// diameter in CSS pixels), from the real camera. The item's radius is half the
// diagonal of its declared size, cached on the object.
function lodRadiusM(object) {
  let radiusM = object.userData.lodRadiusM;
  if (radiusM === undefined) {
    const { width, depth, height } = meshDimensions(object);
    radiusM = 0.5 * Math.hypot(width, depth, height);
    object.userData.lodRadiusM = radiusM;
  }
  return radiusM;
}

function lodApparentPx(entry, object) {
  const radiusM = lodRadiusM(object);
  const dx = entry.group.position.x + object.position.x - camera.position.x;
  const dy = entry.group.position.y + object.position.y - camera.position.y;
  const dz = entry.group.position.z + object.position.z - camera.position.z;
  return apparentSizePx(radiusM, Math.hypot(dx, dy, dz), camera.fov, window.innerHeight);
}

// #3373 / #3416: whether an item has reduced versions to switch between: a
// placed model (not a box fallback, flooring, or the geometry-free handle of a
// batched placement, none of which has a loaded model container) that is not
// cropped to a per-placement shape (the versions are of the whole product).
function hasLodTiers(object) {
  return Boolean(object.userData.model) && !extensibleAxes(object.userData.template);
}

// #3416: an item's mid and far versions are fetched or built only once the
// item first needs one, so a landlet the shopper only ever stands beside never
// pays for them. Until they are ready the item stays on its full model.
function requestInstanceTiers(entry, object) {
  object.userData.lodTiersState = 'loading';
  loadTierScenes(object.userData.template).then((scenes) => {
    if (!object.parent) { object.userData.lodTiersState = 'none'; return; } // unloaded meanwhile
    // Attaching clones the versions into this item: a small unit of work run
    // inside the per-frame budget, largest on screen first (#3396).
    worldWorkQueue.enqueue(() => {
      if (!object.parent) { object.userData.lodTiersState = 'none'; return; }
      object.userData.lodTiersState = attachInstanceTiers(object, scenes) ? 'ready' : 'none';
    }, { group: entry.loadGroup, priority: -(object.userData.lodPx ?? 0) });
  });
}

// #3373 / #3416: sets every loaded item's level of detail from its apparent
// size (with hysteresis): its full model, a mid version, or a far version of the
// same model, never a box. If more items want full detail than the budget
// allows, the smallest on screen drop to mid, and past the mid budget to far.
// Runs on the proximity tick (SHOP_PROXIMITY_INTERVAL_MS), so an item flips
// within a fraction of a second of crossing a threshold. An item without
// versions (a box fallback, flooring, a batched placement, a cropped item)
// has nothing to switch.
const lodItemsScratch = [];
const lodObjectsScratch = [];

// #3443: the placed bundles of a loaded landlet that have more than one
// member with versions to switch between, each with its bounding sphere, found once per change in the
// landlet's object count (Shop items do not move). Members that are drawn by an
// instanced batch have no versions and are not decided one by one at all.
function lodSetsFor(entry) {
  if (entry.lodSets && entry.lodSetsObjectCount === entry.objects.length && entry.lodSetsToken === entry.loadToken) return entry.lodSets;
  const byGroup = new Map();
  for (const object of entry.objects) {
    const groupId = object.userData.groupId;
    if (!groupId || !hasLodTiers(object)) continue;
    let members = byGroup.get(groupId);
    if (!members) byGroup.set(groupId, members = []);
    members.push(object);
  }
  const sets = new Map();
  for (const [groupId, members] of byGroup) {
    if (members.length < 2) continue; // a lone member is decided as a single item
    const sphere = setBoundingSphere(members.map((object) => ({
      x: object.position.x, y: object.position.y, z: object.position.z, radiusM: lodRadiusM(object),
    })));
    sets.set(groupId, { members, sphere, px: 0, near: false });
  }
  entry.lodSets = sets;
  entry.lodSetsObjectCount = entry.objects.length;
  entry.lodSetsToken = entry.loadToken; // an unload and reload with the same count must not reuse stale members
  return sets;
}

function updateInstanceLodTiers() {
  lodItemsScratch.length = 0;
  lodObjectsScratch.length = 0;
  for (const entry of shopLandlets.values()) {
    if (!entry.loaded) continue;
    // #3443: a bundle changes detail as one set, from the set's size on screen,
    // and is protected as a whole when any member is beside the avatar.
    const sets = lodSetsFor(entry);
    for (const set of sets.values()) {
      const { sphere } = set;
      const dx = entry.group.position.x + sphere.x - camera.position.x;
      const dy = entry.group.position.y + sphere.y - camera.position.y;
      const dz = entry.group.position.z + sphere.z - camera.position.z;
      set.px = apparentSizePx(sphere.radiusM, Math.hypot(dx, dy, dz), camera.fov, window.innerHeight);
      // The protection has its own hysteresis (enter at 10 m, leave past 13 m),
      // judged from last tick's answer.
      const wasNear = set.near;
      set.near = false;
      for (const member of set.members) {
        if (isNearFullDetail(horizontalDistanceM(
          entry.group.position.x + member.position.x, entry.group.position.y + member.position.y,
          shopAvatarPosition.x, shopAvatarPosition.y,
        ), wasNear)) { set.near = true; break; }
      }
    }
    for (const object of entry.objects) {
      if (!hasLodTiers(object)) continue;
      const set = object.userData.groupId ? sets.get(object.userData.groupId) : undefined;
      const px = set ? set.px : lodApparentPx(entry, object);
      object.userData.lodPx = px;
      // #3443: beside the avatar is always the real model, outside the budget too.
      const nearAvatar = set ? set.near : isNearFullDetail(horizontalDistanceM(
        entry.group.position.x + object.position.x, entry.group.position.y + object.position.y,
        shopAvatarPosition.x, shopAvatarPosition.y,
      ), object.userData.lodNear === true);
      if (!set) object.userData.lodNear = nearAvatar;
      // A set's current tier is its first member's, so the hysteresis band
      // applies to the set as a whole rather than to each member's own state;
      // every member of a set carries the set's size, so the budget drops or
      // keeps the set together.
      const currentTier = set ? set.members[0].userData.lodTier : object.userData.lodTier;
      lodItemsScratch.push({
        px,
        protected: nearAvatar,
        wanted: nearAvatar ? TIER_FULL : nextTier(currentTier, px),
      });
      lodObjectsScratch.push({ entry, object });
    }
  }
  const tiers = budgetedTiers(lodItemsScratch);
  // #3396: flipping hundreds of items in one tick is a batch like any other, so
  // it stops when its slice of the frame is spent; the items not reached keep
  // their state and flip on the next tick.
  const flipStartMs = performance.now();
  for (let i = 0; i < lodObjectsScratch.length; i++) {
    const { entry, object } = lodObjectsScratch[i];
    const tier = tiers[i];
    object.userData.lodTier = tier;
    if (tier !== TIER_FULL && object.userData.lodTiersState === undefined) requestInstanceTiers(entry, object);
    if (object.userData.lodTiersState !== 'ready' || tier === object.userData.lodApplied) continue;
    object.userData.lodApplied = tier;
    setInstanceLodState(object, tier);
    window.__shopLodFlipCount = (window.__shopLodFlipCount ?? 0) + 1; // #3443: e2e counts tier changes
    if (performance.now() - flipStartMs > SHOP_LOD_FLIP_BUDGET_MS) return;
  }
}
const SHOP_LOD_FLIP_BUDGET_MS = 4; // #3396: the part of a frame one tick's tier flips may use

// True if the given world point falls inside this landlet's own footprint
// — the same shape shapeForLandlet draws for its Shop-mode ground mesh
// (a real polygon where one's stored, else the same default square used
// for a plain areaM2). record.polygon (when present) is landlet-local,
// like a placed instance's own position, so the point is translated into
// that local space first.
function landletContainsPoint(record, worldX, worldY) {
  const localX = worldX - record.center.x;
  const localY = worldY - record.center.y;
  if (record.polygon && record.polygon.length >= 3) return pointInPolygonXY(localX, localY, record.polygon);
  const half = Math.sqrt(record.areaM2) / 2;
  return Math.abs(localX) <= half && Math.abs(localY) <= half;
}

// True if (worldX, worldY) falls inside any currently-known water landlet
// -- shopLandlets is already fully populated by the time enterShopMode
// picks a spawn location (built from the same allLandlets fetch, earlier
// in that same function), so this can check synchronously.
function isShopLocationOnWater(worldX, worldY) {
  for (const entry of shopLandlets.values()) {
    if (entry.record.landType === 'water' && landletContainsPoint(entry.record, worldX, worldY)) return true;
  }
  return false;
}

// #1630: the spawn-orbit's location used to be a uniform Math.random()
// pick over the whole world circle, with no check against landing on a
// water landlet. Rerolls (bounded by SHOP_SPAWN_LOCATION_MAX_ATTEMPTS) a
// candidate radius/angle until it lands outside every water landlet's
// footprint -- same radius/angle-to-world-position formula
// updateShopSpawnRotation itself uses for the orbit.
//
// #1816: the radius draw itself must be sqrt-corrected (sampleUniformDiskRadiusM),
// not sampled directly from Math.random() -- see that function's own header
// for why a direct draw statistically biases spawns toward the center.
export function pickShopSpawnLocation() {
  let radiusM = 0;
  let yaw = 0;
  for (let attempt = 0; attempt < SHOP_SPAWN_LOCATION_MAX_ATTEMPTS; attempt++) {
    radiusM = sampleUniformDiskRadiusM(shopMaxRadiusM(), Math.random());
    yaw = Math.random() * Math.PI * 2;
    const worldX = radiusM * Math.sin(yaw);
    const worldY = -radiusM * Math.cos(yaw);
    if (!isShopLocationOnWater(worldX, worldY)) break;
  }
  return { radiusM, yaw };
}

// Which claimed landlet (if any) the shopper is currently standing on, and
// who built it — otherwise the world gives a shopper no way to tell whose
// land they're on at all. shopBuilderLabels is populated once at Shop-mode
// bootstrap (see enterShopMode) and patched in place whenever a rename
// succeeds through the Builder Identity field (#741) — no live-refresh
// subscription for anyone else's rename, just the common case of your own.
export function updateShopLandletInfo() {
  let found = null;
  for (const entry of shopLandlets.values()) {
    if (entry.record.status !== 'claimed') continue;
    if (landletContainsPoint(entry.record, shopAvatarPosition.x, shopAvatarPosition.y)) {
      found = entry;
      break;
    }
  }
  if (found === shopCurrentLandletEntry) return;
  shopCurrentLandletEntry = found;
  if (!found) {
    accountMenuLandletInfoEl.hidden = true;
    return;
  }
  const ownerLabel = shopBuilderLabels.get(found.record.ownerBuilderId) || 'an unknown builder';
  accountMenuLandletInfoEl.textContent = `${found.record.name} — built by ${ownerLabel}`;
  accountMenuLandletInfoEl.hidden = false;
}

// #2853 (leaf of #2373, Option C real terrain): the real per-landlet
// elevationM offset (#2850/#2851) that flightMovement.js's own altitude
// math needs to add wherever it used to assume ground is flat at 0 --
// same unconditional full-scan-over-shopLandlets shape updateShopLandletInfo
// above already uses for its own landletContainsPoint lookup, but without
// that one's `status === 'claimed'` filter: elevationM applies to every
// landlet regardless of claim status, same as group.position.z's own
// unconditional application in enterShopMode (src/shop/mode.js).
export function shopTerrainHeightAtM(worldX, worldY) {
  for (const entry of shopLandlets.values()) {
    if (landletContainsPoint(entry.record, worldX, worldY)) return entry.record.elevationM ?? 0;
  }
  return 0;
}

// #2996: enterShopMode (mode.js) fetches every landlet's own record
// exactly once, at Shop-mode bootstrap — status/ownerBuilderId/polygon/
// areaM2/elevationM/name never change again for the rest of the session,
// even though claims, auctions, and admin reassignment are real, frequent
// mutations on the very same landlets this snapshot came from. The one
// existing per-landlet refresh (loadShopLandletInstances' own
// activeVersionId re-fetch, #1282) deliberately left everything else
// stale — see that fix's own comment. This re-syncs the rest, on its own
// much slower interval since (unlike that one, scoped to a single landlet
// already being loaded) it means a real network round-trip over every
// landlet in the world.
const SHOP_RECORD_REFRESH_INTERVAL_MS = 20000;
let shopLastRecordRefreshAt = 0;
let shopRecordRefreshInFlight = false; // guards against overlapping fetches if one runs long

export function refreshShopLandletRecordsIfNeeded(now) {
  if (now - shopLastRecordRefreshAt < SHOP_RECORD_REFRESH_INTERVAL_MS) return;
  shopLastRecordRefreshAt = now;
  refreshShopLandletRecordsNow();
}

// Split out of refreshShopLandletRecordsIfNeeded above so a test can force
// this to run right now regardless of SHOP_RECORD_REFRESH_INTERVAL_MS —
// window.__testForceShopLandletRecordRefresh (main.js) calls this directly.
// Returns the in-flight promise so a test can await it rather than polling
// for completion.
export function refreshShopLandletRecordsNow() {
  if (shopRecordRefreshInFlight) return Promise.resolve();
  shopRecordRefreshInFlight = true;
  return fetchAllLandlets()
    .then((freshRecords) => {
      let currentEntryChanged = false;
      for (const freshRecord of freshRecords) {
        const entry = shopLandlets.get(freshRecord.landletId);
        // A landlet shopLandlets doesn't already know about is outside this
        // session's own world-radius cull (enterShopMode's own
        // distanceFromOrigin check) or materialized after bootstrap --
        // backfilling either is outside this issue's own scope; this only
        // keeps already-visible landlets' own fields current.
        if (!entry) continue;
        const oldRecord = entry.record;
        // #1995/#2378: leaving a status this entry had something loaded
        // for needs an explicit unload here — updateShopProximity only
        // ever *loads* based on whatever entry.record.status reads on its
        // next tick (so just swapping entry.record below already makes a
        // fresh load pick up a new 'claimed'/'greenbelt' status on its
        // own), but its branch for the status being *left* never runs
        // again once that swap happens, so nothing else would ever tear
        // down what it already loaded.
        if (oldRecord.status !== freshRecord.status) {
          if (oldRecord.status === 'claimed' && entry.loaded) unloadShopLandletInstances(entry);
          else if (oldRecord.status === 'greenbelt' && entry.orbsLoaded) unloadCreditOrbsForLandlet(entry);
        } else if (
          // #3004: an admin reassign-owner (POST .../reassign-owner) leaves
          // `status` at 'claimed' on both sides of the change -- only
          // ownerBuilderId moves -- but still wipes the previous owner's
          // placed_instances/landlet_versions/landlet_levels server-side
          // (land.js's own #1280 cleanup batch). Without this branch,
          // entry.loaded never resets, so updateShopProximity (which only
          // reloads on a false -> true transition) never notices and a
          // shopper who already loaded this landlet keeps seeing the old
          // owner's now-deleted content indefinitely.
          oldRecord.status === 'claimed' && entry.loaded
          && oldRecord.ownerBuilderId !== freshRecord.ownerBuilderId
        ) {
          unloadShopLandletInstances(entry);
        }
        // #3005: status alone doesn't catch a suspension -- a suspended
        // builder's landlet stays 'claimed' on both sides of the change,
        // only ownerSuspended flips. #2993 already hides this landlet's
        // instances from GET /instances for everyone but the owner once
        // suspended, but a shopper who already had it loaded keeps
        // rendering the stale content until something tears it down.
        // Unloading on either direction of the flip is enough: going
        // suspended clears the now-hidden content, and going unsuspended
        // resets entry.loaded to false so the next proximity tick reloads
        // it (auto-restored server-side per #2986) the same way any other
        // false -> true load already works.
        if (oldRecord.ownerSuspended !== freshRecord.ownerSuspended && entry.loaded) {
          unloadShopLandletInstances(entry);
        }
        // The ground mesh's color/texture (plotColorKeyForLandlet) and
        // shape (shapeForLandlet, keyed off polygon/areaM2) are baked into
        // geometry/materials at construction time — nothing rebuilds them
        // on their own the way entry.record's plain fields just get
        // overwritten below. Only pay for a rebuild when one of their
        // actual inputs changed.
        if (
          plotColorKeyForLandlet(oldRecord) !== plotColorKeyForLandlet(freshRecord)
          || oldRecord.biome !== freshRecord.biome
          || oldRecord.areaM2 !== freshRecord.areaM2
          || JSON.stringify(oldRecord.polygon) !== JSON.stringify(freshRecord.polygon)
        ) {
          entry.group.remove(entry.groundMesh);
          disposeObject3D(entry.groundMesh);
          entry.groundMesh = buildShopGroundMesh(freshRecord);
          entry.group.add(entry.groundMesh);
        }
        // #2871: group.position already carries the real elevationM lift
        // (and the landlet's own center) so every placed instance/orb
        // riding on it moves too — updating it here is enough to pick up
        // an elevationM or center edit (both reachable via #2967's PUT/
        // PATCH endpoint) with no extra per-child work.
        entry.group.position.set(freshRecord.center.x, freshRecord.center.y, freshRecord.elevationM ?? 0);
        entry.record = freshRecord;
        if (entry === shopCurrentLandletEntry) currentEntryChanged = true;
      }
      // updateShopLandletInfo only re-renders on an actual landlet
      // *transition* (found === shopCurrentLandletEntry short-circuits
      // otherwise) — so if the shopper's own current landlet is the one
      // whose record just changed in place (e.g. its ownerBuilderId after
      // an auction win), force a recompute the same way enterShopMode's
      // own bootstrap already does for the equivalent "labels just became
      // current" case, rather than leaving the "built by" label showing
      // stale data for the rest of the session.
      if (currentEntryChanged) resetShopCurrentLandletEntry();
    })
    .catch(() => {}) // best-effort, same as every other background refresh in this file
    .finally(() => {
      shopRecordRefreshInFlight = false;
    });
}

// Same "logged in AND actually verified" check assertVerified enforces
// server-side (worker/index.js: age_attested_at set, trust_tier !== 'none')
// — mirrors the existing ageAttested/trustTier idiom requireCurrentUser's
// own caller (ensureBuilderIdentity) already uses client-side.
// #1771: set true as the delete-account submit handler's first line, before
// its own await -- the account is deleted server-side well before that
// await resolves client-side (a real network round-trip, many render-loop
// ticks), and currentAuthUser itself isn't nulled until after it resolves.
// Without this, a presence report/poll tick firing in that window still
// passes this guard and 401s against a session that's already gone.
let accountSessionEnding = false;

// #2554 (sub-issue of #2626's own extraction): src/account/auth.js's own
// delete-account flow needs to set this flag before deleteAccount()'s own
// await resolves (see the comment at its declaration above) -- imports
// this directly from here now, not via main.js.
export function setAccountSessionEnding(value) {
  accountSessionEnding = value;
}

// #3498: read by the Shop avatar mount, which makes two authenticated fetches
// one after the other and must not send the second once a logout has begun.
export function isAccountSessionEnding() {
  return accountSessionEnding;
}

function hasVerifiedSession() {
  return !!currentAuthUser && currentAuthUser.ageAttested && currentAuthUser.trustTier !== 'none' && !accountSessionEnding;
}

// #1100: the client-side half of #1098's own throttling split — the POST
// endpoint stays safe to call often, so this is what actually keeps calls
// infrequent: a minimum interval AND a minimum movement/turn delta, same
// "both gates, not either" shape #1098's own issue body asked for. Never
// awaited by its caller (updateShopMovement) — a slow or failed report
// should never stall the render loop; errors are swallowed the same way
// updateShopLandletInfo's own best-effort neighbors in this file are.
export function reportOwnPresenceIfNeeded(now) {
  // Shop mode itself never requires a real account, let alone a verified
  // one (anonymous browsing is the whole point — only Build/Sell/
  // purchasing gate on either) — calling an authenticated endpoint for a
  // not-logged-in or not-yet-verified shopper would just fail every single
  // time (401 logged out, 403 unverified per the backend's own
  // assertVerified), logging a browser-level "Failed to load resource"
  // console error that the catch below can't suppress — a `fetch()` call
  // doesn't reject on a non-2xx response (only on a real network failure),
  // and Chromium logs that console line itself, independent of anything
  // the JS layer does with the response afterward. Confirmed via
  // e2e/auth.test.mjs's own logout-reloads-into-Shop step, and separately
  // its freshly-signed-up-but-unverified second account, which both leave
  // the page in exactly one of these two states.
  if (!hasVerifiedSession()) return;
  const sinceLastReport = now - shopLastPresenceReportAt;
  if (sinceLastReport < SHOP_PRESENCE_REPORT_INTERVAL_MS) return;
  const { x, y, z } = shopAvatarPosition;
  const heading = shopAvatarFacing;
  const landletId = shopCurrentLandletEntry?.record.landletId ?? null;
  // #2043: docs/SPEC.md's "Flying avatars are invisible to other users" --
  // airborne covers takeoff/flying/landing, same boolean updateShopMovement
  // already derives from this state for its own speed-multiplier logic.
  const flying = shopFlightState !== 'grounded';
  const moved = !shopLastReportedPosition || Math.hypot(
    x - shopLastReportedPosition.x, y - shopLastReportedPosition.y, z - shopLastReportedPosition.z,
  ) >= SHOP_PRESENCE_MOVE_THRESHOLD_M;
  const turned = shopLastReportedHeading === null
    || Math.abs(shortestAngleDelta(shopLastReportedHeading, heading)) >= SHOP_PRESENCE_HEADING_THRESHOLD_RAD;
  const flyingChanged = shopLastReportedFlying === undefined || flying !== shopLastReportedFlying;
  // shopLandlets is only populated once enterShopMode's own fetchAllLandlets
  // resolves, which races against this function's very first eligible
  // tick -- a player standing perfectly still (the common case right after
  // spawning, before taking a first step) could otherwise have its first-
  // ever report go out with landletId still null (shopCurrentLandletEntry
  // not resolved yet) and then never get corrected, since moved/turned both
  // stay false forever with no further movement. shopLastReportedLandletId
  // starts undefined (distinct from the real, legitimate null of "not on
  // any landlet") specifically so this always fires at least once more
  // once the real landlet resolves, even with zero movement in between.
  const landletChanged = shopLastReportedLandletId === undefined || landletId !== shopLastReportedLandletId;
  const heartbeatDue = sinceLastReport >= SHOP_PRESENCE_HEARTBEAT_INTERVAL_MS;
  if (!moved && !turned && !landletChanged && !flyingChanged && !heartbeatDue) return;
  shopLastPresenceReportAt = now;
  shopLastReportedPosition = { x, y, z };
  shopLastReportedHeading = heading;
  shopLastReportedLandletId = landletId;
  shopLastReportedFlying = flying;
  reportPresence({ x, y, z, heading, landletId, flying }).catch(() => {});
}

// Shared by the report-throttle turn-check above and the other-avatars
// heading lerp below — the signed angular delta via the shortest direction,
// same idiom updateShopMovement's own facing-turn logic already uses.
function shortestAngleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

// #1100: the read side — other builders' last-reported positions in
// whichever landlet this shopper currently stands on. Nothing to scope the
// query by off a landlet (#1099's own GET requires one), so this despawns
// whoever was being tracked rather than keep showing stale others from
// wherever the shopper stood before. Never awaited by its caller
// (updateShopMovement) for the same reason as the report side above.
export async function pollNearbyPresenceIfNeeded(now) {
  // Same reasoning as reportOwnPresenceIfNeeded's own guard above — GET
  // /api/presence requires a verified session too, so skip it entirely
  // rather than failing every poll tick. An anonymous or not-yet-verified
  // shopper simply doesn't see other avatars; the moment they do log in
  // and verify, this starts working on the very next tick with no extra
  // wiring.
  if (!hasVerifiedSession()) {
    despawnOtherShopAvatars();
    return;
  }
  if (now - shopLastPresencePollAt < SHOP_PRESENCE_POLL_INTERVAL_MS) return;
  shopLastPresencePollAt = now;
  const landletId = shopCurrentLandletEntry?.record.landletId;
  if (!landletId) {
    despawnOtherShopAvatars();
    return;
  }
  // #1911: called unawaited every frame, with no AbortController -- a
  // slower, earlier-issued fetch landing after a faster, newer one would
  // otherwise overwrite shopOtherAvatars with stale positions/headings and
  // wrongly despawn avatars only missing from the stale response. Same
  // monotonic-load-token guard every other async render/poll path in this
  // file already uses (friendsLoadToken, dmLoadToken, etc.).
  const myPresencePollToken = ++presencePollToken;
  let avatars;
  try {
    avatars = await fetchNearbyPresence();
  } catch {
    return; // best-effort -- try again next poll tick, same as a dropped report
  }
  // #3349: drop only a response OLDER than one already applied. The old test
  // (`!== presencePollToken`) dropped every response while a newer poll had
  // merely been *issued*, so whenever GET latency exceeded the 1 s poll
  // interval each response was discarded as stale and nothing was ever
  // applied (a livelock; seen as the flaky background-tab despawn e2e).
  if (myPresencePollToken < presenceAppliedToken) return;
  presenceAppliedToken = myPresencePollToken;
  const seenBuilderIds = new Set();
  for (const avatar of avatars) {
    seenBuilderIds.add(avatar.builderId);
    let entry = shopOtherAvatars.get(avatar.builderId);
    if (!entry) {
      // #2045: entry.group is a stable outer transform (position/heading are
      // lerped on it, and flightMovement/voiceChat read it); the visible body
      // lives inside it as entry.body so it can be swapped for the builder's
      // equipped custom model without disturbing anything holding the entry.
      // Always starts as the default procedural body -- a custom model only
      // replaces it once it has loaded (reconcileOtherAvatarBodies). Limb/arm
      // pose and animation clips aren't driven for these, only root
      // position/heading, which is all the presence row carries.
      const group = new THREE.Group();
      const body = createShopAvatar().group;
      group.add(body);
      scene.add(group);
      entry = {
        group,
        body,
        bodyTemplateId: null, // the template the visible body was built from; null = default body
        bodyRequestedTemplateId: null, // latest template asked for (incl. one still loading)
        bodySwapToken: 0,
        // #3230: per-avatar clip playback. mixer/actions are null until the
        // custom body's clips have loaded (and stay null for the default body or
        // a model with no idle/walk clip); clipsFor remembers which (body,
        // applied animation) pair they were built for so a poll only rebuilds
        // them when one of those changes.
        mixer: null,
        actions: null,
        animState: null,
        animationSource: null,
        clipsFor: null,
        lastFrameAt: null,
        fromX: avatar.x, fromY: avatar.y, fromZ: avatar.z, fromHeading: avatar.heading ?? 0,
        lerpDurationMs: SHOP_PRESENCE_POLL_INTERVAL_MS, // nothing to compare against yet; from === to anyway
      };
      shopOtherAvatars.set(avatar.builderId, entry);
    } else {
      entry.fromX = entry.toX;
      entry.fromY = entry.toY;
      entry.fromZ = entry.toZ;
      entry.fromHeading = entry.toHeading;
      // #2864: this snapshot's own real arrival gap, not a fixed
      // assumption — an uneven/delayed poll cadence (network jitter, a
      // throttled/backgrounded tab, a skipped tick) would otherwise make
      // updateOtherShopAvatars clamp at t=1 and sit frozen until the next
      // snapshot finally lands, then visibly snap through the real
      // distance covered in too short a window.
      entry.lerpDurationMs = Math.max(1, now - entry.receivedAt);
    }
    entry.toX = avatar.x;
    entry.toY = avatar.y;
    entry.toZ = avatar.z;
    entry.toHeading = avatar.heading ?? entry.fromHeading;
    entry.receivedAt = now;
    entry.missedPolls = 0; // #2436: seen again -- clear any pending despawn countdown
    entry.equippedAvatar = normalizeEquippedAvatar(avatar.equippedAvatar); // #2045
    entry.equippedAnimation = normalizeEquippedAnimation(avatar.equippedAnimation); // #3230
    applyAssistantLook(entry, avatar.assistant); // #3445: a fleet account is drawn as a named assistant
    entry.userId = avatar.userId ?? null; // #3447: the account to ask when a shopper taps an assistant
  }
  // #2436: a single poll missing an avatar that's genuinely still nearby
  // (report/poll cadence phase gap, or the avatar's own report briefly
  // going stale) used to despawn it outright -- including on the exact
  // frame updateShopFlight's landing branch reads shopOtherAvatars to run
  // the #2044 collision-avoidance nudge, silently skipping it. Requiring
  // SHOP_OTHER_AVATAR_MISSED_POLLS_BEFORE_DESPAWN consecutive misses before
  // actually removing the avatar costs at most a couple of poll intervals
  // of a stale ghost avatar lingering -- far cheaper than a missed landing
  // nudge, which never gets a second chance once that frame has passed.
  for (const [builderId, entry] of shopOtherAvatars) {
    if (seenBuilderIds.has(builderId)) continue;
    entry.missedPolls = (entry.missedPolls ?? 0) + 1;
    if (entry.missedPolls < SHOP_OTHER_AVATAR_MISSED_POLLS_BEFORE_DESPAWN) continue;
    scene.remove(entry.group);
    disposeOtherAvatarClips(entry);
    disposeObject3D(entry.group);
    shopOtherAvatars.delete(builderId);
  }
  reconcileOtherAvatarBodies(now);
  reconcileOtherAvatarAnimations(now); // #3230: also covers an animation equipped/changed with the body unchanged
  refreshOtherShopAvatarsDiagnostic();
}

// #2045: decides, once per poll, which nearby builders get their equipped
// custom model and which keep (or return to) the default body, then starts
// whichever swaps are needed. Never awaited and never throws -- fail open.
function reconcileOtherAvatarBodies(now) {
  const wanted = new Map();
  const shown = new Set();
  for (const [builderId, entry] of shopOtherAvatars) {
    wanted.set(builderId, entry.equippedAvatar ?? null);
    if (entry.bodyRequestedTemplateId) shown.add(entry.bodyRequestedTemplateId);
  }
  const allowed = chooseAllowedTemplateIds(wanted, shown, otherAvatarModelFailedAt, now);
  for (const [builderId, entry] of shopOtherAvatars) {
    const desired = desiredAvatarFor(entry.equippedAvatar ?? null, allowed);
    const desiredId = desired ? desired.templateId : null;
    if (desiredId === entry.bodyRequestedTemplateId) continue;
    entry.bodyRequestedTemplateId = desiredId;
    const myToken = ++entry.bodySwapToken;
    if (!desired) {
      installOtherAvatarBody(entry, createShopAvatar().group, null);
      continue;
    }
    loadOtherAvatarCustomBody(desired.modelUrl)
      .then((body) => {
        // Gone, or asked for something else while this was loading: the
        // result is stale. Only the instance's own cloned materials are freed
        // (disposeObject3D skips the geometry/textures shared with the
        // cached model, #1560).
        if (shopOtherAvatars.get(builderId) !== entry || entry.bodySwapToken !== myToken) {
          disposeObject3D(body);
          return;
        }
        installOtherAvatarBody(entry, body, desired.templateId);
        reconcileOtherAvatarAnimations(performance.now());
        refreshOtherShopAvatarsDiagnostic();
      })
      .catch((err) => {
        otherAvatarModelFailedAt.set(desired.templateId, performance.now());
        console.warn(`Failed to load another builder's avatar model (${desired.modelUrl}), showing the default body:`, err);
        if (shopOtherAvatars.get(builderId) === entry && entry.bodySwapToken === myToken) {
          entry.bodyRequestedTemplateId = null;
          // A previous custom model may still be showing (the builder switched
          // avatars and the new one failed): never leave the old one up as if
          // it were current.
          if (entry.bodyTemplateId !== null) installOtherAvatarBody(entry, createShopAvatar().group, null);
          refreshOtherShopAvatarsDiagnostic();
        }
      });
  }
}

function installOtherAvatarBody(entry, body, templateId) {
  entry.group.remove(entry.body);
  disposeOtherAvatarClips(entry); // the mixer was bound to the body being removed
  disposeObject3D(entry.body);
  entry.group.add(body);
  entry.body = body;
  entry.bodyTemplateId = templateId;
}

// A cloned custom model with its feet at local z=0, matching the default
// body's contract (createCustomShopAvatar does the same measurement for the
// shopper's own avatar). No animation or AFK badge for other players: the
// presence row carries neither.
async function loadOtherAvatarCustomBody(modelUrl) {
  // #3230: skeletonSafe, so each avatar's own AnimationMixer drives only its
  // own bones even when several nearby players wear the same model.
  const container = await loadModelInstance(modelUrl, { skeletonSafe: true });
  const box = new THREE.Box3().setFromObject(container);
  container.position.z = Math.max(box.max.z - box.min.z, 0) / 2;
  container.rotation.z = CUSTOM_AVATAR_FRONT_YAW_RAD; // #2744: same turn as the shopper's own avatar, so the model's front leads
  const body = new THREE.Group();
  body.add(container);
  body.userData.clipRoot = container.userData.model; // what clips bind against (as createCustomShopAvatar does)
  body.userData.modelUrl = modelUrl;
  return body;
}

// #3230: stops and forgets one avatar's clip playback. Safe on an entry that
// never had any. The clips themselves live in the shared GLTF cache, so there
// is nothing to free here beyond the mixer's own bindings.
function disposeOtherAvatarClips(entry) {
  if (entry.mixer) {
    entry.mixer.stopAllAction();
    if (entry.body?.userData?.clipRoot) entry.mixer.uncacheRoot(entry.body.userData.clipRoot);
  }
  entry.mixer = null;
  entry.actions = null;
  entry.animState = null;
  entry.animationSource = null;
  entry.clipsFor = null;
}

// #3230: decides, per nearby custom-bodied avatar, whose clips it plays: the
// applied animation's, when it is compatible with the avatar's skeleton
// (#1162) and within the cap on distinct animation files drawn at once, else
// the avatar's own idle/walk clips -- the same rule createCustomShopAvatar
// follows for the shopper's own avatar. Fail open everywhere: a clip file that
// will not load leaves the avatar with its own clips (or none), never an error.
// Never awaited and never throws.
function reconcileOtherAvatarAnimations(now) {
  const wanted = new Map();
  const shown = new Set();
  for (const [builderId, entry] of shopOtherAvatars) {
    wanted.set(builderId, entry.bodyTemplateId !== null ? animationForAvatar(entry.equippedAvatar, entry.equippedAnimation) : null);
    if (entry.clipsFor?.animationId) shown.add(entry.clipsFor.animationId);
  }
  const allowed = chooseAllowedTemplateIds(wanted, shown, otherAvatarAnimationFailedAt, now);
  for (const [builderId, entry] of shopOtherAvatars) {
    if (entry.bodyTemplateId === null) continue; // default body: no clips to play
    const body = entry.body;
    const desired = desiredAvatarFor(wanted.get(builderId), allowed);
    const animationId = desired ? desired.templateId : null;
    // #3314: the seller's chosen clips arrive with every poll, so a change to
    // them (not only a new body or animation) rebuilds this avatar's clips.
    const rolesKey = JSON.stringify(entry.equippedAvatar?.clipRoles ?? null);
    if (entry.clipsFor && entry.clipsFor.body === body && entry.clipsFor.animationId === animationId && entry.clipsFor.rolesKey === rolesKey) continue;
    entry.clipsFor = { body, animationId, rolesKey };
    setUpOtherAvatarClips(entry, body, desired, animationId, rolesKey).catch(() => {});
  }
}

async function setUpOtherAvatarClips(entry, body, appliedAnimation, animationId, rolesKey) {
  let animations = [];
  let source = 'own';
  if (appliedAnimation) {
    try {
      animations = await loadModelAnimations(appliedAnimation.modelUrl);
      source = 'applied';
    } catch (err) {
      otherAvatarAnimationFailedAt.set(appliedAnimation.templateId, performance.now());
      console.warn(`Failed to load another builder's applied animation (${appliedAnimation.modelUrl}), using the avatar's own clips:`, err);
    }
  }
  if (source === 'own') {
    try {
      animations = await loadModelAnimations(body.userData.modelUrl);
    } catch {
      animations = [];
    }
  }
  // The body was swapped or the avatar despawned (both reset clipsFor), or a
  // newer request replaced this one, while the files loaded: nothing to install.
  if (entry.body !== body || entry.clipsFor?.body !== body || entry.clipsFor.animationId !== animationId || entry.clipsFor.rolesKey !== rolesKey) return;
  let mixer = null;
  let actions = null;
  if (animations.length > 0 && body.userData.clipRoot) {
    mixer = new THREE.AnimationMixer(body.userData.clipRoot);
    actions = {};
    // #3287: same role matching as the shopper's own avatar and the upload wizard.
    // #3314: the seller's chosen clips name clips of the avatar's OWN file, so
    // they apply only when this body plays its own clips, not an applied animation's.
    const picked = pickAvatarClips(animations, ['idle', 'walk'], source === 'own' ? JSON.parse(rolesKey) : null);
    for (const state of ['idle', 'walk']) {
      if (picked[state]) actions[state] = mixer.clipAction(picked[state]);
    }
    if (Object.keys(actions).length === 0) { mixer = null; actions = null; }
  }
  entry.mixer = mixer;
  entry.actions = actions;
  entry.animState = null;
  entry.animationSource = actions ? source : null;
  refreshOtherShopAvatarsDiagnostic();
}

function despawnOtherShopAvatars() {
  for (const entry of shopOtherAvatars.values()) {
    scene.remove(entry.group);
    disposeOtherAvatarClips(entry);
    disposeObject3D(entry.group);
  }
  shopOtherAvatars.clear();
  refreshOtherShopAvatarsDiagnostic();
}

// Read-only diagnostic exposed for e2e tests, same pattern as the existing
// window.__shopAvatarMetrics (#1091) — a real multiplayer scenario needs
// two separate browser sessions in the same landlet, so a test can't just
// read local in-memory state the way a single-session feature would; this
// is what lets it confirm the *other* session's reported position actually
// made it through the full report -> GET -> poll round trip.
function refreshOtherShopAvatarsDiagnostic() {
  window.__shopOtherAvatars = [...shopOtherAvatars.entries()].map(([builderId, entry]) => ({
    builderId, x: entry.toX, y: entry.toY, z: entry.toZ, heading: entry.toHeading,
    userId: entry.userId ?? null, // added for #3447 -- e2e taps an assistant by its account, as it cannot aim at a pixel
    assistantName: entry.assistantName ?? null, // added for #3445 -- e2e needs to see that a fleet avatar carries its name tag and shirt, and an ordinary one does not
    hasAssistantShirt: Boolean(entry.assistantShirt), // added for #3445, same reason
    bodyTemplateId: entry.bodyTemplateId, // added for #2045 -- e2e needs to see which model each other avatar actually drew
    animationSource: entry.animationSource, // added for #3230 -- e2e needs to see whether an avatar plays its own clips, an applied animation's, or none
    animState: entry.animState, // added for #3230 -- idle vs walk, to check clips follow observed movement
    playingClip: (entry.actions && entry.animState && entry.actions[entry.animState]?.getClip().name) || null, // added for #3314 -- which named clip actually plays, to check the seller's chosen clip roles beat name matching
  }));
}

// #1100: lerps every tracked other-avatar from its previous poll snapshot
// toward its latest one over the poll interval, every frame — what makes a
// once-a-second polling transport read as continuous motion rather than a
// visible snap/teleport on each poll tick (the issue's own "smoothing").
export function updateOtherShopAvatars(now) {
  for (const entry of shopOtherAvatars.values()) {
    const t = Math.min(1, (now - entry.receivedAt) / entry.lerpDurationMs);
    entry.group.position.set(
      THREE.MathUtils.lerp(entry.fromX, entry.toX, t),
      THREE.MathUtils.lerp(entry.fromY, entry.toY, t),
      THREE.MathUtils.lerp(entry.fromZ, entry.toZ, t),
    );
    entry.group.rotation.z = entry.fromHeading + shortestAngleDelta(entry.fromHeading, entry.toHeading) * t;
    // #3230: clips follow the movement the lerp above is already showing.
    if (entry.mixer) {
      setShopAvatarAnimationState(entry, locomotionStateFor(entry.fromX, entry.fromY, entry.toX, entry.toY, entry.lerpDurationMs, t));
      const dt = entry.lastFrameAt === null ? 0 : Math.min((now - entry.lastFrameAt) / 1000, 0.1); // same clamp the other per-frame dt uses
      entry.mixer.update(dt);
    }
    entry.lastFrameAt = now;
  }
}

// myToken pins this call to the specific load that started it (see the
// ++entry.loadToken call site) — entry.loaded alone can't tell "still this
// load" from "unloaded and reloaded again while this was in flight," since
// both leave entry.loaded === true. Every checkpoint below compares against
// entry.loadToken instead, so a superseded call quietly stops contributing
// meshes/signs/calendars/reviews rather than duplicating whatever the
// current load already added.
async function loadShopLandletInstances(entry, myToken) {
  let instances;
  try {
    // #1282: entry.record is a one-time snapshot taken when Shop mode was
    // entered (fetchAllLandlets, far above) and was never refreshed after
    // that — a builder publishing a new version, or switching which
    // version is live, while a shopper's session was already open went
    // unnoticed indefinitely, since every reload here (updateShopProximity
    // walking the shopper toward/away from the landlet) kept branching on
    // that same stale activeVersionId. Re-fetching the landlet record
    // fresh on every load keeps this decision current, the same way a
    // fresh page load already would, without changing anything else
    // entry.record is used for.
    entry.record.activeVersionId = (await fetchLandlet(entry.record.landletId)).activeVersionId;
    // A landlet that's actually been published (see the Build settings
    // tab's "Publish"/Version History) shows shoppers a frozen snapshot,
    // not the builder's own live in-progress edits — the whole point of a
    // draft/publish split. A landlet with no activeVersionId has never
    // been published, so this falls back to the live draft (today's
    // behavior for every landlet that existed before this feature).
    instances = entry.record.activeVersionId
      ? (await fetchLandletVersion(entry.record.landletId, entry.record.activeVersionId)).instances
      : await fetchInstances(entry.record.landletId);
  } catch {
    if (myToken === entry.loadToken) entry.loaded = false; // allow a later pass to retry
    return;
  }
  // #3396: moving, looking and drawing never wait on loading. Each item is its
  // own small unit of work, run inside the per-frame time budget (see
  // src/world/frameBudgetQueue.js), nearest and largest on screen first, so a
  // landlet of hundreds of items arrives over several frames instead of
  // freezing one. Dropping the group on unload (or on a newer load) cancels
  // whatever has not run yet.
  if (entry.loadGroup) worldWorkQueue.dropGroup(entry.loadGroup);
  const group = {};
  entry.loadGroup = group;
  // #3407 ("things arrive in the world through fog; nothing pops in"): the
  // instance list is known now, long before any model is built, so each
  // cluster's fog starts at its known position right away and its items
  // resolve out of it as they become ready (src/shop/arrivalRun.js). A newer
  // load replaces the previous run, releasing its fogs and materials.
  entry.arrivalRun?.dispose();
  const run = createArrivalRun({
    parent: entry.group,
    instances,
    templateFor: findTemplate,
    anchor: shopArrivalAnchor(entry),
  });
  entry.arrivalRun = run;
  exposeArrivalStats(run);
  // #3402: placements that look exactly the same (same product, same size, no
  // crop) are drawn by one instanced mesh per model part instead of one cloned
  // mesh each; everything else is built one by one as before.
  const { batches, singles } = groupPlacements(instances, findTemplate);
  for (const members of batches.values()) {
    worldWorkQueue.enqueue(() => buildAndAttachBatch(entry, members, myToken, group, run), {
      group,
      priority: Math.min(...members.map((instance) => instanceLoadPriority(entry, instance))),
    });
  }
  for (const instance of singles) {
    worldWorkQueue.enqueue(() => buildAndAttachInstance(entry, instance, myToken, run), {
      group,
      priority: instanceLoadPriority(entry, instance),
    });
  }
}

// #3402: one batch of identical placements. Each placement still gets its own
// lightweight handle (createPlacementHandle) in entry.objects, so collision,
// sit/lean search, attention and reviews see it like any placed item; only the
// drawing is shared. A model that cannot be drawn this way falls back to
// ordinary per-item meshes for the whole batch.
async function buildAndAttachBatch(entry, members, myToken, group, run) {
  const settleAll = () => { for (const instance of members) run?.itemSettled(instance.instanceId); };
  if (myToken !== entry.loadToken) { // superseded while queued
    settleAll();
    return;
  }
  const template = findTemplate(members[0].templateId);
  const source = await loadBatchSource(template);
  if (!source) {
    for (const instance of members) {
      worldWorkQueue.enqueue(() => buildAndAttachInstance(entry, instance, myToken, run), {
        group,
        priority: instanceLoadPriority(entry, instance),
      });
    }
    return;
  }
  if (myToken !== entry.loadToken) {
    // Same hazard and same e2e-visible counter as buildAndAttachInstance below.
    disposeObject3D(source.container);
    window.__shopInstanceDisposedCount = (window.__shopInstanceDisposedCount ?? 0) + 1;
    settleAll();
    return;
  }
  const handles = members.map((instance) => createPlacementHandle(instance, template));
  for (const handle of handles) entry.group.add(handle);
  const batch = buildInstancedBatch(source.parts, handles);
  batch.container = source.container;
  // One root for the batch's instanced meshes: the arrival dissolve (#3407)
  // swaps the materials of everything under the root it is given, and unload
  // removes the root.
  batch.root = new THREE.Group();
  for (const mesh of batch.meshes) batch.root.add(mesh);
  entry.group.add(batch.root);
  entry.batches.push(batch);
  let topZ = -Infinity;
  for (const handle of handles) {
    entry.objects.push(handle);
    topZ = Math.max(topZ, entry.group.position.z + placementTopZ(handle.position.z, handle.rotation.x, handle.rotation.y, meshDimensions(handle)));
    registerShopReview(handle, entry);
  }
  growShopDomeToHeight(topZ);
  // #3407: the batch dissolves in with its first member's cluster; the other
  // members have nothing of their own to dissolve, so they settle at once and
  // never hold their clusters' fog.
  run?.itemReady(members[0].instanceId, batch.root);
  for (const instance of members.slice(1)) run?.itemSettled(instance.instanceId);
}

// How soon an item should be built: the bigger it will look on screen, the
// sooner (a lower number runs first). Uses the template's declared size, since
// the mesh does not exist yet.
function instanceLoadPriority(entry, instance) {
  const template = findTemplate(instance.templateId);
  const dims = template?.dimensions;
  const scale = instance.scale ?? 1;
  const radiusM = dims ? 0.5 * Math.hypot(dims.width, dims.depth, dims.height) * scale : 0.5;
  const dx = entry.group.position.x + (instance.x ?? 0) - camera.position.x;
  const dy = entry.group.position.y + (instance.y ?? 0) - camera.position.y;
  const dz = entry.group.position.z + (instance.z ?? 0) - camera.position.z;
  return -apparentSizePx(radiusM, Math.hypot(dx, dy, dz), camera.fov, window.innerHeight);
}

// One item of a landlet load (#3396): build it, attach it, register it. The
// loop this came from checked its token before and after the build; those
// checks are unchanged.
async function buildAndAttachInstance(entry, instance, myToken, run) {
  if (myToken !== entry.loadToken) return; // superseded while queued
  const object = await createMeshForInstance(instance);
  if (!object) {
    run?.itemSettled(instance.instanceId); // never arrives; do not hold its fog
    return;
  }
  // #1445: object was already fully built above (a real GLTF load) before
  // this guard runs — same hazard #1426/#1427 already fixed for their own
  // async-supersede loaders. Without disposing it here, the superseded-
  // but-already-built instance's geometry/materials/textures leak for the
  // rest of the tab's lifetime, since nothing else ever references it.
  if (myToken !== entry.loadToken) {
    disposeObject3D(object);
    // Nothing else observes this branch (object is never added to
    // entry.group, so it's never drawn and therefore never counted by
    // reportRendererMemoryDiagnostic's renderer.info.memory snapshot
    // either) -- exposed purely so an e2e test can confirm the dispose
    // above actually ran, same reasoning as window.__sellerShowcaseDisposedMeshCount
    // (#1427/#1432) and window.__supersededAvatarDisposals (#1426).
    window.__shopInstanceDisposedCount = (window.__shopInstanceDisposedCount ?? 0) + 1;
    run?.itemSettled(instance.instanceId);
    return;
  }
  entry.group.add(object);
  entry.objects.push(object);
  growShopDomeIfNeeded(object);
  // #3416: the item starts on its full model. Its mid and far versions are
  // added the first time updateInstanceLodTiers asks for one (see
  // requestInstanceTiers), after growShopDomeIfNeeded above has measured the
  // full model alone.
  object.userData.lodTier = TIER_FULL;
  object.userData.lodApplied = TIER_FULL;
  if (object.userData.isCommunitySign) registerShopSign(object, entry);
  if (object.userData.isCommunityCalendar) registerShopCalendar(object, entry);
  // Unlike signs/calendar above, reviews have no builder opt-in flag at
  // all — every placed instance's underlying catalog template is
  // reviewable by definition (see docs/API.md's "Product reviews"), so
  // this registers unconditionally.
  registerShopReview(object, entry);
  // #3407: last, so the dissolve covers everything attached above. The item stays fully dissolved until its whole cluster has
  // arrived, then resolves out of the fog.
  run?.itemReady(instance.instanceId, object);
}

// Where the fogs of a landlet are ranked from when there are more clusters
// than the cap allows: the shopper's position in the landlet's own frame.
function shopArrivalAnchor(entry) {
  return {
    x: camera.position.x - entry.group.position.x,
    y: camera.position.y - entry.group.position.y,
  };
}

// Drives every landlet's arrival effects (one cheap loop over the clusters
// still arriving; a landlet at rest has none). Called once per frame from
// updateShopWorldServices.
export function updateShopArrivals() {
  for (const entry of shopLandlets.values()) entry.arrivalRun?.update();
}

// Diagnostics for the e2e (and a bug report): what the latest arrival did.
function exposeArrivalStats(run) {
  window.__shopArrivalRun = run;
  window.__shopArrivalFogsAlive = aliveArrivalFogCount;
}

// Unlike signs/calendars/reviews above, a credit orb isn't a placed
// instance at all (#1994's own data model — a separate credit_orbs table
// keyed only by landlet), and unlike those, it only ever loads for a
// greenbelt landlet (see updateShopProximity's own comment on why that's a
// separate load/unload decision from loadShopLandletInstances' claimed-only
// one) — so its mesh is never added to entry.objects; it's tracked solely
// in shopCreditOrbs, and disposed either here-ish (on collect, see
// updateCreditOrbs) or in unloadCreditOrbsForLandlet below, not via
// entry.objects' own generic disposal loop. Fetched once, right as the
// landlet enters load range — same "not kept in sync afterward" tradeoff
// registerShopSign's own posts fetch already accepts; an orb collected by
// another shopper while this one is still nearby just lingers visually
// until the next reload, exactly like registerShopSign's own stale-posts
// case.
async function loadCreditOrbsForLandlet(entry, myToken) {
  let orbs;
  try {
    orbs = await fetchCreditOrbs(entry.record.landletId);
  } catch {
    return;
  }
  if (myToken !== entry.orbLoadToken) return; // superseded while this was in flight
  // #3441: so a reload at the limit does not buy one more pop that the next
  // 429 takes back. Best effort; the server still enforces the limit.
  if (orbs.length > 0) fetchCreditOrbStanding().then(applyCreditOrbStanding);
  for (const orb of orbs) {
    const mesh = createCreditOrbMesh();
    mesh.position.set(orb.x, orb.y, orb.z + CREDIT_ORB_FLOAT_HEIGHT_M);
    entry.group.add(mesh);
    shopCreditOrbs.push({ mesh, group: entry.group, orbId: orb.orbId, collecting: false });
  }
}

// updateShopProximity's own greenbelt-landlet unload branch — mirrors
// unloadShopLandletInstances' shape for the claimed-only path, but only
// ever needs to clean up shopCreditOrbs (entry.objects/loaded/loadToken
// stay permanently empty/false/0 for a greenbelt landlet, since nothing
// else ever loads for one).
function unloadCreditOrbsForLandlet(entry) {
  entry.orbsLoaded = false;
  entry.orbLoadToken++; // invalidate any in-flight loadCreditOrbsForLandlet call
  for (const orb of [...shopCreditOrbs]) {
    if (orb.group !== entry.group) continue;
    shopCreditOrbs.splice(shopCreditOrbs.indexOf(orb), 1);
    orb.group.remove(orb.mesh);
    disposeObject3D(orb.mesh);
  }
}

// A small shimmering sphere — emissiveIntensity is animated per-frame in
// updateCreditOrbs (the "shimmer"), rotation.y likewise (the "rotating"),
// per the owner's own spec phrase "a shimmery, rotating orb."
function createCreditOrbMesh() {
  const geometry = new THREE.SphereGeometry(CREDIT_ORB_RADIUS_M, 16, 16);
  const material = new THREE.MeshStandardMaterial({
    color: 0xfff176,
    emissive: 0xffe066,
    emissiveIntensity: CREDIT_ORB_SHIMMER_MIN,
    metalness: 0.2,
    roughness: 0.25,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.isCreditOrb = true;
  return mesh;
}

// #2441: a brief scale-up-then-fade pop, played on a detached clone of the
// just-collected orb's own mesh rather than the real orb -- same "own
// geometry/material, disposed once its short lifespan ends" shape as
// spawnConfettiBurst/updateConfettiBursts below, just for a single growing,
// fading sphere instead of a particle burst. Spawned on a clone (never
// orb.mesh itself, which removeCreditOrb disposes immediately after) so
// this purely cosmetic effect never has to finish before collection logic/
// collision moves on.
// #3392: halved from 0.4 s so the pop reads as a snap on contact.
const CREDIT_ORB_POP_LIFESPAN_S = 0.2;
// #3392: the reversal shown when the server says someone else got the orb first:
// a grey puff that collapses where the orb was, distinct from the bright pop.
const CREDIT_ORB_REVERSAL_LIFESPAN_S = 0.35;
// #3392: how long a returned orb takes to scale back in.
const CREDIT_ORB_RETURN_SCALE_IN_S = 0.25;
const CREDIT_ORB_POP_END_SCALE = 2.5;
const creditOrbPopEffects = [];

function spawnCreditOrbPopEffect(orb) {
  const mesh = new THREE.Mesh(orb.mesh.geometry.clone(), orb.mesh.material.clone());
  mesh.material.transparent = true;
  mesh.position.copy(orb.mesh.position);
  orb.group.add(mesh);
  creditOrbPopEffects.push({ mesh, group: orb.group, elapsed: 0, kind: 'pop' });
}

// #3392: the orb's position kept after it has popped, so a refusal can put an
// orb back (429) or play the reversal where it was (404).
function spawnCreditOrbReversalEffect(snapshot) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(CREDIT_ORB_RADIUS_M, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0x8a8f98, transparent: true, opacity: 0.7 }),
  );
  mesh.position.copy(snapshot.position);
  snapshot.group.add(mesh);
  creditOrbPopEffects.push({ mesh, group: snapshot.group, elapsed: 0, kind: 'reversal' });
}

export function updateCreditOrbPopEffects(dt) {
  for (const effect of [...creditOrbPopEffects]) {
    effect.elapsed += dt;
    const lifespanS = effect.kind === 'reversal' ? CREDIT_ORB_REVERSAL_LIFESPAN_S : CREDIT_ORB_POP_LIFESPAN_S;
    const t = THREE.MathUtils.clamp(effect.elapsed / lifespanS, 0, 1);
    if (effect.kind === 'reversal') {
      effect.mesh.scale.setScalar(1.8 - 1.5 * t); // collapses, the opposite of the pop
      effect.mesh.material.opacity = 0.7 * (1 - t);
    } else {
      effect.mesh.scale.setScalar(1 + (CREDIT_ORB_POP_END_SCALE - 1) * t);
      effect.mesh.material.opacity = 1 - t;
    }
    if (effect.elapsed >= lifespanS) {
      effect.group.remove(effect.mesh);
      effect.mesh.geometry.dispose();
      effect.mesh.material.dispose();
      creditOrbPopEffects.splice(creditOrbPopEffects.indexOf(effect), 1);
    }
  }
}

let creditOrbShimmerElapsedS = 0;
const scratchCreditOrbWorldPos = new THREE.Vector3();
// Set to the timestamp collection attempts may resume at, once a 429 is
// actually hit — null otherwise. A single shared cooldown, not per-orb:
// CREDIT_ORB_COLLECT_RATE_LIMIT_MAX is keyed by builder id, so hitting it
// near one orb means every other orb in range would 429 too if retried.
let creditOrbRateLimitedUntilMs = null;
// #3441: where the server says the person stands against that limit (see
// creditOrbStanding.js), from the orb list load and from every collect reply.
// An orb touched while this says "at the limit" is left in place and the
// notice shows, instead of popping and being reversed by the next 429.
let creditOrbStanding = null;
function applyCreditOrbStanding(reply) {
  const state = creditOrbStandingState(reply, performance.now());
  if (state) creditOrbStanding = state;
}

// Called every Shop-mode frame, unthrottled like updateSignFade/
// updateCalendarFade — the shimmer needs to read as continuous, and
// collection should feel immediate, not stepped to SHOP_PROXIMITY_INTERVAL_MS.
export function updateCreditOrbs(dt) {
  creditOrbShimmerElapsedS += dt;
  const shimmer = CREDIT_ORB_SHIMMER_MIN + (CREDIT_ORB_SHIMMER_MAX - CREDIT_ORB_SHIMMER_MIN)
    * (0.5 + 0.5 * Math.sin(creditOrbShimmerElapsedS * CREDIT_ORB_SHIMMER_SPEED_RAD_S));
  const standingLimit = creditOrbLimitNow(creditOrbStanding, performance.now());
  const rateLimited = standingLimit !== null
    || (creditOrbRateLimitedUntilMs !== null && performance.now() < creditOrbRateLimitedUntilMs);
  // Deliberately the avatar's own position, not camera.position (unlike
  // updateSignFade/updateCalendarFade's fade distance) -- positionShopCamera
  // holds the third-person camera SHOP_CAMERA_FOLLOW_DISTANCE_M (4.2m) behind
  // the avatar, so camera.position would never read as "touching" an orb.
  // #3392: and the segment since last frame, so a fast flyer cannot pass
  // through an orb between two frames.
  const to = { x: shopAvatarPosition.x, y: shopAvatarPosition.y };
  const from = creditOrbPreviousAvatarXY;
  creditOrbPreviousAvatarXY = to;
  const reachM = shopAvatarCollisionHalfM() + CREDIT_ORB_RADIUS_M;
  for (const orb of [...shopCreditOrbs]) {
    orb.mesh.rotation.y += CREDIT_ORB_ROTATION_SPEED_RAD_S * dt;
    orb.mesh.material.emissiveIntensity = shimmer;
    // #3392: a returned orb (429 / unconfirmed) scales back in rather than appearing.
    if (orb.appearT !== undefined && orb.appearT < 1) {
      orb.appearT = Math.min(1, orb.appearT + dt / CREDIT_ORB_RETURN_SCALE_IN_S);
      orb.mesh.scale.setScalar(Math.max(0.01, orb.appearT));
    }
    // Mid-collect orbs are removed from shopCreditOrbs the frame they pop
    // (#3392), so this only guards against a stray double trigger.
    if (orb.collecting) continue;
    const world = orb.mesh.getWorldPosition(scratchCreditOrbWorldPos);
    if (!creditOrbContact({ orbX: world.x, orbY: world.y, from, to, reachM })) {
      orb.noticeShownForContact = false;
      orb.rearmOnLeave = false;
      continue;
    }
    // #3392: an orb that came back (429 / never confirmed) does not pop again
    // under an avatar still standing on it; the person steps off and back.
    if (orb.rearmOnLeave) continue;
    // #2443: horizontal proximity alone also fired for flying directly over
    // an orb at any altitude, since height above ground was never checked.
    // shopFlightAltitudeM (not world z -- see CREDIT_ORB_COLLECT_ALTITUDE_
    // TOLERANCE_M's own comment on why) is the curvature-independent "how
    // high above local ground" signal already tracked for flight, so this
    // excludes real flight altitude without touching an ordinary ground
    // walk-in.
    if (Math.abs(shopFlightAltitudeM) > CREDIT_ORB_COLLECT_ALTITUDE_TOLERANCE_M) continue;
    // Cooling down after a 429 (see creditOrbRateLimitedUntilMs): the person
    // is at the limit already, so the orb does not pop; touching it says why,
    // once per contact, instead of silently doing nothing (#3392, and
    // "A message that limits or refuses an action states the limit").
    if (rateLimited) {
      if (!orb.noticeShownForContact) {
        orb.noticeShownForContact = true;
        showCreditOrbRateLimitNotice(standingLimit ?? creditOrbLastRateLimit);
      }
      continue;
    }
    popAndCollectCreditOrb(orb);
  }
}

// #3392: the frame the avatar touches the orb it pops, the toast shows and the
// request goes out; the server stays the authority and a refusal is reversed
// visibly with the reason (404: someone else got it, 429: the limit, anything
// else: retried quietly for a few seconds, then the orb comes back).
let creditOrbPreviousAvatarXY = null;
let creditOrbLastRateLimit = null;

function popAndCollectCreditOrb(orb) {
  orb.collecting = true;
  // Kept so a refusal can put the orb back or play the reversal where it was.
  const snapshot = { orbId: orb.orbId, group: orb.group, position: orb.mesh.position.clone() };
  // #2441: spawned before removeCreditOrb disposes the real orb.mesh -- the pop
  // clones it first, so it has its own geometry/material to animate.
  spawnCreditOrbPopEffect(orb);
  removeCreditOrb(orb);
  showCreditOrbToast();
  const startedAt = performance.now();
  const attempt = () => {
    collectCreditOrb(snapshot.orbId).then((reply) => {
      applyCreditOrbStanding(reply?.standing);
      markCreditOrbCollectReachedServer();
      hideCreditOrbRateLimitNotice(); // #3303: a successful collect means the limit lifted
    }).catch((error) => {
      const refusal = creditOrbRefusalKind(error);
      if (refusal === 'retry') {
        // #2447: a 403/5xx is still a real HTTP response proving the server is
        // reachable; only fetch() itself rejecting counts toward "offline".
        if (isNetworkError(error)) markCreditOrbCollectFailedToReachServer();
        else markCreditOrbCollectReachedServer();
        if (creditOrbMayRetry(performance.now() - startedAt)) {
          setTimeout(attempt, CREDIT_ORB_RETRY_INTERVAL_MS);
          return;
        }
        // Gave up: the orb was never confirmed, so it comes back and the
        // person is told, instead of the pop standing for something that did
        // not happen (#2264: it must not vanish for the session either).
        hideCreditOrbToast();
        restoreCreditOrb(snapshot);
        showCreditOrbProblemNotice(isNetworkError(error)
          ? "Couldn't collect that orb. You appear to be offline."
          : "Couldn't collect that orb. Try touching it again in a moment.");
        return;
      }
      markCreditOrbCollectReachedServer();
      hideCreditOrbToast();
      if (refusal === 'gone') {
        // The server's own atomic claim is authoritative: another shopper
        // collected it first. It stays gone; the reversal shows where it was.
        spawnCreditOrbReversalEffect(snapshot);
        showCreditOrbProblemNotice('Someone else collected that orb just before you.');
        return;
      }
      // 429, CREDIT_ORB_COLLECT_RATE_LIMIT_MAX: the orb comes back, the limit
      // and when it lifts are shown, and collecting pauses for a cooldown so
      // standing in range is not a retry storm.
      creditOrbRateLimitedUntilMs = performance.now() + CREDIT_ORB_RATE_LIMIT_RETRY_COOLDOWN_MS;
      creditOrbLastRateLimit = error.rateLimit;
      if (error.rateLimit) applyCreditOrbStanding({ ...error.rateLimit, remaining: 0 });
      restoreCreditOrb(snapshot);
      // #3441: said in the same sentence as the limit, so a person who saw the
      // pop knows the orb was given back.
      showCreditOrbRateLimitNotice(error.rateLimit, { orbCameBack: true });
    });
  };
  attempt();
}

// A popped orb the server did not confirm: a fresh mesh at the same spot,
// scaling back in. Skipped if its landlet unloaded meanwhile.
function restoreCreditOrb(snapshot) {
  if (!snapshot.group.parent) return;
  const mesh = createCreditOrbMesh();
  mesh.position.copy(snapshot.position);
  mesh.scale.setScalar(0.01);
  snapshot.group.add(mesh);
  shopCreditOrbs.push({ mesh, group: snapshot.group, orbId: snapshot.orbId, collecting: false, appearT: 0, rearmOnLeave: true });
}

// #2447: null while no genuine network failure is currently in progress;
// set to the timestamp of the *first* one in an unbroken streak once one
// starts, across every orb's own collect attempts (this is a connectivity
// signal, not a per-orb one). markCreditOrbCollectReachedServer resets it
// the moment any attempt gets a real response, same as it clears the
// notice -- a single dropped frame shouldn't flash anything, only a
// sustained outage should.
let creditOrbOfflineStreakStartedAt = null;

function markCreditOrbCollectReachedServer() {
  creditOrbOfflineStreakStartedAt = null;
  shopCreditOrbOfflineNoticeEl.classList.remove('visible');
}

function markCreditOrbCollectFailedToReachServer() {
  const now = performance.now();
  if (creditOrbOfflineStreakStartedAt === null) {
    creditOrbOfflineStreakStartedAt = now;
    return;
  }
  if (now - creditOrbOfflineStreakStartedAt >= CREDIT_ORB_OFFLINE_NOTICE_THRESHOLD_MS) {
    if (!shopCreditOrbOfflineNoticeEl.classList.contains('visible')) {
      recordVisibleMessage(shopCreditOrbOfflineNoticeTextEl.textContent); // #3303
      bringShopNoticeToFront(shopCreditOrbOfflineNoticeEl);
    }
    shopCreditOrbOfflineNoticeEl.classList.add('visible');
  }
}

function removeCreditOrb(orb) {
  const index = shopCreditOrbs.indexOf(orb);
  if (index === -1) return; // already removed (e.g. its landlet was unloaded while the request was in flight)
  shopCreditOrbs.splice(index, 1);
  orb.group.remove(orb.mesh);
  disposeObject3D(orb.mesh);
}

// #2264: e2e-only hook, same window.__test* convention as
// window.__testLowStockHighlightedInstanceIds/window.__testSoldOutMarkerMeshIds
// -- lets a test confirm an orb survives a transient collect failure
// (429/500/network) instead of being wrongly removed from the scene.
window.__testActiveCreditOrbIds = () => shopCreditOrbs.map((orb) => orb.orbId);
// #2441: same e2e-only convention as window.__testActiveCreditOrbIds just
// above -- lets a test confirm a pop effect actually spawned on collection
// (and, after waiting out CREDIT_ORB_POP_LIFESPAN_S, that it cleaned itself
// up again) without depending on fragile pixel-level visual assertions.
window.__testActiveCreditOrbPopEffectCount = () => creditOrbPopEffects.filter((e) => e.kind === 'pop').length;
// #3392: same convention, for the reversal puff shown when someone else got the orb.
window.__testActiveCreditOrbReversalEffectCount = () => creditOrbPopEffects.filter((e) => e.kind === 'reversal').length;

function showCreditOrbToast() {
  shopCreditOrbToastEl.classList.add('visible');
  clearTimeout(creditOrbToastHideTimer);
  creditOrbToastHideTimer = setTimeout(() => {
    shopCreditOrbToastEl.classList.remove('visible');
  }, CREDIT_ORB_TOAST_VISIBLE_MS);
}
let creditOrbToastHideTimer = null;
function hideCreditOrbToast() {
  clearTimeout(creditOrbToastHideTimer);
  shopCreditOrbToastEl.classList.remove('visible');
}

// #3303 (owner decision: an error or refusal stays until the person dismisses
// it): unlike the toast above, this no longer fades on a timer. It stays until
// the person dismisses it or a collect succeeds again (the limit has plainly
// lifted by then), and carries Copy and dismiss controls. Mode switches reload
// the page, so it cannot linger into Build/Sell.
const shopCreditOrbRateLimitNoticeTextEl = shopCreditOrbRateLimitNoticeEl.querySelector('.shop-notice-text');
const shopCreditOrbOfflineNoticeTextEl = shopCreditOrbOfflineNoticeEl.querySelector('.shop-notice-text');
// #3441: the orb notices share one stack (#shop-notice-stack) so two showing at
// once are both readable, and the one raised last sits nearest the controls
// (highest `order`; the stack is bottom-anchored). Nothing here ever hides
// another notice.
let shopNoticeOrderCounter = 0;
function bringShopNoticeToFront(noticeEl) {
  shopNoticeOrderCounter += 1;
  noticeEl.style.order = String(shopNoticeOrderCounter);
}
function showCreditOrbRateLimitNotice(rateLimit, { orbCameBack = false } = {}) {
  const text = rateLimitNoticeText('orbs', rateLimit);
  if (text) shopCreditOrbRateLimitNoticeTextEl.textContent = orbCameBack ? `That orb is back where it was. ${text}` : text;
  else if (orbCameBack) shopCreditOrbRateLimitNoticeTextEl.textContent = "That orb is back where it was. You've reached the orb limit for now. Try again in a bit.";
  bringShopNoticeToFront(shopCreditOrbRateLimitNoticeEl);
  shopCreditOrbRateLimitNoticeEl.classList.add('visible');
  recordVisibleMessage(shopCreditOrbRateLimitNoticeTextEl.textContent);
}
function hideCreditOrbRateLimitNotice() {
  shopCreditOrbRateLimitNoticeEl.classList.remove('visible');
}
shopCreditOrbRateLimitNoticeEl.querySelector('.shop-notice-dismiss-btn').addEventListener('click', hideCreditOrbRateLimitNotice);
// #3392: a collect the server refused after the orb had popped. Like the other
// orb notices it stays until dismissed and its text is selectable (#3303).
const shopCreditOrbProblemNoticeTextEl = shopCreditOrbProblemNoticeEl.querySelector('.shop-notice-text');
function showCreditOrbProblemNotice(text) {
  shopCreditOrbProblemNoticeTextEl.textContent = text;
  bringShopNoticeToFront(shopCreditOrbProblemNoticeEl);
  shopCreditOrbProblemNoticeEl.classList.add('visible');
  recordVisibleMessage(text);
}
shopCreditOrbProblemNoticeEl.querySelector('.shop-notice-dismiss-btn').addEventListener('click', () => {
  shopCreditOrbProblemNoticeEl.classList.remove('visible');
});
