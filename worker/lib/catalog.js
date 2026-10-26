// #2531 (sub-issue of #2502, itself sub-issue of #2500's worker/index.js
// module split): the catalog-template route handler (handleCatalog) plus
// every helper exclusively used by it -- CRUD/batch/search/thumbnail/
// concept-image endpoints, template validation, dimension-change
// notifications, and the cursor/query-param helpers this resource's own
// listing endpoint uses. Extracted verbatim, zero behavior change.
//
// requireSessionBuilder itself now lives in ./auth.js (moved there after
// this file's own initial extraction, by #2543) -- imported from there
// directly, same as every other already-extracted worker/lib/ module
// (video-generation.js, credit-orbs.js, reputation.js).
//
// Deliberately NOT included here (genuinely shared beyond this file, same
// reverse-import shape worker/lib/video-generation.js's own comment
// documents for its own MAX_MODEL_BYTES/etc.):
// templateFromRow -- read by non-catalog handlers too (owned-avatar/
// -animation listings, instance crop/XY-bounds validation); sellerExists,
// requireSessionSeller, assertReferenceExists, optionalLabelValue,
// positiveNumber -- each used by several other not-yet-extracted domains'
// own handlers/validators too; handleProductReviews/handleProductFlags --
// their own domain, extracted separately into worker/lib/reputation.js
// (#2532), just dispatched to from here.
// getStorageUsage/reserveStorageBudget/formatBytes are the shared R2
// storage-budget machinery (#2530) -- genuinely cross-domain (concept-image
// generation, catalog thumbnails, model uploads, and video-to-3D generation
// all write into the same MODELS bucket under the same cap), so they live
// in worker/lib/storage.js, not worker/index.js -- imported from there
// directly rather than duplicated or routed back through worker/index.js.
// MAX_MODEL_BYTES/MAX_MONEY_CENTS/PNG_SIGNATURE/
// EXTENSIBLE_DIMENSION_KEY_BY_AXIS are likewise genuinely shared constants
// -- duplicated below rather than exported, since (per #1978, confirmed
// the hard way and already documented on worker/lib/credit-orbs.js's own
// LANDLET_SIDE_M/PRESENCE_STALE_AFTER_MS) workerd requires every named
// export of the main Worker entry module (worker/index.js) to be a
// function/class binding, not a plain const.
import { json, HttpError, clientIp } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import { readJson, stringValue, labelValue, assertReferencesExist, queryLimit } from './validation.js';
import { assertOwner, requireSessionBuilder } from './auth.js';
import { bytesToHex } from './crypto.js';
import { fireNotifications } from './notifications.js';
import {
  templateFromRow, sellerExists, requireSessionSeller, assertReferenceExists,
  optionalLabelValue, positiveNumber,
} from '../index.js';
import { getStorageUsage, reserveStorageBudget, formatBytes } from './storage.js';
import { handleProductReviews, handleProductFlags } from './reputation.js';

// #1978: see this file's own header comment above for why these are
// duplicated rather than imported -- each is the exact value worker/
// index.js itself still declares and uses for its own, non-catalog callers.
const MAX_MODEL_BYTES = 20 * 1024 * 1024;
const MAX_MONEY_CENTS = 100_000_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EXTENSIBLE_DIMENSION_KEY_BY_AXIS = { x: 'width', y: 'depth', z: 'height' };

const MAX_THUMBNAIL_BYTES = 300 * 1024;
const THUMBNAIL_DATA_URL_PREFIX = 'data:image/png;base64,';


// Baseline prohibited-content policy (docs/SPEC.md §4: "Prohibited
// categories (baseline, eBay/Etsy-referenced): weapons capable of serious
// harm, controlled substances/paraphernalia, adult content,
// counterfeit/unauthorized trademarked goods, live animals."). A plain
// phrase blocklist checked against name/category/subcategory — not real
// content moderation (no image/AI review exists anywhere in this dev-mode
// backend), just the same "honest simplest form" baseline this project
// applies elsewhere. Deliberately phrase-based rather than single loose
// words ("firearm," not "gun" alone) to keep false positives low against a
// catalog that's mostly ordinary placeholder/furniture names.
const PROHIBITED_CONTENT_PHRASES = [
  'firearm', 'handgun', 'assault rifle', 'ammunition', 'explosive device',
  'illegal drug', 'narcotic', 'drug paraphernalia', 'cocaine', 'heroin', 'methamphetamine',
  'adult content', 'pornographic', 'explicit sexual content',
  'counterfeit', 'knockoff replica',
  'live animal', 'live pet sale',
];

function assertNotProhibitedContent(template) {
  const haystack = [template.name, template.category, template.subcategory]
    .filter(Boolean).join(' ').toLowerCase();
  const match = PROHIBITED_CONTENT_PHRASES.find((phrase) => haystack.includes(phrase));
  if (match) {
    throw new HttpError(`This listing appears to violate higglehaven's prohibited-categories policy (matched "${match}")`, 400);
  }
}

// Digital goods (docs/SPEC.md §4: "Digital goods — narrow, conditional
// exception ... permitted if the listing includes (a) a representative 3D
// model and (b) a clear higglehaven-controlled disclaimer of what's
// actually delivered."). The disclaimer text is platform-controlled, not
// seller-authored freeform text — a seller picks one of these fixed keys,
// not their own wording, so `metadata.digitalGoodDisclaimer` only ever
// stores the key. There is no separate "isDigitalGood" flag: a template is
// a digital good exactly when this key is present, the same
// single-flag-in-metadata simplicity as flooring (migrations/0035) and
// extensibility.
const DIGITAL_GOOD_DISCLAIMER_TEXT = {
  'gift-card': 'This is a digital gift card to a real business, delivered as a code — not a physical item.',
  'art-file': 'This is a digital art or print file, delivered as a download — not a physical item.',
  'software-tool': 'This is a higglehaven-ecosystem software tool, delivered as a download or activation — not a physical item.',
  'avatar-model': 'This is an avatar model, delivered as an equippable item — not a physical item.',
};

// Found via backlog audit: `modelUrl` is optional for every *ordinary*
// template (`validateTemplate` below, `assertUploadedModelExists` no-ops on
// a null one) — a plain-colored-box fallback is a normal, supported look
// for a regular product. That's exactly the condition (a) this spec
// paragraph exempts digital goods *from*, not something they're already
// covered by: a disclaimer alone was silently sufficient to list a digital
// good with zero visual representation, satisfying only condition (b).
function assertValidDigitalGoodDisclaimer(metadata, modelUrl) {
  if (metadata.digitalGoodDisclaimer === undefined) return;
  if (!DIGITAL_GOOD_DISCLAIMER_TEXT[metadata.digitalGoodDisclaimer]) {
    throw new HttpError(`metadata.digitalGoodDisclaimer must be one of: ${Object.keys(DIGITAL_GOOD_DISCLAIMER_TEXT).join(', ')}`, 400);
  }
  if (!modelUrl) {
    throw new HttpError('A digital good must include modelUrl — a representative 3D model', 400);
  }
}

// "No-returns-policy respected as seller-set default" (docs/SPEC.md §5) —
// a seller-set flag on the product itself, same single-key-in-metadata
// simplicity as digitalGoodDisclaimer above. Absent/false means returns
// are accepted (the spec's own default), so this key is only ever written
// when a seller actively opts out.
function assertValidNoReturns(metadata) {
  if (metadata.noReturns === undefined) return;
  if (typeof metadata.noReturns !== 'boolean') {
    throw new HttpError('metadata.noReturns must be a boolean', 400);
  }
}

// International shipping (docs/SPEC.md §5: "Dimmed-filter approach:
// shoppers toggle a filter; non-shippable items are dimmed with a label
// ('ships to United States only')") — a seller-set flag on the product
// itself, same single-boolean-in-metadata simplicity as noReturns above.
// Absent/false means the product ships internationally (the permissive
// default), so this key is only ever written when a seller actively
// restricts to domestic shipping. Real per-destination-zone shipping
// *cost* and a live shopper-facing filter are deliberately not built yet
// (this dev-stage backend has no real shopper address/geo data to filter
// against) — see docs/API.md's "Shipping" section.
function assertValidDomesticOnly(metadata) {
  if (metadata.domesticOnly === undefined) return;
  if (typeof metadata.domesticOnly !== 'boolean') {
    throw new HttpError('metadata.domesticOnly must be a boolean', 400);
  }
}

// Per-axis crop-floor declaration for extensible (croppable) templates
// (docs/API.md's crop/trim feature, `assertCropWithinTemplateBounds`
// above) — same single-key-in-metadata pattern as the siblings above, but
// unlike those flat booleans/enums this one had no server-side validation
// at all until now. The frontend (src/main.js's extensibility-panel save
// handler) already enforces finite/positive/`minM < maxLength` before
// saving, but nothing stopped a PATCH bypassing that UI from writing a
// non-numeric, negative, or missing minM — which assertCropWithinTemplateBounds's
// `length < extensible.minM` check then silently fails to enforce, since
// JS's numeric comparison makes `anything < undefined` and `anything < NaN`
// both false. Mirrors the frontend's own checks exactly.
function assertValidExtensible(metadata, dimensions) {
  if (metadata.extensible === undefined) return;
  if (typeof metadata.extensible !== 'object' || metadata.extensible === null || Array.isArray(metadata.extensible)) {
    throw new HttpError('metadata.extensible must be an object', 400);
  }
  for (const [axis, entry] of Object.entries(metadata.extensible)) {
    const dimensionKey = EXTENSIBLE_DIMENSION_KEY_BY_AXIS[axis];
    if (!dimensionKey) {
      throw new HttpError(`metadata.extensible key "${axis}" must be one of: ${Object.keys(EXTENSIBLE_DIMENSION_KEY_BY_AXIS).join(', ')}`, 400);
    }
    const minM = entry?.minM;
    const maxLength = dimensions[dimensionKey];
    if (!Number.isFinite(minM) || minM <= 0) {
      throw new HttpError(`metadata.extensible.${axis}.minM must be a positive number`, 400);
    }
    if (minM >= maxLength) {
      throw new HttpError(`metadata.extensible.${axis}.minM must be less than this template's own ${dimensionKey}`, 400);
    }
  }
}

// docs/SPEC.md §2's context-aware idle state machine ("sit, lean, stand") --
// only "stand" is built today (src/main.js's updateShopAvatarIdle); #2476
// (sub-issue of the #2475 tracking issue) adds the data model a later
// targeting/pose system needs: where on a marked product an avatar sits or
// leans, and which way it faces while doing so. Coordinates are in the
// template's own local, un-rotated model space -- the same centered-at-
// origin space createMeshForInstance's BoxGeometry/model loading already
// use (x/y span +/- half the template's own width/depth, z spans 0 to its
// own height) -- so a later targeting system combines this with a placed
// instance's own x_m/y_m/z_m/rotation_z_rad to get a world-space target,
// the same way extensible's minM above is expressed in the template's own
// space rather than any one instance's.
function assertValidInteractionTarget(target, dimensions, key) {
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    throw new HttpError(`metadata.${key} must be an object`, 400);
  }
  const { offsetXM, offsetYM, heightM, facingRad } = target;
  if (!Number.isFinite(offsetXM) || Math.abs(offsetXM) > dimensions.width / 2) {
    throw new HttpError(`metadata.${key}.offsetXM must be a number within +/- half this template's own width`, 400);
  }
  if (!Number.isFinite(offsetYM) || Math.abs(offsetYM) > dimensions.depth / 2) {
    throw new HttpError(`metadata.${key}.offsetYM must be a number within +/- half this template's own depth`, 400);
  }
  if (!Number.isFinite(heightM) || heightM < 0 || heightM > dimensions.height) {
    throw new HttpError(`metadata.${key}.heightM must be a number between 0 and this template's own height`, 400);
  }
  if (!Number.isFinite(facingRad)) {
    throw new HttpError(`metadata.${key}.facingRad must be a finite number`, 400);
  }
}

function assertValidSitTarget(metadata, dimensions) {
  if (metadata.sitTarget === undefined) return;
  assertValidInteractionTarget(metadata.sitTarget, dimensions, 'sitTarget');
}

function assertValidLeanTarget(metadata, dimensions) {
  if (metadata.leanTarget === undefined) return;
  assertValidInteractionTarget(metadata.leanTarget, dimensions, 'leanTarget');
}


function validateTemplate(input, fallbackId) {
  const dimensions = input.dimensions || {};
  const template = {
    templateId: stringValue(input.templateId || fallbackId, 'templateId'),
    name: labelValue(input.name, 'name'),
    category: input.category ? labelValue(input.category, 'category') : 'placeholder',
    subcategory: optionalLabelValue(input.subcategory, 'subcategory'),
    color: labelValue(input.color, 'color'),
    dimensions: {
      width: positiveNumber(dimensions.width, 'dimensions.width'),
      depth: positiveNumber(dimensions.depth, 'dimensions.depth'),
      height: positiveNumber(dimensions.height, 'dimensions.height'),
    },
    priceCents: optionalInteger(input.priceCents, 'priceCents'),
    // #1948: NULL (the default, unless a seller opts in) means unlimited --
    // today's unchanged behavior for every pre-existing and future template
    // unless this is explicitly set. A set value is remaining stock, not a
    // fixed "original quantity" -- it decrements at purchase-finalize time
    // (writePurchaseRow) and a seller PATCHing a new value here directly
    // overwrites whatever remained, the same as any other seller-settable
    // field.
    stockQuantity: optionalStockQuantity(input.stockQuantity),
    sellerId: optionalStringValue(input.sellerId, 'sellerId'),
    modelUrl: input.modelUrl || null,
    // #540: the seller's own "faux lándlet" 3D array paginates by a
    // cumulative model-file-size cap, not a fixed item count — this is the
    // one place that size (already computed and returned by
    // handleModelUpload, previously discarded by every client-side caller)
    // gets persisted so later pagination doesn't need to re-fetch every
    // model just to plan pages. NULL for a template with no model, or one
    // uploaded before this field existed.
    modelSizeBytes: optionalModelSizeBytes(input.modelSizeBytes),
    // #1162: computed client-side (computeSkeletonSignature) alongside
    // modelSizeBytes, same "measured once at upload time, persisted so
    // nothing needs to re-fetch the model later" reasoning.
    skeletonSignature: optionalSkeletonSignature(input.skeletonSignature),
    metadata: input.metadata || {},
  };
  // Found via backlog audit (#375): modelUrl went straight through with no
  // format check at all — assertUploadedModelExists (below, at the actual
  // R2-reference check) only validates a `/uploads/`-prefixed value and
  // silently no-ops for anything else, so an arbitrary external URL sailed
  // through untouched. src/main.js's model loader (createMeshForInstance ->
  // loadModelInstance -> GLTFLoader) then unconditionally fetches
  // template.modelUrl from the browser of every shopper/builder who loads a
  // landlet with that template placed on it, not just whoever set it -- a
  // real SSRF-shaped hole (tracking pixel, IP/UA/timing leak, or a chance to
  // feed the model loader an oversized/malformed payload). The only
  // supported shapes, per docs/API.md, are "absent" and a real uploaded
  // model reference.
  if (template.modelUrl !== null && (typeof template.modelUrl !== 'string' || !template.modelUrl.startsWith('/uploads/'))) {
    throw new HttpError('modelUrl must reference an uploaded model (starting with /uploads/) or be omitted', 400);
  }
  JSON.stringify(template.metadata);
  assertNotProhibitedContent(template);
  assertValidDigitalGoodDisclaimer(template.metadata, template.modelUrl);
  assertValidNoReturns(template.metadata);
  assertValidDomesticOnly(template.metadata);
  assertValidExtensible(template.metadata, template.dimensions);
  assertValidSitTarget(template.metadata, template.dimensions);
  assertValidLeanTarget(template.metadata, template.dimensions);
  return template;
}

// #1569: sellerId is optional on catalog-template creation (a system/
// placeholder template has none), but was accepted with no type check at
// all when present, letting a non-string value (an object/array) reach
// assertReferenceExists'/assertReferencesExist's raw D1 bind and crash
// with an unhandled 500 instead of a clean 400.
function optionalStringValue(value, field) {
  if (!value) return null;
  return stringValue(value, field);
}

function optionalInteger(value, field) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_MONEY_CENTS) {
    throw new HttpError(`${field} must be a non-negative integer no greater than ${MAX_MONEY_CENTS}`, 400);
  }
  return number;
}

// #540: bounded against MAX_MODEL_BYTES (the same real upload-size limit
// handleModelUpload itself enforces), not MAX_MONEY_CENTS like
// optionalInteger above — a model's size is never actually money-sized, and
// reusing that cap here would just be the wrong bound wearing the right shape.
function optionalModelSizeBytes(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_MODEL_BYTES) {
    throw new HttpError(`modelSizeBytes must be a non-negative integer no greater than ${MAX_MODEL_BYTES}`, 400);
  }
  return number;
}

// #1948: bounded generously -- this is a count of physical units, not money
// or bytes, so MAX_MONEY_CENTS would be the wrong bound wearing the right
// shape the same way optionalModelSizeBytes already explains above.
const MAX_STOCK_QUANTITY = 1_000_000;

function optionalStockQuantity(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_STOCK_QUANTITY) {
    throw new HttpError(`stockQuantity must be a non-negative integer no greater than ${MAX_STOCK_QUANTITY}`, 400);
  }
  return number;
}

// #1162: a SHA-256 hex digest (computeSkeletonSignature, src/main.js) of a
// model's skeleton bone names/hierarchy, or null for a model with no
// skeleton at all. Only the shape is validated here, not the content —
// this server never re-derives it from the actual model file (that would
// mean re-fetching and parsing GLTF server-side for no real benefit), so
// it's trusted the same way modelSizeBytes already is, just shape-checked
// against being tampered into something that isn't a real digest at all.
const SKELETON_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
function optionalSkeletonSignature(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SKELETON_SIGNATURE_PATTERN.test(value)) {
    throw new HttpError('skeletonSignature must be a 64-character lowercase hex SHA-256 digest, or omitted', 400);
  }
  return value;
}

function templateParams(template) {
  return [template.templateId, template.name, template.category, template.subcategory, template.color, template.dimensions.width, template.dimensions.depth, template.dimensions.height, template.priceCents, template.sellerId, template.modelUrl, template.modelSizeBytes, template.skeletonSignature, JSON.stringify(template.metadata), template.stockQuantity];
}

// #1758: compares an existing row (raw DB shape) against a freshly
// validated template (camelCase shape) across every field the real
// upload wizard's still-editable inputs could legitimately change between
// a lost-response attempt and a resubmit -- name/category/subcategory/
// color/dimensions/priceCents/metadata. modelUrl/sellerId are deliberately
// excluded: they're already baked into the idempotency key's own
// namespace (see catalogTemplateIdempotencyKey), so two rows reaching this
// comparison under the same key already share them.
function templateContentMatches(existingRow, template) {
  return existingRow.name === template.name
    && existingRow.category === template.category
    && existingRow.subcategory === template.subcategory
    && existingRow.color === template.color
    && existingRow.width_m === template.dimensions.width
    && existingRow.depth_m === template.dimensions.depth
    && existingRow.height_m === template.dimensions.height
    && existingRow.price_cents === template.priceCents
    && existingRow.metadata_json === JSON.stringify(template.metadata)
    && existingRow.stock_quantity === template.stockQuantity;
}

// #327: decodes and size-caps the flat PNG thumbnail POST /api/catalog/
// :templateId/thumbnail receives. A JSON data-URL body (not multipart)
// deliberately, unlike handleModelUpload's raw .glb upload — this is a
// small, browser-canvas-produced image accompanied by a same-shaped JSON
// embedding array, and both fit naturally into one ordinary JSON request.
function decodeThumbnailDataUrl(imageDataUrl) {
  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith(THUMBNAIL_DATA_URL_PREFIX)) {
    throw new HttpError(`imageDataUrl must be a data URL starting with "${THUMBNAIL_DATA_URL_PREFIX}"`, 400);
  }
  let binary;
  try {
    binary = atob(imageDataUrl.slice(THUMBNAIL_DATA_URL_PREFIX.length));
  } catch {
    throw new HttpError('imageDataUrl is not valid base64', 400);
  }
  if (binary.length > MAX_THUMBNAIL_BYTES) {
    throw new HttpError(`Thumbnail is ${formatBytes(binary.length)}, over the ${formatBytes(MAX_THUMBNAIL_BYTES)} limit`, 413);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // #823: the data-URL prefix only says the client *claims* this is a PNG —
  // check the real signature before it's ever written to R2, same posture
  // as validateGlb's binary check for .glb model uploads.
  const hasPngSignature = bytes.length >= PNG_SIGNATURE.length
    && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
  if (!hasPngSignature) throw new HttpError('imageDataUrl is not a valid PNG image', 400);
  return bytes;
}

// The embedding itself (see migrations/0071's own comment) is opaque —
// this only bounds its shape against a malformed or oversized payload,
// the same "don't trust the client" posture as every other input this
// file validates, not an attempt to judge whether it's a *good*
// embedding.
function validateThumbnailEmbedding(embedding) {
  if (embedding === undefined || embedding === null) return null;
  if (!Array.isArray(embedding) || embedding.length === 0 || embedding.length > 4096) {
    throw new HttpError('embedding must be a non-empty array of at most 4096 numbers', 400);
  }
  for (const value of embedding) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new HttpError('embedding values must all be finite numbers', 400);
    }
  }
  return embedding;
}

// #329: cosine similarity — scale-invariant (so it doesn't matter that
// today's stub embedding is a bounded [0,1] color average rather than a
// normalized unit vector), and undefined only when a vector is all
// zeros, which can't happen for the stub (a genuinely all-black or
// all-transparent thumbnail is possible but vanishingly unlikely, and
// still just correctly reads as "no meaningful direction to compare");
// returns 0 rather than NaN if it ever does, so a degenerate row sorts
// last instead of corrupting the whole ranking.
// #1244: guards against silent NaN corruption for a future caller that
// doesn't pre-filter by length the way similarity-search's own call site
// already does — looping only over a.length while b is shorter would
// otherwise read b[i] as undefined for the tail of the loop, silently
// producing NaN instead of failing loudly at the point of misuse.
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error('cosineSimilarity: vector length mismatch');
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

// #1728: unlike purchases (purchaseIdempotencyKey above, namespaced by an
// existing instanceId+buyerBuilderId) or sign posts/calendar events
// (namespaced by an existing instanceId), a brand-new catalog template
// has no pre-existing resource id to namespace a client-sent key by --
// it's creating something from scratch. The closest stable value known
// to the client before the create call is the model it already uploaded
// (modelUrl), scoped by the creating seller so two different sellers who
// happen to reuse the exact same model file can't collide. Unlike those
// other namespace components, modelUrl itself contains slashes
// (`/uploads/models/<hash>.glb`) and the result here is used as
// template_id, which doubles as a literal URL path segment elsewhere in
// this file (GET/PUT/PATCH/DELETE /catalog/:templateId and its
// /thumbnail, /reviews siblings) -- so the namespaced value is hashed
// down to a flat hex string, the same way storeTripoModelOutput already
// content-addresses a model's own bytes in this file, rather than being
// used as the id verbatim the way the simpler single-id namespaces above
// can be.
async function catalogTemplateIdempotencyKey(sellerId, modelUrl, rawKey) {
  if (typeof rawKey !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(rawKey)) return undefined;
  const namespace = `${sellerId || 'anon'}:${modelUrl || 'none'}:${rawKey}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(namespace)));
  return `template-${bytesToHex(digest)}`;
}

function queryNonnegativeInteger(value, field) {
  if (value === null) return null;
  const text = stringValue(value, field);
  if (!/^\d+$/.test(text)) throw new HttpError(`${field} must be a non-negative integer`, 400);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    throw new HttpError(`${field} must be a non-negative integer`, 400);
  }
  return number;
}

function queryPositiveNumber(value, field) {
  if (value === null) return null;
  const text = stringValue(value, field);
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0) {
    throw new HttpError(`${field} must be a positive number`, 400);
  }
  return number;
}

function encodeCatalogCursor(name, templateId) {
  const bytes = new TextEncoder().encode(JSON.stringify([name, templateId]));
  return btoa(String.fromCharCode(...bytes));
}

function decodeCatalogCursor(value) {
  if (value === null) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(decoded) || decoded.length !== 2 ||
        typeof decoded[0] !== 'string' || decoded[0] === '' ||
        typeof decoded[1] !== 'string' || decoded[1] === '') throw new Error();
    return { name: decoded[0], templateId: decoded[1] };
  } catch {
    throw new HttpError('cursor is invalid', 400);
  }
}

function encodeCatalogPriceCursor(priceCents, templateId) {
  const bytes = new TextEncoder().encode(JSON.stringify([priceCents, templateId]));
  return btoa(String.fromCharCode(...bytes));
}

function decodeCatalogPriceCursor(value) {
  if (value === null) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(decoded) || decoded.length !== 2
      || !Number.isSafeInteger(decoded[0]) || decoded[0] < 0
      || typeof decoded[1] !== 'string' || decoded[1] === '') throw new Error();
    return { priceCents: decoded[0], templateId: decoded[1] };
  } catch {
    throw new HttpError('cursor is invalid', 400);
  }
}

async function existingSellerIds(db, sellerIds) {
  const uniqueIds = [...new Set(sellerIds)];
  if (uniqueIds.length === 0) return new Set();
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const { results } = await db.prepare(
    `SELECT seller_id FROM sellers WHERE seller_id IN (${placeholders})`,
  ).bind(...uniqueIds).all();
  return new Set(results.map((row) => row.seller_id));
}

// #729: saved_layout_instances (migrations/0080) and version_instances
// (migrations/0007) both keep an immutable historical snapshot of a
// template's placement, and both intentionally use ON DELETE RESTRICT (a
// snapshot should never silently lose which template it depicted) — so a
// template referenced only by one of these, with zero live
// placed_instances left, still fell through to catalog delete's generic
// databaseHttpError 409 with no way to tell it apart from a template
// that's genuinely still placed somewhere. Pre-checked here so the caller
// gets a message pointing at the actual (often invisible to them — a
// stranger's saved layout, or an old version of a landlet they don't own)
// blocker instead of the generic "still in use".
// #1706: placed_instances.template_id (migrations/0001) is ON DELETE
// RESTRICT too, the same as the other two — but was never checked here at
// all, so the single most common blocker (a template still actually placed
// somewhere) fell straight through to the same generic 409 this function
// otherwise exists to avoid.
// #2050: placed_instance_backups.template_id (migrations/0137) is the same
// ON DELETE RESTRICT shape again — a template still queued as someone's
// configured backup, even if nothing currently placed uses it, needs its
// own specific message here too, same reasoning as saved_layout_instances/
// version_instances above.
async function assertCatalogTemplatesDeletable(db, templateIds) {
  const uniqueValues = [...new Set(templateIds)];
  const placeholders = uniqueValues.map(() => '?').join(', ');
  const [inPlacedInstances, inSavedLayouts, inVersions, inBackups, inArchivedVersions] = await Promise.all([
    db.prepare(
      `SELECT DISTINCT template_id FROM placed_instances WHERE template_id IN (${placeholders})`,
    ).bind(...uniqueValues).all(),
    db.prepare(
      `SELECT DISTINCT template_id FROM saved_layout_instances WHERE template_id IN (${placeholders})`,
    ).bind(...uniqueValues).all(),
    db.prepare(
      `SELECT DISTINCT template_id FROM version_instances WHERE template_id IN (${placeholders})`,
    ).bind(...uniqueValues).all(),
    db.prepare(
      `SELECT DISTINCT template_id FROM placed_instance_backups WHERE template_id IN (${placeholders})`,
    ).bind(...uniqueValues).all(),
    // #2315: archived_version_instances (migrations/0140) has the same
    // ON DELETE RESTRICT on template_id as the four tables above, but was
    // added after this function's own last audit (#1706) and never got
    // wired in -- a template only referenced by an inactivity-reclaimed
    // version snapshot fell through to the generic FK-failure fallback.
    db.prepare(
      `SELECT DISTINCT template_id FROM archived_version_instances WHERE template_id IN (${placeholders})`,
    ).bind(...uniqueValues).all(),
  ]);
  const blockedByPlacedInstance = new Set(inPlacedInstances.results.map((row) => row.template_id));
  const blockedBySavedLayout = new Set(inSavedLayouts.results.map((row) => row.template_id));
  const blockedByVersion = new Set(inVersions.results.map((row) => row.template_id));
  const blockedByBackup = new Set(inBackups.results.map((row) => row.template_id));
  const blockedByArchivedVersion = new Set(inArchivedVersions.results.map((row) => row.template_id));
  for (const templateId of uniqueValues) {
    if (blockedByPlacedInstance.has(templateId)) {
      throw new HttpError(
        `Catalog template "${templateId}" cannot be deleted: it is still placed on a landlet `
        + '(remove every placed instance of it first)',
        409,
      );
    }
    if (blockedBySavedLayout.has(templateId)) {
      throw new HttpError(
        `Catalog template "${templateId}" cannot be deleted: it is still referenced by a saved layout `
        + '(a builder has it saved for reuse, even if nothing placed uses it right now)',
        409,
      );
    }
    if (blockedByVersion.has(templateId)) {
      throw new HttpError(
        `Catalog template "${templateId}" cannot be deleted: it is still referenced by a landlet's version history `
        + '(a past published version snapshot used it, even if the current layout does not)',
        409,
      );
    }
    if (blockedByBackup.has(templateId)) {
      throw new HttpError(
        `Catalog template "${templateId}" cannot be deleted: it is still configured as a placed instance's backup `
        + '(remove it from every backup chain first)',
        409,
      );
    }
    if (blockedByArchivedVersion.has(templateId)) {
      throw new HttpError(
        `Catalog template "${templateId}" cannot be deleted: it is still referenced by an archived version snapshot `
        + '(a reclaimed landlet\'s preserved version history used it)',
        409,
      );
    }
  }
}

function dimensionsDiffer(a, b) {
  return Math.abs(a.width - b.width) > 1e-4 ||
    Math.abs(a.depth - b.depth) > 1e-4 ||
    Math.abs(a.height - b.height) > 1e-4;
}

// #1734: metadata.extensible[axis].minM can tighten (or an axis's own
// extensibility can be removed entirely) and metadata.flooring can be
// toggled through the same PATCH/batch-upsert that resizes a template,
// independently of width/depth/height — assertValidExtensible only
// requires 0 < minM < the CURRENT max length, never that minM stayed the
// same as before. Both are exactly as placement-relevant as an outright
// dimension change: a tightened minM can leave an already-set crop below
// the new floor (assertCropWithinTemplateBounds rejects it the next time
// that instance is touched, per #338), and flooring changes meshDimensions'
// own live footprint (src/main.js) for every existing placed copy. Treated
// as its own "changed" reason, not folded into dimensionsDiffer, so the
// notification wording below can say which actually happened.
function extensibleMinMByAxis(metadata) {
  const extensible = metadata?.extensible;
  if (!extensible || typeof extensible !== 'object') return {};
  return Object.fromEntries(Object.entries(extensible).map(([axis, entry]) => [axis, entry?.minM]));
}

function placementRelevantMetadataChanged(oldMetadata, newMetadata) {
  const oldMinMByAxis = extensibleMinMByAxis(oldMetadata);
  const newMinMByAxis = extensibleMinMByAxis(newMetadata);
  const axes = new Set([...Object.keys(oldMinMByAxis), ...Object.keys(newMinMByAxis)]);
  for (const axis of axes) {
    if (oldMinMByAxis[axis] !== newMinMByAxis[axis]) return true;
  }
  return !!oldMetadata?.flooring !== !!newMetadata?.flooring;
}

// A seller changing a product's real-world size after it's already been
// placed somewhere leaves every existing instance still looking like the
// old size (createMeshForInstance never re-scales an already-placed
// mesh) — silently wrong until a builder happens to re-open that
// landlet. Rather than try to auto-fix placements the seller never
// touched, this just tells every builder who has one so they can decide
// what to do about it themselves.
async function notifyBuildersOfDimensionChange(db, template, oldDimensions, oldMetadata) {
  const { width, depth, height } = template.dimensions;
  const dimensionsChanged = dimensionsDiffer(template.dimensions, oldDimensions);
  if (!dimensionsChanged && !placementRelevantMetadataChanged(oldMetadata, template.metadata)) return;

  // #920: grouping (rather than SELECT DISTINCT) gets a real per-builder
  // count, so a builder with several placed copies of the resized template
  // (e.g. bought/placed the same decorative item more than once) sees an
  // accurate count instead of a hardcoded, always-singular "one placed".
  const { results } = await db.prepare(`
    SELECT l.owner_builder_id AS builderId, COUNT(*) AS instanceCount
    FROM placed_instances pi
    JOIN landlets l ON l.landlet_id = pi.landlet_id
    WHERE pi.template_id = ? AND l.owner_builder_id IS NOT NULL
    GROUP BY l.owner_builder_id
  `).bind(template.templateId).all();
  if (results.length === 0) return;

  const fmt = (m) => `${m.toFixed(2)}m`;
  const describeChange = dimensionsChanged
    ? `was resized by its seller to ${fmt(width)} x ${fmt(depth)} x ${fmt(height)}`
    : 'had its placement rules changed by its seller';
  await fireNotifications(db, results.map((row) => ({
    builderId: row.builderId,
    message: `"${template.name}" ${describeChange} — you have ${row.instanceCount} placed. Check that it still fits where you put it.`,
    templateId: template.templateId,
  })));
}

// #1220: list-endpoint version of the above, same "N queries -> one grouped
// query + one batched insert" idiom existingSellerIds/recomputeLandCapsBatch
// already use elsewhere in this file. PUT /api/catalog/batch's own resize
// loop used to call notifyBuildersOfDimensionChange once per resized
// template — up to 100 sequential SELECT+batch round trips for a full
// batch — instead of this single pair. `candidates` is every batch item
// that has a pre-existing row at all (a brand-new template via POST, or a
// PUT id with no matching row, was never a candidate); the actual
// "did its dimensions really change" filter (mirroring the singular
// function's own early-return) happens here, in-memory, so the grouped
// query below only ever asks about templates genuinely worth notifying on.
async function notifyBuildersOfDimensionChangeBatch(db, candidates) {
  const changed = candidates
    .map(({ template, oldDimensions, oldMetadata }) => ({
      template,
      dimensionsChanged: dimensionsDiffer(template.dimensions, oldDimensions),
      metadataChanged: placementRelevantMetadataChanged(oldMetadata, template.metadata),
    }))
    .filter(({ dimensionsChanged, metadataChanged }) => dimensionsChanged || metadataChanged);
  if (changed.length === 0) return;

  const templateIds = changed.map(({ template }) => template.templateId);
  const placeholders = templateIds.map(() => '?').join(', ');
  // #920's own grouping reasoning applies per template here too — grouped
  // by (template_id, builder_id) so a builder with several placed copies
  // of the same resized template still gets one accurate count, not a
  // hardcoded singular.
  const { results } = await db.prepare(`
    SELECT pi.template_id AS templateId, l.owner_builder_id AS builderId, COUNT(*) AS instanceCount
    FROM placed_instances pi
    JOIN landlets l ON l.landlet_id = pi.landlet_id
    WHERE pi.template_id IN (${placeholders}) AND l.owner_builder_id IS NOT NULL
    GROUP BY pi.template_id, l.owner_builder_id
  `).bind(...templateIds).all();
  if (results.length === 0) return;

  const changedById = new Map(changed.map((c) => [c.template.templateId, c]));
  const fmt = (m) => `${m.toFixed(2)}m`;
  await fireNotifications(db, results.map((row) => {
    const { template, dimensionsChanged } = changedById.get(row.templateId);
    const { width, depth, height } = template.dimensions;
    const describeChange = dimensionsChanged
      ? `was resized by its seller to ${fmt(width)} x ${fmt(depth)} x ${fmt(height)}`
      : 'had its placement rules changed by its seller';
    return {
      builderId: row.builderId,
      message: `"${template.name}" ${describeChange} — you have ${row.instanceCount} placed. Check that it still fits where you put it.`,
      templateId: row.templateId,
    };
  }));
}

async function assertUploadedModelExists(bucket, modelUrl) {
  if (!modelUrl?.startsWith('/uploads/')) return;
  if (!bucket) throw new HttpError('R2 binding MODELS is not configured', 500);
  let key;
  try {
    key = decodeURIComponent(modelUrl.slice('/uploads/'.length));
  } catch {
    throw new HttpError('modelUrl contains invalid upload path encoding', 400);
  }
  // #1064: bucket.head() alone only proves *some* object exists at this key
  // in the shared MODELS bucket -- thumbnails/<hash>.png and
  // concept-images/<hash>.png live in the same bucket under the same
  // /uploads/<key> URL scheme, so without this prefix check a template's
  // modelUrl could be set to an existing thumbnail/concept-image instead of
  // an actual uploaded model, bypassing handleModelUpload's own validateGlb
  // check entirely (that check only ever runs at upload time, never here).
  if (!key || !key.startsWith('models/') || !(await bucket.head(key))) {
    throw new HttpError('modelUrl does not reference an existing uploaded model', 400);
  }
}

// ---- Prompt-mode concept-image generation (#328, sub-issue of #323) —
// given a builder's free-text prompt, calls an external image-gen API to
// produce a concept image that a later step (#329's similarity search,
// already merged) embeds and matches against the catalog. Owner-confirmed
// provider (#328's own GitHub thread): OpenAI's gpt-image-1, picked over
// the cheaper Cloudflare Workers AI option because the owner's own stated
// priority is generation quality, not minimizing per-call cost. Same
// guarded-secret shape as RESEND_API_KEY/STRIPE_SECRET_KEY above — with
// env.OPENAI_API_KEY unset (never configured in local dev or the automated
// test suite), openaiConfigured(env) is false and the route handler below
// returns a real 503 rather than attempting a live network call, so this
// stays fully testable without a real OpenAI account.
function openaiConfigured(env) {
  return !!env.OPENAI_API_KEY;
}

// A real, non-trivial per-call cost (unlike every other rate-limited
// action in this file) — kept well below the general-purpose 20/15min
// shape used elsewhere so a runaway loop can't run up a real bill before
// this kicks in.
const CONCEPT_IMAGE_RATE_LIMIT_MAX = 10;

// gpt-image-1 only ever returns base64-encoded image bytes (b64_json) —
// unlike dall-e-2/3, it has no url response-format option — so there's no
// separate "download the generated image" round trip; the bytes are
// already in hand from this one call.
async function generateConceptImageBytes(env, prompt) {
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '1024x1024', n: 1 }),
  });
  // #2486: .catch(() => null), same as tripoRequest/tripoUploadFile -- an
  // upstream gateway error page (HTML, empty, or truncated) makes
  // response.json() itself throw before the !response.ok check below ever
  // runs, otherwise surfacing as an uncaught 500 instead of this function's
  // own intended 502.
  const data = await response.json().catch(() => null);
  // #1548: same response-shape validation fetchTax1099EfilingToken/transmitTax1099Form
  // already do for their own third-party JSON -- without it, a 200 response with an
  // unexpected shape throws an uncaught TypeError instead of a clean 502.
  if (!response.ok || !data?.data?.[0]?.b64_json) {
    console.error('OpenAI image generation failed', response.status, JSON.stringify(data));
    throw new HttpError('Concept-image generation failed — please try again', 502);
  }
  return Uint8Array.from(atob(data.data[0].b64_json), (character) => character.charCodeAt(0));
}

// See the PATCH/PUT handler's own comment below (issue #361) — only gates
// the unauthenticated (no owning seller) path, same shape as
// SIGN_POST_RATE_LIMIT_MAX/PURCHASE_RATE_LIMIT_MAX elsewhere in this file.
const CATALOG_PATCH_RATE_LIMIT_MAX = 20;

// Same unauthenticated-path gap as CATALOG_PATCH_RATE_LIMIT_MAX above, but
// for DELETE (#520) — unlike PATCH, DELETE has no bootstrapping-trap reason
// to stay ungated (nothing legitimate deletes the same unowned templates
// dozens of times over), so this can be a plain, low ceiling.
const CATALOG_DELETE_RATE_LIMIT_MAX = 20;

// #775: seller-owned, but writes a fresh R2 object per call (a slightly
// different canvas render hashes differently, defeating the content-
// addressed dedup below) with no other throttle — same per-seller shape as
// CONCEPT_IMAGE_RATE_LIMIT_MAX, not IP-keyed like the anonymous-path limits
// above since a real session always backs this call.
const THUMBNAIL_UPLOAD_RATE_LIMIT_MAX = 20;

// #2789: POST .../listings (attach a new listing to an existing shared
// product, #2747) is always session-seller-authenticated, unlike the
// sibling single-item create's deliberately-unlimited unauthenticated path
// (CATALOG_PATCH_RATE_LIMIT_MAX's own comment above) — so that rationale
// doesn't carry over here. Matches CATALOG_PATCH_RATE_LIMIT_MAX/
// CATALOG_DELETE_RATE_LIMIT_MAX's existing per-seller ceiling.
const CATALOG_LISTINGS_RATE_LIMIT_MAX = 20;

// Backlog audit: POST .../similarity-search (#329) is unauthenticated
// (deliberately — a read over already-public catalog data, see
// searchCatalogBySimilarity's own comment in src/api.js) AND does real,
// non-trivial per-call work: a full SELECT over every catalog_templates
// row with an embedding, a JSON.parse of each, and an O(rows × embedding
// length) cosine-similarity scan — unlike an ordinary indexed listing
// query. Every other unauthenticated endpoint in this file with a real
// per-call cost (catalog-delete/patch's anonymous path just above,
// sign-post, purchase, builder/seller create) is rate-limited by IP; this
// one wasn't, despite matching that exact shape. IP-keyed like those, not
// per-builder like concept-image (there's no session here to key on),
// with headroom for a legitimate Prompt-mode session to run this once per
// concept image it generates.
const SIMILARITY_SEARCH_RATE_LIMIT_MAX = 30;

// #362 flagged catalog template creation for the same missing-rate-limit
// gap as builders/sellers below, but unlike those two, an IP-keyed limit
// here isn't safe to add at any size a real automated flood would
// actually need to trip on: unauthenticated catalog creation (no
// sellerId) is this app's own primary way of seeding ordinary
// system/placeholder products, used dozens of times over in normal
// operation (this file's own test suite alone makes 50+ such calls
// across unrelated setup helpers, all sharing one IP when run without a
// synthetic header) — the same "bootstrapping trap" shape of problem
// documented on Land cap below for why a hard block there got reverted.
// Length-capping name/category/subcategory/color (see labelValue below)
// still lands here; only the rate limit is deliberately left out.
export async function handleCatalog(request, db, route, url, models, env) {
  if (request.method === 'DELETE' && route.length === 2 && route[1] === 'batch') {
    const input = await readJson(request);
    if (!Array.isArray(input.templateIds)) throw new HttpError('templateIds must be an array', 400);
    if (input.templateIds.length === 0) throw new HttpError('templateIds must contain at least one item', 400);
    if (input.templateIds.length > 100) throw new HttpError('templateIds must contain at most 100 items', 400);
    const templateIds = input.templateIds.map((id) => stringValue(id, 'templateIds item'));
    if (new Set(templateIds).size !== templateIds.length) throw new HttpError('templateIds must be unique', 400);
    const placeholders = templateIds.map(() => '?').join(', ');
    const existing = await db.prepare(`
      SELECT template_id, seller_id FROM catalog_templates WHERE template_id IN (${placeholders})
    `).bind(...templateIds).all();
    if (existing.results.length !== templateIds.length) {
      throw new HttpError('Every templateId must reference an existing catalog template', 404);
    }
    // See sellerExists' own comment (below): a dangling seller_id (its
    // seller self-deleted) counts as unowned, same as this endpoint's
    // single-item sibling — otherwise a template a self-deleted seller once
    // owned becomes permanently un-deletable via this batch route, since no
    // live session's seller_id can ever match one that no longer exists.
    const candidateSellerIds = existing.results.map((row) => row.seller_id).filter(Boolean);
    const ownerSellerIds = await existingSellerIds(db, candidateSellerIds);
    if (ownerSellerIds.size > 0) {
      const sessionSeller = await requireSessionSeller(request, db);
      for (const sellerId of ownerSellerIds) assertOwner(sellerId, sessionSeller.seller_id, 'Not your catalog template');
      // #1457: the session requirement alone doesn't bound this, same
      // reasoning as the single-item DELETE sibling's own #1455 fix — up to
      // 100 owned templateIds can be wiped per call, with no throttle on
      // how often this authenticated owner can repeat the call.
      await checkRateLimit(db, `catalog-delete:${sessionSeller.seller_id}`, CATALOG_DELETE_RATE_LIMIT_MAX);
    }
    // At least one template in this batch has no live owning seller to gate
    // it behind a session (same shape as the single-item DELETE below) —
    // rate-limit the request itself so up to 100 such templates can't be
    // wiped in one unauthenticated, unthrottled call (#520).
    const hasUnownedTemplate = existing.results.some((row) => !row.seller_id || !ownerSellerIds.has(row.seller_id));
    if (hasUnownedTemplate) {
      await checkRateLimit(db, `catalog-delete:${clientIp(request)}`, CATALOG_DELETE_RATE_LIMIT_MAX);
    }
    await assertCatalogTemplatesDeletable(db, templateIds);
    await db.batch(templateIds.map((templateId) => db.prepare(
      'DELETE FROM catalog_templates WHERE template_id = ?',
    ).bind(templateId)));
    return json({ deletedTemplateIds: templateIds });
  }

  if ((request.method === 'POST' || request.method === 'PUT') && route.length === 2 && route[1] === 'batch') {
    const input = await readJson(request);
    if (!Array.isArray(input.templates)) throw new HttpError('templates must be an array', 400);
    if (input.templates.length === 0) throw new HttpError('templates must contain at least one item', 400);
    if (input.templates.length > 100) throw new HttpError('templates must contain at most 100 items', 400);
    const templates = input.templates.map((template) => validateTemplate(template, crypto.randomUUID()));
    const ids = new Set();
    for (const template of templates) {
      if (ids.has(template.templateId)) throw new HttpError('templateId values must be unique', 400);
      ids.add(template.templateId);
    }
    const sellerIds = templates.map((template) => template.sellerId).filter((id) => id);
    if (sellerIds.length > 0) await assertReferencesExist(db, 'sellers', 'seller_id', sellerIds, 'sellerId');
    const existingOwnerRows = await db.prepare(`
      SELECT template_id, seller_id, width_m, depth_m, height_m, metadata_json FROM catalog_templates WHERE template_id IN (${[...ids].map(() => '?').join(', ')})
    `).bind(...ids).all();
    // sellerIds (the templates' own requested sellerId values) already went
    // through assertReferencesExist above, so they're live by construction.
    // existingOwnerRows.results' seller_id is a pre-existing row's own
    // owner, which (see sellerExists' comment below) can be dangling if
    // that seller has since self-deleted — treat that the same as a null
    // seller_id (unowned), not as still-owned-forever, the same fix as the
    // batch DELETE handler above.
    const sellerIdsToCheck = new Set(sellerIds);
    const danglingCandidates = existingOwnerRows.results.map((row) => row.seller_id).filter(Boolean);
    for (const sellerId of await existingSellerIds(db, danglingCandidates)) sellerIdsToCheck.add(sellerId);
    let sessionSeller = null;
    if (sellerIdsToCheck.size > 0) {
      sessionSeller = await requireSessionSeller(request, db);
      for (const sellerId of sellerIdsToCheck) assertOwner(sellerId, sessionSeller.seller_id, 'Not your catalog template');
    }
    // #1416: PUT fires the identical notifyBuildersOfDimensionChange
    // fan-out its single-item sibling (the PATCH/PUT handler above) is
    // rate-limited to protect, "regardless of the session gate" per
    // #1329 -- but this batch endpoint never carried that guard over,
    // authenticated or not. Scoped to PUT only, same as the single-item
    // sibling: plain POST creation has no notification fan-out and is
    // deliberately left unthrottled (see this function's own top
    // comment on why an IP-keyed limit there would trip on ordinary
    // system/placeholder-template seeding).
    if (request.method === 'PUT') {
      await checkRateLimit(db, sessionSeller ? `catalog-patch:${sessionSeller.seller_id}` : `catalog-patch:${clientIp(request)}`, CATALOG_PATCH_RATE_LIMIT_MAX);
    }
    // #2075: moved below the rate-limit check above (and the ownership/
    // session resolution it depends on) -- this Promise.all is up to 100
    // real R2 bucket.head() calls, the one genuinely expensive step in this
    // handler, and used to run before checkRateLimit ever got a chance to
    // reject the request, so a caller already over the limit still paid
    // the full R2 cost on every rejected call. The single-item PUT/PATCH
    // sibling (worker/index.js's own handler for /catalog/:templateId)
    // already rate-limits before its own assertUploadedModelExists call;
    // this brings the batch endpoint in line with that ordering.
    await Promise.all(templates.map((template) => assertUploadedModelExists(models, template.modelUrl)));
    const conflictClause = request.method === 'PUT' ? `
      ON CONFLICT(template_id) DO UPDATE SET
        name = excluded.name, category = excluded.category, subcategory = excluded.subcategory,
        color = excluded.color, width_m = excluded.width_m, depth_m = excluded.depth_m,
        height_m = excluded.height_m, price_cents = excluded.price_cents,
        seller_id = excluded.seller_id, model_url = excluded.model_url,
        model_size_bytes = excluded.model_size_bytes,
        skeleton_signature = excluded.skeleton_signature,
        metadata_json = excluded.metadata_json,
        stock_quantity = excluded.stock_quantity,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ` : '';
    // #934: unlike the single-item PUT/PATCH sibling above (which forces
    // sellerId back to the existing row's own value on every update,
    // specifically because "reassigning a template's seller isn't a
    // feature this endpoint supports"), this upsert let the caller-supplied
    // sellerId win via `seller_id = excluded.seller_id` -- including for a
    // pre-existing row whose seller_id was null or dangling, letting any
    // seller silently claim ownership of an unowned/orphaned template by
    // just resubmitting it with their own sellerId.
    const existingSellerIdById = new Map(existingOwnerRows.results.map((row) => [row.template_id, row.seller_id]));
    // #2242: the single-item POST /api/catalog sibling's own #1601 check
    // ("priceCents is required" on a genuinely new seller-owned listing --
    // a free digital product is an explicit $0, not an omitted field)
    // never got carried over here, so this batch path let a seller create
    // a for-sale template with a null price. Scoped the same way as that
    // sibling: only a template with no pre-existing row (a real create,
    // not an update -- the PATCH/PUT path intentionally still allows
    // clearing a price back to null) and a sellerId present.
    for (const template of templates) {
      if (!existingSellerIdById.has(template.templateId) && template.sellerId && template.priceCents == null) {
        throw new HttpError('priceCents is required', 400);
      }
    }
    await db.batch(templates.map((template) => db.prepare(`
      INSERT INTO catalog_templates
        (template_id, name, category, subcategory, color, width_m, depth_m, height_m, price_cents, seller_id, model_url, model_size_bytes, skeleton_signature, metadata_json, stock_quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ${conflictClause}
    `).bind(...templateParams(existingSellerIdById.has(template.templateId)
      ? { ...template, sellerId: existingSellerIdById.get(template.templateId) }
      : template))));
    // The single-item PATCH/PUT sibling above always calls
    // notifyBuildersOfDimensionChange on a dimension change — this batch
    // upsert performs the identical column update per template but was
    // missing the same call, so a seller resizing several products at once
    // through this endpoint silently never warned any builder hosting a
    // placed instance of them. existingOwnerRows (fetched before the
    // INSERT/upsert above) already holds every batch templateId's
    // pre-existing row, if any — a POST id with no matching row here is a
    // genuinely new template, not a resize, so nothing to notify about.
    if (request.method === 'PUT') {
      const oldDimensionsById = new Map(existingOwnerRows.results.map((row) =>
        [row.template_id, { width: row.width_m, depth: row.depth_m, height: row.height_m }]));
      const oldMetadataById = new Map(existingOwnerRows.results.map((row) =>
        [row.template_id, JSON.parse(row.metadata_json || '{}')]));
      const dimensionChangeCandidates = templates
        .map((template) => ({ template, oldDimensions: oldDimensionsById.get(template.templateId), oldMetadata: oldMetadataById.get(template.templateId) }))
        .filter(({ oldDimensions }) => oldDimensions);
      await notifyBuildersOfDimensionChangeBatch(db, dimensionChangeCandidates);
    }
    const placeholders = templates.map(() => '?').join(', ');
    const stored = await db.prepare(`
      SELECT * FROM catalog_templates WHERE template_id IN (${placeholders})
    `).bind(...ids).all();
    const byId = new Map(stored.results.map((row) => [row.template_id, templateFromRow(row)]));
    return json({ templates: templates.map((template) => byId.get(template.templateId)) }, request.method === 'POST' ? 201 : 200);
  }

  // #329: given an embedding (the same shape POST .../thumbnail stores),
  // ranks every
  // template that has one by cosine similarity and returns the closest
  // matches. No Vectorize/vector-search binding exists in this project
  // (confirmed via wrangler.jsonc — #327's own comment thread already
  // found this), so this is a plain in-memory scan over D1 rows, not an
  // indexed nearest-neighbor query — fine at this catalog's current size,
  // matching this codebase's own "get the mechanic working, model the
  // real thing later" pattern; a real vector index is a swap-in later,
  // not something this endpoint's callers need to know about.
  if (request.method === 'POST' && route.length === 2 && route[1] === 'similarity-search') {
    await checkRateLimit(db, `similarity-search:${clientIp(request)}`, SIMILARITY_SEARCH_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const embedding = validateThumbnailEmbedding(input.embedding);
    if (!embedding) throw new HttpError('embedding is required', 400);
    // A JSON-body integer, not a query-string one, so this doesn't reuse
    // queryLimit (which validates a raw url.searchParams string and always
    // caps at 100) — a much smaller max fits a from-scratch full-scan
    // search better than the ordinary paginated-listing endpoints' cap.
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new HttpError('limit must be an integer between 1 and 50', 400);
    }
    const { results } = await db.prepare(`
      SELECT * FROM catalog_templates WHERE image_embedding IS NOT NULL
    `).all();
    const ranked = results
      .map((row) => ({ template: templateFromRow(row), candidateEmbedding: JSON.parse(row.image_embedding) }))
      // A future embedding-model swap can produce a different vector
      // length than what's already stored — comparing across lengths is
      // meaningless, so those rows are silently excluded rather than
      // erroring the whole search over a handful of stale entries.
      .filter(({ candidateEmbedding }) => candidateEmbedding.length === embedding.length)
      .map(({ template, candidateEmbedding }) => ({ template, similarity: cosineSimilarity(embedding, candidateEmbedding) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
    return json({ templates: ranked.map((r) => ({ ...r.template, similarity: r.similarity })) });
  }

  // #328: given a builder's free-text prompt, generates a concept image via
  // OpenAI (see generateConceptImageBytes' own comment for the provider
  // choice) and stores it content-addressed the same way POST .../thumbnail
  // does — a fixed key would fight the immutable cache-control header on
  // GET /uploads/:key once a second prompt happens to produce identical
  // bytes (astronomically unlikely for a generative model, but the
  // dedup is free either way). This endpoint only ever turns a prompt into
  // a stored image URL — embedding the result and running it through
  // similarity-search (#329) and placing a chosen candidate (#330) are the
  // frontend's own job (src/main.js's Prompt mode tab), both shipped.
  if (request.method === 'POST' && route.length === 2 && route[1] === 'concept-image') {
    // Session-gated (not anonymous, unlike similarity-search's read-only
    // query above) and rate-limited per builder — unlike everything else
    // in this file that calls an external API, this is a real, non-trivial
    // per-call cost, so an unthrottled or anonymous caller could run up a
    // real bill.
    const sessionBuilder = await requireSessionBuilder(request, db);
    const input = await readJson(request);
    const prompt = stringValue(input.prompt, 'prompt');
    if (prompt.length > 2000) throw new HttpError('prompt must be 2000 characters or fewer', 400);
    await checkRateLimit(db, `concept-image:${sessionBuilder.builder_id}`, CONCEPT_IMAGE_RATE_LIMIT_MAX);
    if (!openaiConfigured(env)) {
      throw new HttpError('Concept-image generation is not configured on this server yet.', 503);
    }
    const bytes = await generateConceptImageBytes(env, prompt);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const key = `concept-images/${hash}.png`;
    if (!(await models.head(key))) {
      // #602: this writes into the same MODELS bucket handleModelUpload's
      // own MAX_TOTAL_STORAGE_BYTES cap protects, so it needs the same
      // reservation dance — just after generation rather than before it,
      // since (unlike a multipart upload) the byte size isn't known until
      // the image actually exists. See reserveStorageBudget's own comment.
      const usage = await getStorageUsage(models);
      const reservationId = await reserveStorageBudget(db, usage, bytes.byteLength, 'Concept image');
      try {
        await models.put(key, bytes, { httpMetadata: { contentType: 'image/png' } });
      } finally {
        await db.prepare('DELETE FROM model_upload_reservations WHERE reservation_id = ?').bind(reservationId).run();
      }
    }
    return json({ imageUrl: `/uploads/${key}` }, 201);
  }

  if (request.method === 'GET' && route.length === 1) {
    const categoryParam = url.searchParams.get('category');
    const category = categoryParam === null ? null : stringValue(categoryParam, 'category');
    const subcategoryParam = url.searchParams.get('subcategory');
    const subcategory = subcategoryParam === null ? null : stringValue(subcategoryParam, 'subcategory');
    const sellerIdParam = url.searchParams.get('sellerId');
    const sellerId = sellerIdParam === null ? null : stringValue(sellerIdParam, 'sellerId');
    const colorParam = url.searchParams.get('color');
    const color = colorParam === null ? null : stringValue(colorParam, 'color');
    const minPriceCents = queryNonnegativeInteger(url.searchParams.get('minPriceCents'), 'minPriceCents');
    const maxPriceCents = queryNonnegativeInteger(url.searchParams.get('maxPriceCents'), 'maxPriceCents');
    if (minPriceCents !== null && maxPriceCents !== null && minPriceCents > maxPriceCents) {
      throw new HttpError('minPriceCents cannot exceed maxPriceCents', 400);
    }
    const minWidthM = queryPositiveNumber(url.searchParams.get('minWidthM'), 'minWidthM');
    const maxWidthM = queryPositiveNumber(url.searchParams.get('maxWidthM'), 'maxWidthM');
    const minDepthM = queryPositiveNumber(url.searchParams.get('minDepthM'), 'minDepthM');
    const maxDepthM = queryPositiveNumber(url.searchParams.get('maxDepthM'), 'maxDepthM');
    const minHeightM = queryPositiveNumber(url.searchParams.get('minHeightM'), 'minHeightM');
    const maxHeightM = queryPositiveNumber(url.searchParams.get('maxHeightM'), 'maxHeightM');
    for (const [minimum, maximum, minimumField, maximumField] of [
      [minWidthM, maxWidthM, 'minWidthM', 'maxWidthM'],
      [minDepthM, maxDepthM, 'minDepthM', 'maxDepthM'],
      [minHeightM, maxHeightM, 'minHeightM', 'maxHeightM'],
    ]) {
      if (minimum !== null && maximum !== null && minimum > maximum) {
        throw new HttpError(`${minimumField} cannot exceed ${maximumField}`, 400);
      }
    }
    const queryParam = url.searchParams.get('q');
    const query = queryParam === null ? null : stringValue(queryParam, 'q');
    if (query && query.length > 100) throw new HttpError('q must be at most 100 characters', 400);
    const sort = url.searchParams.get('sort') || 'name';
    if (!['name', 'price-asc', 'price-desc'].includes(sort)) {
      throw new HttpError('sort must be name, price-asc, or price-desc', 400);
    }
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = sort === 'name'
      ? decodeCatalogCursor(url.searchParams.get('cursor'))
      : decodeCatalogPriceCursor(url.searchParams.get('cursor'));
    const conditions = [];
    const bindings = [];
    // #2006: COLLATE NOCASE on category/subcategory/color -- matching the
    // name/q filter's own established reasoning a few lines below (free-
    // text/seller-supplied, no enforced casing convention at the schema
    // level). sellerId stays plain case-sensitive, deliberately excluded:
    // it's a machine-generated opaque id (crypto.randomUUID(), always
    // lowercase hex), not user-typed free text.
    if (category) {
      conditions.push('category = ? COLLATE NOCASE');
      bindings.push(category);
    }
    if (subcategory) {
      conditions.push('subcategory = ? COLLATE NOCASE');
      bindings.push(subcategory);
    }
    if (sellerId) {
      conditions.push('seller_id = ?');
      bindings.push(sellerId);
    }
    if (color) {
      conditions.push('color = ? COLLATE NOCASE');
      bindings.push(color);
    }
    if (minPriceCents !== null) {
      conditions.push('price_cents >= ?');
      bindings.push(minPriceCents);
    }
    if (maxPriceCents !== null) {
      conditions.push('price_cents <= ?');
      bindings.push(maxPriceCents);
    }
    if (minWidthM !== null) {
      conditions.push('width_m >= ?');
      bindings.push(minWidthM);
    }
    if (maxWidthM !== null) {
      conditions.push('width_m <= ?');
      bindings.push(maxWidthM);
    }
    if (minDepthM !== null) {
      conditions.push('depth_m >= ?');
      bindings.push(minDepthM);
    }
    if (maxDepthM !== null) {
      conditions.push('depth_m <= ?');
      bindings.push(maxDepthM);
    }
    if (minHeightM !== null) {
      conditions.push('height_m >= ?');
      bindings.push(minHeightM);
    }
    if (maxHeightM !== null) {
      conditions.push('height_m <= ?');
      bindings.push(maxHeightM);
    }
    if (query) {
      conditions.push("name LIKE ? ESCAPE '\\' COLLATE NOCASE");
      bindings.push(`%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
    }
    if (sort !== 'name') conditions.push('price_cents IS NOT NULL');
    // #1946: is_test_model deliberately does NOT filter this list -- see
    // that migration's own comment. This is the one endpoint Build mode's
    // own "Add Item" picker (buildCatalogPickerButtons/fetchCatalog) uses
    // for every ordinary builder, not just the owner's own account, and
    // there's no separate real shopper-facing marketplace browse surface
    // to filter instead (confirmed: Shop mode walks placed_instances, it
    // never lists catalog_templates directly). Hiding here was tried and
    // reverted after CI caught it breaking ordinary (non-admin) Build-mode
    // placement of every pre-existing system/feature template (community
    // signs, calendar events, flooring, basic furniture) that got
    // backfilled to is_test_model the same as everything else -- those
    // were never "real for-sale products" to begin with (no price, no
    // real seller), so losing Build-mode access to them is a functional
    // regression, not the intended effect. See handleInstancePurchase's
    // own guard below for what is_test_model actually gates today.
    if (cursor && sort === 'name') {
      // #1015: COLLATE NOCASE on both comparisons, matching the ORDER BY
      // below and migrations/0092's own idx_catalog_templates_name_nocase
      // index -- an inconsistent collation here would silently reorder or
      // skip rows relative to what the client's previous page actually
      // ended on.
      conditions.push('(name > ? COLLATE NOCASE OR (name = ? COLLATE NOCASE AND template_id > ?))');
      bindings.push(cursor.name, cursor.name, cursor.templateId);
    } else if (cursor) {
      const comparison = sort === 'price-asc' ? '>' : '<';
      conditions.push(`(price_cents ${comparison} ? OR (price_cents = ? AND template_id > ?))`);
      bindings.push(cursor.priceCents, cursor.priceCents, cursor.templateId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    // #1015: catalog_templates.name is free-text/seller-supplied, so
    // sorting case-insensitively keeps the default browse order actually
    // alphabetical -- matching the case-insensitive `q` search on this
    // same column, and the client-side Sell-mode list's own localeCompare.
    const order = sort === 'name'
      ? 'name COLLATE NOCASE, template_id'
      : `price_cents ${sort === 'price-asc' ? 'ASC' : 'DESC'}, template_id`;
    const { results } = await db.prepare(`
      SELECT * FROM catalog_templates ${where}
      ORDER BY ${order} LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      templates: page.map(templateFromRow),
      nextCursor: hasMore
        ? (sort === 'name'
          ? encodeCatalogCursor(last.name, last.template_id)
          : encodeCatalogPriceCursor(last.price_cents, last.template_id))
        : null,
    });
  }

  if (request.method === 'GET' && route.length === 2) {
    const row = await db.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(route[1]).first();
    // #1946: no admin-only visibility here either, same reasoning as the
    // list endpoint above.
    return row ? json({ template: templateFromRow(row) }) : json({ error: 'Catalog template not found' }, 404);
  }

  // #327: stores the flat thumbnail the client rendered from this
  // template's own 3D model (renderCatalogThumbnailNow, src/main.js) plus
  // a cheap client-computed embedding for it — see migrations/0071's own
  // comment for why these two fields live outside the ordinary
  // validateTemplate/templateParams path every other field goes through.
  // Content-addressed the same way handleModelUpload's .glb uploads are
  // (a hash of the bytes as the R2 key), not `thumbnails/<templateId>.png`
  // — GET /uploads/:key below serves every object with a permanent,
  // immutable cache-control header, so a fixed per-template key would mean
  // a regenerated thumbnail (a reasonable one-time seller edit, not
  // something anyone here is trying to prevent) could never actually
  // reach anyone who'd already cached the old image under that same URL.
  if (request.method === 'POST' && route.length === 3 && route[2] === 'thumbnail') {
    const existing = await db.prepare('SELECT seller_id FROM catalog_templates WHERE template_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Catalog template not found' }, 404);
    // Unlike PATCH's permissive fallback for an unowned/orphaned template
    // (see that handler's own comment below), this writes new bytes to R2
    // storage — an anonymous write path there is a real abuse surface an
    // unauthenticated metadata edit isn't — so a genuine owning seller is
    // required outright rather than falling open.
    if (!existing.seller_id || !(await sellerExists(db, existing.seller_id))) {
      throw new HttpError('This catalog template has no owning seller to authorize a thumbnail upload', 403);
    }
    const sessionSeller = await requireSessionSeller(request, db);
    assertOwner(existing.seller_id, sessionSeller.seller_id, 'Not your catalog template');
    // #775: this writes into the same MODELS bucket handleModelUpload's own
    // MAX_TOTAL_STORAGE_BYTES cap protects, and a re-rendered thumbnail
    // hashes differently each time (defeating the dedup below), so it needs
    // the same rate limit + reservation dance those paths use.
    await checkRateLimit(db, `catalog-thumbnail:${sessionSeller.seller_id}`, THUMBNAIL_UPLOAD_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const bytes = decodeThumbnailDataUrl(input.imageDataUrl);
    const embedding = validateThumbnailEmbedding(input.embedding);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const key = `thumbnails/${hash}.png`;
    if (!(await models.head(key))) {
      const usage = await getStorageUsage(models);
      const reservationId = await reserveStorageBudget(db, usage, bytes.byteLength, 'Thumbnail');
      try {
        await models.put(key, bytes, { httpMetadata: { contentType: 'image/png' } });
      } finally {
        await db.prepare('DELETE FROM model_upload_reservations WHERE reservation_id = ?').bind(reservationId).run();
      }
    }
    const imageUrl = `/uploads/${key}`;
    const result = await db.prepare(`
      UPDATE catalog_templates SET image_url = ?, image_embedding = ? WHERE template_id = ?
    `).bind(imageUrl, embedding ? JSON.stringify(embedding) : null, route[1]).run();
    // #936: same gap #932 fixed on this resource's PATCH/PUT sibling -- a
    // concurrent DELETE of this template landing after the ownership check
    // above (and the R2 upload, which takes real wall-clock time) left this
    // UPDATE matching 0 rows while the handler still returned a fabricated
    // 200, with the freshly-uploaded R2 object now orphaned.
    if (result.meta.changes === 0) return json({ error: 'Catalog template not found' }, 404);
    return json({ imageUrl });
  }

  // #362/#381: unlike the PATCH/DELETE siblings below (which do
  // checkRateLimit on their unauthenticated/unowned-template path),
  // creation here is deliberately NOT rate-limited. Unauthenticated
  // catalog creation is this app's own primary way of seeding system/
  // placeholder products, and is used 50+ times across this file's own
  // test-suite setup helpers alone -- an IP-keyed rate limit here breaks
  // the suite wholesale unless every one of those call sites gets its
  // own synthetic IP (see #381, closed unmerged after discovering exactly
  // this). The chosen fix for #362 instead length-caps name/color via
  // labelValue (see validateTemplate below) and keeps the rate limit only
  // on builders/sellers creation (BUILDER_CREATE_RATE_LIMIT_MAX/
  // SELLER_CREATE_RATE_LIMIT_MAX below), which have no such fixture-
  // seeding use.
  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    // #1728: a lost response (network drop after the INSERT below already
    // landed) looks, client-side, identical to the request never having
    // reached us, and invites an innocent retry of what the real upload
    // wizard considers the same submit -- previously minted a fresh
    // crypto.randomUUID() every time, so that retry silently created a
    // second, fully duplicate listing. See catalogTemplateIdempotencyKey
    // just below for why this is hashed rather than used verbatim.
    const idempotencyKey = await catalogTemplateIdempotencyKey(input.sellerId, input.modelUrl, input.idempotencyKey);
    const template = validateTemplate(input, idempotencyKey || crypto.randomUUID());
    // #1758: unlike purchases/sign-posts (pinned to a fixed instance), the
    // real upload wizard reads name/price fresh off still-editable inputs
    // on every submit and never clears this key on failure -- a seller
    // who edits the name/price and resubmits after a lost response would
    // otherwise get the STALE row back as a fabricated success, silently
    // dropping their edit. Only honor the dedup hit when the content
    // actually matches; on a mismatch this is a genuinely new attempt, so
    // mint a fresh id rather than reusing the idempotency-derived one,
    // which the stale row already occupies.
    const existing = idempotencyKey
      ? await db.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(template.templateId).first()
      : null;
    if (existing) {
      if (templateContentMatches(existing, template)) return json({ template: templateFromRow(existing) });
      template.templateId = `template-${crypto.randomUUID()}`;
    }
    if (template.sellerId) {
      await assertReferenceExists(db, 'sellers', 'seller_id', template.sellerId, 'sellerId');
      const sessionSeller = await requireSessionSeller(request, db);
      assertOwner(template.sellerId, sessionSeller.seller_id, 'Not your seller profile');
      // #1601: the owner wants price required on a real seller listing (a
      // free digital product is an explicit $0, not an omitted field) --
      // scoped to sellerId's presence (a real listing) and to this create
      // path specifically, not validateTemplate itself, since the PATCH/PUT
      // sibling below intentionally still allows clearing a price back to
      // null via the "Edit Price" panel. System/placeholder templates (no
      // sellerId, this file's own primary test/seed-fixture shape) are
      // unaffected.
      if (template.priceCents == null) {
        throw new HttpError('priceCents is required', 400);
      }
    }
    await assertUploadedModelExists(models, template.modelUrl);
    await db.prepare(`
      INSERT INTO catalog_templates
        (template_id, name, category, subcategory, color, width_m, depth_m, height_m, price_cents, seller_id, model_url, model_size_bytes, skeleton_signature, metadata_json, stock_quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(...templateParams(template)).run();
    // #976: re-select and map through templateFromRow rather than handing
    // back the locally-constructed `template` object -- validateTemplate's
    // own return literal never carries imageUrl/imageEmbedding/createdAt/
    // updatedAt, unlike every sibling create/update handler in this file
    // (and this resource's own POST/PUT batch sibling just below).
    const stored = await db.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(template.templateId).first();
    // #2487: same concurrent-delete race #2364 already guards against on
    // this resource's own PATCH/PUT sibling below -- a predictable,
    // client-derivable id (catalogTemplateIdempotencyKey) means a DELETE for
    // this exact id can land in the gap between the INSERT above and this
    // re-SELECT.
    if (!stored) return json({ error: 'Catalog template not found' }, 404);
    return json({ template: templateFromRow(stored) }, 201);
  }

  // #2747 (sub-issue of #2745's shared-products redesign): lets a seller
  // attach their own listing (price, stock) to a product someone else
  // originally uploaded, instead of going through the model-upload-
  // required single-item POST above. Reuses the exact same seller-
  // identity/auth bar (requireSessionSeller) every other catalog mutation
  // already uses -- always required here, unlike that sibling's
  // unauthenticated system/placeholder-template branch, since attaching a
  // listing to someone else's product is never a system/seed action.
  // Denormalizes every shared field from the referenced `products` row
  // into the new catalog_templates row at creation time -- the same
  // direction #2746's own backfill migration copied them, just forward
  // instead of backfilling the past -- so every existing reader of
  // catalog_templates (templateFromRow, browse/picker, admin dashboard,
  // purchase-creation, etc.) keeps working unchanged for a cross-seller
  // listing too, with no JOIN against `products` needed anywhere yet.
  if (request.method === 'POST' && route.length === 2 && route[1] === 'listings') {
    const sessionSeller = await requireSessionSeller(request, db);
    await checkRateLimit(db, `catalog-listings:${sessionSeller.seller_id}`, CATALOG_LISTINGS_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const productId = stringValue(input.productId, 'productId');
    // Same #1601 requirement the sibling single-item create enforces for
    // any real seller listing -- a free digital product is an explicit
    // $0, not an omitted field.
    const priceCents = optionalInteger(input.priceCents, 'priceCents');
    if (priceCents == null) throw new HttpError('priceCents is required', 400);
    const stockQuantity = optionalStockQuantity(input.stockQuantity);
    const product = await db.prepare('SELECT * FROM products WHERE product_id = ?').bind(productId).first();
    if (!product) throw new HttpError('productId must reference an existing product', 404);
    // Same guard/message purchase-creation.js's own handleInstancePurchase
    // already uses for a *listing's* flagged_hidden_at -- here it's the
    // shared product-level moderation state instead, blocking a brand new
    // listing from attaching to a product an admin has already hidden,
    // rather than letting one quietly reappear through a fresh listing.
    if (product.flagged_hidden_at) {
      throw new HttpError('This product is temporarily unavailable pending review', 400);
    }
    const templateId = `template-${crypto.randomUUID()}`;
    await db.prepare(`
      INSERT INTO catalog_templates
        (template_id, name, category, subcategory, color, width_m, depth_m, height_m,
         price_cents, seller_id, model_url, model_size_bytes, skeleton_signature,
         image_url, image_embedding, is_test_model, metadata_json, stock_quantity, product_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      templateId, product.name, product.category, product.subcategory, product.color,
      product.width_m, product.depth_m, product.height_m,
      priceCents, sessionSeller.seller_id, product.model_url, product.model_size_bytes, product.skeleton_signature,
      product.image_url, product.image_embedding, product.is_test_model, product.metadata_json, stockQuantity, productId,
    ).run();
    const stored = await db.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(templateId).first();
    return json({ template: templateFromRow(stored) }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Catalog template not found' }, 404);
    if (existing.seller_id && await sellerExists(db, existing.seller_id)) {
      const sessionSeller = await requireSessionSeller(request, db);
      assertOwner(existing.seller_id, sessionSeller.seller_id, 'Not your catalog template');
      // #1329: the session requirement alone doesn't bound this -- it has
      // the same notifyBuildersOfDimensionChange fan-out as the
      // unauthenticated branch below, and every other authenticated
      // mutation-with-fan-out in this file (friendship/bundle mutate,
      // calendar-event delete, notification mutate, auction bids, and (as
      // of #1455) this same resource's own DELETE sibling) rate-limits
      // itself regardless of the session gate. (#990/#991, despite the
      // similar name, fixed product_reviews' own nested DELETE, a
      // different handler -- not this resource's own DELETE, which #1455
      // found still lacked this until then.)
      await checkRateLimit(db, `catalog-patch:${sessionSeller.seller_id}`, CATALOG_PATCH_RATE_LIMIT_MAX);
    } else {
      // No owning seller to gate this PATCH behind a session (a system/
      // placeholder template, or one whose seller has since deleted their
      // account — see the sellerExists comment on the DELETE handler below),
      // so anyone can hit this unauthenticated. Its side effect —
      // notifyBuildersOfDimensionChange, below — fires a real notification
      // to every builder hosting this template, so cap the request rate the
      // same way handleSignPosts/handleInstancePurchase already do for their
      // own unauthenticated-write endpoints.
      await checkRateLimit(db, `catalog-patch:${clientIp(request)}`, CATALOG_PATCH_RATE_LIMIT_MAX);
    }
    const input = await readJson(request);
    // sellerId is forced back to its existing value (it wins the spread since
    // it's listed last) — reassigning a template's seller isn't a feature
    // this endpoint supports, same as landlets never letting PUT change
    // ownerBuilderId. Because of that, there's no fresh sellerId here to
    // validate — it's always exactly whatever the row already had, dangling
    // or not, so re-running assertReferenceExists on every update would
    // just re-validate unchanged data and (per the sellerExists comment
    // above) permanently block updates on a template whose seller has
    // since deleted their account, contradicting docs/API.md's "same as
    // null seller_id" promise for that case.
    const template = validateTemplate({ ...templateFromRow(existing), ...input, templateId: route[1], sellerId: existing.seller_id }, route[1]);
    await assertUploadedModelExists(models, template.modelUrl);
    // #1742: same lost-update race #468 already fixed for bundles -- two
    // concurrent partial PATCHes to *different* fields (a price change and
    // a separate dimension resize, say) each merged their write from this
    // same stale pre-race `existing` snapshot above, so whichever UPDATE
    // landed second silently reverted the field the first request changed,
    // even though its own input never touched that field. `template` above
    // is still the full merged-and-validated object (dimensions/metadata
    // invariants need the complete picture to check), but the actual
    // columns written below are now gated on whether `input` itself
    // provided each one, resolved atomically against the live row via
    // COALESCE/CASE at the SQL level instead of the stale JS merge.
    // `category`/`color`/dimensions are never legitimately null once
    // provided (labelValue/positiveNumber reject it), so a plain COALESCE
    // sentinel is unambiguous there; `subcategory`/`priceCents`/`modelUrl`/
    // `modelSizeBytes`/`skeletonSignature`/`metadata` can legitimately be
    // set to null/cleared (metadata down to `{}`), so those use an explicit
    // presence flag instead of COALESCE -- a bare null/empty sentinel would
    // be indistinguishable from "omitted" and silently fail to clear them.
    // `dimensions` is provided (or not) as one atomic group, same as
    // validateTemplate's own all-or-nothing handling of it. `seller_id` is
    // intentionally excluded (see this handler's own seller_id comment
    // above) and keeps being written unconditionally -- it's never read
    // from `input` at all (always pinned back to `existing.seller_id`), so
    // there's no separate request-provided value for it to race against.
    // `metadata_json` itself used to be unconditional here the same way,
    // which meant any PATCH that didn't touch metadata (a price or
    // dimension-only edit, say) still re-wrote the *stale* `existing`
    // snapshot's metadata_json verbatim -- silently reverting a concurrent
    // metadata-only save (digital-good flag, no-returns, ...) racing
    // against it, the exact #1742 shape this handler's other columns
    // already guard against. #1807's audit found no live instance of this
    // actually injecting an unintended value (every client call site gates
    // its own metadata write on explicit user input), but it's the one real
    // gap that investigation surfaced, so it gets the same atomic treatment
    // the sibling columns already have.
    const result = await db.prepare(`
      UPDATE catalog_templates
      SET name = COALESCE(?, name), category = COALESCE(?, category),
          subcategory = CASE WHEN ? = 1 THEN ? ELSE subcategory END, color = COALESCE(?, color),
          width_m = COALESCE(?, width_m), depth_m = COALESCE(?, depth_m), height_m = COALESCE(?, height_m),
          price_cents = CASE WHEN ? = 1 THEN ? ELSE price_cents END, seller_id = ?,
          model_url = CASE WHEN ? = 1 THEN ? ELSE model_url END,
          model_size_bytes = CASE WHEN ? = 1 THEN ? ELSE model_size_bytes END,
          skeleton_signature = CASE WHEN ? = 1 THEN ? ELSE skeleton_signature END,
          metadata_json = CASE WHEN ? = 1 THEN ? ELSE metadata_json END,
          stock_quantity = CASE WHEN ? = 1 THEN ? ELSE stock_quantity END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE template_id = ?
    `).bind(
      input.name === undefined ? null : template.name,
      input.category === undefined ? null : template.category,
      input.subcategory === undefined ? 0 : 1, template.subcategory,
      input.color === undefined ? null : template.color,
      input.dimensions === undefined ? null : template.dimensions.width,
      input.dimensions === undefined ? null : template.dimensions.depth,
      input.dimensions === undefined ? null : template.dimensions.height,
      input.priceCents === undefined ? 0 : 1, template.priceCents,
      template.sellerId,
      input.modelUrl === undefined ? 0 : 1, template.modelUrl,
      input.modelSizeBytes === undefined ? 0 : 1, template.modelSizeBytes,
      input.skeletonSignature === undefined ? 0 : 1, template.skeletonSignature,
      input.metadata === undefined ? 0 : 1, JSON.stringify(template.metadata),
      input.stockQuantity === undefined ? 0 : 1, template.stockQuantity,
      route[1],
    ).run();
    // #932: unlike every other single-item update handler on a comparably-
    // shaped resource (builder/seller rename, bundles PATCH, friendships
    // PATCH), this one never checked whether its own UPDATE actually
    // matched a row -- a concurrent DELETE of this template landing in the
    // gap before this UPDATE ran would leave the row already gone, but the
    // handler would still return a fabricated 200 built from the locally-
    // merged `template` object instead of a 404.
    if (result.meta.changes === 0) return json({ error: 'Catalog template not found' }, 404);
    await notifyBuildersOfDimensionChange(db, template, {
      width: existing.width_m,
      depth: existing.depth_m,
      height: existing.height_m,
    }, JSON.parse(existing.metadata_json || '{}'));
    // #976: same reasoning as the POST handler above -- re-select and map
    // through templateFromRow instead of the locally-constructed `template`
    // object, so imageUrl/imageEmbedding/createdAt/updatedAt come back
    // populated like every sibling endpoint on this resource.
    const stored = await db.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(route[1]).first();
    // #2364: same concurrent-delete race #2354/#932 already guard against on
    // this resource's own UPDATE above -- that check only confirms the row
    // existed when the UPDATE ran, not that it still does by the time this
    // re-SELECT runs (e.g. a concurrent DELETE from the same seller session).
    if (!stored) return json({ error: 'Catalog template not found' }, 404);
    return json({ template: templateFromRow(stored) });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    const existing = await db.prepare('SELECT seller_id FROM catalog_templates WHERE template_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Catalog template not found' }, 404);
    if (existing.seller_id && await sellerExists(db, existing.seller_id)) {
      const sessionSeller = await requireSessionSeller(request, db);
      assertOwner(existing.seller_id, sessionSeller.seller_id, 'Not your catalog template');
      // #1455: the session requirement alone doesn't bound this, same
      // reasoning as the PATCH handler's own #1329 fix above (the PATCH
      // comment's claim of parity with "this same resource's own DELETE
      // sibling, #990/#991" was mistaken: #990/#991 fixed product_reviews'
      // own nested DELETE, not this one). This batch sibling (DELETE
      // /catalog/batch, above) had the identical gap on its own owned-seller
      // path and needed the same fix (#1457).
      await checkRateLimit(db, `catalog-delete:${sessionSeller.seller_id}`, CATALOG_DELETE_RATE_LIMIT_MAX);
    } else {
      // No owning seller to gate this DELETE behind a session (see the
      // PATCH handler's identical comment above) — cap the request rate the
      // same way, so an unowned template can't be wiped by an unthrottled
      // anonymous flood (#520).
      await checkRateLimit(db, `catalog-delete:${clientIp(request)}`, CATALOG_DELETE_RATE_LIMIT_MAX);
    }
    await assertCatalogTemplatesDeletable(db, [route[1]]);
    await db.prepare('DELETE FROM catalog_templates WHERE template_id = ?').bind(route[1]).run();
    return json({ deleted: true });
  }

  if (route.length >= 3 && route[2] === 'reviews') {
    return handleProductReviews(request, db, route);
  }

  if (route.length >= 3 && route[2] === 'flags') {
    return handleProductFlags(request, db, route);
  }

  return json({ error: 'Not found' }, 404);
}
