// #2648 (leaf of #2562, sub-issue of #2504/#2500's src/main.js module
// split, see #2503's design comment for the full dependency map): Sell
// mode's in-world showcase array -- the read-only, paginated display of a
// seller's own products on the faux-landlet ground plane, as distinct
// from #2647's product-management modal (the "Manage"/"List" views
// behind it). Extracted verbatim, zero behavior change.
//
// myProducts and openSellerModal (the showcase's own "Manage" button
// target) now both live in #2647's src/sell/mode.js, which landed after
// this leaf's own work started -- imported from there directly.
import * as THREE from 'three';
import { currentMode } from '../world/state.js';
import { scene } from '../world/scene.js';
import {
  curveGroundGeometry, normalizeGroundShapeUVs, landlet, createMeshForInstance, disposeObject,
} from '../world/models.js';
import { computeSellerShowcasePages, layoutSellerShowcasePage } from '../sellerShowcase.js';
import { myProducts, openSellerModal } from '../sell/mode.js';

// Separate array from productMeshes (a genuine builder-owned landlet's
// content, driven by persistLayout/sync) since these are read-only,
// unowned-by-any-landlet display copies that never get saved anywhere.
// Exported (read-only live binding) for src/main.js's own showcase
// click-handler (the currentMode === 'sell' branch of the main renderer's
// click listener).
export let sellerShowcaseMeshes = [];
// Array of arrays of catalog templates, computed once per Sell-mode entry
// (or catalog refresh) by computeSellerShowcasePages — index 0 is always
// the first page shown.
let sellerShowcasePages = [];
// Exported (read-only live binding) for src/main.js's own closeSellerModal,
// which re-loads this page after a product create/duplicate/delete left
// the showcase stale (see refreshSellerShowcase/sellerShowcaseMeshesStale
// below).
export let sellerShowcasePageIndex = 0;

const sellerShowcasePagerEl = document.getElementById('seller-showcase-pager');
const sellerShowcasePageLabelEl = document.getElementById('seller-showcase-page-label');
const sellerShowcasePrevBtn = document.getElementById('seller-showcase-prev-btn');
const sellerShowcaseNextBtn = document.getElementById('seller-showcase-next-btn');
// Exported (the binding itself never changes, only its classList) for
// src/main.js's own enterSellMode, which reveals this button on Sell-mode
// entry the same way it hides/shows the rest of Sell's own chrome.
export const sellerShowcaseManageBtn = document.getElementById('seller-showcase-manage-btn');
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
// Exported for src/main.js's own enterSellMode, which calls this directly
// after setSellerShowcasePages (below).
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

// Exported for src/main.js's own enterSellMode, which computes the page
// set once on entry and then calls loadSellerShowcasePage(0) itself --
// distinct from refreshSellerShowcase below (which only updates the
// cheap pager UI and marks the meshes stale for Sell mode's own later
// close-the-modal rebuild). sellerShowcasePages became a module-private
// binding with this extraction, so enterSellMode's own direct assignment
// needs this setter instead.
export function setSellerShowcasePages(pages) {
  sellerShowcasePages = pages;
}

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
// creating a product. Also used by #2647's own renderSellerList (Duplicate/
// Delete actions).
export function refreshSellerShowcase() {
  sellerShowcasePages = computeSellerShowcasePages(myProducts());
  if (currentMode !== 'sell') return;
  sellerShowcasePageIndex = Math.min(sellerShowcasePageIndex, Math.max(0, sellerShowcasePages.length - 1));
  updateSellerShowcasePagerUI();
  sellerShowcaseMeshesStale = true;
}

// Exported for src/main.js's own closeSellerModal, which checks this right
// after the modal closes to decide whether to rebuild the now-revealed
// showcase (see that function's own comment).
export function isSellerShowcaseMeshesStale() {
  return sellerShowcaseMeshesStale;
}
export function clearSellerShowcaseMeshesStale() {
  sellerShowcaseMeshesStale = false;
}

// findRootProduct's own counterpart for the showcase array — a showcase
// mesh's clicked-on geometry can sit on a nested child node the same way a
// real placed instance's does (see loadModelInstance), not directly on the
// Object3D pushed into sellerShowcaseMeshes. Exported for src/main.js's
// own showcase click-handler.
export function findRootSellerShowcaseMesh(object) {
  let current = object;
  while (current && !sellerShowcaseMeshes.includes(current)) {
    current = current.parent;
  }
  return current;
}
