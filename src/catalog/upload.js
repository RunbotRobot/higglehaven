// #2557 (part of #2504/#2500's src/main.js module split, see #2503's design
// comment for the full dependency map): the Upload-model modal, shared
// between Build's catalog picker and Sell's product list, extracted
// wholesale from src/main.js. The design comment's own item #1 flags
// whether Build-mode and Sell-mode uploads should diverge going forward as
// a genuine owner-input question with no resolution yet — this leaf
// proceeds with the design's stated default (one shared module both modes
// import) and surfaces the open question again in this PR rather than
// deciding it unilaterally.
//
// Sell mode (#2562) hasn't been extracted yet as of this leaf, so this
// module temporarily imports several of its pieces straight from main.js
// (sellerModalEl, closeSellerModal, refreshSellerShowcase,
// renderActiveSellerView, hasDuplicateProductName, persistCatalogThumbnail,
// formatPriceCents, parsePriceInputDollars, formatDollarsForPriceInput,
// AXIS_ARROW_COLORS, MAX_MONEY_CENTS) — same temporary-import shape
// account/auth.js's, account/menu.js's, and build/layoutPreview.js's own
// comments already use for their own not-yet-extracted dependencies. Once
// #2562 lands, the Seller-modal pieces should be repointed there the same
// way #2555 repointed claim/flow.js's stale ui/modal.js import.
// closeCatalogPicker/buildCatalogPickerButtons used to be on this same
// temporary list but now import from catalog/picker.js (#2558), which
// landed after this leaf.
//
// MAX_MONEY_CENTS in particular must stay declared in main.js rather than
// moving here — it's genuinely shared well beyond this leaf (Sell's own
// Edit Price panel, Start Auction form, auction bidding), same reasoning
// #2614's own issue gives for the identical worker-side const.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { openModalA11y, closeModalA11y } from '../ui/modal.js';
import { optimizeModelFile, rescaleModelFile, convertFbxToGlb } from '../modelOptimizer.js';
import { unitSuffix, toDisplayLength, fromDisplayLength, formatLength } from '../settings.js';
import { ensureSellerIdentity } from '../account/identity.js';
import {
  AXIS_DIMENSION_KEY, AXIS_LIST,
  loadModelAnimations, computeSkeletonSignature, loadModelInstance,
  disposeObject,
} from '../world/models.js';
import { activeCatalog } from '../world/state.js';
import {
  uploadModelFile, createVideoGenerationJob, fetchVideoGenerationJobStatus,
  createCatalogTemplate, fetchMyBuilder,
} from '../api.js';
import {
  sellerModalEl, closeSellerModal, refreshSellerShowcase, renderActiveSellerView,
  hasDuplicateProductName, persistCatalogThumbnail,
  formatPriceCents, parsePriceInputDollars, formatDollarsForPriceInput,
  AXIS_ARROW_COLORS, MAX_MONEY_CENTS,
} from '../main.js';
// #2558: closeCatalogPicker/buildCatalogPickerButtons now live in
// src/catalog/picker.js (extracted after this module) rather than main.js.
import { closeCatalogPicker, buildCatalogPickerButtons } from './picker.js';

// Custom product upload: a builder's own model (photogrammetry scan,
// etc.) becomes a real catalog_templates row via two independent backend
// calls — POST /api/models to get bytes into storage and back a modelUrl,
// then the ordinary POST /api/catalog to register a product using it.
// This only works with the real backend reachable — creating a new
// persistent catalog entry has nowhere to live in offline/fallback mode,
// since catalog.js is a static file, not a runtime data store.
// Generic modal a11y stack (focus move-in/restore, Tab trap, Escape-to-close)
// lives in src/ui/modal.js — see that file's own #1316 comment.

const uploadModalEl = document.getElementById('upload-modal');
const uploadModalTitleEl = document.getElementById('upload-modal-title');
const uploadStepFileEl = document.getElementById('upload-step-file');
const uploadStepDimensionsEl = document.getElementById('upload-step-dimensions');
const uploadDimensionsPreviewEl = document.getElementById('upload-dimensions-preview');
const uploadAnimationsDetectedEl = document.getElementById('upload-animations-detected');
const uploadNameInput = document.getElementById('upload-name');
const uploadPriceInput = document.getElementById('upload-price');
const uploadDigitalGoodCheckbox = document.getElementById('upload-digital-good-checkbox');
const uploadDigitalGoodDisclaimerLabel = document.getElementById('upload-digital-good-disclaimer-label');
const uploadDigitalGoodDisclaimerSelect = document.getElementById('upload-digital-good-disclaimer-select');
const uploadAvatarCategoryCheckbox = document.getElementById('upload-avatar-category-checkbox');
const uploadAnimationCategoryCheckbox = document.getElementById('upload-animation-category-checkbox');

// #1163 (sub-issue of #1161): a listing is "avatar" or "animation" or
// neither, never both — checking one clears the other rather than
// letting handleUploadDimensionsStep's own category pick silently favor
// whichever it happens to check first.
uploadAvatarCategoryCheckbox.addEventListener('change', () => {
  if (uploadAvatarCategoryCheckbox.checked) uploadAnimationCategoryCheckbox.checked = false;
});
uploadAnimationCategoryCheckbox.addEventListener('change', () => {
  if (uploadAnimationCategoryCheckbox.checked) uploadAvatarCategoryCheckbox.checked = false;
});

uploadDigitalGoodCheckbox.addEventListener('change', () => {
  uploadDigitalGoodDisclaimerLabel.hidden = !uploadDigitalGoodCheckbox.checked;
});
// N50: reformat to "$123.45" once the seller leaves the field — leave a
// blank or not-yet-valid value alone so the submit-time check below still
// catches it and reports the same error message.
uploadPriceInput.addEventListener('blur', () => {
  const dollars = parsePriceInputDollars(uploadPriceInput.value);
  if (Number.isFinite(dollars) && dollars >= 0) {
    uploadPriceInput.value = formatDollarsForPriceInput(dollars);
  }
});
const uploadFileInput = document.getElementById('upload-file-input');
const uploadFileFieldRowEl = document.getElementById('upload-file-field-row');
const uploadHintEl = document.getElementById('upload-hint');
const uploadHintBtn = document.getElementById('upload-hint-btn');
const uploadModeVideoBtn = document.getElementById('upload-mode-video-btn');
const uploadModeFileBtn = document.getElementById('upload-mode-file-btn');
const uploadVideoSectionEl = document.getElementById('upload-video-section');
const uploadVideoCreditsEl = document.getElementById('upload-video-credits');
const uploadVideoInput = document.getElementById('upload-video-input');
const uploadRetryVideoBtn = document.getElementById('upload-retry-video-btn');
const uploadStatusEl = document.getElementById('upload-status');
const uploadCancelBtn = document.getElementById('upload-cancel-btn');
const uploadSubmitBtn = document.getElementById('upload-submit-btn');
const uploadModelBtn = document.getElementById('upload-model-btn');
const uploadDimensionInputEls = {
  x: document.querySelector('.upload-dimension-input[data-axis="x"]'),
  y: document.querySelector('.upload-dimension-input[data-axis="y"]'),
  z: document.querySelector('.upload-dimension-input[data-axis="z"]'),
};
const uploadDimensionUnitEls = [...document.querySelectorAll('.upload-dimension-unit')];

// Upload is a two-step wizard sharing one modal shell: 'file' (name + pick
// a .glb) then 'dimensions' (confirm/adjust the measured real-world size
// before the product is actually created). uploadModelUrl/
// uploadOriginalDimensions hold what step 'file' produced, since step
// 'dimensions' needs them and the R2 upload shouldn't happen twice.
let uploadStep = 'file';
let uploadModelUrl = null;
// #540: the seller's own "faux lándlet" 3D array paginates by a cumulative
// model-file-size cap — this is what step 'dimensions' passes through to
// createCatalogTemplate as modelSizeBytes, alongside uploadModelUrl.
let uploadModelSizeBytes = null;
// #1162: computed in showUploadDimensionPreview alongside the animation
// detection below, passed through to createCatalogTemplate the same way
// uploadModelSizeBytes already is.
let uploadSkeletonSignature = null;
let uploadOriginalDimensions = null;
let uploadDimensionPreview = null;
// #1620 (sub-issue of #1616): within step 'file', the seller picks either
// a .glb/.fbx file (mode 'file', the original flow) or a short video to
// generate one from (mode 'video') -- mutually exclusive input methods
// sharing the same name/price/digital-good fields and the same eventual
// handoff into step 'dimensions'.
let uploadFileMode = 'file';
// #1622 (sub-issue of #1616): which path produced the model currently
// showing in step 'dimensions' -- 'video' only while finishVideoGeneration
// is mid-handoff into handleUploadFileStep, reset to 'file' the moment
// that step is left any other way (resetUploadModalToFileStep). Drives
// uploadRetryVideoBtn's visibility: a seller who generated from video, but
// isn't happy with the result once they can actually see it in the
// dimensions-step preview, gets a one-click way back into video mode
// without losing the name/price they already typed -- the issue's own
// "post-generation review step... decide to retry" ask. A manually picked
// file has no equivalent need (nothing asynchronous or variable-quality
// about it), so this button only ever shows for the video path.
let uploadModelSource = 'file';

// handleUploadFileStep runs a long async chain (optimize -> upload ->
// measure -> showUploadDimensionPreview) before committing to the shared
// state above and advancing uploadStep. uploadCancelBtn stays enabled
// throughout, and reopening the modal force-resets uploadSubmitBtn's
// disabled state — so without a guard, canceling mid-upload (or a fast
// cancel-then-reopen, or reopen-and-resubmit) could let a stale call's
// awaits resolve later and silently resurrect/overwrite a canceled or
// superseded upload's UI state. Same monotonic load-token pattern already
// used for this exact bug shape elsewhere in this file (loadLandletMap,
// commit 80625ff; showAxisPreview, issue #205): bumped both when a new
// handleUploadFileStep call starts and whenever resetUploadModalToFileStep
// runs (cancel or reopen), checked after every await, with a superseded
// call bailing out before touching shared state further.
let uploadFlowToken = 0;

function setUploadStatus(text, isError) {
  uploadStatusEl.textContent = text;
  uploadStatusEl.classList.toggle('error', Boolean(isError));
}

function formatBytes(bytes) {
  // #1571: same GB tier worker/index.js's own copy of this function already
  // got in #1539/#1540 -- without it, a raw pre-optimization upload over 1GB
  // rendered as e.g. "1536.0MB" in the model-upload status line instead of
  // "1.5GB".
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

function disposeUploadDimensionPreview() {
  uploadDimensionsPreviewEl.innerHTML = '';
  uploadAnimationsDetectedEl.hidden = true;
  if (!uploadDimensionPreview) return;
  uploadDimensionPreview.controls.dispose();
  uploadDimensionPreview.renderer.dispose();
  disposeObject(uploadDimensionPreview.previewObject);
  for (const arrow of uploadDimensionPreview.arrows) {
    arrow.line.geometry.dispose();
    arrow.line.material.dispose();
    arrow.cone.geometry.dispose();
    arrow.cone.material.dispose();
  }
  for (const sprite of uploadDimensionPreview.labels) {
    sprite.material.map.dispose();
    sprite.material.dispose();
  }
  uploadDimensionPreview = null;
}

// #2442: `builders.video_generation_credits` (migrations/0127) was never
// surfaced anywhere in the Upload Model modal -- a seller had no way to
// tell they were out of free generations before actually attempting one
// and hitting VIDEO_GENERATION_NO_CREDITS_MESSAGE's 402. Best-effort: a
// failed fetch (offline, logged out mid-flow) just leaves the line blank
// rather than blocking entry into video mode over it.
async function refreshUploadVideoCredits() {
  uploadVideoCreditsEl.textContent = '';
  try {
    const { videoGenerationCredits } = await fetchMyBuilder();
    uploadVideoCreditsEl.textContent =
      `${videoGenerationCredits} free model generation${videoGenerationCredits === 1 ? '' : 's'} remaining`;
  } catch (err) {
    console.warn('Failed to load the video-generation credit balance:', err);
  }
}

// Switches step 'file' between its two mutually-exclusive input methods.
// #1602's info-tooltip popups (upload-hint, upload-video-hint) are
// siblings of their own field row, not nested inside it, so each one is
// force-collapsed here rather than relying on hiding the row above it to
// also hide the popup -- video mode's own hint lives inside
// uploadVideoSectionEl and so is already covered by that toggle alone.
function setUploadFileMode(mode) {
  uploadFileMode = mode;
  uploadFileFieldRowEl.hidden = mode !== 'file';
  uploadHintEl.hidden = true;
  uploadHintBtn.setAttribute('aria-expanded', 'false');
  uploadModeVideoBtn.hidden = mode !== 'file';
  uploadVideoSectionEl.hidden = mode !== 'video';
  uploadSubmitBtn.textContent = mode === 'video' ? 'Generate Model' : 'Add Product';
  // #2442: refreshed every time video mode is (re-)entered, not just once
  // per modal open -- a generation attempt since the last time this
  // section was shown (success or the 402 no-credits rejection) changes
  // the real balance, and uploadRetryVideoBtn can land back here more than
  // once in the same modal session.
  if (mode === 'video') refreshUploadVideoCredits();
}
uploadModeVideoBtn.addEventListener('click', () => setUploadFileMode('video'));
uploadModeFileBtn.addEventListener('click', () => setUploadFileMode('file'));

// mode lets a caller land back on step 'file' already in video mode
// (uploadRetryVideoBtn below) rather than always defaulting to the plain
// file picker -- every other caller (closing/opening the modal) wants the
// plain 'file' default.
function resetUploadModalToFileStep(mode = 'file') {
  uploadFlowToken++; // invalidate any in-flight handleUploadFileStep/startVideoGeneration call
  stopVideoGenPoll();
  uploadStep = 'file';
  uploadModelUrl = null;
  uploadModelSizeBytes = null;
  uploadSkeletonSignature = null;
  uploadOriginalDimensions = null;
  uploadModelSource = 'file';
  uploadAvatarCategoryCheckbox.checked = false;
  uploadAnimationCategoryCheckbox.checked = false;
  disposeUploadDimensionPreview();
  uploadModalTitleEl.textContent = 'Upload Model';
  uploadStepFileEl.hidden = false;
  uploadStepDimensionsEl.hidden = true;
  setUploadFileMode(mode);
}
// #1622: "Not quite right? Generate from a different video" -- visible
// only once a video-generated model is actually showing in the dimensions
// preview (toggled in handleUploadFileStep below). Keeps whatever
// name/price/digital-good state the seller already entered, unlike
// closing and reopening the whole modal.
uploadRetryVideoBtn.addEventListener('click', () => resetUploadModalToFileStep('video'));

function openUploadModal() {
  closeCatalogPicker();
  uploadNameInput.value = '';
  uploadPriceInput.value = '';
  uploadDigitalGoodCheckbox.checked = false;
  uploadDigitalGoodDisclaimerLabel.hidden = true;
  uploadDigitalGoodDisclaimerSelect.value = 'gift-card';
  uploadFileInput.value = '';
  uploadVideoInput.value = '';
  setUploadStatus('');
  uploadSubmitBtn.disabled = false;
  resetUploadModalToFileStep();
  uploadModalEl.classList.add('visible');
  openModalA11y(uploadModalEl, closeUploadModal);
}

function closeUploadModal() {
  uploadModalEl.classList.remove('visible');
  resetUploadModalToFileStep();
  closeModalA11y(uploadModalEl);
  // #2515: this modal only ever opens stacked on top of the still-visible
  // Seller modal (openUploadModal never hides it) -- closeModalA11y above
  // only clears activeModalEl, so without re-arming here the Seller modal
  // is left on screen but untrapped, same bug class #1679 fixed for the
  // Friends-map/DM pair.
  sellerModalEl.classList.add('visible');
  openModalA11y(sellerModalEl, closeSellerModal);
}

uploadModelBtn.addEventListener('click', openUploadModal);
uploadCancelBtn.addEventListener('click', closeUploadModal);

// Measures a freshly-uploaded model's own real-world size by loading it
// through the exact same path every placed instance uses (loadModelInstance
// — including the Y-up -> Z-up correction), rather than trusting whatever
// the source tool claims. The measured container is never added to the
// scene, just disposed once its bounding box is read.
async function measureModelDimensions(modelUrl) {
  const container = await loadModelInstance(modelUrl);
  const box = new THREE.Box3().setFromObject(container);
  const size = box.getSize(new THREE.Vector3());
  disposeObject(container);
  return { width: size.x, depth: size.y, height: size.z };
}

function setUploadDimensionInputs(dimensionsMeters) {
  for (const axis of AXIS_LIST) {
    const key = AXIS_DIMENSION_KEY[axis];
    uploadDimensionInputEls[axis].value = toDisplayLength(dimensionsMeters[key]).toFixed(2);
  }
}

function currentUploadDimensionsMeters() {
  const dims = {};
  for (const axis of AXIS_LIST) {
    const key = AXIS_DIMENSION_KEY[axis];
    dims[key] = fromDisplayLength(Number(uploadDimensionInputEls[axis].value));
  }
  return dims;
}

function refreshUploadDimensionUnits() {
  const suffix = unitSuffix();
  for (const el of uploadDimensionUnitEls) el.textContent = suffix;
}

// Editing any one dimension field rescales the OTHER TWO in lockstep to
// hold the model's original proportions — always computed fresh off the
// originally-measured dimensions (never off whatever's currently
// displayed), so repeated edits can't compound rounding error.
for (const axis of AXIS_LIST) {
  uploadDimensionInputEls[axis].addEventListener('input', () => {
    if (!uploadOriginalDimensions) return;
    const key = AXIS_DIMENSION_KEY[axis];
    const editedMeters = fromDisplayLength(Number(uploadDimensionInputEls[axis].value));
    if (!Number.isFinite(editedMeters) || editedMeters <= 0) return;
    const scaleFactor = editedMeters / uploadOriginalDimensions[key];
    if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return;
    for (const otherAxis of AXIS_LIST) {
      if (otherAxis === axis) continue;
      const otherKey = AXIS_DIMENSION_KEY[otherAxis];
      uploadDimensionInputEls[otherAxis].value = toDisplayLength(uploadOriginalDimensions[otherKey] * scaleFactor).toFixed(2);
    }
    updateUploadDimensionLabels();
  });
}

// A wider rounded-rect badge sized for a numeric string like "1.24m",
// unlike makeAxisLabelSprite's single-letter circular badge. Exposes
// userData.setText so the same sprite can be redrawn in place as the
// seller edits a dimension field.
function makeDimensionLabelSprite(text, colorHex) {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  const draw = (label) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = `#${colorHex.toString(16).padStart(6, '0')}`;
    ctx.beginPath();
    ctx.roundRect(2, 12, canvas.width - 4, canvas.height - 24, 16);
    ctx.fill();
    ctx.fillStyle = '#16240a';
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, canvas.width / 2, canvas.height / 2);
    texture.needsUpdate = true;
  };
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.renderOrder = 1;
  draw(text);
  sprite.userData.setText = draw;
  return sprite;
}

// Shows the freshly-uploaded (not-yet-created) model with its X/Y/Z
// dimensions labeled, mirroring the Seller modal's extensibility axis
// preview (showAxisPreview) but for a model that has no catalog template
// yet, so it's loaded directly via loadModelInstance rather than
// createMeshForInstance. The arrows/geometry are sized once to the
// original measured bounding box and never rescaled afterward — since
// dimension edits are always proportion-preserving (a uniform scale),
// every possible edit renders identically, so only the label text needs
// to change as the seller types (see updateUploadDimensionLabels).
async function showUploadDimensionPreview(modelUrl) {
  const myFlowToken = uploadFlowToken;
  disposeUploadDimensionPreview();

  const canvas = document.createElement('canvas');
  canvas.className = 'seller-preview-canvas';
  uploadDimensionsPreviewEl.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(2, -3, 4);
  scene.add(sun);

  // #1465: lets an e2e test simulate a slow load deterministically, same
  // reasoning as window.__testAvatarLoadDelayMs (#982) — modelUrl is
  // already cached by the time this runs (handleUploadFileStep's own
  // "Measuring model…" step already fully loaded it via this same
  // loadModelInstance pipeline), so there's no real network request left
  // here to delay via page.route(), and #982's own comment on that hook
  // found route-interception delays unreliable for this anyway. Always
  // undefined outside of that one test.
  if (window.__testUploadPreviewLoadDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, window.__testUploadPreviewLoadDelayMs));
  }
  const previewObject = await loadModelInstance(modelUrl);
  if (myFlowToken !== uploadFlowToken) {
    // A newer/canceled flow owns things now — this one's just-built object
    // was never added to any scene disposeUploadDimensionPreview knows
    // about, so without this it leaks the exact same way #1426/#1427 did
    // for their own superseded in-flight loads (see showAxisPreview).
    disposeObject(previewObject);
    // Exposed purely so an e2e test can confirm the dispose above actually
    // ran, same reasoning as window.__supersededAvatarDisposals (#1426) and
    // window.__sellerShowcaseDisposedMeshCount (#1427/#1432).
    window.__supersededUploadPreviewDisposals = (window.__supersededUploadPreviewDisposals ?? 0) + 1;
    return;
  }
  scene.add(previewObject);

  // #1162: awaited (unlike the animation detection just below, which is
  // fire-and-forget since it only drives a hint label) because
  // uploadSkeletonSignature needs to be settled before the user can reach
  // handleUploadDimensionsStep's createCatalogTemplate call — loadModelGltf
  // caches by URL, so this doesn't re-fetch anything loadModelInstance
  // above didn't already fetch.
  uploadSkeletonSignature = await computeSkeletonSignature(modelUrl);
  if (myFlowToken !== uploadFlowToken) return; // superseded while computing — a newer/canceled flow owns things now

  // #682: surfaces which (if any) of the idle/walk/fly avatar-rig clips
  // this upload carries, per docs/SPEC.md's own "Avatar rig/animation
  // clip convention" — checked for every upload, not just avatar-category
  // ones (category isn't chosen until after this step, per #680/#681's
  // own findings). Stays hidden for the overwhelmingly common case (an
  // ordinary product with no animations at all, e.g. a chair or a brick)
  // rather than telling every seller their table doesn't have a "fly"
  // clip; only speaks up when there's something to actually flag: real
  // clips present, so either confirming the ones that matched or naming
  // the gap for a model that clearly tried to animate but used different
  // clip names, rather than a seller silently discovering that gap only
  // once it's equipped in-world.
  loadModelAnimations(modelUrl).then((animations) => {
    if (myFlowToken !== uploadFlowToken || animations.length === 0) return;
    const matched = ['idle', 'walk', 'fly'].filter((name) => THREE.AnimationClip.findByName(animations, name));
    uploadAnimationsDetectedEl.textContent = matched.length > 0
      ? `Avatar animations detected: ${matched.join(', ')} — these play automatically if this is equipped as an avatar.`
      : `This model has ${animations.length} animation clip${animations.length === 1 ? '' : 's'}, but none named idle/walk/fly — if equipped as an avatar it'll still move, just without playing them.`;
    uploadAnimationsDetectedEl.hidden = false;
  }).catch(() => {});

  const box = new THREE.Box3().setFromObject(previewObject);
  const size = box.getSize(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.05);

  const rect = canvas.getBoundingClientRect();
  const camera = new THREE.PerspectiveCamera(45, rect.width / Math.max(rect.height, 1), 0.01, 100);
  camera.up.set(0, 0, 1);
  const dist = radius * 2.6;
  camera.position.set(dist * 0.75, -dist * 0.95, dist * 0.65);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(rect.width, rect.height, false);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.minDistance = dist * 0.35;
  controls.maxDistance = dist * 3;
  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render);

  const axisDims = { x: size.x, y: size.y, z: size.z };
  const dirs = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
  const arrows = [];
  const labels = [];
  for (const axis of AXIS_LIST) {
    const length = axisDims[axis] / 2 + radius * 0.35;
    const color = AXIS_ARROW_COLORS[axis];
    const arrow = new THREE.ArrowHelper(dirs[axis], new THREE.Vector3(0, 0, 0), length, color, length * 0.3, length * 0.18);
    scene.add(arrow);
    arrows.push(arrow);
    const label = makeDimensionLabelSprite('', color);
    label.position.copy(dirs[axis]).multiplyScalar(length * 1.25);
    const labelScale = radius * 0.5;
    label.scale.set(labelScale, labelScale * 0.4, labelScale);
    scene.add(label);
    labels.push(label);
  }

  uploadDimensionPreview = { renderer, scene, camera, controls, previewObject, arrows, labels, render };
  updateUploadDimensionLabels();
}

function updateUploadDimensionLabels() {
  if (!uploadDimensionPreview) return;
  const dims = currentUploadDimensionsMeters();
  const axisLabelDims = { x: dims.width, y: dims.depth, z: dims.height };
  AXIS_LIST.forEach((axis, i) => {
    uploadDimensionPreview.labels[i].userData.setText(formatLength(axisLabelDims[axis]));
  });
  uploadDimensionPreview.render();
}

async function handleUploadFileStep() {
  const name = uploadNameInput.value.trim();
  if (!name) {
    setUploadStatus('Name is required.', true);
    return;
  }
  const file = uploadFileInput.files[0];
  if (!file) {
    setUploadStatus('Choose a .glb or .fbx file first.', true);
    return;
  }
  if (hasDuplicateProductName(name, null) && !confirm(`You already have a product named "${name}". Continue anyway?`)) {
    return;
  }

  const myFlowToken = ++uploadFlowToken;
  uploadSubmitBtn.disabled = true;
  try {
    let uploadable = file;
    // #1166: an .fbx pick is converted to .glb right here, before anything
    // else in this function ever sees it -- optimizeModelFile below (and
    // the server) only ever deal with .glb, matching #1166's own direction
    // that storage format stays exactly as it is today. Unlike
    // optimization just below, a conversion failure has no original .glb
    // to fall back to, so it aborts this upload attempt outright with a
    // clear error pointing back at the manual Blender path, rather than
    // silently uploading something broken (or the raw .fbx).
    if (/\.fbx$/i.test(file.name)) {
      setUploadStatus('Converting from FBX…');
      try {
        const glbBlob = await convertFbxToGlb(file, (status) => setUploadStatus(status));
        uploadable = new File([glbBlob], file.name.replace(/\.fbx$/i, '.glb'), { type: 'model/gltf-binary' });
        if (myFlowToken !== uploadFlowToken) return; // canceled/superseded while converting
      } catch (err) {
        console.warn('Client-side FBX conversion failed:', err);
        setUploadStatus(
          `Could not convert this .fbx file (${err.message || 'unknown error'}). ` +
            'Try exporting it to .glb in Blender first and uploading that instead.',
          true,
        );
        return;
      }
    }
    try {
      const optimized = await optimizeModelFile(uploadable, (status) => setUploadStatus(status));
      uploadable = new File([optimized.blob], uploadable.name, { type: 'model/gltf-binary' });
      const trianglePct = optimized.trianglesBefore > 0 ? Math.round((optimized.trianglesAfter / optimized.trianglesBefore) * 100) : 100;
      setUploadStatus(
        `Reduced ${optimized.trianglesBefore.toLocaleString()} -> ${optimized.trianglesAfter.toLocaleString()} triangles ` +
          `(${trianglePct}%), ${formatBytes(optimized.bytesBefore)} -> ${formatBytes(optimized.bytesAfter)}. Uploading…`,
      );
    } catch (err) {
      // Optimization is a nice-to-have, not a requirement — if it fails
      // for any reason (an unusual mesh the simplifier chokes on, etc.)
      // fall back to uploading the original file rather than blocking
      // the whole thing on it.
      console.warn('Client-side model optimization failed, uploading original file:', err);
      setUploadStatus('Could not auto-reduce the model — uploading as-is…');
    }
    if (myFlowToken !== uploadFlowToken) return; // canceled/superseded — abandon before uploading anything
    const { modelUrl, sizeBytes } = await uploadModelFile(uploadable);
    if (myFlowToken !== uploadFlowToken) return; // canceled/superseded while uploading

    setUploadStatus('Measuring model…');
    const dimensions = await measureModelDimensions(modelUrl);
    if (myFlowToken !== uploadFlowToken) return; // canceled/superseded while measuring
    uploadModelUrl = modelUrl;
    uploadModelSizeBytes = sizeBytes;
    uploadOriginalDimensions = dimensions;
    setUploadDimensionInputs(dimensions);
    refreshUploadDimensionUnits();

    setUploadStatus('Loading preview…');
    await showUploadDimensionPreview(modelUrl);
    if (myFlowToken !== uploadFlowToken) return; // canceled/superseded while loading the preview

    uploadStep = 'dimensions';
    uploadModalTitleEl.textContent = 'Confirm Dimensions';
    uploadStepFileEl.hidden = true;
    uploadStepDimensionsEl.hidden = false;
    uploadSubmitBtn.textContent = 'Create Product';
    uploadRetryVideoBtn.hidden = uploadModelSource !== 'video';
    setUploadStatus('');
  } catch (err) {
    if (myFlowToken !== uploadFlowToken) return; // canceled/superseded — don't report this call's own error over a newer flow's state
    console.error('Custom product upload failed:', err);
    // #2440: previously a generic "Something went wrong."
    setUploadStatus(err.message || "Couldn't load a preview of that model — please try again in a moment.", true);
  } finally {
    if (myFlowToken === uploadFlowToken) uploadSubmitBtn.disabled = false;
  }
}

// #1620 (sub-issue of #1616): the video-to-3D counterpart to
// handleUploadFileStep above. Extracts a few frames from the seller's
// video, kicks off an async generation job (worker/index.js's
// handleVideoGenerationJobCreate, #1619), polls it to completion, then
// hands the resulting model off into handleUploadFileStep's own existing
// optimize -> upload -> measure -> preview chain unmodified -- confirmed
// in #1621 that a generated mesh needs no special-casing there.
const VIDEO_GEN_FRAME_COUNT = 4;
const VIDEO_GEN_POLL_INTERVAL_MS = 3000;
// Matches the client-cadence budget worker/index.js's own
// VIDEO_GENERATION_STATUS_RATE_LIMIT_MAX (120) was sized around -- the
// same "every 3s for up to 5 minutes" shape pollDiditVerificationStatus
// elsewhere in main.js already uses for its own identically-reasoned
// polling budget.
const VIDEO_GEN_POLL_DEADLINE_MS = 5 * 60 * 1000;

let videoGenPollTimer = null;

function stopVideoGenPoll() {
  if (videoGenPollTimer !== null) {
    clearTimeout(videoGenPollTimer);
    videoGenPollTimer = null;
  }
}

// Draws a handful of evenly-spaced still frames from a video file --
// no provider evaluated by #1617 accepts raw video directly, and this
// has to happen here in the browser (Cloudflare Workers has no video-
// decoding capability) before the video's own bytes ever go anywhere.
async function extractVideoFrames(videoFile, frameCount) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  const url = URL.createObjectURL(videoFile);
  try {
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Could not read this video file.'));
    });
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error("Could not determine this video's length.");
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    const frames = [];
    for (let i = 0; i < frameCount; i++) {
      // The midpoint of each equal slice, not i/frameCount itself -- skips
      // sampling the very first/last instant, often a half-raised phone or
      // a hand still entering/leaving frame.
      const t = ((i + 0.5) / frameCount) * video.duration;
      await new Promise((resolve, reject) => {
        video.onseeked = resolve;
        video.onerror = () => reject(new Error('Could not read this video file.'));
        video.currentTime = t;
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      frames.push(blob);
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Once a job's modelUrl is ready it's an ordinary same-origin
// /uploads/... URL (#1619's storeTripoModelOutput re-stores the
// provider's output in the same R2 bucket/shape a direct upload uses,
// confirmed in #1621 needs no special routing) -- fetching it into a
// File and injecting it into the real file <input> (via DataTransfer,
// since .files can't be assigned a plain array) lets
// handleUploadFileStep run completely unmodified, the same as any
// manually picked file.
async function finishVideoGeneration(modelUrl) {
  setUploadStatus('Generated! Optimizing…');
  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error('Could not download the generated model.');
  const bytes = await response.blob();
  const file = new File([bytes], 'generated-model.glb', { type: 'model/gltf-binary' });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  uploadFileInput.files = dataTransfer.files;
  // Read by handleUploadFileStep once it reaches step 'dimensions', to
  // decide whether uploadRetryVideoBtn should show (#1622).
  uploadModelSource = 'video';
  await handleUploadFileStep();
}

function pollVideoGenerationJob(jobId, myFlowToken) {
  stopVideoGenPoll();
  const deadline = Date.now() + VIDEO_GEN_POLL_DEADLINE_MS;
  const tick = async () => {
    videoGenPollTimer = null;
    if (myFlowToken !== uploadFlowToken) return; // canceled/superseded while waiting
    try {
      const { status, modelUrl, error } = await fetchVideoGenerationJobStatus(jobId);
      if (myFlowToken !== uploadFlowToken) return; // canceled/superseded while checking
      if (status === 'complete') {
        await finishVideoGeneration(modelUrl);
        return;
      }
      if (status === 'failed') {
        setUploadStatus(error || 'Video-to-3D generation failed — try a different video, or fall back to a manual upload.', true);
        uploadSubmitBtn.disabled = false;
        return;
      }
      setUploadStatus('Generating your 3D model… this can take a couple of minutes.');
    } catch (err) {
      // A transient failure here shouldn't give up outright -- keep
      // polling until the deadline, the same "best-effort background
      // poll" spirit pollDiditVerificationStatus elsewhere in main.js
      // already uses.
      console.warn('Could not check video generation status:', err);
    }
    if (myFlowToken !== uploadFlowToken) return; // canceled/superseded while deciding whether to reschedule
    if (Date.now() >= deadline) {
      setUploadStatus('Still generating — this is taking longer than expected. Try again later, or fall back to a manual upload.', true);
      uploadSubmitBtn.disabled = false;
      return;
    }
    videoGenPollTimer = setTimeout(tick, VIDEO_GEN_POLL_INTERVAL_MS);
  };
  tick();
}

async function startVideoGeneration(videoFile, myFlowToken) {
  setUploadStatus('Reading video…');
  const frames = await extractVideoFrames(videoFile, VIDEO_GEN_FRAME_COUNT);
  if (myFlowToken !== uploadFlowToken) return; // canceled/superseded while extracting frames

  setUploadStatus('Starting generation…');
  const fieldNames = ['front', 'left', 'back', 'right'];
  const form = new FormData();
  frames.forEach((blob, i) => form.append(fieldNames[i], blob, `frame-${i}.jpg`));
  const { jobId } = await createVideoGenerationJob(form);
  if (myFlowToken !== uploadFlowToken) return; // canceled/superseded while starting the job

  setUploadStatus('Generating your 3D model… this can take a couple of minutes.');
  pollVideoGenerationJob(jobId, myFlowToken);
}

async function handleUploadVideoStep() {
  const name = uploadNameInput.value.trim();
  if (!name) {
    setUploadStatus('Name is required.', true);
    return;
  }
  const videoFile = uploadVideoInput.files[0];
  if (!videoFile) {
    setUploadStatus('Choose a video first.', true);
    return;
  }
  if (hasDuplicateProductName(name, null) && !confirm(`You already have a product named "${name}". Continue anyway?`)) {
    return;
  }

  const myFlowToken = ++uploadFlowToken;
  uploadSubmitBtn.disabled = true;
  try {
    await startVideoGeneration(videoFile, myFlowToken);
  } catch (err) {
    if (myFlowToken !== uploadFlowToken) return; // canceled/superseded — don't report this call's own error over a newer flow's state
    console.error('Video-to-3D generation failed:', err);
    // #2440: previously a generic "Something went wrong starting video generation."
    setUploadStatus(err.message || "Couldn't start turning that video into a 3D model — please try again in a moment.", true);
    uploadSubmitBtn.disabled = false;
  }
}

// A seller-edited dimension only counts as a real change worth re-encoding
// the model over — not just float noise from round-tripping through
// display units and a fixed 2-decimal display precision.
// Exported: main.js's own Sell-mode "Save Size" handler (Seller modal's
// extensibility axis panel) uses this exact same check on an
// already-created product's resize, not just this modal's own
// handleUploadDimensionsStep.
export function dimensionsChanged(a, b) {
  return AXIS_LIST.some((axis) => {
    const key = AXIS_DIMENSION_KEY[axis];
    return Math.abs(a[key] - b[key]) > Math.max(0.001, a[key] * 0.005);
  });
}

async function handleUploadDimensionsStep() {
  const name = uploadNameInput.value.trim();
  const dimensions = currentUploadDimensionsMeters();
  if (!Object.values(dimensions).every((value) => Number.isFinite(value) && value > 0)) {
    setUploadStatus('Enter a positive size for each dimension.', true);
    return;
  }
  // #1601: price is required at upload time — a free digital good is
  // entered as an explicit $0, not left blank. priceCents can still end up
  // null later via the separate "Edit Price" panel (docs/API.md's "Seller-
  // side: setting a price"), which keeps its own null-means-unset
  // convention; this is just the one-time creation step.
  const priceInput = uploadPriceInput.value.trim();
  if (!priceInput) {
    setUploadStatus('Enter a price — use 0 for a free product.', true);
    return;
  }
  const dollars = parsePriceInputDollars(priceInput);
  if (!Number.isFinite(dollars) || dollars < 0) {
    setUploadStatus('Price must be a non-negative number.', true);
    return;
  }
  if (Math.round(dollars * 100) > MAX_MONEY_CENTS) {
    setUploadStatus(`Price must be ${formatPriceCents(MAX_MONEY_CENTS)} or less.`, true);
    return;
  }
  const priceCents = Math.round(dollars * 100);

  // #423: same uploadFlowToken idiom as handleUploadFileStep above — this
  // step's own await chain (rescale/upload/create) is just as cancelable
  // via uploadCancelBtn (which stays enabled throughout, per its own
  // comment) as the file step's, but without this it kept running to
  // completion in the background after Cancel, silently creating the
  // product anyway.
  const myFlowToken = uploadFlowToken;
  uploadSubmitBtn.disabled = true;
  try {
    let finalModelUrl = uploadModelUrl;
    // createMeshForInstance and (especially) loadCroppedModelInstance's
    // crop math both assume a template's declared dimensions exactly equal
    // the loaded model's own rendered size — see rescaleModelFile's own
    // doc comment. If the seller changed the size away from what was
    // actually measured, the uploaded file itself has to be rescaled to
    // match, not just the number stored alongside it.
    if (dimensionsChanged(dimensions, uploadOriginalDimensions)) {
      setUploadStatus('Applying your size change…');
      const scaleFactor = dimensions.width / uploadOriginalDimensions.width;
      const originalBlob = await fetch(uploadModelUrl).then((res) => res.blob());
      if (myFlowToken !== uploadFlowToken) return; // canceled/superseded while re-fetching the original
      const rescaledBlob = await rescaleModelFile(originalBlob, scaleFactor);
      if (myFlowToken !== uploadFlowToken) return; // canceled/superseded while rescaling
      setUploadStatus('Uploading resized model…');
      const rescaled = await uploadModelFile(new File([rescaledBlob], 'model.glb', { type: 'model/gltf-binary' }));
      finalModelUrl = rescaled.modelUrl;
      uploadModelSizeBytes = rescaled.sizeBytes;
      if (myFlowToken !== uploadFlowToken) return; // canceled/superseded while uploading the resized model
    }

    setUploadStatus('Creating product…');
    // Upload Model only lives inside the (already-open) Seller modal now,
    // which already guaranteed a seller identity to open at all — this is
    // just a defensive fallback, not the primary path to one.
    const uploaderSellerId = await ensureSellerIdentity();
    if (myFlowToken !== uploadFlowToken) return; // canceled/superseded while resolving the seller identity
    const metadata = {};
    if (uploadDigitalGoodCheckbox.checked) {
      metadata.digitalGoodDisclaimer = uploadDigitalGoodDisclaimerSelect.value;
    }
    const template = await createCatalogTemplate({
      name,
      dimensions,
      color: '#999999', // only ever used if the model itself fails to load later
      modelUrl: finalModelUrl,
      modelSizeBytes: uploadModelSizeBytes,
      skeletonSignature: uploadSkeletonSignature,
      sellerId: uploaderSellerId,
      // #680/#681's own "upload flow itself" was deliberately deferred as
      // separate scope — until now, category could only ever be set to
      // 'avatar' via a raw API call, so nothing sold through the app UI
      // could ever actually be bought and equipped. Omit rather than send
      // 'placeholder' explicitly, so the server's own default (worker/
      // index.js's createCatalogTemplate) stays the one source of truth
      // for what an unchecked listing's category actually is.
      // #1163: same reasoning, for the sibling "standalone animation"
      // category — the two checkboxes are mutually exclusive (see their
      // own change listeners above), so at most one of these ever applies.
      category: uploadAvatarCategoryCheckbox.checked
        ? 'avatar'
        : uploadAnimationCategoryCheckbox.checked ? 'animation' : undefined,
      priceCents,
      metadata,
    });
    if (myFlowToken !== uploadFlowToken) return; // canceled/superseded — the template still exists server-side, but nothing here should act on it

    // #327: fire-and-forget, deliberately not awaited — this only feeds
    // future page loads and #329's not-yet-built embedding search, so it
    // shouldn't hold up the seller actually seeing their new product.
    persistCatalogThumbnail(template);
    activeCatalog.push(template);
    buildCatalogPickerButtons();
    refreshSellerShowcase();
    closeUploadModal();
    // Back to the Seller modal it was opened from, with the new product
    // showing up right away — not straight into a Build-mode tap-to-place
    // flow, since Upload Model can now be reached from Shop (no landlet to
    // place onto at all) as easily as from Build.
    renderActiveSellerView();
  } catch (err) {
    if (myFlowToken !== uploadFlowToken) return; // canceled/superseded — don't report this call's own error over a newer flow's state
    console.error('Custom product creation failed:', err);
    // #2440: previously a generic "Something went wrong."
    setUploadStatus(err.message || "Couldn't create that product — please try again in a moment.", true);
  } finally {
    if (myFlowToken === uploadFlowToken) uploadSubmitBtn.disabled = false;
  }
}

uploadSubmitBtn.addEventListener('click', () => {
  if (uploadStep === 'file') {
    if (uploadFileMode === 'video') handleUploadVideoStep();
    else handleUploadFileStep();
  } else {
    handleUploadDimensionsStep();
  }
});
