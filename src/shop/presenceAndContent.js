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
import { setInstanceLodState, buildInstanceLodProxy, createMeshForInstance } from '../world/models.js';
import { sampleUniformDiskRadiusM } from '../spawnLocation.js';
import { isNetworkError } from '../build/scene.js';
import { currentAuthUser } from '../account/auth.js';
import {
  fetchLandlet, fetchLandletVersion, fetchInstances,
  fetchCreditOrbs, collectCreditOrb, reportPresence, fetchNearbyPresence,
} from '../api.js';
import { createShopAvatar } from './avatar.js';
import { shopMaxRadiusM, shopFlightState, shopFlightAltitudeM } from './flightMovement.js';
import { growShopDomeIfNeeded } from './sky.js';
import {
  shopAvatarPosition, shopAvatarFacing, disposeObject3D, pointInPolygonXY,
  unloadShopLandletInstances,
} from '../main.js';
import { registerShopSign, registerShopCalendar, registerShopReview } from './worldSprites.js';

const shopCreditOrbToastEl = document.getElementById('shop-credit-orb-toast');
const shopCreditOrbOfflineNoticeEl = document.getElementById('shop-credit-orb-offline-notice');
export const accountMenuLandletInfoEl = document.getElementById('account-menu-landlet-info');

// #1630: how many times pickShopSpawnLocation will reroll a candidate that
// landed on a water landlet before giving up and using it anyway -- a
// bound, not a tuned value, purely so a (realistically impossible) world
// that's entirely water can't spin this loop forever.
const SHOP_SPAWN_LOCATION_MAX_ATTEMPTS = 20;

// This near/far load-unload distance (plus the middle-LOD band just below,
// #2378 of docs/SPEC.md §1's fuller near/middle-LOD/far-panoramic-backdrop
// system, #2377) is the only "chunk loading" that exists today — the far
// band's own pre-rendered panoramic backdrop isn't built yet (still just
// the flat sky-dome color beyond SHOP_UNLOAD_RADIUS_M), so there's no
// per-band curvature concern to check for it yet. And even if there were:
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
export const SHOP_LOAD_RADIUS_M = 60;
const SHOP_UNLOAD_RADIUS_M = 90;
// #2378: a middle LOD band between the near (full detail, above) and far
// (unload, above) radii, giving the simplified-proxy swap its own
// enter/exit hysteresis gap — the same enter-at-one-distance/exit-at-a-
// closer-one shape SHOP_LOAD_RADIUS_M/SHOP_UNLOAD_RADIUS_M already use for
// the near/far transition, so an avatar hovering right at one boundary
// doesn't thrash the LOD swap every frame. Both sit strictly inside
// [SHOP_LOAD_RADIUS_M, SHOP_UNLOAD_RADIUS_M] so the full progression reads
// as near (0-65m, full detail) → middle (65-90m experienced range, but the
// swap only actually triggers past 75m until the avatar comes back under
// 65m) → far (unload past 90m).
const SHOP_MIDDLE_LOD_ENTER_RADIUS_M = 75; // switch to the simplified proxy once past this
const SHOP_MIDDLE_LOD_EXIT_RADIUS_M = 65; // switch back to full detail once back under this

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
// #2626: main.js's own renderBuilderIdentityField onRenamed callback
// patches a single label in place on a successful rename (#741) -- a
// dedicated setter rather than exposing the Map itself for `.set()`, same
// "narrow the exposed surface to the one real operation" reasoning as
// shop/avatar.js's own addShopIdleSwayYawOffset.
export function setShopBuilderLabel(builderId, label) {
  shopBuilderLabels.set(builderId, label);
}
let shopCurrentLandletEntry = null; // whichever shopLandlets entry the shopper is standing on, else null — see updateShopLandletInfo
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
// the latest poll landed, for timing the lerp against) }.
export const shopOtherAvatars = new Map();
let shopLastPresencePollAt = 0;
let presencePollToken = 0; // #1911: guards pollNearbyPresenceIfNeeded against a stale out-of-order response
// #1995: every currently-loaded credit orb: { mesh, group, orbId, landletId }.
// Unlike shopSigns/shopCalendars (main.js, worldSprites.js's own not-yet-
// extracted territory), an orb isn't a placed instance at all (#1994's own
// data model, a separate credit_orbs table keyed only by landlet) — so
// it's fetched and added alongside a landlet's own instances in
// loadShopLandletInstances rather than discovered via any instance's
// userData, but torn down the identical way in unloadShopLandletInstances.
const shopCreditOrbs = [];

export function updateShopProximity() {
  for (const entry of shopLandlets.values()) {
    const distance = Math.hypot(entry.record.center.x - camera.position.x, entry.record.center.y - camera.position.y);
    if (entry.record.status === 'claimed') {
      if (!entry.loaded && distance < SHOP_LOAD_RADIUS_M) {
        entry.loaded = true; // set before awaiting so a second tick can't double-load
        entry.lod = 'near'; // SHOP_LOAD_RADIUS_M < SHOP_MIDDLE_LOD_EXIT_RADIUS_M, so a fresh load always starts near
        // Each load gets its own token (see loadShopLandletInstances) so a
        // fast unload-then-reload cycle can't let an earlier, still in-flight
        // fetch resurrect itself once entry.loaded flips back to true.
        loadShopLandletInstances(entry, ++entry.loadToken);
      } else if (entry.loaded && distance > SHOP_UNLOAD_RADIUS_M) {
        unloadShopLandletInstances(entry);
      } else if (entry.loaded) {
        // #2378: the middle LOD band's own enter/exit hysteresis, same
        // "only flip once past the gap, not right at a shared boundary"
        // shape the near/far load-unload check above already uses.
        if (entry.lod !== 'middle' && distance > SHOP_MIDDLE_LOD_ENTER_RADIUS_M) {
          entry.lod = 'middle';
          for (const object of entry.objects) setInstanceLodState(object, true);
        } else if (entry.lod !== 'near' && distance < SHOP_MIDDLE_LOD_EXIT_RADIUS_M) {
          entry.lod = 'near';
          for (const object of entry.objects) setInstanceLodState(object, false);
        }
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
}

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
  if (myPresencePollToken !== presencePollToken) return; // a newer poll already landed
  const seenBuilderIds = new Set();
  for (const avatar of avatars) {
    seenBuilderIds.add(avatar.builderId);
    let entry = shopOtherAvatars.get(avatar.builderId);
    if (!entry) {
      // Renders every other avatar as the default procedural body
      // (createShopAvatar) regardless of what they actually have equipped —
      // fetching and loading each nearby builder's own custom model is
      // real scope beyond "report-loop, poll-loop, and smoothing," left for
      // a follow-up rather than silently bundled in here. Limb/arm pose
      // isn't driven for these either, same reasoning — only root position/
      // heading, which is all #1098's presence row actually carries.
      const { group } = createShopAvatar();
      scene.add(group);
      entry = {
        group,
        fromX: avatar.x, fromY: avatar.y, fromZ: avatar.z, fromHeading: avatar.heading ?? 0,
      };
      shopOtherAvatars.set(avatar.builderId, entry);
    } else {
      entry.fromX = entry.toX;
      entry.fromY = entry.toY;
      entry.fromZ = entry.toZ;
      entry.fromHeading = entry.toHeading;
    }
    entry.toX = avatar.x;
    entry.toY = avatar.y;
    entry.toZ = avatar.z;
    entry.toHeading = avatar.heading ?? entry.fromHeading;
    entry.receivedAt = now;
    entry.missedPolls = 0; // #2436: seen again -- clear any pending despawn countdown
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
    disposeObject3D(entry.group);
    shopOtherAvatars.delete(builderId);
  }
  refreshOtherShopAvatarsDiagnostic();
}

function despawnOtherShopAvatars() {
  for (const entry of shopOtherAvatars.values()) {
    scene.remove(entry.group);
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
  }));
}

// #1100: lerps every tracked other-avatar from its previous poll snapshot
// toward its latest one over the poll interval, every frame — what makes a
// once-a-second polling transport read as continuous motion rather than a
// visible snap/teleport on each poll tick (the issue's own "smoothing").
export function updateOtherShopAvatars(now) {
  for (const entry of shopOtherAvatars.values()) {
    const t = Math.min(1, (now - entry.receivedAt) / SHOP_PRESENCE_POLL_INTERVAL_MS);
    entry.group.position.set(
      THREE.MathUtils.lerp(entry.fromX, entry.toX, t),
      THREE.MathUtils.lerp(entry.fromY, entry.toY, t),
      THREE.MathUtils.lerp(entry.fromZ, entry.toZ, t),
    );
    entry.group.rotation.z = entry.fromHeading + shortestAngleDelta(entry.fromHeading, entry.toHeading) * t;
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
  for (const instance of instances) {
    if (myToken !== entry.loadToken) return; // superseded while this was in flight
    const object = await createMeshForInstance(instance);
    if (!object) continue;
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
      return;
    }
    entry.group.add(object);
    entry.objects.push(object);
    growShopDomeIfNeeded(object);
    // #2378: built/attached after growShopDomeIfNeeded above, not before —
    // the proxy's box dimensions approximate the model's declared template
    // size, which can differ slightly from the real mesh's own rendered
    // bounds, so keeping it out of that one Box3.setFromObject(object) call
    // avoids any chance of it skewing the dome-growth calculation.
    const lodProxy = buildInstanceLodProxy(object);
    if (lodProxy) {
      object.userData.lodProxy = lodProxy;
      object.add(lodProxy);
    }
    setInstanceLodState(object, entry.lod === 'middle');
    if (object.userData.isCommunitySign) registerShopSign(object, entry);
    if (object.userData.isCommunityCalendar) registerShopCalendar(object, entry);
    // Unlike signs/calendar above, reviews have no builder opt-in flag at
    // all — every placed instance's underlying catalog template is
    // reviewable by definition (see docs/API.md's "Product reviews"), so
    // this registers unconditionally.
    registerShopReview(object, entry);
  }
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
const CREDIT_ORB_POP_LIFESPAN_S = 0.4;
const CREDIT_ORB_POP_END_SCALE = 2.5;
const creditOrbPopEffects = [];

function spawnCreditOrbPopEffect(orb) {
  const mesh = new THREE.Mesh(orb.mesh.geometry.clone(), orb.mesh.material.clone());
  mesh.material.transparent = true;
  mesh.position.copy(orb.mesh.position);
  orb.group.add(mesh);
  creditOrbPopEffects.push({ mesh, group: orb.group, elapsed: 0 });
}

export function updateCreditOrbPopEffects(dt) {
  for (const effect of [...creditOrbPopEffects]) {
    effect.elapsed += dt;
    const t = THREE.MathUtils.clamp(effect.elapsed / CREDIT_ORB_POP_LIFESPAN_S, 0, 1);
    effect.mesh.scale.setScalar(1 + (CREDIT_ORB_POP_END_SCALE - 1) * t);
    effect.mesh.material.opacity = 1 - t;
    if (effect.elapsed >= CREDIT_ORB_POP_LIFESPAN_S) {
      effect.group.remove(effect.mesh);
      effect.mesh.geometry.dispose();
      effect.mesh.material.dispose();
      creditOrbPopEffects.splice(creditOrbPopEffects.indexOf(effect), 1);
    }
  }
}

let creditOrbShimmerElapsedS = 0;
const scratchCreditOrbWorldPos = new THREE.Vector3();

// Called every Shop-mode frame, unthrottled like updateSignFade/
// updateCalendarFade — the shimmer needs to read as continuous, and
// collection should feel immediate, not stepped to SHOP_PROXIMITY_INTERVAL_MS.
export function updateCreditOrbs(dt) {
  creditOrbShimmerElapsedS += dt;
  const shimmer = CREDIT_ORB_SHIMMER_MIN + (CREDIT_ORB_SHIMMER_MAX - CREDIT_ORB_SHIMMER_MIN)
    * (0.5 + 0.5 * Math.sin(creditOrbShimmerElapsedS * CREDIT_ORB_SHIMMER_SPEED_RAD_S));
  for (const orb of shopCreditOrbs) {
    orb.mesh.rotation.y += CREDIT_ORB_ROTATION_SPEED_RAD_S * dt;
    orb.mesh.material.emissiveIntensity = shimmer;
    // Already mid-collect-request — avoid firing a second one every frame
    // while the first is still in flight (walking stays within the radius
    // for several frames, not just one).
    if (orb.collecting) continue;
    // Deliberately the avatar's own position, not camera.position (unlike
    // updateSignFade/updateCalendarFade's fade distance) -- positionShopCamera
    // holds the third-person camera SHOP_CAMERA_FOLLOW_DISTANCE_M (4.2m)
    // behind the avatar, well outside CREDIT_ORB_COLLECT_RADIUS_M on its
    // own, so camera.position would never read as "standing on it" at this
    // tight a radius the way it still works for signs/calendars' much wider
    // SIGN_INTERACT_RADIUS_M (8m).
    const world = orb.mesh.getWorldPosition(scratchCreditOrbWorldPos);
    const dx = world.x - shopAvatarPosition.x;
    const dy = world.y - shopAvatarPosition.y;
    if (Math.hypot(dx, dy) > CREDIT_ORB_COLLECT_RADIUS_M) continue;
    // #2443: horizontal proximity alone also fired for flying directly over
    // an orb at any altitude, since height above ground was never checked.
    // shopFlightAltitudeM (not world z -- see CREDIT_ORB_COLLECT_ALTITUDE_
    // TOLERANCE_M's own comment on why) is the curvature-independent "how
    // high above local ground" signal already tracked for flight, so this
    // excludes real flight altitude without touching an ordinary ground
    // walk-in.
    if (Math.abs(shopFlightAltitudeM) > CREDIT_ORB_COLLECT_ALTITUDE_TOLERANCE_M) continue;
    orb.collecting = true;
    collectCreditOrb(orb.orbId).then(() => {
      // #2441: spawned before removeCreditOrb disposes the real orb.mesh
      // below -- this clones it first, so the pop has its own geometry/
      // material to animate independently of the disposal.
      markCreditOrbCollectReachedServer();
      spawnCreditOrbPopEffect(orb);
      removeCreditOrb(orb);
      showCreditOrbToast();
    }).catch((error) => {
      // #2222: a 403 means the server's own avatar_presence record hasn't
      // caught up with this walk-in yet (SHOP_PRESENCE_REPORT_INTERVAL_MS/
      // SHOP_PRESENCE_HEARTBEAT_INTERVAL_MS throttle how often that gets
      // posted) -- not a real rejection, so this leaves the orb in place
      // and clears the in-flight guard to let the very next frame retry,
      // the same way it would if collecting had never fired at all.
      if (error.status === 403) {
        markCreditOrbCollectReachedServer();
        orb.collecting = false;
        return;
      }
      // The server's own atomic claim is authoritative (docs/API.md's
      // "Credit orbs" section) — a 404 here just means another shopper
      // collected it first, not a real error, so this quietly drops the
      // now-stale orb from the scene instead of surfacing anything to the
      // shopper or retrying.
      if (error.status === 404) {
        markCreditOrbCollectReachedServer();
        removeCreditOrb(orb);
        return;
      }
      // #2264: everything else (a 429 from CREDIT_ORB_COLLECT_RATE_LIMIT_MAX,
      // a 500, a plain network blip) used to fall through to the 404
      // branch above and remove the orb as if it had genuinely been
      // collected by someone else -- loadCreditOrbsForLandlet only ever
      // fetches a landlet's orbs once, so a wrongly-removed orb was gone
      // from this session's view for good. Transient, same as 403: leave
      // the orb in place and let the next frame retry.
      // #2447: a 429/500 is still a real HTTP response (error.status is
      // set), proving the server was reachable -- only a genuine network
      // failure (isNetworkError, fetch() itself rejecting with no response
      // at all) counts as evidence of actually being offline.
      if (isNetworkError(error)) {
        markCreditOrbCollectFailedToReachServer();
      } else {
        markCreditOrbCollectReachedServer();
      }
      orb.collecting = false;
    });
  }
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
window.__testActiveCreditOrbPopEffectCount = () => creditOrbPopEffects.length;

function showCreditOrbToast() {
  shopCreditOrbToastEl.classList.add('visible');
  clearTimeout(creditOrbToastHideTimer);
  creditOrbToastHideTimer = setTimeout(() => {
    shopCreditOrbToastEl.classList.remove('visible');
  }, CREDIT_ORB_TOAST_VISIBLE_MS);
}
let creditOrbToastHideTimer = null;
