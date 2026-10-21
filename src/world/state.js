import { CATALOG as FALLBACK_CATALOG } from '../catalog.js';

// #2551 (part of #2504/#2500's src/main.js module split, see #2503's design
// comment for the full dependency map): the cross-cutting identity/mode/
// catalog singletons every other extracted module needs to read. An ES
// import binding is read-only from the importing side, so each piece of
// state that main.js (or any future module) still needs to *write* gets a
// paired setter function here rather than being reassignable directly —
// same reasoning src/settings.js's getUnits/setUnits pair already
// established for shared mutable state in this codebase, just in-memory
// instead of localStorage-backed.

// The API (worker/index.js + D1) is authoritative when reachable; the
// catalog.js constants above are only used if fetching it fails. This is
// reassigned once, in bootstrap() (src/main.js), before anything reads it —
// every other reference to the catalog goes through this variable rather
// than FALLBACK_CATALOG directly.
export let activeCatalog = FALLBACK_CATALOG;
export function setActiveCatalog(catalog) {
  activeCatalog = catalog;
}

// Saved groups a builder can stamp down again together (see migrations/
// 0039_bundles.sql) — fetched once builderId is settled in bootstrap() and
// refreshed after any save/delete. Empty (rather than falling back to
// something local) when the backend's unreachable — a bundle only makes
// sense as something durable across sessions/landlets, so there's no
// offline equivalent worth keeping, unlike activeCatalog's FALLBACK_CATALOG.
export let myBundles = [];
export function setMyBundles(bundles) {
  myBundles = bundles;
}
// Every builder's opted-in shared bundles (see migrations/0040_bundle_sharing.sql)
// — a separate list from myBundles, not a filtered view of it, fetched
// alongside it in bootstrap() so the picker's section can show/hide
// correctly based on either tab having something before a builder ever
// switches to the Community tab.
export let communityBundles = [];
export function setCommunityBundles(bundles) {
  communityBundles = bundles;
}

// Resolved from the logged-in account's own builder profile (see
// ensureBuilderIdentity, docs/API.md's "Authentication") once, in
// bootstrap(), before anything reads it; every instance created afterward
// is tagged with it so builders only ever see and edit their own
// landlet's placed products. currentLandletId is settled alongside it.
export let builderId = null;
export function setBuilderId(id) {
  builderId = id;
}
export let currentLandletId = 'starter-landlet';
export function setCurrentLandletId(id) {
  currentLandletId = id;
}

// A seller identity is a genuinely separate roster from builders (see
// worker/index.js's /api/sellers and docs/API.md's "Sellers" section) —
// catalog_templates.seller_id is tagged with this, not builderId, so
// "my products" means "products this seller identity uploaded," not
// "products this builder identity uploaded." Settled lazily, only once
// Sell mode is actually reached (see ensureSellerIdentity), unlike
// builderId which bootstrap() always resolves up front.
export let sellerId = null;
export function setSellerId(id) {
  sellerId = id;
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
// than trying to reuse Build's leftover state).
export let currentMode = 'shop';
export function setCurrentMode(mode) {
  currentMode = mode;
}

// Naming convention (see docs/SPEC.md): plain "a" internally — "landlet", not "lándlet".
// A standard landlet is exactly 1000 m^2. Square footprint for this first pass:
// side length = sqrt(area), giving an edge just over 31.6 meters.
export const LANDLET_AREA_M2 = 1000;
export const LANDLET_SIDE_M = Math.sqrt(LANDLET_AREA_M2);
// Buildable volume: one level (10m, per spec §3) straight up from whichever
// level's own floor is currently in view. No longer the flat-plane/plain-
// cuboid placeholder this comment used to describe — the ground itself is
// curved (curveGroundGeometry, issues #133/#135) and clampToLandlet
// (src/main.js) already widens/narrows the X/Y footprint per height via
// footprintScaleAtHeight, matching the spec's actual cone-shaped volume
// (issue #136). LANDLET_HEIGHT_M just fixes each level's own Z-slab height;
// see clampToLandlet's own comment for how the cross-section at that height
// gets corrected.
export const LANDLET_HEIGHT_M = 10;
