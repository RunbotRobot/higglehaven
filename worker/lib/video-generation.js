// #2541 (sub-issue of #2502, itself sub-issue of #2500's worker/index.js
// module split): video-to-3D generation via Tripo3D (#1619, sub-issue of
// #1616, docs/SPEC.md) -- the job-create/status-poll/webhook route
// handlers plus every helper exclusively used by them. Extracted
// verbatim, zero behavior change.
//
// requireSessionBuilder now lives in worker/lib/auth.js (#2543/#2528).
// MAX_MODEL_BYTES/formatBytes/validateGlb/getStorageUsage/
// reserveStorageBudget/hasValidImageSignature are the shared model-upload
// infrastructure handleModelUpload (worker/index.js) also depends on, not
// video-generation-specific -- still imported back from there below.
import { json, HttpError } from './http.js';
import { timingSafeEqual, bytesToHex } from './crypto.js';
import { checkRateLimit } from './rate-limit.js';
import { assertOwner, requireSessionBuilder } from './auth.js';
import { adminActionLogStatement } from './admin-log.js';
import {
  formatBytes, validateGlb, getStorageUsage, reserveStorageBudget, hasValidImageSignature,
} from '../index.js';

// #1978: workerd requires every named export of the main Worker entry
// module (worker/index.js) to be a function/class binding, not a plain
// const -- confirmed the hard way, per worker/lib/builder-profile.js's own
// comment on its identical D1_MAX_BOUND_PARAMETERS duplication. Duplicated
// here rather than exported-and-imported for that reason; MAX_MODEL_BYTES
// in worker/index.js stays the source of truth for every other R2 writer
// (handleModelUpload and its own size-limit check).
const MAX_MODEL_BYTES = 20 * 1024 * 1024;

// ---- Video-to-3D generation via Tripo3D (#1619, sub-issue of #1616,
// docs/SPEC.md) ----
//
// Same never-configured-in-tests convention as STRIPE_SECRET_KEY/
// DIDIT_API_KEY/OPENAI_API_KEY (worker/index.js): with env.TRIPO_API_KEY
// unset, tripoConfigured(env) is false and the route handlers below
// return a real 503 rather than attempting a live network call.
function tripoConfigured(env) {
  return !!env.TRIPO_API_KEY;
}

// Tripo's V3 API (https://developers.tripo3d.com/) — plain
// bearer-token auth and a JSON body for task-creation/status calls.
// File upload (tripoUploadFile below) is the one call that needs a
// multipart body instead, so it doesn't go through this helper.
async function tripoRequest(env, method, path, body) {
  const response = await fetch(`https://openapi.tripo3d.com/v3/${path}`, {
    method,
    headers: { authorization: `Bearer ${env.TRIPO_API_KEY}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.code !== 0) {
    throw new HttpError(data?.message || 'Tripo request failed', response.status >= 500 ? 502 : 400);
  }
  return data.data;
}

// POST /files — uploads one view image and returns the file_token
// multiview-to-model's own `inputs` field below takes in place of a
// public URL. Separate from tripoRequest since this is the one Tripo
// call that's multipart, not JSON.
async function tripoUploadFile(env, bytes, filename, contentType) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  const response = await fetch('https://openapi.tripo3d.com/v3/files', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.TRIPO_API_KEY}` },
    body: form,
  });
  const data = await response.json().catch(() => null);
  // Same response-shape validation generateConceptImageBytes/
  // fetchTax1099EfilingToken (#1548/#1563, worker/index.js) already do for
  // their own third-party JSON -- without it, an unexpected 2xx body would
  // carry an undefined file_token all the way into the multiview-to-model
  // call below instead of failing here with a clean error.
  if (!response.ok || data?.code !== 0 || !data?.data?.file_token) {
    throw new HttpError('Video-to-3D image upload failed — please try again', response.status >= 500 ? 502 : 400);
  }
  return data.data.file_token;
}

// Pinned to a specific Tripo model version (rather than always "latest")
// so a provider-side default change can't silently alter output quality/
// cost out from under this integration. v3.0-20250812 is docs' own
// "stable" tier as of #1617's research; the "latest" v3.1 tier is newer
// and less proven.
const TRIPO_MODEL_VERSION = 'v3.0-20250812';

// A real (non-trivial) per-call cost -- ~$0.20-0.30/generation per #1617's
// own research -- same reasoning as DIDIT_SESSION_RATE_LIMIT_MAX
// (worker/lib/didit.js), bucketed per-builder since this is a session-gated
// seller action.
const VIDEO_GENERATION_RATE_LIMIT_MAX = 10;

// #1993 (sub-issue of #1976): the honest-budget message the owner asked
// for directly, shown whenever a builder has no video_generation_credits
// left (migrations/0127) -- not a bare cap, an explanation plus a real
// free alternative that doesn't need a credit at all.
const VIDEO_GENERATION_NO_CREDITS_MESSAGE = 'No free model-generation credits available right now — this platform is '
  + 'bootstrapped from very little budget, so generations are rationed. Collect a credit orb in the world, or '
  + 'generate a model for free elsewhere (e.g. Sketchfab) and upload it here directly — no credit needed for that.';
// handleVideoGenerationJobStatus below reconciles against a live Tripo
// status call whenever a job is still pending -- same cadence reasoning
// as DIDIT_STATUS_RATE_LIMIT_MAX, generous enough to cover the frontend's
// own poll loop across one generation attempt (which can take up to ~2
// minutes per #1617) without ever starving a legitimate caller.
const VIDEO_GENERATION_STATUS_RATE_LIMIT_MAX = 120;
const VIDEO_GENERATION_VIEWS = ['front', 'left', 'back', 'right'];
const VIDEO_GENERATION_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
// Headroom under Tripo's own 20MB-per-image cap -- a single extracted
// video frame has no business approaching that.
const MAX_VIDEO_GENERATION_FRAME_BYTES = 10 * 1024 * 1024;
// #1782: same reasoning as DIDIT_RESERVATION_TIMEOUT_MS (worker/lib/didit.js)
// -- a reservation left behind by a crash between reserveVideoGenerationJob's
// own INSERT and handleVideoGenerationJobCreate either flipping it to
// 'processing' or its catch block deleting it outright never resolves on
// its own if that crash didn't run the catch (a CPU-limit kill, isolate
// eviction -- not a thrown JS exception). A legitimate pending->processing
// transition happens within the same request, well under a minute even
// with the frame uploads ahead of it, so this stays well clear of that
// while still being far shorter than DIDIT_RESERVATION_TIMEOUT_MS.
// #1899/#1886: earlier wording here claimed "no real Didit/Tripo cost is
// ever in flight during this specific window (the row is still 'pending',
// not yet billed)" -- false. handleVideoGenerationJobCreate's own billed
// tripoUploadFile/tripoRequest calls happen *while* the row is still
// 'pending'; it only flips to 'processing' after Tripo has already been
// called and billed. A crash landing in that exact sub-window (the row
// genuinely is 'pending' with a real Tripo task already in flight) still
// gets swept by this timeout like any other stale 'pending' row -- a real,
// known residual gap, tracked separately at #1886 (which needs a durable
// task_id-persistence design, not a one-line fix) rather than solved here.
const VIDEO_GENERATION_RESERVATION_TIMEOUT_MS = 2 * 60 * 1000;

// Shared by handleVideoGenerationJobCreate (dedup an already-in-flight
// job) and handleVideoGenerationJobStatus (poll the current one) -- both
// need the same "most recent job row for this builder" lookup.
async function latestVideoGenerationJob(db, builderId) {
  return db.prepare(`
    SELECT * FROM video_generation_jobs WHERE builder_id = ? ORDER BY created_at DESC LIMIT 1
  `).bind(builderId).first();
}

// #2485: reserveVideoGenerationJob's own race-loser `existing` row (read in
// a separate, later query than the INSERT's own NOT EXISTS check that
// lost) isn't automatically still the same still-in-flight job that check
// saw -- it can be gone entirely (deleted in between) or already resolved
// (processed_at set by a concurrent completion) in the narrow window
// between that failed INSERT and this re-read. Exported, same direct-
// testing reasoning as reserveVideoGenerationJob just below, so this
// guard's own logic can be exercised without forcing that exact race
// window's own precise timing.
export function videoGenerationReservationStillUsable(existing) {
  return !!existing && existing.processed_at === null;
}

// Exported for direct testing, the same reasoning reserveDiditSession's
// own callers rely on (worker/lib/didit.js) -- TRIPO_API_KEY is never
// configured in any test file, so handleVideoGenerationJobCreate itself
// always 503s before ever reaching this far through a real HTTP request.
// Reserved atomically before ever calling Tripo's real, billed task-create
// API -- without this, two concurrent requests (a double-click, two open
// tabs) that both observed no in-flight job would both reach the outbound
// call and both get billed. Same "claim first, only the winner calls out"
// idiom reserveDiditSession (#1039) already uses.
export async function reserveVideoGenerationJob(db, builderId) {
  // #1782: same per-caller stale-placeholder cleanup as reserveDiditSession
  // (#1039) runs first, for the identical reason -- clearing out this
  // builder's own stuck 'pending' reservation (scoped to them, not a
  // global sweep) lets the NOT EXISTS guard below admit a genuinely fresh
  // reservation instead of blocking on one nothing will ever resolve.
  //
  // #1886 (piece 1 -- making the failure loud, not the still-open retry/
  // cost policy): a row swept here might be the exact residual gap
  // VIDEO_GENERATION_RESERVATION_TIMEOUT_MS's own comment documents -- a
  // real, billed Tripo call whose result never got persisted because the
  // worker was killed before handleVideoGenerationJobCreate's own UPDATE
  // ever ran. There's no way to tell from this row alone whether that
  // happened or whether it's just an abandoned, never-submitted
  // reservation -- so log every sweep that actually removes a row,
  // durably, rather than only ever being reconstructable by reading code.
  const staleCleanup = await db.prepare(`
    DELETE FROM video_generation_jobs
    WHERE builder_id = ? AND status = 'pending' AND processed_at IS NULL AND created_at < ?
  `).bind(builderId, new Date(Date.now() - VIDEO_GENERATION_RESERVATION_TIMEOUT_MS).toISOString()).run();
  if (staleCleanup.meta.changes > 0) {
    await adminActionLogStatement(db, null, 'video_generation_stale_reservation_swept', 'builder', builderId, {
      rowsDeleted: staleCleanup.meta.changes,
      reservationTimeoutMs: VIDEO_GENERATION_RESERVATION_TIMEOUT_MS,
    }).run();
  }
  const jobId = `job-${crypto.randomUUID()}`;
  const result = await db.prepare(`
    INSERT INTO video_generation_jobs (job_id, builder_id, status)
    SELECT ?, ?, 'pending'
    WHERE NOT EXISTS (
      SELECT 1 FROM video_generation_jobs WHERE builder_id = ? AND processed_at IS NULL
    )
  `).bind(jobId, builderId, builderId).run();
  if (result.meta.changes === 0) {
    return { reservationId: null, existing: await latestVideoGenerationJob(db, builderId) };
  }
  return { reservationId: jobId, existing: null };
}

// #2410: handleVideoGenerationJobCreate's own dedup pre-check (below,
// before the real-cost rate limit) must not treat a stale 'pending' row --
// the exact row reserveVideoGenerationJob's own sweep above exists to
// recover -- as still in flight. Without this, that pre-check intercepts
// every subsequent request for this builder forever, since it never routes
// through reserveVideoGenerationJob (or its sweep) at all once it does.
function isStaleVideoGenerationReservation(row) {
  return row.status === 'pending'
    && new Date(row.created_at).getTime() < Date.now() - VIDEO_GENERATION_RESERVATION_TIMEOUT_MS;
}

// Downloads Tripo's own (third-party, time-limited) output URL and
// re-stores the bytes in the same MODELS R2 bucket/content-addressed
// shape POST /api/models (handleModelUpload) already produces, so the
// client-side model optimizer pipeline (the pipeline-wiring sub-issue)
// gets an identical `/uploads/models/<hash>.glb` URL regardless of
// whether a model came from a direct upload or a video-to-3D job.
async function storeTripoModelOutput(env, tripoModelUrl) {
  const response = await fetch(tripoModelUrl);
  if (!response.ok) {
    throw new HttpError('Failed to download the generated model from the video-to-3D provider', 502);
  }
  const bytes = await response.arrayBuffer();
  // #1755: every other writer into MODELS enforces this same per-file cap
  // before trusting the bytes any further (handleModelUpload checks
  // file.size, modelSizeBytes validation bounds itself against the same
  // constant) -- this path never did, so a generated model could land in
  // R2 well over the limit the rest of the app assumes every model is
  // under, with only the unrelated aggregate MAX_TOTAL_STORAGE_BYTES
  // budget below ever checked.
  if (bytes.byteLength > MAX_MODEL_BYTES) {
    throw new HttpError(`Generated model is ${formatBytes(bytes.byteLength)}, over the ${formatBytes(MAX_MODEL_BYTES)} limit`, 502);
  }
  validateGlb(bytes);

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = bytesToHex(digest);
  const key = `models/${hash}.glb`;
  const existing = await env.MODELS.head(key);
  if (existing) {
    return { modelUrl: `/uploads/${key}`, sizeBytes: existing.size };
  }

  const usage = await getStorageUsage(env.MODELS);
  const reservationId = await reserveStorageBudget(env.DB, usage, bytes.byteLength, 'Generated video-to-3D model');
  try {
    await env.MODELS.put(key, bytes, { httpMetadata: { contentType: 'model/gltf-binary' } });
  } finally {
    await env.DB.prepare('DELETE FROM model_upload_reservations WHERE reservation_id = ?').bind(reservationId).run();
  }
  return { modelUrl: `/uploads/${key}`, sizeBytes: bytes.byteLength };
}

// Tripo's own task statuses (https://developers.tripo3d.com/): 'success'
// means the output is ready to fetch; 'failed'/'cancelled'/'banned'/
// 'expired' are all terminal failures (banned = input violated content
// policy, expired = output no longer available) -- recorded as 'failed'
// so a stuck 'processing' row doesn't linger forever. 'queued'/'running'
// leave the row as-is, handled by callers as "nothing to resolve yet".
const TRIPO_TERMINAL_FAILURE_STATUSES = new Set(['failed', 'cancelled', 'banned', 'expired']);

// Shared by the webhook and the status-poll fallback below, so "a job
// finishes but the webhook is slow or never arrives" doesn't leave it
// stuck. The atomic `processed_at IS NULL` guard is the same idiom
// applyDiditDecision (worker/lib/didit.js) uses -- whichever of the
// webhook or a poll gets there first applies the result; the other is a
// safe no-op.
async function applyTripoTaskResult(db, env, jobId, task) {
  if (task.status === 'success') {
    // #2226: sibling case to the #1673 catch below -- Tripo can also report
    // success with the output/model_url missing entirely (not just an
    // output URL that fails to download). Without marking the job failed
    // here too, this left the row stuck at status='processing' until the
    // cron sweep's own generic "timed out" message, since the thrown error
    // below was never caught by either caller (the webhook handler, or the
    // status-poll path).
    if (!task?.output?.model_url) {
      await db.prepare(`
        UPDATE video_generation_jobs SET status = 'failed', error_message = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE job_id = ? AND processed_at IS NULL
      `).bind('Video-to-3D provider reported success with no output file', jobId).run();
      return;
    }
    // Fetching/storing happens before the atomic claim below (unlike
    // applyDiditDecision, which has no slow step) -- a race between the
    // webhook and a poll can therefore both redundantly store the same
    // content-addressed object, which is harmless (identical bytes,
    // identical key, env.MODELS.head's own dedup check above), rather
    // than risking only a losing caller's unused upload ever reaching R2.
    //
    // #1673: storeTripoModelOutput can throw (Tripo's own output URL is
    // third-party and time-limited -- its own comment says so -- plus any
    // transient download failure or a GLB that fails validateGlb). Without
    // this catch, that exception propagated straight up to the caller and
    // the row below never got updated -- left at status='processing' until
    // expireStaleVideoGenerationJobs' cron sweep eventually caught it (up to
    // ~25 min later) with a misleading generic "timed out" message, instead
    // of failing immediately with the real cause.
    let stored;
    try {
      stored = await storeTripoModelOutput(env, task.output.model_url);
    } catch {
      await db.prepare(`
        UPDATE video_generation_jobs SET status = 'failed', error_message = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE job_id = ? AND processed_at IS NULL
      `).bind('Failed to retrieve the generated model — please try again', jobId).run();
      return;
    }
    await db.prepare(`
      UPDATE video_generation_jobs SET status = 'complete', model_url = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE job_id = ? AND processed_at IS NULL
    `).bind(stored.modelUrl, jobId).run();
    return;
  }
  if (TRIPO_TERMINAL_FAILURE_STATUSES.has(task.status)) {
    await db.prepare(`
      UPDATE video_generation_jobs SET status = 'failed', error_message = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE job_id = ? AND processed_at IS NULL
    `).bind(`Video generation ${task.status} — please try a different video`, jobId).run();
  }
}

// #1619: a job that never reaches a terminal status on Tripo's side
// (provider silence, a dropped webhook with no further poll ever
// arriving) would otherwise sit in 'processing' forever -- nothing else
// ever revisits it once handleVideoGenerationJobCreate's own 201 response
// has gone out. Mirrors pruneStaleAvatarPresence's own cutoff-sweep shape
// (worker/index.js), called from scheduled() on the existing cron. 15
// minutes is a generous multiple of the ~2-minute typical completion time
// (see VIDEO_GENERATION_STATUS_RATE_LIMIT_MAX's own comment above) --
// long enough that a merely-slow job never gets falsely failed, short
// enough that a genuinely stuck one doesn't block its builder's
// one-pending-per-builder slot (idx_video_generation_jobs_one_pending_per_builder)
// indefinitely. Scoped to 'processing' specifically -- a job still
// 'pending' (died between the reservation and ever reaching Tripo) is a
// different crash class, handled instead by reserveVideoGenerationJob's
// own per-caller stale-placeholder cleanup (#1782) -- handleVideoGenerationJobCreate's
// catch block alone only covers a thrown-exception crash, not a harder
// kill (CPU limit, isolate eviction) that never reaches it.
const VIDEO_GENERATION_PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;

export async function expireStaleVideoGenerationJobs(db) {
  const cutoff = new Date(Date.now() - VIDEO_GENERATION_PROCESSING_TIMEOUT_MS).toISOString();
  await db.prepare(`
    UPDATE video_generation_jobs
    SET status = 'failed', error_message = 'Video generation timed out — please try again', processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status = 'processing' AND processed_at IS NULL AND created_at < ?
  `).bind(cutoff).run();
}

// Shared by handleVideoGenerationJobStatus (poll the current job's task)
// and the webhook below, so a slow/missing webhook doesn't leave a
// builder stuck reading "processing" forever.
async function reconcileVideoGenerationJob(env, db, job) {
  if (!tripoConfigured(env)) return;
  const task = await tripoRequest(env, 'GET', `tasks/${encodeURIComponent(job.provider_task_id)}`);
  await applyTripoTaskResult(db, env, job.job_id, task);
}

// Accepts a few still frames extracted client-side from the seller's
// walkaround video (no provider evaluated by #1617 accepts raw video
// directly, and Cloudflare Workers has no video-decoding capability to
// extract frames server-side) and kicks off an async Tripo
// multiview-to-model job. Tracking the job to completion is
// handleVideoGenerationJobStatus/handleVideoGenerationWebhook's job, not
// this one.
export async function handleVideoGenerationJobCreate(request, env, db) {
  const sessionBuilder = await requireSessionBuilder(request, db);

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    throw new HttpError('Expected multipart/form-data', 415);
  }
  const form = await request.formData().catch(() => {
    throw new HttpError('Request body is not valid multipart/form-data', 400);
  });

  // Front is required (Tripo rejects a job without it); at least one more
  // view is required too (Tripo rejects a job with fewer than 2 images).
  // Validated before the "is this configured" check below, so a malformed
  // request always gets a real, specific 400/413/415 rather than being
  // masked by a 503 -- same convention POST /api/catalog/concept-image's
  // own prompt-length check already establishes.
  const views = VIDEO_GENERATION_VIEWS
    .map((view) => [view, form.get(view)])
    .filter(([, file]) => file && typeof file.arrayBuffer === 'function');
  if (!views.some(([view]) => view === 'front')) {
    throw new HttpError('A "front" view image is required', 400);
  }
  if (views.length < 2) {
    throw new HttpError('At least 2 view images are required (front plus at least one of left/back/right)', 400);
  }
  for (const [, file] of views) {
    if (file.size > MAX_VIDEO_GENERATION_FRAME_BYTES) {
      throw new HttpError(`Image is ${formatBytes(file.size)}, over the ${formatBytes(MAX_VIDEO_GENERATION_FRAME_BYTES)} limit`, 413);
    }
    if (!VIDEO_GENERATION_IMAGE_TYPES.includes(file.type)) {
      throw new HttpError('Each view image must be PNG, JPEG, or WebP', 415);
    }
    // #1713: file.type is only the client's claimed Content-Type for this
    // multipart part -- check the real magic bytes before this ever reaches
    // Tripo, same posture as validateGlb/decodeThumbnailDataUrl.
    if (!hasValidImageSignature(await file.arrayBuffer(), file.type)) {
      throw new HttpError('Each view image must be a real PNG, JPEG, or WebP file', 415);
    }
  }

  if (!tripoConfigured(env)) {
    throw new HttpError('Video-to-3D generation is not configured on this server yet.', 503);
  }
  // #1783: a repeat call while a job is already in flight is the common
  // case, not the rare one -- the frontend's own disabled-button guard
  // resets on a page reload, so a builder waiting out a ~2-minute Tripo
  // job can easily re-trigger this several times. Checking for one here,
  // before the real-cost rate limit below, means that never charges it --
  // same shape as handleDiditVerificationSession's own latestDiditSession
  // pre-check (worker/lib/didit.js), which resolves an already-pending
  // session via a separate, cheaper bucket before its real-cost
  // didit-session: one is ever reached. (reserveVideoGenerationJob's own
  // dedup branch below still exists to atomically catch a genuine
  // concurrent-race double-submit this pre-check can't see -- same
  // residual gap Didit's own reserveDiditSession has for the identical
  // reason.)
  const latest = await latestVideoGenerationJob(db, sessionBuilder.builder_id);
  if (latest && latest.processed_at === null && !isStaleVideoGenerationReservation(latest)) {
    return json({ jobId: latest.job_id, status: latest.status });
  }
  await checkRateLimit(db, `video-generation:${sessionBuilder.builder_id}`, VIDEO_GENERATION_RATE_LIMIT_MAX);
  // #1993: alongside (not instead of) the rate limit above -- the rate
  // limit still guards against abuse of a large credit balance, this
  // guards against spending credits the builder doesn't have. Folding the
  // balance check into the UPDATE's own WHERE clause makes "is there a
  // credit" and "spend it" one atomic statement, the same race-safe shape
  // checkRateLimit's own INSERT...WHERE uses just above.
  const creditSpent = await db.prepare(
    'UPDATE builders SET video_generation_credits = video_generation_credits - 1 WHERE builder_id = ? AND video_generation_credits > 0',
  ).bind(sessionBuilder.builder_id).run();
  if (creditSpent.meta.changes === 0) {
    throw new HttpError(VIDEO_GENERATION_NO_CREDITS_MESSAGE, 402);
  }
  const { reservationId, existing } = await reserveVideoGenerationJob(db, sessionBuilder.builder_id);
  if (!reservationId) {
    // Lost a genuine concurrent race against another request for this
    // same builder -- hand back that one instead of ever calling Tripo.
    // #1993: no new job actually started here, so the credit spent above
    // was never really used -- refund it rather than charging a request
    // that just relayed an already-in-flight job's own status.
    await db.prepare('UPDATE builders SET video_generation_credits = video_generation_credits + 1 WHERE builder_id = ?')
      .bind(sessionBuilder.builder_id).run();
    // #2485: `existing` is a separate, later query than the INSERT's own
    // NOT EXISTS check above, so by the time it runs the row it's reading
    // may no longer be the still-in-flight job that check saw -- it can be
    // gone entirely (deleted in between), or already resolved
    // (processed_at set by a concurrent completion) while this request was
    // still mid-flight. Handing back a resolved job's own stale status
    // here would make pollVideoGenerationJob load an old, already-consumed
    // result into the upload wizard for free -- a clean 409 (credit
    // already refunded above) tells the client to retry, and the `latest`
    // check at the top of this handler reports the real current state
    // next time.
    if (!videoGenerationReservationStillUsable(existing)) {
      throw new HttpError('A video-generation job is already starting -- please try again in a moment', 409);
    }
    return json({ jobId: existing.job_id, status: existing.status });
  }

  // #1886 (piece 1): set only once the billed tripoRequest call has
  // actually returned a real task_id -- lets the catch below tell "the
  // outbound call itself failed" (never billed, or at least no task_id in
  // hand) apart from "the billed call succeeded but persisting its result
  // failed," which needs a durable record rather than a silent delete.
  let billedTaskId = null;
  try {
    const inputs = [];
    for (const [view, file] of views) {
      const bytes = await file.arrayBuffer();
      const fileToken = await tripoUploadFile(env, bytes, file.name || `${view}.png`, file.type);
      inputs.push({ [view]: fileToken });
    }
    const task = await tripoRequest(env, 'POST', 'generation/multiview-to-model', {
      inputs,
      model: TRIPO_MODEL_VERSION,
    });
    if (!task?.task_id) {
      throw new HttpError('Video-to-3D job creation failed — please try again', 502);
    }
    billedTaskId = task.task_id;
    await db.prepare(`
      UPDATE video_generation_jobs SET provider_task_id = ?, status = 'processing' WHERE job_id = ?
    `).bind(task.task_id, reservationId).run();
    return json({ jobId: reservationId, status: 'processing' }, 201);
  } catch (err) {
    // #1886 (piece 1 -- making the failure loud, not the still-open retry/
    // cost policy, which stays owner-judgment): if billedTaskId is set, the
    // outbound call didn't fail -- only persisting its result did (a
    // transient D1 write error; a hard kill between the two never reaches
    // this catch at all, see reserveVideoGenerationJob's own stale-sweep
    // logging above for that case instead). Deleting the reservation below
    // either way (so this builder isn't permanently blocked) would
    // otherwise discard the only local record that a real, billed
    // generation is now untracked -- log it durably first.
    if (billedTaskId) {
      await adminActionLogStatement(db, null, 'video_generation_task_id_lost', 'video_generation_job', reservationId, {
        builderId: sessionBuilder.builder_id,
        providerTaskId: billedTaskId,
        error: err instanceof Error ? err.message : String(err),
      }).run();
    }
    // The outbound call itself failed (or a later view's upload failed
    // after an earlier one succeeded) -- release the reservation so it
    // doesn't permanently block this builder from ever starting a video-
    // to-3D job again.
    await db.prepare('DELETE FROM video_generation_jobs WHERE job_id = ?').bind(reservationId).run();
    // #1993: if the billed call never went out (or never got a real
    // task_id back), the credit spent above paid for nothing -- refund it.
    // If it's already billed, the credit was legitimately spent regardless
    // of what happened after (same "billed means billed" reasoning the
    // #1886/#1935 durable-logging above already applies).
    if (!billedTaskId) {
      await db.prepare('UPDATE builders SET video_generation_credits = video_generation_credits + 1 WHERE builder_id = ?')
        .bind(sessionBuilder.builder_id).run();
    }
    throw err;
  }
}

// Polling fallback for the frontend while a job is in flight: reconciles
// directly against Tripo's own task-status endpoint whenever the
// builder's job is still locally pending, rather than requiring the
// webhook to have already landed.
export async function handleVideoGenerationJobStatus(request, env, db, jobId) {
  const sessionBuilder = await requireSessionBuilder(request, db);
  const job = await db.prepare('SELECT * FROM video_generation_jobs WHERE job_id = ?').bind(jobId).first();
  if (!job) throw new HttpError('Video-to-3D job not found', 404);
  assertOwner(job.builder_id, sessionBuilder.builder_id, 'This video-to-3D job belongs to a different builder.');
  if (job.processed_at !== null) {
    return json({ jobId: job.job_id, status: job.status, modelUrl: job.model_url, error: job.error_message });
  }
  if (!job.provider_task_id) {
    // Still mid-creation, or the create call died before ever reaching
    // Tripo -- nothing to reconcile against yet.
    return json({ jobId: job.job_id, status: job.status });
  }
  await checkRateLimit(db, `video-generation-status:${sessionBuilder.builder_id}`, VIDEO_GENERATION_STATUS_RATE_LIMIT_MAX);
  await reconcileVideoGenerationJob(env, db, job);
  const refreshed = await db.prepare('SELECT * FROM video_generation_jobs WHERE job_id = ?').bind(jobId).first();
  return json({ jobId: refreshed.job_id, status: refreshed.status, modelUrl: refreshed.model_url, error: refreshed.error_message });
}

// Tripo signs each webhook delivery with an HMAC-SHA256 of
// `${t}.${rawBody}` (https://developers.tripo3d.com/en/docs/webhooks),
// keyed by a webhook-specific secret -- verified here via a constant-time
// hex comparison (timingSafeEqual, already used elsewhere in this file
// for password/token/Didit-signature checks), never a plain ===. Reads
// the raw body text (not readJson) because the signature is computed
// over the exact bytes Tripo sent, not this codebase's own
// re-serialization of a parsed object.
//
// #1659: same `t=...,v1=...` scheme as the Stripe webhook
// (worker/lib/stripe.js), so it needs the identical timestamp-tolerance
// check (see that module's own STRIPE_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
// comment, #872) -- without it, a captured-but-still-valid delivery could
// be replayed indefinitely.
const TRIPO_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export async function handleVideoGenerationWebhook(request, env, db) {
  if (!env.TRIPO_WEBHOOK_SECRET) throw new HttpError('Video-to-3D webhook is not configured on this server yet.', 503);
  const rawBody = await request.text();
  const signatureHeader = request.headers.get('tripo-webhook-signature') || '';
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(signatureHeader);
  if (!match) throw new HttpError('Invalid webhook signature', 401);
  const [, timestamp, signature] = match;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.TRIPO_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const expectedSignature = bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`))));
  if (!timingSafeEqual(signature, expectedSignature)) {
    throw new HttpError('Invalid webhook signature', 401);
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TRIPO_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    throw new HttpError('Invalid webhook signature', 401);
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new HttpError('Webhook body is not valid JSON', 400);
  }
  const taskId = payload?.data?.task_id;
  const status = payload?.data?.status;
  if (!taskId || !status) return json({ received: true });
  const job = await db.prepare('SELECT * FROM video_generation_jobs WHERE provider_task_id = ?').bind(taskId).first();
  if (!job || job.processed_at !== null) return json({ received: true });
  await applyTripoTaskResult(db, env, job.job_id, payload.data);
  return json({ received: true });
}
