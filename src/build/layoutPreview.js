// #2561 (part of #2504/#2500's src/main.js module split, see #2503's design
// comment for the full dependency map): the "faux layout preview" fourth
// mode, extracted wholesale from src/main.js. The design comment's own
// item #3 flags this as a genuine owner-input question (Build sub-feature
// vs. a top-level `layoutPreview/mode.js` peer of Shop/Build/Sell) with no
// resolution yet — this leaf proceeds with the design's stated default
// (a Build sub-feature, hence this module's name/location under
// src/build/) and surfaces the open question again in this PR rather than
// deciding it unilaterally.
//
// #2559: build/scene.js now owns the rest of Build mode's own internals
// (gizmos, controls, selection, undo/redo, etc.) — the Build-internal
// imports below are repointed there from main.js's own stopgap re-exports
// (same "fix the stale import" step #2555 did for claim/flow.js's own
// ui/modal.js import once ui/modal.js itself landed).
import * as THREE from 'three';
import { fetchCatalog, fetchSavedLayout, fetchAllLandlets, createInstancesRemote } from '../api.js';
import { computeSavedLayoutGround, pointInDragRect } from '../savedLayoutPreview.js';
import { scene, camera, renderer, registerModeFrameUpdate } from '../world/scene.js';
import {
  curveGroundGeometry, normalizeGroundShapeUVs, landlet, createMeshForInstance,
} from '../world/models.js';
import {
  builderId, setBuilderId, currentLandletId, currentMode, setCurrentMode, setActiveCatalog,
} from '../world/state.js';
import { ensureBuilderIdentity } from '../account/identity.js';
import { refreshNotificationsBadge, refreshFriendsBadge, refreshDmBadge } from '../account/menu.js';
import {
  controls, rotateControls, translateControls,
  clearSelection, addSelectionOutline, removeSelectionOutline,
  buildModeFrameUpdate, setLastKnownDistance,
} from './scene.js';
import { START_MODE_KEY, PREVIEW_SAVED_LAYOUT_ID_KEY, SELL_HIDDEN_BUILDER_UI_IDS, showShopAccessGate, updateModeNavUI } from '../main.js';

// #635 (sub-issue of #631): the faux-layout preview — a dedicated,
// read-only 3D view rendering one saved layout's instances at their true
// original relative positions (never sellerShowcase's own grid-repacking —
// see savedLayoutPreview.js's own comment on why), plus drag-rectangle
// marquee selection over them (the v1 interaction agreed on #631 in place
// of a literal freehand circle). Reuses the same "faux ground plane +
// real instance meshes" technique sellerShowcase already established
// (curveGroundGeometry on a swapped `landlet.geometry`, createMeshForInstance
// for real content) and the existing addSelectionOutline/removeSelectionOutline
// highlight Build mode's own single-selection already uses, rather than
// inventing either from scratch.
let layoutPreviewMeshes = [];
// The saved layout's own instance records, exactly as #635's GET endpoint
// returned them (never recentered the way the meshes' render positions
// are) — #636's "Paste" reads a selected instance's real x/y/z/rotation/
// crop/scale/flags back out of here, since those (not the preview-only
// recentered mesh position) are what should land on the target landlet.
let layoutPreviewInstances = [];
const selectedSavedInstanceIds = new Set();
// {x, y} in client (viewport) coordinates while a marquee drag is in
// progress, else null — the one piece of state every pointer handler below
// checks to know whether a drag is actually happening right now.
let layoutPreviewDragStart = null;

const layoutPreviewToolbarEl = document.getElementById('layout-preview-toolbar');
const layoutPreviewBackBtn = document.getElementById('layout-preview-back-btn');
const layoutPreviewNameEl = document.getElementById('layout-preview-name');
const layoutPreviewSelectionCountEl = document.getElementById('layout-preview-selection-count');
const layoutPreviewMarqueeEl = document.getElementById('layout-preview-marquee');
const layoutPreviewPasteTargetEl = document.getElementById('layout-preview-paste-target');
const layoutPreviewPasteBtn = document.getElementById('layout-preview-paste-btn');

function updateLayoutPreviewSelectionUI() {
  const n = selectedSavedInstanceIds.size;
  layoutPreviewSelectionCountEl.textContent = n === 0 ? '' : `${n} selected`;
  layoutPreviewPasteBtn.hidden = n === 0;
}

// A raw pointerdown-then-pointerup with no real movement between them is a
// plain click, not a drag — treated as "clear the selection" (the same
// click-empty-space-to-deselect convention Build mode's own clearSelection
// already follows) rather than as a zero-area rectangle that happens to
// contain nothing.
const LAYOUT_PREVIEW_DRAG_THRESHOLD_PX = 4;

function updateLayoutPreviewMarquee(clientX, clientY) {
  const x = Math.min(layoutPreviewDragStart.x, clientX);
  const y = Math.min(layoutPreviewDragStart.y, clientY);
  layoutPreviewMarqueeEl.style.left = `${x}px`;
  layoutPreviewMarqueeEl.style.top = `${y}px`;
  layoutPreviewMarqueeEl.style.width = `${Math.abs(clientX - layoutPreviewDragStart.x)}px`;
  layoutPreviewMarqueeEl.style.height = `${Math.abs(clientY - layoutPreviewDragStart.y)}px`;
}

// Finishes a marquee drag: projects each preview mesh's real world position
// through the live camera into screen-pixel space (the same NDC-to-pixel
// conversion the renderer itself does internally, just done here explicitly
// since three.js doesn't expose a mesh's own last-rendered screen position)
// and keeps whichever ones land inside the dragged rectangle, via the same
// pointInDragRect axis-aligned test savedLayoutPreview.js's own tests cover.
function finishLayoutPreviewDrag(clientX, clientY) {
  const rect = { x1: layoutPreviewDragStart.x, y1: layoutPreviewDragStart.y, x2: clientX, y2: clientY };
  layoutPreviewDragStart = null;
  layoutPreviewMarqueeEl.classList.remove('visible');

  for (const mesh of layoutPreviewMeshes) removeSelectionOutline(mesh);
  selectedSavedInstanceIds.clear();

  const dragDistance = Math.hypot(rect.x2 - rect.x1, rect.y2 - rect.y1);
  if (dragDistance >= LAYOUT_PREVIEW_DRAG_THRESHOLD_PX) {
    const projected = new THREE.Vector3();
    for (const mesh of layoutPreviewMeshes) {
      projected.copy(mesh.position).project(camera);
      // z > 1 in NDC space means behind the camera — never "in frame" even
      // if its projected x/y happens to fall inside the rect.
      if (projected.z > 1) continue;
      const screenPoint = {
        x: (projected.x + 1) / 2 * window.innerWidth,
        y: (1 - projected.y) / 2 * window.innerHeight,
      };
      if (pointInDragRect(screenPoint, rect)) {
        selectedSavedInstanceIds.add(mesh.userData.savedInstanceId);
        addSelectionOutline(mesh);
      }
    }
  }
  updateLayoutPreviewSelectionUI();
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (currentMode !== 'layoutPreview') return;
  layoutPreviewDragStart = { x: event.clientX, y: event.clientY };
  layoutPreviewMarqueeEl.classList.add('visible');
  updateLayoutPreviewMarquee(event.clientX, event.clientY);
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (currentMode !== 'layoutPreview' || !layoutPreviewDragStart) return;
  updateLayoutPreviewMarquee(event.clientX, event.clientY);
});
// On window, not just the canvas — a drag that ends after the pointer has
// left the canvas (dragging the marquee out past the toolbar, say) still
// needs to finish cleanly rather than leaving layoutPreviewDragStart set
// forever with no matching pointerup ever landing on the canvas itself.
window.addEventListener('pointerup', (event) => {
  if (currentMode !== 'layoutPreview' || !layoutPreviewDragStart) return;
  finishLayoutPreviewDrag(event.clientX, event.clientY);
});

layoutPreviewBackBtn.addEventListener('click', () => {
  sessionStorage.setItem(START_MODE_KEY, 'build');
  location.reload();
});

// #636 (sub-issue of #631): pastes the currently-selected saved instances
// onto a landlet the builder owns, as brand-new placed_instances rows.
//
// Deliberately routed through the exact same POST /instances/batch
// createInstancesRemote already uses for every other bulk-create — the
// server applies its normal ownership/z-bounds checks with no special
// "trusted paste" path, so e.g. a target landlet that hasn't purchased the
// level a saved instance's z requires rejects it exactly like a normal
// create would. instanceId is deliberately omitted from each payload
// entry: the original ids belonged to placed_instances rows that no
// longer exist (they were swept into this saved_layout_instances snapshot
// when the level was removed), and the batch endpoint already assigns a
// fresh id to any entry that omits one.

// #648: "target landlet" was first shipped as never a real picker, on the
// premise that a builder can only ever have one landlet claimed at a
// time. That's not actually true here — ownedLandletsByBuilderId's own
// comment in worker/index.js ("a builder can own more than one lándlet —
// auctions can transfer extra ones in") and this same file's own
// auction-start picker (renderStartSection, built for exactly #199/#249's
// two-simultaneously-claimed-landlets case) both establish it as a real,
// already-handled shape. Populated once per preview session (owned
// landlets don't change mid-preview), same "fetch-all + default to
// currentLandletId when it's in the list + only show a picker when
// there's more than one" convention renderStartSection already uses.
async function populateLayoutPreviewPasteTarget() {
  let owned;
  try {
    owned = await fetchAllLandlets({ status: 'claimed', ownerBuilderId: builderId });
  } catch {
    owned = []; // surfaced instead at paste time, same as the empty-owned case below
  }
  layoutPreviewPasteTargetEl.innerHTML = '';
  for (const ownedLandlet of owned) {
    const option = document.createElement('option');
    option.value = ownedLandlet.landletId;
    option.textContent = ownedLandlet.name || ownedLandlet.landletId;
    if (ownedLandlet.landletId === currentLandletId) option.selected = true;
    layoutPreviewPasteTargetEl.appendChild(option);
  }
  layoutPreviewPasteTargetEl.hidden = owned.length <= 1;
}

layoutPreviewPasteBtn.addEventListener('click', async () => {
  const selected = layoutPreviewInstances.filter((instance) => selectedSavedInstanceIds.has(instance.instanceId));
  if (selected.length === 0) return;
  const targetLandletId = layoutPreviewPasteTargetEl.value;
  if (!targetLandletId) {
    alert("You don't have a claimed lándlet to paste onto — claim one first.");
    return;
  }
  layoutPreviewPasteBtn.disabled = true;
  try {
    // Both instanceId and id (savedLayoutInstanceFromRow's own alias for
    // it) need stripping — validateInstance on the server falls back to
    // input.id just as readily as input.instanceId, so leaving either one
    // in place would hand the old, now-nonexistent id straight back
    // instead of letting the server assign a fresh one.
    await createInstancesRemote(selected.map(({ instanceId, id, ...instance }) => ({
      ...instance,
      landletId: targetLandletId,
    })));
    sessionStorage.setItem(START_MODE_KEY, 'build');
    location.reload();
  } catch (err) {
    // #1362: a mid-chunk failure (createInstancesRemote's own #903
    // succeededCount) already landed the earlier chunks server-side — a
    // plain alert()-and-retry left selectedSavedInstanceIds covering the
    // full original selection, so clicking Paste again resubmitted
    // already-succeeded items too and created duplicates (ids are always
    // stripped before submission, so the server just assigns them fresh
    // ones). Dropping the already-succeeded prefix from the selection
    // before re-enabling the button means a retry only resends what
    // actually still needs it, same as syncBatchCreate's own use of this
    // field.
    const succeededCount = err.succeededCount ?? 0;
    for (const instance of selected.slice(0, succeededCount)) {
      selectedSavedInstanceIds.delete(instance.instanceId);
    }
    const remaining = selected.length - succeededCount;
    alert(
      succeededCount > 0
        ? `Pasted ${succeededCount} item(s), but ${remaining} failed: ${err.message || ''}`.trim()
        : (err.message || "Couldn't paste these items."),
    );
    layoutPreviewPasteBtn.disabled = false;
  }
});

// Entered only via bootstrap() in main.js (reached the same way Shop/Build/
// Sell are — see START_MODE_KEY's own comment), never as an in-place
// transition from another live mode, so there's no other mode's leftover
// scene state to tear down here the way enterSellMode has to for a builder
// switching tabs mid-session.
export async function enterLayoutPreviewMode() {
  const savedLayoutId = sessionStorage.getItem(PREVIEW_SAVED_LAYOUT_ID_KEY);
  sessionStorage.removeItem(PREVIEW_SAVED_LAYOUT_ID_KEY);
  if (!savedLayoutId) {
    // Reached with no id to actually preview (a stale/direct reload) —
    // nothing to show, so land somewhere real instead of a blank scene.
    sessionStorage.setItem(START_MODE_KEY, 'build');
    location.reload();
    return;
  }

  for (const id of SELL_HIDDEN_BUILDER_UI_IDS) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  layoutPreviewToolbarEl.classList.add('visible');
  clearSelection();
  translateControls.detach();
  rotateControls.detach();
  controls.enabled = false;
  // #2552: shares Build's own tween/edge-pan/controls/debug/selection-
  // highlight per-frame work (selection/highlight are both empty here —
  // clearSelection() above and this mode's own no-highlighting design —
  // so those two loops are harmless no-ops, same as they already are
  // whenever Build itself has nothing selected).
  registerModeFrameUpdate(buildModeFrameUpdate);

  setBuilderId(await ensureBuilderIdentity());
  if (!builderId) {
    // N44: lands on showShopAccessGate's shared end state, not a full
    // enterShopMode() call — see that function's own comment for why.
    setCurrentMode('shop');
    updateModeNavUI();
    showShopAccessGate();
    return;
  }
  // #1958: notifications/friends/DM stay reachable from this mode (see
  // SELL_HIDDEN_BUILDER_UI_IDS's own comment below), same as Sell/Build --
  // enterSellMode and bootstrap()'s own Build branch both refresh these
  // three badges right after resolving builderId; this mode-entry path
  // resolved it the same way but never did, leaving the bell/friends/DM
  // badges stuck at their stale default while fully visible and clickable.
  refreshNotificationsBadge();
  refreshFriendsBadge();
  refreshDmBadge();
  populateLayoutPreviewPasteTarget();

  let layout;
  try {
    const [catalog, loadedLayout] = await Promise.all([fetchCatalog(), fetchSavedLayout(savedLayoutId)]);
    setActiveCatalog(catalog);
    layout = loadedLayout;
  } catch (err) {
    layoutPreviewNameEl.textContent = err.message || 'Could not load this saved layout.';
    return;
  }
  layoutPreviewNameEl.textContent = layout.name;
  layoutPreviewInstances = layout.instances;

  const ground = computeSavedLayoutGround(layout.instances);
  const oldGeometry = landlet.geometry;
  const halfWidth = ground.width / 2;
  const halfDepth = ground.depth / 2;
  const groundShape = new THREE.Shape([
    new THREE.Vector2(-halfWidth, -halfDepth),
    new THREE.Vector2(halfWidth, -halfDepth),
    new THREE.Vector2(halfWidth, halfDepth),
    new THREE.Vector2(-halfWidth, halfDepth),
  ]);
  landlet.geometry = new THREE.ShapeGeometry(groundShape);
  normalizeGroundShapeUVs(landlet.geometry);
  curveGroundGeometry(landlet.geometry);
  oldGeometry.dispose();

  // Frame the camera on the ground plane's own size right away, before
  // waiting on each instance's (network-dependent) model load below — a
  // camera still parked wherever Build mode left it, while the toolbar and
  // name already read as "loaded", would show the wrong part of the world
  // for as long as the slowest model takes to fetch.
  const dist = Math.max(ground.width, ground.depth);
  camera.position.set(dist * 0.75, -dist * 0.95, dist * 0.65);
  camera.lookAt(0, 0, 0);
  controls.target.set(0, 0, 0);
  // The free-fly dolly-to-truck conversion (see main.js's own controls
  // 'change' listener, near lastKnownDistance's own declaration) compares
  // the camera's distance-to-target against that stale module-level value
  // on the very next 'change' event to infer a scroll/pinch dolly amount —
  // without resyncing it here, this mode's own one-time camera jump reads
  // as a huge dolly nothing actually did, and immediately flings
  // controls.target far from the origin this preview is centered on.
  setLastKnownDistance(camera.position.distanceTo(controls.target));

  const meshes = await Promise.all(layout.instances.map((instance) => createMeshForInstance({
    ...instance,
    x: instance.x - ground.centerX,
    y: instance.y - ground.centerY,
    z: instance.z - ground.centerZ,
  })));
  for (const mesh of meshes) {
    if (!mesh) continue;
    scene.add(mesh);
    layoutPreviewMeshes.push(mesh);
  }
  // mesh.userData.instanceId is already set (to the same source instance
  // id) by createMeshForInstance itself — savedInstanceId is just a
  // same-value alias so this mode's own selection code reads its own
  // clearly-named field rather than reaching into a field named for a
  // concept (a live, ownable placed instance) that doesn't really apply
  // to this read-only preview.
  for (let i = 0; i < meshes.length; i++) {
    if (meshes[i]) meshes[i].userData.savedInstanceId = layout.instances[i].instanceId;
  }
}
