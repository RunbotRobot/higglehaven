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
  fetchInstanceBackups,
  addInstanceBackup,
  reorderInstanceBackups,
  deleteInstanceBackup,
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
  reportPresence,
  fetchNearbyPresence,
  fetchOwnLastPresence,
  fetchCreditOrbs,
  collectCreditOrb,
} from './api.js';
import { optimizeModelFile, rescaleModelFile, convertFbxToGlb } from './modelOptimizer.js';
import { getUnits, setUnits, unitSuffix, toDisplayLength, fromDisplayLength, formatLength, formatArea } from './settings.js';
import { takeoffAltitudeM, clampedLandingAltitudeM, flightSpeedMultiplier } from './flight.js';
import { attentionDistanceAndDot, hasSustainedAttention, nextAttentionElapsedS, pickNearestInRange, yawRotatedForward } from './attention.js';
import { sampleUniformDiskRadiusM } from './spawnLocation.js';
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
  buildInstanceLodProxy, setInstanceLodState,
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
// it in turn imports loadStripeJs/START_MODE_KEY/setAccountSessionEnding
// back from this module — a temporary circular import, same shape as
// claim/flow.js's own, until those pieces get a real home outside main.js
// via their own future extractions).
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
// notes, including why it in turn imports findShopIdleInteractionTarget/
// shopAvatarPosition/shopAvatarFacing/disposeObject3D/
// reportRendererMemoryDiagnostic back from this module (a temporary
// circular import pending #2624's shop/flightMovement.js extraction, same
// shape as claim/flow.js's own).
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
  syncUpdate, footprintsOverlap, footprintCorners, isNetworkError,
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
let shopActive = false;

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
const catalogThumbnailEmbeddingCache = new Map();
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
// Exported for src/catalog/upload.js (#2557) -- its own closeUploadModal
// needs this same element (Upload Model always opens stacked on top of
// the still-visible Seller modal, and re-shows it on close).
export const sellerModalEl = document.getElementById('seller-modal');
const sellerFeedbackSummaryEl = document.getElementById('seller-feedback-summary');
const sellerFeedbackListEl = document.getElementById('seller-feedback-list');
const sellerListEl = document.getElementById('seller-list');
const sellerListViewEl = document.getElementById('seller-list-view');
const sellerViewToggleEl = document.getElementById('seller-view-toggle');
const sellerStatusEl = document.getElementById('seller-status');
const sellerCloseBtn = document.getElementById('seller-close-btn');
const sellerFilterControlsEl = document.getElementById('seller-filter-controls');
const sellerSearchInput = document.getElementById('seller-search-input');
const sellerCategoryFilterSelect = document.getElementById('seller-category-filter');
const sellerSortSelect = document.getElementById('seller-sort-select');

function myProducts() {
  return activeCatalog.filter((template) =>
    template.sellerId === sellerId ||
    (template.sellerId === null && template.modelUrl?.startsWith('/uploads/')));
}

// #1600: no hard uniqueness constraint on product names (sellers already
// disambiguate by seller), but an exact-match duplicate within one seller's
// OWN catalog is more likely an honest mistake (re-listing, a half-finished
// rename) than something intentional, so this just confirms rather than
// blocking. excludeTemplateId lets a rename skip comparing the product
// against its own pre-rename name.
// Exported for src/catalog/upload.js (#2557) -- its own
// handleUploadFileStep/handleUploadVideoStep need this same check.
export function hasDuplicateProductName(name, excludeTemplateId) {
  const normalized = name.toLowerCase();
  return myProducts().some((other) =>
    other.templateId !== excludeTemplateId && other.name.toLowerCase() === normalized);
}

// #542: shared filtered/sorted product set for Sell mode, independent of
// whichever view renders it (this row-list today; #540/#541's own views
// later) — matches other categories/subcategories already round-tripped
// through the catalog API (see worker/index.js), so filtering by category
// costs nothing beyond what's already on each template. Search matches
// name first (the issue's own stated minimum) plus category/subcategory
// as a cheap stretch, since they're already in hand.
// #2325: GET /api/catalog?category= matches case-insensitively (COLLATE
// NOCASE, migration 0145) -- dedup/compare the same way here so two
// differently-cased templates for what the server treats as one category
// don't splinter into separate filter options that only ever show their
// own casing's listings.
function populateSellerCategoryFilterOptions(templates) {
  const categoriesByKey = new Map();
  for (const t of templates) {
    if (!t.category) continue;
    const key = t.category.toLowerCase();
    if (!categoriesByKey.has(key)) categoriesByKey.set(key, t.category);
  }
  const categories = [...categoriesByKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const previous = sellerCategoryFilterSelect.value;
  sellerCategoryFilterSelect.innerHTML = '';
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'All categories';
  sellerCategoryFilterSelect.appendChild(allOption);
  for (const category of categories) {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    sellerCategoryFilterSelect.appendChild(option);
  }
  sellerCategoryFilterSelect.value = categories.some((c) => c.toLowerCase() === previous.toLowerCase()) ? previous : '';
}

function filterAndSortSellerProducts(templates) {
  const query = sellerSearchInput.value.trim().toLowerCase();
  const category = sellerCategoryFilterSelect.value;
  let filtered = templates;
  if (query) {
    filtered = filtered.filter((t) =>
      t.name.toLowerCase().includes(query) ||
      (t.category || '').toLowerCase().includes(query) ||
      (t.subcategory || '').toLowerCase().includes(query));
  }
  if (category) filtered = filtered.filter((t) => (t.category || '').toLowerCase() === category.toLowerCase());
  const sort = sellerSortSelect.value;
  filtered = filtered.slice().sort((a, b) => {
    if (sort === 'price-asc') return (a.priceCents ?? Infinity) - (b.priceCents ?? Infinity);
    if (sort === 'price-desc') return (b.priceCents ?? -Infinity) - (a.priceCents ?? -Infinity);
    return a.name.localeCompare(b.name);
  });
  return filtered;
}

// #541 added a second (List) view of the same product set — re-render
// whichever view is actually showing, not always Manage, the same idiom
// renderActiveSellerView's own other callers already follow.
for (const el of [sellerSearchInput, sellerCategoryFilterSelect, sellerSortSelect]) {
  el.addEventListener(el === sellerSearchInput ? 'input' : 'change', () => renderActiveSellerView());
}

const AXIS_ROW_LABELS = { x: 'Width (x)', y: 'Depth (y)', z: 'Height (z)' };

// On-demand product preview: a small self-contained Three.js scene,
// entirely separate from the main builder scene, the same pattern the
// claim flyover uses (see disposeClaimFlyover). Lets a seller see the
// actual product — real scanned model or placeholder box, whichever the
// builder scene would show — rather than a simplified stand-in. Only one
// row's preview is ever live at a time (mobile GPUs don't want many
// WebGL contexts anyway), so this is a single shared canvas moved into
// whichever row's Preview button was last toggled on, rather than one
// per row. Defaults to a plain look-it-over view — no axis arrows — since
// most sellers opening this modal just want to rename or delete
// something; arrows only appear once a row's Extensibility section (a
// rare need — see docs/API.md) is actually expanded.
const sellerPreviewCanvas = document.createElement('canvas');
sellerPreviewCanvas.className = 'seller-preview-canvas';
const sellerPreviewHintEl = document.createElement('div');
sellerPreviewHintEl.className = 'seller-preview-hint';
// Exported for src/catalog/upload.js (#2557) -- its own
// showUploadDimensionPreview needs this same color map (also still used
// directly here, below, by the Seller modal's own extensibility axis
// preview).
export const AXIS_ARROW_COLORS = { x: 0xff5555, y: 0x55dd55, z: 0x5599ff };
let axisPreview = null;

// showAxisPreview awaits a model load (createMeshForInstance) before
// building its scene; if it's invoked again — e.g. a seller toggling two
// extensibility-axis checkboxes back-to-back — before that await resolves,
// disposeAxisPreview() at the new call's start is a no-op (axisPreview is
// still whatever it was before either call started), so without this guard
// both calls would go on to build their own WebGLRenderer/OrbitControls
// bound to the same shared sellerPreviewCanvas and race to overwrite the
// shared axisPreview — the same bug shape already fixed once in
// loadLandletMap (commit 80625ff, issue #125). Each call captures the
// token's value before it starts awaiting, then checks it's still the
// latest afterward; a superseded call bails out quietly instead of
// building anything.
let axisPreviewLoadToken = 0;

function mountPreviewInto(container) {
  container.appendChild(sellerPreviewCanvas);
  container.appendChild(sellerPreviewHintEl);
}

function disposeAxisPreview() {
  // #1893: bumped on every call (even when there's nothing to dispose yet),
  // so a showAxisPreview() call still in flight at the time this runs from
  // one of its other callers (the Sell modal closing, a row collapsing,
  // renderSellerList() tearing down row DOM) correctly detects it's been
  // superseded once its own model load resolves, instead of finishing and
  // installing a WebGLRenderer/OrbitControls bound to an already-detached
  // canvas that never gets disposed. showAxisPreview's own call to this
  // function (its very next line) relies on this: it captures its load
  // token right after, not before, calling this.
  axisPreviewLoadToken++;
  sellerPreviewCanvas.remove();
  sellerPreviewHintEl.remove();
  if (!axisPreview) return;
  axisPreview.controls.dispose();
  axisPreview.renderer.dispose();
  disposeObject(axisPreview.previewObject);
  for (const arrow of axisPreview.arrows) {
    arrow.line.geometry.dispose();
    arrow.line.material.dispose();
    arrow.cone.geometry.dispose();
    arrow.cone.material.dispose();
  }
  for (const sprite of axisPreview.labels) {
    sprite.material.map.dispose();
    sprite.material.dispose();
  }
  axisPreview = null;
}

// A small canvas-drawn "X"/"Y"/"Z" billboard at each arrow's tip, so the
// preview reads as a legend rather than three unlabeled colored lines.
function makeAxisLabelSprite(text, colorHex) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `#${colorHex.toString(16).padStart(6, '0')}`;
  ctx.beginPath();
  ctx.arc(32, 32, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#16240a';
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.renderOrder = 1;
  return sprite;
}

// highlightAxes: null for a plain general-viewing look (no arrows at all —
// the default once a row's Preview is toggled on), or an array of the
// axes ('x'/'y'/'z', zero or more, any subset since a template can be
// extensible on more than one at once) currently checked in the
// Extensibility panel. An empty array reads as a neutral, evenly-weighted
// X/Y/Z legend (nothing checked yet); a non-empty one turns those axes
// bright yellow and mutes the rest to gray.
async function showAxisPreview(template, container, highlightAxes) {
  // disposeAxisPreview() now bumps axisPreviewLoadToken itself (#1893), so
  // this captures the token right after calling it, not before -- the same
  // value either way for this call's own purposes, but capturing before
  // would make every call see itself as already-superseded the instant
  // disposeAxisPreview() ran.
  disposeAxisPreview();
  const myLoadToken = axisPreviewLoadToken;
  mountPreviewInto(container);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(2, -3, 4);
  scene.add(sun);

  // #1893: lets an e2e test simulate a slow load deterministically, same
  // reasoning as window.__testUploadPreviewLoadDelayMs (#1465). Always
  // undefined outside of that one test.
  if (window.__testAxisPreviewLoadDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, window.__testAxisPreviewLoadDelayMs));
  }
  // Same instance shape addInstanceToScene builds, at the origin and with
  // no crop, so this shows the product's real full-size geometry (and, for
  // a real uploaded model, its real material/texture) exactly as it would
  // appear freshly placed in Build mode — not a simplified stand-in.
  const previewObject = await createMeshForInstance({
    templateId: template.templateId,
    x: 0, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0,
    crop: {},
  });
  if (myLoadToken !== axisPreviewLoadToken) {
    // A newer call owns the preview now — this one's just-built object was
    // never added to any scene disposeAxisPreview knows about, so without
    // this it leaks the exact same way #1426/#1427 did for their own
    // superseded in-flight loads.
    if (previewObject) disposeObject(previewObject);
    // Exposed purely so an e2e test can confirm the dispose above actually
    // ran, same reasoning as window.__supersededUploadPreviewDisposals (#1465).
    window.__supersededAxisPreviewDisposals = (window.__supersededAxisPreviewDisposals ?? 0) + 1;
    return;
  }
  if (!previewObject) return;
  scene.add(previewObject);

  const box = new THREE.Box3().setFromObject(previewObject);
  const size = box.getSize(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.05);

  const rect = sellerPreviewCanvas.getBoundingClientRect();
  const camera = new THREE.PerspectiveCamera(45, rect.width / Math.max(rect.height, 1), 0.01, 100);
  camera.up.set(0, 0, 1);
  const dist = radius * 2.6;
  camera.position.set(dist * 0.75, -dist * 0.95, dist * 0.65);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas: sellerPreviewCanvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(rect.width, rect.height, false);

  const controls = new OrbitControls(camera, sellerPreviewCanvas);
  controls.target.set(0, 0, 0);
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.minDistance = dist * 0.35;
  controls.maxDistance = dist * 3;
  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render);

  // Not checked yet: all three read as a neutral, evenly-weighted legend.
  // Once one or more axes are checked, those arrows turn bright yellow and
  // the rest mute to gray — the same "this one's the live one" language
  // the Trim gizmo itself uses elsewhere. highlightAxes === null (the
  // default, general-viewing look) skips arrows entirely.
  const arrows = [];
  const labels = [];
  if (highlightAxes !== null) {
    const axisDims = { x: size.x, y: size.y, z: size.z };
    const dirs = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
    for (const axis of AXIS_LIST) {
      const isHighlighted = highlightAxes.includes(axis);
      const color = highlightAxes.length > 0 ? (isHighlighted ? 0xffee33 : 0x888888) : AXIS_ARROW_COLORS[axis];
      const length = axisDims[axis] / 2 + radius * 0.35;
      const arrow = new THREE.ArrowHelper(dirs[axis], new THREE.Vector3(0, 0, 0), length, color, length * 0.3, length * 0.18);
      scene.add(arrow);
      arrows.push(arrow);
      const label = makeAxisLabelSprite(axis.toUpperCase(), color);
      label.position.copy(dirs[axis]).multiplyScalar(length * 1.2);
      const labelScale = radius * 0.28;
      label.scale.set(labelScale, labelScale, labelScale);
      scene.add(label);
      labels.push(label);
    }
  }

  render();
  axisPreview = { renderer, scene, camera, controls, previewObject, arrows, labels, templateId: template.templateId };
  sellerPreviewHintEl.textContent = highlightAxes === null
    ? 'Drag to look around.'
    : highlightAxes.length > 0
      ? `Yellow = extensible (${highlightAxes.map((axis) => axis.toUpperCase()).join(', ')}). Drag to look around.`
      : 'Arrows show X (red) / Y (green) / Z (blue). Check axes below to make them extensible. Drag to look around.';
}

// #457: metadataSaveBusy used to live entirely inside renderSellerList()'s
// per-template closure, so a save left in flight when the Seller modal is
// closed and reopened (renderSellerList() runs fresh each open, per
// openSellerModal() below) got a brand-new `metadataSaveBusy = false` with
// no memory of the still-in-flight PATCH — re-enabling the exact overlap
// #424 was added to prevent. Keyed by templateId (not a single flag) since
// a save against one product must never block a save against another.
const metadataSaveBusyByTemplateId = new Map();

// A row's own metadataSaveButtons closure array (see inside the loop below)
// only ever points at whichever DOM nodes existed at the moment it was
// captured — stale once a modal close/reopen rebuilds the row (#457), so a
// save's completion couldn't re-enable a NEW row's buttons through it.
// Looking the row up fresh by data-template-id instead always finds
// whichever row is actually in the DOM right now, in this render or a
// later one, and every metadata-save button carries the shared
// .metadata-save-btn hook class (alongside its own specific class) so they
// can all be found here in one query regardless of which panel they save.
function syncMetadataSaveButtonsDisabled(templateId) {
  const busy = metadataSaveBusyByTemplateId.get(templateId) === true;
  const row = sellerListEl.querySelector(`.seller-row[data-template-id="${CSS.escape(String(templateId))}"]`);
  if (!row) return;
  for (const btn of row.querySelectorAll('.metadata-save-btn')) btn.disabled = busy;
}

function renderSellerList() {
  // Row DOM is about to be thrown away — an open preview would be left
  // pointing at a detached container, and any per-row event handler
  // (Save, axis select...) that referenced this render's stale `template`
  // closures goes with it.
  disposeAxisPreview();
  sellerListEl.innerHTML = '';
  const allTemplates = myProducts();
  populateSellerCategoryFilterOptions(allTemplates);
  if (allTemplates.length === 0) {
    sellerFilterControlsEl.hidden = true;
    sellerStatusEl.textContent = 'No custom products yet — use "+ Upload Model" to add one.';
    return;
  }
  sellerFilterControlsEl.hidden = false;
  const templates = filterAndSortSellerProducts(allTemplates);
  if (templates.length === 0) {
    sellerStatusEl.textContent = 'No products match your search or filter.';
    return;
  }
  sellerStatusEl.textContent = '';

  for (const template of templates) {
    const row = document.createElement('div');
    row.className = 'seller-row';
    // Lets syncMetadataSaveButtonsDisabled (#457, see its own comment
    // above) find this row again from outside this closure, even after a
    // modal close/reopen has replaced it with a different row instance.
    row.dataset.templateId = String(template.templateId);

    // Every "Save X" panel below (Digital Good, Returns Policy, Shipping,
    // Extensibility, Flooring, Size, Price) independently PATCHes this
    // template via updateCatalogTemplate — the server does a full
    // read-existing/merge/rewrite of the whole catalog_templates row rather
    // than touching only the changed column(s) (see the Extensibility save
    // handler's own comment below), so two of these panels saved in
    // overlapping in-flight windows would otherwise race: whichever
    // response lands last silently discards the other panel's change,
    // since its own patch was built from a `template` snapshot taken
    // before the first save's `Object.assign(template, updated)` landed.
    // (Size and Price were originally left out of this guard despite
    // hitting the same endpoint — #531.) One shared busy flag serializes
    // them, the same idiom as undoRedoBusy/levelActionBusy elsewhere in
    // this file — every save-triggering button on this row registers
    // itself here and is disabled while any one save is in flight. Backed by the
    // module-level metadataSaveBusyByTemplateId map (see its own comment
    // above) rather than a local variable, so the flag survives this
    // row's own DOM/closures being thrown away by a modal close/reopen
    // (#457) while an earlier save is still pending.
    const isMetadataSaveBusy = () => metadataSaveBusyByTemplateId.get(template.templateId) === true;
    const setMetadataSaveBusy = (busy) => {
      if (busy) metadataSaveBusyByTemplateId.set(template.templateId, true);
      else metadataSaveBusyByTemplateId.delete(template.templateId);
    };
    const metadataSaveButtons = [];

    // Dims/actions/preview/extensibility only show once this row is
    // actually tapped — mirrors the identity picker's own row redesign
    // (task #87), for the same reason: a product's full name matters more
    // than room for buttons it doesn't need yet.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'seller-row-toggle';
    const label = document.createElement('div');
    label.className = 'seller-row-label';
    label.textContent = template.name;
    toggle.appendChild(label);
    row.appendChild(toggle);

    const details = document.createElement('div');
    details.className = 'seller-row-details';
    row.appendChild(details);

    toggle.addEventListener('click', () => {
      const wasExpanded = row.classList.contains('expanded');
      for (const otherRow of sellerListEl.querySelectorAll('.seller-row')) otherRow.classList.remove('expanded');
      // A collapsed row's preview would otherwise keep a live WebGL
      // context running inside a display:none panel for nothing.
      disposeAxisPreview();
      previewBtn.classList.remove('active');
      if (!wasExpanded) row.classList.add('expanded');
    });

    const dims = document.createElement('div');
    dims.className = 'seller-row-dims';
    const refreshDimsText = () => {
      const { width, depth, height } = template.dimensions;
      dims.textContent = `${formatLength(width)} × ${formatLength(depth)} × ${formatLength(height)}`;
    };
    refreshDimsText();
    details.appendChild(dims);

    const priceText = document.createElement('div');
    priceText.className = 'seller-row-price';
    const refreshPriceText = () => {
      priceText.textContent = template.priceCents == null ? 'Not priced' : formatPriceCents(template.priceCents);
    };
    refreshPriceText();
    details.appendChild(priceText);

    // Digital good disclosure (docs/SPEC.md §4) — shown right under price
    // when set, same "Not X" convention as price's own "Not priced".
    const digitalGoodText = document.createElement('div');
    digitalGoodText.className = 'seller-row-digital-good';
    const refreshDigitalGoodText = () => {
      const key = template.metadata?.digitalGoodDisclaimer;
      digitalGoodText.textContent = key ? `Digital good: ${DIGITAL_GOOD_DISCLAIMER_TEXT[key]}` : 'Not a digital good';
    };
    refreshDigitalGoodText();
    details.appendChild(digitalGoodText);

    const digitalGoodToggle = document.createElement('button');
    digitalGoodToggle.className = 'seller-extensibility-toggle seller-digital-good-toggle';
    digitalGoodToggle.type = 'button';
    digitalGoodToggle.textContent = 'Edit Digital Good ▾';
    details.appendChild(digitalGoodToggle);

    const digitalGoodPanel = document.createElement('div');
    digitalGoodPanel.className = 'seller-digital-good-panel';
    digitalGoodPanel.hidden = true;
    details.appendChild(digitalGoodPanel);

    const digitalGoodCheckboxLabel = document.createElement('label');
    digitalGoodCheckboxLabel.className = 'seller-digital-good-checkbox-label';
    const digitalGoodCheckbox = document.createElement('input');
    digitalGoodCheckbox.type = 'checkbox';
    digitalGoodCheckboxLabel.appendChild(digitalGoodCheckbox);
    digitalGoodCheckboxLabel.appendChild(document.createTextNode('This is a digital good'));
    digitalGoodPanel.appendChild(digitalGoodCheckboxLabel);

    const digitalGoodSelect = document.createElement('select');
    digitalGoodSelect.className = 'seller-digital-good-select';
    for (const [key, text] of Object.entries(DIGITAL_GOOD_DISCLAIMER_TEXT)) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = text;
      digitalGoodSelect.appendChild(option);
    }
    digitalGoodPanel.appendChild(digitalGoodSelect);

    function fillDigitalGoodInputs() {
      const key = template.metadata?.digitalGoodDisclaimer;
      digitalGoodCheckbox.checked = !!key;
      digitalGoodSelect.value = key || 'gift-card';
      digitalGoodSelect.hidden = !digitalGoodCheckbox.checked;
    }
    fillDigitalGoodInputs();
    digitalGoodCheckbox.addEventListener('change', () => {
      digitalGoodSelect.hidden = !digitalGoodCheckbox.checked;
    });

    const digitalGoodStatus = document.createElement('div');
    digitalGoodStatus.className = 'seller-digital-good-status';

    const digitalGoodSaveBtn = document.createElement('button');
    digitalGoodSaveBtn.className = 'seller-digital-good-save-btn metadata-save-btn';
    digitalGoodSaveBtn.type = 'button';
    digitalGoodSaveBtn.textContent = 'Save Digital Good';
    metadataSaveButtons.push(digitalGoodSaveBtn);
    digitalGoodSaveBtn.addEventListener('click', async () => {
      if (isMetadataSaveBusy()) return;
      digitalGoodStatus.textContent = '';
      digitalGoodStatus.classList.remove('error');
      const nextMetadata = { ...template.metadata };
      if (digitalGoodCheckbox.checked) {
        nextMetadata.digitalGoodDisclaimer = digitalGoodSelect.value;
      } else {
        delete nextMetadata.digitalGoodDisclaimer;
      }
      setMetadataSaveBusy(true);
      for (const btn of metadataSaveButtons) btn.disabled = true;
      try {
        const updated = await updateCatalogTemplate(template.templateId, { metadata: nextMetadata });
        Object.assign(template, updated);
        refreshDigitalGoodText();
        digitalGoodStatus.textContent = 'Saved.';
      } catch (err) {
        digitalGoodStatus.textContent = err.message || 'Could not save.';
        digitalGoodStatus.classList.add('error');
      } finally {
        setMetadataSaveBusy(false);
        // Re-enable via a fresh DOM lookup (#457), not metadataSaveButtons
        // directly -- if the modal was closed and reopened while this save
        // was in flight, that array points at now-detached buttons from a
        // row that no longer exists, and the CURRENT row (same templateId,
        // freshly rendered) would otherwise stay disabled forever.
        syncMetadataSaveButtonsDisabled(template.templateId);
      }
    });
    digitalGoodPanel.appendChild(digitalGoodSaveBtn);
    digitalGoodPanel.appendChild(digitalGoodStatus);

    digitalGoodToggle.addEventListener('click', () => {
      digitalGoodPanel.hidden = !digitalGoodPanel.hidden;
      digitalGoodToggle.textContent = `Edit Digital Good ${digitalGoodPanel.hidden ? '▾' : '▴'}`;
      if (!digitalGoodPanel.hidden) fillDigitalGoodInputs();
    });

    // No-returns policy (docs/SPEC.md §5: "No-returns-policy respected as
    // seller-set default") — absent/false means returns are accepted (the
    // spec's own default), so a seller only ever opts INTO no-returns, same
    // single-boolean-in-metadata simplicity as digital goods above. Own
    // classes throughout for the same "don't share a class across
    // genuinely different rows/panels" reasoning as Extensibility vs. Edit
    // Size vs. Edit Digital Good.
    const noReturnsText = document.createElement('div');
    noReturnsText.className = 'seller-row-no-returns';
    const refreshNoReturnsText = () => {
      noReturnsText.textContent = template.metadata?.noReturns ? 'Returns: not accepted' : 'Returns: accepted';
    };
    refreshNoReturnsText();
    details.appendChild(noReturnsText);

    const noReturnsToggle = document.createElement('button');
    noReturnsToggle.className = 'seller-extensibility-toggle seller-no-returns-toggle';
    noReturnsToggle.type = 'button';
    noReturnsToggle.textContent = 'Edit Returns Policy ▾';
    details.appendChild(noReturnsToggle);

    const noReturnsPanel = document.createElement('div');
    noReturnsPanel.className = 'seller-no-returns-panel';
    noReturnsPanel.hidden = true;
    details.appendChild(noReturnsPanel);

    const noReturnsCheckboxLabel = document.createElement('label');
    noReturnsCheckboxLabel.className = 'seller-no-returns-checkbox-label';
    const noReturnsCheckbox = document.createElement('input');
    noReturnsCheckbox.type = 'checkbox';
    noReturnsCheckboxLabel.appendChild(noReturnsCheckbox);
    noReturnsCheckboxLabel.appendChild(document.createTextNode('This product does not accept returns'));
    noReturnsPanel.appendChild(noReturnsCheckboxLabel);

    const noReturnsStatus = document.createElement('div');
    noReturnsStatus.className = 'seller-no-returns-status';

    const noReturnsSaveBtn = document.createElement('button');
    noReturnsSaveBtn.className = 'seller-no-returns-save-btn metadata-save-btn';
    noReturnsSaveBtn.type = 'button';
    noReturnsSaveBtn.textContent = 'Save Returns Policy';
    metadataSaveButtons.push(noReturnsSaveBtn);
    noReturnsSaveBtn.addEventListener('click', async () => {
      if (isMetadataSaveBusy()) return;
      noReturnsStatus.textContent = '';
      noReturnsStatus.classList.remove('error');
      const nextMetadata = { ...template.metadata };
      if (noReturnsCheckbox.checked) {
        nextMetadata.noReturns = true;
      } else {
        delete nextMetadata.noReturns;
      }
      setMetadataSaveBusy(true);
      for (const btn of metadataSaveButtons) btn.disabled = true;
      try {
        const updated = await updateCatalogTemplate(template.templateId, { metadata: nextMetadata });
        Object.assign(template, updated);
        refreshNoReturnsText();
        noReturnsStatus.textContent = 'Saved.';
      } catch (err) {
        noReturnsStatus.textContent = err.message || 'Could not save.';
        noReturnsStatus.classList.add('error');
      } finally {
        setMetadataSaveBusy(false);
        syncMetadataSaveButtonsDisabled(template.templateId); // #457, see above
      }
    });
    noReturnsPanel.appendChild(noReturnsSaveBtn);
    noReturnsPanel.appendChild(noReturnsStatus);

    noReturnsToggle.addEventListener('click', () => {
      noReturnsPanel.hidden = !noReturnsPanel.hidden;
      noReturnsToggle.textContent = `Edit Returns Policy ${noReturnsPanel.hidden ? '▾' : '▴'}`;
      if (!noReturnsPanel.hidden) noReturnsCheckbox.checked = !!template.metadata?.noReturns;
    });

    // Shipping (docs/SPEC.md §5: "Dimmed-filter approach ... non-shippable
    // items are dimmed with a label ('ships to United States only')") —
    // absent/false means the product ships internationally (the spec's own
    // permissive default), same single-boolean-in-metadata simplicity and
    // own-classes-per-row reasoning as No-Returns above.
    const domesticOnlyText = document.createElement('div');
    domesticOnlyText.className = 'seller-row-domestic-only';
    const refreshDomesticOnlyText = () => {
      domesticOnlyText.textContent = template.metadata?.domesticOnly
        ? 'Shipping: United States only' : 'Shipping: international';
    };
    refreshDomesticOnlyText();
    details.appendChild(domesticOnlyText);

    const domesticOnlyToggle = document.createElement('button');
    domesticOnlyToggle.className = 'seller-extensibility-toggle seller-domestic-only-toggle';
    domesticOnlyToggle.type = 'button';
    domesticOnlyToggle.textContent = 'Edit Shipping ▾';
    details.appendChild(domesticOnlyToggle);

    const domesticOnlyPanel = document.createElement('div');
    domesticOnlyPanel.className = 'seller-domestic-only-panel';
    domesticOnlyPanel.hidden = true;
    details.appendChild(domesticOnlyPanel);

    const domesticOnlyCheckboxLabel = document.createElement('label');
    domesticOnlyCheckboxLabel.className = 'seller-domestic-only-checkbox-label';
    const domesticOnlyCheckbox = document.createElement('input');
    domesticOnlyCheckbox.type = 'checkbox';
    domesticOnlyCheckboxLabel.appendChild(domesticOnlyCheckbox);
    domesticOnlyCheckboxLabel.appendChild(document.createTextNode('This product ships to the United States only'));
    domesticOnlyPanel.appendChild(domesticOnlyCheckboxLabel);

    const domesticOnlyStatus = document.createElement('div');
    domesticOnlyStatus.className = 'seller-domestic-only-status';

    const domesticOnlySaveBtn = document.createElement('button');
    domesticOnlySaveBtn.className = 'seller-domestic-only-save-btn metadata-save-btn';
    domesticOnlySaveBtn.type = 'button';
    domesticOnlySaveBtn.textContent = 'Save Shipping';
    metadataSaveButtons.push(domesticOnlySaveBtn);
    domesticOnlySaveBtn.addEventListener('click', async () => {
      if (isMetadataSaveBusy()) return;
      domesticOnlyStatus.textContent = '';
      domesticOnlyStatus.classList.remove('error');
      const nextMetadata = { ...template.metadata };
      if (domesticOnlyCheckbox.checked) {
        nextMetadata.domesticOnly = true;
      } else {
        delete nextMetadata.domesticOnly;
      }
      setMetadataSaveBusy(true);
      for (const btn of metadataSaveButtons) btn.disabled = true;
      try {
        const updated = await updateCatalogTemplate(template.templateId, { metadata: nextMetadata });
        Object.assign(template, updated);
        refreshDomesticOnlyText();
        domesticOnlyStatus.textContent = 'Saved.';
      } catch (err) {
        domesticOnlyStatus.textContent = err.message || 'Could not save.';
        domesticOnlyStatus.classList.add('error');
      } finally {
        setMetadataSaveBusy(false);
        syncMetadataSaveButtonsDisabled(template.templateId); // #457, see above
      }
    });
    domesticOnlyPanel.appendChild(domesticOnlySaveBtn);
    domesticOnlyPanel.appendChild(domesticOnlyStatus);

    domesticOnlyToggle.addEventListener('click', () => {
      domesticOnlyPanel.hidden = !domesticOnlyPanel.hidden;
      domesticOnlyToggle.textContent = `Edit Shipping ${domesticOnlyPanel.hidden ? '▾' : '▴'}`;
      if (!domesticOnlyPanel.hidden) domesticOnlyCheckbox.checked = !!template.metadata?.domesticOnly;
    });

    // Edit Size: correct a mis-measured (or since-outgrown) real-world
    // size after the fact — proportional-only, same as the upload
    // wizard's own dimensions step (handleUploadDimensionsStep), since
    // Trim (not this) is the tool for changing one instance's own aspect
    // ratio. A real uploaded model gets its actual geometry rescaled to
    // match (rescaleModelFile) and re-uploaded before the template is
    // patched — a placeholder box product has no model file to rescale,
    // so its dimensions alone are patched. Either way, the server-side
    // PATCH handler notifies every builder with this template placed
    // (see notifyBuildersOfDimensionChange) — nothing extra to call here.
    const sizeToggle = document.createElement('button');
    // Own classes throughout, not shared with the Extensibility toggle/
    // panel/rows below despite the identical look (same CSS rules, applied
    // to both) — several existing tests select the Extensibility panel's
    // axis rows/inputs by class and index (nth(0)/(1)/(2)) assuming exactly
    // three such elements per row; a second, earlier-in-DOM set under a
    // shared class would silently shift those indices.
    sizeToggle.className = 'seller-extensibility-toggle seller-size-toggle';
    sizeToggle.type = 'button';
    sizeToggle.textContent = 'Edit Size ▾';
    details.appendChild(sizeToggle);

    const sizePanel = document.createElement('div');
    sizePanel.className = 'seller-size-panel';
    sizePanel.hidden = true;
    details.appendChild(sizePanel);

    const sizeInputs = {};
    for (const axis of AXIS_LIST) {
      const axisRow = document.createElement('label');
      axisRow.className = 'seller-size-row';
      const text = document.createElement('span');
      text.textContent = AXIS_ROW_LABELS[axis];
      const input = document.createElement('input');
      input.className = 'seller-size-input';
      input.type = 'number';
      input.step = '0.01';
      input.min = '0';
      axisRow.appendChild(text);
      axisRow.appendChild(input);
      sizePanel.appendChild(axisRow);
      sizeInputs[axis] = input;
    }

    function fillSizeInputs() {
      for (const axis of AXIS_LIST) {
        sizeInputs[axis].value = toDisplayLength(template.dimensions[AXIS_DIMENSION_KEY[axis]]).toFixed(2);
      }
    }
    fillSizeInputs();

    // Editing one axis rescales the other two in lockstep off the
    // template's own current dimensions (not whatever's mid-edit in the
    // other fields), so repeated edits can't compound rounding error —
    // same approach as the upload wizard's proportional linking.
    for (const axis of AXIS_LIST) {
      sizeInputs[axis].addEventListener('input', () => {
        const key = AXIS_DIMENSION_KEY[axis];
        const editedMeters = fromDisplayLength(Number(sizeInputs[axis].value));
        if (!Number.isFinite(editedMeters) || editedMeters <= 0) return;
        const scaleFactor = editedMeters / template.dimensions[key];
        if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return;
        for (const otherAxis of AXIS_LIST) {
          if (otherAxis === axis) continue;
          const otherKey = AXIS_DIMENSION_KEY[otherAxis];
          sizeInputs[otherAxis].value = toDisplayLength(template.dimensions[otherKey] * scaleFactor).toFixed(2);
        }
      });
    }

    // Own classes, not .seller-row-status/.seller-save-btn (see the
    // classes comment above the toggle/panel) — several tests read "the"
    // row status or click "the" save button by class alone, assuming just
    // one of each per row.
    const sizeStatus = document.createElement('div');
    sizeStatus.className = 'seller-size-status';

    const sizeSaveBtn = document.createElement('button');
    sizeSaveBtn.className = 'seller-size-save-btn metadata-save-btn';
    sizeSaveBtn.type = 'button';
    sizeSaveBtn.textContent = 'Save Size';
    metadataSaveButtons.push(sizeSaveBtn);
    sizeSaveBtn.addEventListener('click', async () => {
      if (isMetadataSaveBusy()) return;
      sizeStatus.textContent = '';
      sizeStatus.classList.remove('error');
      const nextDimensions = {
        width: fromDisplayLength(Number(sizeInputs.x.value)),
        depth: fromDisplayLength(Number(sizeInputs.y.value)),
        height: fromDisplayLength(Number(sizeInputs.z.value)),
      };
      if (!Object.values(nextDimensions).every((value) => Number.isFinite(value) && value > 0)) {
        sizeStatus.textContent = 'Enter a positive size for each dimension.';
        sizeStatus.classList.add('error');
        return;
      }
      if (!dimensionsChanged(nextDimensions, template.dimensions)) {
        sizeStatus.textContent = 'No change.';
        return;
      }
      setMetadataSaveBusy(true);
      for (const btn of metadataSaveButtons) btn.disabled = true;
      try {
        const patch = { dimensions: nextDimensions };
        if (template.modelUrl?.startsWith('/uploads/')) {
          const scaleFactor = nextDimensions.width / template.dimensions.width;
          sizeStatus.textContent = 'Rescaling model…';
          const originalBlob = await fetch(template.modelUrl).then((res) => res.blob());
          const rescaledBlob = await rescaleModelFile(originalBlob, scaleFactor);
          sizeStatus.textContent = 'Uploading resized model…';
          const rescaled = await uploadModelFile(new File([rescaledBlob], 'model.glb', { type: 'model/gltf-binary' }));
          patch.modelUrl = rescaled.modelUrl;
          patch.modelSizeBytes = rescaled.sizeBytes;
        }
        sizeStatus.textContent = 'Saving…';
        const updated = await updateCatalogTemplate(template.templateId, patch);
        Object.assign(template, updated);
        refreshDimsText();
        // #544/#327: dimensions changed (and possibly the model itself, if
        // it was rescaled/re-uploaded above) — both affect what the catalog
        // picker's thumbnail actually renders, so the cached render (and
        // its embedding) from before this save is stale. Re-persist so both
        // the in-session picker and the stored image_url pick up the new
        // size instead of quietly going stale.
        catalogThumbnailCache.delete(template.templateId);
        catalogThumbnailEmbeddingCache.delete(template.templateId);
        persistCatalogThumbnail(template);
        buildCatalogPickerButtons();
        // #543: this row's own previewContainer can be stale by the time this
        // slow (fetch → rescale → upload → save) chain resolves — the Seller
        // modal may have been closed and reopened in the meantime, which
        // rebuilds every row (and its previewContainer) from scratch while
        // leaving this closure pointing at the old, now-detached node.
        // Without this check, re-showing the preview here would yank the
        // shared preview canvas out of whatever OTHER row currently has it
        // open and re-mount it into this detached node instead.
        if (axisPreview?.templateId === template.templateId && previewContainer.isConnected) {
          showAxisPreview(template, previewContainer, extensibilityPanel.hidden ? null : checkedAxes());
        }
        sizeStatus.textContent = 'Saved — any builder with this placed has been notified.';
      } catch (err) {
        sizeStatus.textContent = err.message || 'Could not resize.';
        sizeStatus.classList.add('error');
      } finally {
        setMetadataSaveBusy(false);
        syncMetadataSaveButtonsDisabled(template.templateId);
      }
    });
    sizePanel.appendChild(sizeSaveBtn);
    sizePanel.appendChild(sizeStatus);

    sizeToggle.addEventListener('click', () => {
      sizePanel.hidden = !sizePanel.hidden;
      sizeToggle.textContent = `Edit Size ${sizePanel.hidden ? '▾' : '▴'}`;
      if (!sizePanel.hidden) fillSizeInputs();
    });

    // Edit Price: the only way a seller can ever set/change a product's
    // priceCents after upload (the upload wizard's own price field only
    // covers creation) — same collapsed-panel-with-a-Save-step idiom as
    // Edit Size just above, own classes throughout for the same reasons.
    const priceToggle = document.createElement('button');
    priceToggle.className = 'seller-extensibility-toggle seller-price-toggle';
    priceToggle.type = 'button';
    priceToggle.textContent = 'Edit Price ▾';
    details.appendChild(priceToggle);

    const pricePanel = document.createElement('div');
    pricePanel.className = 'seller-price-panel';
    pricePanel.hidden = true;
    details.appendChild(pricePanel);

    const priceInput = document.createElement('input');
    priceInput.className = 'seller-price-input';
    priceInput.type = 'text';
    priceInput.inputMode = 'decimal';
    pricePanel.appendChild(priceInput);

    // N50: reformat to "$123.45" once the seller leaves the field — see
    // parsePriceInputDollars/formatDollarsForPriceInput above.
    priceInput.addEventListener('blur', () => {
      const dollars = parsePriceInputDollars(priceInput.value);
      if (Number.isFinite(dollars) && dollars >= 0) {
        priceInput.value = formatDollarsForPriceInput(dollars);
      }
    });

    function fillPriceInput() {
      priceInput.value = template.priceCents == null ? '' : formatDollarsForPriceInput(template.priceCents / 100);
    }
    fillPriceInput();

    const priceStatus = document.createElement('div');
    priceStatus.className = 'seller-price-status';

    const priceSaveBtn = document.createElement('button');
    priceSaveBtn.className = 'seller-price-save-btn metadata-save-btn';
    priceSaveBtn.type = 'button';
    priceSaveBtn.textContent = 'Save Price';
    metadataSaveButtons.push(priceSaveBtn);
    priceSaveBtn.addEventListener('click', async () => {
      if (isMetadataSaveBusy()) return;
      priceStatus.textContent = '';
      priceStatus.classList.remove('error');
      const trimmed = priceInput.value.trim();
      let priceCents = null;
      if (trimmed) {
        const dollars = parsePriceInputDollars(trimmed);
        if (!Number.isFinite(dollars) || dollars < 0) {
          priceStatus.textContent = 'Price must be a non-negative number, or left blank.';
          priceStatus.classList.add('error');
          return;
        }
        if (Math.round(dollars * 100) > MAX_MONEY_CENTS) {
          priceStatus.textContent = `Price must be ${formatPriceCents(MAX_MONEY_CENTS)} or less.`;
          priceStatus.classList.add('error');
          return;
        }
        priceCents = Math.round(dollars * 100);
      }
      if (priceCents === template.priceCents) {
        priceStatus.textContent = 'No change.';
        return;
      }
      setMetadataSaveBusy(true);
      for (const btn of metadataSaveButtons) btn.disabled = true;
      try {
        const updated = await updateCatalogTemplate(template.templateId, { priceCents });
        Object.assign(template, updated);
        refreshPriceText();
        priceStatus.textContent = 'Saved.';
        priceToggle.textContent = `Edit Price ${pricePanel.hidden ? '▾' : '▴'}`;
      } catch (err) {
        priceStatus.textContent = err.message || 'Could not save.';
        priceStatus.classList.add('error');
      } finally {
        setMetadataSaveBusy(false);
        syncMetadataSaveButtonsDisabled(template.templateId);
      }
    });
    pricePanel.appendChild(priceSaveBtn);
    pricePanel.appendChild(priceStatus);

    priceToggle.addEventListener('click', () => {
      pricePanel.hidden = !pricePanel.hidden;
      priceToggle.textContent = `Edit Price ${pricePanel.hidden ? '▾' : '▴'}`;
      if (!pricePanel.hidden) fillPriceInput();
    });

    const rowStatus = document.createElement('div');
    rowStatus.className = 'seller-row-status';

    const actions = document.createElement('div');
    actions.className = 'seller-row-actions';
    details.appendChild(actions);

    const previewContainer = document.createElement('div');
    previewContainer.className = 'seller-row-preview';
    details.appendChild(previewContainer);

    // General-purpose look-it-over view by default (no axis arrows) — see
    // showAxisPreview's own doc comment. Toggling reuses the single
    // shared canvas rather than one per row.
    const previewBtn = document.createElement('button');
    previewBtn.className = 'seller-row-action-btn';
    previewBtn.type = 'button';
    previewBtn.textContent = 'Preview';
    previewBtn.addEventListener('click', () => {
      const alreadyOpenHere = axisPreview?.templateId === template.templateId;
      disposeAxisPreview();
      previewBtn.classList.remove('active');
      if (alreadyOpenHere) return; // toggled off
      previewBtn.classList.add('active');
      const showingExtensibility = !extensibilityPanel.hidden;
      showAxisPreview(template, previewContainer, showingExtensibility ? checkedAxes() : null);
    });
    actions.appendChild(previewBtn);

    const renameBtn = document.createElement('button');
    renameBtn.className = 'seller-row-action-btn';
    renameBtn.type = 'button';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', async () => {
      const next = prompt('Rename this product', template.name);
      if (!next || !next.trim() || next.trim() === template.name) return;
      const trimmedNext = next.trim();
      if (trimmedNext.length > 100) {
        alert('Keep it to 100 characters or fewer.');
        return;
      }
      if (hasDuplicateProductName(trimmedNext, template.templateId) &&
        !confirm(`You already have another product named "${trimmedNext}". Rename anyway?`)) return;
      rowStatus.textContent = '';
      rowStatus.classList.remove('error');
      renameBtn.disabled = true;
      try {
        const updated = await updateCatalogTemplate(template.templateId, { name: trimmedNext });
        Object.assign(template, updated);
        label.textContent = template.name;
        buildCatalogPickerButtons();
      } catch (err) {
        rowStatus.textContent = err.message || 'Could not rename.';
        rowStatus.classList.add('error');
      } finally {
        renameBtn.disabled = false;
      }
    });
    actions.appendChild(renameBtn);

    // Duplicates the catalog row only — modelUrl is copied by reference,
    // not re-uploaded, so this is cheap and the original file is never
    // touched (deleting a template only ever removes its D1 row, never
    // the underlying R2 object — see docs/API.md). Lets a seller try
    // extensibility (or any other edit) on a copy without any risk to a
    // product they already have placed instances of, like a real scan
    // they don't want to accidentally break.
    const duplicateBtn = document.createElement('button');
    duplicateBtn.className = 'seller-row-action-btn';
    duplicateBtn.type = 'button';
    duplicateBtn.textContent = 'Duplicate';
    duplicateBtn.addEventListener('click', async () => {
      rowStatus.textContent = '';
      rowStatus.classList.remove('error');
      duplicateBtn.disabled = true;
      try {
        const copy = await createCatalogTemplate({
          name: `${template.name} (copy)`,
          category: template.category,
          subcategory: template.subcategory,
          dimensions: template.dimensions,
          color: template.color,
          modelUrl: template.modelUrl,
          // modelUrl is copied by reference (see this button's own comment
          // above) — the underlying file, and so its size and skeleton, is
          // identical.
          modelSizeBytes: template.modelSizeBytes,
          skeletonSignature: template.skeletonSignature,
          priceCents: template.priceCents,
          stockQuantity: template.stockQuantity,
          metadata: template.metadata,
          // Safe to read directly (not ensureSellerIdentity()) — this only
          // ever runs while the Seller modal is open, which already
          // guaranteed one via openSellerModal().
          sellerId,
        });
        // #327: fire-and-forget, deliberately not awaited -- same reasoning
        // as the upload-flow and resize-save call sites. Without this, the
        // copy's imageUrl/imageEmbedding stay permanently null (nothing else
        // ever backfills them), making it unfindable via Prompt-mode
        // similarity search and forcing every picker render to re-render its
        // full GLTF model from scratch instead of reusing a stored image.
        persistCatalogThumbnail(copy);
        activeCatalog.push(copy);
        buildCatalogPickerButtons();
        refreshSellerShowcase();
        // #1342: this used to call renderSellerList() directly -- if List
        // view was active (toggled while this await was in flight), that
        // rebuilt the hidden Manage DOM while the visible List view never
        // picked up the new copy. renderActiveSellerView() is the shared
        // dispatcher every other mutation path in this file already uses.
        renderActiveSellerView();
      } catch (err) {
        rowStatus.textContent = err.message || 'Could not duplicate.';
        rowStatus.classList.add('error');
        duplicateBtn.disabled = false;
      }
    });
    actions.appendChild(duplicateBtn);

    // A hard delete — only the catalog row, never the underlying R2 model
    // (see the Duplicate comment above) — so it's recoverable by
    // re-registering the same modelUrl, just not from this UI. The
    // worker's placed_instances -> catalog_templates foreign key blocks
    // this outright (a 409) if the product is still placed anywhere,
    // rather than silently orphaning those instances — caught below and
    // reworded, since the server's own message is written for any FK
    // conflict on the API, not specifically "this product is in use."
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'seller-row-action-btn danger';
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Delete "${template.name}"? This can't be undone.`)) return;
      rowStatus.textContent = '';
      rowStatus.classList.remove('error');
      deleteBtn.disabled = true;
      try {
        await deleteCatalogTemplate(template.templateId);
        setActiveCatalog(activeCatalog.filter((t) => t.templateId !== template.templateId));
        buildCatalogPickerButtons();
        refreshSellerShowcase();
        // #1342: same fix as Duplicate's own handler above -- renderActiveSellerView()
        // instead of renderSellerList() directly, so a deleted product
        // doesn't keep showing (and staying tappable) in List view if that
        // was the active view when this await resolved.
        renderActiveSellerView();
      } catch (err) {
        // #729: a saved-layout or landlet-version-history block (see the
        // worker's assertCatalogTemplatesDeletable) has nothing placed to
        // remove -- "remove those instances first" would send the seller
        // looking for a fix that doesn't exist, so those get their own
        // wording distinct from the generic "still in use" FK message.
        if (err.message?.includes('referenced by a saved layout')) {
          rowStatus.textContent = "Still saved in someone's layout library — it can't be deleted until that saved layout is removed or no longer references it.";
        } else if (err.message?.includes("referenced by a landlet's version history")) {
          rowStatus.textContent = "Used in a lándlet's past published version — it can't be deleted while that version history exists.";
        } else if (err.message?.includes('still in use')) {
          rowStatus.textContent = 'Still placed somewhere — remove those instances first, or Duplicate to edit a copy instead.';
        } else {
          rowStatus.textContent = err.message || 'Could not delete.';
        }
        rowStatus.classList.add('error');
        deleteBtn.disabled = false;
      }
    });
    actions.appendChild(deleteBtn);

    // Ground/flooring (docs/SPEC.md §3, see isFlooringTemplate in this
    // file) — a single opt-in flag, not a numeric form like Extensibility
    // or Edit Size, so a plain immediate-PATCH toggle button fits better
    // than a collapsed panel with its own Save step.
    const flooringToggleBtn = document.createElement('button');
    flooringToggleBtn.className = 'seller-row-action-btn metadata-save-btn';
    flooringToggleBtn.type = 'button';
    flooringToggleBtn.classList.toggle('active', isFlooringTemplate(template));
    flooringToggleBtn.setAttribute('aria-pressed', String(isFlooringTemplate(template)));
    flooringToggleBtn.textContent = isFlooringTemplate(template) ? 'Flooring ✓' : 'Flooring';
    metadataSaveButtons.push(flooringToggleBtn);
    flooringToggleBtn.addEventListener('click', async () => {
      if (isMetadataSaveBusy()) return;
      rowStatus.textContent = '';
      rowStatus.classList.remove('error');
      setMetadataSaveBusy(true);
      for (const btn of metadataSaveButtons) btn.disabled = true;
      try {
        const nextMetadata = { ...template.metadata, flooring: !isFlooringTemplate(template) };
        if (!nextMetadata.flooring) delete nextMetadata.flooring;
        const updated = await updateCatalogTemplate(template.templateId, { metadata: nextMetadata });
        Object.assign(template, updated);
        flooringToggleBtn.classList.toggle('active', isFlooringTemplate(template));
        flooringToggleBtn.setAttribute('aria-pressed', String(isFlooringTemplate(template)));
        flooringToggleBtn.textContent = isFlooringTemplate(template) ? 'Flooring ✓' : 'Flooring';
        buildCatalogPickerButtons();
      } catch (err) {
        rowStatus.textContent = err.message || 'Could not update.';
        rowStatus.classList.add('error');
      } finally {
        setMetadataSaveBusy(false);
        syncMetadataSaveButtonsDisabled(template.templateId); // #457, see above
      }
    });
    actions.appendChild(flooringToggleBtn);

    // Extensibility (see docs/API.md) is a real but rare need — collapsed
    // by default so the row reads as "a product with some buttons," not
    // as a trim-configuration form. A template can be extensible on any
    // subset of its three axes at once (e.g. a wall resizable in
    // thickness, length, AND height) — each axis gets its own row here,
    // an independent checkbox plus min-length field rather than a single
    // either/or picker, and Save writes all three at once.
    const existingExtensible = extensibleAxes(template) || {};
    const extensibilityToggle = document.createElement('button');
    extensibilityToggle.className = 'seller-extensibility-toggle';
    extensibilityToggle.type = 'button';
    const anyAxisOn = () => Object.keys(existingExtensible).length > 0;
    extensibilityToggle.textContent = anyAxisOn() ? 'Extensibility (on) ▾' : 'Extensibility ▾';
    details.appendChild(extensibilityToggle);

    const extensibilityPanel = document.createElement('div');
    extensibilityPanel.className = 'seller-extensibility-panel';
    extensibilityPanel.hidden = true;
    details.appendChild(extensibilityPanel);

    const axisRows = {};
    function checkedAxes() {
      return AXIS_LIST.filter((axis) => axisRows[axis].checkbox.checked);
    }

    extensibilityToggle.addEventListener('click', () => {
      extensibilityPanel.hidden = !extensibilityPanel.hidden;
      extensibilityToggle.textContent = `${anyAxisOn() ? 'Extensibility (on)' : 'Extensibility'} ${extensibilityPanel.hidden ? '▾' : '▴'}`;
      // If this row's preview is already open, switch it between the
      // plain general view and the axis-arrow legend to match — no need
      // to open one that wasn't already showing.
      if (axisPreview?.templateId === template.templateId) {
        showAxisPreview(template, previewContainer, extensibilityPanel.hidden ? null : checkedAxes());
      }
    });

    for (const axis of AXIS_LIST) {
      const axisRow = document.createElement('label');
      axisRow.className = 'seller-axis-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !!existingExtensible[axis];

      const text = document.createElement('span');
      text.textContent = AXIS_ROW_LABELS[axis];

      const minInput = document.createElement('input');
      minInput.className = 'seller-min-input';
      minInput.type = 'number';
      minInput.step = '0.01';
      minInput.min = '0';
      minInput.placeholder = `min ${unitSuffix()}`;
      minInput.disabled = !checkbox.checked;
      if (existingExtensible[axis]) minInput.value = toDisplayLength(existingExtensible[axis].minM).toFixed(2);

      checkbox.addEventListener('change', () => {
        minInput.disabled = !checkbox.checked;
        if (axisPreview?.templateId === template.templateId) showAxisPreview(template, previewContainer, checkedAxes());
      });

      axisRow.appendChild(checkbox);
      axisRow.appendChild(text);
      axisRow.appendChild(minInput);
      extensibilityPanel.appendChild(axisRow);
      axisRows[axis] = { checkbox, minInput };
    }

    const saveBtn = document.createElement('button');
    saveBtn.className = 'seller-save-btn metadata-save-btn';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    metadataSaveButtons.push(saveBtn);

    saveBtn.addEventListener('click', async () => {
      if (isMetadataSaveBusy()) return;
      rowStatus.textContent = '';
      rowStatus.classList.remove('error');
      const nextExtensible = {};
      for (const axis of AXIS_LIST) {
        const { checkbox, minInput } = axisRows[axis];
        if (!checkbox.checked) continue;
        const minM = fromDisplayLength(Number(minInput.value));
        const maxLength = template.dimensions[AXIS_DIMENSION_KEY[axis]];
        if (!Number.isFinite(minM) || minM <= 0) {
          rowStatus.textContent = `${AXIS_ROW_LABELS[axis]} minimum length must be a positive number.`;
          rowStatus.classList.add('error');
          return;
        }
        if (minM >= maxLength) {
          rowStatus.textContent = `${AXIS_ROW_LABELS[axis]} minimum must be less than this product's own ${formatLength(maxLength)} size.`;
          rowStatus.classList.add('error');
          return;
        }
        nextExtensible[axis] = { minM };
      }
      setMetadataSaveBusy(true);
      for (const btn of metadataSaveButtons) btn.disabled = true;
      try {
        // A full replace, not a merge — validateTemplate on the worker
        // side takes whatever `metadata` is sent as the template's entire
        // new metadata, so any OTHER keys already there (like
        // placeholder: true) have to be carried through here rather than
        // just sending the one key this form actually edits.
        const nextMetadata = { ...template.metadata };
        if (Object.keys(nextExtensible).length > 0) {
          nextMetadata.extensible = nextExtensible;
        } else {
          delete nextMetadata.extensible;
        }
        const updated = await updateCatalogTemplate(template.templateId, { metadata: nextMetadata });
        Object.assign(template, updated);
        Object.assign(existingExtensible, nextExtensible);
        for (const axis of AXIS_LIST) if (!nextExtensible[axis]) delete existingExtensible[axis];
        rowStatus.textContent = 'Saved.';
        extensibilityToggle.textContent = `${anyAxisOn() ? 'Extensibility (on)' : 'Extensibility'} ${extensibilityPanel.hidden ? '▾' : '▴'}`;
      } catch (err) {
        rowStatus.textContent = err.message || 'Could not save.';
        rowStatus.classList.add('error');
      } finally {
        setMetadataSaveBusy(false);
        syncMetadataSaveButtonsDisabled(template.templateId); // #457, see above
      }
    });

    extensibilityPanel.appendChild(saveBtn);

    // Sit/lean interaction targets (docs/SPEC.md §2, docs/API.md's
    // "Sit/lean interaction targets (#2476)") — schema/metadata-only piece
    // of the #2475 tracking issue; the actual targeting/pose logic is a
    // later sub-issue. Same collapsed-panel-with-a-Save-step idiom as
    // Extensibility above, with two independent sections (a product can
    // be sittable, leanable, both, or neither).
    const SIT_LEAN_TARGETS = [
      { key: 'sitTarget', label: 'Sittable', className: 'seller-sit-target' },
      { key: 'leanTarget', label: 'Leanable', className: 'seller-lean-target' },
    ];
    const existingSitLean = {};
    for (const { key } of SIT_LEAN_TARGETS) existingSitLean[key] = template.metadata?.[key] || null;
    const anySitLeanOn = () => SIT_LEAN_TARGETS.some(({ key }) => !!existingSitLean[key]);

    const sitLeanToggle = document.createElement('button');
    sitLeanToggle.className = 'seller-extensibility-toggle seller-sit-lean-toggle';
    sitLeanToggle.type = 'button';
    sitLeanToggle.textContent = `${anySitLeanOn() ? 'Sit/Lean Target (on)' : 'Sit/Lean Target'} ▾`;
    details.appendChild(sitLeanToggle);

    const sitLeanPanel = document.createElement('div');
    sitLeanPanel.className = 'seller-sit-lean-panel';
    sitLeanPanel.hidden = true;
    details.appendChild(sitLeanPanel);

    sitLeanToggle.addEventListener('click', () => {
      sitLeanPanel.hidden = !sitLeanPanel.hidden;
      sitLeanToggle.textContent = `${anySitLeanOn() ? 'Sit/Lean Target (on)' : 'Sit/Lean Target'} ${sitLeanPanel.hidden ? '▾' : '▴'}`;
    });

    const sitLeanFields = {};
    for (const { key, label, className } of SIT_LEAN_TARGETS) {
      const existing = existingSitLean[key];

      const checkboxLabel = document.createElement('label');
      checkboxLabel.className = `${className}-checkbox-label`;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !!existing;
      checkboxLabel.appendChild(checkbox);
      checkboxLabel.appendChild(document.createTextNode(label));
      sitLeanPanel.appendChild(checkboxLabel);

      const offsetXInput = document.createElement('input');
      offsetXInput.className = `${className}-offset-x-input`;
      offsetXInput.type = 'number';
      offsetXInput.step = '0.01';
      offsetXInput.placeholder = `offset X (${unitSuffix()})`;
      offsetXInput.disabled = !checkbox.checked;
      if (existing) offsetXInput.value = toDisplayLength(existing.offsetXM).toFixed(2);

      const offsetYInput = document.createElement('input');
      offsetYInput.className = `${className}-offset-y-input`;
      offsetYInput.type = 'number';
      offsetYInput.step = '0.01';
      offsetYInput.placeholder = `offset Y (${unitSuffix()})`;
      offsetYInput.disabled = !checkbox.checked;
      if (existing) offsetYInput.value = toDisplayLength(existing.offsetYM).toFixed(2);

      const heightInput = document.createElement('input');
      heightInput.className = `${className}-height-input`;
      heightInput.type = 'number';
      heightInput.step = '0.01';
      heightInput.min = '0';
      heightInput.placeholder = `height (${unitSuffix()})`;
      heightInput.disabled = !checkbox.checked;
      if (existing) heightInput.value = toDisplayLength(existing.heightM).toFixed(2);

      const facingInput = document.createElement('input');
      facingInput.className = `${className}-facing-input`;
      facingInput.type = 'number';
      facingInput.step = '0.01';
      facingInput.placeholder = 'facing (radians)';
      facingInput.disabled = !checkbox.checked;
      if (existing) facingInput.value = existing.facingRad.toFixed(2);

      checkbox.addEventListener('change', () => {
        offsetXInput.disabled = !checkbox.checked;
        offsetYInput.disabled = !checkbox.checked;
        heightInput.disabled = !checkbox.checked;
        facingInput.disabled = !checkbox.checked;
      });

      const row = document.createElement('div');
      row.className = `${className}-row`;
      row.appendChild(offsetXInput);
      row.appendChild(offsetYInput);
      row.appendChild(heightInput);
      row.appendChild(facingInput);
      sitLeanPanel.appendChild(row);

      sitLeanFields[key] = { checkbox, offsetXInput, offsetYInput, heightInput, facingInput };
    }

    const sitLeanStatus = document.createElement('div');
    sitLeanStatus.className = 'seller-sit-lean-status';

    const sitLeanSaveBtn = document.createElement('button');
    sitLeanSaveBtn.className = 'seller-sit-lean-save-btn metadata-save-btn';
    sitLeanSaveBtn.type = 'button';
    sitLeanSaveBtn.textContent = 'Save Sit/Lean Target';
    metadataSaveButtons.push(sitLeanSaveBtn);

    sitLeanSaveBtn.addEventListener('click', async () => {
      if (isMetadataSaveBusy()) return;
      sitLeanStatus.textContent = '';
      sitLeanStatus.classList.remove('error');
      const nextTargets = {};
      for (const { key, label } of SIT_LEAN_TARGETS) {
        const { checkbox, offsetXInput, offsetYInput, heightInput, facingInput } = sitLeanFields[key];
        if (!checkbox.checked) continue;
        const offsetXM = fromDisplayLength(Number(offsetXInput.value));
        const offsetYM = fromDisplayLength(Number(offsetYInput.value));
        const heightM = fromDisplayLength(Number(heightInput.value));
        const facingRad = Number(facingInput.value);
        if (!Number.isFinite(offsetXM) || Math.abs(offsetXM) > template.dimensions.width / 2) {
          sitLeanStatus.textContent = `${label} offset X must be within +/- half this product's own width.`;
          sitLeanStatus.classList.add('error');
          return;
        }
        if (!Number.isFinite(offsetYM) || Math.abs(offsetYM) > template.dimensions.depth / 2) {
          sitLeanStatus.textContent = `${label} offset Y must be within +/- half this product's own depth.`;
          sitLeanStatus.classList.add('error');
          return;
        }
        if (!Number.isFinite(heightM) || heightM < 0 || heightM > template.dimensions.height) {
          sitLeanStatus.textContent = `${label} height must be between 0 and this product's own height.`;
          sitLeanStatus.classList.add('error');
          return;
        }
        if (!Number.isFinite(facingRad)) {
          sitLeanStatus.textContent = `${label} facing must be a number.`;
          sitLeanStatus.classList.add('error');
          return;
        }
        nextTargets[key] = { offsetXM, offsetYM, heightM, facingRad };
      }
      setMetadataSaveBusy(true);
      for (const btn of metadataSaveButtons) btn.disabled = true;
      try {
        // A full replace, not a merge -- same reasoning as Extensibility's
        // own save handler above.
        const nextMetadata = { ...template.metadata };
        for (const { key } of SIT_LEAN_TARGETS) {
          if (nextTargets[key]) nextMetadata[key] = nextTargets[key];
          else delete nextMetadata[key];
        }
        const updated = await updateCatalogTemplate(template.templateId, { metadata: nextMetadata });
        Object.assign(template, updated);
        for (const { key } of SIT_LEAN_TARGETS) existingSitLean[key] = nextTargets[key] || null;
        sitLeanStatus.textContent = 'Saved.';
        sitLeanToggle.textContent = `${anySitLeanOn() ? 'Sit/Lean Target (on)' : 'Sit/Lean Target'} ${sitLeanPanel.hidden ? '▾' : '▴'}`;
      } catch (err) {
        sitLeanStatus.textContent = err.message || 'Could not save.';
        sitLeanStatus.classList.add('error');
      } finally {
        setMetadataSaveBusy(false);
        syncMetadataSaveButtonsDisabled(template.templateId); // #457, see above
      }
    });

    sitLeanPanel.appendChild(sitLeanSaveBtn);
    sitLeanPanel.appendChild(sitLeanStatus);

    // Product reviews (docs/SPEC.md §5, docs/API.md's "Product reviews") —
    // shopper-authored, tied to this product itself rather than to any one
    // placed instance of it, so this is the seller's own moderation view,
    // not a Build-mode one. Collapsed by default like Extensibility above,
    // fetched lazily on first open rather than for every row up front.
    const reviewToggle = document.createElement('button');
    reviewToggle.className = 'seller-extensibility-toggle seller-review-toggle';
    reviewToggle.type = 'button';
    reviewToggle.textContent = 'Reviews ▾';
    details.appendChild(reviewToggle);

    const reviewPanel = document.createElement('div');
    reviewPanel.className = 'seller-review-panel';
    reviewPanel.hidden = true;
    details.appendChild(reviewPanel);

    const reviewSummaryEl = document.createElement('div');
    reviewSummaryEl.className = 'seller-review-summary';
    reviewPanel.appendChild(reviewSummaryEl);

    const reviewListEl = document.createElement('div');
    reviewListEl.className = 'seller-review-list';
    reviewPanel.appendChild(reviewListEl);

    const reviewEmptyEl = document.createElement('div');
    reviewEmptyEl.className = 'seller-review-empty';
    reviewEmptyEl.textContent = 'No reviews yet.';
    reviewPanel.appendChild(reviewEmptyEl);

    const reviewTruncatedEl = document.createElement('div');
    reviewTruncatedEl.className = 'seller-review-truncated';
    reviewTruncatedEl.hidden = true;
    reviewPanel.appendChild(reviewTruncatedEl);

    // #425: per-row, not module-level — signPostsLoadToken/
    // calendarEventsLoadToken's own single shared counter works there
    // because only one of those panels is ever open at a time, but every
    // seller row here has its own independent Reviews panel, so a shared
    // counter would have unrelated rows' toggles spuriously invalidate
    // each other's still-in-flight loads.
    let reviewLoadToken = 0;
    async function renderReviews() {
      reviewListEl.innerHTML = '';
      reviewSummaryEl.textContent = '';
      reviewTruncatedEl.hidden = true;
      const myLoadToken = ++reviewLoadToken;
      let reviews;
      let averageRating;
      let count;
      try {
        ({ reviews, averageRating, count } = await fetchProductReviews(template.templateId));
      } catch (err) {
        if (myLoadToken !== reviewLoadToken) return; // superseded while fetching
        reviewEmptyEl.textContent = err.message || 'Could not load reviews.';
        reviewEmptyEl.hidden = false;
        return;
      }
      if (myLoadToken !== reviewLoadToken) return; // superseded — a newer call owns the list now
      // #1128: reset back to the friendly default on every successful load —
      // the catch branch above is the only other place this gets written,
      // and without this a single past fetch failure would leave this
      // element showing that stale error message forever, even once a
      // later load succeeds with zero reviews.
      reviewEmptyEl.textContent = 'No reviews yet.';
      reviewEmptyEl.hidden = reviews.length > 0;
      // #1274's own fix added this notice for sign posts/calendar events
      // (count is the real, uncapped total; reviews is windowed to the
      // newest 200 by handleProductReviews) but missed this sibling panel.
      reviewTruncatedEl.hidden = count <= reviews.length;
      reviewTruncatedEl.textContent = `Showing newest ${reviews.length} of ${count} reviews.`;
      if (reviews.length > 0) {
        const stars = '★'.repeat(Math.round(averageRating)) + '☆'.repeat(5 - Math.round(averageRating));
        reviewSummaryEl.textContent = `${stars} ${averageRating.toFixed(1)} average (${count} review${count === 1 ? '' : 's'})`;
      }
      for (const review of reviews) {
        const reviewRow = document.createElement('div');
        reviewRow.className = 'product-review-row';
        const body = document.createElement('div');
        body.className = 'product-review-row-body';
        const author = document.createElement('div');
        author.className = 'product-review-row-author';
        author.textContent = review.authorLabel;
        body.appendChild(author);
        const rating = document.createElement('div');
        rating.className = 'product-review-row-rating';
        rating.textContent = '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
        body.appendChild(rating);
        if (review.text) {
          const text = document.createElement('div');
          text.textContent = review.text;
          body.appendChild(text);
        }
        const time = document.createElement('div');
        time.className = 'product-review-row-time';
        const date = new Date(review.createdAt);
        time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
        body.appendChild(time);
        reviewRow.appendChild(body);
        const deleteRowBtn = document.createElement('button');
        deleteRowBtn.className = 'product-review-row-delete';
        deleteRowBtn.type = 'button';
        deleteRowBtn.textContent = '×';
        deleteRowBtn.setAttribute('aria-label', 'Delete review');
        deleteRowBtn.addEventListener('click', async () => {
          deleteRowBtn.disabled = true;
          try {
            await deleteProductReview(template.templateId, review.reviewId);
            await renderReviews();
          } catch (err) {
            console.warn('Could not delete review:', err);
            deleteRowBtn.disabled = false;
          }
        });
        reviewRow.appendChild(deleteRowBtn);
        reviewListEl.appendChild(reviewRow);
      }
    }

    reviewToggle.addEventListener('click', () => {
      reviewPanel.hidden = !reviewPanel.hidden;
      reviewToggle.textContent = `Reviews ${reviewPanel.hidden ? '▾' : '▴'}`;
      if (!reviewPanel.hidden) renderReviews();
    });

    // Simulated purchases (docs/API.md's "Simulated purchases"/"Refunds")
    // — this product's own sale history, across every builder who happens
    // to host an instance of it (fetchPurchases by templateId, not
    // builderId — see handlePurchases' own comment in worker/index.js).
    // Refunding is seller-initiated here, standing in for a real
    // customer-service-initiated refund (docs/SPEC.md §6's
    // no-personal-support-contact policy) — shoppers have no account in
    // this dev-mode identity system to authenticate a "my purchases"
    // self-service view against in the first place.
    const salesToggle = document.createElement('button');
    salesToggle.className = 'seller-extensibility-toggle seller-sales-toggle';
    salesToggle.type = 'button';
    salesToggle.textContent = 'Sales ▾';
    details.appendChild(salesToggle);

    const salesPanel = document.createElement('div');
    salesPanel.className = 'seller-sales-panel';
    salesPanel.hidden = true;
    details.appendChild(salesPanel);

    const salesSummaryEl = document.createElement('div');
    salesSummaryEl.className = 'seller-sales-summary';
    salesPanel.appendChild(salesSummaryEl);

    const salesListEl = document.createElement('div');
    salesListEl.className = 'seller-sales-list';
    salesPanel.appendChild(salesListEl);

    const salesEmptyEl = document.createElement('div');
    salesEmptyEl.className = 'seller-sales-empty';
    salesEmptyEl.textContent = 'No sales yet.';
    salesPanel.appendChild(salesEmptyEl);

    const salesTruncatedEl = document.createElement('div');
    salesTruncatedEl.className = 'seller-sales-truncated';
    salesTruncatedEl.hidden = true;
    salesPanel.appendChild(salesTruncatedEl);

    // #425: same per-row reasoning as reviewLoadToken above.
    let salesLoadToken = 0;
    async function renderSales() {
      salesListEl.innerHTML = '';
      salesSummaryEl.textContent = '';
      salesTruncatedEl.hidden = true;
      const myLoadToken = ++salesLoadToken;
      let purchases;
      let totalCount;
      try {
        ({ purchases, totalCount } = await fetchPurchases({ templateId: template.templateId }));
      } catch (err) {
        if (myLoadToken !== salesLoadToken) return; // superseded while fetching
        salesEmptyEl.textContent = err.message || 'Could not load sales.';
        salesEmptyEl.hidden = false;
        return;
      }
      if (myLoadToken !== salesLoadToken) return; // superseded — a newer call owns the list now
      // #1128: same reset-on-success fix as reviewEmptyEl above — without
      // it a past fetch failure leaves this stuck on its error message
      // forever, even once a later load succeeds with zero sales.
      salesEmptyEl.textContent = 'No sales yet.';
      salesEmptyEl.hidden = totalCount > 0;
      if (totalCount > 0) {
        salesSummaryEl.textContent = `${totalCount} sale${totalCount === 1 ? '' : 's'}`;
      }
      // #1377: same "windowed list + real total" shape #1331 fixed for the
      // sibling Reviews panel (handlePurchases caps purchases at LIMIT 100
      // but totalCount is the real, uncapped count) — missed here too.
      salesTruncatedEl.hidden = totalCount <= purchases.length;
      salesTruncatedEl.textContent = `Showing newest ${purchases.length} of ${totalCount} sales.`;
      for (const purchase of purchases) {
        const saleRow = document.createElement('div');
        saleRow.className = 'product-sale-row';
        const body = document.createElement('div');
        body.className = 'product-sale-row-body';
        const summary = document.createElement('div');
        summary.className = 'product-sale-row-summary';
        summary.textContent = `${purchase.buyerLabel || 'Anonymous'} — ${purchase.quantity}x, ${formatPriceCents(purchase.totalCents)} total`;
        body.appendChild(summary);
        const commission = document.createElement('div');
        commission.className = 'product-sale-row-commission';
        commission.textContent = `You earned ${formatPriceCents(purchase.builderShareCents)}`;
        body.appendChild(commission);
        const time = document.createElement('div');
        time.className = 'product-sale-row-time';
        const date = new Date(purchase.createdAt);
        time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
        body.appendChild(time);
        saleRow.appendChild(body);

        // #454: a physical (non-digital-good) real-money purchase holds
        // its payout until delivery is confirmed or 7 days after shipping
        // — this is the seller's own side of starting that fallback clock.
        // Neither a digital good (nothing to ship) nor a simulated
        // (higgles) sale (no real Stripe balance to ever hold) shows this.
        if (purchase.paymentIntentId && !purchase.isDigitalGood && !purchase.refundedAt) {
          const shipping = document.createElement('div');
          shipping.className = 'product-sale-row-shipping';
          if (purchase.deliveryConfirmedAt) {
            shipping.textContent = 'Delivery confirmed — available to cash out.';
          } else if (purchase.shippedAt) {
            shipping.textContent = `Shipped ${new Date(purchase.shippedAt).toLocaleDateString()} — available 7 days after shipping if not confirmed sooner.`;
          } else {
            const shipBtn = document.createElement('button');
            shipBtn.className = 'product-sale-row-ship-btn';
            shipBtn.type = 'button';
            shipBtn.textContent = 'Mark shipped';
            shipBtn.addEventListener('click', async () => {
              shipBtn.disabled = true;
              try {
                await markPurchaseShipped(purchase.purchaseId);
                await renderSales();
              } catch (err) {
                alert(err.message || 'Could not mark this purchase shipped.');
                shipBtn.disabled = false;
              }
            });
            shipping.appendChild(shipBtn);
          }
          body.appendChild(shipping);
        }

        if (purchase.refundedAt) {
          const refundedLabel = document.createElement('div');
          refundedLabel.className = 'product-sale-row-refunded';
          refundedLabel.textContent = 'Refunded';
          saleRow.appendChild(refundedLabel);
        } else if (purchase.paidOutAt) {
          // #599: the backend now rejects a refund once paid_out_at is
          // set (that seller-share has already left the platform via a
          // real payout) — mirror that here instead of showing an active
          // button that would just 409.
          const paidOutLabel = document.createElement('div');
          paidOutLabel.className = 'product-sale-row-refunded';
          paidOutLabel.textContent = 'Paid out — contact support for a refund';
          saleRow.appendChild(paidOutLabel);
        } else {
          const refundBtn = document.createElement('button');
          refundBtn.className = 'product-sale-row-refund-btn';
          refundBtn.type = 'button';
          refundBtn.textContent = 'Refund';
          refundBtn.addEventListener('click', async () => {
            refundBtn.disabled = true;
            try {
              await refundPurchase(purchase.purchaseId);
              await renderSales();
            } catch (err) {
              alert(err.message || 'Could not refund this purchase.');
              refundBtn.disabled = false;
            }
          });
          saleRow.appendChild(refundBtn);
        }
        salesListEl.appendChild(saleRow);
      }
    }

    salesToggle.addEventListener('click', () => {
      salesPanel.hidden = !salesPanel.hidden;
      salesToggle.textContent = `Sales ${salesPanel.hidden ? '▾' : '▴'}`;
      if (!salesPanel.hidden) renderSales();
    });

    details.appendChild(rowStatus);
    // #457: a save begun before the modal was closed can still be in
    // flight against this templateId when it's reopened and this row is
    // rebuilt from scratch — disable this row's own freshly-created
    // buttons up front in that case, rather than leaving them clickable
    // and relying solely on isMetadataSaveBusy()'s silent no-op inside
    // each handler (correct, but reads as unresponsive buttons).
    if (isMetadataSaveBusy()) {
      for (const btn of metadataSaveButtons) btn.disabled = true;
    }
    sellerListEl.appendChild(row);
  }
}

// #541: a lighter, thumbnail-first way to browse the same products
// renderSellerList's rows already manage — persists only for this open of
// the modal (resets to 'manage' on next open, same as activeSettingsTab
// resetting per its own comment) since there's no strong reason yet for a
// seller's view choice to survive a close/reopen.
let sellerActiveView = 'manage';

// #1503: the .active class alone communicated "current view" visually but
// not to a screen reader -- aria-pressed mirrors it so the same state is
// announced, not just styled.
function updateSellerViewToggleUI() {
  for (const btn of sellerViewToggleEl.querySelectorAll('.seller-view-btn')) {
    const isActive = btn.dataset.view === sellerActiveView;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  }
}

// Cards, not rows — no edit controls here (that's what Manage is for);
// tapping a card jumps straight into Manage with that product already
// expanded, the same "browse here, edit there" split issue #540 (the
// sibling 3D-array sub-issue) proposes for its own view.
function renderSellerListView() {
  sellerListViewEl.replaceChildren();
  // #542: same shared filtered/sorted product set Manage's own
  // renderSellerList uses — search/filter/sort is meant to work "from
  // either the 3D array or the list view," per the issue's own text, not
  // duplicated per view.
  const allTemplates = myProducts();
  populateSellerCategoryFilterOptions(allTemplates);
  if (allTemplates.length === 0) {
    sellerFilterControlsEl.hidden = true;
    sellerStatusEl.textContent = 'No custom products yet — use "+ Upload Model" to add one.';
    return;
  }
  sellerFilterControlsEl.hidden = false;
  const templates = filterAndSortSellerProducts(allTemplates);
  if (templates.length === 0) {
    sellerStatusEl.textContent = 'No products match your search or filter.';
    return;
  }
  sellerStatusEl.textContent = '';

  for (const template of templates) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'seller-card';

    const thumb = document.createElement('img');
    thumb.className = 'seller-card-thumb';
    thumb.alt = '';
    // Same fallback order as buildCatalogPickerButtons' own thumb.src line
    // (in-session render cache, then a persisted image_url, then a flat
    // color swatch) — this view and the catalog picker are showing the
    // same templates, so they should never disagree on what a product
    // looks like.
    thumb.src = catalogThumbnailCache.get(template.templateId) ?? template.imageUrl ?? solidColorDataUrl(template.color);
    // See buildCatalogTemplateTile's own onerror comment — same gap, same
    // fix: fall back to the flat-color swatch if the persisted imageUrl
    // actually fails to load, not just when it's missing outright.
    thumb.onerror = () => {
      thumb.onerror = null;
      thumb.src = solidColorDataUrl(template.color);
    };
    card.appendChild(thumb);
    if (!catalogThumbnailCache.has(template.templateId) && !template.imageUrl) {
      renderCatalogThumbnail(template).then((dataUrl) => {
        if (dataUrl) thumb.src = dataUrl;
      });
    }

    const name = document.createElement('span');
    name.className = 'seller-card-name';
    name.textContent = template.name;
    card.appendChild(name);

    const price = document.createElement('span');
    price.className = 'seller-card-price';
    price.textContent = template.priceCents == null ? 'Not priced' : formatPriceCents(template.priceCents);
    card.appendChild(price);

    const digitalGoodKey = template.metadata?.digitalGoodDisclaimer;
    if (digitalGoodKey) {
      const digitalGood = document.createElement('span');
      digitalGood.className = 'seller-card-digital-good';
      digitalGood.textContent = 'Digital good';
      card.appendChild(digitalGood);
    }

    card.addEventListener('click', () => focusSellerManageRow(template.templateId));

    sellerListViewEl.appendChild(card);
  }
}

// Shared by every "browse here, edit there" view (List view's own cards
// above, and #540's 3D showcase array) — switches back to Manage with the
// clicked product's row already expanded and scrolled into view, so
// browsing and editing stay one tap apart regardless of which view found
// the product. sellerModalEl itself is not opened here — a caller entering
// this from the 3D array (which can be visible with the modal closed)
// needs to show it first.
function focusSellerManageRow(templateId) {
  sellerActiveView = 'manage';
  updateSellerViewToggleUI();
  renderActiveSellerView();
  const row = sellerListEl.querySelector(`.seller-row[data-template-id="${CSS.escape(String(templateId))}"]`);
  if (row) {
    row.classList.add('expanded');
    row.scrollIntoView({ block: 'nearest' });
  }
}

// Single entry point for (re)rendering whichever of Manage/List view is
// currently active — every caller that used to render the Manage view
// unconditionally (opening the modal, a Units-setting change) goes through
// here now so it keeps refreshing whichever view the seller actually has
// open, not always Manage.
// Exported for src/catalog/upload.js (#2557) -- its own
// handleUploadDimensionsStep needs this same refresh after creating a
// product, to show it in whichever Seller view is currently active.
export function renderActiveSellerView() {
  sellerListEl.hidden = sellerActiveView !== 'manage';
  sellerListViewEl.hidden = sellerActiveView !== 'list';
  if (sellerActiveView === 'list') renderSellerListView();
  else renderSellerList();
}

for (const btn of sellerViewToggleEl.querySelectorAll('.seller-view-btn')) {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === sellerActiveView) return;
    sellerActiveView = btn.dataset.view;
    updateSellerViewToggleUI();
    renderActiveSellerView();
  });
}
updateSellerViewToggleUI();

// Ensures a seller identity is active before showing the modal. Only
// reachable via the #mode-nav Sell tab (openSellerModal call sites below),
// which calls this rather than separately remembering to await
// ensureSellerIdentity() first. Backing out of that picker (Close) means
// there's still no seller identity — just leave the Seller modal unopened
// rather than showing it with nothing to filter its list by.
//
// Also waits on bootstrapPromise first (see its own declaration) — Sell is
// reachable the instant the page loads or right after switching Shop<->
// Build (#mode-nav's own click handler opens it directly, no reload, even
// though switching modes themselves reload the whole page), racing
// whichever bootstrap() call is currently populating activeCatalog. Build
// mode's own chain (auth -> builder identity -> landlet resolution -> the
// catalog fetch) is considerably longer than Shop's (fetches catalog
// almost immediately), so clicking Sell right after Build was reliably
// catching activeCatalog still at its plain FALLBACK_CATALOG default —
// myProducts() then filtered against catalog entries that all have no
// seller at all, showing "No custom products yet" for an account that
// genuinely has some. Confirmed via direct testing: an artificial 50ms
// delay between clicking Build and Sell reproduced this every time;
// waiting for Build's bootstrap to actually finish first did not.
// #1096: this seller's own all-time feedback summary (distinct from any
// one product's review average) — fetched fresh on every modal open since
// new feedback can land between opens, same reasoning renderActiveSellerView
// itself gets re-run on open rather than cached. Hidden entirely until this
// seller has at least one piece of feedback, same "nothing to show yet"
// convention #productInfoEl's own comment documents, rather than a
// permanent "No feedback yet" placeholder taking up space.
// #2514: singleton summary element, so one shared counter (not a per-row
// one like renderReviews' own reviewLoadToken) is the right shape here —
// guards against a double-clicked Sell/Manage button's two openSellerModal()
// calls racing each other and letting the first (now-stale) fetch overwrite
// what the second, newer one already rendered.
let sellerFeedbackLoadToken = 0;
async function renderSellerFeedbackSummary(id) {
  const myLoadToken = ++sellerFeedbackLoadToken;
  let feedback;
  let averageRating;
  let count;
  try {
    ({ feedback, averageRating, count } = await fetchSellerFeedback(id));
  } catch (err) {
    if (myLoadToken !== sellerFeedbackLoadToken) return; // superseded while fetching
    console.warn('Could not load seller feedback summary:', err);
    sellerFeedbackSummaryEl.hidden = true;
    sellerFeedbackListEl.innerHTML = '';
    return;
  }
  if (myLoadToken !== sellerFeedbackLoadToken) return; // superseded — a newer call owns the summary now
  sellerFeedbackSummaryEl.hidden = feedback.length === 0;
  sellerFeedbackListEl.innerHTML = '';
  if (feedback.length === 0) return;
  const stars = '★'.repeat(Math.round(averageRating)) + '☆'.repeat(5 - Math.round(averageRating));
  sellerFeedbackSummaryEl.textContent =
    `Seller feedback: ${stars} ${averageRating.toFixed(1)} average (${count} rating${count === 1 ? '' : 's'})`;
  // #2286: the individual entries (author, rating, free-text comment, date)
  // were fetched above but never rendered anywhere -- mirrors renderReviews'
  // own product-review-row markup for the structurally identical shape,
  // minus its delete button (no self-moderation route exists for seller
  // feedback from the rated seller's own side, see handleSellerFeedbackDelete's
  // own comment in worker/index.js).
  for (const entry of feedback) {
    const row = document.createElement('div');
    // #2292 regression fix: must NOT reuse product-review-row -- the Seller
    // modal shows this list alongside a per-product review panel that uses
    // that exact class (renderReviews), and review-feedback-summary-count
    // .test.mjs's own `.product-review-row` count assertion (scoped to
    // product reviews only) broke the moment both sets of rows shared a
    // class name in the same DOM. Own classes throughout, same visual
    // styling via a shared CSS rule (index.html).
    row.className = 'seller-feedback-row';
    const body = document.createElement('div');
    body.className = 'seller-feedback-row-body';
    const author = document.createElement('div');
    author.className = 'seller-feedback-row-author';
    author.textContent = entry.authorLabel;
    body.appendChild(author);
    const rating = document.createElement('div');
    rating.className = 'seller-feedback-row-rating';
    rating.textContent = '★'.repeat(entry.rating) + '☆'.repeat(5 - entry.rating);
    body.appendChild(rating);
    if (entry.text) {
      const text = document.createElement('div');
      text.textContent = entry.text;
      body.appendChild(text);
    }
    const time = document.createElement('div');
    time.className = 'seller-feedback-row-time';
    const date = new Date(entry.createdAt);
    time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    body.appendChild(time);
    row.appendChild(body);
    sellerFeedbackListEl.appendChild(row);
  }
}

async function openSellerModal() {
  await bootstrapPromise;
  const id = await ensureSellerIdentity();
  if (!id) {
    updateModeNavUI(); // undoes the Sell button's own optimistic highlight below
    return;
  }
  renderSellerFeedbackSummary(id);
  // #541: always opens back on Manage, same as activeSettingsTab resetting
  // to 'general' on next Settings open — a seller's view choice doesn't
  // need to survive a close/reopen yet.
  sellerActiveView = 'manage';
  updateSellerViewToggleUI();
  renderActiveSellerView();
  sellerModalEl.classList.add('visible');
  openModalA11y(sellerModalEl, closeSellerModal);
}
// Exported for src/catalog/upload.js (#2557) -- its own closeUploadModal
// needs this same handler to re-arm the Seller modal's focus trap.
export function closeSellerModal() {
  sellerModalEl.classList.remove('visible');
  closeModalA11y(sellerModalEl);
  disposeAxisPreview();
  // An Edit Size save while this modal was open can have just created a
  // notification for this same builder identity — refresh the badge now
  // rather than leaving it stale until the next Build-mode entry.
  refreshNotificationsBadge();
  // A save in here can change whether the currently-selected item (if any)
  // is extensible — updateSelectionUI() only normally re-runs on an actual
  // selection *change*, so without this the Trim button/field would keep
  // showing whatever was true when the modal opened, stale until the
  // builder reselected something.
  updateSelectionUI();
  // #540: closing this modal is what actually reveals the showcase behind
  // it — rebuild its meshes now if a product was created/duplicated/deleted
  // while the modal was open (refreshSellerShowcase only updated the pager
  // label at the time, deferring this heavier fetch-and-load work so it
  // doesn't compete with whatever save was still in flight).
  if (currentMode === 'sell' && sellerShowcaseMeshesStale) {
    sellerShowcaseMeshesStale = false;
    loadSellerShowcasePage(sellerShowcasePageIndex);
  }
  updateModeNavUI();
}
sellerCloseBtn.addEventListener('click', closeSellerModal);

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
    onRenamed: (id, label) => { shopBuilderLabels.set(id, label); },
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
const DIGITAL_GOOD_DISCLAIMER_TEXT = {
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
const communitySignBtn = document.getElementById('toggle-community-sign');
const communityCalendarBtn = document.getElementById('toggle-community-calendar');
const backupChainBtn = document.getElementById('toggle-backup-chain');
// #2559: see src/build/scene.js's own comment.

// #2559: see src/build/scene.js's own comment.

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

// Community Sign (docs/SPEC.md §6, docs/API.md's "Community signs") — an
// immediate-PATCH flag on the single selected instance the first time (the
// same pattern the Seller modal's own Flooring button uses for a
// per-instance/per-template boolean rather than a form with its own Save
// step). Once already flagged, this same button instead opens the Manage
// Posts panel (#sign-posts-modal, below) rather than un-flagging directly
// — un-flagging lives inside that panel's own "Remove Community Sign"
// button instead. A dedicated always-present "Manage Posts" toolbar button
// was tried first and reverted: on a phone-width viewport it pushed
// #gizmo-mode-controls' wrapped button row tall enough to physically
// overlap and intercept taps meant for the 3D canvas beneath it (caught by
// e2e/bundles.test.mjs — an unrelated test — suddenly failing to select a
// placed tree). Folding both actions into one button removes that extra
// row entirely.
communitySignBtn.addEventListener('click', async () => {
  if (selectedMeshes.size !== 1) return;
  const [mesh] = selectedMeshes;
  if (mesh.userData.isCommunitySign) {
    openSignPostsModal(mesh);
    return;
  }
  mesh.userData.isCommunitySign = true;
  updateSelectionUI();
  persistLayout();
  await syncUpdate(mesh);
});

// A builder's moderation view onto one sign's posts (see docs/API.md's
// "Community signs"), reusing the same modal shell #notifications-modal
// already establishes. Build mode never renders a sign's post sprites
// itself (those are Shop-mode-only, see registerShopSign), so this modal
// is the only place a builder ever sees what's actually been posted.
const signPostsModalEl = document.getElementById('sign-posts-modal');
const signPostsCloseBtn = document.getElementById('sign-posts-close-btn');
const signPostsListEl = document.getElementById('sign-posts-list');
const signPostsEmptyEl = document.getElementById('sign-posts-empty');
const signPostsTruncatedEl = document.getElementById('sign-posts-truncated');
const signPostsUnflagBtn = document.getElementById('sign-posts-unflag-btn');
let signPostsTargetMesh = null;
// Guards against reopening this modal on a different mesh before an
// earlier renderSignPosts()'s own await resolves — without it, the
// earlier call's stale fetch can land after the target has switched and
// append its rows (with the old instanceId baked into each delete
// button) onto a list the user now believes belongs to the new mesh.
// Same pattern as axisPreviewLoadToken/claimMapLoadToken elsewhere in
// this file.
let signPostsLoadToken = 0;

function formatSignPostTime(isoString) {
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

async function renderSignPosts() {
  signPostsListEl.innerHTML = '';
  signPostsTruncatedEl.hidden = true;
  if (!signPostsTargetMesh) return;
  const myLoadToken = ++signPostsLoadToken;
  const instanceId = signPostsTargetMesh.userData.instanceId;
  let posts;
  let totalCount;
  try {
    ({ posts, totalCount } = await fetchSignPosts(instanceId));
  } catch (err) {
    if (myLoadToken !== signPostsLoadToken) return; // superseded while fetching
    signPostsEmptyEl.textContent = err.message || 'Could not load posts.';
    signPostsEmptyEl.hidden = false;
    return;
  }
  if (myLoadToken !== signPostsLoadToken) return; // superseded — a newer call owns the list now
  // #1128: same reset-on-success fix as reviewEmptyEl in the Seller
  // modal — without it a past fetch failure leaves this stuck on its
  // error message forever, even once a later load succeeds with zero posts.
  signPostsEmptyEl.textContent = 'No posts on this sign yet.';
  signPostsEmptyEl.hidden = posts.length > 0;
  // #1274: posts is windowed to the newest 200 (worker/index.js's
  // handleSignPosts); totalCount is the real, uncapped count, so this is
  // the only way to tell a builder older posts exist but aren't shown.
  signPostsTruncatedEl.hidden = totalCount <= posts.length;
  signPostsTruncatedEl.textContent = `Showing newest ${posts.length} of ${totalCount} posts.`;
  for (const post of posts) {
    const row = document.createElement('div');
    row.className = 'sign-post-row';
    const body = document.createElement('div');
    body.className = 'sign-post-row-body';
    const author = document.createElement('div');
    author.className = 'sign-post-row-author';
    author.textContent = post.authorLabel;
    body.appendChild(author);
    const text = document.createElement('div');
    text.textContent = post.text;
    body.appendChild(text);
    const time = document.createElement('div');
    time.className = 'sign-post-row-time';
    time.textContent = formatSignPostTime(post.createdAt);
    body.appendChild(time);
    row.appendChild(body);
    const deleteRowBtn = document.createElement('button');
    deleteRowBtn.className = 'sign-post-row-delete';
    deleteRowBtn.type = 'button';
    deleteRowBtn.textContent = '×';
    deleteRowBtn.setAttribute('aria-label', 'Delete post');
    deleteRowBtn.addEventListener('click', async () => {
      if (!confirm('Delete this post? This can\'t be undone.')) return;
      deleteRowBtn.disabled = true;
      try {
        await deleteSignPost(instanceId, post.postId);
        await renderSignPosts();
      } catch (err) {
        alert(err.message || 'Could not delete this post.');
        deleteRowBtn.disabled = false;
      }
    });
    row.appendChild(deleteRowBtn);
    signPostsListEl.appendChild(row);
  }
}

function openSignPostsModal(mesh) {
  signPostsTargetMesh = mesh;
  signPostsModalEl.classList.add('visible');
  openModalA11y(signPostsModalEl, closeSignPostsModal);
  renderSignPosts();
}
function closeSignPostsModal() {
  signPostsModalEl.classList.remove('visible');
  signPostsTargetMesh = null;
  closeModalA11y(signPostsModalEl);
}
signPostsCloseBtn.addEventListener('click', closeSignPostsModal);
signPostsUnflagBtn.addEventListener('click', async () => {
  if (!signPostsTargetMesh) return;
  const mesh = signPostsTargetMesh;
  mesh.userData.isCommunitySign = false;
  signPostsModalEl.classList.remove('visible');
  signPostsTargetMesh = null;
  closeModalA11y(signPostsModalEl);
  updateSelectionUI();
  persistLayout();
  await syncUpdate(mesh);
});

// Community Calendar (docs/SPEC.md §6, docs/API.md's "Community
// calendar") — structurally identical to Community Sign just above (same
// toggle-then-manage button design, same reasoning), deliberately kept as
// its own independent flag/table rather than merged with signs — see
// migrations/0042's own comment.
communityCalendarBtn.addEventListener('click', async () => {
  if (selectedMeshes.size !== 1) return;
  const [mesh] = selectedMeshes;
  if (mesh.userData.isCommunityCalendar) {
    openCalendarEventsModal(mesh);
    return;
  }
  mesh.userData.isCommunityCalendar = true;
  updateSelectionUI();
  persistLayout();
  await syncUpdate(mesh);
});

// A builder's moderation view onto one calendar's events — same shell/
// pattern as the sign posts modal just above.
const calendarEventsModalEl = document.getElementById('calendar-events-modal');
const calendarEventsCloseBtn = document.getElementById('calendar-events-close-btn');
const calendarEventsListEl = document.getElementById('calendar-events-list');
const calendarEventsEmptyEl = document.getElementById('calendar-events-empty');
const calendarEventsTruncatedEl = document.getElementById('calendar-events-truncated');
const calendarEventsUnflagBtn = document.getElementById('calendar-events-unflag-btn');
let calendarEventsTargetMesh = null;
// See signPostsLoadToken above — same reopen-on-a-different-mesh race,
// same fix.
let calendarEventsLoadToken = 0;

function formatCalendarEventTime(isoString) {
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

async function renderCalendarEvents() {
  calendarEventsListEl.innerHTML = '';
  calendarEventsTruncatedEl.hidden = true;
  if (!calendarEventsTargetMesh) return;
  const myLoadToken = ++calendarEventsLoadToken;
  const instanceId = calendarEventsTargetMesh.userData.instanceId;
  let events;
  let totalCount;
  try {
    ({ events, totalCount } = await fetchCalendarEvents(instanceId));
  } catch (err) {
    if (myLoadToken !== calendarEventsLoadToken) return; // superseded while fetching
    calendarEventsEmptyEl.textContent = err.message || 'Could not load events.';
    calendarEventsEmptyEl.hidden = false;
    return;
  }
  if (myLoadToken !== calendarEventsLoadToken) return; // superseded — a newer call owns the list now
  // #1128: same reset-on-success fix as reviewEmptyEl in the Seller
  // modal — without it a past fetch failure leaves this stuck on its
  // error message forever, even once a later load succeeds with zero events.
  calendarEventsEmptyEl.textContent = 'No events on this calendar yet.';
  calendarEventsEmptyEl.hidden = events.length > 0;
  // #1274: same truncation signal as sign posts above (handleCalendarEvents
  // windows to the newest 200 but returns the real, uncapped totalCount).
  calendarEventsTruncatedEl.hidden = totalCount <= events.length;
  calendarEventsTruncatedEl.textContent = `Showing newest ${events.length} of ${totalCount} events.`;
  for (const event of events) {
    const row = document.createElement('div');
    row.className = 'calendar-event-row';
    const body = document.createElement('div');
    body.className = 'calendar-event-row-body';
    const author = document.createElement('div');
    author.className = 'calendar-event-row-author';
    author.textContent = event.authorLabel;
    body.appendChild(author);
    const text = document.createElement('div');
    text.textContent = event.text;
    body.appendChild(text);
    const time = document.createElement('div');
    time.className = 'calendar-event-row-time';
    time.textContent = formatCalendarEventTime(event.createdAt);
    body.appendChild(time);
    if (event.scheduledAt) {
      const schedule = document.createElement('div');
      schedule.className = 'calendar-event-row-time';
      schedule.textContent = event.triggeredAt
        ? `🎉 Fired at ${formatCalendarEventTime(event.triggeredAt)}`
        : `⏳ Scheduled for ${formatCalendarEventTime(event.scheduledAt)}`;
      body.appendChild(schedule);
    }
    row.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'calendar-event-row-actions';
    // #1975: editing is author-only (handleCalendarEvents' own PATCH
    // branch 403s "Not your event" for anyone else) — this modal lists
    // every event on the calendar, not just this viewer's own, so the
    // edit button only renders for rows this session's own account
    // authored, same userId-match idiom as the sign-post/product-review
    // "myPost"/"myReview" checks use elsewhere.
    if (event.userId && currentAuthUser && event.userId === currentAuthUser.userId) {
      const editRowBtn = document.createElement('button');
      editRowBtn.className = 'calendar-event-row-edit';
      editRowBtn.type = 'button';
      editRowBtn.textContent = '✎';
      editRowBtn.setAttribute('aria-label', 'Edit event');
      editRowBtn.addEventListener('click', async () => {
        const newText = prompt('Edit this event (up to 280 characters):', event.text);
        if (newText === null) return;
        if (!newText.trim()) {
          alert('Event text cannot be empty.');
          return;
        }
        if (newText.trim().length > 280) {
          alert('Keep it to 280 characters or fewer.');
          return;
        }
        editRowBtn.disabled = true;
        try {
          await editCalendarEvent(instanceId, event.eventId, { text: newText.trim() });
          await renderCalendarEvents();
        } catch (err) {
          alert(err.message || 'Could not update this event.');
          editRowBtn.disabled = false;
        }
      });
      actions.appendChild(editRowBtn);
    }
    const deleteRowBtn = document.createElement('button');
    deleteRowBtn.className = 'calendar-event-row-delete';
    deleteRowBtn.type = 'button';
    deleteRowBtn.textContent = '×';
    deleteRowBtn.setAttribute('aria-label', 'Delete event');
    deleteRowBtn.addEventListener('click', async () => {
      if (!confirm('Delete this event? This can\'t be undone.')) return;
      deleteRowBtn.disabled = true;
      try {
        await deleteCalendarEvent(instanceId, event.eventId);
        await renderCalendarEvents();
      } catch (err) {
        alert(err.message || 'Could not delete this event.');
        deleteRowBtn.disabled = false;
      }
    });
    actions.appendChild(deleteRowBtn);
    row.appendChild(actions);
    calendarEventsListEl.appendChild(row);
  }
}

function openCalendarEventsModal(mesh) {
  calendarEventsTargetMesh = mesh;
  calendarEventsModalEl.classList.add('visible');
  openModalA11y(calendarEventsModalEl, closeCalendarEventsModal);
  renderCalendarEvents();
}
function closeCalendarEventsModal() {
  calendarEventsModalEl.classList.remove('visible');
  calendarEventsTargetMesh = null;
  closeModalA11y(calendarEventsModalEl);
}
calendarEventsCloseBtn.addEventListener('click', closeCalendarEventsModal);
calendarEventsUnflagBtn.addEventListener('click', async () => {
  if (!calendarEventsTargetMesh) return;
  const mesh = calendarEventsTargetMesh;
  mesh.userData.isCommunityCalendar = false;
  calendarEventsModalEl.classList.remove('visible');
  calendarEventsTargetMesh = null;
  closeModalA11y(calendarEventsModalEl);
  updateSelectionUI();
  persistLayout();
  await syncUpdate(mesh);
});

// Backup Chain (#2050/#2051, docs/API.md's "Placed instance backup
// chains") — an ordered, per-instance list of replacement products,
// auto-activated server-side the moment the active one sells out. Unlike
// Community Sign/Calendar above, every placed instance can have one (it's
// not gated behind some other flag), so this button always opens the same
// manage panel directly rather than toggling a flag first — see
// backupChainBtn's own disabled-only (no active state) line in
// updateSelectionUI.
const backupChainModalEl = document.getElementById('backup-chain-modal');
const backupChainCloseBtn = document.getElementById('backup-chain-close-btn');
const backupChainListEl = document.getElementById('backup-chain-list');
const backupChainEmptyEl = document.getElementById('backup-chain-empty');
const backupChainAddBtn = document.getElementById('backup-chain-add-btn');
let backupChainTargetMesh = null;
// Same stale-fetch guard idiom as signPostsLoadToken/calendarEventsLoadToken
// above.
let backupChainLoadToken = 0;

// #2051: the low-opacity placement/alignment reference the owner
// explicitly asked for ("when placing a backup product, the existing
// product should be visible in low opacity") — a second, independent
// rebuild of the currently-selected instance's own mesh at its own
// position, shown only while the catalog picker is open for a backup
// pick. Never added to productMeshes, so it's automatically never a
// raycast target for selection or the placement-click handler (both only
// ever check that array) — no separate "non-interactive" flag needed,
// same reasoning addBuildModeNeighborOutlines' own low-opacity overlay
// already relies on.
const BACKUP_REFERENCE_OPACITY = 0.35;
let backupReferenceMesh = null;

async function showBackupReferenceMesh(mesh) {
  hideBackupReferenceMesh();
  const reference = await createMeshForInstance({
    templateId: mesh.userData.template.templateId,
    x: mesh.position.x,
    y: mesh.position.y,
    z: mesh.position.z,
    rotationX: mesh.rotation.x,
    rotationY: mesh.rotation.y,
    rotationZ: mesh.rotation.z,
    crop: mesh.userData.crop,
    scale: mesh.userData.scale,
    label: mesh.userData.label,
  });
  if (!reference) return;
  // Same "traverse every part's material(s), including a multi-mesh
  // loaded GLTF" idiom as setShopAvatarOpacity — a product mesh can have
  // arbitrarily many parts, unlike a simple procedural box.
  reference.traverse((object) => {
    if (!object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      material.transparent = true;
      material.opacity = BACKUP_REFERENCE_OPACITY;
    }
  });
  scene.add(reference);
  backupReferenceMesh = reference;
}

// Exported for src/catalog/picker.js (#2558) -- its own closeCatalogPicker
// needs this same cleanup when a Backup Chain pick session ends.
export function hideBackupReferenceMesh() {
  if (!backupReferenceMesh) return;
  scene.remove(backupReferenceMesh);
  disposeObject(backupReferenceMesh);
  backupReferenceMesh = null;
}
// #2051: e2e-only hook (same window.__test* convention as
// window.__testShopAvatarHasTransparentMaterial above) -- lets a test
// confirm the low-opacity placement reference actually appears while the
// catalog picker is open for a backup pick, and is gone again once it
// closes, without needing to read raw WebGL pixels. Always inert unless a
// test calls it.
window.__testBackupReferenceMeshVisible = () => backupReferenceMesh !== null;

function formatInstanceBackupTemplateName(templateId) {
  return findTemplate(templateId)?.name ?? templateId;
}

async function renderBackupChain() {
  backupChainListEl.innerHTML = '';
  if (!backupChainTargetMesh) return;
  const myLoadToken = ++backupChainLoadToken;
  const instanceId = backupChainTargetMesh.userData.instanceId;
  let backups;
  try {
    ({ backups } = await fetchInstanceBackups(instanceId));
  } catch (err) {
    if (myLoadToken !== backupChainLoadToken) return; // superseded while fetching
    backupChainEmptyEl.textContent = err.message || 'Could not load the backup chain.';
    backupChainEmptyEl.hidden = false;
    return;
  }
  if (myLoadToken !== backupChainLoadToken) return; // superseded — a newer call owns the list now
  // #1128-style reset-on-success: without this, a past fetch failure
  // leaves this stuck on its error message forever, even once a later
  // load succeeds with an empty (but genuinely empty) chain.
  backupChainEmptyEl.textContent = 'No backups configured yet.';
  backupChainEmptyEl.hidden = backups.length > 0;
  backups.forEach((backup, index) => {
    const row = document.createElement('div');
    row.className = 'backup-chain-row';
    const name = document.createElement('span');
    name.className = 'backup-chain-row-name';
    name.textContent = `${index + 1}. ${formatInstanceBackupTemplateName(backup.templateId)}`;
    row.appendChild(name);
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'backup-chain-row-up';
    upBtn.textContent = '▲';
    upBtn.setAttribute('aria-label', 'Move up in the chain');
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => reorderBackupChainRow(backups, index, index - 1));
    row.appendChild(upBtn);
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'backup-chain-row-down';
    downBtn.textContent = '▼';
    downBtn.setAttribute('aria-label', 'Move down in the chain');
    downBtn.disabled = index === backups.length - 1;
    downBtn.addEventListener('click', () => reorderBackupChainRow(backups, index, index + 1));
    row.appendChild(downBtn);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'backup-chain-row-remove';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', 'Remove backup');
    removeBtn.addEventListener('click', async () => {
      if (!confirm('Remove this backup? This can\'t be undone.')) return;
      removeBtn.disabled = true;
      try {
        await deleteInstanceBackup(instanceId, backup.backupId);
        await renderBackupChain();
      } catch (err) {
        alert(err.message || 'Could not remove this backup.');
        removeBtn.disabled = false;
      }
    });
    row.appendChild(removeBtn);
    backupChainListEl.appendChild(row);
  });
}

async function reorderBackupChainRow(backups, fromIndex, toIndex) {
  const reordered = [...backups];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);
  const instanceId = backupChainTargetMesh.userData.instanceId;
  // Every row's Up/Down button closes over this same `backups` snapshot, so
  // a second reorder click anywhere in the list (same row or a different
  // one) before this request resolves would compute its own move against
  // the same now-stale ordering -- reorderInstanceBackups is a full-replace
  // PUT, so whichever response lands last would silently discard the other.
  // Disabling every currently-enabled button for the duration (restoring
  // only those, not a row's own boundary-disabled Up/Down) closes that
  // window the same way removeBtn's own disable-during-await already does.
  const buttonsToRestore = [...backupChainListEl.querySelectorAll('button:not(:disabled)')];
  buttonsToRestore.forEach((btn) => { btn.disabled = true; });
  try {
    await reorderInstanceBackups(instanceId, reordered.map((backup) => backup.backupId));
    await renderBackupChain();
  } catch (err) {
    alert(err.message || 'Could not reorder the backup chain.');
    buttonsToRestore.forEach((btn) => { btn.disabled = false; });
  }
}

function openBackupChainModal(mesh) {
  backupChainTargetMesh = mesh;
  backupChainModalEl.classList.add('visible');
  openModalA11y(backupChainModalEl, closeBackupChainModal);
  renderBackupChain();
}
function closeBackupChainModal() {
  backupChainModalEl.classList.remove('visible');
  backupChainTargetMesh = null;
  hideBackupReferenceMesh();
  closeModalA11y(backupChainModalEl);
}
backupChainCloseBtn.addEventListener('click', closeBackupChainModal);
backupChainBtn.addEventListener('click', () => {
  if (selectedMeshes.size !== 1) return;
  const [mesh] = selectedMeshes;
  openBackupChainModal(mesh);
});
backupChainAddBtn.addEventListener('click', async () => {
  if (!backupChainTargetMesh) return;
  const mesh = backupChainTargetMesh;
  const instanceId = mesh.userData.instanceId;
  closeBackupChainModal();
  await showBackupReferenceMesh(mesh);
  openCatalogPickerForPick(
    async (template) => {
      try {
        await addInstanceBackup(instanceId, { templateId: template.templateId });
        await renderBackupChain();
      } catch (err) {
        alert(err.message || 'Could not add this backup.');
      }
    },
    () => openBackupChainModal(mesh),
  );
});

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
const shopMoveJoystickEl = document.getElementById('shop-move-joystick');
const shopMoveKnobEl = shopMoveJoystickEl.querySelector('.shop-joystick-knob');
const shopLookJoystickEl = document.getElementById('shop-look-joystick');
const shopLookKnobEl = shopLookJoystickEl.querySelector('.shop-joystick-knob');
const shopFlyBtn = document.getElementById('shop-fly-btn');
const shopFlyBtnIcon = document.getElementById('shop-fly-btn-icon');
const shopLastLocationBtn = document.getElementById('shop-last-location-btn');
const shopVerticalControlsEl = document.getElementById('shop-vertical-controls');
const shopUpBtn = document.getElementById('shop-up-btn');
const shopDownBtn = document.getElementById('shop-down-btn');
const shopSignHintEl = document.getElementById('shop-sign-hint');
const shopCalendarHintEl = document.getElementById('shop-calendar-hint');
const shopCreditOrbToastEl = document.getElementById('shop-credit-orb-toast');
const shopCreditOrbOfflineNoticeEl = document.getElementById('shop-credit-orb-offline-notice');
const shopProductPreviewModalEl = document.getElementById('shop-product-preview-modal');
const shopProductPreviewCloseBtn = document.getElementById('shop-product-preview-close-btn');
const shopProductPreviewCanvas = document.getElementById('shop-product-preview-canvas');
const shopProductPreviewInfoEl = document.getElementById('shop-product-preview-info');
const shopProductPreviewReviewBtn = document.getElementById('shop-product-preview-review-btn');
const shopProductPreviewBuyBtn = document.getElementById('shop-product-preview-buy-btn');
const shopProductPreviewReturnPolicyBtn = document.getElementById('shop-product-preview-return-policy-btn');
const accountMenuLandletInfoEl = document.getElementById('account-menu-landlet-info');
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
// #1630: how many times pickShopSpawnLocation will reroll a candidate that
// landed on a water landlet before giving up and using it anyway -- a
// bound, not a tuned value, purely so a (realistically impossible) world
// that's entirely water can't spin this loop forever.
const SHOP_SPAWN_LOCATION_MAX_ATTEMPTS = 20;
// #1176: the "Go to Last Location" button's own fade in/out — same
// duration both ways, applied via CSS transition (#shop-last-location-btn
// in index.html), not JS-driven opacity.
const SHOP_LAST_LOCATION_BUTTON_FADE_S = 0.4;
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
const SHOP_MAX_PITCH = Math.PI * 0.35;
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

function getShopCameraLockToFacing() {
  return localStorage.getItem(SHOP_CAMERA_LOCK_TO_FACING_KEY) === '1';
}

function setShopCameraLockToFacing(enabled) {
  localStorage.setItem(SHOP_CAMERA_LOCK_TO_FACING_KEY, enabled ? '1' : '0');
}
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
// A fixed-radius orbit around that anchor (`positionShopCamera` below) — the
// classic over-the-shoulder third-person rig: subtracting the look
// direction from the anchor means looking down swings the camera up and
// back, looking up swings it down and in, all without a separate
// "collision" pass (clampShopCameraHeight/the wall-radius clamp still catch
// the rare pose that would otherwise dip the camera underground or past the
// world wall — see updateShopMovement).
const SHOP_CAMERA_FOLLOW_DISTANCE_M = 4.2;
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
const SHOP_LOAD_RADIUS_M = 60;
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
const SHOP_PROXIMITY_INTERVAL_MS = 400;
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
// The world wall: an opaque ring standing at exactly the current world
// radius, tall enough that nothing generating out beyond it (still
// unclaimable — see the availability circle in docs/SPEC.md) is visible
// past the edge, and a matching radial clamp on the camera so it's a real
// boundary, not just a backdrop — the builder can never fly past it to see
// around it. A land straddling the boundary still shows whatever fraction
// of it sits inside — anywhere from a sliver to nearly the whole shape —
// which is the correct, intentional look here, not a bug to hide.
const SHOP_WALL_HEIGHT_M = 60;
const SHOP_WALL_MARGIN_M = 1.5; // small ground/wall seam overlap only — see wildGround below
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
const SHOP_DOME_CLEARANCE_MARGIN_M = 5;
// Skip building a ground mesh for a landlet with no chance of being seen
// (entirely beyond the wall, comfortably past any land's own footprint) —
// pure cost-cutting as the world grows, never aggressive enough to risk
// hiding a real sliver.
const SHOP_LANDLET_CULL_MARGIN_M = 40;
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

let shopWorldRadiusM = null;
let shopDomeMesh = null;
let shopWallMesh = null;
let shopDomeRiseM = SHOP_DOME_INITIAL_RISE_M;
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
function growShopDomeIfNeeded(object) {
  if (!shopDomeMesh) return;
  const box = new THREE.Box3().setFromObject(object);
  const neededRise = box.max.z - SHOP_WALL_HEIGHT_M + SHOP_DOME_CLEARANCE_MARGIN_M;
  if (neededRise <= shopDomeRiseM) return;
  shopDomeRiseM = neededRise;
  shopDomeMesh.scale.y = shopDomeRiseM;
}

let shopYaw = 0;
let shopPitch = -0.12;
// The avatar's own facing (docs/SPEC.md §2) — deliberately separate from
// shopYaw (the camera's look direction, right-stick-driven): the left
// stick turns the avatar to face wherever it's actually walking, while the
// right stick free-looks independently, the standard third-person control
// scheme. Only updated while moving (see updateShopMovement) — standing
// still and looking around doesn't spin the avatar in place.
export let shopAvatarFacing = 0;
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
const shopLandlets = new Map(); // landletId -> { record, group, loaded, loadToken, objects }
let shopBuilderLabels = new Map(); // builderId -> label, fetched once in enterShopMode, patched on an in-session rename (#741) — see updateShopLandletInfo
let shopCurrentLandletEntry = null; // whichever shopLandlets entry the shopper is standing on, else null — see updateShopLandletInfo
// #1164 (sub-issue of #1161): the shopper's own currently-equipped avatar's
// skeleton signature (#1162), fetched once in enterShopMode alongside
// equippedAvatarModelUrl just below — null for the default procedural
// avatar or a logged-out/anonymous visit. productInfoText reads this to
// show a compatibility note on an "animation"-category product's buy hint.
let shopEquippedAvatarSkeletonSignature = null;
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
const shopOtherAvatars = new Map();
let shopLastPresencePollAt = 0;
let presencePollToken = 0; // #1911: guards pollNearbyPresenceIfNeeded against a stale out-of-order response
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
// #1995: every currently-loaded credit orb: { mesh, group, orbId, landletId }.
// Unlike shopSigns/shopCalendars above, an orb isn't a placed instance at
// all (#1994's own data model, a separate credit_orbs table keyed only by
// landlet) — so it's fetched and added alongside a landlet's own instances
// in loadShopLandletInstances rather than discovered via any instance's
// userData, but torn down the identical way in unloadShopLandletInstances.
const shopCreditOrbs = [];
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

function applyShopCameraOrientation() {
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
bindShopJoystick(shopMoveJoystickEl, shopMoveKnobEl, (x, y) => {
  shopMoveX = x;
  shopMoveY = y;
});
bindShopJoystick(shopLookJoystickEl, shopLookKnobEl, (x, y) => {
  shopLookX = x;
  shopLookY = y;
});

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
bindShopVerticalButton(shopUpBtn, 1);
bindShopVerticalButton(shopDownBtn, -1);

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
bindShopFlyToggle(shopFlyBtn);

// #1176: "Go to Last Location" — see startGoToLastLocation's own comment.
// A plain click, not pointerdown like the fly button above: this one has
// no in-air-vs-grounded ambiguity to resolve quickly, and it's only ever
// shown during the spawn orbit anyway, never competing with another
// control for the same tap.
shopLastLocationBtn.addEventListener('click', () => {
  if (!shopActive) return;
  startGoToLastLocation();
});

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
function setShopFov(fov) {
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

// #2623: makeAfkBadgeSprite/createShopAvatar/createCustomShopAvatar/
// shopAvatar(/setShopAvatar)/shopAvatarCollisionHalfM/shopAvatarHeightM/
// shopCameraAnchorHeightM/refreshEquippedShopAvatar now live in
// src/shop/avatar.js — see that module's own header comment for its
// dependency notes.

export const shopAvatarPosition = new THREE.Vector3(); // feet position, ground truth for both the mesh and the camera
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
// #1829: read-only counterpart to the teleport hook above -- lets a test
// confirm shopAvatarPosition actually changed (or didn't) after driving a
// real move through moveShopAvatarWithCollision below, same "always inert
// unless a test calls it" convention as every other window.__test* hook
// here.
window.__testShopAvatarPosition = () => ({ x: shopAvatarPosition.x, y: shopAvatarPosition.y, z: shopAvatarPosition.z });
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

// Flight state (docs/SPEC.md §2) — see updateShopFlight/toggleShopFlight.
// 'grounded' | 'takingOff' | 'flying' | 'landing'. Toggling mid-transition
// is ignored (see toggleShopFlight) rather than queued or reversed, so
// there's no need to track anything beyond "which transition, how far in."
let shopFlightState = 'grounded';
let shopFlightTransitionElapsedS = 0;
let shopFlightAltitudeM = 0; // authoritative — shopAvatarPosition.z mirrors this (offset by ground curvature) every frame
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
let shopLastLocation = null;
let shopLastLocationHideTimerS = null;
let shopGoToLastLocationPhase = null; // null | 'fadingOut' | 'fadingIn'
let shopGoToLastLocationElapsedS = 0;

// #2623: updateShopAvatarPose/setShopAvatarAnimationState/updateShopAvatarIdle
// now live in src/shop/avatar.js.

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
function shopMaxRadiusM() {
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
const SHOP_AVATAR_FLIGHT_LEAN_CLEARANCE_M =
  (SHOP_AVATAR_TORSO_LENGTH_M + SHOP_AVATAR_HEAD_RADIUS_M * 2) * Math.sin(Math.abs(SHOP_AVATAR_FLIGHT_PITCH_RAD));

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
const SHOP_FLY_BTN_ICON_ZOOM = 1.6;
const SHOP_FLY_BTN_ICON_STANDING_ORIGIN = '38% 62%'; // standing bird: shift right + up
const SHOP_FLY_BTN_ICON_FLYING_ORIGIN = '60% 40%'; // in-flight bird: shift down + left
function setShopFlyBtnFlying(flying) {
  document.body.classList.toggle('shop-flying', flying);
  shopFlyBtn.classList.toggle('active', flying);
  shopFlyBtn.setAttribute('aria-pressed', String(flying));
  // #1589: the icon shows the action a press performs, not the current
  // state — a standing bird (press to take off) while grounded, a flying
  // bird (press to land) while flying, i.e. the inverse of `flying`.
  shopFlyBtnIcon.src = flying ? SHOP_FLY_BTN_ICON_STANDING : SHOP_FLY_BTN_ICON_FLYING;
  shopFlyBtnIcon.style.transformOrigin = flying ? SHOP_FLY_BTN_ICON_STANDING_ORIGIN : SHOP_FLY_BTN_ICON_FLYING_ORIGIN;
  shopFlyBtnIcon.style.transform = `scale(${SHOP_FLY_BTN_ICON_ZOOM})`;
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
    shopAvatarFacing = shopYaw;
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
  shopAvatarFacing = shopYaw;
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
    // #1090: minAltitudeM is 0 (bare ground) unless there's a placed item
    // directly under the avatar's current (x, y), in which case it's that
    // item's own top surface (converted from world z into this frame's
    // altitude terms, same as shopAvatarPosition.z's own formula below) —
    // the floor this descent should stop at instead of passing through.
    const obstructionTopZ = shopLandingObstructionTopZ(shopAvatarPosition.x, shopAvatarPosition.y);
    const minAltitudeM = obstructionTopZ === null
      ? 0
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
          ? 0
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
function positionShopCamera() {
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
      const itemZMin = mesh.position.z - height / 2;
      const itemZMax = mesh.position.z + height / 2;
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
      const itemZMax = mesh.position.z + height / 2;
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
          worldZ: mesh.position.z - height / 2 + target.heightM,
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

function updateShopMovement(now) {
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
      shopAvatarFacing += turnDelta * Math.min(1, SHOP_AVATAR_TURN_EASE_PER_S * dt);
    }
    // #1840: the extra lean clearance (reserved whenever airborne) is
    // folded into baseMaxRadiusM *before* shopMaxRadiusAtWorldZM (#1839)
    // derives its own clearanceM from it, so the leaning-body margin holds
    // consistently at every height -- both down at the flat wall (this
    // issue's own low-altitude case) and up where the dome's real curved
    // cross-section already narrows the radius on its own (#1839's case).
    clampShopRadius(
      shopAvatarPosition,
      shopMaxRadiusAtWorldZM(shopAvatarPosition.z, shopAvatarMaxRadiusM() - (airborne ? SHOP_AVATAR_FLIGHT_LEAN_CLEARANCE_M : 0)),
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
  updateOtherShopAvatars(now);
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

function updateShopProximity() {
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
function pickShopSpawnLocation() {
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
function updateShopLandletInfo() {
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

// #2554: src/account/auth.js's own delete-account flow needs to set this
// flag before deleteAccount()'s own await resolves (see the comment at
// its declaration above) -- exported rather than left internal since
// hasVerifiedSession/accountSessionEnding themselves still live here,
// Shop-mode-specific state pending its own future extraction.
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
function reportOwnPresenceIfNeeded(now) {
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
async function pollNearbyPresenceIfNeeded(now) {
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
function updateOtherShopAvatars(now) {
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

function updateCreditOrbPopEffects(dt) {
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
function updateCreditOrbs(dt) {
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

// A sign starts with no posts loaded — fetched once, here, right as it
// enters the world (rather than re-fetched on every proximity tick), then
// kept in sync locally by promptLeaveNote's own optimistic append. If the
// fetch loses the race with the landlet being unloaded again (camera
// wandered off before it resolved), the `shopSigns.includes` check drops
// the result on the floor rather than resurrecting sprites for a sign
// that's no longer in the scene.
function registerShopSign(mesh, entry) {
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
function registerShopCalendar(mesh, entry) {
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
function updateSignFade() {
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
function updateCalendarFade() {
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
function registerShopReview(mesh, entry) {
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
function updateReviewFade() {
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
// event.triggeredAt is only ever set once a trigger request's own .then()
// resolves — with nothing tracking a request already in flight, a call
// slower than one 10s check interval (slow network, a throttled
// backgrounded tab, or many due events firing in the same tick) let the
// next tick re-issue a request for that same still-untriggered event.
// pendingCalendarEventTriggers closes that gap; eventId is unique enough
// on its own (no instanceId needed) since it's never reused across events.
const pendingCalendarEventTriggers = new Set();
function checkScheduledCalendarEvents() {
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

function updateConfettiBursts(dt) {
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

function unloadShopLandletInstances(entry) {
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
  shopCurrentLandletEntry = null;
  accountMenuLandletInfoEl.hidden = true;
  const visibleOwnerBuilderIds = [...new Set(
    allLandlets.map((landlet) => landlet.ownerBuilderId).filter((id) => id),
  )];
  fetchBuildersByIds(visibleOwnerBuilderIds)
    .then((builders) => {
      shopBuilderLabels = new Map(builders.map((b) => [b.builderId, b.label]));
      // #1172: updateShopLandletInfo only re-renders on a landlet-transition
      // (found === shopCurrentLandletEntry short-circuits otherwise), so a
      // shopper who spawned already standing on a landlet before this fetch
      // resolved would see the "unknown builder" fallback stuck until they
      // walked off and back. Forcing shopCurrentLandletEntry back to null
      // makes the next call recompute from scratch and re-render — same
      // effect as the bootstrap reset above, just re-triggered once real
      // labels are in.
      shopCurrentLandletEntry = null;
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
  // any navigation input (see updateShopSpawnRotation/stopShopSpawnRotation,
  // driven from updateShopMovement). Skips the takingOff ramp entirely
  // (that's for a player-initiated toggle mid-session, not this spawn),
  // landing in 'flying' directly the same way toggleShopFlight's own
  // takingOff path eventually would.
  // #1630: pickShopSpawnLocation (not a bare Math.random() pair) so the
  // spawn location avoids landing on a water landlet.
  ({ radiusM: shopSpawnOrbitRadiusM, yaw: shopYaw } = pickShopSpawnLocation());
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
  // Now that the correct grounded/flying look is actually applied, safe to
  // reveal (see this function's own comment on why these two specifically
  // wait until here, unlike the other Shop HUD elements above).
  shopFlyBtn.classList.add('visible');
  shopVerticalControlsEl.classList.add('visible');
  // #1176: the "Go to Last Location" button, offered only when there's
  // actually somewhere to offer — reset alongside the rest of this
  // function's own re-entrant spawn state (see its opening comment on
  // Shop mode being re-enterable without a reload) rather than carrying
  // over a previous round trip's now-stale countdown/sequence state.
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
  // free-look is already bounded to (see that constant's own comment) —
  // is the right pitch here too: the camera is looking down at the whole
  // world from above, not at a nearby build.
  shopPitch = -SHOP_MAX_PITCH;
  // shopYaw (set above, the orbit's starting angle) already faces the
  // world center — see updateShopSpawnRotation's own comment on why that
  // single angle does double duty as both the camera's look direction and
  // the orbit position.
  shopAvatarFacing = shopYaw;
  shopAvatarPitch = 0;
  applyShopCameraOrientation();
  positionShopCamera();
  setShopFov(camera.fov); // re-clamp in case a previous Shop session left it zoomed
  shopLastFrameTime = null;
  shopLastProximityCheck = 0;
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
let sellerShowcasePageIndex = 0;

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
async function loadSellerShowcasePage(pageIndex) {
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
let sellerShowcaseMeshesStale = false;
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
  sellerActiveView = 'manage';
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

function pointInPolygonXY(x, y, polygon) {
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
const bootstrapPromise = bootstrap();
bootstrapPromise.then(hideLoadingScreen, hideLoadingScreen);
