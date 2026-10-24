// #2530 (sub-issue of #2502, itself sub-issue of #2500) — see #2503's
// design comment for full context. Extracted verbatim, zero behavior
// change: handleUploadedAsset, handleModelUpload, handleModelListing,
// handleModelStorage, handleModelCleanup, plus scheduledModelCleanup/
// cleanupUnreferencedModels (the cron sweep and its own shared helper --
// not separately named in this issue's own scope, but only ever called by
// handleModelCleanup and the cron path respectively, so leaving them
// behind in worker/index.js would split one cohesive cleanup mechanism
// across two files for no reason).
//
// handleListSavedLayouts/handleSavedLayouts (also named in this issue's
// own scope) were originally left behind for the same reason just
// described -- both call requireSessionBuilder, which lived in
// worker/index.js at the time, and worker/index.js imports this module's
// own handlers to dispatch to them, so importing requireSessionBuilder
// back would have been circular. That's resolved now: requireSessionBuilder
// moved into worker/lib/auth.js (landed on main independently while this
// issue's own first PR, #2594, was still in CI), so this module can import
// it as a forward, non-circular dependency the same way every other
// handler here already imports from auth.js. Picking this back up now.
// savedLayoutFromRow/savedLayoutInstanceFromRow move here too (their own
// natural home, alongside the handlers that are these rows' only real
// owner) and are exported for worker/index.js's own exportSocialSection,
// which still needs them for the full-account-data-export feature --
// not a circular import, just worker/index.js importing one more name
// from this module the same way it already imports handleModelUpload etc.
import { json, HttpError, clientIp } from './http.js';
import { requireAdmin, requireSessionBuilder, assertOwner } from './auth.js';
import { checkRateLimit } from './rate-limit.js';
import { readJson, queryLimit, decodeCursor, encodeCursor, stringValue, positiveInteger } from './validation.js';
import { adminActionLogStatement } from './admin-log.js';
import {
  MAX_MODEL_BYTES, MAX_TOTAL_STORAGE_BYTES, MODEL_UPLOAD_RESERVATION_TIMEOUT_MS,
  formatBytes, getStorageUsage, reserveStorageBudget, validateGlb,
} from './storage.js';

// #2668: this admin-gated single-object delete had no checkRateLimit call
// at all, unlike every comparable admin mutation elsewhere (e.g.
// purchases-admin.js's SELF_DEALING_FLAG_REVIEW_RATE_LIMIT_MAX, or
// world-generation.js's own buckets from #2657/#2659) -- same 20-per-window
// shape as those, bucketed on the admin's own user_id.
const UPLOADED_ASSET_DELETE_RATE_LIMIT_MAX = 20;

async function handleUploadedAsset(request, env) {
  if (!env.MODELS) return json({ error: 'R2 binding MODELS is not configured' }, 500);
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'DELETE') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD, DELETE' } });
  }

  let key;
  try {
    key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/uploads\//, ''));
  } catch {
    throw new HttpError('Invalid upload path encoding', 400);
  }
  if (!key) throw new HttpError('Uploaded model key is required', 400);

  if (request.method === 'DELETE') {
    if (!env.DB) throw new HttpError('D1 binding DB is not configured', 500);
    // Same admin-only bar as /api/models/cleanup below (and every other
    // maintenance-tooling endpoint gated by requireAdmin) — deleting an R2
    // object outright, unlike every other mutating endpoint in this file,
    // has no owning builder/seller to check against, so "logged in" alone
    // isn't a meaningful bar here.
    const admin = await requireAdmin(request, env.DB);
    await checkRateLimit(env.DB, `uploaded-asset-delete:${admin.user_id}`, UPLOADED_ASSET_DELETE_RATE_LIMIT_MAX);
    const modelUrl = `/uploads/${key}`;
    const existing = await env.MODELS.head(key);
    if (!existing) return json({ error: 'Not found' }, 404);
    // #376: re-checked as the very last thing before the actual R2 delete
    // (not at the top of this handler) to keep this as close as this
    // codebase's D1-vs-R2 split allows to the atomic check-then-act idiom
    // used everywhere else here (auction bids, reviews, friendships) — a
    // template referencing this model created between an earlier check and
    // now would otherwise still lose its file out from under it.
    // #774: model_url and image_url are both content-addressed keys into
    // this same bucket (the latter written by POST .../thumbnail) — an
    // object referenced only as a thumbnail must block deletion here too.
    // #1644/#1655/#1696: video_generation_jobs.model_url and
    // control_room_tasks/control_room_replies.image_url are three more
    // writers into this same bucket/scheme (same five sources
    // cleanupUnreferencedModels already checks) — without these, this raw
    // admin delete would succeed on an object still in use by a pending
    // video-to-3D job or a Control Room screenshot, destroying it out from
    // under that reference even though the automated sweep would have
    // correctly protected it.
    const referenced = await env.DB.prepare(`
      SELECT 1 FROM catalog_templates WHERE model_url = ? OR image_url = ?
      UNION ALL
      SELECT 1 FROM video_generation_jobs WHERE model_url = ?
      UNION ALL
      SELECT 1 FROM control_room_tasks WHERE image_url = ?
      UNION ALL
      SELECT 1 FROM control_room_replies WHERE image_url = ?
      LIMIT 1
    `).bind(modelUrl, modelUrl, modelUrl, modelUrl, modelUrl).first();
    if (referenced) throw new HttpError('Uploaded model is still referenced', 409);
    await env.MODELS.delete(key);
    // #829: same missed-audit-trail gap as /api/models/cleanup above — this
    // single-object delete never recorded which admin ran it.
    await adminActionLogStatement(env.DB, admin.user_id, 'delete_uploaded_asset', 'model_upload', modelUrl).run();
    return json({ deleted: true });
  }

  const conditionalRequest = request.method === 'HEAD' || request.headers.has('if-none-match');
  let object = conditionalRequest ? await env.MODELS.head(key) : await env.MODELS.get(key);
  if (!object) return json({ error: 'Not found' }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('access-control-allow-origin', '*');
  // #823: defense-in-depth for the whole /uploads/* surface — stops a
  // browser from MIME-sniffing stored bytes into something other than the
  // Content-Type this server itself set at write time.
  headers.set('x-content-type-options', 'nosniff');
  // Uploaded files are content-addressed (SHA-256 key, never overwritten in
  // place — see handleModelUpload) and never change once
  // stored, so a long-lived cache is always safe.
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  if (request.headers.get('if-none-match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') return new Response(null, { headers });

  // A metadata lookup was enough to answer a matching conditional request.
  // Fetch the body only when a stale conditional GET actually needs it.
  if (!('body' in object)) {
    object = await env.MODELS.get(key);
    if (!object) return json({ error: 'Not found' }, 404);
  }
  return new Response(object.body, { headers });
}

async function handleModelUpload(request, env) {
  if (!env.MODELS) throw new HttpError('R2 binding MODELS is not configured', 500);

  // Unauthenticated on purpose (see the removed-URL-import comment above),
  // but unlike POST /api/builders/sellers this isn't just a spoof-nothing
  // row insert — each call can burn up to MAX_MODEL_BYTES of the shared
  // MAX_TOTAL_STORAGE_BYTES cap, so an anonymous caller looping this
  // endpoint could otherwise exhaust R2 storage for everyone. Same
  // per-IP-throttle mitigation as signup/password-reset (checkRateLimit).
  await checkRateLimit(env.DB, `model-upload:${clientIp(request)}`, 20);

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    throw new HttpError('Expected multipart/form-data', 415);
  }

  const form = await request.formData().catch(() => {
    throw new HttpError('Request body is not valid multipart/form-data', 400);
  });
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new HttpError('Expected a "file" field in the form data', 400);
  }
  if (file.size > MAX_MODEL_BYTES) {
    throw new HttpError(`File is ${formatBytes(file.size)}, over the ${formatBytes(MAX_MODEL_BYTES)} limit`, 413);
  }
  const bytes = await file.arrayBuffer();
  validateGlb(bytes);

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const key = `models/${hash}.glb`;
  const existing = await env.MODELS.head(key);
  if (existing) {
    return json({
      modelUrl: `/uploads/${key}`,
      sourceName: file.name || 'model.glb',
      sizeBytes: existing.size,
      deduplicated: true,
    });
  }

  const usage = await getStorageUsage(env.MODELS);

  // R2 has no primitive for "put only if some byte budget elsewhere still
  // allows it," so the actual cap enforcement has to happen in D1 instead —
  // see reserveStorageBudget's own comment for the atomic-reservation idiom
  // this shares with concept-image generation (#602), the other writer into
  // this same bucket. `usage.usedBytes` is a snapshot (R2 can't be read
  // inside the same atomic statement), but any other upload racing this one
  // reads its own snapshot at essentially the same real R2 state, so the SUM
  // of not-yet-landed reservations — computed atomically alongside this
  // insert — is what actually closes the race between concurrent requests
  // (#264).
  const reservationId = await reserveStorageBudget(env.DB, usage, file.size, 'File');

  try {
    await env.MODELS.put(key, bytes, { httpMetadata: { contentType: 'model/gltf-binary' } });
  } finally {
    // The reservation's job is done either way: on success it's now
    // reflected in R2 itself (the next getStorageUsage will see it); on
    // failure the budget it held should be freed back up immediately
    // rather than waiting out MODEL_UPLOAD_RESERVATION_TIMEOUT_MS.
    await env.DB.prepare('DELETE FROM model_upload_reservations WHERE reservation_id = ?').bind(reservationId).run();
  }
  return json({
    modelUrl: `/uploads/${key}`,
    sourceName: file.name || 'model.glb',
    sizeBytes: bytes.byteLength,
    deduplicated: false,
  }, 201);
}

// #2204: handleModelListing and cleanupUnreferencedModels (its scan loop
// and its pre-delete re-check) each run the same 5-way UNION ALL --
// catalog_templates.model_url/image_url, video_generation_jobs.model_url,
// control_room_tasks/control_room_replies.image_url, see the #774/#1644/
// #1655 comments on those callers for why all five need checking -- and
// each one used to bind its own modelUrls/targetUrls array once per UNION
// branch in a single unchunked query. D1_MAX_BOUND_PARAMETERS is a per-
// query cap, not a per-array cap: with the same array bound 5 times into
// one query, the real per-chunk size is a fifth of what a single-bind-
// per-value query (e.g. worker/lib/validation.js's own assertReferencesExist)
// uses for itself, so a straight reuse of that constant would still blow
// the limit at 100 urls instead of the real ~20. (A local copy of this
// constant, not imported from validation.js's own private one, matching
// worker/index.js's own likewise-separate copy for its own unrelated
// chunked queries -- genuinely incidental duplication of the same D1
// ceiling, not a shared value worth centralizing just for this.)
const D1_MAX_BOUND_PARAMETERS = 100;

async function selectModelUrlReferencesChunked(db, urls) {
  const chunkSize = Math.floor(D1_MAX_BOUND_PARAMETERS / 5);
  const rows = [];
  for (let i = 0; i < urls.length; i += chunkSize) {
    const chunk = urls.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await db.prepare(`
      SELECT 'template' AS source, template_id AS id, model_url AS url FROM catalog_templates WHERE model_url IN (${placeholders})
      UNION ALL
      SELECT 'template' AS source, template_id AS id, image_url AS url FROM catalog_templates WHERE image_url IN (${placeholders})
      UNION ALL
      SELECT 'videoJob' AS source, job_id AS id, model_url AS url FROM video_generation_jobs WHERE model_url IN (${placeholders})
      UNION ALL
      SELECT 'controlRoom' AS source, task_id AS id, image_url AS url FROM control_room_tasks WHERE image_url IN (${placeholders})
      UNION ALL
      SELECT 'controlRoom' AS source, reply_id AS id, image_url AS url FROM control_room_replies WHERE image_url IN (${placeholders})
    `).bind(...chunk, ...chunk, ...chunk, ...chunk, ...chunk).all();
    rows.push(...results);
  }
  return rows;
}

// Admin-only, same "cleanup tooling" bar as POST /api/models/cleanup and
// DELETE /uploads/:key — this lists every R2 upload (including
// unregistered, in-progress ones no other builder should be able to
// enumerate) with its size, etag, and which catalog templates reference
// it. Not a builder/seller-facing endpoint at all.
async function handleModelListing(request, env, url) {
  await requireAdmin(request, env.DB);
  if (!env.MODELS) throw new HttpError('R2 binding MODELS is not configured', 500);
  const limit = queryLimit(url.searchParams.get('limit'), 100);
  const cursorParam = url.searchParams.get('cursor');
  const cursor = cursorParam === null ? undefined : stringValue(cursorParam, 'cursor');
  const listing = await env.MODELS.list({ limit, cursor });
  const modelUrls = listing.objects.map((object) => `/uploads/${object.key}`);
  const templateRefs = new Map(modelUrls.map((modelUrl) => [modelUrl, []]));
  const videoJobRefs = new Map(modelUrls.map((modelUrl) => [modelUrl, []]));
  const controlRoomRefs = new Map(modelUrls.map((modelUrl) => [modelUrl, []]));
  if (modelUrls.length > 0) {
    // #774: image_url (thumbnails) shares this same bucket/URL scheme as
    // model_url — checking model_url alone marked every live thumbnail
    // "unreferenced". #1644/#1655/#1696: video_generation_jobs.model_url
    // and control_room_tasks/control_room_replies.image_url are three more
    // writers into this same bucket/scheme (same reasoning as
    // cleanupUnreferencedModels' own two UNION queries, which already check
    // all five) — a model/image real-but-not-yet-template-referenced in one
    // of these used to read back here as `deletable: true` with an empty
    // reference list, a false "safe to delete" signal for this admin view.
    //
    // #2204: selectModelUrlReferencesChunked (see its own comment) chunks
    // this same query rather than binding the full modelUrls array once
    // per UNION branch in a single call -- this list can be up to 100
    // long (this handler's own `limit` above), which blew D1's 100-bound-
    // parameter cap once multiplied by 5 branches.
    const referenced = await selectModelUrlReferencesChunked(env.DB, modelUrls);
    for (const row of referenced) {
      if (row.source === 'template') templateRefs.get(row.url).push(row.id);
      else if (row.source === 'videoJob') videoJobRefs.get(row.url).push(row.id);
      else controlRoomRefs.get(row.url).push(row.id);
    }
  }
  return json({
    models: listing.objects.map((object) => {
      const modelUrl = `/uploads/${object.key}`;
      const referencedByTemplateIds = templateRefs.get(modelUrl);
      const referencedByVideoJobIds = videoJobRefs.get(modelUrl);
      const referencedByControlRoomIds = controlRoomRefs.get(modelUrl);
      return {
        modelUrl,
        sizeBytes: object.size,
        etag: object.httpEtag,
        uploadedAt: object.uploaded?.toISOString() || null,
        referencedByTemplateIds,
        referencedByVideoJobIds,
        referencedByControlRoomIds,
        deletable: referencedByTemplateIds.length === 0 && referencedByVideoJobIds.length === 0
          && referencedByControlRoomIds.length === 0,
      };
    }),
    nextCursor: listing.truncated ? listing.cursor : null,
  });
}

// Admin-only, same reasoning as handleModelListing above — live storage
// utilization against the shared cap is operational data, not something a
// shopper/builder/seller session has any business reading.
async function handleModelStorage(request, env) {
  await requireAdmin(request, env.DB);
  if (!env.MODELS) throw new HttpError('R2 binding MODELS is not configured', 500);
  const usage = await getStorageUsage(env.MODELS);
  return json({
    ...usage,
    capBytes: MAX_TOTAL_STORAGE_BYTES,
    availableBytes: Math.max(0, MAX_TOTAL_STORAGE_BYTES - usage.usedBytes),
    utilizationRatio: usage.usedBytes / MAX_TOTAL_STORAGE_BYTES,
  });
}

// #2668: same gap as UPLOADED_ASSET_DELETE_RATE_LIMIT_MAX above — this
// admin-gated bulk delete (up to 100 objects per call) had no rate limit
// at all either.
const MODEL_CLEANUP_RATE_LIMIT_MAX = 20;

async function handleModelCleanup(request, env) {
  if (!env.MODELS) throw new HttpError('R2 binding MODELS is not configured', 500);
  // Admin-only: this bulk-deletes any unreferenced upload in the shared R2
  // bucket, including another builder's in-progress upload that just
  // hasn't been registered via POST /api/catalog yet (the two are
  // deliberately independent steps — see handleModelUpload's own comment).
  // Same bar as the world/land-candidate tooling above. (handleApi already
  // guarantees env.DB is configured before routing here, unlike
  // handleUploadedAsset below, which sits outside handleApi entirely.)
  const admin = await requireAdmin(request, env.DB);
  await checkRateLimit(env.DB, `model-cleanup:${admin.user_id}`, MODEL_CLEANUP_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const maxDeletes = positiveInteger(input.maxDeletes ?? 100, 'maxDeletes');
  if (maxDeletes > 100) throw new HttpError('maxDeletes must be at most 100', 400);
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
    throw new HttpError('dryRun must be a boolean', 400);
  }
  const dryRun = input.dryRun || false;
  const result = await cleanupUnreferencedModels(env, { maxDeletes, dryRun });
  // #1202: targetCount/reclaimedBytes alone can't say which objects a given
  // run actually (or would) remove -- targetModelUrls is already computed by
  // cleanupUnreferencedModels (and already returned in this endpoint's own
  // HTTP response below), so carry it into the logged detail too, the same
  // "who did what" bar #829 already held delete_uploaded_asset to.
  await adminActionLogStatement(env.DB, admin.user_id, 'model_cleanup', 'model_upload_batch', null, {
    maxDeletes, dryRun, targetCount: result.targetCount, reclaimedBytes: result.reclaimedBytes,
    targetModelUrls: result.targetModelUrls,
  }).run();
  return json({ ...result, dryRun });
}

// #848: scheduled()'s own periodic sweep — see its call site in
// worker/index.js. Every writer into the MODELS bucket (model uploads,
// catalog thumbnails, concept-image generation, #602) shares one
// MAX_TOTAL_STORAGE_BYTES cap, but concept-image's own generated PNGs are
// *never* meant to be referenced by a catalog_templates row (they're pure
// scratch input to similarity-search, see concept-image's own comment) —
// every generation is therefore a guaranteed-permanent, guaranteed-
// unreferenced object with no automatic path to reclaim it, previously
// only cleaned up if an admin happened to run POST /api/models/cleanup by
// hand. Left unattended, ordinary encouraged usage (iterating on a
// concept-image prompt) eventually exhausts the shared cap and 507s every
// writer, model uploads and catalog thumbnails included, until an admin
// notices. adminUserId is null here (a real admin_user_id FK wouldn't
// exist for a cron-triggered action) — admin_action_log.admin_user_id
// already allows NULL for exactly this "no longer identifiable/no admin
// acted" shape (migrations/0087's own ON DELETE SET NULL reasoning).
export async function scheduledModelCleanup(env) {
  if (!env.MODELS) return;
  // #890: an unattended sweep — unlike the admin-triggered POST endpoint
  // below, which stays immediate/no-grace-period on purpose — must not
  // delete an upload that's still legitimately mid-registration (the
  // upload-then-register wizard has no deadline of its own). Reuses
  // MODEL_UPLOAD_RESERVATION_TIMEOUT_MS: the same "comfortably above how
  // long even a slow connection needs" reasoning already applied to the
  // storage-budget-reservation side of this identical upload flow.
  const result = await cleanupUnreferencedModels(env, { maxDeletes: 100, dryRun: false, minAgeMs: MODEL_UPLOAD_RESERVATION_TIMEOUT_MS });
  if (result.targetCount > 0) {
    // #1202: same "record which objects, not just how many" fix as
    // handleModelCleanup's own call site above -- matters even more here
    // since this unattended sweep's admin_action_log row is the only record
    // this run ever produces at all (no HTTP response for anyone to see).
    await adminActionLogStatement(env.DB, null, 'model_cleanup', 'model_upload_batch', null, {
      maxDeletes: 100, dryRun: false, targetCount: result.targetCount, reclaimedBytes: result.reclaimedBytes,
      targetModelUrls: result.targetModelUrls,
      trigger: 'scheduled',
    }).run();
  }
}

// Exported so #890's regression test can exercise minAgeMs directly with a
// tiny threshold — proving an object that genuinely clears the age bar
// still gets cleaned isn't practically testable through the real cron
// path, which hardcodes the full 5-minute MODEL_UPLOAD_RESERVATION_TIMEOUT_MS.
export async function cleanupUnreferencedModels(env, { maxDeletes, dryRun, minAgeMs = 0 }) {
  const targets = [];
  let cursor;
  let completeScan = false;
  const now = Date.now();
  do {
    const listing = await env.MODELS.list({ cursor, limit: 100 });
    const modelUrls = listing.objects.map((object) => `/uploads/${object.key}`);
    const referencedUrls = new Set();
    if (modelUrls.length > 0) {
      // #774: image_url (thumbnails) shares this same bucket/URL scheme as
      // model_url — checking model_url alone would target live thumbnails
      // for deletion as "unreferenced". #1644: video_generation_jobs.
      // model_url (migrations/0119) is a second, independent writer into
      // this same bucket/scheme — a completed video-to-3D job's model has
      // no catalog_templates row yet (that's only created once a human
      // finishes the upload wizard, #1620), so without this it reads as
      // unreferenced and gets swept within minutes of generation. #1655:
      // control_room_tasks/control_room_replies.image_url (migrations/0082)
      // are a fourth writer into this same bucket/scheme — imageUrlValue
      // explicitly accepts a /uploads/<key> path for these columns, so a
      // Control Room screenshot uploaded that way looked unreferenced too.
      //
      // #2204: selectModelUrlReferencesChunked (see its own comment) chunks
      // this same 5-way check rather than binding the full modelUrls array
      // once per branch in a single call -- a 100-object R2 page blew D1's
      // 100-bound-parameter cap once multiplied by 5 branches.
      const referenced = await selectModelUrlReferencesChunked(env.DB, modelUrls);
      for (const row of referenced) referencedUrls.add(row.url);
    }
    let examinedWholePage = true;
    for (let i = 0; i < listing.objects.length; i++) {
      const object = listing.objects[i];
      // #890: an object younger than minAgeMs is skipped, not just
      // "examined and found referenced" — it may still be mid-registration
      // (see this function's own callers for why the cron path passes a
      // nonzero minAgeMs and the admin-triggered one doesn't).
      const oldEnough = !object.uploaded || now - object.uploaded.getTime() >= minAgeMs;
      if (oldEnough && !referencedUrls.has(`/uploads/${object.key}`)) targets.push(object);
      if (targets.length === maxDeletes && i < listing.objects.length - 1) {
        examinedWholePage = false;
        break;
      }
    }
    // completeScan means "every object in the bucket was actually examined,"
    // not just "R2 has no further pages" — listing.truncated alone doesn't
    // capture the loop above stopping mid-page once maxDeletes is hit, which
    // would otherwise report the scan as complete despite skipping whatever
    // was left unexamined on this same (final, listing.truncated === false)
    // page (#417).
    completeScan = !listing.truncated && examinedWholePage;
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (!completeScan && targets.length < maxDeletes);

  // #376: each target's "unreferenced" check above ran against whatever
  // page it was scanned on, potentially many awaits before this point (the
  // scan can span several 100-object pages) — a catalog template could
  // have started referencing one of them in the meantime. Re-verify against
  // the final target set immediately before the actual delete, as close to
  // the R2 call as this D1-vs-R2 split allows, and only delete/report
  // whatever is still genuinely unreferenced.
  let toDelete = targets;
  if (targets.length > 0) {
    // #774/#1644/#1655: same reference-check gap as the scan above —
    // re-checked here too since this query is independent of it.
    //
    // #2204: chunked via selectModelUrlReferencesChunked for the same
    // reason as the scan above — targetUrls can be up to maxDeletes long,
    // which blew D1's 100-bound-parameter cap once multiplied by 5
    // branches in a single unchunked query.
    const targetUrls = targets.map((object) => `/uploads/${object.key}`);
    const stillReferenced = await selectModelUrlReferencesChunked(env.DB, targetUrls);
    const rescuedUrls = new Set(stillReferenced.map((row) => row.url));
    toDelete = targets.filter((object) => !rescuedUrls.has(`/uploads/${object.key}`));
  }
  if (!dryRun && toDelete.length > 0) await env.MODELS.delete(toDelete.map((object) => object.key));
  const reclaimedBytes = toDelete.reduce((sum, object) => sum + object.size, 0);
  return {
    targetModelUrls: toDelete.map((object) => `/uploads/${object.key}`),
    targetCount: toDelete.length,
    reclaimedBytes,
    completeScan,
  };
}

export function savedLayoutFromRow(row) {
  return {
    savedLayoutId: row.saved_layout_id,
    sourceLandletId: row.source_landlet_id,
    sourceLevelIndex: row.source_level_index,
    name: row.name,
    createdAt: row.created_at,
    instanceCount: row.instance_count,
  };
}

// #634 (sub-issue of #631): GET /api/builders/me/saved-layouts — newest
// first, same cursor shape as GET /api/notifications (DESC on both
// created_at and the tiebreak id, "older than the last row already seen"
// on the next page) since a builder's own saved-layout history reads the
// same way a notification feed does, not like the ascending lists
// (auctions, landlets, instances) elsewhere in worker/index.js.
async function handleListSavedLayouts(request, db, url) {
  const sessionBuilder = await requireSessionBuilder(request, db);
  const limit = queryLimit(url.searchParams.get('limit'), 100);
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  const conditions = ['l.builder_id = ?'];
  const bindings = [sessionBuilder.builder_id];
  if (cursor) {
    conditions.push('(l.created_at < ? OR (l.created_at = ? AND l.saved_layout_id < ?))');
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const { results } = await db.prepare(`
    SELECT l.*, COUNT(i.source_instance_id) AS instance_count
    FROM saved_level_layouts l
    LEFT JOIN saved_layout_instances i ON i.saved_layout_id = l.saved_layout_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY l.saved_layout_id
    ORDER BY l.created_at DESC, l.saved_layout_id DESC LIMIT ?
  `).bind(...bindings, limit + 1).all();
  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  const last = page.at(-1);
  return json({
    savedLayouts: page.map(savedLayoutFromRow),
    nextCursor: hasMore ? encodeCursor(last.created_at, last.saved_layout_id) : null,
  });
}

// #635's own preview needs each instance's full snapshot (template,
// position, rotation, crop, scale) to actually render it — the same shape
// versionInstanceFromRow already gives createMeshForInstance for a landlet
// version's own snapshot rows, just read off saved_layout_instances
// instead of version_instances.
export function savedLayoutInstanceFromRow(row) {
  return {
    instanceId: row.source_instance_id,
    id: row.source_instance_id,
    templateId: row.template_id,
    x: row.x_m,
    y: row.y_m,
    z: row.z_m,
    rotationX: row.rotation_x_rad,
    rotationY: row.rotation_y_rad,
    rotationZ: row.rotation_z_rad,
    label: row.label,
    crop: JSON.parse(row.crop_json || '{}'),
    scale: row.scale,
    isCommunitySign: Boolean(row.is_community_sign),
    isCommunityCalendar: Boolean(row.is_community_calendar),
  };
}

// #944: the DELETE branch below is an authenticated, owner-gated,
// repeatable mutation with no rate limit at all -- unlike this file's other
// owner-gated CRUD DELETEs (friendship-mutate, bundle-mutate) and unlike
// saved-layout *creation* itself (SAVED_LAYOUT_CREATE_RATE_LIMIT_MAX,
// worker/lib/land.js -- a layout is auto-created there as a side effect of
// removing a landlet level, not through a handler in this file).
const SAVED_LAYOUT_DELETE_RATE_LIMIT_MAX = 20;

// #634: GET/DELETE /api/saved-layouts/:id — owner-gated the same way every
// other builder-owned resource is (assertOwner against the session's own
// resolved builder id), a separate top-level collection rather than nested
// under /builders/me since a single saved layout is addressed by its own
// id, not by the builder's — the list above is the only place that needs
// the builder's own id in its path.
async function handleSavedLayouts(request, db, route) {
  if (request.method === 'GET' && route.length === 2) {
    const savedLayoutId = route[1];
    const row = await db.prepare('SELECT * FROM saved_level_layouts WHERE saved_layout_id = ?').bind(savedLayoutId).first();
    if (!row) throw new HttpError('Saved layout not found', 404);
    const sessionBuilder = await requireSessionBuilder(request, db);
    assertOwner(row.builder_id, sessionBuilder.builder_id, 'Not your saved layout');
    const { results } = await db.prepare(
      'SELECT * FROM saved_layout_instances WHERE saved_layout_id = ? ORDER BY source_instance_id',
    ).bind(savedLayoutId).all();
    return json({
      savedLayout: { ...savedLayoutFromRow(row), instanceCount: results.length, instances: results.map(savedLayoutInstanceFromRow) },
    });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    const savedLayoutId = route[1];
    const row = await db.prepare('SELECT * FROM saved_level_layouts WHERE saved_layout_id = ?').bind(savedLayoutId).first();
    if (!row) throw new HttpError('Saved layout not found', 404);
    const sessionBuilder = await requireSessionBuilder(request, db);
    assertOwner(row.builder_id, sessionBuilder.builder_id, 'Not your saved layout');
    await checkRateLimit(db, `saved-layout-delete:${sessionBuilder.builder_id}`, SAVED_LAYOUT_DELETE_RATE_LIMIT_MAX);
    // saved_layout_instances cascades via its own FOREIGN KEY ... ON
    // DELETE CASCADE (migration 0080) — nothing else to clean up here.
    await db.prepare('DELETE FROM saved_level_layouts WHERE saved_layout_id = ?').bind(savedLayoutId).run();
    return json({ deleted: true });
  }
  return json({ error: 'Not found' }, 404);
}

export {
  handleUploadedAsset, handleModelUpload, handleModelListing, handleModelStorage, handleModelCleanup,
  handleListSavedLayouts, handleSavedLayouts,
};
