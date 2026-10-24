// #2530 (sub-issue of #2502, itself sub-issue of #2500): the shared R2
// storage-budget machinery -- genuinely cross-domain (builder-uploaded
// custom models, concept-image generation (#602), catalog thumbnails, and
// video-to-3D generated models all write into the same MODELS bucket and
// share the same cap), not specific to the models/uploaded-assets domain
// this issue's own scope otherwise extracts. Discovered the same way
// #2528 discovered its own "second tier" of shared helpers while scoping
// #2502's domain leaves: extracting handleModelUpload/handleModelCleanup
// into worker/lib/models.js without first pulling this out would mean
// either that file reaching back into worker/index.js for a function other
// domains still call inline there (a real circular import -- the one
// #2502's own scoping comment warned splitting any domain out before a
// shared dependency lands would risk), or duplicating this logic. Extracted
// verbatim, zero behavior change -- both worker/index.js (the concept-image/
// thumbnail/video-gen call sites, which stay inline there since they're
// each their own domain's job, not this leaf's) and worker/lib/models.js
// import from here.
import { HttpError } from './http.js';

const GLB_MAGIC = 0x46546c67; // ascii "glTF", little-endian uint32
const GLB_VERSION = 2;
const GLB_JSON_CHUNK = 0x4e4f534a;

// Shared between handleModelUpload (worker/lib/models.js) and the
// video-to-3D generation pipeline (worker/index.js, #1619) -- both store a
// model into the same MODELS bucket and both need the same format check
// before it's written, so this lives alongside the rest of the storage-
// budget machinery rather than in either domain's own module.
export function validateGlb(bytes) {
  const view = new DataView(bytes);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) {
    throw new HttpError('File is not a valid .glb (binary glTF) model', 400);
  }
  if (view.getUint32(4, true) !== GLB_VERSION) {
    throw new HttpError('Only glTF 2.0 .glb models are supported', 400);
  }
  if (view.getUint32(8, true) !== bytes.byteLength) {
    throw new HttpError('GLB header length does not match the uploaded file', 400);
  }

  let offset = 12;
  let chunkIndex = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new HttpError('GLB contains a truncated chunk header', 400);
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkEnd = offset + 8 + chunkLength;
    if (chunkLength % 4 !== 0 || chunkEnd > bytes.byteLength) {
      throw new HttpError('GLB contains an invalid chunk length', 400);
    }
    if (chunkIndex === 0) {
      if (chunkType !== GLB_JSON_CHUNK) throw new HttpError('GLB must begin with a JSON chunk', 400);
      let json;
      try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes, offset + 8, chunkLength)).trimEnd());
      } catch {
        throw new HttpError('GLB contains invalid JSON metadata', 400);
      }
      // Found via backlog audit: syntactically valid JSON (even `{}`) used
      // to pass this check outright, storing an unusable "model" that only
      // fails later wherever it's actually loaded (client preview, catalog
      // thumbnailing, in-world rendering). asset.version is the one
      // top-level field the glTF 2.0 spec itself requires of every valid
      // asset (§3.9.2) — checking for it closes the gap with the same kind
      // of format-conformance check this function already does for the
      // magic number/version/chunk type, not a new app-specific rule.
      if (typeof json?.asset?.version !== 'string') {
        throw new HttpError('GLB is missing the required asset.version field', 400);
      }
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
}

// 20MB is a generous ceiling above typical real-world model sizes (most
// uploads should land well under 2MB), not a target: it exists to reject
// an accidentally-huge raw photogrammetry export before it ever reaches R2.
export const MAX_MODEL_BYTES = 20 * 1024 * 1024;

// R2's free tier is 10GB of storage per month. This is our OWN
// application-level backstop well under that — checked live against R2's
// actual current contents on every upload — so a new upload gets rejected
// before it would ever push real usage into paid territory, independent of
// whatever Cloudflare's own billing dashboard does or doesn't warn about.
// Only counts what's actually in R2 — the built-in catalog's models ship as
// static assets, not R2 objects, so they never count against this. The
// writers that do live in this bucket and count against it: builder-
// uploaded custom models, generated concept images (#602), catalog
// thumbnails, and generated video-to-3D models — all go through
// reserveStorageBudget below.
export const MAX_TOTAL_STORAGE_BYTES = 8 * 1024 * 1024 * 1024;

// Generous bound on how long a model_upload_reservations row can outlive
// its own request before being treated as abandoned (the request crashed
// or the Worker was killed mid-upload, before its own cleanup ran) — see
// migrations/0065_model_upload_reservations.sql. Comfortably above how long
// even a slow connection needs to finish uploading MAX_MODEL_BYTES.
export const MODEL_UPLOAD_RESERVATION_TIMEOUT_MS = 5 * 60 * 1000;

export function formatBytes(bytes) {
  // #1539: MAX_TOTAL_STORAGE_BYTES is 8GB -- without this tier it rendered
  // as "8192.0MB" in every reserveStorageBudget 507 error.
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

export async function getStorageUsage(bucket) {
  let usedBytes = 0;
  let objectCount = 0;
  let cursor;
  do {
    const listing = await bucket.list({ cursor, limit: 1000 });
    for (const object of listing.objects) usedBytes += object.size;
    objectCount += listing.objects.length;
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return { usedBytes, objectCount };
}

// The atomic reservation dance MAX_TOTAL_STORAGE_BYTES enforcement needs
// (see model_upload_reservations' own migration comment), shared between
// handleModelUpload and concept-image generation (#602) — both write into
// the same MODELS bucket and can each add a meaningfully large object, so
// both need to close the same concurrent-upload race against the same cap.
// Concept-image can't reserve before its own R2 write the way a multipart
// upload does (its size isn't known until the image is actually generated),
// so it calls this right before the put instead of before the request body
// is even read — same atomicity where it matters (nothing else can land
// between this reservation and its own put), just later in that one
// request's own timeline. Returns a reservation id the caller must delete
// (in a finally) once its own R2 write lands or fails.
export async function reserveStorageBudget(db, usage, sizeBytes, sizeLabel) {
  const reservationId = `reservation-${crypto.randomUUID()}`;
  const now = Date.now();
  await db.prepare(`
    DELETE FROM model_upload_reservations WHERE created_at < ?
  `).bind(now - MODEL_UPLOAD_RESERVATION_TIMEOUT_MS).run();
  const reserved = await db.prepare(`
    INSERT INTO model_upload_reservations (reservation_id, size_bytes, created_at)
    SELECT ?, ?, ?
    WHERE ? + (SELECT COALESCE(SUM(size_bytes), 0) FROM model_upload_reservations) + ? <= ?
  `).bind(reservationId, sizeBytes, now, usage.usedBytes, sizeBytes, MAX_TOTAL_STORAGE_BYTES).run();
  if (reserved.meta.changes === 0) {
    const reservedBytes = await db.prepare(`
      SELECT COALESCE(SUM(size_bytes), 0) AS total FROM model_upload_reservations
    `).first();
    const remainingBudget = MAX_TOTAL_STORAGE_BYTES - usage.usedBytes - reservedBytes.total;
    throw new HttpError(
      `${sizeLabel} is ${formatBytes(sizeBytes)}, but only ${formatBytes(Math.max(remainingBudget, 0))} of storage headroom is left (${formatBytes(MAX_TOTAL_STORAGE_BYTES)} total cap)`,
      507,
    );
  }
  return reservationId;
}
