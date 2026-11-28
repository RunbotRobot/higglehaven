// #2647 (leaf of #2562, sub-issue of #2504/#2500's src/main.js module
// split, see #2503's design comment for the full dependency map): Sell
// mode's product management -- the seller-modal chrome, the Manage/List
// product views, the resize-preview mini-3D-view, and the per-row
// shipping/returns/digital-good/extensibility/price/flooring save panels
// -- extracted wholesale from src/main.js. The sibling "showcase" half
// (sellerShowcaseMeshes, loadSellerShowcasePage, and the in-world
// paginated display) is #2648 (#2562's other leaf) -- now landed too,
// so loadSellerShowcasePage/refreshSellerShowcase/sellerShowcasePageIndex
// import from ../sell/showcase.js below, repointed the same way #2555
// repointed claim/flow.js's stale ui/modal.js import. The old raw
// sellerShowcaseMeshesStale boolean became private to that module with
// the same extraction -- isSellerShowcaseMeshesStale()/
// clearSellerShowcaseMeshesStale() read/clear it instead. bootstrapPromise
// still imports from main.js, genuinely unrelated to either leaf.
//
// enterSellMode/SELL_HIDDEN_BUILDER_UI_IDS stay in main.js for now -- same
// role as enterShopMode, not yet extracted anywhere -- and import back
// renderActiveSellerView/sellerModalEl/closeSellerModal/
// renderSellerFeedbackSummary/myProducts/updateSellerViewToggleUI from
// here. enterSellMode used to assign `sellerActiveView = 'manage'`
// directly; since that becomes a module-private binding here, it now
// calls resetSellerView() instead (see that function's own comment).
//
// renderSellerIdentityField (once Settings > Sell's shop name, #2565) lives here too; since #3704
// it is the bud's Storefront leaf, and Settings has no Sell tab.
//
// persistCatalogThumbnail, formatPriceCents/parsePriceInputDollars/
// formatDollarsForPriceInput, MAX_MONEY_CENTS, DIGITAL_GOOD_DISCLAIMER_TEXT,
// catalogThumbnailCache/catalogThumbnailEmbeddingCache, renderCatalogThumbnail,
// solidColorDataUrl, and updateModeNavUI are all genuinely shared well
// beyond Sell mode (Shop's own product display, the generic
// catalog-thumbnail pipeline) -- stay in main.js, imported back.
// updateSelectionUI moved to src/build/scene.js (#2559, landed after this
// leaf's own work started) -- imported from there directly.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { openModalA11y, closeModalA11y } from '../ui/modal.js';
import { registerBudPetals, openLeaf } from '../ui/bud.js';
import { openPayoutsLeaf } from './payoutsLeaf.js';
import { parseStockInput } from '../../worker/stockLimit.js';
import { buildSaleRow } from './saleRow.js';
import { EMPTY_COPY } from '../ui/emptyState.js';
import { openOrdersLeaf } from './ordersLeaf.js';
import { confirmDestructive } from '../ui/confirmModal.js';
import { promptModerationCategory } from '../ui/moderationCategoryModal.js';
import { showInlineActionStatus } from '../ui/inlineActionStatus.js';
import { promptBundleName } from '../ui/bundleNameModal.js';
import { inlineConfirm } from '../ui/inlineConfirm.js';
import {
  activeCatalog, setActiveCatalog, sellerId, setSellerId, currentMode,
} from '../world/state.js';
import {
  AXIS_DIMENSION_KEY, AXIS_LIST, extensibleAxes, createMeshForInstance,
  disposeObject, isFlooringTemplate,
} from '../world/models.js';
import { ensureSellerIdentity } from '../account/identity.js';
import { refreshNotificationsBadge } from '../account/menu.js';
import { formatLength, fromDisplayLength, toDisplayLength, unitSuffix } from '../settings.js';
import { rescaleModelFile } from '../modelOptimizer.js';
import {
  createCatalogListing, createCatalogTemplate, deleteCatalogTemplate, deleteProductReview,
  fetchProductReviews, fetchPurchases, fetchSellerFeedback,
  updateCatalogTemplate, uploadModelFile,
  fetchMySeller, renameSeller, deleteSeller,
} from '../api.js';
import { buildCatalogPickerButtons } from '../catalog/picker.js';
import { dimensionsChanged } from '../catalog/upload.js';
import { rescaleAndUploadModelTiers } from '../catalog/modelTierUpload.js';
import { updateSelectionUI } from '../build/scene.js';
import {
  bootstrapPromise, catalogThumbnailCache, catalogThumbnailEmbeddingCache,
  formatDollarsForPriceInput, formatPriceCents, parsePriceInputDollars,
  persistCatalogThumbnail, renderCatalogThumbnail, solidColorDataUrl,
  updateModeNavUI, DIGITAL_GOOD_DISCLAIMER_TEXT, MAX_MONEY_CENTS,
} from '../main.js';
import {
  renderSettingsSection, renderIdentityField,
} from '../settings/modal.js';
import {
  loadSellerShowcasePage, refreshSellerShowcase, sellerShowcasePageIndex, sellerShowcaseFeedbackState,
  isSellerShowcaseMeshesStale, clearSellerShowcaseMeshesStale,
} from '../sell/showcase.js';

import { camera as worldCamera } from '../world/scene.js';
import { recordRenderStateSample } from '../feedback/renderStateBuffer.js';
import { frameMonitorSample } from '../world/frameMonitor.js';
import { duplicateName } from './duplicateName.js';
import { hasFractionOfACent, FRACTION_OF_A_CENT_MESSAGE } from '../priceInput.js';
import { SHIPPING_ZONES, shippingPlaces, shippingZonesOf } from '../../shared/shipping-zones.js';

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

export function myProducts() {
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

// #3588 (interface week, #3539): search, category and sort only earn their
// place once the list is long enough to need them. A seller with two
// products was offered all three above the first product. "More than
// eight" is the issue's own suggested threshold; one named constant so it
// is a single place to tune. When the list drops back under it (a delete),
// the controls go and their values are reset too, so a filter set while the
// list was long can never keep hiding products behind controls nobody can
// reach to clear it.
const SELLER_FILTER_CONTROLS_MIN_PRODUCTS = 8;

function syncSellerFilterControls(productCount) {
  const show = productCount > SELLER_FILTER_CONTROLS_MIN_PRODUCTS;
  sellerFilterControlsEl.hidden = !show;
  if (show) return;
  sellerSearchInput.value = '';
  sellerCategoryFilterSelect.value = '';
  sellerSortSelect.value = 'name-asc';
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

// #3702 (Sell in the bud, 4/6): the actions on a whole product are one copy, used by the rows of
// My products and by the card that blooms beside a product tapped in the showroom, so the
// wording, the duplicate-name check, the save-busy guard and the refusal messages cannot drift
// apart. Each returns what happened and leaves the showing of it to the caller.

// Renames after the in-app name modal (#3249). inlineHost is where the duplicate-name question
// is asked, beside the buttons that were tapped. Returns { changed } or { error }.
export async function renameSellerProduct(template, inlineHost) {
  const result = await promptBundleName({ title: 'Rename this product', initialName: template.name });
  if (!result || result.name === template.name) return { changed: false };
  const trimmedNext = result.name;
  if (hasDuplicateProductName(trimmedNext, template.templateId)) {
    const proceed = await inlineConfirm(
      inlineHost,
      `You already have another product named "${trimmedNext}". Rename anyway?`,
      { yesLabel: 'Rename anyway' },
    );
    if (!proceed) return { changed: false };
  }
  try {
    const updated = await updateCatalogTemplate(template.templateId, { name: trimmedNext });
    Object.assign(template, updated);
    buildCatalogPickerButtons();
    return { changed: true };
  } catch (err) {
    return { error: err.message || 'Couldn\'t rename.' };
  }
}

// Saves a price typed in dollars ("" leaves the product not priced). Serialised with every other
// save on the product by the same busy flag as the row's own panels (#424, #457). Returns
// { saved: true }, { noChange: true } or { error }.
export async function saveSellerPrice(template, text) {
  if (metadataSaveBusyByTemplateId.get(template.templateId) === true) return { busy: true };
  const trimmed = String(text ?? '').trim();
  let priceCents = null;
  if (trimmed) {
    const dollars = parsePriceInputDollars(trimmed);
    if (!Number.isFinite(dollars) || dollars < 0) {
      return { error: 'Price must be a non-negative number, or left blank.' };
    }
    if (hasFractionOfACent(trimmed)) return { error: FRACTION_OF_A_CENT_MESSAGE };
    if (Math.round(dollars * 100) > MAX_MONEY_CENTS) {
      return { error: `Price must be ${formatPriceCents(MAX_MONEY_CENTS)} or less.` };
    }
    priceCents = Math.round(dollars * 100);
  }
  if (priceCents === template.priceCents) return { noChange: true };
  metadataSaveBusyByTemplateId.set(template.templateId, true);
  syncMetadataSaveButtonsDisabled(template.templateId);
  try {
    const updated = await updateCatalogTemplate(template.templateId, { priceCents });
    Object.assign(template, updated);
    return { saved: true };
  } catch (err) {
    return { error: err.message || 'Couldn\'t save.' };
  } finally {
    metadataSaveBusyByTemplateId.delete(template.templateId);
    syncMetadataSaveButtonsDisabled(template.templateId);
  }
}

// #3702: stock from the showroom card. A blank field means unlimited (null on the server), a whole
// number of 0 or more is what is left to sell. Same busy guard and error wording style as the price.
export async function saveSellerStock(template, text) {
  if (metadataSaveBusyByTemplateId.get(template.templateId) === true) return { busy: true };
  // #4343: the limit (and its wording) is the server's own, from worker/stockLimit.js.
  const parsedStock = parseStockInput(text, { blankMeansNoLimit: true });
  if (parsedStock.error) return { error: parsedStock.error };
  const stockQuantity = parsedStock.quantity;
  if (stockQuantity === (template.stockQuantity ?? null)) return { noChange: true };
  metadataSaveBusyByTemplateId.set(template.templateId, true);
  syncMetadataSaveButtonsDisabled(template.templateId);
  try {
    const updated = await updateCatalogTemplate(template.templateId, { stockQuantity });
    Object.assign(template, updated);
    return { saved: true };
  } catch (err) {
    return { error: err.message || 'Couldn\'t save.' };
  } finally {
    metadataSaveBusyByTemplateId.delete(template.templateId);
    syncMetadataSaveButtonsDisabled(template.templateId);
  }
}

// Deletes after its own in-app confirmation modal (#3249, #3278); the refusal wording (still
// placed, still in a saved layout) is shown in that modal. Returns true when deleted.
export async function deleteSellerProduct(template, returnFocusEl) {
  const deleted = await confirmDestructive({
    title: 'Delete this product?',
    message: `Delete "${template.name}"? This can't be undone.`,
    confirmLabel: 'Delete',
    returnFocusEl,
    restoreModalEl: sellerModalEl,
    restoreCloseFn: closeSellerModal,
    onConfirm: async () => {
      try {
        await deleteCatalogTemplate(template.templateId);
      } catch (err) {
        // #729: a saved-layout or landlet-version-history block (see the
        // worker's assertCatalogTemplatesDeletable) has nothing placed to
        // remove -- "remove those instances first" would send the seller
        // looking for a fix that doesn't exist, so those get their own
        // wording distinct from the generic "still in use" FK message.
        if (err.message?.includes('referenced by a saved layout')) {
          throw new Error("Still saved in someone's layout library — it can't be deleted until that saved layout is removed or no longer references it.");
        } else if (err.message?.includes("referenced by a landlet's version history")) {
          throw new Error("Used in a lándlet's past published version — it can't be deleted while that version history exists.");
        } else if (err.message?.includes('still in use')) {
          throw new Error('Still placed somewhere — remove those instances first, or Duplicate to edit a copy instead.');
        }
        throw new Error(err.message || 'Couldn\'t delete.');
      }
    },
  });
  if (!deleted) return false;
  setActiveCatalog(activeCatalog.filter((t) => t.templateId !== template.templateId));
  buildCatalogPickerButtons();
  refreshSellerShowcase();
  // #1342: renderActiveSellerView() rather than renderSellerList() directly, so a deleted product
  // does not keep showing (and staying tappable) in List view.
  renderActiveSellerView();
  return true;
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
    syncSellerFilterControls(0);
    sellerStatusEl.textContent = EMPTY_COPY.products;
    return;
  }
  syncSellerFilterControls(allTemplates.length);
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
    // #2218 (owner decision, 2026-10-25): a product an admin removed for
    // a policy violation stays visible here (never hidden/deleted, so the
    // seller's own history/transparency stays intact) but carries this
    // indicator, and -- unlike every other action on this row -- Duplicate
    // is disabled for it below, since re-creating a removed listing is
    // exactly the moderation bypass this decision closes.
    if (template.flaggedHiddenAt) {
      const flaggedBadge = document.createElement('div');
      flaggedBadge.className = 'seller-row-flagged-badge';
      flaggedBadge.textContent = 'Removed — policy violation';
      toggle.appendChild(flaggedBadge);
    }
    row.appendChild(toggle);

    const details = document.createElement('div');
    details.className = 'seller-row-details';
    row.appendChild(details);

    // #3378 (owner, 2026-11-10): the buttons that act on the whole product sit
    // directly under its name, above every settings toggle, with the status
    // line and the preview they produce right beside them. They are created
    // here so their place in the block is fixed; the buttons are filled in
    // further down.
    const rowStatus = document.createElement('div');
    rowStatus.className = 'seller-row-status';

    const actions = document.createElement('div');
    actions.className = 'seller-row-actions';
    details.appendChild(actions);
    details.appendChild(rowStatus);

    const previewContainer = document.createElement('div');
    previewContainer.className = 'seller-row-preview';
    details.appendChild(previewContainer);

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
    digitalGoodToggle.textContent = 'Edit digital good ▾';
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
    digitalGoodSaveBtn.textContent = 'Save digital good';
    metadataSaveButtons.push(digitalGoodSaveBtn);
    digitalGoodSaveBtn.addEventListener('click', async () => {
      if (isMetadataSaveBusy()) return;
      digitalGoodStatus.textContent = '';
      digitalGoodStatus.classList.remove('error');
      const nextMetadata = { ...template.metadata };
      if (digitalGoodCheckbox.checked) {
        nextMetadata.digitalGoodDisclaimer = digitalGoodSelect.value;
        // #4601: a digital good has no shipping settings; none are kept.
        delete nextMetadata.shippingZones;
        delete nextMetadata.domesticOnly;
      } else {
        delete nextMetadata.digitalGoodDisclaimer;
      }
      setMetadataSaveBusy(true);
      for (const btn of metadataSaveButtons) btn.disabled = true;
      try {
        const updated = await updateCatalogTemplate(template.templateId, { metadata: nextMetadata });
        Object.assign(template, updated);
        refreshDigitalGoodText();
        syncShippingForDigital();
        digitalGoodStatus.textContent = 'Saved.';
      } catch (err) {
        digitalGoodStatus.textContent = err.message || 'Couldn\'t save.';
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
      digitalGoodToggle.textContent = `Edit digital good ${digitalGoodPanel.hidden ? '▾' : '▴'}`;
      if (!digitalGoodPanel.hidden) fillDigitalGoodInputs();
    });

    // No-returns policy (docs/SPEC.md §5: "No-returns-policy respected as
    // seller-set default") — absent/false means returns are accepted (the
    // spec's own default), so a seller only ever opts INTO no-returns, same
    // single-boolean-in-metadata simplicity as digital goods above. Own
    // classes throughout for the same "don't share a class across
    // genuinely different rows/panels" reasoning as Extensibility vs. Edit
    // Size vs. Edit digital good.
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
    noReturnsToggle.textContent = 'Edit returns policy ▾';
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
    noReturnsSaveBtn.textContent = 'Save returns policy';
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
        noReturnsStatus.textContent = err.message || 'Couldn\'t save.';
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
      noReturnsToggle.textContent = `Edit returns policy ${noReturnsPanel.hidden ? '▾' : '▴'}`;
      if (!noReturnsPanel.hidden) noReturnsCheckbox.checked = !!template.metadata?.noReturns;
    });

    // Shipping (docs/SPEC.md §5): where the product ships, one checkbox per zone (shared/shipping-zones.js,
    // #4601), in place of the single "United States only" switch. All zones ticked is the permissive default and is
    // stored as nothing at all, the same clear-to-absent convention as No-Returns above.
    const domesticOnlyText = document.createElement('div');
    domesticOnlyText.className = 'seller-row-domestic-only';
    const refreshDomesticOnlyText = () => {
      domesticOnlyText.textContent = `Ships: ${shippingPlaces(template.metadata)}`;
    };
    refreshDomesticOnlyText();
    details.appendChild(domesticOnlyText);

    const domesticOnlyToggle = document.createElement('button');
    domesticOnlyToggle.className = 'seller-extensibility-toggle seller-domestic-only-toggle';
    domesticOnlyToggle.type = 'button';
    domesticOnlyToggle.textContent = 'Edit shipping ▾';
    details.appendChild(domesticOnlyToggle);

    const domesticOnlyPanel = document.createElement('div');
    domesticOnlyPanel.className = 'seller-domestic-only-panel';
    domesticOnlyPanel.hidden = true;
    details.appendChild(domesticOnlyPanel);

    const zoneCheckboxes = new Map();
    for (const zone of SHIPPING_ZONES) {
      const zoneLabel = document.createElement('label');
      zoneLabel.className = 'seller-domestic-only-checkbox-label seller-shipping-zone-label';
      const zoneCheckbox = document.createElement('input');
      zoneCheckbox.type = 'checkbox';
      zoneCheckbox.value = zone.id;
      zoneCheckboxes.set(zone.id, zoneCheckbox);
      zoneLabel.appendChild(zoneCheckbox);
      zoneLabel.appendChild(document.createTextNode(zone.label));
      domesticOnlyPanel.appendChild(zoneLabel);
    }
    const syncZoneCheckboxes = () => {
      const zones = shippingZonesOf(template.metadata);
      for (const [id, box] of zoneCheckboxes) box.checked = zones.includes(id);
    };

    const domesticOnlyStatus = document.createElement('div');
    domesticOnlyStatus.className = 'seller-domestic-only-status';

    const domesticOnlySaveBtn = document.createElement('button');
    domesticOnlySaveBtn.className = 'seller-domestic-only-save-btn metadata-save-btn';
    domesticOnlySaveBtn.type = 'button';
    domesticOnlySaveBtn.textContent = 'Save shipping';
    metadataSaveButtons.push(domesticOnlySaveBtn);
    domesticOnlySaveBtn.addEventListener('click', async () => {
      if (isMetadataSaveBusy()) return;
      domesticOnlyStatus.textContent = '';
      domesticOnlyStatus.classList.remove('error');
      const chosen = SHIPPING_ZONES.filter((zone) => zoneCheckboxes.get(zone.id).checked).map((zone) => zone.id);
      if (chosen.length === 0) {
        domesticOnlyStatus.textContent = 'Choose at least one place this ships to.';
        domesticOnlyStatus.classList.add('error');
        return;
      }
      const nextMetadata = { ...template.metadata };
      delete nextMetadata.domesticOnly; // the one model is shippingZones now
      if (chosen.length === SHIPPING_ZONES.length) {
        delete nextMetadata.shippingZones;
      } else {
        nextMetadata.shippingZones = chosen;
      }
      setMetadataSaveBusy(true);
      for (const btn of metadataSaveButtons) btn.disabled = true;
      try {
        const updated = await updateCatalogTemplate(template.templateId, { metadata: nextMetadata });
        Object.assign(template, updated);
        refreshDomesticOnlyText();
        domesticOnlyStatus.textContent = 'Saved.';
      } catch (err) {
        domesticOnlyStatus.textContent = err.message || 'Couldn\'t save.';
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
      domesticOnlyToggle.textContent = `Edit shipping ${domesticOnlyPanel.hidden ? '▾' : '▴'}`;
      if (!domesticOnlyPanel.hidden) syncZoneCheckboxes();
    });

    // #4601: a digital good (the disclaimer, or an avatar or animation listing) has no shipping settings at all.
    function syncShippingForDigital() {
      const digital = !!template.metadata?.digitalGoodDisclaimer || template.category === 'avatar' || template.category === 'animation';
      domesticOnlyText.hidden = digital;
      domesticOnlyToggle.hidden = digital;
      if (digital) domesticOnlyPanel.hidden = true;
    }
    syncShippingForDigital();

    // Edit size: correct a mis-measured (or since-outgrown) real-world
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
    sizeToggle.textContent = 'Edit size ▾';
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
    sizeSaveBtn.textContent = 'Save size';
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
          // #3414: a new model file drops the product's reduced versions on the
          // server (they reduce the OLD file), so they are rescaled and sent
          // along. One that cannot be is simply left out and the product keeps
          // the rest.
          if (template.modelMidUrl || template.modelFarUrl) {
            const tiers = await rescaleAndUploadModelTiers(
              { modelMidUrl: template.modelMidUrl, modelFarUrl: template.modelFarUrl },
              scaleFactor,
              rescaled.sizeBytes,
            );
            if (tiers.modelMidUrl) patch.modelMidUrl = tiers.modelMidUrl;
            if (tiers.modelFarUrl) patch.modelFarUrl = tiers.modelFarUrl;
          }
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
        sizeStatus.textContent = err.message || 'Couldn\'t resize.';
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
      sizeToggle.textContent = `Edit size ${sizePanel.hidden ? '▾' : '▴'}`;
      if (!sizePanel.hidden) fillSizeInputs();
    });

    // Edit price: the only way a seller can ever set/change a product's
    // priceCents after upload (the upload wizard's own price field only
    // covers creation) — same collapsed-panel-with-a-Save-step idiom as
    // Edit size just above, own classes throughout for the same reasons.
    const priceToggle = document.createElement('button');
    priceToggle.className = 'seller-extensibility-toggle seller-price-toggle';
    priceToggle.type = 'button';
    priceToggle.textContent = 'Edit price ▾';
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
      // #4685: left as typed, so Save's refusal of a fraction of a cent still sees it.
      if (hasFractionOfACent(priceInput.value)) return;
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
    priceSaveBtn.textContent = 'Save price';
    metadataSaveButtons.push(priceSaveBtn);
    priceSaveBtn.addEventListener('click', async () => {
      if (isMetadataSaveBusy()) return;
      priceStatus.textContent = '';
      priceStatus.classList.remove('error');
      const out = await saveSellerPrice(template, priceInput.value);
      if (out.busy) return;
      if (out.error) {
        priceStatus.textContent = out.error;
        priceStatus.classList.add('error');
      } else if (out.noChange) {
        priceStatus.textContent = 'No change.';
      } else if (out.saved) {
        refreshPriceText();
        priceStatus.textContent = 'Saved.';
        priceToggle.textContent = `Edit price ${pricePanel.hidden ? '▾' : '▴'}`;
      }
    });
    pricePanel.appendChild(priceSaveBtn);
    pricePanel.appendChild(priceStatus);

    priceToggle.addEventListener('click', () => {
      pricePanel.hidden = !pricePanel.hidden;
      priceToggle.textContent = `Edit price ${pricePanel.hidden ? '▾' : '▴'}`;
      if (!pricePanel.hidden) fillPriceInput();
    });

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
    renameBtn.className = 'seller-row-action-btn seller-rename-btn'; // #3617: the handbook test finds Rename by this class
    renameBtn.type = 'button';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', async () => {
      rowStatus.textContent = '';
      rowStatus.classList.remove('error');
      renameBtn.disabled = true;
      const out = await renameSellerProduct(template, actions);
      renameBtn.disabled = false;
      if (out.changed) label.textContent = template.name;
      if (out.error) {
        rowStatus.textContent = out.error;
        rowStatus.classList.add('error');
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
    // #2218: client-side half of the moderation-bypass fix -- the real
    // enforcement is the server's own sourceTemplateId check in the
    // create handler (see this button's own click handler below); this
    // just keeps a seller from even trying on a removed listing.
    duplicateBtn.disabled = !!template.flaggedHiddenAt;
    duplicateBtn.addEventListener('click', async () => {
      rowStatus.textContent = '';
      rowStatus.classList.remove('error');
      // A listing needs a price, a free one an explicit $0, so a copy of a product with none would be refused
      // by the server with a message about a field name. Say what to do instead, before asking.
      if (template.priceCents == null) {
        rowStatus.textContent = 'Set a price on this product first (enter 0 for a free one), then duplicate it.';
        rowStatus.classList.add('error');
        return;
      }
      duplicateBtn.disabled = true;
      try {
        const copy = await createCatalogTemplate({
          name: duplicateName(template.name), // #4344: trimmed so the copy fits the server's 100 characters
          category: template.category,
          subcategory: template.subcategory,
          dimensions: template.dimensions,
          color: template.color,
          modelUrl: template.modelUrl,
          // modelUrl is copied by reference (see this button's own comment
          // above) — the underlying file, and so its size and skeleton, is
          // identical. #3414: so are its reduced versions, copied the same way.
          modelMidUrl: template.modelMidUrl ?? undefined,
          modelFarUrl: template.modelFarUrl ?? undefined,
          modelSizeBytes: template.modelSizeBytes,
          skeletonSignature: template.skeletonSignature,
          priceCents: template.priceCents,
          stockQuantity: template.stockQuantity,
          metadata: template.metadata,
          // Safe to read directly (not ensureSellerIdentity()) — this only
          // ever runs while the Seller modal is open, which already
          // guaranteed one via openSellerModal().
          sellerId,
          // #2218: declares exactly which template this is duplicating
          // from, so the server can independently reject a copy of one
          // that's been removed by admin moderation -- this button is
          // already disabled for that case (see its own flaggedHiddenAt
          // check below), but the server check is what actually closes
          // the gap against a direct API call bypassing this UI.
          sourceTemplateId: template.templateId,
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
        rowStatus.textContent = err.message || 'Couldn\'t duplicate.';
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
    // #3249/#3278: confirming a delete is its own in-app modal (never the
    // browser's native confirm(), which a browser can suppress and which then
    // silently did nothing on Android Chrome, and not an inline control the
    // owner almost missed). The delete itself runs inside the modal, so a
    // refusal (still placed somewhere, still in a saved layout) is shown
    // right where the person just tapped instead of in a row-status line that
    // can be off-screen on a phone.
    deleteBtn.addEventListener('click', async () => {
      rowStatus.textContent = '';
      rowStatus.classList.remove('error');
      await deleteSellerProduct(template, deleteBtn);
    });
    actions.append(deleteBtn);

    // Ground/flooring (docs/SPEC.md §3, see isFlooringTemplate in this
    // file) — a single opt-in flag, not a numeric form like Extensibility
    // or Edit size, so a plain immediate-PATCH toggle button fits better
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
        rowStatus.textContent = err.message || 'Couldn\'t update.';
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
        rowStatus.textContent = err.message || 'Couldn\'t save.';
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
    sitLeanSaveBtn.textContent = 'Save sit/lean target';
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
        sitLeanStatus.textContent = err.message || 'Couldn\'t save.';
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
        reviewEmptyEl.textContent = err.message || 'Couldn\'t load reviews.';
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
          // #2388: seller-moderation delete -- the server now requires a
          // removal category on this path (see worker/lib/content-
          // moderation.js), same as the sign-posts/calendar-events
          // moderation panels in src/build/metadataModals.js.
          const category = await promptModerationCategory();
          if (!category) return;
          deleteRowBtn.disabled = true;
          showInlineActionStatus(reviewPanel, '');
          try {
            await deleteProductReview(template.templateId, review.reviewId, { category });
            await renderReviews();
          } catch (err) {
            console.warn('Could not delete review:', err);
            // #4548: said in this panel, kept and selectable, like the sign-post and calendar panels (#3889 shape b).
            // The button used to just come back, so a refused delete looked like a tap that did nothing. The re-render
            // rebuilds only the list, so the line stays, and a review someone else already removed leaves the list.
            showInlineActionStatus(reviewPanel, err.message || 'Couldn\'t delete this review.');
            await renderReviews();
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
        salesEmptyEl.textContent = err.message || 'Couldn\'t load sales.';
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
        salesListEl.appendChild(buildSaleRow(purchase, { onChanged: renderSales }));
      }
    }

    salesToggle.addEventListener('click', () => {
      salesPanel.hidden = !salesPanel.hidden;
      salesToggle.textContent = `Sales ${salesPanel.hidden ? '▾' : '▴'}`;
      if (!salesPanel.hidden) renderSales();
    });

    // #457: a save begun before the modal was closed can still be in
    // flight against this templateId when it's reopened and this row is
    // rebuilt from scratch — disable this row's own freshly-created
    // buttons up front in that case, rather than leaving them clickable
    // and relying solely on isMetadataSaveBusy()'s silent no-op inside
    // each handler (correct, but reads as unresponsive buttons).
    if (isMetadataSaveBusy()) {
      for (const btn of metadataSaveButtons) btn.disabled = true;
    }
    // #3702 (Sell in the bud, 4/6, slice B): the per-product settings (digital good, returns, shipping,
    // size, price, extensibility, sit/lean) were seven "Edit ..." links stacked down the row. They are
    // kept, with their panels and save handlers untouched, but folded under one "More settings" control
    // so the row opened from a product's card reads as the product and its few actions, not as a form.
    const settingsEls = [
      digitalGoodText, digitalGoodToggle, digitalGoodPanel,
      noReturnsText, noReturnsToggle, noReturnsPanel,
      domesticOnlyText, domesticOnlyToggle, domesticOnlyPanel,
      sizeToggle, sizePanel,
      extensibilityToggle, extensibilityPanel, sitLeanToggle, sitLeanPanel,
    ];
    const moreToggle = document.createElement('button');
    moreToggle.type = 'button';
    moreToggle.className = 'seller-extensibility-toggle seller-more-settings-toggle';
    moreToggle.textContent = 'More settings ▾';
    moreToggle.setAttribute('aria-expanded', 'false');
    const moreBox = document.createElement('div');
    moreBox.className = 'seller-more-settings';
    moreBox.hidden = true;
    // Where the first setting stood: after the product's own facts, before reviews and sales.
    // #3584: the price is the setting a seller changes most, and "Not priced" is what stops a product selling, so
    // its control stays out in the open, right under the price it changes, not among the settings nobody touches.
    details.insertBefore(priceToggle, settingsEls[0]);
    details.insertBefore(pricePanel, settingsEls[0]);
    details.insertBefore(moreToggle, settingsEls[0]);
    details.insertBefore(moreBox, settingsEls[0]);
    // #3702 slice C: Preview, Duplicate and Flooring are secondary to Rename/Delete, so they
    // fold into the same box, on a row of their own at its top.
    const moreActions = document.createElement('div');
    moreActions.className = 'seller-row-actions';
    moreActions.append(previewBtn, duplicateBtn, flooringToggleBtn);
    moreBox.appendChild(moreActions);
    for (const el of settingsEls) moreBox.appendChild(el);
    moreToggle.addEventListener('click', () => {
      moreBox.hidden = !moreBox.hidden;
      moreToggle.setAttribute('aria-expanded', String(!moreBox.hidden));
      moreToggle.textContent = `More settings ${moreBox.hidden ? '▾' : '▴'}`;
    });
    sellerListEl.appendChild(row);
  }
}

// #541: a lighter, thumbnail-first way to browse the same products
// renderSellerList's rows already manage — persists only for this open of
// the modal (resets to 'manage' on next open, same as activeSettingsTab
// resetting per its own comment) since there's no strong reason yet for a
// seller's view choice to survive a close/reopen.
let sellerActiveView = 'manage';

// Exported for src/main.js's own enterSellMode (#2647) -- sellerActiveView
// becomes a module-private binding here, so that one call site needs a
// setter instead of its old direct assignment. Intentionally just the
// assignment, not also updateSellerViewToggleUI() -- enterSellMode calls
// that itself right after, same two-step shape as before this leaf moved.
export function resetSellerView() {
  sellerActiveView = 'manage';
}

// #3302: a Submit feedback report sent from Sell needs the camera pose and what
// the seller was looking at. Registered as Sell's frame callback by enterSellMode
// (src/main.js), and run after the movement core each frame once the Sell world
// view (#3295) mounts; recordRenderStateSample throttles it to ~1Hz. Every field was added for
// #3302 so a report from Sell says where it came from.
export function recordSellFeedbackSample(now) {
  recordRenderStateSample(now, {
    mode: 'sell', // #3302: which mode the report came from
    cameraPosition: { x: worldCamera.position.x, y: worldCamera.position.y, z: worldCamera.position.z }, // #3302: showcase camera pose
    sellerView: sellerActiveView, // #3302: 'manage' or 'list' view of the seller modal
    sellerModalOpen: sellerModalEl.classList.contains('visible'), // #3302: whether a modal was covering the showcase
    showcase: sellerShowcaseFeedbackState(), // #3302: which showcase page / how many products were showing
    ...frameMonitorSample(now), // added for #3396 -- load freeze; need the longest gap between frames in the last second and the long-task count to tell a main-thread stall from a slow network
  });
}

// #1503: the .active class alone communicated "current view" visually but
// not to a screen reader -- aria-pressed mirrors it so the same state is
// announced, not just styled.
export function updateSellerViewToggleUI() {
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
    syncSellerFilterControls(0);
    sellerStatusEl.textContent = EMPTY_COPY.products;
    return;
  }
  syncSellerFilterControls(allTemplates.length);
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

    // #2218: same visible-not-hidden indicator as Manage view's own row
    // badge (renderSellerList above) -- this view has no Duplicate button
    // of its own to disable (tapping a card just jumps into Manage,
    // focusSellerManageRow below, where that control and its own guard
    // live), but a moderator-removed product's own transparency shouldn't
    // depend on which view the seller happens to have open.
    if (template.flaggedHiddenAt) {
      const flaggedBadge = document.createElement('span');
      flaggedBadge.className = 'seller-card-flagged-badge';
      flaggedBadge.textContent = 'Removed — policy violation';
      card.appendChild(flaggedBadge);
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
// A tap on More on a showroom product's card: My products opens on that product's row (what a tap
// on the product itself used to do before #3702).
export function openSellerSheetOnProduct(templateId) {
  sellerModalEl.classList.add('visible');
  openModalA11y(sellerModalEl, closeSellerModal);
  focusSellerManageRow(templateId);
}

export function focusSellerManageRow(templateId) {
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
export async function renderSellerFeedbackSummary(id) {
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

// #4437: a product's thumbnail (and the 8x8 grid Prompt mode matches on) is stored only when its seller's own browser
// sends it right after an upload, resize or duplicate; a call that was missed (a closed tab, a failed request) was
// never made again, so the product could never be found by Prompt mode. Opening My products now sends the ones that
// have none, a few per open (the server allows 20 uploads per window and each render is a model load) and each only
// once a session, so a model that cannot render is not tried again and again.
const THUMBNAIL_BACKFILL_PER_OPEN = 3;
const thumbnailBackfillTried = new Set();
function backfillMissingThumbnails() {
  let started = 0;
  for (const template of myProducts()) {
    if (started >= THUMBNAIL_BACKFILL_PER_OPEN) break;
    if (template.sellerId !== sellerId || template.imageUrl || !template.modelUrl || thumbnailBackfillTried.has(template.templateId)) continue;
    thumbnailBackfillTried.add(template.templateId);
    started += 1;
    persistCatalogThumbnail(template);
  }
}

export async function openSellerModal() {
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
  backfillMissingThumbnails(); // #4437
}
// Exported for src/catalog/upload.js (#2557) -- its own closeUploadModal
// needs this same handler to re-arm the Seller modal's focus trap.
export function closeSellerModal() {
  sellerModalEl.classList.remove('visible');
  closeModalA11y(sellerModalEl);
  disposeAxisPreview();
  // An Edit size save while this modal was open can have just created a
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
  if (currentMode === 'sell' && isSellerShowcaseMeshesStale()) {
    clearSellerShowcaseMeshesStale();
    loadSellerShowcasePage(sellerShowcasePageIndex);
  }
  updateModeNavUI();
}
sellerCloseBtn.addEventListener('click', closeSellerModal);

// A seller identity first, as My products has always needed; then the leaf (upload.js listens).
async function openAddProductFromPetal() {
  await bootstrapPromise;
  const id = await ensureSellerIdentity();
  if (!id) return;
  document.dispatchEvent(new Event('higglehaven:add-product'));
}

async function openOrdersFromPetal() {
  await bootstrapPromise;
  const id = await ensureSellerIdentity();
  if (!id) return;
  openOrdersLeaf();
}

async function openPayoutsFromPetal() {
  await bootstrapPromise;
  const id = await ensureSellerIdentity();
  if (!id) return;
  openPayoutsLeaf();
}

// #3699 (Sell in the bud, 1/6; part of #3648): in Sell the interface is the bud. Its petals are
// the account rows and the Shop and Build mode buttons (moved in by src/ui/bud.js), plus these
// two: My products reopens the product list (the bottom-right Products button it replaces is
// gone). "?" is in the general menu (#3760), not here. Sell still opens onto My products and the list is still a sheet;
// slices 2 and 3 of #3655 change those.
registerBudPetals('sell', [
  { id: 'my-products', label: 'My products', run: () => { void openSellerModal(); } },
  // #3703 (Sell in the bud, 5/6): one petal starts every way of adding a product. The leaf it opens
  // (src/catalog/upload.js) asks which way; the + Upload Model and Sell this too buttons are gone.
  { id: 'add-product', label: 'Add a product', run: () => { void openAddProductFromPetal(); } },
  // #3704 (6/6, slice 1): the payout account, balance and Cash out are a leaf now (src/sell/payoutsLeaf.js),
  // not the bottom of Settings > Sell. A seller identity first, as My products has always needed.
  // #3704 (6/6, slice 3): every sale of the seller's products in one list, with Mark shipped and Refund.
  { id: 'orders', label: 'Orders', run: () => { void openOrdersFromPetal(); } },
  { id: 'payouts', label: 'Payouts', run: () => { void openPayoutsFromPetal(); } },
  // #3704 (6/6, slice 2): the shop name (Rename, Reset Profile) is a leaf; Settings has no Sell tab.
  { id: 'storefront', label: 'Storefront', run: () => { void openStorefrontFromPetal(); } },
]);

// #2748 (leaf of #2745's shared-products redesign): "Sell this too" --
// browse every product in the catalog (not just this seller's own) and
// attach a fresh listing (this seller's own price/stock) to whichever one
// is picked -- POST /api/catalog/listings (#2747). Deliberately not named
// or worded like Duplicate (see this button's own HTML comment, and
// #2218's discussion) -- no copy is ever made here; every shared field
// (model, name, dimensions, ...) is read live off the already-existing
// product by the server, never re-entered or re-uploaded by this seller.
//
// Its own dedicated modal (#sell-this-too-modal) rather than reusing the
// Build-mode catalog picker (openCatalogPickerForPick, reused by the
// Backup chain panel for an analogous "pick one existing catalog item"
// need) -- that picker's DOM lives inside #add-item-panel, one of the
// Build-only panels SELL_HIDDEN_BUILDER_UI_IDS (src/main.js) sets
// style.display='none' on for the whole time Sell mode is active, which a
// descendant's own .visible class can never override. Same stack-on-top-
// without-closing-the-Seller-modal shape as the Upload modal's own
// openUploadModal/closeUploadModal (src/catalog/upload.js) instead.
const sellThisTooModalEl = document.getElementById('sell-this-too-modal');
const sellThisTooGridEl = document.getElementById('sell-this-too-grid');
const sellThisTooEmptyEl = document.getElementById('sell-this-too-empty');
const sellThisTooSearchInput = document.getElementById('sell-this-too-search-input');
const sellThisTooCloseBtn = document.getElementById('sell-this-too-close-btn');
const sellThisTooFormEl = document.getElementById('sell-this-too-form');
const sellThisTooFormTitleEl = document.getElementById('sell-this-too-form-title');
const sellThisTooFormNoteEl = document.getElementById('sell-this-too-form-note');
const sellThisTooPriceInput = document.getElementById('sell-this-too-price-input');
const sellThisTooStockInput = document.getElementById('sell-this-too-stock-input');
const sellThisTooFormErrorEl = document.getElementById('sell-this-too-form-error');
const sellThisTooAddBtn = document.getElementById('sell-this-too-add-btn');
const sellThisTooBackBtn = document.getElementById('sell-this-too-back-btn');

// One tile per distinct *product*, not per existing listing -- a product
// several sellers already list would otherwise show up once per seller,
// which is both visual noise and not what "browse products to sell" means.
// minPriceCents is purely informational (what it's currently going for
// elsewhere) -- this seller sets their own price next regardless of it.
function distinctSellableProducts() {
  const byProductId = new Map();
  for (const template of activeCatalog) {
    // #2748's own worker/lib/catalog.js fix backs every new template with
    // a product_id at creation time, same as #2746's historical backfill
    // already did for every pre-existing row -- null only for a row from
    // before either of those landed, which can't be attached to here.
    if (!template.productId) continue;
    const entry = byProductId.get(template.productId);
    if (!entry) {
      byProductId.set(template.productId, { template, minPriceCents: template.priceCents });
    } else if (template.priceCents != null && (entry.minPriceCents == null || template.priceCents < entry.minPriceCents)) {
      entry.minPriceCents = template.priceCents;
    }
  }
  return [...byProductId.values()];
}

// #2795: the duplicate check below reads activeCatalog, which only gets this
// listing pushed into it *after* createCatalogListing's await resolves --
// without a guard, a second submit while that request is still in flight
// would create the same listing twice. Module-level (not per-template) since
// a seller could otherwise race two DIFFERENT products' requests against
// each other too, both still safe individually but not worth the added
// complexity to allow concurrently.
let attachListingInFlight = false;

// #3249: the price and stock questions used to be two native prompt() calls
// plus a confirm() for "you already have one", which a browser that
// suppresses native dialogs skipped silently. They are now a small form in
// the Sell this too modal. The validation mirrors the Edit price panel's
// (parsePriceInputDollars/MAX_MONEY_CENTS) since priceCents is required here
// the same way it's required on this seller's own new listing (#1601's own
// catalog-create requirement, which POST /api/catalog/listings shares). The
// price starts empty and is checked here, on the step that holds it.
let attachFormTemplate = null;

function showSellThisTooGrid() {
  attachFormTemplate = null;
  sellThisTooFormEl.hidden = true;
  sellThisTooSearchInput.hidden = false;
  sellThisTooGridEl.hidden = false;
  renderSellThisTooGrid();
}

function attachListingTo(template) {
  attachFormTemplate = template;
  sellThisTooSearchInput.hidden = true;
  sellThisTooGridEl.hidden = true;
  sellThisTooEmptyEl.hidden = true;
  sellThisTooFormEl.hidden = false;
  sellThisTooFormTitleEl.textContent = template.name;
  const alreadyMine = myProducts().some((p) => p.productId === template.productId);
  sellThisTooFormNoteEl.hidden = !alreadyMine;
  sellThisTooFormNoteEl.textContent = alreadyMine
    ? `You already have a listing for "${template.name}". Adding this creates a second one.`
    : '';
  sellThisTooAddBtn.textContent = alreadyMine ? 'Add another listing' : 'Add listing';
  sellThisTooPriceInput.value = '';
  sellThisTooStockInput.value = '';
  sellThisTooFormErrorEl.hidden = true;
  sellThisTooPriceInput.focus();
}

async function submitAttachListing(event) {
  event.preventDefault();
  const template = attachFormTemplate;
  if (!template || attachListingInFlight) return;
  const fail = (message) => {
    sellThisTooFormErrorEl.textContent = message;
    sellThisTooFormErrorEl.hidden = false;
  };
  sellThisTooFormErrorEl.hidden = true;
  const dollars = parsePriceInputDollars(sellThisTooPriceInput.value);
  if (!Number.isFinite(dollars) || dollars < 0) {
    fail('Enter a price of 0 or more.');
    sellThisTooPriceInput.focus();
    return;
  }
  if (hasFractionOfACent(sellThisTooPriceInput.value)) {
    fail(FRACTION_OF_A_CENT_MESSAGE);
    sellThisTooPriceInput.focus();
    return;
  }
  if (Math.round(dollars * 100) > MAX_MONEY_CENTS) {
    fail(`Price must be ${formatPriceCents(MAX_MONEY_CENTS)} or less.`);
    sellThisTooPriceInput.focus();
    return;
  }
  const priceCents = Math.round(dollars * 100);
  const trimmedStock = sellThisTooStockInput.value.trim();
  // #4343: same limit and wording as the server (worker/stockLimit.js). Blank here means the listing has no stock
  // number (unlimited), so stockQuantity stays undefined and is not sent.
  const parsedStock = parseStockInput(trimmedStock);
  if (parsedStock.error) {
    fail(parsedStock.error);
    sellThisTooStockInput.focus();
    return;
  }
  const stockQuantity = parsedStock.quantity ?? undefined;
  attachListingInFlight = true;
  sellThisTooAddBtn.disabled = true;
  try {
    const listing = await createCatalogListing({ productId: template.productId, priceCents, stockQuantity });
    activeCatalog.push(listing);
    // #327: same fire-and-forget reasoning as Duplicate's own call to this
    // above -- without it, this listing's imageUrl/imageEmbedding stay
    // permanently null.
    persistCatalogThumbnail(listing);
    buildCatalogPickerButtons();
    refreshSellerShowcase();
    closeSellThisTooModal();
    renderActiveSellerView();
  } catch (err) {
    fail(err.message || 'Couldn\'t attach this listing.');
  } finally {
    attachListingInFlight = false;
    sellThisTooAddBtn.disabled = false;
  }
}

// Same thumbnail-tile look as List view's own .seller-card (renderSellerListView
// above) -- these classes are plain, unscoped CSS, not tied to #seller-list-view,
// so reusing them here keeps every "browse products" surface in this file
// looking consistent rather than inventing a second tile style.
function renderSellThisTooGrid() {
  sellThisTooGridEl.replaceChildren();
  const query = sellThisTooSearchInput.value.trim().toLowerCase();
  const entries = distinctSellableProducts()
    .filter(({ template }) => !query || template.name.toLowerCase().includes(query));
  sellThisTooEmptyEl.hidden = entries.length > 0;
  for (const { template, minPriceCents } of entries) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'seller-card';

    const thumb = document.createElement('img');
    thumb.className = 'seller-card-thumb';
    thumb.alt = '';
    thumb.src = catalogThumbnailCache.get(template.templateId) ?? template.imageUrl ?? solidColorDataUrl(template.color);
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
    price.textContent = minPriceCents == null ? 'Not priced yet' : `From ${formatPriceCents(minPriceCents)}`;
    card.appendChild(price);

    card.addEventListener('click', () => attachListingTo(template));
    sellThisTooGridEl.appendChild(card);
  }
}

// #3703: put My products back on close only when it was open underneath when this opened.
let sellThisTooOpenedOverSeller = false;
function openSellThisTooModal() {
  sellThisTooOpenedOverSeller = sellerModalEl.classList.contains('visible');
  sellThisTooSearchInput.value = '';
  showSellThisTooGrid();
  sellThisTooModalEl.classList.add('visible');
  openModalA11y(sellThisTooModalEl, closeSellThisTooModal);
}
function closeSellThisTooModal() {
  sellThisTooModalEl.classList.remove('visible');
  closeModalA11y(sellThisTooModalEl);
  // Same stacked-on-top re-arming as closeUploadModal's own comment explains (#3703: only when
  // My products was open underneath).
  if (sellThisTooOpenedOverSeller) {
    sellerModalEl.classList.add('visible');
    openModalA11y(sellerModalEl, closeSellerModal);
  }
  sellThisTooOpenedOverSeller = false;
}
document.addEventListener('higglehaven:sell-this-too', openSellThisTooModal);
sellThisTooCloseBtn.addEventListener('click', closeSellThisTooModal);
sellThisTooSearchInput.addEventListener('input', renderSellThisTooGrid);
sellThisTooFormEl.addEventListener('submit', submitAttachListing);
sellThisTooBackBtn.addEventListener('click', showSellThisTooGrid);

// #2565 (leaf of #2504/#2500): the Settings modal's Sell tab was extracted here; #3704 turned what
// was left of it into the bud's Storefront leaf (below) and the tab is gone.

// #3704 (6/6, slice 2): the shop name, with Rename and Reset Profile, is the bud's Storefront leaf; it
// was the only thing left on Settings > Sell, and that tab is gone. The calls, the warning and the
// confirmation are the ones the Settings field made (renderIdentityField), hosted in the leaf.
function renderSellerIdentityField(container, rerender) {
  renderIdentityField('Seller', {
    container,
    rerender,
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
    deleteWarning: 'Reset your seller profile? Your products come off sale and leave every lándlet they stand on. This cannot be undone. Your login stays active either way; to delete that too, use Delete account under the account icon at the top.',
    onDeleted: () => { setSellerId(null); },
  });
}

function openStorefrontLeaf() {
  const paint = (body) => {
    body.innerHTML = '';
    renderSellerIdentityField(body, () => paint(body));
  };
  openLeaf({
    id: 'storefront',
    title: 'Storefront',
    render: (body) => paint(body),
  });
}

async function openStorefrontFromPetal() {
  await bootstrapPromise;
  const id = await ensureSellerIdentity();
  if (!id) return;
  openStorefrontLeaf();
}
