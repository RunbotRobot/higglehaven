// #2629 (last leaf of #2563, itself part of #2504/#2500's src/main.js
// module split -- see #2503's design comment and #2563's own breakdown
// comment for the full dependency map): enterShopMode itself -- the
// per-visit world-build sequence (identity gate, catalog/world/landlet
// fetch, wall/dome/ground construction, avatar spawn) that wires together
// every other shop/*.js leaf under #2563 (avatar.js #2623, flightMovement.js
// #2624, sky.js #2625, presenceAndContent.js #2626, worldSprites.js #2627,
// productCheckout.js #2628) -- plus disposeObject3D/unloadShopLandletInstances
// (the renderer-resource teardown helpers enterShopMode and several of
// those other leaves all call into) and reportRendererMemoryDiagnostic (the
// GPU-resource-count e2e test hook enterShopMode/avatar.js's own
// refreshEquippedShopAvatar call after a swap).
//
// Depends on every other shop/*.js leaf under #2563 having landed first --
// enterShopMode's own body is largely just calling into each of them in the
// same order/shape main.js always has.
//
// shopActive, shopWorldRadiusM, shopDomeMesh, shopLastLocation, and
// shopEquippedAvatarSkeletonSignature stay owned by main.js, same as before
// this leaf -- each is read by one or more sibling shop/*.js modules (or,
// for shopActive/shopEquippedAvatarSkeletonSignature, by main.js's own
// not-yet-extracted code too) via a plain reverse-imported binding, and this
// module was the only writer for all five even while it still lived in
// main.js. Since an ES import binding is read-only from the importing side,
// main.js now exports a setShopActive/setShopWorldRadiusM/setShopDomeMesh/
// setShopLastLocation/setShopEquippedAvatarSkeletonSignature setter for
// each, same shape world/state.js's own setCurrentMode etc. already
// established. Likewise SHOP_WALL_HEIGHT_M/SHOP_HIDDEN_BUILDER_UI_IDS/
// SHOP_PLOT_COLORS/plotColorKeyForLandlet/shapeForLandlet/pointInPolygonXY/
// shopAvatarFacing and the DOM elements (shopStatusEl/shopMoveJoystickEl/
// shopLookJoystickEl/shopFlyBtn/shopVerticalControlsEl/shopSignHintEl/
// shopCalendarHintEl) stay in main.js too -- each either used by code that
// stays there (showShopAccessGate's own decline branches, the sign/calendar
// click handlers, claim/flow.js's reverse import of shapeForLandlet/
// plotColorKeyForLandlet) or just never reassigned from here, so a plain
// reverse-imported read-only binding is enough.
//
// SHOP_WALL_MARGIN_M/SHOP_GROUND_HORIZON_COLOR/SHOP_HAZY_HORIZON_COLOR/
// SHOP_SKY_DOME_COLOR/SHOP_LANDLET_CULL_MARGIN_M, the (dead-write, never
// actually read) shopWallMesh/shopWorldObjects fields, and the
// computeGaplessWorldRadius/applyGroundCurvature helpers (with their own
// landletWorldPolygon/SHOP_COVERAGE_ANGLE_SAMPLES/SHOP_COVERAGE_RADIUS_STEP_M
// private helpers) all move here wholesale instead -- nothing outside
// enterShopMode ever referenced any of them, even back when it still lived
// in main.js.
import * as THREE from 'three';
import { landlet, createGroundTexture, normalizeGroundShapeUVs, disposeObject, disposeMaterialTextures } from '../world/models.js';
import { scene, camera, renderer, registerModeFrameUpdate, registerFacingOverride } from '../world/scene.js';
import { activeCatalog, setActiveCatalog } from '../world/state.js';
import { authInitPromise, accountRecoveryFlowActive, currentAuthUser } from '../account/auth.js';
import { ensureShopperIdentity } from '../account/identity.js';
import {
  controls, rotateControls, translateControls, clearSelection,
  productMeshes, removeLowStockHighlight,
  setActiveLowStockTemplateIds, setLowStockFilterMaxQty, setLowStockFilterMaxDays,
  clearSoldOutMarkerMeshes, setShowSoldOutMarkers, setSoldOutMarkers,
  removeSelectionOutline,
} from '../build/scene.js';
import { CATALOG as FALLBACK_CATALOG } from '../catalog.js';
import {
  fetchCatalog, fetchWorld, fetchAllLandlets, fetchBuildersByIds,
  fetchMyEquippedAvatar, fetchMyEquippedAnimation, fetchOwnLastPresence,
} from '../api.js';
import { curvatureDropM, relativeCurvatureDropM } from '../../worker/earthCurvature.js';
import {
  SHOP_HIDDEN_BUILDER_UI_IDS, showShopAccessGate,
  shopStatusEl, shopMoveJoystickEl, shopLookJoystickEl, shopFlyBtn, shopVerticalControlsEl,
  shopSignHintEl, shopCalendarHintEl,
  SHOP_WALL_HEIGHT_M, SHOP_PLOT_COLORS, plotColorKeyForLandlet, shapeForLandlet, pointInPolygonXY,
  shopAvatarPosition, shopAvatarFacing,
  setShopActive, setShopWorldRadiusM, setShopDomeMesh,
  setShopEquippedAvatarSkeletonSignature, setShopLastLocation,
} from '../main.js';
import {
  shopAvatar, setShopAvatar, createShopAvatar, createCustomShopAvatar,
  shopAvatarHeightM, shopAvatarCollisionHalfM, shopCameraAnchorHeightM,
  resetShopAvatarIdleState,
} from './avatar.js';
import { beginShopSpawn, updateShopMovement } from './flightMovement.js';
import {
  shopDomeRiseM, resetShopDomeRiseM, paintVerticalGradient,
  SHOP_SKY_VERTEX_SHADER, SHOP_SKY_FRAGMENT_SHADER, initShopSkyMaterial, updateShopSky,
  currentShopSkyTimeS,
} from './sky.js';
import {
  shopLandlets, pickShopSpawnLocation, setShopBuilderLabels, updateShopLandletInfo,
  resetShopCurrentLandletEntry, accountMenuLandletInfoEl,
} from './presenceAndContent.js';
import {
  shopSigns, shopCalendars, shopReviews,
  nearestActiveSign, setNearestActiveSign, nearestActiveCalendar, setNearestActiveCalendar,
  shopTappedProduct, setShopTappedProduct,
  setShopReviewHintsVisible, setShopReviewHintsProduct,
  shopHighlightedProduct, setShopHighlightedProduct,
  disposeSignSprites, disposeCalendarSprites, disposeReviewSprites,
} from './worldSprites.js';
import { closeShopProductPreviewModal, confettiBursts, disposeConfettiBurst } from './productCheckout.js';
import { recordRenderStateSample } from '../feedback/renderStateBuffer.js';
import { shopFeedbackBtn } from '../feedback/submitFeedbackUI.js';

// small ground/wall seam overlap only — see wildGround below (enterShopMode)
const SHOP_WALL_MARGIN_M = 1.5;
// A dome caps the wall's open top, and both share one continuous vertical
// gradient (pale ground-green at the base, through a hazy horizon blend
// right at the wall/dome seam, up to a deeper sky blue at the dome's own
// apex) painted directly as vertex colors rather than a texture — see
// paintVerticalGradient. The illusion this is going for is a horizon that
// recedes into atmospheric haze and open sky, not a wall the world
// visibly stops at.
const SHOP_GROUND_HORIZON_COLOR = new THREE.Color(0xa8d98a); // the wall's own former flat color, now just its base
const SHOP_HAZY_HORIZON_COLOR = new THREE.Color(0xcfe8dc); // where wall meets dome — both gradients hit this exact color, so the seam is invisible
const SHOP_SKY_DOME_COLOR = new THREE.Color(0x5a9fd4); // deeper than the flat backdrop sky (0x87ceeb) for a sense of real overhead depth
// Skip building a ground mesh for a landlet with no chance of being seen
// (entirely beyond the wall, comfortably past any land's own footprint) —
// pure cost-cutting as the world grows, never aggressive enough to risk
// hiding a real sliver.
const SHOP_LANDLET_CULL_MARGIN_M = 40;

let shopWallMesh = null;
const shopWorldObjects = []; // ground meshes + the wild backdrop — disposed together on exit

// #135 (docs/SPEC.md §1's "Earth-curvature coordinate system from day
// one"): a flat CircleGeometry's vertices lie exactly in its own XY plane
// (z = 0 everywhere) — this nudges each one to where it actually sits on a
// curved Earth, relative to (worldCenterX, worldCenterY): the mesh's own
// local origin stays at z = 0 exactly, and every other vertex gets the
// extra sag or rise relativeCurvatureDropM says it should have relative to
// that. Z-only, and doesn't reorient the mesh's own local frame to match
// its true surface normal at each vertex — fine for this function's only
// call site, wildGround's single, scene-origin-anchored fill circle:
// sagging visibly toward the rim over real world-radius distances is
// exactly the effect wanted, and there's no neighboring mesh it needs to
// blend with at a shared edge. (Per-landlet ground curvature isn't done
// this way — see #135/#166 — a landlet's own polygon is small enough that
// positioning/orienting its whole THREE.Group is both simpler and
// visually indistinguishable from a true per-vertex curve.) Called once
// right after building a ground mesh's geometry, before it's ever added
// to the scene.
function applyGroundCurvature(geometry, worldCenterX, worldCenterY) {
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const localX = position.getX(i);
    const localY = position.getY(i);
    const drop = relativeCurvatureDropM(worldCenterX + localX, worldCenterY + localY, worldCenterX, worldCenterY);
    position.setZ(i, position.getZ(i) + drop);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
}

// The mosaic tessellation guarantees no gaps *between* adjacent cells (see
// generate-mosaic's own doc comment in worker/index.js), but its outer
// edge is scalloped, not a perfect circle: some directions reach past the
// world radius, others fall short of it, since the world radius has been
// expanded several times since the mosaic was generated without new
// geometry necessarily following it out in every direction. A wall drawn
// as a plain circle at the world radius exposed bare "wild ground" in the
// short directions — real, but not part of any land, which is exactly the
// thing the wall exists to hide. This instead finds the largest circle
// that's fully covered by *some* landlet's polygon in every direction, by
// marching outward at each of many sampled angles and stopping at the
// first gap. The wall goes there, not at the administrative radius —
// landlets with geometry beyond it (the currently-generating ones) still
// get built normally and show whatever fraction of them the wall doesn't
// cut off, same as before.
const SHOP_COVERAGE_ANGLE_SAMPLES = 144;
const SHOP_COVERAGE_RADIUS_STEP_M = 2;
// A landlet without a real generated polygon still actually renders as a
// plain area-sized square (see shapeForLandlet's own fallback) — computing
// coverage against real polygons only, while excluding those squares
// entirely, used to make computeGaplessWorldRadius think there was a gap
// exactly where starter-landlet's own square visibly sits. Worse than
// merely inaccurate: starter-landlet ships with an empty polygon by
// default and only ever gets a real one via the one-time /land-candidates/
// generate-mosaic call, which the automatic world-growth job (see
// worker/index.js's autoGrowWorldIfNeeded) never runs — so in a real
// deployment relying solely on that automatic growth, the origin's
// "coverage" would come entirely from this fallback square, permanently.
// Mirrors shapeForLandlet's exact fallback math so this never disagrees
// with what's actually drawn.
function landletWorldPolygon(record) {
  if (record.polygon && record.polygon.length >= 3) {
    return record.polygon.map((p) => ({ x: record.center.x + p.x, y: record.center.y + p.y }));
  }
  const half = Math.sqrt(record.areaM2) / 2;
  return [
    { x: record.center.x - half, y: record.center.y - half },
    { x: record.center.x + half, y: record.center.y - half },
    { x: record.center.x + half, y: record.center.y + half },
    { x: record.center.x - half, y: record.center.y + half },
  ];
}

function computeGaplessWorldRadius(landlets, worldRadiusM) {
  const worldPolygons = landlets.map(landletWorldPolygon);
  if (worldPolygons.length === 0) return worldRadiusM; // nothing to measure coverage against yet
  let minCovered = worldRadiusM;
  for (let i = 0; i < SHOP_COVERAGE_ANGLE_SAMPLES; i++) {
    const angle = (i / SHOP_COVERAGE_ANGLE_SAMPLES) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let covered = 0;
    for (let r = SHOP_COVERAGE_RADIUS_STEP_M; r <= worldRadiusM; r += SHOP_COVERAGE_RADIUS_STEP_M) {
      const insideAny = worldPolygons.some((polygon) => pointInPolygonXY(dx * r, dy * r, polygon));
      if (!insideAny) break;
      covered = r;
    }
    minCovered = Math.min(minCovered, covered);
  }
  return minCovered;
}

// #1358: the renderer's own live (i.e. still-referenced, not-yet-disposed)
// GPU resource counts — exposed on `window` the same way __shopAvatarModelUrl
// (#982) etc. are, purely so an e2e test can confirm a shop-avatar swap
// actually released the outgoing avatar's geometry/material instead of only
// detaching it from the scene graph. THREE's own WebGLRenderer tracks a
// geometry/texture in these counts from the first frame it's actually drawn
// until its own `dispose()` fires (it listens for that event internally), so
// this reflects real live GPU resources, not just "everything ever created."
//
// #1591: every caller invokes this synchronously right after scene.add()-ing
// the incoming avatar, while the outgoing one's geometries/textures have
// already been synchronously decremented by disposeObject3D's own dispose()
// calls just above. The incoming avatar's own geometries/textures, though,
// only get counted once the renderer actually draws them for the first
// time (see this function's own comment above) — which hasn't happened yet
// at this exact point in the call stack. Reading renderer.info.memory
// immediately here caught that gap: the outgoing avatar's resources already
// gone, the incoming one's not yet counted, undercounting by exactly the
// incoming avatar's own geometry/texture count until some future render.
//
// #2690: an earlier fix here (while this function still lived in main.js,
// before #2629 moved it here) deferred the read via a double
// requestAnimationFrame, betting that the app's own animate() loop
// (world/scene.js) would render the new avatar somewhere in that two-frame
// gap. It usually does, but nothing actually guarantees the ordering: this
// function's own first rAF callback and animate()'s next-frame callback
// race each other to be *registered* first, and under enough CI load/jitter
// that race can go either way, occasionally leaving the incoming avatar's
// geometries/textures still one frame short of being drawn (and therefore
// counted) by the time the second callback reads renderer.info.memory —
// the "13 vs baseline 15" mismatch e2e/avatar-picker-settings.test.mjs
// caught. Rendering synchronously right here sidesteps the race instead of
// betting on it: the scene graph is already fully updated by this point in
// every call site (right after scene.add()), so this render call counts
// the incoming avatar's resources immediately and deterministically,
// without waiting on — or racing — the next animate() frame at all. Still
// returns a (resolved) promise so both call sites' existing `await` keeps
// working unchanged.
export function reportRendererMemoryDiagnostic() {
  renderer.render(scene, camera);
  window.__rendererMemory = { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
  return Promise.resolve();
}

export function disposeObject3D(object) {
  object.traverse((child) => {
    // #1370: same Sprite gap disposeObject's own fix just closed — e.g. the
    // shop avatar's afkSprite is a THREE.Sprite, not a Mesh, so it (and its
    // SpriteMaterial's CanvasTexture) was silently skipped by this traverse
    // every time a shop avatar was swapped/unequipped.
    if (child.isSprite) {
      if (child.material) {
        disposeMaterialTextures(child.material);
        child.material.dispose();
      }
      return;
    }
    if (!child.isMesh) return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      // #1359: same texture-leak gap disposeObject's own fix just closed.
      disposeMaterialTextures(material);
      material.dispose();
    }
  });
}

export function unloadShopLandletInstances(entry) {
  entry.loaded = false;
  entry.lod = 'near'; // #2378: reset so a later reload always starts at full detail, same reasoning as entry.loaded's own reset here
  entry.loadToken++; // invalidate any in-flight loadShopLandletInstances call, reload or not
  for (const object of entry.objects) {
    entry.group.remove(object);
    disposeObject3D(object);
  }
  entry.objects = [];
  for (const sign of [...shopSigns]) {
    if (sign.group !== entry.group) continue;
    disposeSignSprites(sign);
    shopSigns.splice(shopSigns.indexOf(sign), 1);
    if (nearestActiveSign === sign) {
      setNearestActiveSign(null);
      shopSignHintEl.classList.remove('visible');
    }
  }
  for (const calendar of [...shopCalendars]) {
    if (calendar.group !== entry.group) continue;
    disposeCalendarSprites(calendar);
    shopCalendars.splice(shopCalendars.indexOf(calendar), 1);
    if (nearestActiveCalendar === calendar) {
      setNearestActiveCalendar(null);
      shopCalendarHintEl.classList.remove('visible');
    }
  }
  // #1995: credit orbs never load for a claimed landlet at all (see
  // updateShopProximity's own comment — only ever greenbelt, torn down by
  // unloadCreditOrbsForLandlet instead), so there's nothing of theirs to
  // clean up here.
  for (const review of [...shopReviews]) {
    if (review.group !== entry.group) continue;
    disposeReviewSprites(review);
    shopReviews.splice(shopReviews.indexOf(review), 1);
    // The tapped product's own mesh is about to be disposed below — clear
    // the reference and hide its info/buy/review hints rather than leaving
    // them pointing at (and this landlet's next load potentially reusing) a
    // stale entry.
    if (shopTappedProduct === review) {
      setShopTappedProduct(null);
      setShopReviewHintsVisible(false);
      setShopReviewHintsProduct(null);
      // #1811: the preview modal's own template/model would otherwise keep
      // pointing at a mesh that's about to be disposed.
      closeShopProductPreviewModal();
    }
    // #1810: same reasoning as the hints just above -- the highlight's own
    // BoxHelper/fill reference this review's mesh directly, which is about
    // to be disposed below, so it can't wait for the next updateReviewFade
    // tick to notice the tapped product is gone.
    if (shopHighlightedProduct === review) {
      removeSelectionOutline(review.mesh);
      setShopHighlightedProduct(null);
    }
  }
  // Any confetti burst still mid-flight on this landlet would otherwise
  // keep animating on (and eventually try to remove itself from) a group
  // whose other contents just got disposed above.
  for (const burst of [...confettiBursts]) {
    if (burst.group !== entry.group) continue;
    disposeConfettiBurst(burst);
    confettiBursts.splice(confettiBursts.indexOf(burst), 1);
  }
}

export async function enterShopMode() {
  // Safe regardless of whether the identity gate just below passes — Build
  // UI has nothing to do with an identity check, and hiding it before that
  // gate (rather than after) means a declined/pending login never leaves
  // Build-mode chrome visible behind the auth modal.
  for (const id of SHOP_HIDDEN_BUILDER_UI_IDS) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  controls.enabled = false;

  // N44 (owner, Control Room, 2026-09-12): Shop mode used to need no
  // identity at all — see ensureShopperIdentity's own comment for why that
  // changed. Gated before any of this function's own scene work below,
  // matching docs/SPEC.md §6's "gate first, then build the experience"
  // design (previously only actually applied to Build/Sell's own entry
  // points, not Shop's).
  await authInitPromise;
  // A verify-email/password-reset/Didit-return link visit already opened
  // its own specific #auth-modal (or #verify-modal) view as part of
  // authInitPromise above — this gate skips itself entirely rather than
  // calling requireLogin, which would call openAuthModal and unconditionally
  // overwrite that view (openAuthModal always calls showAuthView(view) when
  // logged out), clobbering the very thing the visitor came here to do. The
  // world still loads normally underneath, exactly as it did before this
  // gate existed — only the login/verification prompt itself is skipped.
  if (!accountRecoveryFlowActive) {
    const shopper = await ensureShopperIdentity();
    if (!shopper) {
      // Declined login or verification — this is now a genuine dead end
      // until the next fresh mode-nav reload retries the gate (see
      // showShopAccessGate's own comment on why Build/Sell/layoutPreview's
      // own decline branches land here too, rather than each re-triggering
      // this same gate a second time).
      showShopAccessGate();
      return;
    }
  }

  // shopFlyBtn/shopVerticalControlsEl are deliberately NOT marked visible
  // here — #119/#688: they used to be, but this app now blocks Shop's own
  // entry on ensureShopperIdentity (N44/#678) before ever reaching this
  // point, and the spawn-flying decision below (#1175: every spawn now
  // flies, not just a first-ever visit) still waits on fetchCatalog/
  // fetchWorld/fetchAllLandlets to actually resolve first. Marking the fly
  // button visible this early let it appear on screen — already showing
  // its default grounded look — for that whole fetch window, only flipping
  // to the tilted "flying" look once setShopFlyBtnFlying(true) finally
  // runs: a real, visible flash of the wrong state for every visitor (and
  // the exact race #688's own e2e failure caught, once the identity gate
  // made that window long enough to reliably lose). Made visible below
  // instead, together with the moment the correct state is actually
  // decided.
  for (const el of [shopStatusEl, shopMoveJoystickEl, shopLookJoystickEl]) {
    el.classList.add('visible');
  }
  shopStatusEl.textContent = 'Loading the world…';

  // The builder scene's placeholder square (see applyLandletShape) has
  // nothing to do with Shop mode's own per-landlet ground meshes.
  scene.remove(landlet);
  landlet.geometry.dispose();
  landlet.material.dispose();

  // Shop can be entered without a reload — Identity -> Shop, not just
  // fresh from the builder-choice screen — so whatever was actually built
  // this session is very likely still sitting in productMeshes. Those
  // meshes are positioned in the single active landlet's *local*
  // coordinates (the builder scene only ever shows one landlet, so its
  // local origin doubles as the scene origin) rather than that landlet's
  // real world position, which is what Shop mode's own per-landlet groups
  // use. Left in place, they'd clutter the scene somewhere near the world
  // origin — disconnected from, and easily mistaken for missing/wrong
  // versions of, that same landlet's content once Shop loads it fresh (in
  // the right place) as the camera gets close. This only tears down the
  // in-memory scene, not anything on the server — nothing here is deleted,
  // just no longer shown twice in two different places.
  clearSelection();
  translateControls.detach();
  rotateControls.detach();
  for (const mesh of productMeshes) {
    removeLowStockHighlight(mesh);
    scene.remove(mesh);
    disposeObject(mesh);
  }
  productMeshes.length = 0;
  // #1950: Build-mode-only state -- nothing to highlight once its scene is
  // torn down, and a stale filter would otherwise silently reapply itself
  // (matching nothing, harmlessly, but still wrong) if Build is re-entered
  // later without Settings ever being reopened to reset it.
  setActiveLowStockTemplateIds(null);
  setLowStockFilterMaxQty(null);
  setLowStockFilterMaxDays(null);
  // #2068: same reasoning as the low-stock reset just above -- the ghost
  // boxes belong to the Build scene being torn down right here, and the
  // toggle/list themselves reset too so re-entering Build later starts
  // clean rather than silently reapplying a stale toggle.
  clearSoldOutMarkerMeshes();
  setShowSoldOutMarkers(false);
  setSoldOutMarkers([]);

  try {
    setActiveCatalog(await fetchCatalog());
  } catch {
    setActiveCatalog(FALLBACK_CATALOG);
  }

  // #681: which custom avatar (if any) this account has equipped — never
  // blocks Shop mode entry on failure, same as activeCatalog's own
  // fallback just above; falls back to today's hardcoded default avatar.
  // Only attempted when actually logged in: the accountRecoveryFlowActive
  // branch above deliberately skips ensureShopperIdentity, so Shop mode
  // can still be reached fully anonymous (mid verify-email/password-reset
  // flow) — calling this endpoint anyway would 401, and unlike a caught
  // JS exception, Chromium logs a failed resource load as a console error
  // regardless of the try/catch (found via e2e/auth.test.mjs's own
  // logout -> reset-password reload tripping its errors.length === 0
  // check).
  let equippedAvatarModelUrl = null;
  setShopEquippedAvatarSkeletonSignature(null);
  // #1165: the applied animation (if any and still owned), fetched
  // alongside the equipped avatar — createCustomShopAvatar needs both
  // together to decide whether this animation's own clips actually apply
  // here (#1162's compatibility check) or this avatar falls back to its
  // own.
  let equippedAnimation = null;
  if (currentAuthUser) {
    try {
      const avatar = await fetchMyEquippedAvatar();
      equippedAvatarModelUrl = avatar.modelUrl;
      setShopEquippedAvatarSkeletonSignature(avatar.skeletonSignature);
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

  // #1176: the shopper's own last-reported position, if any — powers the
  // "Go to Last Location" button shown during the spawn orbit below. Never
  // blocks Shop mode entry on failure, same as equippedAvatarModelUrl just
  // above — but unlike that one, this also skips the call entirely during
  // accountRecoveryFlowActive, not just when logged out: GET /api/presence/me
  // is gated by requireSessionBuilder (full age/trust-tier verification,
  // same bar every other presence endpoint already uses), while the
  // equipped-avatar endpoint above only requires a login. A logged-in-but-
  // not-yet-verified account reaching Shop mode specifically through the
  // accountRecoveryFlowActive path (its own comment above: "mid verify-
  // email/password-reset flow") would otherwise call this anyway and get a
  // real 403 — caught here same as any other failure, but Chromium still
  // logs the failed resource load as a console error regardless of the
  // catch (the exact e2e/auth.test.mjs failure mode equippedAvatarModelUrl's
  // own comment already describes for a 401; this is that same shape for a
  // 403 instead, found via that file's own errors.length === 0 check during
  // its reset-password flow). null (no button shown) either way.
  setShopLastLocation(null);
  if (currentAuthUser && !accountRecoveryFlowActive) {
    try {
      setShopLastLocation(await fetchOwnLastPresence());
    } catch (err) {
      console.warn('Could not fetch last known location:', err);
    }
  }

  let world;
  let allLandlets;
  try {
    [world, allLandlets] = await Promise.all([fetchWorld(), fetchAllLandlets()]);
  } catch (err) {
    shopStatusEl.textContent = err.message || 'Could not load the world.';
    return;
  }
  // Builder display labels for updateShopLandletInfo — supplementary, so a
  // failure here just leaves shopBuilderLabels empty (falls back to "an
  // unknown builder" per-landlet) rather than blocking Shop mode itself.
  // #717 (sub-issue of #711): scoped to exactly the owners with a visible
  // landlet right now, via the already-fetched allLandlets above, instead
  // of fetchBuilders' entire roster — naturally bounded by how many
  // distinct owners are on-screen, not the total account count, so this
  // doesn't need its own pagination once GET /api/builders gets a LIMIT
  // (#715).
  resetShopCurrentLandletEntry();
  accountMenuLandletInfoEl.hidden = true;
  const visibleOwnerBuilderIds = [...new Set(
    allLandlets.map((landlet) => landlet.ownerBuilderId).filter((id) => id),
  )];
  fetchBuildersByIds(visibleOwnerBuilderIds)
    .then((builders) => {
      setShopBuilderLabels(new Map(builders.map((b) => [b.builderId, b.label])));
      // #1172: updateShopLandletInfo only re-renders on a landlet-transition
      // (found === shopCurrentLandletEntry short-circuits otherwise), so a
      // shopper who spawned already standing on a landlet before this fetch
      // resolved would see the "unknown builder" fallback stuck until they
      // walked off and back. Forcing shopCurrentLandletEntry back to null
      // makes the next call recompute from scratch and re-render — same
      // effect as the bootstrap reset above, just re-triggered once real
      // labels are in.
      resetShopCurrentLandletEntry();
      updateShopLandletInfo();
    })
    .catch(() => {});

  // The wall sits at the largest gap-free radius, not the administrative
  // world radius itself — see computeGaplessWorldRadius's doc comment.
  const shopWorldRadiusM = computeGaplessWorldRadius(allLandlets, world.radiusM);
  setShopWorldRadiusM(shopWorldRadiusM);

  // The visible world stops at the wall — no glimpse of "wild ground" that
  // isn't actually any land's own polygon. A thin overlap keeps the ground
  // from leaving a seam right at the wall's own base. Textured (#220) with
  // the same base brand green the flat fill used before (index.html's
  // --brand-green) — this used to be a much darker forest green that read
  // as a heavy, ominous swath across an otherwise bright scene once every
  // visible landlet resolves against it; the mottling stays subtle for the
  // same reason.
  const wildGroundGeometry = new THREE.CircleGeometry(shopWorldRadiusM + SHOP_WALL_MARGIN_M, 64);
  applyGroundCurvature(wildGroundGeometry, 0, 0); // this mesh's own local origin *is* the world origin
  const wildGround = new THREE.Mesh(
    wildGroundGeometry,
    new THREE.MeshStandardMaterial({ map: createGroundTexture() }),
  );
  scene.add(wildGround);
  shopWorldObjects.push(wildGround);

  // The wall's own ring sits at (essentially) one fixed distance from the
  // origin all the way around, so — unlike wildGround's per-vertex
  // applyGroundCurvature above, needed because that mesh spans every
  // distance from 0 out to shopWorldRadiusM — a single z offset lines its
  // base up with the already-curved ground it should be resting on instead
  // of the flat z=0 plane (#166, #203). Shared by the dome below, whose own
  // base sits on top of the wall's rim.
  const wallGroundDropM = curvatureDropM(shopWorldRadiusM);
  const wallGeometry = new THREE.CylinderGeometry(shopWorldRadiusM, shopWorldRadiusM, SHOP_WALL_HEIGHT_M, 64, 1, true);
  paintVerticalGradient(wallGeometry, (localY, out) => {
    const t = THREE.MathUtils.clamp((localY + SHOP_WALL_HEIGHT_M / 2) / SHOP_WALL_HEIGHT_M, 0, 1);
    out.copy(SHOP_GROUND_HORIZON_COLOR).lerp(SHOP_HAZY_HORIZON_COLOR, t);
  });
  // A custom shader (unlit, like the MeshBasicMaterial this replaced) so a
  // soft swirling cloud layer can be painted over the vertex-color gradient
  // below — see createShopSkyMaterial's own comment. Shared with the dome
  // (created just below) so both animate in perfect sync off one clock.
  const shopSkyMaterial = initShopSkyMaterial(shopWorldRadiusM);
  const wall = new THREE.Mesh(wallGeometry, shopSkyMaterial);
  wall.rotation.x = Math.PI / 2; // THREE's cylinder stands along local Y by default — this world is Z-up
  wall.position.z = SHOP_WALL_HEIGHT_M / 2 - wallGroundDropM;
  scene.add(wall);
  shopWorldObjects.push(wall);
  shopWallMesh = wall;

  // Caps the wall's open top so the world reads as fully enclosed — an
  // upper hemisphere (unit sphere, theta 0..PI/2) whose equator matches
  // the wall's own rim exactly (same radius, continuous gradient color at
  // the seam — see SHOP_HAZY_HORIZON_COLOR), non-uniformly scaled (X/Z to
  // the wall's radius, Y — the pole axis before Z-up rotation — to how far
  // it currently rises) so growShopDomeIfNeeded can grow it later with a
  // single scale change, no geometry rebuild.
  //
  // owner-report-2026-10-20: widthSegments here used to be 48 against the
  // wall's own 64 radialSegments just above. Matching *radius* alone
  // isn't enough for a seamless rim -- a cylinder/sphere's circular edges
  // are really inscribed N-gons (vertices sit exactly on the circle,
  // straight edges between them sag slightly inward), so a 48-gon and a
  // 64-gon inscribed in the very same circle still sag by different
  // amounts between vertices and only touch exactly at the handful of
  // angles where a vertex of one happens to land near a vertex of the
  // other. That periodic sag-mismatch is what read as jaggedness right at
  // the wall/dome border. Matching widthSegments to the wall's own
  // radialSegments makes the two rims the same 64-gon at the same angles,
  // closing the gap.
  const domeGeometry = new THREE.SphereGeometry(1, 64, 24, 0, Math.PI * 2, 0, Math.PI / 2);
  paintVerticalGradient(domeGeometry, (localY, out) => {
    const t = THREE.MathUtils.clamp(localY, 0, 1);
    out.copy(SHOP_HAZY_HORIZON_COLOR).lerp(SHOP_SKY_DOME_COLOR, t);
  });
  resetShopDomeRiseM();
  // owner-report-2026-10-21: matching segment counts (above) makes the
  // wall's and dome's rims the same ideal 64-gon, but CylinderGeometry
  // and SphereGeometry still compute that shared rim's vertex positions
  // via two different trig code paths (the cylinder's theta parameter
  // isn't the same floating-point expression as the sphere's equivalent
  // phi, even though they describe the same circle -- see #2523's own
  // 90-degree-phase-offset analysis). That leaves a sub-ULP gap/overlap
  // right at the seam, which the depth test resolves inconsistently --
  // worse at a distance, where depth-buffer precision is coarser, and
  // gone up close, exactly matching the owner's own report ("disappears
  // when I try to get closer"): classic z-fighting, not noise. A
  // dedicated material for the dome -- sharing the wall's own `uniforms`
  // object *by reference* (not a deep clone) so both stay on the exact
  // same clock -- with a small polygonOffset settles the ambiguity
  // deterministically in the wall's favor instead of leaving it to
  // whichever float value happens to round which way.
  const shopDomeMaterial = new THREE.ShaderMaterial({
    uniforms: shopSkyMaterial.uniforms,
    vertexShader: SHOP_SKY_VERTEX_SHADER,
    fragmentShader: SHOP_SKY_FRAGMENT_SHADER,
    side: THREE.BackSide,
    extensions: { derivatives: true },
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const shopDomeMesh = new THREE.Mesh(domeGeometry, shopDomeMaterial);
  shopDomeMesh.rotation.x = Math.PI / 2;
  shopDomeMesh.position.z = SHOP_WALL_HEIGHT_M - wallGroundDropM;
  shopDomeMesh.scale.set(shopWorldRadiusM, shopDomeRiseM, shopWorldRadiusM);
  scene.add(shopDomeMesh);
  shopWorldObjects.push(shopDomeMesh);
  setShopDomeMesh(shopDomeMesh);

  for (const record of allLandlets) {
    // Nothing this far past the wall could ever show even a sliver — skip
    // building geometry for it at all rather than paying for meshes no
    // camera position can ever see.
    const distanceFromOrigin = Math.hypot(record.center.x, record.center.y);
    if (distanceFromOrigin - SHOP_LANDLET_CULL_MARGIN_M > world.radiusM) continue;

    const group = new THREE.Group();
    group.position.set(record.center.x, record.center.y, 0);
    // #220/#2371: only an unclaimed 'greenbelt' plot gets the textured
    // ground — claimed/generating/water keep their own flat
    // SHOP_PLOT_COLORS fill, since those are ownership-status indicators,
    // not a ground biome, and need to stay instantly readable as a single
    // solid color at a glance across the whole world. A greenbelt plot's
    // own texture now varies by its real biome (#2370's ingested data),
    // falling back to the same default/unclassified look #220 originally
    // shipped when no real classification exists at its location yet.
    const plotColorKey = plotColorKeyForLandlet(record);
    const groundMaterial = plotColorKey === 'greenbelt'
      ? new THREE.MeshStandardMaterial({ map: createGroundTexture(record.biome) })
      : new THREE.MeshStandardMaterial({ color: SHOP_PLOT_COLORS[plotColorKey] ?? 0x4caf50 });
    const groundGeometry = new THREE.ShapeGeometry(shapeForLandlet(record));
    if (plotColorKey === 'greenbelt') normalizeGroundShapeUVs(groundGeometry);
    const groundMesh = new THREE.Mesh(groundGeometry, groundMaterial);
    // #2851: Shop mode's own ground mesh never called curveGroundGeometry
    // (world-curvature *between* landlets is a separate, unaddressed
    // problem here -- see applyLandletShape's own comment on this) --
    // this plot-level real elevation offset is independent of that, just
    // a uniform z lift for this one landlet's own real terrain height.
    groundMesh.position.z = 0.02 + (record.elevationM ?? 0);
    group.add(groundMesh);
    scene.add(group);
    shopLandlets.set(record.landletId, {
      record, group, loaded: false, loadToken: 0, objects: [],
      // #2378: 'near' (full detail) or 'middle' (simplified proxy) — only
      // meaningful while loaded is true; see updateShopProximity.
      lod: 'near',
      // #1995: orbs' own load state, independent of loaded/loadToken/
      // objects above -- see updateShopProximity's own comment on why.
      orbsLoaded: false, orbLoadToken: 0,
    });
  }

  // Shop mode can be (re-)entered without a reload (see this function's own
  // opening comment) — remove any avatar left over from a previous round
  // trip before building a fresh one, rather than ending up with two
  // overlapping bodies.
  // #1358: also dispose it, not just detach it from the scene graph — left
  // over from a previous round trip means its geometry/material (and any
  // custom GLTF avatar's textures) would otherwise leak every time Shop
  // mode is re-entered without a page reload.
  if (shopAvatar) {
    scene.remove(shopAvatar.group);
    disposeObject3D(shopAvatar.group);
  }
  setShopAvatar(null);
  if (equippedAvatarModelUrl) {
    try {
      setShopAvatar(await createCustomShopAvatar(equippedAvatarModelUrl, equippedAnimation));
    } catch (err) {
      console.warn(`Failed to load equipped avatar model (${equippedAvatarModelUrl}), falling back to the default avatar:`, err);
    }
  }
  if (!shopAvatar) setShopAvatar(createShopAvatar());
  scene.add(shopAvatar.group);
  window.__shopAvatarModelUrl = shopAvatar.modelUrl; // see refreshEquippedShopAvatar's own comment on this (#982)
  window.__shopAvatarMetrics = { heightM: shopAvatarHeightM(), collisionHalfM: shopAvatarCollisionHalfM(), cameraAnchorHeightM: shopCameraAnchorHeightM() }; // see refreshEquippedShopAvatar's own comment on this (#1091)
  window.__shopAvatarAnimationSource = shopAvatar.animationSource ?? null; // see createCustomShopAvatar's own comment on this (#1165)
  await reportRendererMemoryDiagnostic(); // see disposeObject3D's neighboring comment on this (#1358)
  resetShopAvatarIdleState(); // src/shop/avatar.js (#2623) — zeroes every idle/sway/sit/lean field it owns
  // #1175 (docs/SPEC.md §1/§2): every spawn — not just a first-ever visit —
  // starts already flying, above a random world location, facing the
  // world center, and slowly orbiting it clockwise until the shopper gives
  // any navigation input — see beginShopSpawn (src/shop/flightMovement.js,
  // #2624) for the rest of this reset.
  // #1630: pickShopSpawnLocation (not a bare Math.random() pair) so the
  // spawn location avoids landing on a water landlet.
  const { radiusM: spawnOrbitRadiusM, yaw: spawnYaw } = pickShopSpawnLocation();
  beginShopSpawn(spawnOrbitRadiusM, spawnYaw);
  // Now that the correct grounded/flying look is actually applied, safe to
  // reveal (see this function's own comment on why these two specifically
  // wait until here, unlike the other Shop HUD elements above).
  shopFlyBtn.classList.add('visible');
  shopVerticalControlsEl.classList.add('visible');
  // #2718: reveal the "Submit Feedback" trigger the same moment as the fly
  // button/vertical controls above -- see submitFeedbackUI.js's own
  // comment on why this is Shop-only and owns its own listeners.
  shopFeedbackBtn.classList.add('visible');
  // Not just clearing the text — an empty .visible pill still shows its
  // own padding/background as a small blank rectangle, which sat directly
  // on top of the wordmark (both anchored at the same top:10/left:12 spot)
  // once the world finished loading. Hiding it outright once there's
  // nothing left to say is the actual fix; the "Loading the world…"/error
  // paths above re-add .visible themselves whenever there's real text.
  shopStatusEl.textContent = '';
  shopStatusEl.classList.remove('visible');
  setShopActive(true);
  // #2552: Shop's own per-frame work (movement + sky) and its own avatar-
  // facing value for the compass (eases toward movement direction rather
  // than tracking the camera instantly, unlike every other mode's default
  // camera-derived bearing — see world/scene.js's own comment).
  registerModeFrameUpdate((now) => {
    updateShopMovement(now);
    updateShopSky(now);
    // #2717: feed the render-state ring buffer (src/feedback/
    // renderStateBuffer.js) a fresh snapshot every frame -- it throttles
    // itself to ~1Hz internally (see that module's own comment), so it's
    // cheap to call unconditionally here rather than this callback needing
    // its own timer. "shop id" isn't included -- see that module's own
    // comment on why (GET /api/world is a singleton; there's no id to
    // capture yet).
    recordRenderStateSample(now, {
      cameraPosition: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      avatarPosition: { x: shopAvatarPosition.x, y: shopAvatarPosition.y, z: shopAvatarPosition.z },
      avatarFacingRad: shopAvatarFacing,
      uTime: currentShopSkyTimeS(),
      worldRadiusM: shopWorldRadiusM,
    });
  });
  registerFacingOverride(() => shopAvatarFacing);
}
