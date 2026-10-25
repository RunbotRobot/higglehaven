// #2558 (part of #2504/#2500's src/main.js module split, see #2503's design
// comment for the full dependency map): the catalog/bundle picker modal
// (Build's add-item flow, plus "prompt mode" concept-image search and the
// bundle picker's own tabs/rename/share/delete), extracted from src/main.js.
// The issue's own line estimate ("~2296-3074") was wrong by a wide margin,
// same shape #2618's own correction found for its leaf -- the real block
// starts around line 1628 and is NOT contiguous: the catalog-thumbnail
// render/cache subsystem (catalogThumbnailCache, renderCatalogThumbnail,
// solidColorDataUrl, computeThumbnailEmbedding, persistCatalogThumbnail,
// etc.) sits physically in the middle of it but deliberately stays in
// main.js rather than moving here -- it's genuinely shared well beyond
// this modal (Sell mode's own product-tile rendering, Save Size's
// thumbnail invalidation, src/catalog/upload.js's own persistCatalogThumbnail
// call), same reasoning MAX_MONEY_CENTS's own comment in main.js gives for
// staying put. Imported back from main.js below.
//
// Build mode's own Backup Chain panel now lives in
// src/build/metadataModals.js (#2560), which calls openCatalogPickerForPick
// directly. Save Bundle flow (bundlePickerLoadToken's own external bumps)
// hasn't been extracted yet, so this module still exports several pieces
// main.js needs to call back (renderBundlePicker, bumpBundlePickerLoadToken,
// buildCatalogPickerButtons, closeCatalogPicker -- the last of these for its
// own world-click-away handler, see that function's own comment) -- same
// temporary-circular-import shape
// account/auth.js's, account/menu.js's, build/layoutPreview.js's, and
// catalog/upload.js's own comments already use for their own
// not-yet-extracted dependencies. addItemBtn is exported the same way:
// src/build/scene.js's own enterPlacementMode/cancelPlacementMode (armed
// from anywhere a placement can start -- a tile pick here, Upload Model,
// Paste) write its button label directly.
import { openModalA11y, closeModalA11y } from '../ui/modal.js';
import { generateConceptImage, searchCatalogBySimilarity, fetchBundles, fetchSharedBundles, updateBundle, deleteBundle } from '../api.js';
import {
  activeCatalog, myBundles, setMyBundles, communityBundles, setCommunityBundles, builderId,
} from '../world/state.js';
import {
  catalogThumbnailCache, renderCatalogThumbnail, solidColorDataUrl, computeThumbnailEmbedding,
  activeBundleTab, setActiveBundleTab,
} from '../main.js';
// #2559: enterPlacementMode/cancelPlacementMode/pendingPlacement now live in
// src/build/scene.js -- see that module's own comment.
// #2560: hideBackupReferenceMesh now lives in src/build/metadataModals.js.
import { hideBackupReferenceMesh } from '../build/metadataModals.js';
import { enterPlacementMode, cancelPlacementMode, pendingPlacement } from '../build/scene.js';

// Add-item catalog picker: a toggled panel listing every activeCatalog
// template as a grid of thumbnails with the name below each, rather than a
// plain list of name-only buttons — much faster to recognize a product by
// its actual shape/color than by reading through a list of names. Tapping
// one doesn't place anything yet — it arms placement mode (see
// enterPlacementMode) so the next tap in the world, wherever that is, is
// where the item actually goes. Tiles are (re)built in bootstrap() once
// activeCatalog is settled, since the API's catalog isn't known until that
// fetch resolves.
export const addItemBtn = document.getElementById('add-item-btn');
const catalogPickerEl = document.getElementById('catalog-picker');
const catalogPickerGridEl = document.getElementById('catalog-picker-grid');
const catalogPickerCloseBtn = document.getElementById('catalog-picker-close-btn');
const catalogSearchInputEl = document.getElementById('catalog-search-input');
const catalogPickerEmptyEl = document.getElementById('catalog-picker-empty');
const catalogPickerEmptyQueryEl = document.getElementById('catalog-picker-empty-query');
const bundlePickerSectionEl = document.getElementById('bundle-picker-section');
const bundlePickerGridEl = document.getElementById('bundle-picker-grid');
const bundlePickerEmptyEl = document.getElementById('bundle-picker-empty');
const bundleTabButtons = [...document.querySelectorAll('.bundle-tab-btn')];

// #1082 (owner's own call): one search box covering both the product grid
// above and the bundle section below, with this scope toggle picking which
// section(s) it actually applies to — 'both' is the default so existing
// "search products" behavior is unchanged until a builder deliberately
// narrows it.
const searchScopeButtons = [...document.querySelectorAll('.search-scope-btn')];
const catalogSearchScopeTabsEl = document.getElementById('catalog-search-scope-tabs');
let catalogSearchScope = 'both'; // 'products' | 'bundles' | 'both'

// #329/#330: "Prompt mode" — a second way into the exact same
// enterPlacementMode({type:'template',...}) flow manual mode's own tiles
// use above, just arrived at via a generated concept image and a
// similarity search instead of browsing/searching the catalog directly.
const catalogModeTabButtons = [...document.querySelectorAll('.catalog-mode-tab-btn')];
const catalogManualModeEl = document.getElementById('catalog-manual-mode');
const catalogPromptModeEl = document.getElementById('catalog-prompt-mode');
const promptModeInputEl = document.getElementById('prompt-mode-input');
const promptModeGenerateBtn = document.getElementById('prompt-mode-generate-btn');
const promptModeStatusEl = document.getElementById('prompt-mode-status');
const promptModeGridEl = document.getElementById('prompt-mode-grid');
const promptModeEmptyEl = document.getElementById('prompt-mode-empty');
let activeCatalogMode = 'manual';

// Client-side name filtering (see #catalog-search-input's own CSS comment)
// — toggles each already-built tile's `hidden` attribute rather than
// re-querying the catalog or touching the thumbnail cache, since neither a
// template's name nor its appearance changes mid-session. Reads whatever
// buildCatalogPickerButtons last stamped into each tile's dataset.name, so
// it's safe to call any time after the grid exists, including right after
// a rebuild while the picker itself is closed.
//
// #1082: the whole product grid (not just its tiles) hides outright when
// catalogSearchScope narrows the search to Bundles only — the empty-state
// message is product-specific wording ("No products match...") so it's
// suppressed too rather than shown for an unrelated, deliberately-hidden
// section.
function filterCatalogTiles() {
  const showProducts = catalogSearchScope !== 'bundles';
  catalogPickerGridEl.hidden = !showProducts;
  const query = catalogSearchInputEl.value.trim().toLowerCase();
  let anyVisible = false;
  if (showProducts) {
    for (const tile of catalogPickerGridEl.children) {
      const matches = !query || tile.dataset.name.includes(query);
      tile.hidden = !matches;
      if (matches) anyVisible = true;
    }
  }
  catalogPickerEmptyEl.hidden = !showProducts || anyVisible || !query;
  catalogPickerEmptyQueryEl.textContent = catalogSearchInputEl.value.trim();
}

// #1082: re-applies both the product filter and the bundle filter/visibility
// together — the one handler for anything that can change what the search
// box's scope covers (typing, or switching the scope toggle itself).
function updateCatalogSearchPanel() {
  filterCatalogTiles();
  renderBundlePicker();
}
catalogSearchInputEl.addEventListener('input', updateCatalogSearchPanel);
for (const btn of searchScopeButtons) {
  btn.addEventListener('click', () => {
    catalogSearchScope = btn.dataset.searchScope;
    for (const b of searchScopeButtons) {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-pressed', String(b === btn));
    }
    updateCatalogSearchPanel();
  });
}

// Shared by manual mode's own grid below and prompt mode's search-result
// grid (#329/#330) — both list catalog template objects and both arm the
// exact same enterPlacementMode({type:'template',...}) flow on click, so
// neither needs its own copy of this tile's look or click behavior.
function buildCatalogTemplateTile(template) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'catalog-tile';
  tile.dataset.name = template.name.toLowerCase();

  const thumb = document.createElement('img');
  thumb.className = 'catalog-thumb';
  thumb.alt = '';
  // #327: a persisted image_url (once one exists) is a real, already-
  // rendered image straight from storage — cheaper than the client
  // re-rendering this template's full GLTF model just to redraw the
  // same picture the live render already produced once before. The
  // in-session cache still wins when both exist since it's already in
  // memory (no network round trip) and, right after a fresh upload,
  // may be more current than a not-yet-finished persistCatalogThumbnail
  // call.
  thumb.src = catalogThumbnailCache.get(template.templateId) ?? template.imageUrl ?? solidColorDataUrl(template.color);
  // The ?? chain above only falls back to a flat-color swatch when
  // imageUrl is itself missing — it never fires if imageUrl is present
  // but the actual request for it fails (a 404 on a since-deleted R2
  // object, a transient network error, ...), which otherwise leaves a
  // permanently broken-image icon in the tile instead of the same
  // on-brand placeholder the ?? chain already has on hand. onerror
  // clears itself before swapping in the data: URL fallback so a
  // (never actually expected) failure to render *that* can't loop.
  thumb.onerror = () => {
    thumb.onerror = null;
    thumb.src = solidColorDataUrl(template.color);
  };
  tile.appendChild(thumb);

  const name = document.createElement('span');
  name.className = 'catalog-tile-name';
  name.textContent = template.name;
  tile.appendChild(name);

  // #1951: stockQuantity is already in every template object #1948 put
  // there (null means unlimited, the default/common case -- no indicator
  // at all, so an ordinary tile stays uncluttered). A finite, nonzero
  // value is the real signal the issue asks for: enough to let a builder
  // weigh risk before placing (a one-off "antique lamp" vs. a bottomless
  // "cottage bricks" restock) without needing a sales-velocity/"days
  // remaining" estimate -- that math doesn't exist anywhere in this
  // codebase yet, and #1947's own tracking issue already flags it as an
  // undecided owner question (what trailing window, what to show with no
  // sales history), so it's deliberately not built here.
  if (template.stockQuantity != null) {
    const stock = document.createElement('span');
    stock.className = 'catalog-tile-stock';
    if (template.stockQuantity === 0) {
      stock.classList.add('catalog-tile-stock-sold-out');
      stock.textContent = 'Sold out';
    } else {
      stock.textContent = `${template.stockQuantity} left`;
    }
    tile.appendChild(stock);
  }

  tile.addEventListener('click', () => {
    // #2051: when set, the Backup Chain panel's "+ Add Backup" wants the
    // chosen template handed back to it instead of an ordinary world
    // placement -- captured before closeCatalogPicker() below, which
    // clears it as part of leaving pick mode.
    const onPick = catalogPickerPickCallback;
    closeCatalogPicker();
    if (onPick) {
      onPick(template);
      return;
    }
    enterPlacementMode({ type: 'template', template }, `Tap a spot to place ${template.name}`);
  });
  return { tile, thumb };
}

// Exported for src/catalog/upload.js (#2557) -- its own
// handleUploadDimensionsStep needs this same catalog-picker refresh after
// a new product is created. Also still used directly here, and by
// Build-mode call sites in main.js not yet extracted.
export function buildCatalogPickerButtons() {
  catalogPickerGridEl.replaceChildren();
  for (const template of activeCatalog) {
    const { tile, thumb } = buildCatalogTemplateTile(template);
    catalogPickerGridEl.appendChild(tile);

    if (!catalogThumbnailCache.has(template.templateId) && !template.imageUrl) {
      renderCatalogThumbnail(template).then((dataUrl) => {
        if (dataUrl) thumb.src = dataUrl;
      });
    }
  }
  filterCatalogTiles();
}

// #329/#330: "Prompt mode" — a builder types a free-text description, an
// AI-generated concept image stands in for a product photo, and the
// catalog's own stored embeddings (see uploadCatalogTemplateThumbnail
// above) are searched for the closest visual matches. A hit is placed the
// exact same way a manual-mode tile is (buildCatalogTemplateTile above)
// — this mode only changes how candidates are *found*, not how one ends
// up in the world.
function renderCatalogMode() {
  const promptActive = activeCatalogMode === 'prompt';
  catalogManualModeEl.hidden = promptActive;
  catalogPromptModeEl.hidden = !promptActive;
  for (const btn of catalogModeTabButtons) {
    const isActive = btn.dataset.catalogMode === activeCatalogMode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  }
}
for (const btn of catalogModeTabButtons) {
  btn.addEventListener('click', () => {
    activeCatalogMode = btn.dataset.catalogMode;
    renderCatalogMode();
  });
}
// #1965: unlike its sibling toggle groups in this same modal (e.g.
// searchScopeButtons, re-synced every time the picker opens via
// updateCatalogSearchPanel), renderCatalogMode() was previously only ever
// invoked from its own click handler above -- so aria-pressed would never
// get set at all until a builder's first click on either tab. One eager
// call here gives both buttons a correct initial aria-pressed from page
// load, matching the already-correct initial .active/hidden state the
// static markup provides.
renderCatalogMode();

function setPromptModeStatus(text) {
  promptModeStatusEl.textContent = text;
  promptModeStatusEl.hidden = !text;
}

function renderPromptModeResults(templates) {
  promptModeGridEl.replaceChildren();
  promptModeEmptyEl.hidden = templates.length > 0;
  for (const template of templates) {
    const { tile } = buildCatalogTemplateTile(template);
    promptModeGridEl.appendChild(tile);
  }
}

// Loads a same-origin image URL (the concept-image endpoint's own
// response, always a /uploads/... path) into a real <img> so
// computeThumbnailEmbedding can drawImage it the same way it draws a
// just-rendered catalog thumbnail's canvas.
function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the generated concept image.'));
    img.src = src;
  });
}

promptModeGenerateBtn.addEventListener('click', async () => {
  const prompt = promptModeInputEl.value.trim();
  if (!prompt) {
    setPromptModeStatus('Describe what you’re looking for first.');
    return;
  }
  promptModeGenerateBtn.disabled = true;
  promptModeEmptyEl.hidden = true;
  try {
    setPromptModeStatus('Generating a concept image…');
    const imageUrl = await generateConceptImage(prompt);
    setPromptModeStatus('Finding similar products…');
    const image = await loadImageElement(imageUrl);
    const embedding = computeThumbnailEmbedding(image);
    const templates = await searchCatalogBySimilarity(embedding, 20);
    renderPromptModeResults(templates);
    setPromptModeStatus('');
  } catch (err) {
    console.warn('Prompt mode search failed:', err);
    // #2440: previously a generic "Something went wrong. Please try again."
    setPromptModeStatus(err.message || "Couldn't find similar products for that — please try again in a moment.");
  } finally {
    promptModeGenerateBtn.disabled = false;
  }
});

// Bundles (see migrations/0039_bundles.sql, 0040_bundle_sharing.sql) — no
// thumbnail, just a name and item count; tapping one arms placement mode
// with exactly the same {type:'clipboard', items} shape a Paste does, so
// handlePlacementClick's existing clipboard-placement path
// (placeClipboardItems) needs no changes to place a bundle.
//
// The whole section stays hidden until either list has something — a
// builder who's never saved a bundle themselves but whose neighbors have
// shared some still gets to discover the Community tab. Delete (and the
// Shared/Private toggle) only ever show on a tile this builder actually
// owns — a shared bundle is still owned by whoever created it (see
// handleBundles' own comment in worker/index.js); the backend does no
// ownership check, so this is the only place that's actually enforced.
//
// #1082: also hidden outright when catalogSearchScope narrows the search
// to Products only — same reasoning as filterCatalogTiles hiding the
// product grid for the Bundles-only case, just the other section.
function currentBundleTabList() {
  return activeBundleTab === 'mine' ? myBundles : communityBundles;
}

// #1349: the rename and share-toggle handlers below each do their own
// updateBundle -> refetch-both-lists -> renderBundlePicker() round trip
// against this same shared myBundles/communityBundles state — without a
// shared token, a rename and a share-toggle fired close together could
// have the slower refetch land last and redraw from a snapshot that's
// already stale relative to the other's already-applied change. Same
// monotonic-token fix as friendsLoadToken/notificationsLoadToken.
// Exported for main.js's own Save Bundle flow and bundle-list refresh
// (not yet extracted) -- a live binding, so comparisons there
// (`loadToken !== bundlePickerLoadToken`) always see this module's current
// value. An ES import binding is read-only from the importing side though,
// so `++bundlePickerLoadToken` can't be done there directly;
// bumpBundlePickerLoadToken below increments the module-local counter and
// hands back the new value, same as capturing `++bundlePickerLoadToken`
// would locally.
export let bundlePickerLoadToken = 0;
export function bumpBundlePickerLoadToken() {
  return ++bundlePickerLoadToken;
}

// Exported for main.js's own Save Bundle flow and bundle-list refresh
// (not yet extracted) -- also still used directly here.
export function renderBundlePicker() {
  const hasAnyBundles = myBundles.length > 0 || communityBundles.length > 0;
  bundlePickerSectionEl.hidden = catalogSearchScope === 'products' || !hasAnyBundles;
  if (bundlePickerSectionEl.hidden) return;

  for (const btn of bundleTabButtons) {
    btn.classList.toggle('active', btn.dataset.bundleTab === activeBundleTab);
    btn.setAttribute('aria-pressed', String(btn.dataset.bundleTab === activeBundleTab));
  }

  const bundles = currentBundleTabList();
  bundlePickerGridEl.replaceChildren();
  bundlePickerEmptyEl.hidden = bundles.length > 0;
  if (bundles.length === 0) {
    bundlePickerEmptyEl.textContent = activeBundleTab === 'mine'
      ? "You haven't saved any bundles yet — select items and use Save Bundle."
      : 'No one has shared a bundle yet.';
    return;
  }

  for (const bundle of bundles) {
    const tile = document.createElement('div');
    tile.className = 'bundle-tile';
    // #1082: read by filterBundleTiles below, same dataset.name idiom
    // buildCatalogTemplateTile already uses for the product grid.
    tile.dataset.name = bundle.name.toLowerCase();
    const owned = bundle.builderId === builderId;

    const placeBtn = document.createElement('button');
    placeBtn.type = 'button';
    placeBtn.className = 'bundle-tile-place';
    const name = document.createElement('span');
    name.className = 'bundle-tile-name';
    name.textContent = bundle.name;
    const count = document.createElement('span');
    count.className = 'bundle-tile-count';
    count.textContent = `${bundle.items.length} item${bundle.items.length === 1 ? '' : 's'}`;
    placeBtn.append(name, count);
    placeBtn.addEventListener('click', () => {
      closeCatalogPicker();
      // #2766: group: true -- a bundle's own newly-placed instances default
      // to grouped (placeClipboardItems' own new option, see its comment),
      // unlike an ordinary clipboard paste through pasteBtn elsewhere in
      // src/build/scene.js, which leaves this unset.
      enterPlacementMode({ type: 'clipboard', items: bundle.items, group: true }, `Tap a spot to place "${bundle.name}"`);
    });
    tile.appendChild(placeBtn);

    if (owned) {
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'bundle-tile-rename';
      renameBtn.textContent = '✎';
      renameBtn.setAttribute('aria-label', `Rename bundle "${bundle.name}"`);
      renameBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const next = prompt('Rename this bundle', bundle.name);
        if (!next || !next.trim() || next.trim() === bundle.name) return;
        if (next.trim().length > 100) {
          alert('Keep it to 100 characters or fewer.');
          return;
        }
        renameBtn.disabled = true;
        const myLoadToken = ++bundlePickerLoadToken;
        try {
          const updated = await updateBundle(bundle.bundleId, { name: next.trim() });
          Object.assign(bundle, updated);
          // #435: a shared bundle intentionally exists as two separate JS
          // objects, one per tab's own fetch (myBundles/communityBundles)
          // — the Object.assign above only ever patches whichever tab's
          // copy this rename was triggered from, leaving the other tab's
          // tile showing the stale name. Refetching both, the same fix
          // the share-toggle handler below already uses for the same
          // divergence risk, keeps both tabs' copies in sync.
          const [freshMine, freshShared] = await Promise.all([fetchBundles(), fetchSharedBundles()]);
          if (myLoadToken !== bundlePickerLoadToken) return; // superseded while loading — a newer rename/share-toggle owns the picker now
          setMyBundles(freshMine);
          setCommunityBundles(freshShared);
          renderBundlePicker();
        } catch (err) {
          alert(err.message || 'Could not rename this bundle.');
          renameBtn.disabled = false;
        }
      });
      tile.appendChild(renameBtn);

      const shareToggleBtn = document.createElement('button');
      shareToggleBtn.type = 'button';
      // Own class, not shared with .bundle-tile-delete despite the same
      // look — a page.click('.bundle-tile-delete') would otherwise hit
      // whichever of the two buttons happens to render first in the DOM
      // instead of the one actually intended.
      shareToggleBtn.className = 'bundle-tile-share';
      shareToggleBtn.textContent = bundle.shared ? '⇩' : '⇧';
      shareToggleBtn.setAttribute(
        'aria-label',
        bundle.shared ? `Stop sharing "${bundle.name}"` : `Share "${bundle.name}" to the Community tab`,
      );
      shareToggleBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        shareToggleBtn.disabled = true;
        const myLoadToken = ++bundlePickerLoadToken;
        try {
          const updated = await updateBundle(bundle.bundleId, { shared: !bundle.shared });
          Object.assign(bundle, updated);
          // Sharing/unsharing changes which list(s) this bundle belongs in
          // — simplest to just re-fetch both rather than hand-patch
          // communityBundles for an add/remove that only affects this one
          // tab's membership.
          const [freshMine, freshShared] = await Promise.all([fetchBundles(), fetchSharedBundles()]);
          if (myLoadToken !== bundlePickerLoadToken) return; // superseded while loading — a newer rename/share-toggle owns the picker now
          setMyBundles(freshMine);
          setCommunityBundles(freshShared);
          renderBundlePicker();
        } catch (err) {
          alert(err.message || 'Could not update this bundle\'s sharing.');
          shareToggleBtn.disabled = false;
        }
      });
      tile.appendChild(shareToggleBtn);

      const deleteTileBtn = document.createElement('button');
      deleteTileBtn.type = 'button';
      deleteTileBtn.className = 'bundle-tile-delete';
      deleteTileBtn.setAttribute('aria-label', `Delete bundle "${bundle.name}"`);
      deleteTileBtn.textContent = '×';
      deleteTileBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!confirm(`Delete bundle "${bundle.name}"? This can't be undone.`)) return;
        // #1787: same bundlePickerLoadToken guard as the rename/share-toggle
        // handlers above — without it, a slower concurrent rename/share-
        // toggle on a different tile can resolve after this delete and
        // overwrite myBundles/communityBundles with a refetched snapshot
        // that still contains the bundle this handler just deleted.
        const myLoadToken = ++bundlePickerLoadToken;
        try {
          await deleteBundle(bundle.bundleId);
          if (myLoadToken !== bundlePickerLoadToken) return; // superseded while loading — a newer rename/share-toggle owns the picker now
          setMyBundles(myBundles.filter((b) => b.bundleId !== bundle.bundleId));
          setCommunityBundles(communityBundles.filter((b) => b.bundleId !== bundle.bundleId));
          renderBundlePicker();
        } catch (err) {
          alert(err.message || 'Could not delete this bundle.');
        }
      });
      tile.appendChild(deleteTileBtn);
    }

    bundlePickerGridEl.appendChild(tile);
  }

  filterBundleTiles();
}

// #1082: applies the shared search box's query to the just-built bundle
// tiles, same hidden-toggling idiom filterCatalogTiles uses for products.
// Only reachable once renderBundlePicker has already confirmed the
// section isn't hidden and the active tab has at least one bundle, so
// bundlePickerGridEl always has real tiles here — the "no bundles in this
// tab at all" empty-state text renderBundlePicker sets above is left
// alone in that case rather than this function ever running against an
// empty grid.
function filterBundleTiles() {
  const query = catalogSearchInputEl.value.trim().toLowerCase();
  let anyVisible = false;
  for (const tile of bundlePickerGridEl.children) {
    const matches = !query || tile.dataset.name.includes(query);
    tile.hidden = !matches;
    if (matches) anyVisible = true;
  }
  if (query && !anyVisible) {
    bundlePickerEmptyEl.hidden = false;
    bundlePickerEmptyEl.textContent = `No bundles match "${catalogSearchInputEl.value.trim()}".`;
  }
}
for (const btn of bundleTabButtons) {
  btn.addEventListener('click', () => {
    setActiveBundleTab(btn.dataset.bundleTab);
    renderBundlePicker();
  });
}
// #1554: shared modal keyboard accessibility (#1316) missed this panel —
// open/close now go through openModalA11y/closeModalA11y like every other
// real modal dialog in this file.
//
// #2051: when the picker was opened via openCatalogPickerForPick (the
// Backup Chain panel's "+ Add Backup" button), closing it by any route —
// a tile pick, the close button, Escape, or a backdrop click via
// openModalA11y — must also leave pick mode: clear the callbacks, restore
// the ordinary scope-tab row that mode hides, drop the low-opacity
// reference mesh it showed, and (via the stored "done" callback) hand
// control back to whatever opened the picker for a pick. One choke point
// here rather than duplicating this at every close trigger. onDone fires
// exactly once per pick session, whether the picker closed via an actual
// pick (see buildCatalogTemplateTile's tile click, which calls
// closeCatalogPicker before invoking the picked template's own callback)
// or a plain cancel — openModalA11y only ever tracks one modal at a time
// (see its own comment above), so the Backup Chain panel closes itself
// before opening this picker and relies on onDone to reopen+re-render
// itself afterward, rather than both staying visible at once.
let catalogPickerPickCallback = null;
let catalogPickerPickDoneCallback = null;
// Exported for src/catalog/upload.js (#2557) -- its own openUploadModal
// needs this same close call (Upload Model is reachable from the catalog
// picker, which must close before the Upload modal opens on top of it).
// Also exported for main.js's own world-click-away handler, which closes
// the picker (and so ends whatever pick session is active -- today, only
// src/build/metadataModals.js's Backup Chain panel, via
// openCatalogPickerForPick below) on any tap outside it.
export function closeCatalogPicker() {
  catalogPickerEl.classList.remove('visible');
  closeModalA11y(catalogPickerEl);
  if (catalogPickerPickCallback) {
    catalogPickerPickCallback = null;
    const onDone = catalogPickerPickDoneCallback;
    catalogPickerPickDoneCallback = null;
    catalogSearchScopeTabsEl.hidden = false;
    hideBackupReferenceMesh();
    if (onDone) onDone();
  }
}
// A backup must be a single catalog product, not a bundle — forces
// Products-only scope and hides the scope-tab row for the duration of the
// pick so there's nothing tappable that wouldn't do anything (a bundle
// tile calls its own multi-item placement flow, never this callback).
// Reuses the exact same picker UI/search/thumbnails as the ordinary
// "+ Add Item" flow below rather than building a second one.
// Exported for src/build/metadataModals.js's own Backup Chain panel (#2560).
export function openCatalogPickerForPick(onPick, onDone) {
  catalogPickerPickCallback = onPick;
  catalogPickerPickDoneCallback = onDone;
  catalogPickerEl.classList.add('visible');
  catalogSearchInputEl.value = '';
  catalogSearchScope = 'products';
  for (const b of searchScopeButtons) {
    b.classList.toggle('active', b.dataset.searchScope === 'products');
    b.setAttribute('aria-pressed', String(b.dataset.searchScope === 'products'));
  }
  catalogSearchScopeTabsEl.hidden = true;
  updateCatalogSearchPanel();
  openModalA11y(catalogPickerEl, closeCatalogPicker);
}
addItemBtn.addEventListener('click', () => {
  if (pendingPlacement) {
    cancelPlacementMode();
    return;
  }
  const opening = !catalogPickerEl.classList.contains('visible');
  if (!opening) {
    closeCatalogPicker();
    return;
  }
  catalogPickerEl.classList.add('visible');
  // Fresh search each time the picker opens, rather than carrying over
  // whatever was last typed (or last scoped to) — the same "reset on
  // open" pattern the upload modal's own file step uses. #1082 extends
  // this to the scope toggle: reopening with Bundles-only still
  // selected would otherwise leave the product grid silently hidden
  // with no query typed to explain why.
  catalogSearchInputEl.value = '';
  catalogSearchScope = 'both';
  for (const b of searchScopeButtons) {
    b.classList.toggle('active', b.dataset.searchScope === 'both');
    b.setAttribute('aria-pressed', String(b.dataset.searchScope === 'both'));
  }
  updateCatalogSearchPanel();
  openModalA11y(catalogPickerEl, closeCatalogPicker);
});
catalogPickerCloseBtn.addEventListener('click', closeCatalogPicker);
