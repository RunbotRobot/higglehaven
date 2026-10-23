import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { getModalFocusable, openModalA11y, closeModalA11y } from './ui/modal.js';
import { CATALOG as FALLBACK_CATALOG, DEFAULT_INSTANCES } from './catalog.js';
import { loadInstances, saveInstances } from './layoutStorage.js';
import {
  signUp,
  logIn,
  logOut,
  deleteAccount,
  exportMyData,
  changePassword,
  fetchCurrentUser,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
  resendVerificationEmail,
  changeEmail,
  ageAttest,
  cardSetupIntent,
  confirmCard,
  startDiditVerification,
  fetchDiditVerificationStatus,
  fetchCatalog,
  fetchInstances,
  createInstanceRemote,
  updateInstanceRemote,
  deleteInstanceRemote,
  createInstancesRemote,
  upsertInstancesRemote,
  deleteInstancesRemote,
  uploadModelFile,
  createVideoGenerationJob,
  fetchVideoGenerationJobStatus,
  createCatalogTemplate,
  updateCatalogTemplate,
  deleteCatalogTemplate,
  uploadCatalogTemplateThumbnail,
  generateConceptImage,
  searchCatalogBySimilarity,
  fetchLandlets,
  fetchLandlet,
  claimLandlet,
  fetchLandletLevels,
  addLandletLevel,
  deleteLandletLevel,
  fetchWorld,
  fetchBuilders,
  fetchBuildersByIds,
  fetchMyBuilder,
  renameBuilder,
  deleteBuilder,
  fetchNotificationPreferences,
  updateNotificationPreferences,
  fetchMySeller,
  renameSeller,
  deleteSeller,
  fetchMyEquippedAvatar,
  fetchMyOwnedAvatars,
  equipAvatar,
  fetchMyEquippedAnimation,
  fetchMyOwnedAnimations,
  equipAnimation,
  submitTaxIdForm,
  fetchSellerStripeAccount,
  submitSellerStripeAccount,
  submitBuilderStripeAccount,
  fetchBuilderRedeemStatus,
  redeemHiggles,
  fetchAllLandlets,
  fetchLandletVersions,
  saveLandletVersion,
  clearVersionIdempotencyKey,
  fetchLandletVersion,
  activateLandletVersion,
  replaceLandletDraft,
  clearDraftIdempotencyKey,
  fetchBundles,
  fetchSharedBundles,
  createBundle,
  updateBundle,
  deleteBundle,
  fetchSignPosts,
  createSignPost,
  deleteSignPost,
  editSignPost,
  fetchCalendarEvents,
  createCalendarEvent,
  deleteCalendarEvent,
  editCalendarEvent,
  triggerCalendarEvent,
  fetchProductReviews,
  createProductReview,
  editProductReview,
  deleteProductReview,
  fetchSellerFeedback,
  createSellerFeedback,
  startAuction,
  fetchAuctions,
  fetchAllAuctions,
  fetchAuction,
  fetchAuctionBids,
  placeBid,
  resolveAuctionNow,
  purchaseInstance,
  clearPurchaseIdempotencyKey,
  finalizePurchase,
  fetchPurchases,
  fetchLowStock,
  fetchSoldOutMarkers,
  dismissSoldOutMarker,
  refundPurchase,
  fetchSellerPayouts,
  requestSellerPayout,
  markPurchaseShipped,
  confirmPurchaseDelivery,
  fetchSavedLayouts,
  fetchSavedLayout,
  deleteSavedLayout,
  fetchOwnLastPresence,
} from './api.js';
import { optimizeModelFile, rescaleModelFile, convertFbxToGlb } from './modelOptimizer.js';
import { getUnits, setUnits, unitSuffix, toDisplayLength, fromDisplayLength, formatLength, formatArea } from './settings.js';
import { takeoffAltitudeM, clampedLandingAltitudeM, flightSpeedMultiplier } from './flight.js';
import { attentionDistanceAndDot, hasSustainedAttention, nextAttentionElapsedS, pickNearestInRange, yawRotatedForward } from './attention.js';
import { classifyHandlingKind, nextHandlingBlend, nextPhase, shouldEndItemHandling } from './itemHandling.js';
import { computeSellerShowcasePages, layoutSellerShowcasePage } from './sellerShowcase.js';
import { computeSavedLayoutGround, pointInDragRect } from './savedLayoutPreview.js';
import {
  curvatureDropM,
  curvedPosition,
  footprintScaleAtHeight,
  relativeCurvatureDropM,
} from '../worker/earthCurvature.js';

// #2551: activeCatalog/myBundles/communityBundles/builderId/currentLandletId/
// sellerId/currentMode and the LANDLET_* consts now live in
// src/world/state.js (see that module's own comments for why each one is
// shaped the way it is) — every other extracted module under #2504 needs to
// read at least one of them. Writes go through the paired setter functions
// (an ES import binding is read-only from this side).
import {
  activeCatalog, setActiveCatalog,
  myBundles, setMyBundles,
  communityBundles, setCommunityBundles,
  builderId, setBuilderId,
  currentLandletId, setCurrentLandletId,
  sellerId, setSellerId,
  currentMode, setCurrentMode,
  LANDLET_AREA_M2, LANDLET_SIDE_M, LANDLET_HEIGHT_M,
} from './world/state.js';
// #2552: scene/camera/renderer/canvas and the shared animate()/
// updateCompassNeedle/onResize loop now live in src/world/scene.js (see
// that module's own comments) — registerModeFrameUpdate/registerFacing
// Override are each mode's own hook into that now-shared loop (see
// enterShopMode/enterSellMode/enterLayoutPreviewMode/bootstrap's own
// calls to them, and buildModeFrameUpdate's own comment below).
import {
  scene, camera, renderer, canvas,
  registerModeFrameUpdate, registerFacingOverride,
} from './world/scene.js';

// #2553 (part of #2504/#2500's src/main.js module split, see #2503's
// design comment for the full dependency map): the catalog-template ->
// Object3D pipeline, the ground plane, and LOD/dispose helpers now live in
// src/world/models.js. That module exports `landlet` without adding it to
// any scene -- `scene` lived in this file when world/models.js was
// written, and now that #2552 moved it to world/scene.js too, the
// scene.add(landlet) call right after this import still preserves the
// exact original initialization order (world/scene.js's own module-eval
// runs first, since it's imported above this).
import {
  curveGroundGeometry, flatGroundHitPoint,
  createGroundTexture, normalizeGroundShapeUVs,
  landlet, findTemplate,
  loadModelAnimations, computeSkeletonSignature, loadModelInstance,
  extensibleAxes, effectiveLength, meshDimensions,
  AXIS_DIMENSION_KEY, AXIS_LIST, FLOORING_THICKNESS_M, isFlooringTemplate,
  createMeshForInstance,
  disposeMaterialTextures, disposeObject,
} from './world/models.js';
scene.add(landlet);
// #2564: the mandatory first-claim flow (runClaimFlow, its own flyover-map
// scene, and the plot pick/confirm handlers) now lives in src/claim/flow.js
// — see that module's own comment for its dependency notes, including why
// it in turn imports a few things back from this module (a temporary
// circular import pending #2550's ui/modal.js extraction).
import { runClaimFlow } from './claim/flow.js';
// #2554: login/signup/verify/session flow now lives in src/account/auth.js
// (see that module's own comment for its dependency notes, including why
// it in turn imports loadStripeJs/START_MODE_KEY back from this module — a
// temporary circular import, same shape as claim/flow.js's own, until
// those pieces get a real home outside main.js via their own future
// extraction. setAccountSessionEnding moved to shop/presenceAndContent.js
// as part of #2626 -- account/auth.js now imports it from there instead).
import {
  currentAuthUser, setCurrentAuthUser, accountRecoveryFlowActive, authInitPromise,
} from './account/auth.js';
// #2555: ensureBuilderIdentity/ensureSellerIdentity/ensureShopperIdentity
// now live in src/account/identity.js.
import { ensureBuilderIdentity, ensureSellerIdentity, ensureShopperIdentity } from './account/identity.js';
// #2556: the notifications/friends/DM/my-lands account-menu chrome now
// lives in src/account/menu.js — see that module's own comment for its
// dependency notes, including why it in turn imports formatHiggles/
// START_MODE_KEY/BUILD_TARGET_LANDLET_ID_KEY back from this module (a
// temporary circular import, same shape as auth.js's/identity.js's own,
// until those pieces get a real home outside main.js via their own
// future extractions).
import { refreshNotificationsBadge, refreshFriendsBadge, refreshDmBadge } from './account/menu.js';
// #2561: the faux-layout preview mode now lives in src/build/layoutPreview.js
// — see that module's own comment for its dependency notes.
import { enterLayoutPreviewMode } from './build/layoutPreview.js';
// #2623 (leaf of #2563/#2504/#2500): the Shop avatar's own mesh/skeleton
// creation, per-frame pose, and idle state machine now live in
// src/shop/avatar.js — see that module's own comment for its dependency
// notes, including why it in turn imports shopAvatarPosition/
// shopAvatarFacing/disposeObject3D/reportRendererMemoryDiagnostic back
// from this module (a temporary circular import, same shape as
// claim/flow.js's own).
import {
  createShopAvatar, createCustomShopAvatar, shopAvatar, setShopAvatar,
  shopAvatarCollisionHalfM, shopAvatarHeightM, shopCameraAnchorHeightM, refreshEquippedShopAvatar,
  updateShopAvatarPose, setShopAvatarAnimationState, updateShopAvatarIdle,
  shopIdleSwayYawOffset, addShopIdleSwayYawOffset, resetShopAvatarIdleState,
  shopIdleInteractionTarget, shopSitBlend, shopSitYawOffset, shopSitHeightOffset,
  shopSitSettleDelayS, shopSitSettleElapsedS,
  shopLeanBlend, shopLeanYawOffset, shopLeanPositionOffset,
  shopLeanSettleDelayS, shopLeanSettleElapsedS,
} from './shop/avatar.js';
// #2624 (leaf of #2563/#2504/#2500, depends on #2623 above): Shop mode's
// flight physics, free-look/third-person camera, collision movement,
// sustained-attention tracking, and item-handling pose now live in
// src/shop/flightMovement.js — see that module's own comment for its
// dependency notes, including why it in turn imports several not-yet-
// extracted functions/state (presence, world-content, signs/calendars/
// credit-orbs/confetti) back from this module, same shape as claim/flow.js's
// own, and why beginShopSpawn replaces this file's own direct assignment of
// several of this leaf's now-private state fields.
import {
  getShopCameraLockToFacing, setShopCameraLockToFacing, setShopFlyBtnFlying,
  applyShopCameraOrientation, positionShopCamera, setShopFov, updateShopMovement,
  beginShopSpawn, initShopFlightInputBindings,
} from './shop/flightMovement.js';
// #2626 (leaf of #2563/#2504/#2500, depends on #2623/#2624 above): Shop
// mode's proximity-driven landlet instance loading/LOD, multiplayer
// presence, and credit orbs now live in src/shop/presenceAndContent.js --
// see that module's own comment for its dependency notes, including why it
// in turn imports pointInPolygonXY/growShopDomeIfNeeded/registerShopSign/
// registerShopCalendar/registerShopReview/unloadShopLandletInstances back
// from this module (each still pending its own future extraction), and why
// this file gets setShopBuilderLabel(s)/resetShopCurrentLandletEntry
// setters rather than reassigning that module's state directly.
import {
  shopLandlets, updateShopProximity, updateShopLandletInfo, pickShopSpawnLocation,
  setShopBuilderLabel, setShopBuilderLabels, resetShopCurrentLandletEntry,
  accountMenuLandletInfoEl, SHOP_LOAD_RADIUS_M,
} from './shop/presenceAndContent.js';
// #2559: Build mode's core editor internals now live in src/build/scene.js
// -- see that module's own comment for its dependency notes, including why
// it in turn imports shapeForLandlet/BUILD_TARGET_LANDLET_ID_KEY/addItemBtn/
// closeCatalogPicker back from this module (a temporary circular import,
// same shape as account/menu.js's/build/layoutPreview.js's own).
import {
  productMeshes, selectedMeshes, multiSelectMode, pendingPlacement,
  enterPlacementMode, handlePlacementClick, handleMeasureClick,
  measureMode, measureMarkerWasDragged, setMeasureMarkerWasDragged,
  findRootProduct, toggleInSelection, selectOnly,
  raycaster, ndcFromEvent, pointerDownPos, CLICK_DRAG_THRESHOLD_PX,
  persistLayout, setProductInfo, relativeItemsForMeshes, updateSelectionUI,
  lowStockFilterMaxQty, lowStockFilterMaxDays,
  setLowStockFilterMaxQty, setLowStockFilterMaxDays, updateLowStockHighlights,
  showSoldOutMarkers, setShowSoldOutMarkers, soldOutMarkers, setSoldOutMarkers,
  applySoldOutMarkerVisibility, removeSoldOutMarkerMesh, clearSoldOutMarkerMeshes,
  activeLowStockTemplateIds, setActiveLowStockTemplateIds,
  applyLandletShape, resolveLandletId, renderLevelControls, addInstanceToScene,
  setCurrentLandletAreaM2, setCurrentLandletLevels, setCurrentLevelIndex,
  buildModeFrameUpdate,
  controls, rotateControls, translateControls,
  clearSelection, addSelectionOutline, removeSelectionOutline,
  cancelPlacementMode, updateTrimLengthInput,
  measurePointA, measurePointB, updateMeasureResultText,
  syncUpdate, footprintsOverlap, footprintCorners,
  removeLowStockHighlight,
} from './build/scene.js';

// Exported for src/catalog/picker.js (#2558) -- its own renderBundlePicker/
// currentBundleTabList/bundle-tab-click handler need this same state; a
// setter since an ES import binding is read-only from the importing side.
export let activeBundleTab = 'mine';
export function setActiveBundleTab(tab) {
  activeBundleTab = tab;
}

// Shop, Build, and Sell are the three peer top-level views (#mode-nav in
// index.html) — genuine currentMode values now (#540 gave Sell the real
// mode-architecture plumbing #539 was closed without ever landing), each a
// fundamentally different full-screen scene setup (per-world absolute
// coordinates + flight controls; one landlet's local coordinates + build
// gizmos; a paginated showcase of the seller's own products) that
// bootstrap() builds fresh each time, so switching between any of the
// three goes through a reload rather than a live in-place teardown/
// rebuild, deliberately: this codebase already rejected that path once
// (see enterShopMode's own comment on why it re-fetches/rebuilds rather
// than trying to reuse Build's leftover state). sessionStorage (not
// localStorage) carries the *next* mode across that reload — it's gone
// once bootstrap() reads it, and a plain fresh tab with nothing set always
// lands on Shop, the product's chosen default landing view.
// Exported: src/claim/flow.js (#2564) needs it for claimBackBtn's own
// reload-to-shop fallback — a temporary circular import (this module also
// imports runClaimFlow from there) until #2550 gives this constant a real
// home outside main.js the way #2551 already did for the state it also
// needed; harmless here since every use on both sides is inside a function
// body, never read at module-evaluation time.
export const START_MODE_KEY = 'higglehaven.startMode';
// #635's own preview is reached via a reload the same way Shop/Build/Sell
// switch (see START_MODE_KEY's own comment above) — this carries which
// saved layout to load across that reload, since START_MODE_KEY itself
// only ever holds a bare mode name.
export const PREVIEW_SAVED_LAYOUT_ID_KEY = 'higglehaven.previewSavedLayoutId';
// #1150: same reload-carries-one-value shape as PREVIEW_SAVED_LAYOUT_ID_KEY
// above — the "My Lands" list's own "open for editing" link reaches a
// specific one of a builder's (possibly several — see
// resolveLandletId's own comment) owned landlets this way, since bootstrap()
// is the only place Build mode ever loads a landlet from.
export const BUILD_TARGET_LANDLET_ID_KEY = 'higglehaven.buildTargetLandletId';

// Declared here (rather than alongside the rest of Shop mode, much further
// down) because several Shop-specific pointer/keyboard event handlers
// declared well before the rest of Shop mode's own state gate on it — a
// `let` declared after those would be in its temporal dead zone the first
// time one of them ran. (#2552: animate() itself moved to world/scene.js
// and no longer reads this directly — see registerModeFrameUpdate's own
// comment — but plenty else in this file still does.)
export let shopActive = false;

// #2559 (part of #2504/#2500's src/main.js module split, see #2503's
// design comment): Build mode's core editor internals -- gizmos/collision/
// snap/alignment/trim, undo/redo, measure mode, selection + outlines,
// low-stock/sold-out highlighting, clipboard, levels, sync state -- now
// live in src/build/scene.js. See that module's own comment for the
// owner-input item it leaves open (teardownBuildScene()) and for which
// pieces of this file it imports back (a temporary circular import, same
// shape as account/auth.js's/account/menu.js's own).
// Shown in Settings' General tab (renderGeneralSettingsSection) rather than
// an always-on-screen HUD overlay — decluttering the main view, now that
// it's the only way to read/copy exactly which commit is deployed.
const BUILD_INFO_TEXT = `build ${__BUILD_COMMIT__} · ${__BUILD_TIME__}`;

// #2559: see src/build/scene.js's own comment.
// Fixed bright daylight, always — no day-night cycle (docs/SPEC.md §1's
// "shared, compressed 4-hour cycle" is deliberately not implemented here
// for now: a builder shouldn't have to make their space look good in three
// different kinds of lighting, and a dark "night" phase read as ominous
// rather than the lighthearted, bright feel this world is going for). These
// values are the cycle's own former "daylight" keyframe — kept exactly so
// nothing about the lit look actually changes, only the fact that it never
// stops being this.
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
sunLight.position.set(20, 10, 30);
scene.add(sunLight);

// #2559: see src/build/scene.js's own comment.

// A template's appearance never changes after creation (there's no edit
// flow for its color), so a thumbnail rendered once this session is good
// for the rest of it — keyed by templateId rather than re-rendered every
// time the picker reopens or a new upload rebuilds the whole grid. The one
// exception is Save Size (#544): it can rescale/re-upload the model and
// always changes template.dimensions, both of which change what
// renderCatalogThumbnailNow's bounding-sphere framing actually renders —
// its own success handler deletes this template's cache entry before
// rebuilding the picker, so this cache would otherwise keep serving a
// stale pre-resize thumbnail for the rest of the session.
// Exported for src/catalog/picker.js (#2558) -- its own
// buildCatalogTemplateTile/buildCatalogPickerButtons read this same cache
// (also still used directly here, by Sell mode's own product-tile
// rendering and Save Size's cache-invalidation on resize).
export const catalogThumbnailCache = new Map();
// #327: the cheap stand-in visual embedding computed alongside each
// thumbnail render (computeThumbnailEmbedding below) — kept as its own
// map, not folded into catalogThumbnailCache's value, so that cache's
// existing dataUrl-in/dataUrl-out shape (relied on by every caller that
// only ever wanted the image) doesn't need to change.
// Exported for src/sell/mode.js (#2647) -- its own persistCatalogThumbnail/
// renderCatalogThumbnail call sites stay here (shared well beyond Sell
// mode), but that leaf's catalog-thumbnail-cache invalidation reads this.
export const catalogThumbnailEmbeddingCache = new Map();
const CATALOG_THUMBNAIL_SIZE = 128;
let catalogThumbnailCanvas = null;
let catalogThumbnailRenderer = null;
// Real thumbnail rendering awaits an actual model load (loadModelInstance),
// so overlapping calls could otherwise interleave through the one shared
// canvas/renderer below (mobile GPUs don't want a WebGL context per tile —
// same reasoning as the Seller modal's single shared preview canvas) and
// read back whichever render happened to finish last. Chaining every call
// onto this one queue serializes the actual render+readback work while
// still letting each caller await its own result independently.
let catalogThumbnailQueue = Promise.resolve();

// A flat swatch of the template's own color, shown immediately while the
// real render (which needs an async model load for anything with a
// modelUrl) is still in flight — closer to the real product than a blank
// or generic placeholder icon would be.
// Exported for src/catalog/picker.js (#2558) -- its own
// buildCatalogTemplateTile needs this same fallback swatch (also still
// used directly here, by Sell mode's own product-tile rendering).
export function solidColorDataUrl(color) {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  canvas.getContext('2d').fillStyle = color || '#999999';
  canvas.getContext('2d').fillRect(0, 0, 1, 1);
  return canvas.toDataURL();
}

async function renderCatalogThumbnailNow(template) {
  if (!catalogThumbnailCanvas) {
    catalogThumbnailCanvas = document.createElement('canvas');
    catalogThumbnailRenderer = new THREE.WebGLRenderer({
      canvas: catalogThumbnailCanvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    catalogThumbnailRenderer.setSize(CATALOG_THUMBNAIL_SIZE, CATALOG_THUMBNAIL_SIZE, false);
  }
  // Same instance shape showAxisPreview uses — origin, no crop, no
  // rotation — so this shows the product's real full-size appearance
  // (actual model/texture when it has one) the same way Build mode would.
  const previewObject = await createMeshForInstance({
    templateId: template.templateId,
    x: 0, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0,
    crop: {},
  });
  if (!previewObject) return null;

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(2, -3, 4);
  scene.add(sun);
  scene.add(previewObject);

  const box = new THREE.Box3().setFromObject(previewObject);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.05);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.up.set(0, 0, 1);
  const dist = radius * 2.6;
  camera.position.set(dist * 0.75, -dist * 0.95, dist * 0.65);
  camera.lookAt(0, 0, 0);

  catalogThumbnailRenderer.render(scene, camera);
  const dataUrl = catalogThumbnailCanvas.toDataURL('image/png');
  // #327: computed from these exact pixels before disposeObject/before
  // this shared canvas could possibly be reused by a queued render for a
  // different template — see computeThumbnailEmbedding's own comment.
  const embedding = computeThumbnailEmbedding(catalogThumbnailCanvas);
  disposeObject(previewObject);
  return { dataUrl, embedding };
}

// #327 ("build the 3D Model > Flat image creation pathway," the owner's
// own direction on issue #327 after ruling out a second seller photo
// upload and server-side GLB rendering, which Workers can't do): a cheap
// stand-in visual embedding — issue #327's own goal is a stored embedding
// per product image, and its own text allows stubbing "whatever's
// cheapest to get the pipeline working end-to-end first... swap in a
// better model later." Downsampling the already-rendered thumbnail into a
// small grid of normalized RGB averages needs no embedding-model/provider
// choice (a real design decision this issue's comments explicitly left
// open) and is derived from actual rendered pixels, not a metadata
// stand-in like color/category/dimensions alone (which docs/API.md's own
// discussion on #327 treated as a worse fallback, not the goal).
const THUMBNAIL_EMBEDDING_GRID = 8;
// Takes anything drawImage accepts (a canvas for a just-rendered catalog
// thumbnail, or an <img> for #328's downloaded concept image below) so
// prompt mode's search query is computed the exact same way a product's own
// stored embedding was, rather than a second, subtly different formula.
// Exported for src/catalog/picker.js (#2558) -- its own prompt-mode search
// needs this same embedding formula on the generated concept image, so the
// query is computed identically to a product's own stored embedding.
export function computeThumbnailEmbedding(source) {
  const grid = document.createElement('canvas');
  grid.width = THUMBNAIL_EMBEDDING_GRID;
  grid.height = THUMBNAIL_EMBEDDING_GRID;
  const ctx = grid.getContext('2d');
  ctx.drawImage(source, 0, 0, THUMBNAIL_EMBEDDING_GRID, THUMBNAIL_EMBEDDING_GRID);
  const { data } = ctx.getImageData(0, 0, THUMBNAIL_EMBEDDING_GRID, THUMBNAIL_EMBEDDING_GRID);
  const embedding = [];
  for (let i = 0; i < data.length; i += 4) {
    embedding.push(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
  }
  return embedding;
}

// Exported for src/catalog/picker.js (#2558) -- its own
// buildCatalogPickerButtons needs this same render-or-cached-fetch call.
export function renderCatalogThumbnail(template) {
  if (catalogThumbnailCache.has(template.templateId)) {
    return Promise.resolve(catalogThumbnailCache.get(template.templateId));
  }
  // #1446: renderCatalogThumbnailNow can genuinely reject (e.g. a
  // SecurityError from a tainted canvas on a model whose texture lacks
  // CORS headers) -- caught here, once, so neither of this function's two
  // internal .then()s nor either of its callers need their own catch.
  // Degrades the same way a null previewObject already does: no thumbnail,
  // same error-logging style persistCatalogThumbnail's own catch uses.
  const result = catalogThumbnailQueue.then(() => renderCatalogThumbnailNow(template)).catch((err) => {
    console.error('renderCatalogThumbnail: could not render a thumbnail for', template.templateId, err);
    return null;
  });
  catalogThumbnailQueue = result.then(() => {}); // keep the queue alive even if one template's render fails
  result.then((rendered) => {
    if (rendered) {
      catalogThumbnailCache.set(template.templateId, rendered.dataUrl);
      catalogThumbnailEmbeddingCache.set(template.templateId, rendered.embedding);
    }
  });
  return result.then((rendered) => rendered?.dataUrl ?? null);
}

// #327: persists the client-rendered thumbnail (plus its embedding) to
// the server so later page loads/sessions get a real stored image instead
// of needing to load and render this template's full GLTF model again,
// and so a future embedding-similarity search (#329, not built yet) has
// something to query against. Best-effort and never awaited by its
// callers — a failure here shouldn't block or surface an error for
// whatever product-creation/edit flow triggered it, since the picker
// already works fine off the client-rendered dataUrl either way.
//
// Self-found audit fix, no issue: two calls for the same template (e.g.
// a resize immediately followed by another, before the first call's own
// upload has finished — nothing else here serializes persistCatalogThumbnail
// itself, only the render step via catalogThumbnailQueue) used to just
// both `await uploadCatalogTemplateThumbnail(...)` and unconditionally
// assign the result, so whichever response happened to land last — not
// necessarily the one from the more recent render — won. A slow response
// from a now-stale render could overwrite a newer one that already landed,
// leaving template.imageUrl (and the server's own stored copy) pointing at
// an outdated thumbnail. Same supersede-guard idiom as uploadFlowToken
// above, just keyed per templateId since persistCatalogThumbnail calls for
// different templates run independently and shouldn't block each other.
const catalogThumbnailPersistTokens = new Map(); // templateId -> generation of the most recently started call
// Exported for src/catalog/upload.js (#2557) -- its own
// handleUploadDimensionsStep needs this same fire-and-forget call.
export async function persistCatalogThumbnail(template) {
  const generation = (catalogThumbnailPersistTokens.get(template.templateId) || 0) + 1;
  catalogThumbnailPersistTokens.set(template.templateId, generation);
  try {
    const dataUrl = await renderCatalogThumbnail(template);
    if (!dataUrl) return;
    const embedding = catalogThumbnailEmbeddingCache.get(template.templateId) || null;
    const imageUrl = await uploadCatalogTemplateThumbnail(template.templateId, { imageDataUrl: dataUrl, embedding });
    // A newer call already started (and may have already written its own,
    // more current result) — don't let this now-stale response regress it.
    if (catalogThumbnailPersistTokens.get(template.templateId) === generation) {
      template.imageUrl = imageUrl;
    }
  } catch (err) {
    console.error('persistCatalogThumbnail: could not persist a thumbnail for', template.templateId, err);
  }
}

// #2557: the Upload-model modal (shared between Build's catalog picker and
// Sell's product list) now lives in src/catalog/upload.js — see that
// module's own comment for its dependency notes, including why it in turn
// imports several Build/Sell-internal pieces back from this module (a
// temporary circular import, same shape claim/flow.js's and account/auth.js's
// own already use). dimensionsChanged is imported back from it here because
// the Seller modal's own "Save Size" resize handler below needs this exact
// same check, not just this modal's own handleUploadDimensionsStep.
import { dimensionsChanged } from './catalog/upload.js';

// #2558: the catalog/bundle picker modal (Build's add-item flow, "prompt
// mode" concept-image search, and the bundle picker's own tabs/rename/
// share/delete) now lives in src/catalog/picker.js — see that module's own
// comment for its dependency notes, including why it in turn imports
// several Build-internal pieces back from this module (a temporary
// circular import, same shape the other extracted modules above already
// use). addItemBtn/buildCatalogPickerButtons/closeCatalogPicker/
// openCatalogPickerForPick/renderBundlePicker/bumpBundlePickerLoadToken are
// imported back from it here because main.js's own Backup Chain panel and
// Save Bundle/bundle-list-refresh call sites (not yet extracted) still
// need them.
import {
  addItemBtn, buildCatalogPickerButtons, closeCatalogPicker,
  openCatalogPickerForPick, renderBundlePicker,
  bundlePickerLoadToken, bumpBundlePickerLoadToken,
} from './catalog/picker.js';

// #2330: mirrors worker/index.js's own MAX_MONEY_CENTS -- the ceiling
// nonnegativeInteger()/optionalInteger() enforce on every dollar-amount
// field server-side. Checked client-side at every price/bid input (same
// "surface a friendly message, not the raw server one" reasoning #1922
// already established for the Start Auction form's duration field).
// Genuinely shared well beyond the Upload-model modal (Sell's own Edit
// Price panel, Start Auction form, auction bidding below) -- stays
// declared here rather than moving into src/catalog/upload.js (#2557),
// same reasoning #2614's own issue gives for the identical worker-side
// const. Exported for that module to import back.
export const MAX_MONEY_CENTS = 100_000_000;

// Seller product management: lets a seller mark their own uploaded
// products extensible (see extensibleAxes) after the fact — the upload
// flow itself doesn't ask, since cutting something down to fit is a need
// that only shows up once a builder is actually trying to place it. Still
// no real accounts (see docs/API.md's "Sellers" section) — "mine" means
// sellerId matches this session's active seller identity (a genuinely
// separate roster from builders, not reused from one), falling back to
// any unclaimed (sellerId-less) custom upload so products created before
// sellers existed as their own concept — like a real scanned model
// uploaded before this feature — are still reachable here instead of
// stuck unmanageable.
// #2647 (leaf of #2562, see that issue and #2503's design comment): Sell
// mode's product management (seller-modal chrome, Manage/List views,
// resize preview, per-row save panels) now lives in src/sell/mode.js.
// resetSellerView is a setter for enterSellMode's own
// `sellerActiveView = 'manage'` below -- that binding is module-private
// there now.
import {
  sellerModalEl, closeSellerModal, renderActiveSellerView, hasDuplicateProductName,
  AXIS_ARROW_COLORS, openSellerModal, myProducts, updateSellerViewToggleUI,
  focusSellerManageRow, renderSellerFeedbackSummary, resetSellerView,
} from './sell/mode.js';

// Settings: local, per-device display preferences — nothing here is ever
// sent to the server (see settings.js). Four sections exist as fixed tabs
// per the product ask even though only General/Units has a real setting
// today; Shop/Build/Sell show a placeholder rather than inventing controls
// nobody asked for yet.
const settingsModalEl = document.getElementById('settings-modal');
const settingsTabsEl = document.getElementById('settings-tabs');
const settingsSectionEl = document.getElementById('settings-section');
const settingsBtn = document.getElementById('settings-btn');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const trimUnitLabelEls = [...document.querySelectorAll('.trim-unit-label')];

let activeSettingsTab = 'general';

// #1124: set right before renderSettingsSection() redraws the tab a
// Delete Account click just fired from, so the freshly re-rendered
// identity field (renderIdentityField below) can still show its own
// "Deleted" confirmation even though the DOM node that would have shown
// it got torn down along with everything else in the tab. Consumed
// (cleared) by the one renderIdentityField call whose kind matches, so a
// later, unrelated render never picks it up.
let justDeletedIdentityKind = null;

// #905: renderLandCapField/renderRedeemHigglesField/renderAuctionSection
// each await ensureBuilderIdentity() (a real network round-trip whenever
// Settings was opened from Shop mode before Build mode ever established
// builderId) before appending their own content to settingsSectionEl —
// but switching tabs (or reopening the modal) is synchronous and
// unconditional, so a tab switch mid-await let a since-superseded call's
// financially-relevant controls (Redeem Higgles, Start Auction) land on
// whatever tab is now showing. Bumped once per renderSettingsSection()
// call (covers both a tab click and a modal reopen, since both call it);
// same generation-counter idiom notificationsLoadToken/landletRenderToken
// already use elsewhere in this file for the identical shape of race.
let settingsRenderToken = 0;

// Called whenever the Units preference changes, so every on-screen length
// reflects it immediately rather than only after the next selection change
// or modal reopen.
function refreshUnitDisplays() {
  for (const el of trimUnitLabelEls) el.textContent = unitSuffix();
  updateTrimLengthInput();
  // #1939: the Measure tool's own live readout is unit-dependent (formatLength)
  // but was never covered here, unlike its sibling updateTrimLengthInput().
  if (measurePointA && measurePointB) updateMeasureResultText();
  if (sellerModalEl.classList.contains('visible')) renderActiveSellerView();
}

function renderSettingsSection() {
  settingsRenderToken += 1;
  settingsSectionEl.innerHTML = '';
  for (const btn of settingsTabsEl.querySelectorAll('.settings-tab-btn')) {
    btn.classList.toggle('active', btn.dataset.section === activeSettingsTab);
    btn.setAttribute('aria-pressed', String(btn.dataset.section === activeSettingsTab));
  }

  if (activeSettingsTab === 'general') {
    renderGeneralSettingsSection();
    return;
  }
  if (activeSettingsTab === 'shop') {
    renderShopSettingsSection();
    return;
  }
  if (activeSettingsTab === 'build') {
    renderBuildSettingsSection();
    return;
  }
  if (activeSettingsTab === 'sell') {
    renderSellSettingsSection();
    return;
  }

  const note = document.createElement('div');
  note.className = 'settings-empty-note';
  note.textContent = 'Nothing to configure here yet.';
  settingsSectionEl.appendChild(note);
}

// Owner: "I want the instructional note at the bottom of the shop screen
// that explains the three controls... to go into a Help section in Menu
// to clean up the interface." Moved out of the always-visible #shop-hint
// overlay (removed from index.html/enterShopMode) into this Settings tab,
// which already existed as an empty placeholder — reachable any time via
// Menu → Settings → Shop, not just while actually standing in the world.
function renderShopSettingsSection() {
  const field = document.createElement('div');
  field.className = 'settings-field';
  const label = document.createElement('span');
  label.textContent = 'Controls';
  field.appendChild(label);
  const note = document.createElement('div');
  note.className = 'settings-empty-note';
  note.textContent = 'Left stick to walk (push further to run) — right stick to look — double-tap 🕊️ (or double-press space) to fly.';
  field.appendChild(note);
  settingsSectionEl.appendChild(field);

  // #1588: opt-in free-look-recenters-on-facing. Off by default — the
  // existing free-look/facing independence (see updateShopMovement's own
  // comment on this) is the baseline behavior, not something this toggle
  // should change for anyone who hasn't asked for it.
  const cameraLockField = document.createElement('div');
  cameraLockField.className = 'settings-field';
  const cameraLockLabel = document.createElement('span');
  cameraLockLabel.textContent = 'Camera';
  cameraLockField.appendChild(cameraLockLabel);
  const cameraLockRow = document.createElement('div');
  cameraLockRow.className = 'settings-radio-row';
  const cameraLockLabelEl = document.createElement('label');
  const cameraLockCheckbox = document.createElement('input');
  cameraLockCheckbox.type = 'checkbox';
  cameraLockCheckbox.checked = getShopCameraLockToFacing();
  cameraLockCheckbox.addEventListener('change', () => {
    setShopCameraLockToFacing(cameraLockCheckbox.checked);
  });
  cameraLockLabelEl.appendChild(cameraLockCheckbox);
  cameraLockLabelEl.appendChild(document.createTextNode("Ease the camera back to face the way I'm walking"));
  cameraLockRow.appendChild(cameraLockLabelEl);
  cameraLockField.appendChild(cameraLockRow);
  settingsSectionEl.appendChild(cameraLockField);

  // #1340: My Animations' own compatibility badges are a function of
  // whichever avatar is currently equipped -- without wiring the two
  // together, re-equipping via My Avatars left My Animations rendering
  // badges against the previous avatar until Settings was closed and
  // reopened. refreshMyAnimationsList is reassigned below once
  // renderMyAnimationsField exists; the forward reference preserves the
  // existing DOM order (My Avatars field above My Animations field).
  let refreshMyAnimationsList = () => {};
  renderMyAvatarsField(() => refreshMyAnimationsList());
  refreshMyAnimationsList = renderMyAnimationsField();
}

// #713 (sub-issue of #710): #679 shipped the backend (GET /api/builders/
// me/avatars, GET/PUT /api/builders/me/avatar) and in-world rendering of
// whatever ends up equipped, but nothing in this file ever called any of
// it — a builder who bought an avatar-category listing (#712 finally made
// one purchasable through the app) had no way to ever equip it. Lives in
// the Shop tab, not General, since equipping only ever affects the
// Shop-mode player character. Reuses Saved Layouts/Version History's own
// .version-list/.version-row row shape above (a named, actionable list
// entry is the same kind of thing here).
function renderMyAvatarsField(onEquipped) {
  const field = document.createElement('div');
  field.className = 'settings-field';
  const label = document.createElement('span');
  label.textContent = 'My Avatars';
  field.appendChild(label);
  const hint = document.createElement('div');
  hint.className = 'settings-empty-note';
  hint.textContent = 'Equip an avatar you own to replace the default Shop-mode character.';
  field.appendChild(hint);
  const list = document.createElement('div');
  list.className = 'version-list';
  field.appendChild(list);
  settingsSectionEl.appendChild(field);

  let myAvatarsLoadToken = 0;
  async function renderMyAvatarsList() {
    const myLoadToken = ++myAvatarsLoadToken;
    list.innerHTML = '<div class="settings-empty-note">Loading…</div>';
    let avatars;
    let equipped;
    try {
      [avatars, equipped] = await Promise.all([fetchMyOwnedAvatars(), fetchMyEquippedAvatar()]);
    } catch (err) {
      if (myLoadToken !== myAvatarsLoadToken) return; // superseded while loading — a newer call owns the panel now
      list.innerHTML = '';
      const errNote = document.createElement('div');
      errNote.className = 'settings-empty-note';
      errNote.textContent = err.message || 'Could not load your avatars.';
      list.appendChild(errNote);
      return;
    }
    if (myLoadToken !== myAvatarsLoadToken) return; // superseded while loading — a newer call owns the panel now
    list.innerHTML = '';

    // The default (no template equipped) is always offered as its own row,
    // even with zero owned avatars — it's a real, equippable choice (the
    // revert target from PUT .../avatar's own { templateId: null } shape),
    // not just a placeholder for an empty list.
    const rowSpecs = [{ templateId: null, name: 'Default avatar', purchasedAt: null }, ...avatars.map((avatar) => ({ templateId: avatar.templateId, name: avatar.name, purchasedAt: avatar.purchasedAt }))];
    for (const { templateId, name, purchasedAt } of rowSpecs) {
      const row = document.createElement('div');
      row.className = 'version-row';

      const info = document.createElement('div');
      info.className = 'version-row-info';
      const isEquipped = equipped.equippedTemplateId === templateId;
      const parts = [isEquipped ? `${name} — equipped` : name];
      if (purchasedAt) {
        const purchaseDate = new Date(purchasedAt);
        if (!Number.isNaN(purchaseDate.getTime())) parts.push(`purchased ${purchaseDate.toLocaleDateString()}`);
      }
      info.textContent = parts.join(' — ');
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'version-row-actions';
      const equipBtn = document.createElement('button');
      equipBtn.type = 'button';
      equipBtn.className = 'version-action-btn';
      equipBtn.textContent = 'Equip';
      equipBtn.disabled = isEquipped;
      equipBtn.addEventListener('click', async () => {
        equipBtn.disabled = true;
        try {
          const newEquipped = await equipAvatar(templateId);
          // #1164: keep the Shop-mode buy hint's own compatibility note
          // (productInfoText) current — without this, re-equipping while
          // already in Shop mode left it comparing against whichever
          // avatar was equipped when enterShopMode last ran.
          shopEquippedAvatarSkeletonSignature = newEquipped.skeletonSignature;
          await refreshEquippedShopAvatar(newEquipped.modelUrl);
          renderMyAvatarsList();
          onEquipped?.();
        } catch (err) {
          alert(err.message || 'Could not equip this avatar.');
          equipBtn.disabled = false;
        }
      });
      actions.appendChild(equipBtn);
      row.appendChild(actions);
      list.appendChild(row);
    }
  }
  renderMyAvatarsList();
}

// #1164 (sub-issue of #1161): shared by this file's own two compatibility
// surfaces (this settings panel, and the Shop-mode buy hint below) so
// "what does compatible/incompatible/unknown actually mean" lives in
// exactly one place. Exact-match string equality (#1162's own contract —
// see computeSkeletonSignature's doc comment on why this is never fuzzy),
// gated on both signatures actually being present: `null` either means
// "the default procedural avatar" (no skeleton at all, see myAvatarJson's
// own comment) or "this animation file carries no skeleton," and neither
// can ever match anything, compatible or not.
function animationCompatibility(animationSignature, avatarSignature) {
  if (!avatarSignature) return 'no-avatar';
  if (!animationSignature) return 'unknown';
  return animationSignature === avatarSignature ? 'compatible' : 'incompatible';
}

function animationCompatibilityLabel(compatibility) {
  switch (compatibility) {
    case 'compatible': return 'Compatible with your equipped avatar';
    case 'incompatible': return 'Incompatible with your equipped avatar';
    case 'no-avatar': return 'Equip a custom avatar to check compatibility';
    default: return 'Compatibility unknown';
  }
}

// #1164: the "My Animations" sibling of renderMyAvatarsField just above —
// same row shape, equip/unequip against owned_animations (#1163) instead
// of owned_avatars, plus a compatibility badge per row (see
// animationCompatibility) since, unlike an avatar, whether an animation
// actually plays correctly depends on which avatar is currently equipped.
// Equipping an incompatible animation is still allowed here, deliberately
// — the issue's own scope note is that incompatibility should be
// *visible*, not blocked outright; #1165's own "sane fallback behavior if
// the shopper later switches to a different, incompatible avatar while an
// animation is applied" only makes sense if that combination can exist in
// the first place.
function renderMyAnimationsField() {
  const field = document.createElement('div');
  field.className = 'settings-field';
  const label = document.createElement('span');
  label.textContent = 'My Animations';
  field.appendChild(label);
  const hint = document.createElement('div');
  hint.className = 'settings-empty-note';
  hint.textContent = 'Apply an animation you own to your currently equipped avatar.';
  field.appendChild(hint);
  const list = document.createElement('div');
  list.className = 'version-list';
  field.appendChild(list);
  settingsSectionEl.appendChild(field);

  let myAnimationsLoadToken = 0;
  async function renderMyAnimationsList() {
    const myLoadToken = ++myAnimationsLoadToken;
    list.innerHTML = '<div class="settings-empty-note">Loading…</div>';
    let animations;
    let equipped;
    let equippedAvatar;
    try {
      [animations, equipped, equippedAvatar] = await Promise.all([
        fetchMyOwnedAnimations(), fetchMyEquippedAnimation(), fetchMyEquippedAvatar(),
      ]);
    } catch (err) {
      if (myLoadToken !== myAnimationsLoadToken) return; // superseded while loading — a newer call owns the panel now
      list.innerHTML = '';
      const errNote = document.createElement('div');
      errNote.className = 'settings-empty-note';
      errNote.textContent = err.message || 'Could not load your animations.';
      list.appendChild(errNote);
      return;
    }
    if (myLoadToken !== myAnimationsLoadToken) return; // superseded while loading — a newer call owns the panel now
    list.innerHTML = '';

    if (animations.length === 0) {
      const emptyNote = document.createElement('div');
      emptyNote.className = 'settings-empty-note';
      emptyNote.textContent = "You don't own any standalone animations yet.";
      list.appendChild(emptyNote);
      return;
    }

    // Unlike My Avatars, "None applied" is only a meaningful choice once
    // you own at least one animation — an empty list above already covers
    // "nothing to apply" on its own, so this row only appears alongside
    // real owned animations.
    const rowSpecs = [{ templateId: null, name: 'None applied', skeletonSignature: null, purchasedAt: null }, ...animations];
    for (const { templateId, name, skeletonSignature, purchasedAt } of rowSpecs) {
      const row = document.createElement('div');
      row.className = 'version-row';

      const info = document.createElement('div');
      info.className = 'version-row-info';
      const isEquipped = equipped.equippedTemplateId === templateId;
      const parts = [isEquipped ? `${name} — applied` : name];
      if (templateId !== null) {
        parts.push(animationCompatibilityLabel(animationCompatibility(skeletonSignature, equippedAvatar.skeletonSignature)));
      }
      if (purchasedAt) {
        const purchaseDate = new Date(purchasedAt);
        if (!Number.isNaN(purchaseDate.getTime())) parts.push(`purchased ${purchaseDate.toLocaleDateString()}`);
      }
      info.textContent = parts.join(' — ');
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'version-row-actions';
      const equipBtn = document.createElement('button');
      equipBtn.type = 'button';
      equipBtn.className = 'version-action-btn';
      equipBtn.textContent = templateId === null ? 'Clear' : 'Apply';
      equipBtn.disabled = isEquipped;
      equipBtn.addEventListener('click', async () => {
        equipBtn.disabled = true;
        try {
          await equipAnimation(templateId);
          // #1165: live-swap the Shop-mode avatar's actual playing clips
          // the same way re-equipping an avatar already does — the avatar
          // itself (shopAvatar.modelUrl) doesn't change here, only which
          // animation createCustomShopAvatar binds against it.
          await refreshEquippedShopAvatar(shopAvatar?.modelUrl);
          renderMyAnimationsList();
        } catch (err) {
          alert(err.message || 'Could not apply this animation.');
          equipBtn.disabled = false;
        }
      });
      actions.appendChild(equipBtn);
      row.appendChild(actions);
      list.appendChild(row);
    }
  }
  renderMyAnimationsList();
  return renderMyAnimationsList;
}

function renderGeneralSettingsSection() {
  const field = document.createElement('div');
  field.className = 'settings-field';
  const fieldLabel = document.createElement('span');
  fieldLabel.textContent = 'Units';
  field.appendChild(fieldLabel);

  const radioRow = document.createElement('div');
  radioRow.className = 'settings-radio-row';
  const currentUnits = getUnits();
  for (const [value, optionLabel] of [['m', 'Meters'], ['ft', 'Feet']]) {
    const optionLabelEl = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'settings-units';
    radio.value = value;
    radio.checked = currentUnits === value;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      setUnits(value);
      refreshUnitDisplays();
    });
    optionLabelEl.appendChild(radio);
    optionLabelEl.appendChild(document.createTextNode(optionLabel));
    radioRow.appendChild(optionLabelEl);
  }
  field.appendChild(radioRow);
  settingsSectionEl.appendChild(field);

  const versionField = document.createElement('div');
  versionField.className = 'settings-field';
  const versionLabel = document.createElement('span');
  versionLabel.textContent = 'Version';
  versionField.appendChild(versionLabel);
  const versionValue = document.createElement('div');
  versionValue.className = 'settings-empty-note';
  versionValue.textContent = BUILD_INFO_TEXT;
  versionField.appendChild(versionValue);
  settingsSectionEl.appendChild(versionField);

  renderTaxPaperworkField();
  renderNotificationPreferencesField();
}

// #2067 (leaf sub-issue of #1973, part of #1947): account-level opt-in
// for an email alert on top of the dashboard notification already fired
// unconditionally when one of this builder's placed products sells out.
// Same async-field-in-General shape as renderTaxPaperworkField just
// above (currentAuthUser-gated, settingsRenderToken-guarded against a
// tab switch/modal reopen racing the fetch).
async function renderNotificationPreferencesField() {
  if (!currentAuthUser) return;
  const myToken = settingsRenderToken;

  const field = document.createElement('div');
  field.className = 'settings-field';
  const fieldLabel = document.createElement('span');
  fieldLabel.textContent = 'Notifications';
  field.appendChild(fieldLabel);
  const status = document.createElement('div');
  status.className = 'settings-empty-note';
  status.textContent = 'Loading…';
  field.appendChild(status);
  settingsSectionEl.appendChild(field);

  let prefs;
  try {
    prefs = await fetchNotificationPreferences();
  } catch (err) {
    status.textContent = err.message || 'Could not load your notification preferences.';
    status.classList.add('error');
    return;
  }
  if (myToken !== settingsRenderToken) return;
  field.removeChild(status);

  const row = document.createElement('div');
  row.className = 'settings-radio-row';
  const labelEl = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = !!prefs.notifySoldOutEmail;
  checkbox.addEventListener('change', async () => {
    const desired = checkbox.checked;
    checkbox.disabled = true;
    try {
      await updateNotificationPreferences({ notifySoldOutEmail: desired });
    } catch (err) {
      checkbox.checked = !desired;
      alert(err.message || 'Could not update this preference.');
    } finally {
      checkbox.disabled = false;
    }
  });
  labelEl.appendChild(checkbox);
  labelEl.appendChild(document.createTextNode('Email me when one of my placed products sells out'));
  row.appendChild(labelEl);
  field.appendChild(row);

  const note = document.createElement('div');
  note.className = 'settings-empty-note';
  note.textContent = 'You always get a dashboard notification when this happens — this adds an email on top.';
  field.appendChild(note);
}

// #614: POST /api/tax/id-form (W-9/W-8BEN collection) has existed on the
// backend since #621, and the earnings-threshold gate that actually blocks
// redemption/payout without it (#615) has been live just as long — but
// nothing in this file ever called the submission endpoint, leaving a real
// account with no in-app way to unblock itself once it crosses the
// threshold (worker/index.js's taxThresholdPayoutBlockedError literally
// tells the user to call the raw API). Lives in General (not Build/Sell)
// since the combined threshold spans both a builder's higgles commissions
// and a seller's real-money payouts.
async function renderTaxPaperworkField() {
  if (!currentAuthUser) return;

  const statusField = document.createElement('div');
  statusField.className = 'settings-field';
  const statusLabel = document.createElement('span');
  statusLabel.textContent = 'Tax Paperwork';
  statusField.appendChild(statusLabel);
  const statusNote = document.createElement('div');
  statusNote.className = 'settings-empty-note';
  statusNote.setAttribute('role', 'status');
  statusNote.setAttribute('aria-live', 'polite');
  statusField.appendChild(statusNote);
  settingsSectionEl.appendChild(statusField);

  function refreshStatusNote() {
    if (currentAuthUser.taxFormType) {
      const formLabel = currentAuthUser.taxFormType === 'w9' ? 'W-9' : 'W-8BEN';
      const completedDate = new Date(currentAuthUser.taxFormCompletedAt).toLocaleDateString();
      statusNote.textContent = `${formLabel} on file since ${completedDate}. Submitting again below replaces it.`;
    } else {
      statusNote.textContent = 'No tax paperwork on file yet — required once your combined earnings ' +
        'cross this year\'s reporting threshold (see the account menu\'s own notice for where you stand).';
    }
  }
  refreshStatusNote();

  const formField = document.createElement('div');
  formField.className = 'settings-field';
  settingsSectionEl.appendChild(formField);

  const typeRow = document.createElement('div');
  typeRow.className = 'settings-radio-row';
  const typeInputs = {};
  for (const [value, optionLabel] of [['w9', 'W-9 (US person)'], ['w8ben', 'W-8BEN (non-US person)']]) {
    const optionLabelEl = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'tax-form-type';
    radio.value = value;
    radio.checked = (currentAuthUser.taxFormType || 'w9') === value;
    optionLabelEl.appendChild(radio);
    optionLabelEl.appendChild(document.createTextNode(optionLabel));
    typeRow.appendChild(optionLabelEl);
    typeInputs[value] = radio;
  }
  formField.appendChild(typeRow);

  // #2344: maxLength here mirrors this form's own server-side caps --
  // legalName/addressLine1 go through taxFormTextValue's 200-char
  // MAX_TAX_FORM_TEXT_LENGTH, every other field through labelValue's
  // 100-char MAX_LABEL_LENGTH (worker/index.js's validateTaxIdForm).
  const commonFields = [
    ['legalName', 'Legal name', 'text', 200],
    ['addressLine1', 'Street address', 'text', 200],
    ['city', 'City', 'text', 100],
  ];
  const w9Fields = [
    ['state', 'State', 'text', 100],
    ['postalCode', 'ZIP code', 'text', 100],
    ['taxIdNumber', 'SSN or EIN', 'text', 100],
  ];
  const w8benFields = [
    ['country', 'Country', 'text', 100],
    ['countryOfCitizenship', 'Country of citizenship', 'text', 100],
    ['foreignTaxId', 'Foreign tax ID', 'text', 100],
  ];
  const form = document.createElement('div');
  form.className = 'stripe-onboarding-form';
  const inputs = {};
  function addFormInputs(specs) {
    const labels = [];
    for (const [key, fieldLabel, type, maxLength] of specs) {
      const label = document.createElement('label');
      label.textContent = fieldLabel;
      const input = document.createElement('input');
      input.type = type;
      input.maxLength = maxLength;
      label.appendChild(input);
      form.appendChild(label);
      inputs[key] = input;
      labels.push(label);
    }
    return labels;
  }
  addFormInputs(commonFields);
  const w9Labels = addFormInputs(w9Fields);
  const w8benLabels = addFormInputs(w8benFields);

  function refreshFieldVisibility() {
    const isW9 = typeInputs.w9.checked;
    for (const label of w9Labels) label.hidden = !isW9;
    for (const label of w8benLabels) label.hidden = isW9;
  }
  refreshFieldVisibility();
  typeInputs.w9.addEventListener('change', refreshFieldVisibility);
  typeInputs.w8ben.addEventListener('change', refreshFieldVisibility);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'version-action-btn';
  submitBtn.textContent = currentAuthUser.taxFormType ? 'Update tax paperwork' : 'Submit tax paperwork';
  form.appendChild(submitBtn);
  const formStatus = document.createElement('div');
  formStatus.className = 'settings-empty-note';
  form.appendChild(formStatus);

  submitBtn.addEventListener('click', async () => {
    formStatus.textContent = '';
    formStatus.classList.remove('error');
    submitBtn.disabled = true;
    try {
      const formType = typeInputs.w9.checked ? 'w9' : 'w8ben';
      const specificFields = formType === 'w9' ? w9Fields : w8benFields;
      const payload = { formType };
      for (const [key] of commonFields) payload[key] = inputs[key].value;
      for (const [key] of specificFields) payload[key] = inputs[key].value;
      const result = await submitTaxIdForm(payload);
      setCurrentAuthUser({ ...currentAuthUser, taxFormType: result.taxFormType, taxFormCompletedAt: result.taxFormCompletedAt });
      refreshStatusNote();
      submitBtn.textContent = 'Update tax paperwork';
      formStatus.textContent = 'Submitted.';
    } catch (err) {
      formStatus.textContent = err.message || 'Could not submit — check the fields above.';
      formStatus.classList.add('error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  formField.appendChild(form);
}

// Land cap (docs/SPEC.md §3, docs/API.md's "Land cap") — a builder-account
// fact, not tied to the currently-active landlet the way Publish/Version
// History below are, so this shows regardless of currentMode/
// currentLandletId (as long as a builder identity has actually been
// chosen at all this session — builderId can still be null if Settings is
// opened from Shop mode before ever entering Build).
async function renderLandCapField() {
  const myToken = settingsRenderToken;
  // builderId can be null here purely because Settings was opened from Shop
  // mode before Build mode ever ran ensureBuilderIdentity() this session —
  // not because the visitor is actually logged out. If they already have a
  // session, silently establish it the same way (requireLogin's own
  // `if (currentAuthUser) return currentAuthUser` means this never pops a
  // login prompt) instead of just leaving this whole field missing.
  if (!builderId && currentAuthUser) setBuilderId(await ensureBuilderIdentity());
  // #905: a tab switch (or modal reopen) during that await already tore
  // down and rebuilt settingsSectionEl for a different tab — appending
  // below would land this field there instead of silently vanishing with
  // it, same as a stale renderNotifications/renderForLandlet call already
  // gets caught by their own load tokens.
  if (myToken !== settingsRenderToken) return;
  if (!builderId) return;
  const field = document.createElement('div');
  field.id = 'land-cap-field';
  field.className = 'settings-field';
  const fieldLabel = document.createElement('span');
  fieldLabel.textContent = 'Land Cap';
  field.appendChild(fieldLabel);
  const status = document.createElement('div');
  status.className = 'settings-empty-note';
  status.textContent = 'Loading…';
  field.appendChild(status);
  settingsSectionEl.appendChild(field);
  try {
    // ownedAreaM2 comes straight from the builder object now (#312) —
    // the backend's own recomputeLandCap already sums every owned
    // landlet's ground area *and* every level's own cap_consumed_m2
    // (docs/API.md's "Vertical construction") to grow landCapM2 itself,
    // so reading it back here is both more accurate (a frontend-side sum
    // over fetchAllLandlets alone silently ignored level area) and
    // cheaper (no second paginated fetch needed at all). Uses
    // fetchMyBuilder (GET /api/builders/me) rather than scanning the full
    // GET /api/builders roster for this account's own row (found via
    // #711's own investigation: the full-roster fetch this used to do
    // would silently stop finding a late-signed-up builder's own row the
    // moment that list endpoint gets capped) — this account's own record
    // is always exactly what's needed here, never anyone else's.
    const me = await fetchMyBuilder();
    const ownedAreaM2 = me.ownedAreaM2 ?? 0;
    status.textContent = `You own ${formatArea(ownedAreaM2, 0)} of your ${formatArea(me.landCapM2, 0)} cap. ` +
      'Your cap grows automatically as you earn higgles from selling lándlets via auction — never purchasable with cash.';
  } catch (err) {
    status.textContent = err.message || 'Could not load your land cap.';
  }
}

// #724: renameBuilder/deleteBuilder/renameSeller had real, working,
// documented backend endpoints (docs/API.md's "Builders"/"Sellers") but no
// UI ever called any of them. Shared between the Build and Sell settings
// tabs since a builder identity and a seller identity work identically
// here — only the fetch/rename/delete calls and the delete warning differ.
async function renderIdentityField(kind, { fetchProfile, idKey, renameProfile, deleteProfile, deleteWarning, onDeleted, onRenamed }) {
  const field = document.createElement('div');
  field.className = 'settings-field';
  const label = document.createElement('span');
  label.textContent = `${kind} Identity`;
  field.appendChild(label);
  const status = document.createElement('div');
  status.className = 'settings-empty-note';
  status.textContent = 'Loading…';
  field.appendChild(status);
  settingsSectionEl.appendChild(field);

  let profile;
  try {
    profile = await fetchProfile();
  } catch (err) {
    status.textContent = err.message || `Could not load your ${kind.toLowerCase()} identity.`;
    status.classList.add('error');
    return;
  }

  const nameRow = document.createElement('div');
  field.insertBefore(nameRow, status);

  const actions = document.createElement('div');
  actions.className = 'version-row-actions';
  field.insertBefore(actions, status);

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'version-action-btn';
  renameBtn.textContent = 'Rename';
  actions.appendChild(renameBtn);

  const deleteBtn = document.createElement('button');
  if (deleteProfile) {
    deleteBtn.type = 'button';
    deleteBtn.className = 'version-action-btn';
    // #1149: this used to say "Delete Account," which was never true — it
    // only ever reset this one profile (land/build/balance released, a
    // fresh profile auto-created), while the real login account kept
    // working the whole time. Real account deletion now lives in the
    // Account panel (see auth-delete-account-btn); this stays what it
    // always actually was, just honestly labeled.
    deleteBtn.textContent = 'Reset Profile';
    actions.appendChild(deleteBtn);
  }

  function renderName() {
    nameRow.textContent = profile.label;
  }
  renderName();
  // #1124: this render may be the one renderSettingsSection() triggered
  // right after a Reset Profile click redrew the whole tab — if so, show
  // the same confirmation the old, identity-field-only refresh used to,
  // rather than a blank status now that a fresh profile (not the deleted
  // one) is what fetchProfile() above actually returned.
  if (justDeletedIdentityKind === kind) {
    justDeletedIdentityKind = null;
    status.textContent = `Reset — a fresh ${kind.toLowerCase()} identity was created.`;
  } else {
    status.textContent = '';
  }

  renameBtn.addEventListener('click', async () => {
    const next = prompt(`Rename your ${kind.toLowerCase()} identity`, profile.label);
    if (!next || !next.trim() || next.trim() === profile.label) return;
    if (next.trim().length > 100) {
      alert('Keep it to 100 characters or fewer.');
      return;
    }
    status.textContent = '';
    status.classList.remove('error');
    renameBtn.disabled = true;
    try {
      profile = await renameProfile(profile[idKey], next.trim());
      renderName();
      // #741: shopBuilderLabels (a Shop-mode-only cache) has no other way
      // to learn about a rename that happens mid-session — let the caller
      // patch whatever cache it keeps, same shape as onDeleted above.
      onRenamed?.(profile[idKey], profile.label);
    } catch (err) {
      status.textContent = err.message || 'Could not rename.';
      status.classList.add('error');
    } finally {
      renameBtn.disabled = false;
    }
  });

  if (deleteProfile) {
    deleteBtn.addEventListener('click', async () => {
      // #740: deleteWarning may be a function of the current profile (e.g.
      // to disclose a real-money-backed balance that's about to be
      // forfeited) rather than a fixed string — resolved fresh on every
      // click since `profile` can have changed since renderIdentityField
      // was first called.
      const warningText = typeof deleteWarning === 'function' ? deleteWarning(profile) : deleteWarning;
      if (!confirm(warningText)) return;
      status.textContent = '';
      status.classList.remove('error');
      deleteBtn.disabled = true;
      try {
        await deleteProfile(profile[idKey]);
        // #738: the caller's cached module-level id (builderId/sellerId)
        // must be cleared here, before fetchProfile() re-provisions a
        // fresh identity server-side -- ensureBuilderIdentity()'s own
        // `if (builderId) return builderId;` short-circuit would otherwise
        // keep every later action (claim, bid, build) pinned to the
        // just-deleted, now-nonexistent id until a full page reload.
        onDeleted?.();
        // #1124: Land Cap/Redeem Higgles/Active Auctions (Build tab) and
        // Payout Account (Sell tab) each fetch their own data once at
        // tab-render time and never re-fetch on their own — patching only
        // this field's own nameRow/status (the old behavior) left them
        // showing the just-deleted identity's stale figures. A full
        // renderSettingsSection() redraw — the same thing a manual tab
        // switch already triggers — is what actually refreshes every
        // sibling field against the fresh, auto-provisioned identity, not
        // just this one.
        justDeletedIdentityKind = kind;
        renderSettingsSection();
        return;
      } catch (err) {
        status.textContent = err.message || 'Could not delete.';
        status.classList.add('error');
      } finally {
        deleteBtn.disabled = false;
      }
    });
  }
}

// #723: #624/#625 shipped GET/POST /api/builders/me/stripe-account and
// .../redeem — a builder's own exit from higgles to real cash — but
// nothing in this file ever called either. Lives alongside Land Cap
// above, not the Sell tab's own payout section, since redeeming a
// higgles balance is a builder-account concern independent of whether
// this account also sells anything. Reuses renderSellSettingsSection's
// own Stripe Custom-account onboarding form almost verbatim (same
// fields, different account row) rather than sharing code with it, to
// avoid touching that already-working, real-money-adjacent flow.
async function renderRedeemHigglesField() {
  const myToken = settingsRenderToken;
  if (!builderId && currentAuthUser) setBuilderId(await ensureBuilderIdentity());
  // #905: see renderLandCapField's own comment — a tab switch/modal reopen
  // during that await already tore down settingsSectionEl for a different
  // tab, so this real-money redemption form must not land there.
  if (myToken !== settingsRenderToken) return;
  if (!builderId) return;

  const statusField = document.createElement('div');
  statusField.className = 'settings-field';
  const statusLabel = document.createElement('span');
  statusLabel.textContent = 'Redeem Higgles';
  statusField.appendChild(statusLabel);
  const statusNote = document.createElement('div');
  statusNote.className = 'settings-empty-note';
  statusNote.setAttribute('role', 'status');
  statusNote.setAttribute('aria-live', 'polite');
  statusNote.textContent = 'Loading…';
  statusField.appendChild(statusNote);
  settingsSectionEl.appendChild(statusField);

  const formField = document.createElement('div');
  formField.className = 'settings-field';
  settingsSectionEl.appendChild(formField);
  // #1912: exposes this call's own formField so a test can tell a fixed
  // early-return (no children ever appended to it) apart from the
  // pre-fix behavior (the form still gets built and appended onto this
  // now-detached node after a superseded tab switch) -- there's no
  // DOM-visible difference to check otherwise, since this appendChild
  // above (unlike renderSellSettingsSection's later, gated
  // settingsSectionEl.appendChild(payoutsField)) is the last direct
  // append to the live settingsSectionEl either way.
  window.__testLastRedeemFormField = formField;

  let redeemStatus;
  try {
    redeemStatus = await fetchBuilderRedeemStatus();
  } catch (err) {
    statusNote.textContent = err.message || 'Could not load your redemption status.';
    statusNote.classList.add('error');
    return;
  }
  // #1912: a tab switch (or modal reopen) during that await already tore
  // down and rebuilt settingsSectionEl for a different tab — same #1732/#905
  // guard renderSellSettingsSection already has after its own second await.
  if (myToken !== settingsRenderToken) return;

  function describeAccountStatus() {
    if (!redeemStatus.configured) {
      return "Stripe payouts aren't set up on this server yet — check back later.";
    }
    if (redeemStatus.status === 'complete') return 'Your payout account is fully set up.';
    if (redeemStatus.status === 'requirements_due') {
      return `Stripe needs more information: ${redeemStatus.requirementsCurrentlyDue.join(', ')}`;
    }
    if (redeemStatus.status === 'action_needed') return 'Stripe flagged an issue with this account — resubmit below.';
    if (redeemStatus.connected) return 'Your account was created — verification is pending.';
    return 'Not set up yet. Redeeming higgles for cash needs this first.';
  }

  function refreshStatusNote() {
    statusNote.textContent = `Available to redeem: ${formatHiggles(redeemStatus.availableCents)} — ${describeAccountStatus()}`;
    statusNote.classList.remove('error');
  }
  refreshStatusNote();

  const fields = [
    ['firstName', 'First name', 'text'],
    ['lastName', 'Last name', 'text'],
    ['dobDay', 'Birth day', 'number'],
    ['dobMonth', 'Birth month', 'number'],
    ['dobYear', 'Birth year', 'number'],
    ['ssnLast4', 'SSN (last 4 digits)', 'text'],
    ['addressLine1', 'Street address', 'text'],
    ['addressCity', 'City', 'text'],
    ['addressState', 'State', 'text'],
    ['addressPostalCode', 'ZIP code', 'text'],
    ['addressCountry', 'Country (2-letter code)', 'text'],
    ['routingNumber', 'Bank routing number', 'text'],
    ['accountNumber', 'Bank account number', 'text'],
  ];
  const inputs = {};
  const form = document.createElement('div');
  form.className = 'stripe-onboarding-form';
  for (const [key, fieldLabel, type] of fields) {
    const label = document.createElement('label');
    label.textContent = fieldLabel;
    const input = document.createElement('input');
    input.type = type;
    if (key === 'addressCountry') input.value = 'US';
    if (key === 'dobMonth') { input.min = '1'; input.max = '12'; }
    if (key === 'dobDay') { input.min = '1'; input.max = '31'; }
    label.appendChild(input);
    form.appendChild(label);
    inputs[key] = input;
  }
  // #1940: dobDay's own max (31) never accounted for which month was
  // entered -- keep it in sync so the browser's own number-input
  // clamping/invalid-state catches Feb 30 etc. before submit does.
  function refreshDobDayMax() {
    const month = parseInt(inputs.dobMonth.value, 10);
    const year = parseInt(inputs.dobYear.value, 10);
    if (!Number.isFinite(month) || month < 1 || month > 12) return;
    inputs.dobDay.max = String(daysInMonth(Number.isFinite(year) ? year : new Date().getUTCFullYear(), month));
  }
  inputs.dobMonth.addEventListener('input', refreshDobDayMax);
  inputs.dobYear.addEventListener('input', refreshDobDayMax);
  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'version-action-btn';
  submitBtn.textContent = redeemStatus.connected ? 'Update payout account' : 'Set up payout account';
  form.appendChild(submitBtn);
  const formStatus = document.createElement('div');
  formStatus.className = 'settings-empty-note';
  form.appendChild(formStatus);

  submitBtn.addEventListener('click', async () => {
    formStatus.textContent = '';
    formStatus.classList.remove('error');
    submitBtn.disabled = true;
    try {
      const updated = await submitBuilderStripeAccount({
        individual: {
          firstName: inputs.firstName.value,
          lastName: inputs.lastName.value,
          dobDay: Number(inputs.dobDay.value),
          dobMonth: Number(inputs.dobMonth.value),
          dobYear: Number(inputs.dobYear.value),
          ssnLast4: inputs.ssnLast4.value,
          addressLine1: inputs.addressLine1.value,
          addressCity: inputs.addressCity.value,
          addressState: inputs.addressState.value,
          addressPostalCode: inputs.addressPostalCode.value,
          addressCountry: inputs.addressCountry.value,
        },
        externalAccount: {
          routingNumber: inputs.routingNumber.value,
          accountNumber: inputs.accountNumber.value,
          currency: 'usd',
        },
      });
      redeemStatus = { ...redeemStatus, ...updated };
      // #1403: submitBtn's "Set up"/"Update payout account" label (line
      // 5918 above) is only ever set once, at this function's own initial
      // render, gated on redeemStatus.connected as it stood then — a
      // first-time submit flips connected from false to true right here,
      // but nothing re-evaluated that gate afterward, so the button kept
      // reading "Set up payout account" until the tab was closed and
      // reopened. Same renderSettingsSection() full-redraw idiom #1373
      // already uses for the sibling Sell tab's own onboarding form.
      renderSettingsSection();
      return;
    } catch (err) {
      formStatus.textContent = err.message || 'Could not submit — check the fields above.';
      formStatus.classList.add('error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  formField.appendChild(form);

  if (redeemStatus.availableCents > 0) {
    const redeemBtn = document.createElement('button');
    redeemBtn.type = 'button';
    redeemBtn.className = 'version-action-btn';
    redeemBtn.textContent = 'Redeem';
    formField.appendChild(redeemBtn);
    const redeemStatusNote = document.createElement('div');
    redeemStatusNote.className = 'settings-empty-note';
    formField.appendChild(redeemStatusNote);

    redeemBtn.addEventListener('click', async () => {
      redeemBtn.disabled = true;
      redeemStatusNote.textContent = '';
      redeemStatusNote.classList.remove('error');
      try {
        const result = await redeemHiggles();
        redeemStatusNote.textContent = `Redeemed ${formatHiggles(result.redeemedCents)}.`;
      } catch (err) {
        // Currently always hits here — #653 pauses every redemption
        // pending a fraud-provenance design, and the server's own error
        // message already explains that clearly; surfaced as-is rather
        // than special-cased.
        redeemStatusNote.textContent = err.message || 'Could not redeem right now.';
        redeemStatusNote.classList.add('error');
      } finally {
        redeemBtn.disabled = false;
      }
    });
  }
}

function renderBuilderIdentityField() {
  renderIdentityField('Builder', {
    fetchProfile: fetchMyBuilder,
    idKey: 'builderId',
    renameProfile: (id, label) => renameBuilder(id, label),
    deleteProfile: (id) => deleteBuilder(id),
    // #740: deleteBuilder hard-deletes the builder row, including any
    // real-money-backed higgles balance on it — nothing preserves or
    // refunds it. Disclose the actual amount at stake rather than leaving
    // it a silent side effect of "this can't be undone".
    deleteWarning: (profile) => {
      const balanceCents = profile?.higglesBalanceCents ?? 0;
      const balanceNote = balanceCents > 0
        ? ` You'll also forfeit your ${formatHiggles(balanceCents)} higgles balance — it cannot be recovered.`
        : '';
      return `Reset your builder profile? Any lándlet you currently own is released back to greenbelt (its build is cleared) — this can't be undone.${balanceNote} Your login stays active either way; use Delete Account under Account above to delete that too.`;
    },
    // #2068: Reset Profile releases any owned lándlet back to greenbelt
    // server-side (see deleteWarning's own wording above) -- currentLandletId
    // must be cleared alongside builderId, not left stale, since it's no
    // longer a landlet this session owns. Previously harmless (nothing in
    // Settings > Build auto-fetched anything landlet-ownership-gated), but
    // renderSoldOutMarkersSection's own auto-fetch surfaced it: the very
    // next full renderSettingsSection() redraw this same Reset Profile
    // triggers would otherwise still query the old, just-released landlet
    // and get a real 403 back.
    onDeleted: () => { setBuilderId(null); setCurrentLandletId(null); },
    // #741: keep Shop mode's own "Built by X" attribution (populated once
    // in enterShopMode) from showing a stale pre-rename label for the rest
    // of this session.
    onRenamed: (id, label) => { setShopBuilderLabel(id, label); },
  });
}

function renderSellerIdentityField() {
  renderIdentityField('Seller', {
    fetchProfile: fetchMySeller,
    idKey: 'sellerId',
    renameProfile: (id, label) => renameSeller(id, label),
    deleteProfile: (id) => deleteSeller(id),
    // #744: unlike a builder, a seller owns no landlet to release — the
    // backend's own guard (worker/index.js's DELETE /api/sellers/:id,
    // #732) is what actually protects real money here, by 409ing instead
    // of deleting while a real purchase's proceeds are still unpaid, so
    // this warning doesn't need to (and can't) disclose an amount at risk
    // the way renderBuilderIdentityField's higgles-balance warning does.
    deleteWarning: 'Reset your seller profile? This cannot be undone. Your login stays active either way; use Delete Account under Account above to delete that too.',
    onDeleted: () => { setSellerId(null); },
  });
}

// Publish + Version History (see docs/API.md's "Landlet drafts"/"Landlet
// versions") — the one place the already-existing draft/version/activate
// backend gets a frontend. Only meaningful while actually in Build mode on
// a claimed landlet (Settings itself stays reachable from Shop too, but
// there's no landlet to publish from there).
function renderBuildSettingsSection() {
  renderBuilderIdentityField();
  renderLandCapField();
  renderRedeemHigglesField();
  renderAuctionSection();
  renderLowStockSection();
  renderSoldOutMarkersSection();
  if (currentMode !== 'build' || !currentLandletId) {
    const note = document.createElement('div');
    note.className = 'settings-empty-note';
    note.textContent = 'Enter Build mode on a claimed lándlet to publish or manage versions.';
    settingsSectionEl.appendChild(note);
    return;
  }
  const landletId = currentLandletId;

  const publishField = document.createElement('div');
  publishField.className = 'settings-field';
  const publishLabel = document.createElement('span');
  publishLabel.textContent = 'Publish';
  publishField.appendChild(publishLabel);
  const publishHint = document.createElement('div');
  publishHint.className = 'settings-empty-note';
  publishHint.textContent = 'Shoppers see whatever was last published here, not your live edits, until you publish again.';
  publishField.appendChild(publishHint);
  const publishBtn = document.createElement('button');
  publishBtn.type = 'button';
  publishBtn.className = 'version-action-btn';
  publishBtn.textContent = 'Publish';
  publishField.appendChild(publishBtn);
  const publishStatus = document.createElement('div');
  publishStatus.id = 'build-publish-status';
  publishStatus.className = 'settings-empty-note';
  publishField.appendChild(publishStatus);
  settingsSectionEl.appendChild(publishField);

  const historyField = document.createElement('div');
  historyField.className = 'settings-field';
  const historyLabel = document.createElement('span');
  historyLabel.textContent = 'Version History';
  historyField.appendChild(historyLabel);
  const historyList = document.createElement('div');
  historyList.className = 'version-list';
  historyField.appendChild(historyList);
  const historyLoadMoreBtn = document.createElement('button');
  historyLoadMoreBtn.type = 'button';
  historyLoadMoreBtn.className = 'version-action-btn';
  historyLoadMoreBtn.textContent = 'Load more';
  historyLoadMoreBtn.hidden = true;
  historyField.appendChild(historyLoadMoreBtn);
  settingsSectionEl.appendChild(historyField);

  // #634/#635 (sub-issues of #631): a removed level's swept-out instances
  // (#633) land here — reusing Version History's own .settings-field/
  // .version-list/.version-row/.version-action-btn look immediately above
  // rather than inventing a second list style for what's structurally the
  // same kind of thing (a builder's own named, timestamped, deletable
  // snapshot of instances).
  const savedLayoutsField = document.createElement('div');
  savedLayoutsField.className = 'settings-field';
  const savedLayoutsLabel = document.createElement('span');
  savedLayoutsLabel.textContent = 'Saved Layouts';
  savedLayoutsField.appendChild(savedLayoutsLabel);
  const savedLayoutsHint = document.createElement('div');
  savedLayoutsHint.className = 'settings-empty-note';
  savedLayoutsHint.textContent = "Instances swept off active space when you remove a level here, so nothing's really lost.";
  savedLayoutsField.appendChild(savedLayoutsHint);
  const savedLayoutsList = document.createElement('div');
  savedLayoutsList.className = 'version-list';
  savedLayoutsField.appendChild(savedLayoutsList);
  const savedLayoutsLoadMoreBtn = document.createElement('button');
  savedLayoutsLoadMoreBtn.type = 'button';
  savedLayoutsLoadMoreBtn.id = 'saved-layouts-load-more-btn';
  savedLayoutsLoadMoreBtn.textContent = 'Load more';
  savedLayoutsLoadMoreBtn.hidden = true;
  savedLayoutsField.appendChild(savedLayoutsLoadMoreBtn);
  settingsSectionEl.appendChild(savedLayoutsField);

  let savedLayoutsLoadToken = 0;
  // The cursor for whatever page comes after the ones currently rendered —
  // null once there's nothing more to load. Same shape as
  // notificationsNextCursor (src/main.js ~8974) — #1215 found this panel's
  // own `fetchSavedLayouts({ limit: 20 })` never read the API's own
  // already-supported `nextCursor` at all, silently hiding anything past
  // the first 20 saved layouts.
  let savedLayoutsNextCursor = null;

  function appendSavedLayoutRow(savedLayout) {
    const row = document.createElement('div');
    row.className = 'version-row';

    const info = document.createElement('div');
    info.className = 'version-row-info';
    const itemWord = savedLayout.instanceCount === 1 ? 'item' : 'items';
    info.textContent = `${savedLayout.name} — ${savedLayout.instanceCount} ${itemWord}`;
    row.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'version-row-actions';

    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'version-action-btn';
    previewBtn.textContent = 'Preview';
    previewBtn.addEventListener('click', () => {
      sessionStorage.setItem(PREVIEW_SAVED_LAYOUT_ID_KEY, savedLayout.savedLayoutId);
      sessionStorage.setItem(START_MODE_KEY, 'layoutPreview');
      location.reload();
    });
    actions.appendChild(previewBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'version-action-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Permanently delete "${savedLayout.name}"? This can't be undone.`)) return;
      deleteBtn.disabled = true;
      try {
        await deleteSavedLayout(savedLayout.savedLayoutId);
        renderSavedLayoutsList();
      } catch (err) {
        alert(err.message || 'Could not delete this saved layout.');
        deleteBtn.disabled = false;
      }
    });
    actions.appendChild(deleteBtn);

    row.appendChild(actions);
    savedLayoutsList.appendChild(row);
  }

  async function renderSavedLayoutsList() {
    const myLoadToken = ++savedLayoutsLoadToken;
    savedLayoutsList.innerHTML = '<div class="settings-empty-note">Loading…</div>';
    savedLayoutsLoadMoreBtn.hidden = true;
    savedLayoutsNextCursor = null;
    let page;
    try {
      page = await fetchSavedLayouts({ limit: 20 });
    } catch (err) {
      if (myLoadToken !== savedLayoutsLoadToken) return; // superseded while loading — a newer call owns the panel now
      savedLayoutsList.innerHTML = '';
      const errNote = document.createElement('div');
      errNote.className = 'settings-empty-note';
      errNote.textContent = err.message || 'Could not load saved layouts.';
      savedLayoutsList.appendChild(errNote);
      return;
    }
    if (myLoadToken !== savedLayoutsLoadToken) return; // superseded while loading — a newer call owns the panel now
    savedLayoutsList.innerHTML = '';
    if (page.savedLayouts.length === 0) {
      savedLayoutsList.innerHTML = '<div class="settings-empty-note">Nothing saved yet — removing a level with instances on it saves them here first.</div>';
      return;
    }
    for (const savedLayout of page.savedLayouts) appendSavedLayoutRow(savedLayout);
    savedLayoutsNextCursor = page.nextCursor;
    savedLayoutsLoadMoreBtn.hidden = !savedLayoutsNextCursor;
  }
  renderSavedLayoutsList();

  savedLayoutsLoadMoreBtn.addEventListener('click', async () => {
    const myLoadToken = savedLayoutsLoadToken; // this panel's current, already-rendered load — not a fresh reset
    savedLayoutsLoadMoreBtn.disabled = true;
    try {
      const page = await fetchSavedLayouts({ limit: 20, cursor: savedLayoutsNextCursor });
      if (myLoadToken !== savedLayoutsLoadToken) return; // panel was reset while this page was loading
      for (const savedLayout of page.savedLayouts) appendSavedLayoutRow(savedLayout);
      savedLayoutsNextCursor = page.nextCursor;
      savedLayoutsLoadMoreBtn.hidden = !savedLayoutsNextCursor;
    } catch (err) {
      console.warn('Could not load more saved layouts:', err);
    } finally {
      savedLayoutsLoadMoreBtn.disabled = false;
    }
  });

  // renderVersionHistory() is called from several places in quick
  // succession — the initial render, and again after Publish or after
  // either row's own Set Live resolves — each doing its own network
  // round-trip before touching historyList. Only the button that was
  // clicked gets disabled, so nothing stops a second call (e.g. clicking
  // Set Live on a different row) from starting before an earlier one's
  // response has come back; without a staleness guard, an earlier, slower
  // call's response can land after a later one's and overwrite the DOM
  // with out-of-date version/activeVersionId data. Same monotonic-token
  // fix as friendsLoadToken (#448).
  let versionHistoryLoadToken = 0;
  // The cursor for whatever page comes after the ones currently rendered —
  // null once there's nothing more to load, same shape as
  // notificationsNextCursor (#320) and savedLayoutsNextCursor (#1215).
  // Reset to null every time renderVersionHistory starts a fresh first
  // page; advanced by historyLoadMoreBtn's click handler as later pages
  // come in.
  let versionHistoryNextCursor = null;
  // Set by renderVersionHistory on the initial load; historyLoadMoreBtn's
  // click handler reuses it for later pages rather than re-fetching
  // fetchLandlet on every "Load more" click just to learn the same id again.
  let versionHistoryActiveVersionId = null;

  function appendVersionRow(version, activeVersionId) {
    const row = document.createElement('div');
    row.className = 'version-row';

    const info = document.createElement('div');
    info.className = 'version-row-info';
    const itemWord = version.instanceCount === 1 ? 'item' : 'items';
    const liveTag = version.versionId === activeVersionId ? ' — live' : '';
    info.textContent = `${version.name} — ${version.instanceCount} ${itemWord} — ${new Date(version.createdAt).toLocaleString()}${liveTag}`;
    row.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'version-row-actions';

    const setLiveBtn = document.createElement('button');
    setLiveBtn.type = 'button';
    setLiveBtn.className = 'version-action-btn';
    setLiveBtn.textContent = 'Set Live';
    setLiveBtn.disabled = version.versionId === activeVersionId;
    setLiveBtn.addEventListener('click', async () => {
      setLiveBtn.disabled = true;
      try {
        await activateLandletVersion(landletId, version.versionId);
        // Feedback goes through the shared publishStatus, not a status
        // element inside this row — renderVersionHistory() (below) tears
        // down and rebuilds every row's DOM, including this one, so
        // anything set on a per-row element here would be wiped before
        // ever actually being visible.
        publishStatus.textContent = `Shoppers now see "${version.name}".`;
        publishStatus.classList.remove('error');
        renderVersionHistory();
      } catch (err) {
        publishStatus.textContent = err.message || 'Could not activate.';
        publishStatus.classList.add('error');
        setLiveBtn.disabled = false;
      }
    });
    actions.appendChild(setLiveBtn);

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'version-action-btn';
    restoreBtn.textContent = 'Restore to Editor';
    restoreBtn.addEventListener('click', async () => {
      if (!confirm(`Replace everything currently placed with "${version.name}"? This saves its own version first, so it's reversible, but everything since your last save will be gone from the live editor.`)) return;
      restoreBtn.disabled = true;
      publishStatus.textContent = 'Restoring…';
      publishStatus.classList.remove('error');
      try {
        const full = await fetchLandletVersion(landletId, version.versionId);
        // #2250: each restore wraps the prior name in this same prefix/
        // suffix, so a chain of restores grows versionName past the
        // server's own MAX_LABEL_LENGTH (100, worker/index.js) and the
        // restore starts failing a 400 that has nothing to do with the
        // instances actually being restored -- this is an auto-generated
        // label the user never typed, so truncate it rather than let the
        // server reject it.
        const wrappedVersionName = `Restored from "${version.name}"`;
        const versionName = wrappedVersionName.length > 100
          ? `${wrappedVersionName.slice(0, 99)}…`
          : wrappedVersionName;
        await replaceLandletDraft(landletId, {
          instances: full.instances,
          versionName,
        });
        clearDraftIdempotencyKey(landletId);
        // Simplest correct way to get the live scene back in sync with
        // whatever the server now holds — the same "something changed
        // server-side, reload" pattern claimBackBtn already uses
        // elsewhere in this file.
        sessionStorage.setItem(START_MODE_KEY, 'build');
        location.reload();
      } catch (err) {
        publishStatus.textContent = err.message || 'Could not restore.';
        publishStatus.classList.add('error');
        restoreBtn.disabled = false;
      }
    });
    actions.appendChild(restoreBtn);

    row.appendChild(actions);
    historyList.appendChild(row);
  }

  async function renderVersionHistory() {
    const myLoadToken = ++versionHistoryLoadToken;
    historyList.innerHTML = '<div class="settings-empty-note">Loading…</div>';
    historyLoadMoreBtn.hidden = true;
    versionHistoryNextCursor = null;
    let versions;
    let activeVersionId;
    let nextCursor;
    try {
      [{ versions, nextCursor }, { activeVersionId }] = await Promise.all([
        fetchLandletVersions(landletId, { limit: 20 }),
        fetchLandlet(landletId),
      ]);
    } catch (err) {
      if (myLoadToken !== versionHistoryLoadToken) return; // superseded while loading — a newer call owns the panel now
      historyList.innerHTML = '';
      const errNote = document.createElement('div');
      errNote.className = 'settings-empty-note';
      errNote.textContent = err.message || 'Could not load version history.';
      historyList.appendChild(errNote);
      return;
    }
    if (myLoadToken !== versionHistoryLoadToken) return; // superseded while loading — a newer call owns the panel now
    historyList.innerHTML = '';
    if (versions.length === 0) {
      historyList.innerHTML = '<div class="settings-empty-note">No versions saved yet — Publish creates the first one.</div>';
      return;
    }
    for (const version of versions) appendVersionRow(version, activeVersionId);
    versionHistoryNextCursor = nextCursor;
    versionHistoryActiveVersionId = activeVersionId;
    historyLoadMoreBtn.hidden = !versionHistoryNextCursor;
  }

  historyLoadMoreBtn.addEventListener('click', async () => {
    const myLoadToken = versionHistoryLoadToken; // this panel's current, already-rendered load — not a fresh reset
    historyLoadMoreBtn.disabled = true;
    try {
      const { versions, nextCursor } = await fetchLandletVersions(landletId, { limit: 20, cursor: versionHistoryNextCursor });
      if (myLoadToken !== versionHistoryLoadToken) return; // panel was reset while this page was loading
      for (const version of versions) appendVersionRow(version, versionHistoryActiveVersionId);
      versionHistoryNextCursor = nextCursor;
      historyLoadMoreBtn.hidden = !versionHistoryNextCursor;
    } catch (err) {
      console.warn('Could not load more versions:', err);
    } finally {
      historyLoadMoreBtn.disabled = false;
    }
  });

  publishBtn.addEventListener('click', async () => {
    publishBtn.disabled = true;
    publishStatus.textContent = 'Publishing…';
    publishStatus.classList.remove('error');
    try {
      const version = await saveLandletVersion(landletId, {});
      clearVersionIdempotencyKey(landletId);
      await activateLandletVersion(landletId, version.versionId);
      publishStatus.textContent = `Published as "${version.name}" — shoppers now see this.`;
      renderVersionHistory();
    } catch (err) {
      publishStatus.textContent = err.message || 'Could not publish.';
      publishStatus.classList.add('error');
    } finally {
      publishBtn.disabled = false;
    }
  });

  renderVersionHistory();
}

// Seller-facing Stripe Connect Custom account onboarding (#452, first leaf
// under #347/#324's real-money payment processing — owner-confirmed
// account type: Custom, meaning Stripe stays entirely invisible to the
// seller and higglehaven builds this form itself, rather than redirecting
// to a Stripe-hosted page). Lives under the Sell settings tab since it's a
// seller-identity concern, not tied to any one landlet the way Build's
// Publish/Auction sections are.
async function renderSellSettingsSection() {
  const myToken = settingsRenderToken;
  renderSellerIdentityField();

  const statusField = document.createElement('div');
  statusField.className = 'settings-field';
  const statusLabel = document.createElement('span');
  statusLabel.textContent = 'Payout Account';
  statusField.appendChild(statusLabel);
  const statusNote = document.createElement('div');
  statusNote.className = 'settings-empty-note';
  statusNote.setAttribute('role', 'status');
  statusNote.setAttribute('aria-live', 'polite');
  statusNote.textContent = 'Loading…';
  statusField.appendChild(statusNote);
  settingsSectionEl.appendChild(statusField);

  const formField = document.createElement('div');
  formField.className = 'settings-field';
  settingsSectionEl.appendChild(formField);

  let account;
  try {
    account = await fetchSellerStripeAccount();
  } catch (err) {
    statusNote.textContent = err.message || 'Could not load your payout account status.';
    statusNote.classList.add('error');
    return;
  }
  // #1732: a tab switch (or modal reopen) during that await already tore
  // down and rebuilt settingsSectionEl for a different tab — the real-money
  // Payouts field below would land there instead of silently vanishing with
  // it, same #905 guard every sibling Settings-tab renderer already has.
  if (myToken !== settingsRenderToken) return;

  function describeStatus() {
    if (!account.configured) {
      return "Stripe payouts aren't set up on this server yet — check back later.";
    }
    if (account.status === 'complete') return 'Your payout account is fully set up.';
    if (account.status === 'requirements_due') {
      return `Stripe needs more information: ${account.requirementsCurrentlyDue.join(', ')}`;
    }
    if (account.status === 'action_needed') return 'Stripe flagged an issue with this account — resubmit below.';
    if (account.connected) return 'Your account was created — verification is pending.';
    return 'Not set up yet. Real-money sales are held until this is complete.';
  }

  statusNote.textContent = describeStatus();
  statusNote.classList.remove('error');

  const fields = [
    ['firstName', 'First name', 'text'],
    ['lastName', 'Last name', 'text'],
    ['dobDay', 'Birth day', 'number'],
    ['dobMonth', 'Birth month', 'number'],
    ['dobYear', 'Birth year', 'number'],
    ['ssnLast4', 'SSN (last 4 digits)', 'text'],
    ['addressLine1', 'Street address', 'text'],
    ['addressCity', 'City', 'text'],
    ['addressState', 'State', 'text'],
    ['addressPostalCode', 'ZIP code', 'text'],
    ['addressCountry', 'Country (2-letter code)', 'text'],
    ['routingNumber', 'Bank routing number', 'text'],
    ['accountNumber', 'Bank account number', 'text'],
  ];
  const inputs = {};
  const form = document.createElement('div');
  form.className = 'stripe-onboarding-form';
  for (const [key, fieldLabel, type] of fields) {
    const label = document.createElement('label');
    label.textContent = fieldLabel;
    const input = document.createElement('input');
    input.type = type;
    if (key === 'addressCountry') input.value = 'US';
    if (key === 'dobMonth') { input.min = '1'; input.max = '12'; }
    if (key === 'dobDay') { input.min = '1'; input.max = '31'; }
    label.appendChild(input);
    form.appendChild(label);
    inputs[key] = input;
  }
  // #1940: same dobDay/dobMonth sync as the sibling seller-payout form.
  function refreshDobDayMax() {
    const month = parseInt(inputs.dobMonth.value, 10);
    const year = parseInt(inputs.dobYear.value, 10);
    if (!Number.isFinite(month) || month < 1 || month > 12) return;
    inputs.dobDay.max = String(daysInMonth(Number.isFinite(year) ? year : new Date().getUTCFullYear(), month));
  }
  inputs.dobMonth.addEventListener('input', refreshDobDayMax);
  inputs.dobYear.addEventListener('input', refreshDobDayMax);
  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'version-action-btn';
  submitBtn.textContent = account.connected ? 'Update payout account' : 'Set up payout account';
  form.appendChild(submitBtn);
  const formStatus = document.createElement('div');
  formStatus.className = 'settings-empty-note';
  form.appendChild(formStatus);

  submitBtn.addEventListener('click', async () => {
    formStatus.textContent = '';
    formStatus.classList.remove('error');
    submitBtn.disabled = true;
    try {
      account = await submitSellerStripeAccount({
        individual: {
          firstName: inputs.firstName.value,
          lastName: inputs.lastName.value,
          dobDay: Number(inputs.dobDay.value),
          dobMonth: Number(inputs.dobMonth.value),
          dobYear: Number(inputs.dobYear.value),
          ssnLast4: inputs.ssnLast4.value,
          addressLine1: inputs.addressLine1.value,
          addressCity: inputs.addressCity.value,
          addressState: inputs.addressState.value,
          addressPostalCode: inputs.addressPostalCode.value,
          addressCountry: inputs.addressCountry.value,
        },
        externalAccount: {
          routingNumber: inputs.routingNumber.value,
          accountNumber: inputs.accountNumber.value,
          currency: 'usd',
        },
      });
      // #1373: the Payouts field (balance + Cash out button) below only
      // ever gets built once, gated on account.connected as it stood at
      // this function's own initial render -- a first-time submit flips
      // account.connected from false to true right here, but nothing
      // re-evaluates that gate afterward, so the field (and the
      // "Update payout account" relabel) never appeared until the tab was
      // closed and reopened. Same renderSettingsSection() full-redraw
      // idiom #1124/#1346 already use for this exact "a mutation here
      // should refresh what a sibling/gated block shows" shape.
      renderSettingsSection();
      return;
    } catch (err) {
      formStatus.textContent = err.message || 'Could not submit — check the fields above.';
      formStatus.classList.add('error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  formField.appendChild(form);

  // #454: only meaningful once an account actually exists to hold a
  // balance against — Stripe stays entirely invisible to the seller
  // otherwise (#452's own mandate), same reasoning as the status field
  // above gating on account.connected implicitly via describeStatus().
  if (account.connected) {
    const payoutsField = document.createElement('div');
    payoutsField.className = 'settings-field';
    const payoutsLabel = document.createElement('span');
    payoutsLabel.textContent = 'Payouts';
    payoutsField.appendChild(payoutsLabel);
    const payoutsNote = document.createElement('div');
    payoutsNote.className = 'settings-empty-note';
    payoutsNote.textContent = 'Loading…';
    payoutsField.appendChild(payoutsNote);
    const cashOutBtn = document.createElement('button');
    cashOutBtn.type = 'button';
    cashOutBtn.className = 'version-action-btn';
    cashOutBtn.textContent = 'Cash out';
    cashOutBtn.hidden = true;
    payoutsField.appendChild(cashOutBtn);
    settingsSectionEl.appendChild(payoutsField);

    async function refreshPayouts() {
      try {
        const payouts = await fetchSellerPayouts();
        const parts = [`Available to cash out: ${formatPriceCents(payouts.availableCents)}`];
        if (payouts.heldCents > 0) parts.push(`Held: ${formatPriceCents(payouts.heldCents)}`);
        if (payouts.nextEligibleAt) parts.push(`Next eligible: ${new Date(payouts.nextEligibleAt).toLocaleDateString()}`);
        payoutsNote.textContent = parts.join(' · ');
        payoutsNote.classList.remove('error');
        cashOutBtn.hidden = payouts.availableCents <= 0;
      } catch (err) {
        payoutsNote.textContent = err.message || 'Could not load your payout balance.';
        payoutsNote.classList.add('error');
      }
    }

    cashOutBtn.addEventListener('click', async () => {
      cashOutBtn.disabled = true;
      try {
        await requestSellerPayout();
        await refreshPayouts();
        alert('Payout requested.');
      } catch (err) {
        alert(err.message || 'Could not request a payout.');
      } finally {
        cashOutBtn.disabled = false;
      }
    });

    await refreshPayouts();
  }
}

// #1940: the Stripe-onboarding dobDay input's own max was a fixed 31
// regardless of dobMonth -- Feb 30, Apr 31, etc. passed client validation.
// new Date(Date.UTC(year, month, 0)) is day 0 of the following month, i.e.
// the last real day of `month` (1-indexed, matching dobMonth's own values).
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// #1492: used to build the string manually via a template literal, which
// never inserts a thousands separator -- unlike formatDollarsForPriceInput
// below, the one money formatter in this file that already used
// toLocaleString. A real amount like TAX_REPORTING_THRESHOLD_CENTS
// ($20,000) rendered as "$20000.00".
export function formatHiggles(cents) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// A catalog template's own priceCents (docs/API.md's "Catalog templates")
// is a real-world USD price a shopper would pay for the product — a
// distinct concept from higgles (the platform's internal commission
// currency, formatHiggles above) even though the cents-to-dollars math is
// identical, so this stays its own named helper rather than reusing that
// one.
// Exported for src/catalog/upload.js (#2557) -- its own
// handleUploadDimensionsStep needs this same formatter for its price-ceiling
// error message.
export function formatPriceCents(cents) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// N50: the price fields (upload wizard + Seller "Edit Price") let the
// seller type a price in whatever format they like — plain digits, a
// leading $, thousands commas — and reformat it to a consistent
// "$123,456.78" display once they leave the field, rather than forcing a
// bare-number native <input type=number> with an "e.g. 12.99" placeholder.
// Parsing strips the cosmetic $/, characters back out so the existing
// submit-time validation still sees a plain number.
// Exported for src/catalog/upload.js (#2557) -- its own upload-price field
// needs these same two parse/format helpers, per this comment's own note
// above ("the price fields (upload wizard + Seller Edit Price)").
export function parsePriceInputDollars(raw) {
  const cleaned = String(raw).trim().replace(/[$,]/g, '');
  return cleaned === '' ? NaN : Number(cleaned);
}
export function formatDollarsForPriceInput(dollars) {
  return dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// Mirrors worker/index.js's own DIGITAL_GOOD_DISCLAIMER_TEXT (docs/SPEC.md
// §4's "clear higglehaven-controlled disclaimer") — kept as a second copy
// here rather than fetched from the server, since it's small, static, and
// needed synchronously while building each seller-row's DOM. Keep the full
// sentences, not an abbreviation: this same constant backs productInfoText's
// shopper-facing disclaimer (the actual compliance surface this section of
// spec is about), not just the seller-panel dropdown label below.
// Exported for src/sell/mode.js (#2647) -- its own digital-good save panel
// needs this same lookup; genuinely shared beyond Sell mode (Shop's own
// product display reads it too), so it stays here rather than moving.
export const DIGITAL_GOOD_DISCLAIMER_TEXT = {
  'gift-card': 'This is a digital gift card to a real business, delivered as a code — not a physical item.',
  'art-file': 'This is a digital art or print file, delivered as a download — not a physical item.',
  'software-tool': 'This is a higglehaven-ecosystem software tool, delivered as a download or activation — not a physical item.',
  'avatar-model': 'This is an avatar model, delivered as an equippable item — not a physical item.',
};

function formatAuctionTimeRemaining(isoString) {
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms <= 0) return 'ending soon';
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  return hours >= 1 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
}

function formatAuctionSummary(auction) {
  const bidText = auction.highestBidCents !== null
    ? `high bid ${formatHiggles(auction.highestBidCents)} (${auction.bidCount} bid${auction.bidCount === 1 ? '' : 's'})`
    : `no bids yet, starts at ${formatHiggles(auction.startingBidCents)}`;
  const outcomeText = auction.startingBidCents === 0
    ? 'free to the highest bidder, or released if unsold'
    : `stays yours at ${formatHiggles(auction.startingBidCents)} if unsold`;
  return `${auction.landletId} — ${bidText} — ${formatAuctionTimeRemaining(auction.endsAt)} — ${outcomeText}`;
}

// Land acquisition auctions (docs/SPEC.md §5, docs/API.md's "Land
// acquisition auctions") — lives in the Build settings tab, alongside Land
// Cap (#197: auctioning a landlet is a Build-mode concern, not a Sell one,
// per the project owner directly). Covers both starting a voluntary
// auction on whatever landlet this identity currently owns and
// browsing/bidding on every other active auction in the world — the
// latter isn't tied to currentLandletId, so it still renders here even
// outside an active Build session, same as Land Cap above it.
async function renderAuctionSection() {
  const myToken = settingsRenderToken;
  // Same Shop-mode-opened-Settings gap as renderLandCapField above — an
  // already-logged-in visitor can still have a null builderId simply
  // because nothing's called ensureBuilderIdentity() yet this session.
  // Establish it silently (no login prompt, since requireLogin short-
  // circuits on an existing currentAuthUser) rather than showing a
  // "choose an identity" dead end to someone who already has one.
  if (!builderId && currentAuthUser) setBuilderId(await ensureBuilderIdentity());
  // #905: see renderLandCapField's own comment — a tab switch/modal reopen
  // during that await already tore down settingsSectionEl for a different
  // tab, so this section (with a live "Start Auction" button) must not
  // land there.
  if (myToken !== settingsRenderToken) return;
  if (!builderId) {
    const note = document.createElement('div');
    note.className = 'settings-empty-note';
    note.textContent = 'Choose a builder identity to start or bid on an auction.';
    settingsSectionEl.appendChild(note);
    return;
  }

  const startField = document.createElement('div');
  startField.className = 'settings-field';
  const startLabel = document.createElement('span');
  startLabel.textContent = 'Sell Your Lándlet';
  startField.appendChild(startLabel);
  const startStatus = document.createElement('div');
  startStatus.className = 'settings-empty-note';
  startField.appendChild(startStatus);
  settingsSectionEl.appendChild(startField);

  const listField = document.createElement('div');
  listField.className = 'settings-field';
  const listLabel = document.createElement('span');
  listLabel.textContent = 'Active Auctions';
  listField.appendChild(listLabel);
  const auctionList = document.createElement('div');
  auctionList.className = 'auction-list';
  listField.appendChild(auctionList);
  settingsSectionEl.appendChild(listField);

  // Guards against the picker's `change` handler firing renderForLandlet
  // again before a previous call's own fetchAuctions round-trip has
  // resolved (#442) — without this, switching the picker quickly (A→B, or
  // A→B→A) races two async renders over the same shared startField/
  // startStatus DOM nodes, and whichever fetch happens to resolve last
  // wins regardless of which landlet is actually selected by then. Bumped
  // at the start of every call; a call whose token has been superseded by
  // a newer one bails out without touching the DOM once its await
  // returns, the same generation-counter idiom #424/#425 already use for
  // this exact race shape elsewhere in Settings.
  let landletRenderToken = 0;

  async function renderForLandlet(landletId) {
    const myToken = ++landletRenderToken;
    startStatus.textContent = '';
    startStatus.classList.remove('error');
    for (const el of startField.querySelectorAll('.auction-start-form, .auction-row')) el.remove();
    let activeForMine;
    try {
      activeForMine = await fetchAuctions({ status: 'active', landletId });
    } catch (err) {
      if (myToken !== landletRenderToken) return;
      startStatus.textContent = err.message || 'Could not check for an existing auction.';
      startStatus.classList.add('error');
      return;
    }
    if (myToken !== landletRenderToken) return;
    if (activeForMine.length > 0) {
      const row = document.createElement('div');
      // #2607: also carries auction-row-mine -- the sibling Active Auctions
      // list (buildAuctionRow, below) renders plain .auction-row elements
      // for every site-wide active auction, so .auction-row alone no longer
      // uniquely identifies this picker's own "your auction is live" row.
      row.className = 'auction-row auction-row-mine';
      const info = document.createElement('div');
      info.className = 'auction-row-info';
      info.textContent = `Your auction is live — ${formatAuctionSummary(activeForMine[0])}`;
      row.appendChild(info);
      startField.appendChild(row);
      return;
    }

    startStatus.textContent = 'A $0 starting bid gives it away free if nobody bids; any other amount keeps it yours if it goes unsold.';
    const form = document.createElement('div');
    form.className = 'auction-start-form';
    const bidLabel = document.createElement('label');
    bidLabel.textContent = 'Starting bid ($)';
    const bidInput = document.createElement('input');
    bidInput.type = 'number';
    bidInput.min = '0';
    bidInput.step = '0.01';
    bidInput.value = '0';
    bidLabel.appendChild(bidInput);
    form.appendChild(bidLabel);
    const durationLabel = document.createElement('label');
    durationLabel.textContent = 'Duration (hours)';
    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.min = '1';
    durationInput.max = '8760';
    durationInput.step = '1';
    durationInput.value = '24';
    durationLabel.appendChild(durationInput);
    form.appendChild(durationLabel);
    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'auction-start-btn';
    startBtn.textContent = 'Start Auction';
    startBtn.addEventListener('click', async () => {
      const dollars = Number(bidInput.value);
      const hours = Number(durationInput.value);
      if (!Number.isFinite(dollars) || dollars < 0) {
        startStatus.textContent = 'Starting bid must be zero or more.';
        startStatus.classList.add('error');
        return;
      }
      if (Math.round(dollars * 100) > MAX_MONEY_CENTS) {
        startStatus.textContent = `Starting bid must be ${formatHiggles(MAX_MONEY_CENTS)} or less.`;
        startStatus.classList.add('error');
        return;
      }
      if (!Number.isFinite(hours) || hours < 1) {
        startStatus.textContent = 'Duration must be at least 1 hour.';
        startStatus.classList.add('error');
        return;
      }
      // #1922: mirrors the server's own cap (worker/index.js's handleAuctions
      // POST, "durationHours must be 8760 (one year) or fewer") -- without
      // this, an unusually large value passes client validation and
      // surfaces that raw server message instead of a friendly one.
      if (hours > 8760) {
        startStatus.textContent = 'Duration must be 8760 hours (one year) or fewer.';
        startStatus.classList.add('error');
        return;
      }
      startBtn.disabled = true;
      try {
        await startAuction(landletId, {
          startingBidCents: Math.round(dollars * 100),
          durationHours: Math.round(hours),
        });
        await renderForLandlet(landletId);
        await renderAuctionList();
      } catch (err) {
        startStatus.textContent = err.message || 'Could not start the auction.';
        startStatus.classList.add('error');
        startBtn.disabled = false;
      }
    });
    form.appendChild(startBtn);
    startField.appendChild(form);
  }

  async function renderStartSection() {
    startStatus.textContent = '';
    startStatus.classList.remove('error');
    for (const el of startField.querySelectorAll('.auction-start-form, .auction-row, .landlet-picker')) el.remove();
    let owned;
    try {
      // fetchAllLandlets pages through every one of this builder's owned
      // landlets, not just fetchLandlets's own first 100-per-page limit
      // (#186's own shape). Needed here too now that #199 lets a seller
      // hold two simultaneously-claimed landlets (starting a $0 auction,
      // or getting a first bid on any starting amount, frees the claim
      // lock immediately rather than waiting for resolution) — "exactly
      // one owned landlet" is no longer a safe assumption (#249).
      owned = await fetchAllLandlets({ status: 'claimed', ownerBuilderId: builderId });
    } catch (err) {
      startStatus.textContent = err.message || 'Could not check your lándlets.';
      startStatus.classList.add('error');
      return;
    }
    if (owned.length === 0) {
      startStatus.textContent = 'Claim a lándlet first to auction it off.';
      return;
    }

    // Per the owner's own #249 product call: a picker across every
    // claimed landlet the builder owns, defaulting to whichever one
    // they're currently in Build mode on (falling back to the first
    // owned landlet when that one isn't in this list at all — e.g.
    // Settings opened from Shop mode with no Build-mode landlet active).
    let selectedLandletId = owned.some((l) => l.landletId === currentLandletId)
      ? currentLandletId
      : owned[0].landletId;

    if (owned.length > 1) {
      const pickerRow = document.createElement('div');
      pickerRow.className = 'landlet-picker';
      const pickerLabel = document.createElement('label');
      pickerLabel.textContent = 'Lándlet';
      const picker = document.createElement('select');
      for (const landlet of owned) {
        const option = document.createElement('option');
        option.value = landlet.landletId;
        option.textContent = landlet.name || landlet.landletId;
        if (landlet.landletId === selectedLandletId) option.selected = true;
        picker.appendChild(option);
      }
      picker.addEventListener('change', () => {
        selectedLandletId = picker.value;
        renderForLandlet(selectedLandletId);
      });
      pickerLabel.appendChild(picker);
      pickerRow.appendChild(pickerLabel);
      startField.appendChild(pickerRow);
    }

    await renderForLandlet(selectedLandletId);
  }

  // #2016: each row's own bid button only disables itself (see its click
  // handler below), not the whole panel or any other row — so a bid on
  // row A and a bid on row B can both be in flight at once, each
  // triggering its own renderAuctionList() call. Without this guard,
  // whichever fetchAllAuctions() round-trip happens to resolve last wins
  // regardless of which bid was actually placed most recently, the same
  // "slower, earlier-issued fetch lands after a faster, newer one" race
  // landletRenderToken already guards against for renderForLandlet just
  // above.
  let auctionListLoadToken = 0;

  async function renderAuctionList() {
    const myToken = ++auctionListLoadToken;
    auctionList.innerHTML = '<div class="settings-empty-note">Loading…</div>';
    let auctions;
    try {
      // The world's full active-auction list, not one landlet's own — use
      // the paginating fetch so this doesn't silently truncate past 100
      // simultaneously active auctions (#190, same shape as #186).
      auctions = await fetchAllAuctions({ status: 'active' });
    } catch (err) {
      if (myToken !== auctionListLoadToken) return;
      auctionList.innerHTML = '';
      const errNote = document.createElement('div');
      errNote.className = 'settings-empty-note';
      errNote.textContent = err.message || 'Could not load auctions.';
      auctionList.appendChild(errNote);
      return;
    }
    if (myToken !== auctionListLoadToken) return;
    auctionList.innerHTML = '';
    if (auctions.length === 0) {
      auctionList.innerHTML = '<div class="settings-empty-note">No active auctions right now.</div>';
      return;
    }
    for (const auction of auctions) {
      auctionList.appendChild(buildAuctionRow(auction));
    }
  }

  // Split out of renderAuctionList so a single row can be re-fetched and
  // swapped in place (see the Refresh button below) without re-rendering
  // — and re-requesting bid history for — every other row in the list.
  function buildAuctionRow(auction) {
    const row = document.createElement('div');
    row.className = 'auction-row';
    const info = document.createElement('div');
    info.className = 'auction-row-info';
    info.textContent = formatAuctionSummary(auction);
    row.appendChild(info);

    // Single-auction detail refetch (fetchAuction, #733) — a per-row
    // way to see this one auction's own current status/highest bid
    // without waiting for or triggering the full-list refresh already
    // used after placeBid/resolveAuctionNow below.
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'auction-refresh-btn';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      try {
        const updated = await fetchAuction(auction.auctionId);
        row.replaceWith(buildAuctionRow(updated));
      } catch (err) {
        alert(err.message || 'Could not refresh this auction.');
        refreshBtn.disabled = false;
      }
    });
    row.appendChild(refreshBtn);

    // Bid history — GET /auctions already gives every row its own
    // bidCount (auctionsFromRowsBatch), so this button only renders once
    // there's actually something to show. The full per-bid list
    // (amount, bidder, timestamp) itself is fetched lazily via
    // fetchAuctionBids on first expand, not eagerly for every row in the
    // list — same "don't fetch what nobody asked to see yet" shape as
    // the rest of this settings panel.
    if (auction.bidCount > 0) {
      const bidHistoryToggle = document.createElement('button');
      bidHistoryToggle.type = 'button';
      bidHistoryToggle.className = 'auction-bid-history-btn';
      bidHistoryToggle.textContent = `View Bids (${auction.bidCount})`;
      const bidHistoryList = document.createElement('div');
      bidHistoryList.className = 'auction-bid-history';
      bidHistoryList.hidden = true;
      bidHistoryToggle.addEventListener('click', async () => {
        if (!bidHistoryList.hidden) {
          bidHistoryList.hidden = true;
          bidHistoryToggle.textContent = `View Bids (${auction.bidCount})`;
          return;
        }
        bidHistoryToggle.disabled = true;
        bidHistoryList.hidden = false;
        bidHistoryList.innerHTML = '<div class="settings-empty-note">Loading…</div>';
        try {
          const { bids, totalCount } = await fetchAuctionBids(auction.auctionId);
          // Bidder labels resolved via the batch-by-ids lookup (#717/
          // #720), scoped to just the distinct bidders on this one
          // auction rather than the whole roster.
          const labels = new Map(
            (await fetchBuildersByIds(bids.map((bid) => bid.bidderBuilderId)))
              .map((b) => [b.builderId, b.label]),
          );
          bidHistoryList.innerHTML = '';
          // Already highest-first from the server (ORDER BY amount_cents
          // DESC, created_at in handleAuctionBids) — no client-side sort
          // needed.
          for (const bid of bids) {
            const bidRow = document.createElement('div');
            bidRow.className = 'auction-bid-history-row';
            const label = labels.get(bid.bidderBuilderId) || 'an unknown builder';
            bidRow.textContent = `${formatHiggles(bid.amountCents)} — ${label} — ${new Date(bid.createdAt).toLocaleString()}`;
            bidHistoryList.appendChild(bidRow);
          }
          // #1275: the server caps this list at 200 rows — flag it when
          // that cap actually bites, instead of silently showing a
          // partial list under a "Hide Bids (N)" label that implies it's
          // everything.
          if (totalCount > bids.length) {
            const truncationNote = document.createElement('div');
            truncationNote.className = 'settings-empty-note';
            truncationNote.textContent = `Showing top ${bids.length} of ${totalCount} bids.`;
            bidHistoryList.appendChild(truncationNote);
          }
          bidHistoryToggle.textContent = `Hide Bids (${auction.bidCount})`;
        } catch (err) {
          bidHistoryList.innerHTML = '';
          const errNote = document.createElement('div');
          errNote.className = 'settings-empty-note';
          errNote.textContent = err.message || 'Could not load bid history.';
          bidHistoryList.appendChild(errNote);
        } finally {
          bidHistoryToggle.disabled = false;
        }
      });
      row.appendChild(bidHistoryToggle);
      row.appendChild(bidHistoryList);
    }

    // GET /auctions already resolves anything past its end time before
    // this list is built (see resolveDueAuctions in worker/index.js) —
    // this button exists only for the narrow gap between that moment
    // and the *next* fetch, e.g. a second tab that loaded the list a
    // moment before this one's own timer ran out. Anyone can trigger
    // it; resolution is an objective time-based fact, not a seller- or
    // bidder-specific action.
    const isPastDue = new Date(auction.endsAt).getTime() <= Date.now();
    if (isPastDue) {
      const resolveBtn = document.createElement('button');
      resolveBtn.type = 'button';
      resolveBtn.className = 'auction-resolve-btn';
      resolveBtn.textContent = 'Resolve Now';
      resolveBtn.addEventListener('click', async () => {
        resolveBtn.disabled = true;
        try {
          await resolveAuctionNow(auction.auctionId);
          // #1346: resolution happens synchronously server-side, before
          // this await returns -- it credits the seller's higgles balance
          // and transfers the landlet immediately, the exact figures Land
          // Cap/Redeem Higgles display. Those are sibling fields with their
          // own fetch, not refreshed by renderAuctionList/renderStartSection
          // below. Same #1124 idiom (a full renderSettingsSection() redraw,
          // the same thing a manual tab switch already triggers) rather
          // than patching only this section's own calls.
          renderSettingsSection();
          return;
        } catch (err) {
          alert(err.message || 'Could not resolve this auction.');
          resolveBtn.disabled = false;
        }
      });
      row.appendChild(resolveBtn);
    } else if (auction.sellerBuilderId !== builderId) {
      // A seller doesn't bid on their own listing — same row, just no
      // bid form, rather than a disabled one (nothing useful to type
      // into it).
      const form = document.createElement('div');
      form.className = 'auction-row-bid-form';
      const minCents = auction.highestBidCents !== null ? auction.highestBidCents + 1 : auction.startingBidCents;
      const bidInput = document.createElement('input');
      bidInput.type = 'number';
      bidInput.className = 'auction-row-bid-input';
      bidInput.min = (minCents / 100).toFixed(2);
      bidInput.step = '0.01';
      bidInput.placeholder = `${formatHiggles(minCents)}+`;
      form.appendChild(bidInput);
      const bidBtn = document.createElement('button');
      bidBtn.type = 'button';
      bidBtn.className = 'auction-bid-btn';
      bidBtn.textContent = 'Place Bid';
      bidBtn.addEventListener('click', async () => {
        const dollars = Number(bidInput.value);
        if (!Number.isFinite(dollars) || dollars < 0) {
          alert('Enter a bid amount of zero or more.');
          return;
        }
        const amountCents = Math.round(dollars * 100);
        if (amountCents > MAX_MONEY_CENTS) {
          alert(`Enter a bid of ${formatHiggles(MAX_MONEY_CENTS)} or less.`);
          return;
        }
        if (amountCents < minCents) {
          alert(`Enter a bid of at least ${formatHiggles(minCents)}.`);
          return;
        }
        bidBtn.disabled = true;
        try {
          await placeBid(auction.auctionId, { amountCents });
          await renderAuctionList();
          await renderStartSection();
        } catch (err) {
          alert(err.message || 'Could not place bid.');
          bidBtn.disabled = false;
        }
      });
      form.appendChild(bidBtn);
      row.appendChild(form);
    }
    return row;
  }

  renderStartSection();
  renderAuctionList();
}

// #1949 (sub-issue of #1947): a builder-wide list of their own placed
// products carrying finite stock, each annotated with the server's own
// estimated days-remaining figure -- same "builder-wide, independent of
// which/any landlet is active" placement as renderAuctionSection just
// above, filterable client-side by remaining quantity and/or days
// remaining the same way the catalog picker's own search box filters
// already-fetched tiles (filterCatalogTiles) rather than re-fetching per
// keystroke.
async function renderLowStockSection() {
  const myToken = settingsRenderToken;
  if (!builderId && currentAuthUser) setBuilderId(await ensureBuilderIdentity());
  if (myToken !== settingsRenderToken) return;
  if (!builderId) {
    const note = document.createElement('div');
    note.className = 'settings-empty-note';
    note.textContent = 'Choose a builder identity to see which of your placed products are low on stock.';
    settingsSectionEl.appendChild(note);
    return;
  }

  const field = document.createElement('div');
  field.className = 'settings-field';
  const label = document.createElement('span');
  label.textContent = 'Low Stock';
  field.appendChild(label);

  const filterRow = document.createElement('div');
  filterRow.className = 'low-stock-filter-row';
  const qtyLabel = document.createElement('label');
  qtyLabel.textContent = 'Max remaining';
  const qtyInput = document.createElement('input');
  qtyInput.type = 'number';
  qtyInput.min = '0';
  qtyInput.placeholder = 'Any';
  qtyInput.className = 'low-stock-filter-input';
  // #1950: restores whatever threshold was active last time this section
  // was rendered -- without this, merely reopening Settings (or switching
  // tabs and back) would reset the inputs to blank and silently clear the
  // in-world highlight these drive, even though the builder never asked
  // for that.
  qtyInput.value = lowStockFilterMaxQty == null ? '' : String(lowStockFilterMaxQty);
  qtyLabel.appendChild(qtyInput);
  filterRow.appendChild(qtyLabel);
  const daysLabel = document.createElement('label');
  daysLabel.textContent = 'Max days remaining';
  const daysInput = document.createElement('input');
  daysInput.type = 'number';
  daysInput.min = '0';
  daysInput.placeholder = 'Any';
  daysInput.className = 'low-stock-filter-input';
  daysInput.value = lowStockFilterMaxDays == null ? '' : String(lowStockFilterMaxDays);
  daysLabel.appendChild(daysInput);
  filterRow.appendChild(daysLabel);
  field.appendChild(filterRow);

  const list = document.createElement('div');
  list.className = 'low-stock-list';
  field.appendChild(list);
  const empty = document.createElement('div');
  empty.className = 'settings-empty-note';
  field.appendChild(empty);
  settingsSectionEl.appendChild(field);

  // A days-remaining threshold only ever excludes a row that actually has a
  // number -- 'unpredictable'/'notEnoughData' rows (daysRemaining: null)
  // have nothing to compare against a numeric threshold, so they stay
  // filtered out once that threshold is set rather than matching by
  // accident on a missing value.
  function applyFilter() {
    const maxQty = qtyInput.value === '' ? null : Number(qtyInput.value);
    const maxDays = daysInput.value === '' ? null : Number(daysInput.value);
    setLowStockFilterMaxQty(maxQty);
    setLowStockFilterMaxDays(maxDays);
    let anyVisible = false;
    const matchingTemplateIds = new Set();
    for (const row of list.children) {
      const qty = Number(row.dataset.stockQuantity);
      const days = row.dataset.daysRemaining === '' ? null : Number(row.dataset.daysRemaining);
      const matchesQty = maxQty == null || qty <= maxQty;
      const matchesDays = maxDays == null || (days != null && days <= maxDays);
      const matches = matchesQty && matchesDays;
      row.hidden = !matches;
      if (matches) {
        anyVisible = true;
        matchingTemplateIds.add(row.dataset.templateId);
      }
    }
    empty.hidden = list.children.length === 0 || anyVisible;
    empty.textContent = list.children.length === 0
      ? 'None of your placed products carry finite stock yet.'
      : 'No placed products match this filter.';
    // #1950: only an actually-set threshold counts as "the filter is
    // active" -- the unfiltered full list (both inputs still "Any")
    // highlights nothing in the 3D view, matching the issue's own
    // "matching the active filter" wording rather than highlighting every
    // finite-stock item by default.
    updateLowStockHighlights((maxQty != null || maxDays != null) ? matchingTemplateIds : null);
  }
  qtyInput.addEventListener('input', applyFilter);
  daysInput.addEventListener('input', applyFilter);

  let templates;
  try {
    templates = await fetchLowStock();
  } catch (err) {
    if (myToken !== settingsRenderToken) return;
    empty.hidden = false;
    empty.textContent = err.message || 'Could not load low-stock products.';
    return;
  }
  if (myToken !== settingsRenderToken) return;

  for (const t of templates) {
    const row = document.createElement('div');
    row.className = 'low-stock-row';
    row.dataset.templateId = t.templateId;
    row.dataset.stockQuantity = String(t.stockQuantity);
    row.dataset.daysRemaining = t.daysRemaining == null ? '' : String(t.daysRemaining);
    const info = document.createElement('div');
    info.className = 'low-stock-row-info';
    const countLabel = t.placedInstanceCount === 1 ? '1 placed' : `${t.placedInstanceCount} placed`;
    const stockLabel = t.stockQuantity === 1 ? '1 left (one-of-a-kind)' : `${t.stockQuantity} left`;
    let estimateLabel;
    if (t.predictability === 'unpredictable') estimateLabel = 'hard to predict';
    else if (t.predictability === 'notEnoughData') estimateLabel = 'not enough data yet';
    else if (t.predictability === 'estimatedFromCategory') estimateLabel = `~${t.daysRemaining}d left (est. from similar products)`;
    else estimateLabel = `~${t.daysRemaining}d left`;
    info.textContent = `"${t.name}" — ${stockLabel}, ${countLabel} — ${estimateLabel}`;
    row.appendChild(info);
    list.appendChild(row);
  }
  applyFilter();
}

// #2068 (leaf sub-issue of #1973/#1947, owner requirement): "On the build
// screen looking at their land, they should be able to toggle on/off
// grayed-out items that have disappeared which they haven't dismissed
// yet." Unlike renderLowStockSection above (which decorates an already-
// placed, still-live mesh), a sold-out marker has no live instance left to
// attach to -- each one gets its own standalone ghost box at its own
// recorded position instead. Landlet-scoped (fetchSoldOutMarkers takes
// currentLandletId), not a cross-landlet "mine" list, since a marker's x/y
// only mean anything inside the one landlet's own scene.
async function renderSoldOutMarkersSection() {
  const myToken = settingsRenderToken;
  if (currentMode !== 'build' || !currentLandletId) return;

  const field = document.createElement('div');
  field.className = 'settings-field';
  const label = document.createElement('span');
  label.textContent = 'Sold-out markers';
  field.appendChild(label);

  const toggleRow = document.createElement('label');
  toggleRow.className = 'sold-out-marker-toggle-row';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.id = 'sold-out-marker-toggle';
  toggle.checked = showSoldOutMarkers;
  toggleRow.appendChild(toggle);
  toggleRow.appendChild(document.createTextNode(' Show grayed-out markers where sold-out items used to be'));
  field.appendChild(toggleRow);

  const list = document.createElement('div');
  list.className = 'sold-out-marker-list';
  field.appendChild(list);
  const empty = document.createElement('div');
  empty.className = 'settings-empty-note';
  field.appendChild(empty);
  settingsSectionEl.appendChild(field);

  toggle.addEventListener('change', () => {
    setShowSoldOutMarkers(toggle.checked);
    applySoldOutMarkerVisibility();
  });

  let markers;
  try {
    markers = await fetchSoldOutMarkers(currentLandletId);
  } catch (err) {
    if (myToken !== settingsRenderToken) return;
    empty.hidden = false;
    empty.textContent = err.message || 'Could not load sold-out markers.';
    return;
  }
  if (myToken !== settingsRenderToken) return;

  setSoldOutMarkers(markers);
  applySoldOutMarkerVisibility();
  empty.hidden = markers.length > 0;
  empty.textContent = 'Nothing sold out on this land yet.';

  for (const marker of markers) {
    const row = document.createElement('div');
    row.className = 'sold-out-marker-row';
    row.dataset.markerId = marker.markerId;
    const info = document.createElement('div');
    info.className = 'sold-out-marker-row-info';
    info.textContent = `"${marker.templateName}" sold out`;
    row.appendChild(info);
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'sold-out-marker-row-dismiss';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', async () => {
      dismissBtn.disabled = true;
      try {
        await dismissSoldOutMarker(currentLandletId, marker.markerId);
        setSoldOutMarkers(soldOutMarkers.filter((m) => m.markerId !== marker.markerId));
        removeSoldOutMarkerMesh(marker.markerId);
        row.remove();
        empty.hidden = list.children.length > 0;
      } catch (err) {
        alert(err.message || 'Could not dismiss this marker.');
        dismissBtn.disabled = false;
      }
    });
    row.appendChild(dismissBtn);
    list.appendChild(row);
  }
}

for (const btn of settingsTabsEl.querySelectorAll('.settings-tab-btn')) {
  btn.addEventListener('click', () => {
    activeSettingsTab = btn.dataset.section;
    renderSettingsSection();
  });
}

// Owner (Control Room feedback): "When a user opens the menu, it should
// default to the menu tab of the site tab they're already in (Shop,
// Build, or Sell)." activeSettingsTab used to just persist whatever tab
// was last clicked (starting at 'general'), so opening Settings from
// Build mode after a previous session left it on e.g. Shop showed the
// wrong tab first. currentMode's own values ('shop'/'build'/'sell')
// match the settings-tab-btn dataset values exactly.
function openSettingsModal() {
  if (currentMode === 'shop' || currentMode === 'build' || currentMode === 'sell') {
    activeSettingsTab = currentMode;
  }
  renderSettingsSection();
  settingsModalEl.classList.add('visible');
  openModalA11y(settingsModalEl, closeSettingsModal);
}
function closeSettingsModal() {
  settingsModalEl.classList.remove('visible');
  closeModalA11y(settingsModalEl);
}
settingsBtn.addEventListener('click', openSettingsModal);
settingsCloseBtn.addEventListener('click', closeSettingsModal);
// Only the static unit suffix needs painting at load — updateTrimLengthInput()
// depends on selectedMeshes, declared further below, and no-ops correctly
// (there's nothing selected yet) once that's ready.
for (const el of trimUnitLabelEls) el.textContent = unitSuffix();

// Only one gizmo is ever attached at a time. Showing both simultaneously
// was tried first and rejected: the rotate ring and the translate handles
// can occupy the same screen pixels at some angles/zoom levels, and each
// TransformControls instance hit-tests independently, so a single drag
// could trigger both at once (move AND rotate from one gesture). A mode
// toggle — the same convention Blender/Unity use — avoids that outright.
// #2559: see src/build/scene.js's own comment.
const saveBundleBtn = document.getElementById('save-bundle-item');
// #2560: communitySignBtn/communityCalendarBtn/backupChainBtn and the
// modals they open now live in src/build/metadataModals.js.

// Save Bundle persists the current selection's relative arrangement to the
// backend (see relativeItemsForMeshes) so it can be stamped down again
// later — in a different session, or on a different landlet entirely —
// rather than only living in this session's in-memory clipboard the way an
// ordinary Copy does.
saveBundleBtn.addEventListener('click', async () => {
  if (selectedMeshes.size === 0) return;
  const meshes = [...selectedMeshes];
  const name = prompt('Name this bundle', '');
  if (!name || !name.trim()) return;
  if (name.trim().length > 100) {
    alert('Keep it to 100 characters or fewer.');
    return;
  }
  // Private by default (docs/SPEC.md's Bundles section) — sharing is an
  // explicit extra step, not the default, so a plain confirm() dialog
  // (declined by default on most platforms) rather than folding it into
  // the name prompt itself.
  const shared = confirm('Share this bundle to the Community tab so any builder can use it too?');
  saveBundleBtn.disabled = true;
  try {
    const bundle = await createBundle({ name: name.trim(), items: relativeItemsForMeshes(meshes), shared });
    // #1831: bumps bundlePickerLoadToken so this local, already-up-to-date
    // mutation can't later be clobbered by a slower, now-stale concurrent
    // fetch (e.g. Build mode's own deferred initial bundles load) landing
    // after and overwriting it — same guard rename/share/delete already use.
    bumpBundlePickerLoadToken();
    myBundles.unshift(bundle);
    // #1873: read the server's own `bundle.shared`, not the local `shared`
    // variable this click computed -- on a same-key resubmit after a lost
    // response with a different sharing answer, the server may have
    // returned a stale row whose actual `shared` column disagrees with
    // what this click just asked for.
    if (bundle.shared) communityBundles.unshift(bundle);
    renderBundlePicker();
    const count = meshes.length;
    setProductInfo(`Saved "${bundle.name}" (${count} item${count === 1 ? '' : 's'})`);
    setTimeout(updateSelectionUI, 1200);
  } catch (err) {
    console.error('Could not save bundle:', err);
    setProductInfo(err.message || 'Could not save bundle.');
  } finally {
    saveBundleBtn.disabled = false;
  }
});

// #2560: the sign-post/calendar-event/backup-chain metadata modals
// now live in src/build/metadataModals.js -- see that module's own
// comment for its dependency notes.

// #2559: see src/build/scene.js's own comment.
renderer.domElement.addEventListener('click', (event) => {
  if (pointerDownPos) {
    const dx = event.clientX - pointerDownPos.x;
    const dy = event.clientY - pointerDownPos.y;
    if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) return;
  }
  // Any genuine tap into the world — whether it selects a product or hits
  // empty ground — means the builder has moved on from the add-item flow,
  // so the catalog picker (if left open) should collapse either way.
  closeCatalogPicker();
  raycaster.setFromCamera(ndcFromEvent(event), camera);

  // #540: Sell mode's showcase array is read-only browsing, not editing —
  // no measure/placement/gizmo modes ever run here (those are Build-only
  // flows never triggered while currentMode is 'sell'), so this branches
  // off before any of that rather than needing each of those checks below
  // to separately account for it. A hit jumps straight to Manage with that
  // product's row focused (see focusSellerManageRow); a miss does nothing.
  if (currentMode === 'sell') {
    const hits = raycaster.intersectObjects(sellerShowcaseMeshes, true);
    const hitRoot = hits.length > 0 ? findRootSellerShowcaseMesh(hits[0].object) : null;
    if (hitRoot) {
      sellerModalEl.classList.add('visible');
      openModalA11y(sellerModalEl, closeSellerModal);
      focusSellerManageRow(hitRoot.userData.template.templateId);
    }
    return;
  }

  if (measureMode) {
    // A drag that grabbed and moved an endpoint (see the pointerdown/
    // pointermove handlers above) can still land under CLICK_DRAG_THRESHOLD_PX
    // and fire this native 'click' too — without this guard it would be
    // read as "place a new point right here," undoing the drag that had
    // just finished.
    if (measureMarkerWasDragged) {
      setMeasureMarkerWasDragged(false);
      return;
    }
    handleMeasureClick();
    return;
  }

  if (pendingPlacement) {
    handlePlacementClick();
    return;
  }

  // recursive: true, since a model's own geometry sits on nested child
  // meshes (see loadModelInstance) rather than directly on the top-level
  // Object3D pushed into productMeshes.
  const hits = raycaster.intersectObjects(productMeshes, true);
  const hitRoot = hits.length > 0 ? findRootProduct(hits[0].object) : null;
  if (multiSelectMode) {
    if (hitRoot) toggleInSelection(hitRoot);
  } else {
    selectOnly(hitRoot);
  }
});

// #2559: see src/build/scene.js's own comment.

// requireLogin/requireVerification (login/signup, age+card verification
// gate) now live in src/account/auth.js — see that module's own #2554
// comment. ensureBuilderIdentity/ensureSellerIdentity/ensureShopperIdentity
// (and their flow-promise guards, and resetIdentityFlowPromises) now live
// in src/account/identity.js — see that module's own #2555 comment.

// #1602: generic "?" info-tooltip toggle -- reveals a popup of explanatory
// text next to the control it describes, instead of that text sitting
// inline and permanently taking up space (the owner's own complaint about
// #upload-hint/#upload-dimensions-hint). One delegated listener covers
// every .info-tooltip-btn/.info-tooltip-popup pair (present or future),
// unlike the one-off #level-menu-toggle/#account-menu-toggle wiring in
// src/account/menu.js, since this pattern is meant to be dropped in
// anywhere, not just at one fixed spot.
document.addEventListener('click', (event) => {
  const clickedBtn = event.target.closest('.info-tooltip-btn');
  document.querySelectorAll('.info-tooltip-btn[aria-expanded="true"]').forEach((openBtn) => {
    if (openBtn === clickedBtn) return;
    const openPopup = document.getElementById(openBtn.getAttribute('aria-controls'));
    if (openPopup?.contains(event.target)) return; // selecting text inside the popup itself shouldn't close it
    openBtn.setAttribute('aria-expanded', 'false');
    openPopup?.setAttribute('hidden', '');
  });
  if (!clickedBtn) return;
  const popup = document.getElementById(clickedBtn.getAttribute('aria-controls'));
  if (!popup) return;
  const expanding = popup.hasAttribute('hidden');
  clickedBtn.setAttribute('aria-expanded', String(expanding));
  popup.toggleAttribute('hidden', !expanding);
});

// Real login (docs/API.md's "Authentication") — now the sole way a
// builder/seller identity is established (see ensureBuilderIdentity/
// ensureSellerIdentity above, migrations/0054_link_builders_sellers_to_users.sql).
// currentAuthUser, the #auth-modal login/signup/verify flow, session
// reset, and authInitPromise now live in src/account/auth.js — see that
// module's own #2554 comment. This standalone IIFE stays here: unlike
// authInitPromise, it's explicitly independent of this browser's own
// login/session state (see its own comment).
// #454: a buyer confirming delivery has no account here at all (see
// "Simulated purchases") — this link works purely off the unguessable
// token in the URL, entirely independent of src/account/auth.js's
// authInitPromise (which is specifically about this browser's own
// login/session state, never relevant to whichever purchase this token
// identifies). Handled separately, at module load, rather than folded
// into that promise.
(async () => {
  const params = new URLSearchParams(location.search);
  const confirmToken = params.get('confirmDelivery');
  if (!confirmToken) return;
  history.replaceState(null, '', location.pathname);
  try {
    await confirmPurchaseDelivery(confirmToken);
    alert('Delivery confirmed — thank you! The seller can now cash out for this order.');
  } catch (err) {
    alert(err.message || 'This delivery-confirmation link is invalid or has expired.');
  }
})();

// #2556 (part of #2504/#2500's src/main.js module split, see #2503's
// design comment for the full dependency map): the notifications/
// friends/DM/my-lands account-menu chrome now lives in
// src/account/menu.js — see that module's own comment for its
// dependency notes. refreshNotificationsBadge/refreshFriendsBadge/
// refreshDmBadge (still called directly from this file after Shop/
// Sell/layout-preview mode entry and the seller Edit Size save flow)
// are imported back above.

// Shop: a visitor mode reached straight from the builder-choice screen, no
// identity needed, since visiting doesn't build or claim anything. Unlike
// the claim flyover (a separate small canvas/renderer showing a top-down
// map you tap to select a plot), Shop is full-screen continuous flight
// through the real world using the *same* scene/camera/renderer the
// builder view uses — reused rather than duplicated, partly to avoid
// fighting mobile browsers' low limit on simultaneous WebGL contexts, and
// partly because "the same ground/instance data, seen from a moving
// camera" is genuinely the same rendering problem the builder scene
// already solves for one landlet, just for many at once.
//
// Every landlet has an absolute world position (center_x_m/center_y_m);
// every placed instance's x/y is local to its own landlet (see
// docs/API.md) — so an instance's true position here is
// landlet.center + instance.(x,y). Each landlet gets a THREE.Group
// positioned at that center, and its instances are added as children at
// their ordinary local coordinates, so nothing about createMeshForInstance
// itself needs to know Shop mode exists.
const shopStatusEl = document.getElementById('shop-status');
export const shopMoveJoystickEl = document.getElementById('shop-move-joystick');
export const shopMoveKnobEl = shopMoveJoystickEl.querySelector('.shop-joystick-knob');
export const shopLookJoystickEl = document.getElementById('shop-look-joystick');
export const shopLookKnobEl = shopLookJoystickEl.querySelector('.shop-joystick-knob');
export const shopFlyBtn = document.getElementById('shop-fly-btn');
export const shopFlyBtnIcon = document.getElementById('shop-fly-btn-icon');
export const shopLastLocationBtn = document.getElementById('shop-last-location-btn');
export const shopVerticalControlsEl = document.getElementById('shop-vertical-controls');
export const shopUpBtn = document.getElementById('shop-up-btn');
export const shopDownBtn = document.getElementById('shop-down-btn');
// #2624: wires up both joysticks/both vertical buttons/the fly toggle/the
// last-location click -- deferred into a function call (rather than left
// as shop/flightMovement.js's own top-level side effects) so it runs after
// the DOM consts just above are actually initialized; see that module's
// own comment on initShopFlightInputBindings for the TDZ this avoids.
initShopFlightInputBindings();
const shopSignHintEl = document.getElementById('shop-sign-hint');
const shopCalendarHintEl = document.getElementById('shop-calendar-hint');
const shopProductPreviewModalEl = document.getElementById('shop-product-preview-modal');
const shopProductPreviewCloseBtn = document.getElementById('shop-product-preview-close-btn');
const shopProductPreviewCanvas = document.getElementById('shop-product-preview-canvas');
const shopProductPreviewInfoEl = document.getElementById('shop-product-preview-info');
const shopProductPreviewReviewBtn = document.getElementById('shop-product-preview-review-btn');
const shopProductPreviewBuyBtn = document.getElementById('shop-product-preview-buy-btn');
const shopProductPreviewReturnPolicyBtn = document.getElementById('shop-product-preview-return-policy-btn');
const refundPolicyModalEl = document.getElementById('refund-policy-modal');
const refundPolicyCloseBtn = document.getElementById('refund-policy-close-btn');
const checkoutModalEl = document.getElementById('checkout-modal');
const checkoutSummaryEl = document.getElementById('checkout-summary');
const checkoutCardElementEl = document.getElementById('checkout-card-element');
const checkoutStatusEl = document.getElementById('checkout-status');
const checkoutPayBtn = document.getElementById('checkout-pay-btn');
const checkoutCancelBtn = document.getElementById('checkout-cancel-btn');

// A flat, neutral gray for "claimed" reads as concrete/asphalt — a jarring,
// cold clash against this world's warm cream-and-green palette (see
// :root's --pill-rgb/--panel-rgb/--brand-green in index.html) every other
// bit of chrome uses. A warm tan instead reads as cleared/settled ground
// (tilled earth, a building's footprint) while staying clearly distinct
// from greenbelt's green and generating's amber.
const SHOP_PLOT_COLORS = { greenbelt: 0x6ca42e, claimed: 0xc2a878, generating: 0xd99a3f, water: 0x4a9bd1 };

// #220 (sub-issue of #206, docs/SPEC.md §1's "Water cannot be owned"): a
// landlet's landType (worker/earthCurvature.js's sibling module,
// worker/index.js's #218) is orthogonal to its lifecycle status — a water
// landlet still carries status: 'greenbelt' (see migrations/0064's own
// comment for why) so it never falls through either palette's lookup as
// "unknown," but it must never render or behave like ordinary available
// greenbelt. Every per-plot color/affordance lookup goes through this
// instead of reading `.status` directly, so a water landlet always resolves
// to each palette's own 'water' entry regardless of its underlying status.
export function plotColorKeyForLandlet(landlet) {
  return landlet.landType === 'water' ? 'water' : landlet.status;
}
// #1176: the "Go to Last Location" button's own fade in/out — same
// duration both ways, applied via CSS transition (#shop-last-location-btn
// in index.html), not JS-driven opacity.
const SHOP_LAST_LOCATION_BUTTON_FADE_S = 0.4;
// docs/SPEC.md's 500m flight ceiling assumes a much taller sky than this
// world's current wall/dome backdrop was ever built for (SHOP_WALL_HEIGHT_M
// + a dome that only grows reactively to clear tall builds — see
// growShopDomeIfNeeded — nowhere close to 500m by default). Capping flight
// to the same dynamic dome ceiling the camera itself already respects
// (clampShopCameraHeight) is a deliberate scope boundary for this pass,
// not an attempt at the literal number — genuinely extending the dome to a
// real 500m sky is its own separate visual-design task.
// Tighter than the old free-fly camera's own 0.47*PI (~85deg) — that
// figure let a bodiless camera look almost straight up/down freely, but
// this third-person rig swings the camera up and over the avatar's own
// head the more it looks down (see positionShopCamera), so an equally
// steep pitch here would swing the camera into a near-fully-overhead,
// disorienting god's-eye view. 0.35*PI (~63deg) still allows looking well
// down at your own feet or up at a tall build without reaching that
// extreme.
export const SHOP_MAX_PITCH = Math.PI * 0.35;
// The avatar's own body proportions (docs/SPEC.md §2's default avatar —
// see createShopAvatar), all in meters, hip-up from the ground the avatar
// group's own origin sits on:
export const SHOP_AVATAR_LEG_LENGTH_M = 0.86;
export const SHOP_AVATAR_LEG_RADIUS_M = 0.075;
export const SHOP_AVATAR_HIP_WIDTH_M = 0.12;
export const SHOP_AVATAR_TORSO_LENGTH_M = 0.5;
export const SHOP_AVATAR_TORSO_RADIUS_M = 0.17;
export const SHOP_AVATAR_ARM_LENGTH_M = 0.6;
export const SHOP_AVATAR_ARM_RADIUS_M = 0.055;
export const SHOP_AVATAR_SHOULDER_WIDTH_M = 0.23;
export const SHOP_AVATAR_HEAD_RADIUS_M = 0.14;
// docs/SPEC.md §2's collision numbers ("a 2-foot-diameter hard barrier"),
// reused here for shopper-vs-placed-item collision (the item-collision half
// of "Shopper collision still prevents walking through items" — Build
// mode's own item-vs-item collision, above, never covered this since Shop
// mode's multi-landlet shopLandlets map isn't part of productMeshes).
// Approximated as a small square rather than a true circle so the existing
// footprintCorners/footprintsOverlap SAT helpers (built for box-vs-box) can
// be reused as-is instead of writing separate circle-vs-polygon math.
export const SHOP_AVATAR_COLLISION_HALF_M = 0.3;
export const SHOP_AVATAR_HEIGHT_M = SHOP_AVATAR_LEG_LENGTH_M + SHOP_AVATAR_TORSO_LENGTH_M + SHOP_AVATAR_HEAD_RADIUS_M * 2;
// #1588: opt-in setting — when on, free-look (shopYaw) eases back toward
// the avatar's own facing (shopAvatarFacing) whenever the shopper isn't
// actively steering the right stick, instead of the two staying fully
// independent forever. Deliberately much slower than
// SHOP_AVATAR_TURN_EASE_PER_S's near-instant body turn: the owner's own
// requirement was that this read as a smooth re-center (Dysmantle cited
// as the UX precedent), never a snap.
// Where the third-person camera orbits around — roughly head height, not
// the very top of the head, so looking straight ahead frames the avatar
// low in frame rather than staring at the back of its skull.
export const SHOP_CAMERA_ANCHOR_HEIGHT_M =
  SHOP_AVATAR_LEG_LENGTH_M + SHOP_AVATAR_TORSO_LENGTH_M + SHOP_AVATAR_HEAD_RADIUS_M * 0.6;
// #1091: a custom equipped avatar (createCustomShopAvatar) can be any real
// size, not the default body's own fixed proportions — this ratio (anchor
// height as a fraction of total height, derived from the default body's own
// two constants above) lets positionShopCamera scale the anchor to a custom
// avatar's measured height instead of just reusing the default's absolute
// SHOP_CAMERA_ANCHOR_HEIGHT_M, while staying exactly equivalent to today's
// behavior for the default avatar itself.
export const SHOP_CAMERA_ANCHOR_HEIGHT_RATIO = SHOP_CAMERA_ANCHOR_HEIGHT_M / SHOP_AVATAR_HEIGHT_M;
// A full walk-cycle swing (hip/shoulder pivot, radians) at a full run;
// scales down toward 0 as the joystick's own deflection (and thus speed)
// drops toward a stand-still — see updateShopAvatarPose.
export const SHOP_AVATAR_SWING_AMPLITUDE_RAD = 0.55;
// Radians/second the walk-cycle phase advances at a full run; scales down
// with speed the same way the swing amplitude does, so a slow walk cycles
// its legs slower as well as with a smaller swing, not just a smaller one.
export const SHOP_AVATAR_CYCLE_SPEED_RAD_S = 7;
// How fast the avatar's swing amplitude eases toward its current target
// (moving vs. stopped) each frame — see updateShopAvatarPose.
export const SHOP_AVATAR_SWING_EASE_PER_S = 8;
export const SHOP_AVATAR_ANIM_CROSSFADE_S = 0.25;
// docs/SPEC.md §2's "context-aware idle state machine ... after inactivity,
// with randomization" — see updateShopAvatarIdle. This pass only covers
// "stand" (a subtle randomized weight-shift sway + occasional head turn);
// "sit"/"lean" need a real interaction-target system (e.g. a chair prop
// with an occupancy slot) that doesn't exist yet.
export const SHOP_IDLE_DELAY_S = 3; // no movement input for this long before idle sway starts easing in
export const SHOP_IDLE_BLEND_PER_S = 0.6; // how fast idle sway eases in/out (in on stillness, out the instant movement resumes)
// docs/SPEC.md §2's "stationary-too-long triggers an AFK indicator" — a
// floating label above the avatar's own head (see makeSignPostSprite),
// visible on the player's own third-person avatar in Shop mode so it's
// directly self-testable. Deliberately much longer than SHOP_IDLE_DELAY_S:
// idle sway should read as "still paying attention," AFK should only show
// once that stops being a believable read — a minute-plus of true stillness.
export const SHOP_AFK_DELAY_S = 90; // no movement input for this long before the AFK label starts fading in
export const SHOP_AFK_BLEND_PER_S = 0.6; // matches SHOP_IDLE_BLEND_PER_S's own feel — in on stillness, out instantly on movement
export const SHOP_IDLE_SWAY_AMPLITUDE_RAD = 0.035; // whole-body weight-shift, small enough to read as idle fidget, not a stagger
export const SHOP_IDLE_SWAY_PERIOD_MIN_S = 3.5;
export const SHOP_IDLE_SWAY_PERIOD_MAX_S = 6;
export const SHOP_IDLE_ARM_SWAY_AMPLITUDE_RAD = 0.05;
export const SHOP_IDLE_HEAD_TURN_MAX_RAD = 0.4; // a natural glance range, not a full look-behind
export const SHOP_IDLE_HEAD_TURN_INTERVAL_MIN_S = 2.5;
export const SHOP_IDLE_HEAD_TURN_INTERVAL_MAX_S = 5;
// #2478 (sub-issue of #2475): the seated pose. No knee joint on this
// primitive rig (createShopAvatar's own comment -- each leg is one rigid
// hip-to-foot cylinder), so "sitting" is approximated as the whole leg
// swinging forward from the hip toward horizontal, same single-joint
// simplification the walk cycle already uses -- not a full right angle, so
// the silhouette doesn't read as the legs sticking straight out stiff.
export const SHOP_SIT_LEG_ROTATION_RAD = (Math.PI / 2) * 0.88;
// Forearms resting toward the lap rather than hanging straight down —
// gentler than the legs' own rotation since there's no elbow to bend
// either and a full 90 degrees would plant the hands on the floor instead.
export const SHOP_SIT_ARM_ROTATION_RAD = (Math.PI / 2) * 0.55;
export const SHOP_IDLE_HEAD_TURN_EASE_PER_S = 1.5;
// docs/SPEC.md §1's "vertical chunk-loading uses the same near/middle/far
// LOD banding as horizontal distance" (#171, sub-issue of #167's vertical-
// construction tracking) has nothing to hang a per-band decision on yet,
// same reasoning as the horizontal case just above: the horizontal scheme
// it's meant to mirror doesn't itself have real near/middle-LOD/far-
// backdrop banding built (just this one binary load/unload distance), and
// separately, there's no frontend rendering of a lándlet's own levels at
// all yet — worker/index.js's landlet_levels (#168) is a real data model
// with real cap accounting, but #169 (the Build-mode UI to actually add/
// remove/view a level) hasn't landed, so no level ever has geometry to
// apply a LOD band to in the first place. Revisit once both exist: #169
// gives levels something to render, and a real horizontal LOD system
// gives this a banding scheme to reuse a vertical distance metric in,
// rather than inventing one from scratch here.
// Community signs (docs/SPEC.md §6, docs/API.md's "Community signs") —
// shopper-authored posts fade in as the camera approaches a sign and back
// out past it, rather than a hard show/hide cutoff, the same
// proximity-as-opacity idea the spec's own in-world social feed calls for
// generally ("size/opacity as a function of distance"). SIGN_INTERACT_RADIUS_M
// is deliberately much tighter than the fade radius — close enough to
// plausibly be able to read the sign at all before "Leave a Note" appears.
const SIGN_FADE_NEAR_M = 4; // fully opaque at/within this distance
const SIGN_FADE_FAR_M = 20; // fully transparent at/beyond this distance
const SIGN_INTERACT_RADIUS_M = 8;
const SIGN_MAX_VISIBLE_POSTS = 5;
// Community calendar (docs/SPEC.md §6, docs/API.md's "Community
// calendar") reuses the SIGN_FADE_NEAR_M/SIGN_FADE_FAR_M/
// SIGN_INTERACT_RADIUS_M/SIGN_MAX_VISIBLE_POSTS constants above directly
// rather than declaring near-duplicate CALENDAR_* ones — they're generic
// "how far can you read floating in-world text" thresholds, not anything
// specific to signs, so there's nothing calendar-specific to tune
// separately (unlike the backend's own deliberately-separate table/flag —
// see migrations/0042's comment on why that split is real).
// The world wall: an opaque ring standing at exactly the current world
// radius, tall enough that nothing generating out beyond it (still
// unclaimable — see the availability circle in docs/SPEC.md) is visible
// past the edge, and a matching radial clamp on the camera so it's a real
// boundary, not just a backdrop — the builder can never fly past it to see
// around it. A land straddling the boundary still shows whatever fraction
// of it sits inside — anywhere from a sliver to nearly the whole shape —
// which is the correct, intentional look here, not a bug to hide.
export const SHOP_WALL_HEIGHT_M = 60;
const SHOP_WALL_MARGIN_M = 1.5; // small ground/wall seam overlap only — see wildGround below
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
// The dome's rise above the wall's own top — independent of the wall's
// rim radius (set via non-uniform scale, see enterShopMode) so a bigger
// world doesn't need a proportionately taller dome. Grows on its own if
// something built anywhere in the world is ever discovered taller than
// this provides clearance for — see growShopDomeIfNeeded.
const SHOP_DOME_INITIAL_RISE_M = SHOP_WALL_HEIGHT_M;
export const SHOP_DOME_CLEARANCE_MARGIN_M = 5;
// Skip building a ground mesh for a landlet with no chance of being seen
// (entirely beyond the wall, comfortably past any land's own footprint) —
// pure cost-cutting as the world grows, never aggressive enough to risk
// hiding a real sliver.
const SHOP_LANDLET_CULL_MARGIN_M = 40;

export let shopWorldRadiusM = null;
export let shopDomeMesh = null;
let shopWallMesh = null;
export let shopDomeRiseM = SHOP_DOME_INITIAL_RISE_M;
let shopSkyMaterial = null; // the wall's own material — the dome gets its own material instance (see enterShopMode) sharing this one's `uniforms` object by reference, not the material itself, so both still animate off one clock — see createShopSkyMaterial
let shopSkyClockStart = null;

// Clouds only ever show in the upper portion of the wall (its own hazy-
// horizon band) and above — never near the wall's ground-colored base, so
// the boundary still mostly reads as plain sky/horizon rather than a
// visibly "effects-y" surface. Both are absolute world Z heights (this
// world is Z-up, ground at z=0), independent of shopDomeRiseM growing
// later — see growShopDomeIfNeeded — since growing the dome only extends
// clear sky *above* SHOP_CLOUD_FADE_HIGH_Z, which was already full opacity.
const SHOP_CLOUD_FADE_LOW_Z = SHOP_WALL_HEIGHT_M * 0.55;
const SHOP_CLOUD_FADE_HIGH_Z = SHOP_WALL_HEIGHT_M * 1.25;

// Colors a geometry per-vertex along its own local "up" axis (the axis
// CylinderGeometry/SphereGeometry both author height/pole along before any
// Z-up rotation is applied), calling colorAt(localUp, out) for every
// vertex — a plain vertical gradient needs nothing fancier than that, and
// staying in each geometry's own local space means the result is
// independent of any later position/rotation/scale, so growShopDomeIfNeeded
// scaling the dome taller never has to repaint it.
function paintVerticalGradient(geometry, colorAt) {
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const out = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    colorAt(position.getY(i), out);
    colors[i * 3] = out.r;
    colors[i * 3 + 1] = out.g;
    colors[i * 3 + 2] = out.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// A soft, slowly swirling cloud layer painted directly over the wall/dome's
// own vertex-color gradient (vColor below — the exact colors
// paintVerticalGradient already wrote) rather than replacing it, so the
// calm horizon/sky look this was tuned to keep is the base case and clouds
// are only ever a translucent overlay on top of it. One shared material
// instance for both meshes (see enterShopMode) keeps their animation
// perfectly in sync and means only one uTime needs updating per frame.
//
// The "swirl": each height band drifts around the vertical axis at a
// slightly different azimuthal speed (see the sin(heightFrac...) term in
// `drift` below), so bands shear past each other over time instead of the
// whole sky sliding sideways together — soft, continuous, and slow enough
// to read as soothing rather than busy. World-space position (not each
// geometry's own local parametrization) drives both the swirl angle and
// the height-based fade, so the effect is seamless across the wall/dome
// seam even though they're two separate meshes with different local
// coordinate systems.
const SHOP_SKY_VERTEX_SHADER = `
  attribute vec3 color;
  varying vec3 vColor;
  varying vec3 vWorldPosition;
  varying vec3 vNormalWorld;
  void main() {
    vColor = color;
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    // See the fragment shader's own owner-report-2026-10-21 comment on
    // grazeFade -- this is purely that fix's input, not used for lighting.
    vNormalWorld = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SHOP_SKY_FRAGMENT_SHADER = `
  varying vec3 vColor;
  varying vec3 vWorldPosition;
  varying vec3 vNormalWorld;
  uniform float uTime;
  uniform float uFadeLowZ;
  uniform float uFadeHighZ;
  uniform float uWorldRadius;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  // Band-limited fbm: each octave is faded out once its own noise-space
  // period gets small relative to how much p itself changes between
  // neighboring screen pixels (fwidth(p)). Without this, looking nearly
  // straight up into the dome compresses a huge sweep of world-space
  // azimuth into a handful of screen pixels near the apex, so the same
  // pixel-to-pixel jump in p covers many full cycles of the higher
  // octaves — undersampling them, which aliases into sharp radiating
  // streaks rather than soft cloud texture. Fading each octave out before
  // that happens leaves only the octaves that are still actually resolved
  // at that pixel, which reads as a smooth (if slightly hazier) blend
  // instead — exactly the soft wisp this was meant to look like everywhere,
  // not just where the view happens to be gentle enough not to alias.
  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    float totalWeight = 0.0;
    for (int i = 0; i < 4; i++) {
      float footprint = fwidth(p.x) + fwidth(p.y);
      // #1585: #1190's original thresholds (0.005, 0.05) still left a
      // visible band of sharp-edged, hard-banded streaks (not the soft
      // "slightly hazier blend" this comment promises) wherever footprint
      // landed inside that range but hadn't yet grown large enough to
      // fully fade — confirmed directly: replacing fbm()'s body with a
      // flat constant (no pseudo-random content at all, same geometry/
      // camera) rendered a perfectly smooth gradient with zero streaking,
      // proving the streaks are 100% this noise function's own
      // undersampling, not a mesh seam or z-fighting (the two alternatives
      // issue #1585's own report raised). Widening apexFade's own radius
      // (the pole-proximity cutoff just below) barely changed the result,
      // so the problem wasn't limited to the literal pole either — it's
      // this fade engaging too late. Starting the fade an order of
      // magnitude sooner (0.0005) closes that gap — confirmed via direct
      // visual comparison that every previously-streaked camera angle
      // (near the apex, pitched up and yawed, flying near the horizon)
      // renders cleanly once the fade engages that early.
      //
      // #1799: #1585's own fix additionally narrowed the *upper* bound
      // from 0.05 to 0.006 (a ~9x tighter span, 0.0055 wide vs. the
      // original 0.045), which traded the undersampling streaks for a
      // new, different-looking artifact — a hard, jagged/stair-stepped
      // edge in the cloud overlay, most visible on a pitched-up-and-yawed
      // view (confirmed via direct Playwright screenshots, cropped and
      // contrast-boosted to make it unambiguous). Root cause: fwidth() is
      // a GPU quad-derivative — effectively constant across each 2x2
      // pixel block, not a true per-pixel value — and that inherent
      // blockiness is negligible against a wide threshold span but
      // becomes the dominant signal once the span narrows enough that
      // one quad's worth of footprint jitter covers a large fraction of
      // it, which is exactly what a 0.0055-wide span did. This shows up
      // worst along diagonal gradients (yawed views) because GPU quad
      // derivatives are axis-aligned, so a diagonal transition steps
      // through quads one axis at a time rather than smoothly. Widening
      // the upper bound back out to 0.03 — keeping #1585's early-
      // engaging 0.0005 lower bound (the actual fix for the original
      // streaks), while still well under the pre-#1585 0.05 that let
      // those streaks through — gives the transition enough span again
      // to absorb normal quad-to-quad footprint jitter: confirmed via
      // the same screenshot technique that the jagged edge is gone at
      // every angle that showed it (pitched up and yawed, near the
      // horizon), while a full straight-up apex view and an ordinary
      // moderate-pitch view both still render as a smooth gradient with
      // no streaking, same as #1585's own fix already established.
      float fade = 1.0 - smoothstep(0.0005, 0.03, footprint);
      value += amplitude * fade * noise(p);
      totalWeight += amplitude * fade;
      p *= 2.05;
      amplitude *= 0.55;
    }
    // Renormalize so fading out high octaves near the apex converges the
    // result toward the (still fully resolved) low-frequency base rather
    // than just going dim/dark — a change in texture, not in brightness.
    return totalWeight > 0.0001 ? value / totalWeight : value;
  }

  void main() {
    float heightFrac = clamp((vWorldPosition.z - uFadeLowZ) / (uFadeHighZ - uFadeLowZ), 0.0, 1.0);
    // Rotating the actual XY position (not an extracted angle) around the
    // vertical axis avoids a polar singularity — sampling noise by angle
    // alone makes every point near the dome's apex, however close
    // together, resolve to wildly different angles, which reads as sharp
    // rays converging to a point rather than soft cloud cover. Rotating
    // real coordinates has no such singularity: nearby points stay nearby.
    // Each height band rotates at a slightly different rate so bands shear
    // past each other over time — that shear is what actually reads as
    // "swirl." Split into two terms: a uniform rotation (same for every
    // height, so it has zero derivative w.r.t. heightFrac and is safe to
    // keep accumulating forever) plus a height-dependent shear term.
    //
    // #1190: the height-dependent term used to be uTime * 0.015 *
    // sin(heightFrac * 2pi) -- i.e. its own magnitude grew linearly with
    // elapsed time forever. That means d(swirlAngle)/d(heightFrac), which
    // directly drives how far apart in noise-space two vertically adjacent
    // pixels sample, also grew linearly with uTime without bound: after
    // long enough in Shop mode, adjacent height rows' samples became far
    // enough apart to alias, visible as a seam/band (confirmed via direct
    // footprint-heatmap debugging: fwidth(samplePos) spikes in a band near
    // the horizon after ~20 simulated minutes, exactly where the normal
    // render shows a washed-out edge, and is flat at t=0). Capping the
    // term's own magnitude with a slow oscillating envelope instead of
    // letting it grow linearly keeps that derivative bounded for any
    // session length, while matching the original's instantaneous rate at
    // t=0 (so a normal, short session looks identical to before).
    float shearOmega = 0.0104719755; // 2*pi / 600s -- full envelope cycle every 10 minutes
    float shearAmplitude = 1.4323944878; // 0.015 / shearOmega, so d/dt at t=0 matches the original 0.015 rad/s
    float swirlAngle = uTime * 0.02 + shearAmplitude * sin(shearOmega * uTime) * sin(heightFrac * 6.2831);
    float s = sin(swirlAngle);
    float c = cos(swirlAngle);
    // Normalized by the world's own current radius (not a fixed meters
    // scale) so the pattern always spans the same handful of cells around
    // the dome regardless of how big the world currently is — a fixed
    // meters-based frequency would compress into a single, texture-less
    // noise cell for a small early-game world, or tile too busily once the
    // world has grown large.
    vec2 normalizedXY = vWorldPosition.xy / max(uWorldRadius, 1.0);
    vec2 swirled = mat2(c, -s, s, c) * normalizedXY;
    // owner-report-2026-10-20 (regression on #2450): this offset used to be
    // vec2(uTime * 0.05, heightFrac * 3.0 - uTime * 0.015) -- i.e. its own
    // magnitude grew linearly with elapsed time forever, exactly the same
    // unbounded-growth shape #1204 already fixed once for the swirl term
    // just above (which is why that term is now safe: it's only ever
    // consumed via sin/cos, so it's inherently periodic). This offset
    // wasn't, so the fbm sample neighborhood wandered forever through
    // fresh noise-space. #2450's widened cloudMask hides an ordinary
    // *steady-state* gradient near the pole, but it can't hide an
    // arbitrarily steep one -- and an unbounded random walk through noise
    // space will eventually (by chance) wander back into one, reproducing
    // the original artifact after a few minutes (confirmed via simulated-
    // duration testing with a dilated RAF clock, same technique #1204's
    // own "verified clean up to ~27.7 hours" claim must have used: the
    // artifact's severity visibly fluctuates and worsens over the first
    // ~20 simulated minutes rather than settling down). Fixed the same way
    // #1204 fixed the shear term: a bounded oscillating envelope instead
    // of unbounded linear growth, matching the original's instantaneous
    // rate at t=0 so a short session still looks identical to before, and
    // sharing shearOmega's own 600s cycle length for consistency.
    float driftAmplitudeX = 4.7746482927; // 0.05 / shearOmega, matches d/dt at t=0
    float driftAmplitudeY = -1.4323944878; // -0.015 / shearOmega, matches d/dt at t=0
    vec2 drift = vec2(driftAmplitudeX, driftAmplitudeY) * sin(shearOmega * uTime);
    vec2 samplePos = swirled * 2.5 + vec2(drift.x, heightFrac * 3.0 + drift.y);
    float clouds = fbm(samplePos);
    // #1190/#1585/#1799/owner-report-2026-10-20: three prior fixes in this
    // area (apex-streak footprint-fade tuning, shear-band envelope capping,
    // footprint-threshold widening/narrowing) all targeted *aliasing* —
    // undersampled high-frequency noise. Direct visual debugging this time
    // (rendering fbm()'s raw, unprocessed output with visibility forced to
    // 0/1 at a time) found something different: even the *smooth*,
    // correctly-resolved, non-aliased base octave shows a soft radial
    // "spoke" pattern converging on the pole. This isn't noise undersampling
    // at all — it's an unavoidable consequence of rotating the flattened
    // (x,y) world position (normalizedXY below) around the pole: every
    // azimuth's sample position approaches the *same* noise-space point as
    // world-space radius shrinks toward the pole (a sphere's pole is a
    // single point — any 2D flattening must collapse every azimuth there),
    // so a smooth noise gradient near that point reads as straight
    // "contour" lines radiating outward once you're close enough. No amount
    // of per-octave aliasing suppression touches this, because it's present
    // in the lowest octave too, which that mechanism never fades.
    // What actually fixes the *visible* symptom: the previous narrow
    // smoothstep(0.25, 0.95, clouds) turned this smooth radial gradient
    // into a near-binary cloud/no-cloud mask, and it's that hard threshold
    // — not the underlying gradient — that reads as sharp "spokes"/"bands"
    // rather than a soft, barely-noticeable undulation. Widening the
    // threshold dramatically (confirmed via a full yaw sweep at a fixed
    // steep pitch, not just one camera angle) keeps the same underlying
    // field but blends it so softly that the radial structure stops being
    // perceptible, without touching the swirl/shear-band fix (#1204) or the
    // per-octave aliasing fade (#1633) at all.
    // owner-report-2026-10-20 (round 2, post-deploy): even with the
    // drift term now bounded (see samplePos above) and this threshold
    // already once widened by #2450, a sharp-edged patch is still
    // occasionally visible near the wall/dome boundary. heightFrac is
    // already fairly low there (uFadeLowZ sits well below the boundary,
    // but the ramp isn't finished by the time visibility is still
    // substantial at that height -- see heightFrac's own definition
    // above), so a locally steep spot in the (now-bounded, but not
    // perfectly flat) noise field is still enough to read as a hard edge
    // once multiplied back up by a non-trivial heightFrac. Widening this
    // threshold again trades a little more of the cloud layer's own
    // contrast for a softer worst case everywhere, same direction as
    // #2450's own change and with the same confirmed-safe-to-widen
    // precedent noted below for apexFade.
    float cloudMask = smoothstep(-0.6, 1.6, clouds);
    // Kept from before (#1204/#1585) as a modest extra safety margin right
    // at the literal pole specifically — on its own this barely moves the
    // result (confirmed: widening or disabling it entirely, independent of
    // the cloudMask change above, made no meaningful visual difference —
    // the real fix is the threshold softening above). length(normalizedXY)
    // is the pole-distance in sin(angle-from-zenith) terms, independent of
    // the current world radius — 0 at the apex, growing toward the horizon.
    float apexFade = smoothstep(0.0, 0.08, length(normalizedXY));
    // owner-report-2026-10-21 (round 3): none of the fixes above touch a
    // different failure mode from the same fbm() footprint-fade logic --
    // confirmed via a from-scratch repro harness (matching wall/dome
    // geometry+shader at the real production world's own scale, since the
    // only sandbox account available keeps every camera distance inside the
    // depth buffer's high-precision near range, same limitation #2606's own
    // honesty check flagged) that isolated the *dome* mesh alone (wall
    // hidden entirely) as sufficient to reproduce a crisp, stair-stepped
    // crack through the sky -- present identically regardless of the wall,
    // regardless of #2606's polygonOffset (even at 1000x its shipped
    // magnitude), and regardless of giving the dome real (multi-meter, not
    // sub-ULP) geometric overlap with the wall. Forcing cloudMask's own
    // visibility contribution to zero made the crack vanish outright, which
    // the wall/dome-seam theory never explained: this was the fbm()
    // footprint-threshold aliasing from #1585/#1799 all along, just not
    // triggered by any camera angle those two fixes were tuned against --
    // true grazing/near-tangential incidence (flying close alongside the
    // wall, looking almost straight along it) drives fwidth(p) for *every*
    // octave far past even #1799's widened 0.03 upper bound, and GPU quad-
    // derivative blockiness turns that threshold crossing into a visible
    // stair-step rather than a smooth fade, exactly as #1799's own comment
    // already predicted for this mechanism in general.
    // Widening the threshold a third time would eventually hit the same
    // wall again at a steep enough angle, so this instead fades the cloud
    // overlay itself out as the view approaches grazing incidence against
    // the dome/wall surface -- a Fresnel-style facing term, not another
    // footprint-threshold tweak. facing is 1.0 looking straight at the
    // surface (normal viewing, including straight up at the zenith) and
    // approaches 0.0 at true grazing/tangential incidence, exactly where
    // fwidth()'s blockiness becomes visible. Confirmed via the same repro
    // harness across every previously-clean case (zenith, moderate-pitch
    // ground view, realistic near-wall flight) that this is pixel-identical
    // to the unfixed shader -- the fade only ever engages in the narrow
    // facing range right at the silhouette, where a human player is never
    // looking at ordinary cloud detail anyway. 0.35 was the narrowest
    // margin that still fully cleared the crack even at a deliberately
    // pathological near-impossible test angle (camera 0.2m from a 300m-
    // radius wall, pitch 2°, almost perfectly tangential) with headroom.
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    float facing = abs(dot(normalize(vNormalWorld), viewDir));
    float grazeFade = smoothstep(0.0, 0.35, facing);
    float visibility = heightFrac * cloudMask * apexFade * grazeFade * 0.5; // kept subtle — an overlay, not a repaint
    vec3 cloudColor = vec3(0.99, 0.99, 1.0);
    gl_FragColor = vec4(mix(vColor, cloudColor, visibility), 1.0);
  }
`;

function createShopSkyMaterial(worldRadiusM) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFadeLowZ: { value: SHOP_CLOUD_FADE_LOW_Z },
      uFadeHighZ: { value: SHOP_CLOUD_FADE_HIGH_Z },
      uWorldRadius: { value: worldRadiusM },
    },
    vertexShader: SHOP_SKY_VERTEX_SHADER,
    fragmentShader: SHOP_SKY_FRAGMENT_SHADER,
    side: THREE.BackSide,
    // fwidth() in fbm() (used to band-limit the noise near the dome apex,
    // see fbm's own comment) needs this extension under WebGL1/GLSL ES
    // 1.00; harmless no-op where the renderer already exposes it as core
    // (WebGL2).
    extensions: { derivatives: true },
  });
}

// Called every animate() frame while Shop mode is active (see animate's own
// dispatch) — advances the shared sky material's clock. A local clock
// start rather than reusing `now` directly so the shader's time uniform
// stays small/precise regardless of how long the page has been open before
// Shop mode was entered.
function updateShopSky(now) {
  if (!shopSkyMaterial) return;
  if (shopSkyClockStart === null) shopSkyClockStart = now;
  shopSkyMaterial.uniforms.uTime.value = (now - shopSkyClockStart) / 1000;
}

// Called as each Shop-mode landlet's instances load in (see
// loadShopLandletInstances) — if anything anywhere in the world turns out
// to be tall enough to threaten poking through the dome, grow the dome to
// keep clearing it rather than ever letting a real build clip through a
// backdrop. Purely reactive to what's actually been loaded so far (Shop
// only loads a landlet's instances once the camera gets near it — see
// updateShopProximity), not a global precomputed guarantee.
export function growShopDomeIfNeeded(object) {
  if (!shopDomeMesh) return;
  const box = new THREE.Box3().setFromObject(object);
  const neededRise = box.max.z - SHOP_WALL_HEIGHT_M + SHOP_DOME_CLEARANCE_MARGIN_M;
  if (neededRise <= shopDomeRiseM) return;
  shopDomeRiseM = neededRise;
  shopDomeMesh.scale.y = shopDomeRiseM;
}

export let shopAvatarFacing = 0;
// #2624: shop/flightMovement.js reassigns this in several places (turning
// to face movement, the spawn-orbit/"Go to Last Location" sequences) --
// an ES import binding is read-only from the importing side, so it needs
// this setter rather than a direct assignment, same shape world/state.js's
// own setCurrentMode etc. already established for cross-cutting state.
export function setShopAvatarFacing(value) {
  shopAvatarFacing = value;
}
// #1164 (sub-issue of #1161): the shopper's own currently-equipped avatar's
// skeleton signature (#1162), fetched once in enterShopMode alongside
// equippedAvatarModelUrl just below — null for the default procedural
// avatar or a logged-out/anonymous visit. productInfoText reads this to
// show a compatibility note on an "animation"-category product's buy hint.
let shopEquippedAvatarSkeletonSignature = null;
const shopWorldObjects = []; // ground meshes + the wild backdrop — disposed together on exit
// Every currently-loaded community-sign instance: { mesh, group, instanceId,
// posts, sprites }. Populated/torn down alongside its landlet's own
// objects (see loadShopLandletInstances/unloadShopLandletInstances) rather
// than kept in its own load radius — a sign is exactly as "loaded" as the
// rest of its landlet.
const shopSigns = [];
let nearestActiveSign = null; // whichever sign #shop-sign-hint currently targets, or null
// Same shape/lifecycle as shopSigns above, for community-calendar instances.
const shopCalendars = [];
let nearestActiveCalendar = null;
// Same shape/lifecycle as shopSigns above, for every placed instance's
// reviews (no opt-in flag — see registerShopReview) — a
// {mesh, group, templateId, reviews, sprites} entry per loaded one, with
// `reviews` populated once rather than re-fetched.
const shopReviews = [];
// The product preview modal's own content/visibility is driven by this
// (see the tap handler further below) — showing it the instant a shopper
// wanders near anything read as noisy/intrusive, closer to a tooltip stuck
// to the cursor than an intentional "what is this." Requiring a tap makes
// seeing it a deliberate choice.
//
// Owner (Control Room, N42): the buy/review hints used to be purely
// proximity-driven (visible whenever nearest-in-range, no tap needed) —
// "walking near a product should not make the buttons appear... they
// should only appear after the user taps the product." Now shares this
// same tapped-product state instead of its own nearest-by-distance
// tracking, so a shopper has to deliberately tap before either button can
// show. Still range-gated on top of that (see updateReviewFade below) —
// walking away from a tapped product hides its buttons again, the same
// physical-interaction requirement every other in-world hint (signs,
// calendar events) already enforces.
let shopTappedProduct = null;
let shopReviewHintsVisible = false;
// #994: which product shopReviewHintsVisible/canBuy were last computed for
// -- updateReviewFade's own change-detection used to key purely off
// tappedInRange, so retapping a *different* product without ever leaving
// SIGN_INTERACT_RADIUS_M (two nearby items on the same shelf, say) left
// the Buy/Return-Policy hints showing the previous product's priced state.
let shopReviewHintsProduct = null;
// #1810: which product's mesh currently carries addSelectionOutline's
// highlight -- mirrors shopReviewHintsProduct's own "last computed for"
// role, so updateReviewFade can tell a highlight change from a no-op on
// the same product it's already applied to.
let shopHighlightedProduct = null;






// #2623: makeAfkBadgeSprite/createShopAvatar/createCustomShopAvatar/
// shopAvatar(/setShopAvatar)/shopAvatarCollisionHalfM/shopAvatarHeightM/
// shopCameraAnchorHeightM/refreshEquippedShopAvatar now live in
// src/shop/avatar.js — see that module's own header comment for its
// dependency notes.

export const shopAvatarPosition = new THREE.Vector3(); // feet position, ground truth for both the mesh and the camera
// #1829: read-only counterpart to the teleport hook above -- lets a test
// confirm shopAvatarPosition actually changed (or didn't) after driving a
// real move through moveShopAvatarWithCollision below, same "always inert
// unless a test calls it" convention as every other window.__test* hook
// here.
window.__testShopAvatarPosition = () => ({ x: shopAvatarPosition.x, y: shopAvatarPosition.y, z: shopAvatarPosition.z });
// #1479: forces an immediate, synchronous load/unload decision rather than
// waiting on the next real requestAnimationFrame tick to notice a teleport
// on its own. window.__testTeleportShopAvatar's own comment above explains
// why a real tick "should" see the new position promptly -- true most of
// the time, but under heavy load a backgrounded/throttled RAF loop can
// stall for a while, and there's no reason to leave that window open when
// a test can make the decision land exactly when it wants it to. Always
// inert unless a test calls it, same convention as window.__testAvatarLoadDelayMs.
window.__testForceShopProximityCheck = () => {
  positionShopCamera();
  updateShopProximity();
};
// #2378: read-only test hook reporting an instance's actual rendered LOD
// state, rather than just entry.lod's own intended-state tracking -- reads
// object.userData.lodProxy.visible directly (the real signal
// setInstanceLodState toggles), so a bug in that toggle itself still shows
// up here even if entry.lod flipped correctly. Returns 'near' (full detail
// visible), 'middle' (simplified proxy visible), 'none' (no proxy at all --
// a box/flooring fallback instance, nothing to simplify), or null if the
// instance isn't currently loaded. Same minimal-exposure-for-verification
// precedent as window.__shopInstanceDisposedCount (#1427) and
// window.__testShopAvatarPosition above. Always inert unless a test calls it.
window.__testShopInstanceLodBand = (instanceId) => {
  for (const entry of shopLandlets.values()) {
    const object = entry.objects.find((o) => o.userData.instanceId === instanceId);
    if (!object) continue;
    const proxy = object.userData.lodProxy;
    if (!proxy) return 'none';
    return proxy.visible ? 'middle' : 'near';
  }
  return null;
};
// #2399: read-only test hook exercising the *real* raycast pipeline (the
// same THREE.Raycaster/shopReviews.map(r => r.mesh) pair the tap-to-inspect
// click handler below uses) against a ray aimed straight down through the
// exact center of the proxy's own world-space bounding box -- computed via
// THREE.Box3 rather than assumed local coordinates, so it works regardless
// of whether the proxy or the real model is currently visible. Reports
// which representation actually absorbed the hit ('proxy', 'real', or
// 'none' for no hit at all), independent of findTappedShopProduct's own
// walk-up-to-the-shared-parent resolution (which would mask this -- both
// representations share the same top-level `object`, so tapping either one
// still resolves to the same product; this hook is what actually shows
// setInstanceLodState's own hit-testable toggle working, or not). Always
// inert unless a test calls it, same convention as the other window.__test*
// hooks here.
window.__testShopInstanceLodHitSource = (instanceId) => {
  for (const entry of shopLandlets.values()) {
    const object = entry.objects.find((o) => o.userData.instanceId === instanceId);
    if (!object) continue;
    const proxy = object.userData.lodProxy;
    if (!proxy) return null;
    const box = new THREE.Box3().setFromObject(proxy);
    const center = box.getCenter(new THREE.Vector3());
    const origin = new THREE.Vector3(center.x, center.y, box.max.z + 10);
    const downRaycaster = new THREE.Raycaster(origin, new THREE.Vector3(0, 0, -1));
    const hits = downRaycaster.intersectObjects(shopReviews.map((r) => r.mesh), true);
    if (hits.length === 0) return 'none';
    let current = hits[0].object;
    while (current) {
      if (current === proxy) return 'proxy';
      current = current.parent;
    }
    return 'real';
  }
  return null;
};
// #1495: reports whether any material on the current shop avatar is still
// flagged transparent -- used to confirm setShopAvatarOpacity's "Go to Last
// Location" fade sequence actually restores this when it completes, rather
// than leaving it stuck true. Always inert (read-only), same convention as
// the other window.__test* hooks above.
window.__testShopAvatarHasTransparentMaterial = () => {
  let found = false;
  shopAvatar.group.traverse((object) => {
    if (object === shopAvatar.afkSprite || !object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (materials.some((material) => material.transparent)) found = true;
  });
  return found;
};
// #1583: the normal upload flow always runs a selected file through
// optimizeModelFile first (handleUploadFileStep), and GLTFExporter
// unconditionally wraps whatever Group it's given in one new top-level
// node on export -- so by the time rescaleModelFile itself ever sees a
// file via that flow, any originally-multi-root model has already been
// collapsed to a single root one level up, and a test driving the real
// upload wizard UI can't reach the multi-root branch rescaleModelFile's
// own scene.children loop exists to handle. Exposing the function directly
// lets a test feed it a genuinely multi-root buffer and inspect the result,
// without needing to defeat (or rely on the absence of) that optimization
// step. Always inert unless a test calls it, same convention as the other
// window.__test* hooks above.
window.__rescaleModelFileForTests = rescaleModelFile;
// #1682: same reasoning as __rescaleModelFileForTests above -- driving the
// real upload wizard UI with a constructed fixture can't isolate
// optimizeModelFile's own decimation math from everything else the wizard
// does around it (FBX conversion, dimension measurement, the actual
// network upload). Exposing it directly lets a test feed it a raw file
// and inspect trianglesAfter/the re-exported geometry on their own. Always
// inert unless a test calls it.
window.__optimizeModelFileForTests = optimizeModelFile;
// #2623: shopAvatarSwing/WalkPhase and the idle/AFK/sway/head-turn/sit/
// lean state block that used to live here now live in src/shop/avatar.js
// (SHOP_SIT_SETTLE_DELAY_MIN_S/MAX_S included) — the exported bindings
// this file still needs (shopIdleSwayYawOffset/shopIdleInteractionTarget/
// shopSitBlend/shopSitYawOffset/shopSitHeightOffset/shopLeanBlend/
// shopLeanYawOffset/shopLeanPositionOffset) are imported from there.

export let shopLastLocation = null;

// #2623: updateShopAvatarPose/setShopAvatarAnimationState/updateShopAvatarIdle
// now live in src/shop/avatar.js.


// Read-only: the target actually cached for the avatar's *current* idle
// episode (null if not idle, or idle with nothing in range) -- see
// shopIdleInteractionTarget's own declaration above.
window.__testShopIdleInteractionTarget = () => shopIdleInteractionTarget;
// #2478: same "expose computed state purely for verification" convention
// as window.__shopAvatarOrientation/__testShopIdleInteractionTarget above
// -- lets an e2e test confirm the seated pose actually engages (the blend
// itself, the visual-only yaw/height offsets, and the leg/arm pivots
// actually bending into the seated silhouette) without needing pixel
// inspection.
window.__testShopSitPose = () => ({
  blend: shopSitBlend,
  yawOffset: shopSitYawOffset,
  heightOffset: shopSitHeightOffset,
  legRotationRad: shopAvatar.legPivotL.rotation.x,
  armRotationRad: shopAvatar.armPivotL.rotation.x,
  // #2480: this episode's own randomized settle delay/elapsed (see their
  // declarations above) -- lets a test confirm the delay itself varies
  // across repeated episodes, and that shopSitBlend really does stay 0
  // until shopSitSettleElapsedS catches up to it.
  settleDelayS: shopSitSettleDelayS,
  settleElapsedS: shopSitSettleElapsedS,
});
// #2479: same convention as window.__testShopSitPose just above, for the
// lean pose's own visual-only state.
window.__testShopLeanPose = () => ({
  blend: shopLeanBlend,
  yawOffset: shopLeanYawOffset,
  positionOffset: { ...shopLeanPositionOffset },
  // #2480: same settle-delay fields window.__testShopSitPose exposes above.
  settleDelayS: shopLeanSettleDelayS,
  settleElapsedS: shopLeanSettleElapsedS,
});





// A sign starts with no posts loaded — fetched once, here, right as it
// enters the world (rather than re-fetched on every proximity tick), then
// kept in sync locally by promptLeaveNote's own optimistic append. If the
// fetch loses the race with the landlet being unloaded again (camera
// wandered off before it resolved), the `shopSigns.includes` check drops
// the result on the floor rather than resurrecting sprites for a sign
// that's no longer in the scene.
export function registerShopSign(mesh, entry) {
  const sign = { mesh, group: entry.group, instanceId: mesh.userData.instanceId, posts: [], sprites: [] };
  shopSigns.push(sign);
  fetchSignPosts(sign.instanceId).then(({ posts }) => {
    if (!shopSigns.includes(sign)) return;
    sign.posts = posts;
    rebuildSignSprites(sign);
  }).catch(() => {});
}

function disposeSignSprites(sign) {
  for (const sprite of sign.sprites) {
    sign.group.remove(sprite);
    sprite.material.map?.dispose();
    sprite.material.dispose();
  }
  sign.sprites = [];
}

// Renders a canvas-texture Sprite per post (THREE Sprites always face the
// camera on their own, so this needs no manual billboarding) stacked
// vertically above the sign's own footprint. Capped at
// SIGN_MAX_VISIBLE_POSTS most-recent posts — an unbounded stack would
// eventually tower well past where the fade radius could ever make it
// readable anyway. Opacity starts at 0 and is driven entirely by
// updateSignFade() every frame, not set here.
function rebuildSignSprites(sign) {
  disposeSignSprites(sign);
  const baseHeight = meshDimensions(sign.mesh).height;
  const recent = sign.posts.slice(-SIGN_MAX_VISIBLE_POSTS);
  recent.forEach((post, i) => {
    const sprite = makeSignPostSprite(`${post.authorLabel}: ${post.text}`);
    // #1594: sign.mesh.position.z is the mesh's own vertical *center*, per
    // this codebase's ground-rest convention (createMeshForInstance sets
    // position.z = height / 2 by default) — the same convention
    // supportZ/itemZMax elsewhere in this file rely on to find a mesh's top
    // surface (mesh.position.z + height / 2). This used to add the mesh's
    // *full* height instead of half of it, overshooting the actual top
    // surface by another half-height and leaving posts hovering well above
    // the sign instead of just above its surface.
    sprite.position.set(sign.mesh.position.x, sign.mesh.position.y, sign.mesh.position.z + baseHeight / 2 + 0.4 + i * 0.5);
    sprite.material.opacity = 0;
    sign.group.add(sprite);
    sign.sprites.push(sprite);
  });
  // #1594: e2e-only hook (same "expose computed state purely for
  // verification" convention as window.__shopInstanceDisposedCount) --
  // lets a test confirm a post sprite's world-space z actually sits just
  // above the sign mesh's own top surface, without needing visual
  // inspection of the real 3D render.
  window.__lastSignSpriteDebug = { meshZ: sign.mesh.position.z, meshHeight: baseHeight, spriteZs: sign.sprites.map((s) => s.position.z) };
}

// A single line of white-on-dark text baked into a canvas texture — the
// simplest possible in-world text rendering, and enough for a short social
// post. Long posts (up to 280 chars server-side) are truncated for display;
// this is a floating nameplate-style sign, not a page to scroll.
function makeSignPostSprite(text) {
  const display = text.length > 70 ? `${text.slice(0, 69)}…` : text;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = 48;
  ctx.font = `${fontSize}px sans-serif`;
  const paddingX = 20;
  canvas.width = Math.ceil(ctx.measureText(display).width) + paddingX * 2;
  canvas.height = Math.round(fontSize * 1.7);
  // Sizing the canvas above resets its 2D context — font has to be set again
  // before the actual draw calls below.
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = 'rgba(20, 24, 18, 0.85)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f5f5f0';
  ctx.textBaseline = 'middle';
  ctx.fillText(display, paddingX, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  const WORLD_UNITS_PER_PX = 0.012; // tuned so a typical post reads clearly from SIGN_INTERACT_RADIUS_M away
  sprite.scale.set(canvas.width * WORLD_UNITS_PER_PX, canvas.height * WORLD_UNITS_PER_PX, 1);
  return sprite;
}

// Community calendar — same lifecycle/rendering as the community-sign
// functions just above (registerShopSign/disposeSignSprites/
// rebuildSignSprites), reusing makeSignPostSprite directly since it's
// generic single-line text-sprite rendering with nothing sign-specific in
// its implementation despite the name.
export function registerShopCalendar(mesh, entry) {
  const calendar = { mesh, group: entry.group, instanceId: mesh.userData.instanceId, events: [], sprites: [] };
  shopCalendars.push(calendar);
  fetchCalendarEvents(calendar.instanceId).then(({ events }) => {
    if (!shopCalendars.includes(calendar)) return;
    calendar.events = events;
    rebuildCalendarSprites(calendar);
  }).catch(() => {});
}

function disposeCalendarSprites(calendar) {
  for (const sprite of calendar.sprites) {
    calendar.group.remove(sprite);
    sprite.material.map?.dispose();
    sprite.material.dispose();
  }
  calendar.sprites = [];
}

function rebuildCalendarSprites(calendar) {
  disposeCalendarSprites(calendar);
  const baseHeight = meshDimensions(calendar.mesh).height;
  const recent = calendar.events.slice(-SIGN_MAX_VISIBLE_POSTS);
  recent.forEach((event, i) => {
    const sprite = makeSignPostSprite(`${event.authorLabel}: ${event.text}`);
    // #1642: calendar.mesh.position.z is the mesh's own vertical *center*
    // (createMeshForInstance's ground-rest convention) — see
    // rebuildSignSprites' own comment just above (#1594) for the full
    // reasoning this sibling function was missing.
    sprite.position.set(calendar.mesh.position.x, calendar.mesh.position.y, calendar.mesh.position.z + baseHeight / 2 + 0.4 + i * 0.5);
    sprite.material.opacity = 0;
    calendar.group.add(sprite);
    calendar.sprites.push(sprite);
  });
  // #1642: same e2e-verification hook as rebuildSignSprites' own
  // window.__lastSignSpriteDebug (#1594).
  window.__lastCalendarSpriteDebug = { meshZ: calendar.mesh.position.z, meshHeight: baseHeight, spriteZs: calendar.sprites.map((s) => s.position.z) };
}

// Called every Shop-mode frame (not throttled like updateShopProximity —
// opacity needs to read as a smooth fade, not a 400ms-stepped one). Two
// independent jobs: fade every loaded sign's post sprites by the camera's
// distance to that sign, and track which single nearest in-range sign (if
// any) #shop-sign-hint currently targets.
export function updateSignFade() {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const sign of shopSigns) {
    const world = sign.mesh.getWorldPosition(scratchSignWorldPos);
    const distance = world.distanceTo(camera.position);
    const opacity = 1 - THREE.MathUtils.clamp(
      (distance - SIGN_FADE_NEAR_M) / (SIGN_FADE_FAR_M - SIGN_FADE_NEAR_M), 0, 1,
    );
    for (const sprite of sign.sprites) sprite.material.opacity = opacity;
    if (distance <= SIGN_INTERACT_RADIUS_M && distance < nearestDistance) {
      nearest = sign;
      nearestDistance = distance;
    }
  }
  if (nearest !== nearestActiveSign) {
    nearestActiveSign = nearest;
    shopSignHintEl.classList.toggle('visible', !!nearest);
  }
}
const scratchSignWorldPos = new THREE.Vector3();

// Community calendar's own per-frame fade — identical logic to
// updateSignFade above, over shopCalendars instead of shopSigns.
export function updateCalendarFade() {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const calendar of shopCalendars) {
    const world = calendar.mesh.getWorldPosition(scratchSignWorldPos);
    const distance = world.distanceTo(camera.position);
    const opacity = 1 - THREE.MathUtils.clamp(
      (distance - SIGN_FADE_NEAR_M) / (SIGN_FADE_FAR_M - SIGN_FADE_NEAR_M), 0, 1,
    );
    for (const sprite of calendar.sprites) sprite.material.opacity = opacity;
    if (distance <= SIGN_INTERACT_RADIUS_M && distance < nearestDistance) {
      nearest = calendar;
      nearestDistance = distance;
    }
  }
  if (nearest !== nearestActiveCalendar) {
    nearestActiveCalendar = nearest;
    shopCalendarHintEl.classList.toggle('visible', !!nearest);
  }
}

// Every placed instance starts with no reviews loaded — fetched once, here,
// right as it enters the world, keyed by the instance's underlying
// templateId (the product), not its own instanceId, since the same review
// list is shared by every placement of that product. Each placement fetches
// independently rather than sharing a per-template cache — a shopper
// posting a review near one placement won't instantly update another
// loaded instance of the same product elsewhere (an edge case rare enough,
// and purely cosmetic enough, that a shared cache isn't worth the added
// bookkeeping here).
export function registerShopReview(mesh, entry) {
  const review = { mesh, group: entry.group, templateId: mesh.userData.template.templateId, reviews: [], sprites: [] };
  shopReviews.push(review);
  fetchProductReviews(review.templateId).then(({ reviews }) => {
    if (!shopReviews.includes(review)) return;
    review.reviews = reviews;
    rebuildReviewSprites(review);
  }).catch(() => {});
}

function disposeReviewSprites(review) {
  for (const sprite of review.sprites) {
    review.group.remove(sprite);
    sprite.material.map?.dispose();
    sprite.material.dispose();
  }
  review.sprites = [];
}

function rebuildReviewSprites(review) {
  disposeReviewSprites(review);
  const baseHeight = meshDimensions(review.mesh).height;
  const recent = review.reviews.slice(-SIGN_MAX_VISIBLE_POSTS);
  recent.forEach((r, i) => {
    const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
    const label = r.text ? `${r.authorLabel} ${stars}: ${r.text}` : `${r.authorLabel} ${stars}`;
    const sprite = makeSignPostSprite(label);
    // #1642: same mesh-center-vs-base fix as rebuildCalendarSprites/
    // rebuildSignSprites (#1594) just above — review.mesh.position.z is
    // the mesh's own vertical center, not its base.
    sprite.position.set(review.mesh.position.x, review.mesh.position.y, review.mesh.position.z + baseHeight / 2 + 0.4 + i * 0.5);
    sprite.material.opacity = 0;
    review.group.add(sprite);
    review.sprites.push(sprite);
  });
  // #1642: same e2e-verification hook as rebuildSignSprites' own
  // window.__lastSignSpriteDebug (#1594).
  window.__lastReviewSpriteDebug = { meshZ: review.mesh.position.z, meshHeight: baseHeight, spriteZs: review.sprites.map((s) => s.position.z) };
}

// Product reviews' own per-frame fade — identical logic to updateSignFade/
// updateCalendarFade above, over shopReviews instead of shopSigns. Also
// drives the buy/review hints' visibility: tapped (shopTappedProduct) AND
// still within interact range, recomputed every frame so walking away from
// a tapped product hides its buttons again without needing a fresh tap.
export function updateReviewFade() {
  let tappedDistance = Infinity;
  for (const review of shopReviews) {
    const world = review.mesh.getWorldPosition(scratchSignWorldPos);
    const distance = world.distanceTo(camera.position);
    // #1800: unlike signs/calendars, a review should only be visible once its
    // product has actually been tapped -- pure proximity (the shared
    // SIGN_FADE_NEAR_M/FAR_M curve below) still governs *how* it fades in for
    // the tapped product, it just no longer applies to every nearby review.
    const opacity = review === shopTappedProduct
      ? 1 - THREE.MathUtils.clamp(
        (distance - SIGN_FADE_NEAR_M) / (SIGN_FADE_FAR_M - SIGN_FADE_NEAR_M), 0, 1,
      )
      : 0;
    for (const sprite of review.sprites) sprite.material.opacity = opacity;
    if (review === shopTappedProduct) tappedDistance = distance;
  }
  const tappedInRange = !!shopTappedProduct && tappedDistance <= SIGN_INTERACT_RADIUS_M;
  // #1810: the mesh highlight shares the Buy/Review hints' own range gate —
  // walking out of SIGN_INTERACT_RADIUS_M clears it the same way it hides
  // those buttons, rather than leaving a highlight glowing on a product the
  // shopper is no longer actually standing next to.
  const desiredHighlight = tappedInRange ? shopTappedProduct : null;
  if (desiredHighlight !== shopHighlightedProduct) {
    if (shopHighlightedProduct) removeSelectionOutline(shopHighlightedProduct.mesh);
    if (desiredHighlight) addSelectionOutline(desiredHighlight.mesh);
    shopHighlightedProduct = desiredHighlight;
  }
  // #994: recompute on a tapped-product change too, not just a tappedInRange
  // flip -- two nearby in-range products can be tapped one after another
  // without tappedInRange ever toggling, which used to leave the hints
  // showing the previous product's priced state for the new one.
  if (tappedInRange !== shopReviewHintsVisible || shopTappedProduct !== shopReviewHintsProduct) {
    shopReviewHintsVisible = tappedInRange;
    shopReviewHintsProduct = shopTappedProduct;
    shopProductPreviewReviewBtn.classList.toggle('visible', tappedInRange);
    // Only a priced product has anything to "buy" — an unpriced one (the
    // common case for most placeholder catalog items) shows no buy button at
    // all rather than one that would just 400 on click. #1946 (owner
    // correction): a test/demo model is never purchasable either, even on
    // the rare chance it somehow carried a price — same "hide the
    // affordance entirely" treatment as the unpriced case, not a disabled
    // button. tappedInRange's own !!shopTappedProduct check (above) is what
    // makes the short-circuit here safe -- shopTappedProduct can be null
    // while tappedInRange is false.
    const canBuy = tappedInRange
      && shopTappedProduct.mesh.userData.template.priceCents != null
      && !shopTappedProduct.mesh.userData.template.isTestModel;
    shopProductPreviewBuyBtn.classList.toggle('visible', canBuy);
    // #659: same gate as the Buy button just above — a return policy only
    // matters for something with a price to actually refund.
    shopProductPreviewReturnPolicyBtn.classList.toggle('visible', canBuy);
  }
}

// Shared by the tap handler below and formerly by proximity — the actual
// "name — price (disclaimer)" line the preview modal (#shop-product-preview-info)
// shows once tapped.
function productInfoText(template) {
  const {
    name, priceCents, metadata, category, skeletonSignature, isTestModel,
  } = template;
  let text = priceCents == null ? name : `${name} — ${formatPriceCents(priceCents)}`;
  // #1946 (owner correction): a test/demo model must read as obviously not
  // a real product wherever a shopper sees it, same tap-to-inspect
  // disclosure slot as the digital-goods/domestic-only/no-returns notes
  // below -- shown first since it overrides the ordinary "is this for
  // sale" assumption the rest of this text otherwise implies.
  if (isTestModel) text += ' (Testing Model — not a real product, not for sale)';
  // The "clear higglehaven-controlled disclaimer" digital goods require
  // (docs/SPEC.md §4) — shown to the shopper right where they'd otherwise
  // assume every placed item is a physical one.
  const disclaimerKey = metadata?.digitalGoodDisclaimer;
  if (disclaimerKey) text += ` (${DIGITAL_GOOD_DISCLAIMER_TEXT[disclaimerKey]})`;
  // docs/SPEC.md §5's shipping disclosure ("ships to United States only")
  // — same tap-to-inspect treatment as the digital-goods disclaimer above,
  // shown right where a shopper would otherwise assume every item ships
  // internationally like the rest of the catalog.
  if (metadata?.domesticOnly) text += ' (ships to United States only)';
  // #659 (owner, Control Room, 2026-09-11): a shopper had no way to see a
  // product's own return policy before buying it — this is the same
  // tap-to-inspect disclosure slot the digital-goods/domestic-only notes
  // above already use, so a no-returns product reads the same way those
  // do: right where a shopper would otherwise assume every item can be
  // returned like the rest of the catalog. A product that DOES accept
  // returns gets no extra text here — the general 99% refund policy
  // (see the Return Policy link this same tap also reveals, below) already
  // covers the default case, and repeating "returns accepted" on every
  // single product would just be noise.
  if (metadata?.noReturns) text += ' (no returns)';
  // #1164 (sub-issue of #1161): same tap-to-inspect disclosure slot as the
  // notes above, so a shopper sees whether a standalone animation will
  // actually play against their own currently-equipped avatar before
  // buying it, rather than discovering that only after purchase.
  if (category === 'animation') {
    text += ` (${animationCompatibilityLabel(animationCompatibility(skeletonSignature, shopEquippedAvatarSkeletonSignature))})`;
  }
  return text;
}

// Walks up from a raycast hit (a model's own nested child mesh — see
// loadModelInstance) to whichever shopReviews entry's root mesh is its
// ancestor, the same findRootProduct pattern Build mode's own click
// handler uses against productMeshes.
function findTappedShopProduct(object) {
  let current = object;
  while (current) {
    const review = shopReviews.find((r) => r.mesh === current);
    if (review) return review;
    current = current.parent;
  }
  return null;
}

// #1811 (sub-issue of #1809): isolated 3D preview for a tapped product,
// replacing the old #shop-product-info pill (removed in #1813). Same
// self-contained-scene technique as Sell mode's own showAxisPreview/
// disposeAxisPreview (see that function's own comment, above) — a
// dedicated scene/camera/renderer/controls bound to this modal's own
// canvas, built via createMeshForInstance so a real scanned model (or
// placeholder box) renders exactly as it would in the world, not a
// simplified stand-in. No axis arrows here (this modal is read-only
// "what is this," not the Extensibility editor those arrows serve), and
// no shared-canvas reparenting (this canvas always lives in this one
// modal's own markup, unlike the seller preview's single canvas moved
// between row panels).
let shopProductPreview = null;
// Same reopen-before-the-previous-load-finishes guard as
// axisPreviewLoadToken — a quick double-tap, or tapping a second product
// before createMeshForInstance's await on the first resolves, would
// otherwise race two calls into building their own renderer bound to the
// same canvas.
let shopProductPreviewLoadToken = 0;

function disposeShopProductPreview() {
  if (!shopProductPreview) return;
  shopProductPreview.controls.dispose();
  shopProductPreview.renderer.dispose();
  disposeObject(shopProductPreview.previewObject);
  shopProductPreview = null;
}

async function showShopProductPreview(template) {
  const myLoadToken = ++shopProductPreviewLoadToken;
  disposeShopProductPreview();

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(2, -3, 4);
  scene.add(sun);

  // #1876: lets an e2e test simulate a slow load deterministically, same
  // reasoning as window.__testUploadPreviewLoadDelayMs (#1465). Always
  // undefined outside of that one test.
  if (window.__testShopProductPreviewLoadDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, window.__testShopProductPreviewLoadDelayMs));
  }
  // At the origin and with no crop, same as showAxisPreview — shows the
  // product's real full-size geometry, not the specific crop any one
  // placed instance of it happens to have in the world.
  const previewObject = await createMeshForInstance({
    templateId: template.templateId,
    x: 0, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0,
    crop: {},
  });
  if (myLoadToken !== shopProductPreviewLoadToken) {
    // A newer call owns the preview now — same superseded-load leak guard
    // showAxisPreview uses: this object was never added to any scene the
    // dispose function above knows about.
    if (previewObject) disposeObject(previewObject);
    // Exposed purely so an e2e test can confirm the dispose above actually
    // ran, same reasoning as window.__supersededUploadPreviewDisposals (#1465).
    window.__supersededShopProductPreviewDisposals = (window.__supersededShopProductPreviewDisposals ?? 0) + 1;
    return;
  }
  if (!previewObject) return;
  scene.add(previewObject);

  const box = new THREE.Box3().setFromObject(previewObject);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.05);

  const rect = shopProductPreviewCanvas.getBoundingClientRect();
  const camera = new THREE.PerspectiveCamera(45, rect.width / Math.max(rect.height, 1), 0.01, 100);
  camera.up.set(0, 0, 1);
  const dist = radius * 2.6;
  camera.position.set(dist * 0.75, -dist * 0.95, dist * 0.65);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas: shopProductPreviewCanvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(rect.width, rect.height, false);

  const controls = new OrbitControls(camera, shopProductPreviewCanvas);
  controls.target.set(0, 0, 0);
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.minDistance = dist * 0.35;
  controls.maxDistance = dist * 3;
  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render);

  render();
  shopProductPreview = { renderer, scene, camera, controls, previewObject };
}

function openShopProductPreviewModal(review) {
  shopProductPreviewModalEl.classList.add('visible');
  shopProductPreviewInfoEl.textContent = productInfoText(review.mesh.userData.template);
  openModalA11y(shopProductPreviewModalEl, closeShopProductPreviewModal);
  showShopProductPreview(review.mesh.userData.template);
}

function closeShopProductPreviewModal() {
  shopProductPreviewModalEl.classList.remove('visible');
  // #1876: bump the token even though there's nothing to dispose yet if a
  // showShopProductPreview() call is still in flight -- without this, that
  // call's own stale-load check (myLoadToken !== shopProductPreviewLoadToken)
  // never fires, so it finishes building a full scene/renderer/controls
  // after the modal is already closed and assigns it as the live
  // shopProductPreview, leaking a WebGL context until the next preview open.
  shopProductPreviewLoadToken++;
  disposeShopProductPreview();
  closeModalA11y(shopProductPreviewModalEl);
}
shopProductPreviewCloseBtn.addEventListener('click', closeShopProductPreviewModal);

// Tap-to-inspect: Shop mode has no other use for a plain single-finger tap
// on open canvas (movement/look are joystick-driven, pinch-zoom needs two
// fingers — see the pointerdown/pointermove pair just above), so this is
// free to use for "what is this." Tapping a product shows its info;
// tapping anything else (ground, sky, empty space) dismisses whatever was
// showing, the same "tap away to close" a shopper would expect.
renderer.domElement.addEventListener('click', (event) => {
  if (!shopActive) return;
  if (pointerDownPos) {
    const dx = event.clientX - pointerDownPos.x;
    const dy = event.clientY - pointerDownPos.y;
    if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) return;
  }
  raycaster.setFromCamera(ndcFromEvent(event), camera);
  const hits = raycaster.intersectObjects(shopReviews.map((r) => r.mesh), true);
  const review = hits.length > 0 ? findTappedShopProduct(hits[0].object) : null;
  shopTappedProduct = review;
  if (review) openShopProductPreviewModal(review);
  else closeShopProductPreviewModal();
});

// event.triggeredAt is only ever set once a trigger request's own .then()
// resolves — with nothing tracking a request already in flight, a call
// slower than one 10s check interval (slow network, a throttled
// backgrounded tab, or many due events firing in the same tick) let the
// next tick re-issue a request for that same still-untriggered event.
// pendingCalendarEventTriggers closes that gap; eventId is unique enough
// on its own (no instanceId needed) since it's never reused across events.
const pendingCalendarEventTriggers = new Set();
export function checkScheduledCalendarEvents() {
  const nowIso = new Date().toISOString();
  for (const calendar of shopCalendars) {
    for (const event of calendar.events) {
      if (!event.scheduledAt || event.triggeredAt || event.scheduledAt > nowIso) continue;
      if (pendingCalendarEventTriggers.has(event.eventId)) continue;
      pendingCalendarEventTriggers.add(event.eventId);
      triggerCalendarEvent(calendar.instanceId, event.eventId).then(({ event: updated, triggered }) => {
        // Cache the server's own triggeredAt locally regardless of who
        // actually won the race, so a lost race doesn't keep retrying
        // this same event every 10 seconds for the rest of the visit.
        event.triggeredAt = updated.triggeredAt;
        // #436: this request's own await is a real gap the landlet can
        // unload (or reload with a fresh calendar object of the same
        // instanceId) across — unloadShopLandletInstances already
        // disposes calendar.group/sprites in that case, so spawning into
        // it here would burst confetti into a detached, no-longer-in-
        // scene Three.js group. Same guard the click-driven sign-post/
        // calendar-event handlers already use for #426.
        if (triggered && shopCalendars.includes(calendar)) spawnConfettiBurst(calendar.mesh.position, calendar.group);
        pendingCalendarEventTriggers.delete(event.eventId);
      }).catch(() => { pendingCalendarEventTriggers.delete(event.eventId); });
    }
  }
}

// A lightweight, dependency-free particle burst — small flat tumbling
// squares with an outward+upward launch velocity and simple downward
// gravity, faded out and disposed once their short lifespan ends. Not
// literally "a confetti cannon" (the spec's own phrase is one illustrative
// example of "creative-tool support," not a specific effect to replicate
// pixel-for-pixel) — this is the same idea in the simplest form this
// app's existing rendering toolkit (plain THREE.Mesh, no particle-system
// library) can produce cheaply.
const CONFETTI_COLORS = [0xff6b6b, 0xffd93d, 0x6bcb77, 0x4d96ff, 0xff922b, 0xda77f2];
const CONFETTI_PARTICLE_COUNT = 24;
const CONFETTI_GRAVITY_M_S2 = 4;
const CONFETTI_LIFESPAN_S = 2.5;
const confettiBursts = [];

function spawnConfettiBurst(localPosition, group) {
  const particles = [];
  for (let i = 0; i < CONFETTI_PARTICLE_COUNT; i++) {
    const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    const geometry = new THREE.PlaneGeometry(0.12, 0.12);
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(localPosition);
    mesh.position.z += 0.3; // launches from just above the calendar's own footprint, not its exact center
    group.add(mesh);
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.5 + Math.random() * 2;
    particles.push({
      mesh,
      velocity: new THREE.Vector3(Math.cos(angle) * speed, Math.sin(angle) * speed, 3 + Math.random() * 2),
      spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8),
    });
  }
  confettiBursts.push({ particles, group, elapsed: 0 });
}

function disposeConfettiBurst(burst) {
  for (const particle of burst.particles) {
    burst.group.remove(particle.mesh);
    particle.mesh.geometry.dispose();
    particle.mesh.material.dispose();
  }
}

export function updateConfettiBursts(dt) {
  for (const burst of [...confettiBursts]) {
    burst.elapsed += dt;
    const fade = 1 - THREE.MathUtils.clamp(burst.elapsed / CONFETTI_LIFESPAN_S, 0, 1);
    for (const particle of burst.particles) {
      particle.velocity.z -= CONFETTI_GRAVITY_M_S2 * dt;
      particle.mesh.position.addScaledVector(particle.velocity, dt);
      particle.mesh.rotation.x += particle.spin.x * dt;
      particle.mesh.rotation.y += particle.spin.y * dt;
      particle.mesh.rotation.z += particle.spin.z * dt;
      particle.mesh.material.opacity = fade;
    }
    if (burst.elapsed >= CONFETTI_LIFESPAN_S) {
      disposeConfettiBurst(burst);
      confettiBursts.splice(confettiBursts.indexOf(burst), 1);
    }
  }
}

// #1830 (owner correction, 2026-10-13): sign posts used to be genuinely
// anonymous (a free-text name prompt, no account behind it) — stale since
// Shop mode's own entry gate (ensureShopperIdentity) started requiring a
// real logged-in, verified account; currentAuthUser.username is always
// available by the time this can be clicked at all. The one exception is
// the accountRecoveryFlowActive branch of enterShopMode, which deliberately
// skips that gate — createSignPost/editSignPost/deleteSignPost below just
// 401 in that edge case, same as any other authenticated action attempted
// mid-recovery.
shopSignHintEl.addEventListener('click', async () => {
  const sign = nearestActiveSign;
  if (!sign) return;
  // A shopper who already has a post on this particular sign edits or
  // removes that one instead of being offered an unrelated second slot —
  // this mirrors the one-note-per-sign feel the old shopperLabel() prompt
  // already had in practice (nothing stopped multiple posts before, but
  // nothing invited them either), while actually using the real ownership
  // #1830 adds (sign.posts' own userId, populated from signPostFromRow).
  const myPost = currentAuthUser && sign.posts.find((post) => post.userId === currentAuthUser.userId);
  if (myPost) {
    const choice = (prompt(
      `Your note on this sign: "${myPost.text}"\n\nType "edit" to change it, or "delete" to remove it. Leave blank to cancel.`,
      '',
    ) || '').trim().toLowerCase();
    if (choice === 'delete') {
      shopSignHintEl.disabled = true;
      try {
        await deleteSignPost(sign.instanceId, myPost.postId);
        if (!shopSigns.includes(sign)) return;
        sign.posts = sign.posts.filter((post) => post.postId !== myPost.postId);
        rebuildSignSprites(sign);
      } catch (err) {
        alert(err.message || 'Could not delete this note.');
      } finally {
        shopSignHintEl.disabled = false;
      }
    } else if (choice === 'edit') {
      const text = prompt('Your note (up to 280 characters):', myPost.text);
      if (!text || !text.trim()) return;
      // #2015: same #1920 guard as the sibling create path below -- prompt()
      // shows no live character count, and without this an over-length edit
      // reaches the server's own 280-char check, throws, and the retyped note
      // is lost since the prompt isn't reopened with the text prefilled.
      if (text.trim().length > 280) {
        alert('Keep it to 280 characters or fewer.');
        return;
      }
      shopSignHintEl.disabled = true;
      try {
        const updated = await editSignPost(sign.instanceId, myPost.postId, { text: text.trim() });
        if (!shopSigns.includes(sign)) return;
        const index = sign.posts.findIndex((post) => post.postId === myPost.postId);
        if (index !== -1) sign.posts[index] = updated;
        rebuildSignSprites(sign);
      } catch (err) {
        alert(err.message || 'Could not update this note.');
      } finally {
        shopSignHintEl.disabled = false;
      }
    }
    return;
  }
  const text = prompt('Your note (up to 280 characters):', '');
  if (!text || !text.trim()) return;
  // #1920: prompt() shows no live character count, and unlike the DM
  // compose field (a real <input maxlength="280">), nothing here stops an
  // over-length submission from reaching the server's own 280-char check
  // (worker/index.js) -- which then throws, and prompt() isn't reopened
  // with the text prefilled, so the whole note has to be retyped from
  // scratch. Catch it client-side instead.
  if (text.trim().length > 280) {
    alert('Keep it to 280 characters or fewer.');
    return;
  }
  shopSignHintEl.disabled = true;
  try {
    const post = await createSignPost(sign.instanceId, { text: text.trim() });
    // The landlet this sign belongs to can unload while the request above
    // was in flight (registerShopSign's own fetch has the same guard, for
    // the same reason — see its own comment) — without this, a post that
    // resolves after the sign is gone still gets added to its still-live
    // THREE.Group, an orphaned sprite nothing will ever dispose (#426).
    if (!shopSigns.includes(sign)) return;
    sign.posts.push(post);
    rebuildSignSprites(sign);
  } catch (err) {
    alert(err.message || 'Could not post to this sign.');
  } finally {
    shopSignHintEl.disabled = false;
  }
});

shopCalendarHintEl.addEventListener('click', async () => {
  const calendar = nearestActiveCalendar;
  if (!calendar) return;
  // Unlike signs (a real logged-in shopper, since #1830), docs/SPEC.md §6
  // calls calendar events "builder-authored" — the server derives
  // authorLabel from a real logged-in builder and rejects anyone but the
  // hosting landlet's own owner, so this needs a builder identity
  // specifically, not just any logged-in shopper.
  const builder = await ensureBuilderIdentity();
  if (!builder) return;
  const text = prompt('Event details (up to 280 characters):', '');
  if (!text || !text.trim()) return;
  // #1920: same missing client-side check as the sign-post prompt above --
  // see its own comment for why this matters (prompt() gives no live
  // count, and loses the whole typed text on a server-side rejection).
  if (text.trim().length > 280) {
    alert('Keep it to 280 characters or fewer.');
    return;
  }
  // Optional third step — most events are just a plain announcement (the
  // two prompts above already cover that), a real scheduled moment (the
  // spec's own "creative-tool support like a scheduled confetti-cannon
  // trigger") is an explicit extra ask. Left blank, this posts exactly
  // like it always has.
  const scheduleInput = prompt(
    'Schedule a special moment? Enter a date/time (e.g. 2026-08-26T20:00), or leave blank for just a note:', '',
  );
  let scheduledAt;
  if (scheduleInput && scheduleInput.trim()) {
    const parsed = new Date(scheduleInput.trim());
    if (Number.isNaN(parsed.getTime())) {
      alert('Could not understand that date/time — try a format like 2026-08-26T20:00. Posting without a scheduled moment.');
    } else {
      scheduledAt = parsed.toISOString();
    }
  }
  shopCalendarHintEl.disabled = true;
  try {
    const event = await createCalendarEvent(calendar.instanceId, { text: text.trim(), scheduledAt });
    // The window between the two prompts and the ensureBuilderIdentity()
    // auth-modal wait above is genuinely unbounded — the landlet this
    // calendar belongs to can unload well before this request resolves.
    // registerShopCalendar's own fetch already guards against exactly
    // this; without the same check here, a post that resolves after the
    // calendar is gone still gets added to its still-live THREE.Group, an
    // orphaned sprite nothing will ever dispose (#426).
    if (!shopCalendars.includes(calendar)) return;
    calendar.events.push(event);
    rebuildCalendarSprites(calendar);
  } catch (err) {
    alert(err.message || 'Could not post to this calendar.');
  } finally {
    shopCalendarHintEl.disabled = false;
  }
});

async function handleShopProductReviewClick() {
  const review = shopTappedProduct;
  if (!review) return;
  // #1113: the server now derives authorship from a real logged-in builder
  // and verifies an actual purchase, not a caller-supplied name matched
  // against a free-text label (#893's spoofing gap) — same "builder-
  // authored, needs a real identity" shape the calendar hint above already
  // uses, replacing this handler's own former shopperLabel() name prompt.
  const builder = await ensureBuilderIdentity();
  if (!builder) return;
  // #1975 (owner decision): a shopper who already reviewed this product
  // edits or removes that one review instead of being offered an unrelated
  // second slot — mirrors the sign-post hint's own myPost pattern (#1830)
  // exactly, using review.userId (reviewFromRow, populated server-side from
  // the posting session) rather than a free-text author match.
  const myReview = currentAuthUser && review.reviews.find((r) => r.userId === currentAuthUser.userId);
  if (myReview) {
    const stars = '★'.repeat(myReview.rating) + '☆'.repeat(5 - myReview.rating);
    const choice = (prompt(
      `Your review: ${stars}${myReview.text ? ` "${myReview.text}"` : ''}\n\nType "edit" to change it, or "delete" to remove it. Leave blank to cancel.`,
      '',
    ) || '').trim().toLowerCase();
    if (choice === 'delete') {
      shopProductPreviewReviewBtn.disabled = true;
      try {
        await deleteProductReview(review.templateId, myReview.reviewId);
        if (!shopReviews.includes(review)) return;
        review.reviews = review.reviews.filter((r) => r.reviewId !== myReview.reviewId);
        rebuildReviewSprites(review);
      } catch (err) {
        alert(err.message || 'Could not delete this review.');
      } finally {
        shopProductPreviewReviewBtn.disabled = false;
      }
    } else if (choice === 'edit') {
      const ratingInput = prompt('Rate this product 1-5 stars:', String(myReview.rating));
      if (!ratingInput || !ratingInput.trim()) return;
      const rating = Number(ratingInput.trim());
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        alert('Please enter a whole number from 1 to 5.');
        return;
      }
      const text = prompt('Add a comment (up to 280 characters), or leave blank:', myReview.text || '');
      // #2005's own fix only covered the create path right below this one
      // -- same missing guard, same data-loss consequence on edit.
      if (text && text.trim().length > 280) {
        alert('Keep it to 280 characters or fewer.');
        return;
      }
      shopProductPreviewReviewBtn.disabled = true;
      try {
        // Cancelling (null) omits `text` entirely so the server keeps the
        // existing value — an explicit empty string (OK clicked with the
        // field cleared) is sent as-is, clearing it, same distinction
        // editProductReview's own `text !== undefined` check preserves.
        const updated = await editProductReview(review.templateId, myReview.reviewId, {
          rating, text: text === null ? undefined : text.trim(),
        });
        if (!shopReviews.includes(review)) return;
        const index = review.reviews.findIndex((r) => r.reviewId === myReview.reviewId);
        if (index !== -1) review.reviews[index] = updated;
        rebuildReviewSprites(review);
      } catch (err) {
        alert(err.message || 'Could not update this review.');
      } finally {
        shopProductPreviewReviewBtn.disabled = false;
      }
    }
    return;
  }
  const ratingInput = prompt('Rate this product 1-5 stars:', '5');
  if (!ratingInput || !ratingInput.trim()) return;
  const rating = Number(ratingInput.trim());
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    alert('Please enter a whole number from 1 to 5.');
    return;
  }
  // A star rating alone is already a complete, useful review — this text
  // prompt is an optional extra, same as the calendar hint's own scheduling
  // step above.
  const text = prompt('Add a comment (up to 280 characters), or leave blank:', '');
  // #2005: same missing client-side check #1920 already added to the
  // sign-post/calendar-event prompts above -- prompt() gives no live
  // character count, and an over-length submission loses the whole typed
  // comment on the server's own 280-char rejection.
  if (text && text.trim().length > 280) {
    alert('Keep it to 280 characters or fewer.');
    return;
  }
  shopProductPreviewReviewBtn.disabled = true;
  try {
    const posted = await createProductReview(review.templateId, { rating, text: text?.trim() || undefined });
    // Same unloaded-landlet guard as the sign-post and calendar handlers
    // above (#426) — registerShopReview's own fetch already checks this.
    if (!shopReviews.includes(review)) return;
    review.reviews.push(posted);
    rebuildReviewSprites(review);
  } catch (err) {
    alert(err.message || 'Could not review this product.');
  } finally {
    shopProductPreviewReviewBtn.disabled = false;
  }
}
shopProductPreviewReviewBtn.addEventListener('click', handleShopProductReviewClick);

// #453: Stripe.js is loaded lazily, only the first time a real-money
// checkout is actually needed — the overwhelming majority of purchases in
// this dev-mode-heavy app never reach this path (see purchaseInstance's
// own comment in src/api.js), so there's no reason to pull in a
// third-party script on every page load.
let stripeJsPromise = null;
// #2554: src/account/auth.js's own card-verification step also needs
// this (exactly the same lazy-load-once shape the Shop-mode checkout
// flow below already relies on) -- exported rather than left internal
// since loadStripeJs/stripeJsPromise themselves still live here, pending
// the eventual src/shop/mode.js extraction.
export function loadStripeJs() {
  if (stripeJsPromise) return stripeJsPromise;
  stripeJsPromise = new Promise((resolve, reject) => {
    if (window.Stripe) { resolve(window.Stripe); return; }
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.onload = () => resolve(window.Stripe);
    script.onerror = () => { stripeJsPromise = null; reject(new Error('Could not load Stripe.')); };
    document.head.appendChild(script);
  });
  return stripeJsPromise;
}

let checkoutCardElement = null;
let rejectCheckoutFlow = null;

// #1730: this used to only hide the modal -- registered as the modal's own
// Escape handler via openModalA11y below, but runCheckoutFlow's own promise
// contract (see its comment just below) says this modal can only be left by
// resolving or rejecting that promise. Escape skipped that step entirely,
// leaving the promise permanently unsettled (and the caller's own `finally`
// never running) if the shopper dismissed with Escape instead of the
// Cancel button. Now shares the same reject call checkoutCancelBtn's own
// handler uses, so Escape and Cancel behave identically -- same fix shape
// #1679 already applied to the Friends-map/DM modal's own Escape gap.
function closeCheckoutModal() {
  checkoutModalEl.classList.remove('visible');
  closeModalA11y(checkoutModalEl);
  if (checkoutCardElement) {
    checkoutCardElement.unmount();
    checkoutCardElement = null;
  }
  if (rejectCheckoutFlow) {
    const reject = rejectCheckoutFlow;
    rejectCheckoutFlow = null;
    reject(new Error('Checkout cancelled.'));
  }
}

// Collects real payment for a connected seller's product, once
// purchaseInstance's response comes back as `requiresPayment` instead of
// an already-completed `purchase` (#453). The returned promise resolves
// with `{ purchase, deliveryConfirmUrl }` (see finalizePurchase in
// src/api.js — the latter is only set for a physical real-money purchase,
// #454) once the purchase has genuinely been finalized (Stripe confirmed
// the charge AND the server has recorded it), or rejects if the buyer
// cancels — it deliberately does NOT resolve just because the modal was
// shown, so a caller's own `finally` (e.g. re-enabling the button that
// opened this) covers the whole checkout, not just the initial setup.
function runCheckoutFlow({ clientSecret, paymentIntentId, publishableKey }, { name, totalCents }) {
  return new Promise((resolve, reject) => {
    checkoutSummaryEl.textContent = `${name} — ${formatPriceCents(totalCents)}`;
    checkoutStatusEl.textContent = 'Loading payment form…';
    checkoutStatusEl.classList.remove('error');
    checkoutPayBtn.disabled = true;
    checkoutCancelBtn.disabled = false;
    checkoutModalEl.classList.add('visible');
    // #1730: closeCheckoutModal itself now rejects (see its own comment)
    // once rejectCheckoutFlow is armed here, so Escape (wired to it via
    // openModalA11y) and the explicit Cancel button settle this promise
    // identically.
    rejectCheckoutFlow = reject;
    openModalA11y(checkoutModalEl, closeCheckoutModal);

    checkoutCancelBtn.onclick = closeCheckoutModal;

    loadStripeJs().then((Stripe) => {
      const stripe = Stripe(publishableKey);
      const elements = stripe.elements();
      checkoutCardElement = elements.create('card');
      checkoutCardElement.mount(checkoutCardElementEl);
      checkoutStatusEl.textContent = '';
      checkoutPayBtn.disabled = false;

      checkoutPayBtn.onclick = async () => {
        checkoutPayBtn.disabled = true;
        // #841: the card is genuinely charged once confirmCardPayment
        // resolves, so Cancel can't stay clickable during this await —
        // otherwise a cancel-click here settles this promise as rejected
        // while the charge (and the finalize call below) still goes
        // through for real, silently reporting a completed purchase as
        // cancelled.
        checkoutCancelBtn.disabled = true;
        checkoutStatusEl.textContent = 'Processing…';
        checkoutStatusEl.classList.remove('error');
        try {
          const result = await stripe.confirmCardPayment(clientSecret, { payment_method: { card: checkoutCardElement } });
          if (result.error) throw new Error(result.error.message || 'Payment failed.');
          const finalized = await finalizePurchase(paymentIntentId);
          // Disarm before closing -- closeCheckoutModal's own reject must
          // not fire after a genuinely completed purchase (a settled
          // promise's second settle attempt is a silent no-op, but relying
          // on that would be fragile and misleading to read).
          rejectCheckoutFlow = null;
          closeCheckoutModal();
          resolve(finalized);
        } catch (err) {
          checkoutStatusEl.textContent = err.message || 'Payment failed.';
          checkoutStatusEl.classList.add('error');
          checkoutPayBtn.disabled = false;
          checkoutCancelBtn.disabled = false;
        }
      };
    }).catch((err) => {
      checkoutStatusEl.textContent = err.message || 'Could not load Stripe.';
      checkoutStatusEl.classList.add('error');
    });
  });
}

// #659: read-only, no submit/confirm action — just the close button, same
// as every other dismissible modal in this file (see #checkout-modal's
// own comment on why there's no backdrop-click-to-close convention here).
function closeRefundPolicyModal() {
  refundPolicyModalEl.classList.remove('visible');
  closeModalA11y(refundPolicyModalEl);
  // #2515: same gap as closeUploadModal's own #2515 fix -- this modal only
  // ever opens stacked on top of the still-visible Shop Product Preview
  // modal, so re-arm its trap rather than leaving it on screen untrapped.
  shopProductPreviewModalEl.classList.add('visible');
  openModalA11y(shopProductPreviewModalEl, closeShopProductPreviewModal);
}
function handleShopReturnPolicyClick() {
  refundPolicyModalEl.classList.add('visible');
  openModalA11y(refundPolicyModalEl, closeRefundPolicyModal);
}
shopProductPreviewReturnPolicyBtn.addEventListener('click', handleShopReturnPolicyClick);
refundPolicyCloseBtn.addEventListener('click', closeRefundPolicyModal);

// #1096: distinct from handleShopProductReviewClick's product review above — this
// rates the seller's own service (listing accuracy, timeliness,
// communication) for one specific purchase, not the product itself, so it
// only ever fires right after that purchase rather than from a standalone
// in-world tap. Same lightweight prompt()-based rating+comment flow as the
// review handler, for the same reason that handler uses it — a star
// rating is already a complete, useful piece of feedback, and the comment
// is an optional extra.
async function promptSellerFeedback(purchase) {
  if (!purchase?.sellerId || !purchase.buyerLabel) return;
  if (!confirm('Leave feedback for the seller? (listing accuracy, timeliness, communication)')) return;
  const ratingInput = prompt('Rate this seller 1-5 stars:', '5');
  if (!ratingInput || !ratingInput.trim()) return;
  const rating = Number(ratingInput.trim());
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    alert('Please enter a whole number from 1 to 5.');
    return;
  }
  const text = prompt('Add a comment (up to 280 characters), or leave blank:', '');
  // #2005: same missing client-side check as the product review prompt
  // above -- see its own comment for why this matters.
  if (text && text.trim().length > 280) {
    alert('Keep it to 280 characters or fewer.');
    return;
  }
  try {
    await createSellerFeedback(purchase.purchaseId, { rating, text: text?.trim() || undefined });
  } catch (err) {
    alert(err.message || 'Could not leave feedback for this seller.');
  }
}

async function handleShopProductBuyClick() {
  const review = shopTappedProduct;
  if (!review) return;
  const { name, priceCents, isTestModel } = review.mesh.userData.template;
  if (priceCents == null) return;
  // #1946 (owner correction): defense in depth alongside the canBuy gate
  // above (updateReviewFade) that already hides this button entirely for
  // a test model -- same belt-and-suspenders relationship priceCents ==
  // null already has with its own .visible toggle.
  if (isTestModel) return;
  // #659: a one-line mention right at the moment of buying, alongside the
  // full Return Policy button this same tapped product already surfaces
  // (#shop-product-preview-return-policy-btn, above) — this dialog is a
  // native confirm(), so it can't carry an actual link, just the fact
  // worth knowing before saying yes.
  const confirmed = confirm(`Buy "${name}" for ${formatPriceCents(priceCents)}? (Refunds return 99% — see Return Policy.)`);
  if (!confirmed) return;
  shopProductPreviewBuyBtn.disabled = true;
  const instanceId = review.mesh.userData.instanceId;
  try {
    const result = await purchaseInstance(instanceId);
    let purchase;
    if (result.requiresPayment) {
      const finalized = await runCheckoutFlow(result, { name, totalCents: priceCents });
      purchase = finalized.purchase;
      // #473: only clear the persisted idempotency key (see purchaseInstance
      // in src/api.js) once the purchase has genuinely finalized — a
      // network failure anywhere before this point should leave it in
      // place so a retried "Buy" click reuses the same key instead of
      // risking a second real PaymentIntent for the same attempt.
      clearPurchaseIdempotencyKey(instanceId);
      // #454: the ONLY time this link is ever shown — the server never
      // stores the raw token, only its hash, so there is no "my orders"
      // page to come back and find it later. Present for a physical
      // (non-digital-good) purchase only; a digital good pays the seller
      // out instantly with nothing to confirm.
      alert(finalized.deliveryConfirmUrl
        ? `Purchase complete — thank you! Once you receive it, confirm delivery here so the seller gets paid:\n${finalized.deliveryConfirmUrl}`
        : 'Purchase complete — thank you!');
    } else {
      purchase = result.purchase;
      clearPurchaseIdempotencyKey(instanceId);
      alert('Purchase simulated — the seller has been credited.');
    }
    // #1096: right after the purchase, while the shopper's own buyer_label
    // (locked into the purchase row at checkout — see #761's own comment on
    // why the in-world buy flow never sends an explicit one) is already
    // known, is the only moment this dev-mode identity system can offer a
    // "leave feedback" prompt at all — there's no "my orders" page to come
    // back to later (#454's own comment above). sellerId/buyerLabel are
    // both required server-side (handleSellerFeedbackCreate), so a
    // seller-less product or a null buyer_label (shouldn't happen via this
    // flow, but defends the same way the review gate does) just skips the
    // prompt rather than offering feedback that would only 400.
    await promptSellerFeedback(purchase);
  } catch (err) {
    if (err.message !== 'Checkout cancelled.') alert(err.message || 'Could not complete this purchase.');
  } finally {
    shopProductPreviewBuyBtn.disabled = false;
  }
}
shopProductPreviewBuyBtn.addEventListener('click', handleShopProductBuyClick);

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
// at this exact point in the call stack, only on the *next* animate() frame.
// Reading renderer.info.memory immediately here caught that gap: the
// outgoing avatar's resources already gone, the incoming one's not yet
// counted, undercounting by exactly the incoming avatar's own geometry/
// texture count until that next frame renders. Deferring the actual read to
// the frame after this one (double rAF: the first just waits for the next
// paint to be scheduled, the second runs after it's actually happened) closes
// that gap without changing what's being measured. Returns a promise so
// both call sites can await it — otherwise the async swap function they're
// each the last line of would resolve (and its own caller would move on to
// reading window.__rendererMemory) before the deferred write above ever
// lands, trading the original undercount race for an equally real stale-read
// one.
export function reportRendererMemoryDiagnostic() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.__rendererMemory = { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
      resolve();
    }));
  });
}
// #1591: same counts as window.__rendererMemory above, but read on demand
// rather than only at whichever moment refreshEquippedShopAvatar/
// enterShopMode last happened to call reportRendererMemoryDiagnostic —
// window.__rendererMemory alone is a frozen snapshot from that one past
// moment, not a live value, which makes it the wrong thing to compare
// against once anything else in the scene (e.g. a landlet's own placed
// instances, still loading asynchronously by proximity) can keep changing
// in between.
window.__currentRendererMemory = () => ({ geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures });

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
      nearestActiveSign = null;
      shopSignHintEl.classList.remove('visible');
    }
  }
  for (const calendar of [...shopCalendars]) {
    if (calendar.group !== entry.group) continue;
    disposeCalendarSprites(calendar);
    shopCalendars.splice(shopCalendars.indexOf(calendar), 1);
    if (nearestActiveCalendar === calendar) {
      nearestActiveCalendar = null;
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
      shopTappedProduct = null;
      shopReviewHintsVisible = false;
      shopReviewHintsProduct = null;
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
      shopHighlightedProduct = null;
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

// The normal builder UI (toolbar, product hint, camera debug, undo/redo)
// belongs to the single-landlet editing experience — none of it applies
// while visiting, and left showing it would just overlap Shop's own
// overlay. There's nothing to restore on the way out: leaving Shop mode
// (via #mode-nav's Build/Sell buttons) reloads the page rather than
// trying to undo this.
const SHOP_HIDDEN_BUILDER_UI_IDS = [
  'notifications-btn', 'friends-btn', 'undo-redo-panel', 'product-info', 'gizmo-mode-controls', 'add-item-panel', 'camera-debug-panel',
  'level-controls', 'connectivity-indicator',
];

// N44: the shared "nothing to show, sign in to continue" end state for a
// declined/failed login or verification — used by enterShopMode's own
// decline branch below, and by Build/Sell/layoutPreview's own decline
// branches (bootstrap, enterSellMode, enterLayoutPreviewMode), which used
// to fall back to a full `enterShopMode()` call. That would now immediately
// re-trigger Shop's own identical gate (ensureShopperIdentity) a second
// time in a row, reopening #auth-modal right on top of the one the visitor
// just closed — confusing at best, and it broke e2e/identity-and-ui-
// chrome.test.mjs's own "cancel out entirely" assertions outright (the
// modal it expected gone had already reopened by the time it checked).
// Landing on this same inert end state instead means declining anywhere
// always reads the same way, with no redundant second prompt.
export function showShopAccessGate() {
  for (const id of SHOP_HIDDEN_BUILDER_UI_IDS) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  controls.enabled = false;
  shopStatusEl.classList.add('visible');
  shopStatusEl.textContent = 'Sign in and complete age verification to continue.';
}

async function enterShopMode() {
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
  shopEquippedAvatarSkeletonSignature = null;
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
      shopEquippedAvatarSkeletonSignature = avatar.skeletonSignature;
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
  shopLastLocation = null;
  if (currentAuthUser && !accountRecoveryFlowActive) {
    try {
      shopLastLocation = await fetchOwnLastPresence();
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
  shopWorldRadiusM = computeGaplessWorldRadius(allLandlets, world.radiusM);

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
  shopSkyMaterial = createShopSkyMaterial(shopWorldRadiusM);
  shopSkyClockStart = null;
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
  shopDomeRiseM = SHOP_DOME_INITIAL_RISE_M;
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
  shopDomeMesh = new THREE.Mesh(domeGeometry, shopDomeMaterial);
  shopDomeMesh.rotation.x = Math.PI / 2;
  shopDomeMesh.position.z = SHOP_WALL_HEIGHT_M - wallGroundDropM;
  shopDomeMesh.scale.set(shopWorldRadiusM, shopDomeRiseM, shopWorldRadiusM);
  scene.add(shopDomeMesh);
  shopWorldObjects.push(shopDomeMesh);

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
    groundMesh.position.z = 0.02;
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
  // Not just clearing the text — an empty .visible pill still shows its
  // own padding/background as a small blank rectangle, which sat directly
  // on top of the wordmark (both anchored at the same top:10/left:12 spot)
  // once the world finished loading. Hiding it outright once there's
  // nothing left to say is the actual fix; the "Loading the world…"/error
  // paths above re-add .visible themselves whenever there's real text.
  shopStatusEl.textContent = '';
  shopStatusEl.classList.remove('visible');
  shopActive = true;
  // #2552: Shop's own per-frame work (movement + sky) and its own avatar-
  // facing value for the compass (eases toward movement direction rather
  // than tracking the camera instantly, unlike every other mode's default
  // camera-derived bearing — see world/scene.js's own comment).
  registerModeFrameUpdate((now) => {
    updateShopMovement(now);
    updateShopSky(now);
  });
  registerFacingOverride(() => shopAvatarFacing);
}

// #540: Sell mode's own "faux lándlet" — the seller's own products,
// scrolled through in pages, each page its own ground plane sized to fit
// just that page's items. Owner-confirmed design (Control Room): real
// placed-instance meshes (not thumbnails), paginated by a cumulative
// model-file-size cap (not a fixed item count), reusing the lándlet ground
// mesh rendering path, click-through to Edit Size/Price. The pure
// pagination/grid-layout math lives in src/sellerShowcase.js (unit-tested
// there) — everything below is just wiring it against the live scene.

// Real Object3Ds currently standing on the showcase ground plane — a
// separate array from productMeshes (a genuine builder-owned landlet's
// content, driven by persistLayout/sync) since these are read-only,
// unowned-by-any-landlet display copies that never get saved anywhere.
let sellerShowcaseMeshes = [];
// Array of arrays of catalog templates, computed once per Sell-mode entry
// (or catalog refresh) by computeSellerShowcasePages — index 0 is always
// the first page shown.
let sellerShowcasePages = [];
// Exported for src/sell/mode.js (#2647) -- its own closeSellerModal reads
// this to resume the pager at the right page; read-only from there, #2648
// (the showcase leaf, not yet landed) owns writing it.
export let sellerShowcasePageIndex = 0;

const sellerShowcasePagerEl = document.getElementById('seller-showcase-pager');
const sellerShowcasePageLabelEl = document.getElementById('seller-showcase-page-label');
const sellerShowcasePrevBtn = document.getElementById('seller-showcase-prev-btn');
const sellerShowcaseNextBtn = document.getElementById('seller-showcase-next-btn');
const sellerShowcaseManageBtn = document.getElementById('seller-showcase-manage-btn');
sellerShowcaseManageBtn.addEventListener('click', openSellerModal);

function disposeSellerShowcaseMeshes() {
  for (const mesh of sellerShowcaseMeshes) {
    scene.remove(mesh);
    disposeObject(mesh);
  }
  sellerShowcaseMeshes = [];
}

function updateSellerShowcasePagerUI() {
  const totalPages = sellerShowcasePages.length;
  sellerShowcasePagerEl.classList.toggle('visible', totalPages > 0);
  sellerShowcasePageLabelEl.textContent = `Page ${totalPages === 0 ? 0 : sellerShowcasePageIndex + 1} of ${totalPages}`;
  sellerShowcasePrevBtn.disabled = sellerShowcasePageIndex <= 0;
  sellerShowcaseNextBtn.disabled = sellerShowcasePageIndex >= totalPages - 1;
}

// (Re)builds the ground plane (reusing the same `landlet` mesh Build mode's
// own placeholder/real-landlet ground uses — applyLandletShape does the
// same geometry swap for a real landlet's polygon) and places every
// template in `sellerShowcasePages[pageIndex]` on it as its actual
// placed-instance mesh, laid out in a square-ish grid sized off that
// page's own largest item so nothing overlaps regardless of how big any
// one product's declared dimensions are.
let sellerShowcaseLoadToken = 0;
// Exported for src/sell/mode.js (#2647) -- its own closeSellerModal calls
// this after a stale showcase rebuild; temporary, same as refreshSellerShowcase
// -- repoint to #2648 (the showcase leaf) once it lands.
export async function loadSellerShowcasePage(pageIndex) {
  const myToken = ++sellerShowcaseLoadToken;
  disposeSellerShowcaseMeshes();
  sellerShowcasePageIndex = pageIndex;
  updateSellerShowcasePagerUI();

  const templates = sellerShowcasePages[pageIndex] || [];
  if (templates.length === 0) {
    // Nothing to show — leave the ground as whatever plain placeholder
    // square it already was rather than building a zero-size shape.
    return;
  }
  const { groundWidth, groundDepth, placements } = layoutSellerShowcasePage(templates);

  const oldGeometry = landlet.geometry;
  const groundShape = new THREE.Shape([
    new THREE.Vector2(-groundWidth / 2, -groundDepth / 2),
    new THREE.Vector2(groundWidth / 2, -groundDepth / 2),
    new THREE.Vector2(groundWidth / 2, groundDepth / 2),
    new THREE.Vector2(-groundWidth / 2, groundDepth / 2),
  ]);
  landlet.geometry = new THREE.ShapeGeometry(groundShape);
  normalizeGroundShapeUVs(landlet.geometry);
  curveGroundGeometry(landlet.geometry);
  oldGeometry.dispose();

  const meshes = await Promise.all(placements.map(({ template, x, y }) => createMeshForInstance({
    instanceId: `sell-showcase-${template.templateId}`,
    templateId: template.templateId,
    x,
    y,
    z: template.dimensions.height / 2,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    crop: {},
    scale: 1,
  })));
  if (myToken !== sellerShowcaseLoadToken) {
    // A newer page load superseded this one while models were loading.
    // `meshes` already finished building (geometry + material + textures)
    // but was never added to the scene, so nothing else will ever dispose
    // it — same leak family as #1358/#1359/#1370/#1426. Mirrors
    // disposeSellerShowcaseMeshes's own per-mesh disposeObject call below.
    let disposedCount = 0;
    for (const mesh of meshes) {
      if (!mesh) continue;
      disposeObject(mesh);
      disposedCount++;
    }
    // #1427: e2e-only diagnostic, same "expose a minimal hook purely for
    // test verification" reasoning as window.__rendererMemory (#1358) —
    // a superseded page's meshes are never added to the scene, so
    // renderer.info's own live counts never reflect them either way and
    // can't tell a test whether this disposal actually ran. This counter
    // is incremented only in this branch, so a test can assert it grew
    // across a deliberately raced Next/Prev pair.
    window.__sellerShowcaseDisposedMeshCount = (window.__sellerShowcaseDisposedMeshCount || 0) + disposedCount;
    return;
  }

  for (const mesh of meshes) {
    if (!mesh) continue;
    scene.add(mesh);
    sellerShowcaseMeshes.push(mesh);
  }
}

sellerShowcasePrevBtn.addEventListener('click', () => {
  if (sellerShowcasePageIndex > 0) loadSellerShowcasePage(sellerShowcasePageIndex - 1);
});
sellerShowcaseNextBtn.addEventListener('click', () => {
  if (sellerShowcasePageIndex < sellerShowcasePages.length - 1) loadSellerShowcasePage(sellerShowcasePageIndex + 1);
});

// enterSellMode() only computes sellerShowcasePages once, on entry — a
// product created/duplicated/deleted afterward (openSellerModal() is
// reachable from any mode, not just Sell, via the account menu's own "My
// Products" entry) would otherwise leave the showcase behind the modal
// showing stale page data once closed. A no-op when the modal was opened
// from Build/Shop, since sellerShowcasePages/the `landlet` ground swap
// only matter once actually in Sell mode.
//
// Only the (cheap, synchronous) pager label/page count is refreshed right
// away — the actual mesh rebuild (loadSellerShowcasePage, a real
// fetch-and-load per model) is deferred to closeSellerModal, since the
// showcase sits behind the still-open modal and isn't visible yet anyway.
// Doing it eagerly here used to compete for the main thread/network with
// whatever save the seller was still mid-flight on inside the modal — a
// real regression a save-serialization race test caught (rebuilding a
// showcase mesh right after this row's own upload delayed the very next
// button's disabled-while-saving state past that test's own timing
// window).
// Exported for src/sell/mode.js (#2647) -- its own closeSellerModal reads
// this (read-only; an ES import binding can't be reassigned, hence the
// paired setSellerShowcaseMeshesStale below for its one write). Temporary,
// same as refreshSellerShowcase -- repoint to #2648 once it lands.
export let sellerShowcaseMeshesStale = false;
export function setSellerShowcaseMeshesStale(value) {
  sellerShowcaseMeshesStale = value;
}
// Exported for src/catalog/upload.js (#2557) -- its own
// handleUploadDimensionsStep needs this same showcase refresh after
// creating a product.
export function refreshSellerShowcase() {
  sellerShowcasePages = computeSellerShowcasePages(myProducts());
  if (currentMode !== 'sell') return;
  sellerShowcasePageIndex = Math.min(sellerShowcasePageIndex, Math.max(0, sellerShowcasePages.length - 1));
  updateSellerShowcasePagerUI();
  sellerShowcaseMeshesStale = true;
}

// findRootProduct's own counterpart for the showcase array — a showcase
// mesh's clicked-on geometry can sit on a nested child node the same way a
// real placed instance's does (see loadModelInstance), not directly on the
// Object3D pushed into sellerShowcaseMeshes.
function findRootSellerShowcaseMesh(object) {
  let current = object;
  while (current && !sellerShowcaseMeshes.includes(current)) {
    current = current.parent;
  }
  return current;
}

// Sell's own equivalent of SHOP_HIDDEN_BUILDER_UI_IDS — none of Build's
// editing tools (gizmo, level controls, add-item, undo/redo) apply to this
// read-only showcase array, and Sell has no per-instance selection to
// support anyway (clicking a product jumps straight to Manage, see the
// showcase click handling in the main renderer click listener). Unlike
// Shop's own list, notifications/friends stay reachable — Sell (unlike
// Shop) always runs under a real logged-in account, which those features
// are genuinely useful for.
export const SELL_HIDDEN_BUILDER_UI_IDS = [
  'undo-redo-panel', 'product-info', 'gizmo-mode-controls', 'add-item-panel', 'camera-debug-panel', 'level-controls',
  // #1169: the compass orients by Shop/Build's own free-look camera or
  // avatar facing — Sell has neither (its own faux-landlet showcase is a
  // fixed, non-orbiting preview), so there's no facing for it to show.
  'compass-panel',
];

// #2561: the faux-layout preview mode (layoutPreviewMeshes/Instances,
// selectedSavedInstanceIds, marquee selection, paste, enterLayoutPreviewMode)
// now lives in src/build/layoutPreview.js — see that module's own comment
// for its dependency notes, including why it in turn imports several
// Build-internal pieces back from this module (a temporary circular
// import, same shape as account/menu.js's own, until build/scene.js's own
// future extraction gives them a real home outside main.js).

// #539/#540: makes Sell a genuine currentMode (the mode-architecture
// plumbing #539 itself was closed without ever landing — see #540's own
// GitHub thread) rather than a modal shown over whatever Build/Shop scene
// happened to already be running. Parallels enterShopMode's own shape:
// hide the builder chrome that doesn't apply, clear out whatever the
// placeholder/real landlet scene had, load this seller's own content.
async function enterSellMode() {
  // #2552: Sell has no per-frame work of its own (paginated, static
  // between page turns) — see world/scene.js's own comment on why this is
  // an explicit null rather than just leaving whatever the previous page
  // load registered.
  registerModeFrameUpdate(null);
  for (const id of SELL_HIDDEN_BUILDER_UI_IDS) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  sellerShowcaseManageBtn.classList.add('visible');
  clearSelection();
  translateControls.detach();
  rotateControls.detach();
  for (const mesh of productMeshes) {
    removeLowStockHighlight(mesh);
    scene.remove(mesh);
    disposeObject(mesh);
  }
  productMeshes.length = 0;
  // #1950: same "Build-mode-only state" reasoning as enterShopMode's own
  // identical teardown above.
  setActiveLowStockTemplateIds(null);
  setLowStockFilterMaxQty(null);
  setLowStockFilterMaxDays(null);
  // #2068: same reasoning, same place, as enterShopMode's own identical
  // sold-out-marker teardown above.
  clearSoldOutMarkerMeshes();
  setShowSoldOutMarkers(false);
  setSoldOutMarkers([]);

  const id = await ensureSellerIdentity();
  if (!id) {
    // Declined to log in — Sell needs a real seller identity the same way
    // Build needs a builder one (see bootstrap()'s own Build-mode
    // fallback just below). Nothing left to show here. N44: lands on
    // showShopAccessGate's shared end state, not a full enterShopMode()
    // call — see that function's own comment for why.
    setCurrentMode('shop');
    updateModeNavUI();
    showShopAccessGate();
    return;
  }

  // Notifications/friends stay reachable from Sell mode (unlike Shop's own
  // hidden-UI list) — both are builder-scoped concepts (a builder gets
  // notified when a product they placed gets resized; see
  // notifyBuildersOfDimensionChange), so showing a real badge count for
  // them needs a real builderId, not just the sellerId Sell mode otherwise
  // only needs. ensureBuilderIdentity reuses the login ensureSellerIdentity
  // just confirmed (never re-prompts) and lazily provisions a builder
  // profile the same way visiting Build mode for the first time would —
  // the natural cost of this app's "every account can hold both roles"
  // model, not a new one Sell mode introduces on its own.
  setBuilderId(await ensureBuilderIdentity());
  refreshNotificationsBadge();
  refreshFriendsBadge();
  refreshDmBadge();

  try {
    setActiveCatalog(await fetchCatalog());
  } catch {
    setActiveCatalog(FALLBACK_CATALOG);
  }
  sellerShowcasePages = computeSellerShowcasePages(myProducts());

  // Preserves today's default: Sell has always opened straight into the
  // product-management modal — the showcase array behind it (semi-
  // transparent backdrop, see #seller-modal's own CSS) is new, not a
  // replacement for that entry behavior. Deliberately not calling
  // openSellerModal() itself here: its own `await bootstrapPromise` exists
  // for the *old* no-reload mode-nav path (Sell reachable while some other
  // mode's bootstrap() call might still be resolving) — this function only
  // ever runs from inside this very page's own bootstrap() now, so
  // awaiting that same promise here would deadlock (it can't resolve
  // until this call returns).
  // #2647: sellerActiveView is a module-private binding in src/sell/mode.js
  // now -- resetSellerView() is that module's own setter for this same
  // assignment.
  resetSellerView();
  updateSellerViewToggleUI();
  renderActiveSellerView();
  sellerModalEl.classList.add('visible');
  openModalA11y(sellerModalEl, closeSellerModal);
  // #1214: openSellerModal() (see its own comment above) has never actually
  // been called from anywhere since #540 moved Sell to this reload-based
  // entry path — this function inlines the rest of its body, but had
  // dropped this one call along the way, leaving #seller-feedback-summary
  // permanently hidden/stale in the live app regardless of real feedback
  // on file. Found while adding e2e coverage for the seller-feedback flow.
  renderSellerFeedbackSummary(id);
  // #1801 (owner feedback): this modal doesn't need the showcase array
  // behind it to be loaded at all — it was sitting there blocking this
  // whole function (and bootstrapPromise's own hideLoadingScreen with it)
  // behind a real per-model fetch-and-load for every product, the same
  // "unrelated 3D scene" delay closeSellerModal's own comment already
  // reasons about. Deferred/unawaited here exactly like that same call
  // there and the Prev/Next pager buttons above — the modal is already
  // visible by the time this resolves, so there's nothing for a slower
  // load here to visibly block.
  loadSellerShowcasePage(0);
}

// The persistent Shop/Build/Sell switcher (#mode-nav). All three are real
// currentMode transitions now (#540) — each goes through the same reload +
// bootstrap() dance, so there's exactly one way any mode ever gets entered,
// not a special no-reload case for Sell alongside the other two.
const modeNavButtons = [...document.querySelectorAll('.mode-nav-btn')];
// #1503: same gap as updateSellerViewToggleUI's own fix -- the .active
// class alone communicated "current mode" visually but not to a screen
// reader.
export function updateModeNavUI() {
  for (const btn of modeNavButtons) {
    const isActive = btn.dataset.mode === currentMode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  }
}
for (const btn of modeNavButtons) {
  btn.addEventListener('click', () => {
    const target = btn.dataset.mode;
    if (target === currentMode) return;
    // #1152: show the press instantly rather than waiting for the reload's
    // own bootstrap() to get far enough to call updateModeNavUI() — that
    // can be a real, perceptible delay (Build mode's own chain in
    // particular, see enterBuildMode's callers). location.reload() still
    // fires synchronously, same tick as before this fix — every e2e call
    // site that clicks a mode-nav button relies on that to line up its own
    // waitForLoadState/waitForSelector right after (deferring the reload a
    // frame or two, e.g. via requestAnimationFrame, raced those callers:
    // the click's own promise resolves before the deferred reload actually
    // starts, so a wait begun only after the click can see an idle page and
    // return immediately, long before the real navigation). A real reload
    // (unlike an instant same-document change) always takes measurably
    // longer than a frame — network + document parsing — so the browser
    // still gets a chance to paint this highlight on the outgoing page
    // first.
    for (const b of modeNavButtons) {
      const isTarget = b.dataset.mode === target;
      b.classList.toggle('active', isTarget);
      b.setAttribute('aria-pressed', String(isTarget));
    }
    sessionStorage.setItem(START_MODE_KEY, target);
    location.reload();
  });
}

export function pointInPolygonXY(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = (a.y > y) !== (b.y > y)
      && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
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

// Builds a flat THREE.Shape for a landlet: its real polygon (plot-local
// meter offsets from its own center, per docs/API.md) when the backend has
// generated one, or a plain square sized to its area as a fallback for
// legacy/placeholder landlets (e.g. starter-landlet) that predate real
// procedural generation and were never given one.
export function shapeForLandlet(landlet) {
  const shape = new THREE.Shape();
  if (landlet.polygon && landlet.polygon.length >= 3) {
    shape.moveTo(landlet.polygon[0].x, landlet.polygon[0].y);
    for (const point of landlet.polygon.slice(1)) shape.lineTo(point.x, point.y);
    shape.closePath();
    return shape;
  }
  const half = Math.sqrt(landlet.areaM2) / 2;
  shape.moveTo(-half, -half);
  shape.lineTo(half, -half);
  shape.lineTo(half, half);
  shape.lineTo(-half, half);
  shape.closePath();
  return shape;
}

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

// #1170 (owner request, 2026-10-01): a grayed-out, non-interactive outline
// of every other landlet within SHOP_LOAD_RADIUS_M of this one — the same
// "how far" radius Shop mode already uses to decide what's visible/loaded
// (SHOP_LOAD_RADIUS_M's own comment) — so a builder gets spatial context
// for what's next to their plot without it reading as part of their own
// buildable area. Scoped to plot-boundary outlines only, matching
// applyLandletShape's own treatment of the main plot (a flat ShapeGeometry
// built from the record's own plot-local polygon, curveGroundGeometry
// applied directly to it rather than accounting for true world position —
// negligible at landlet scale, same simplification the main plot already
// relies on) — not a full dimmed render of whatever a neighbor has
// actually built. #1170's own comment leaves that fuller render as a
// reasonable follow-up, not attempted here. Never used as a raycast
// target (ground-click placement only ever raycasts against `landlet`
// itself, never the whole scene), so no interactivity guard is needed.
const BUILD_NEIGHBOR_OUTLINE_COLOR = 0x888888;
function addBuildModeNeighborOutlines(currentLandletRecord, allLandlets) {
  const neighborMaterial = new THREE.MeshStandardMaterial({
    color: BUILD_NEIGHBOR_OUTLINE_COLOR,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
  });
  for (const record of allLandlets) {
    if (record.landletId === currentLandletRecord.landletId) continue;
    const dx = record.center.x - currentLandletRecord.center.x;
    const dy = record.center.y - currentLandletRecord.center.y;
    if (Math.hypot(dx, dy) > SHOP_LOAD_RADIUS_M) continue;
    const geometry = new THREE.ShapeGeometry(shapeForLandlet(record));
    curveGroundGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, neighborMaterial);
    const group = new THREE.Group();
    // Just under the main plot's own ground (z 0.02, applyLandletShape/the
    // initial landletGeometry) so the two never z-fight at the shared edge.
    group.position.set(dx, dy, -0.01);
    group.add(mesh);
    scene.add(group);
  }
}

// #1590: fades out the cold-start/mode-switch splash (#loading-screen,
// visible by default in index.html's own markup) once bootstrap() has
// settled, whichever of Shop/Build/Sell/layoutPreview it resolved into —
// including the declined-login dead ends (showShopAccessGate), since those
// are also "nothing left to load," not stuck-mid-load. Tied to both the
// resolve and reject side of bootstrapPromise below so an unexpected throw
// still uncovers the app rather than leaving the wordmark stuck forever.
function hideLoadingScreen() {
  const el = document.getElementById('loading-screen');
  if (!el || el.classList.contains('loading-screen-hidden')) return;
  el.classList.add('loading-screen-hidden');
  el.addEventListener('transitionend', () => { el.style.display = 'none'; }, { once: true });
}

// Loads the real catalog + instance list from the backend API, falling
// back to catalog.js's placeholder data (and the localStorage cache) if
// either fetch fails. Catalog and instances are fetched together with a
// single Promise.all specifically so a failure in either one falls both
// back together — the API's seeded catalog (placeholder-table/chair/tree)
// and the local fallback catalog (crate/planter/lamp/table) use different
// templateIds, so pairing one source's catalog with the other's instances
// would leave every instance unable to find its template.
//
// Runs after animate() has already started so the (empty, for now) scene
// renders immediately rather than waiting on the network.
async function bootstrap() {
  // Set by #mode-nav just before its reload; consumed
  // once here. Nothing set — a plain fresh tab — lands on Shop, the
  // product's chosen default landing view (see START_MODE_KEY above).
  const requestedStartMode = sessionStorage.getItem(START_MODE_KEY);
  sessionStorage.removeItem(START_MODE_KEY);
  const startMode = requestedStartMode === 'build' || requestedStartMode === 'sell' || requestedStartMode === 'layoutPreview'
    ? requestedStartMode : 'shop';

  if (startMode === 'shop') {
    setCurrentMode('shop');
    updateModeNavUI();
    await enterShopMode();
    return;
  }

  // Build/Sell/layoutPreview need currentAuthUser settled before proceeding
  // (see authInitPromise's own comment on the race this avoids) — Shop's
  // own branch above awaits it too now, inside enterShopMode itself (N44),
  // so this isn't the scene-renders-instantly shortcut it used to be for
  // the majority-of-traffic Shop-mode case; it's just not duplicated here
  // since enterShopMode already covers it before this function ever
  // reaches this line for the other three modes.
  await authInitPromise;

  if (startMode === 'sell') {
    setCurrentMode('sell');
    updateModeNavUI();
    await enterSellMode();
    return;
  }

  // #635: the faux-layout preview — never reachable from #mode-nav itself
  // (only from a saved layout's own "Preview" button in Settings > Build),
  // so updateModeNavUI() below is a harmless no-op (no nav button's
  // data-mode ever equals 'layoutPreview').
  if (startMode === 'layoutPreview') {
    setCurrentMode('layoutPreview');
    updateModeNavUI();
    await enterLayoutPreviewMode();
    return;
  }

  setCurrentMode('build');
  updateModeNavUI();
  // #1831: fetchCatalog needs no builderId (unlike resolveLandletId just
  // below, which filters by it) -- firing it alongside ensureBuilderIdentity
  // rather than after overlaps that round trip with this one instead of
  // paying for both in serial.
  const catalogPromise = fetchCatalog();
  setBuilderId(await ensureBuilderIdentity());
  if (!builderId) {
    // Declined to log in (closed #auth-modal without signing in/up) —
    // Build/Sell both require a real account now (docs/API.md's
    // "Authentication"), so there's nothing left to build on. N44: lands
    // on showShopAccessGate's shared end state, not a full enterShopMode()
    // call — see that function's own comment for why.
    catalogPromise.catch(() => {}); // abandoning it here -- avoid an unhandled-rejection warning if it fails
    setCurrentMode('shop');
    updateModeNavUI();
    showShopAccessGate();
    return;
  }
  // #2552: Build's own tween/edge-pan/controls/debug/selection-highlight
  // per-frame work — see buildModeFrameUpdate's own comment.
  registerModeFrameUpdate(buildModeFrameUpdate);
  refreshNotificationsBadge();
  refreshFriendsBadge();
  refreshDmBadge();
  let instances;
  try {
    setCurrentLandletId(await resolveLandletId());
    const [catalog, remoteInstances, landletRecord, levels] = await Promise.all([
      catalogPromise, fetchInstances(currentLandletId), fetchLandlet(currentLandletId),
      fetchLandletLevels(currentLandletId),
    ]);
    setActiveCatalog(catalog);
    instances = remoteInstances;
    setMyBundles([]);
    setCommunityBundles([]);
    applyLandletShape(landletRecord);
    setCurrentLandletAreaM2(landletRecord.areaM2);
    setCurrentLandletLevels(levels);
    setCurrentLevelIndex(0);
    // #1831: neighbor outlines are a decorative, non-interactive visual-only
    // addition (see addBuildModeNeighborOutlines's own comment: "[n]ever
    // used as a raycast target... no interactivity guard is needed") -- not
    // something the builder needs before the scene itself becomes usable,
    // so this fetch moves off Build's blocking critical path.
    fetchAllLandlets()
      .then((allLandlets) => addBuildModeNeighborOutlines(landletRecord, allLandlets))
      .catch((err) => console.warn('Could not load neighboring landlet outlines:', err));
    // #1831: the bundle browser isn't needed until the builder actually
    // opens the catalog picker -- deferring this pair off the critical
    // path too, re-rendering the (already-safe-to-redraw) picker once it
    // resolves instead of blocking the whole scene on it. Shares
    // bundlePickerLoadToken with Save Bundle and the rename/share/delete
    // handlers below (#1349/#1787's own guard) -- this fetch was already
    // in flight by the time Build mode's scene renders, so a builder who
    // saves a new bundle before it resolves must not have it clobbered by
    // this slower, now-stale snapshot landing after.
    const bundlesLoadToken = bumpBundlePickerLoadToken();
    Promise.all([fetchBundles(), fetchSharedBundles()])
      .then(([bundles, shared]) => {
        if (bundlesLoadToken !== bundlePickerLoadToken) return; // superseded while loading -- a newer bundle-picker action owns the picker now
        setMyBundles(bundles);
        setCommunityBundles(shared);
        renderBundlePicker();
      })
      .catch((err) => console.warn('Could not load bundles:', err));
  } catch (err) {
    console.warn('Backend unreachable, falling back to local/placeholder data:', err);
    setActiveCatalog(FALLBACK_CATALOG);
    setMyBundles([]);
    setCommunityBundles([]);
    setCurrentLandletId('starter-landlet');
    setCurrentLandletAreaM2(LANDLET_AREA_M2);
    setCurrentLandletLevels([]);
    setCurrentLevelIndex(0);
    // A previously-saved instance list (builder additions/removals/moves)
    // entirely replaces the starter set — not merged with it — since the
    // starter set is just a first-visit default, not content to preserve
    // alongside whatever the builder has actually done.
    instances = loadInstances() ?? DEFAULT_INSTANCES;
  }
  renderLevelControls();

  buildCatalogPickerButtons();
  renderBundlePicker();
  // In parallel: each instance's model load is an independent fetch (and
  // most placed instances share just a handful of cached model URLs), so
  // there's no reason to load them one at a time.
  await Promise.all(instances.map((instance) => addInstanceToScene(instance)));

}
// Captured so openSellerModal() (see its own comment) can await whichever
// bootstrap this page load is running before trusting activeCatalog. #540
// gave 'sell' a real bootstrap() branch of its own (enterSellMode) — that
// branch must never itself await this promise (it can't resolve until
// bootstrap() — which is what's currently running enterSellMode — returns);
// enterSellMode's own comment covers why it opens the modal directly
// instead of going through openSellerModal() for that reason.
// Exported for src/sell/mode.js (#2647) -- its own openSellerModal awaits
// this same promise (see the comment above).
export const bootstrapPromise = bootstrap();
bootstrapPromise.then(hideLoadingScreen, hideLoadingScreen);
