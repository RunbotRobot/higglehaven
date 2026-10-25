// #2541 (sub-issue of #2502, itself sub-issue of #2500's worker/index.js
// module split): government-ID verification via Didit (#589, sub-issue of
// #556, docs/SPEC.md §6) -- the session-create/status-poll/webhook route
// handlers plus every helper exclusively used by them. Extracted verbatim,
// zero behavior change.
//
// Deliberately NOT included here: appBaseUrl -- it's genuinely shared well
// beyond this file (email verification, password reset, dispute-delivery
// confirmation), not Didit-specific, so it stays in worker/index.js and is
// imported back below -- same shape worker/lib/builder-profile.js's own
// comment documents for its own templateFromRow/recomputeLandCap imports
// (#2535).
import { json, HttpError } from './http.js';
import { timingSafeEqual, bytesToHex } from './crypto.js';
import { checkRateLimit } from './rate-limit.js';
import { requireCurrentUser } from './auth.js';
import { adminActionLogStatement } from './admin-log.js';
import { appBaseUrl } from '../index.js';

// ---- Government-ID verification via Didit (#589, sub-issue of #556,
// docs/SPEC.md §6) — the higher trust tier that gates full social
// features, above the credit-card tier card-setup-intent/confirm-card
// (worker/lib/stripe.js) establish. Same guarded-secret shape as
// STRIPE_SECRET_KEY/OPENAI_API_KEY (worker/index.js): with env.DIDIT_API_KEY
// unset (never configured in local dev or the automated test suite),
// diditConfigured(env) is false and the route handlers below return a real
// 503 rather than attempting a live network call.
function diditConfigured(env) {
  return !!env.DIDIT_API_KEY && !!env.DIDIT_WORKFLOW_ID;
}

// Didit's Verification Session API (https://docs.didit.me/) — a plain
// bearer-style API-key header and a JSON body, simpler than Stripe's
// Basic-auth-with-empty-password + form-encoded shape (worker/lib/stripe.js).
async function diditRequest(env, method, path, body) {
  const response = await fetch(`https://verification.didit.me/${path}`, {
    method,
    headers: { 'x-api-key': env.DIDIT_API_KEY, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  // #2486: .catch(() => null), same as tripoRequest/tripoUploadFile
  // (worker/lib/video-generation.js) -- an upstream gateway error page
  // makes response.json() itself throw before the !response.ok check below
  // ever runs, otherwise surfacing as an uncaught 500 instead of this
  // function's own intended 502/400.
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new HttpError(data?.message || 'Didit request failed', response.status >= 500 ? 502 : 400);
  }
  return data;
}

// A real (if small — $0.33/verification beyond Didit's 500/month free
// tier, per #589's own research) per-call cost, same reasoning as
// CONCEPT_IMAGE_RATE_LIMIT_MAX (worker/index.js) — bucketed per-user since
// this is a session-gated action, not a public/anonymous endpoint an
// IP-based bucket would need to cover.
const DIDIT_SESSION_RATE_LIMIT_MAX = 10;
// #1037: handleDiditVerificationStatus below forwards straight through to a
// live outbound Didit API call whenever the caller's latest session is
// still pending, with no local throttle before this fix -- the same
// "unrate-limited third-party call" gap #839 fixed for purchase finalize.
// Sized around the legitimate client cadence (pollDiditVerificationStatus,
// src/main.js: every 3s for up to 5 minutes, ~100 calls per verification
// attempt), with headroom for a retry or two inside the same 15-minute
// RATE_LIMIT_WINDOW_MS rather than the tighter ~20 this file's ordinary
// one-shot mutations use.
const DIDIT_STATUS_RATE_LIMIT_MAX = 120;

// If the Worker is interrupted between Didit's session-create call
// succeeding and the UPDATE that records its real session_id below (an
// isolate eviction, a network drop mid-await -- anything short of a thrown
// JS exception, which the try/catch around that sequence already handles),
// the reservation is left behind forever with only its local placeholder
// id ('pending-<uuid>') and processed_at still NULL. Every later attempt
// then reconciles against Didit using that fake id (reconcileDiditSession
// below), which Didit will never recognize, and
// idx_didit_verification_sessions_one_pending_per_user blocks a fresh
// reservation from ever being created for this user again -- a permanent
// lockout with no self-healing path. Comfortably above how long a Didit
// session-create call should ever take, matching the reasoning
// MODEL_UPLOAD_RESERVATION_TIMEOUT_MS (worker/index.js) already uses for
// the identical "claimed, then abandoned mid-flight" shape on model
// uploads.
const DIDIT_RESERVATION_TIMEOUT_MS = 5 * 60 * 1000;

// Shared by handleDiditVerificationSession (dedup an already-pending
// session rather than starting a real-cost new one) and
// handleDiditVerificationStatus (poll the current one) — both need the
// same "most recent session row for this user" lookup.
export async function latestDiditSession(db, userId) {
  return db.prepare(`
    SELECT * FROM didit_verification_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
  `).bind(userId).first();
}

// #2485: reserveDiditSession's own race-loser `existing` row (read in a
// separate, later query than the INSERT's own NOT EXISTS check that lost)
// isn't automatically still the same still-in-flight session that check
// saw -- it can be gone entirely (deleted in between), already resolved
// (processed_at set by a concurrent webhook/poll), or still just a local
// 'pending-<uuid>' placeholder with no real url to hand back yet. Exported
// (same reasoning as latestDiditSession/reserveDiditSession just above --
// DIDIT_API_KEY is deliberately never configured for a real HTTP request
// in the test files exercising handleDiditVerificationSession) so this
// guard's own logic can be tested directly without a live network call.
export function diditReservationStillUsable(existing) {
  return !!existing && existing.processed_at === null && !existing.session_id.startsWith('pending-');
}

// Starts a fresh Didit-hosted verification session for the requesting
// builder and records it so the webhook/status-poll below have a row to
// resolve against.
export async function handleDiditVerificationSession(request, env, db) {
  const user = await requireCurrentUser(request, db);
  if (user.trust_tier === 'id_verified') {
    throw new HttpError('This account is already ID-verified.', 400);
  }
  if (!diditConfigured(env)) {
    throw new HttpError('Government-ID verification is not configured on this server yet.', 503);
  }
  // #607: idx_didit_verification_sessions_user_id's own migration comment
  // says this table is "looked up by user_id when starting a new session
  // (to reuse/report an already-pending one)" — that lookup never
  // actually happened, so a re-click of "Verify ID" (or two open tabs)
  // started a brand new, real-cost Didit session every time instead of
  // handing back the one still in flight.
  const latest = await latestDiditSession(db, user.user_id);
  // A still-local placeholder (session_id still 'pending-<uuid>') was never
  // actually told to Didit -- reusing it here would hand the client a
  // sessionId with no real url to open (reconcileDiditSession now reports
  // it as 'pending' rather than throwing, see its own comment, but that
  // status alone isn't something this caller can act on the way it can for
  // a real session). Falling through to reserveDiditSession below is what
  // actually resolves this: either it's still genuinely in-flight (a
  // concurrent request already holds it, same race #1039 already handles)
  // or it's aged out and reserveDiditSession's own cleanup clears the way
  // for a real fresh reservation.
  if (latest && latest.processed_at === null && !latest.session_id.startsWith('pending-')) {
    // #1038: a merely locally-pending session can already be dead on
    // Didit's side -- expired, abandoned, or (rarer) actually approved --
    // if the webhook never landed and the builder never returned to
    // trigger a status poll. Reconcile it the same way
    // handleDiditVerificationStatus already does before trusting it,
    // rather than handing back a session URL that's aged out, or starting
    // a redundant new session below for an account that just turned out
    // to already be verified. Same rate-limit bucket as that endpoint's
    // own reconciliation call, since this hits the identical Didit
    // decision endpoint -- not the real-cost session-create call below.
    await checkRateLimit(db, `didit-status:${user.user_id}`, DIDIT_STATUS_RATE_LIMIT_MAX);
    const status = await reconcileDiditSession(env, db, latest, user.user_id);
    if (status === 'pending') {
      return json({ sessionId: latest.session_id, url: latest.url });
    }
    if (status === 'approved') {
      throw new HttpError('This account is already ID-verified.', 400);
    }
    // status === 'declined' -- this session is dead, fall through and
    // start a fresh one below.
  }
  await checkRateLimit(db, `didit-session:${user.user_id}`, DIDIT_SESSION_RATE_LIMIT_MAX);
  // #1039: reserved atomically before ever calling Didit's real, billed
  // session-create API -- without this, two concurrent requests (a
  // double-click, or two open tabs) that both observed no pending session
  // just above would both reach the outbound call and both get billed.
  // Same "claim first, only the winner calls out" idiom
  // claimOrResumeBuilderRedemption (#852, worker/index.js) already uses
  // for Stripe.
  const { reservationId, existing } = await reserveDiditSession(db, user.user_id);
  if (!reservationId) {
    // Lost the race -- a concurrent request already reserved this user's
    // pending session; hand back that one instead of ever calling Didit.
    // #2485: `existing` is a separate, later query than the INSERT's own
    // NOT EXISTS check above, so by the time it runs the row it's reading
    // may no longer be the still-in-flight one that check saw -- it can be
    // gone entirely (deleted in between), already resolved (processed_at
    // set by a concurrent webhook/poll), or still just this function's own
    // local 'pending-<uuid>' placeholder with no real url yet to hand
    // back. None of those are safe to report as "here's your in-flight
    // session" -- a clean 409 tells the client to retry, and the `latest`
    // check at the top of this handler resolves correctly next time
    // regardless of which of those states it turns out to be.
    if (!diditReservationStillUsable(existing)) {
      throw new HttpError('A verification session is already starting -- please try again in a moment', 409);
    }
    return json({ sessionId: existing.session_id, url: existing.url });
  }
  // #1886/#2313 (porting the same durable-logging fix from the identical
  // reservation shape on the Tripo side, handleVideoGenerationJobCreate):
  // set only once the billed diditRequest call has actually returned a
  // real session_id -- lets the catch below tell "the outbound call itself
  // failed" (never billed, or at least no session_id in hand) apart from
  // "the billed call succeeded but persisting its result failed," which
  // needs a durable record rather than a silent delete.
  let billedSessionId = null;
  try {
    const session = await diditRequest(env, 'POST', 'v3/session/', {
      workflow_id: env.DIDIT_WORKFLOW_ID,
      vendor_data: user.user_id,
      callback: `${appBaseUrl(env)}/?diditReturn=1`,
    });
    // #1563: same response-shape validation generateConceptImageBytes/
    // fetchTax1099EfilingToken (#1548) already do for their own third-party
    // JSON -- without it, an unexpected 2xx body binds undefined into
    // session_id's TEXT PRIMARY KEY below, which D1 throws on synchronously,
    // surfacing as a generic 500 instead of this clean 502.
    if (!session?.session_id || !session?.url) {
      throw new HttpError('Didit session creation failed — please try again', 502);
    }
    billedSessionId = session.session_id;
    // The reservation's own session_id was only ever a local placeholder --
    // nothing external has referenced it, so overwriting it with Didit's
    // real one (along with the url a reused session needs, #607) is safe.
    await db.prepare(`
      UPDATE didit_verification_sessions SET session_id = ?, url = ? WHERE session_id = ?
    `).bind(session.session_id, session.url, reservationId).run();
    return json({ sessionId: session.session_id, url: session.url });
  } catch (err) {
    // #1886/#2313: if billedSessionId is set, the outbound call didn't
    // fail -- only persisting its result did (a transient D1 write error;
    // a hard kill between the two never reaches this catch at all, see
    // reserveDiditSession's own stale-sweep logging above for that case
    // instead). Deleting the reservation below either way (so this user
    // isn't permanently blocked) would otherwise discard the only local
    // record that a real, billed session is now untracked -- log it
    // durably first.
    if (billedSessionId) {
      await adminActionLogStatement(db, null, 'didit_session_id_lost', 'user', user.user_id, {
        providerSessionId: billedSessionId,
        error: err instanceof Error ? err.message : String(err),
      }).run();
    }
    // The outbound call itself failed (or Didit isn't configured) --
    // release the reservation so it doesn't permanently block this user
    // from ever starting verification again.
    await db.prepare('DELETE FROM didit_verification_sessions WHERE session_id = ?').bind(reservationId).run();
    throw err;
  }
}

// Exported for direct testing, the same reasoning latestDiditSession's own
// callers already rely on -- DIDIT_API_KEY is never configured in any test
// file (deliberately, per worker/didit-verification.test.js's own top
// comment), so handleDiditVerificationSession itself always 503s before
// ever reaching this far through a real HTTP request.
export async function reserveDiditSession(db, userId) {
  // DIDIT_RESERVATION_TIMEOUT_MS's own comment above: a placeholder left
  // behind by a crash between Didit's session-create call succeeding and
  // the local UPDATE that records its real id never resolves on its own --
  // nothing ever calls Didit with the right id again to find out it's
  // done. Clearing out this user's own stale placeholder first (scoped to
  // them, not a global sweep -- unlike model uploads' shared R2 budget,
  // one user's stuck row costs nothing but that same user's own ability to
  // retry) lets the NOT EXISTS guard below admit a genuinely fresh
  // reservation instead of blocking on a reservation nothing will ever
  // resolve.
  //
  // #1886/#2313 (porting the same durable-logging fix from the identical
  // reservation shape on the Tripo side, reserveVideoGenerationJob,
  // worker/lib/video-generation.js): a row swept here might be exactly the
  // residual gap DIDIT_RESERVATION_TIMEOUT_MS's own comment documents -- a
  // real, billed Didit call whose result never got persisted. Log every
  // sweep that actually removes a row, durably, rather than only ever
  // being reconstructable by reading code.
  const staleCleanup = await db.prepare(`
    DELETE FROM didit_verification_sessions
    WHERE user_id = ? AND processed_at IS NULL AND session_id LIKE 'pending-%' AND created_at < ?
  `).bind(userId, new Date(Date.now() - DIDIT_RESERVATION_TIMEOUT_MS).toISOString()).run();
  if (staleCleanup.meta.changes > 0) {
    await adminActionLogStatement(db, null, 'didit_stale_reservation_swept', 'user', userId, {
      rowsDeleted: staleCleanup.meta.changes,
      reservationTimeoutMs: DIDIT_RESERVATION_TIMEOUT_MS,
    }).run();
  }
  const reservationId = `pending-${crypto.randomUUID()}`;
  const result = await db.prepare(`
    INSERT INTO didit_verification_sessions (session_id, user_id, status)
    SELECT ?, ?, 'pending'
    WHERE NOT EXISTS (
      SELECT 1 FROM didit_verification_sessions WHERE user_id = ? AND processed_at IS NULL
    )
  `).bind(reservationId, userId, userId).run();
  if (result.meta.changes === 0) {
    return { reservationId: null, existing: await latestDiditSession(db, userId) };
  }
  return { reservationId, existing: null };
}

// Didit's own decision statuses (https://docs.didit.me/): 'Approved' is
// the only one that raises trust_tier; every other terminal status
// ('Declined', 'Abandoned', 'Expired', 'Kyc Expired') is recorded as
// declined so a stuck 'pending' row doesn't linger forever — a builder can
// always just start a fresh session afterward. 'In Review'/'In Progress'
// leave the row pending (absent from this map, handled by callers as
// "nothing to resolve yet").
const DIDIT_TERMINAL_STATUSES = { Approved: true, Declined: false, Abandoned: false, Expired: false, 'Kyc Expired': false };

// Shared by the webhook and the status-poll fallback below, so "a builder
// finishes verification but the webhook is slow or never arrives" doesn't
// leave them stuck. The atomic `processed_at IS NULL` guard is the same
// idiom this file already uses for purchases.paid_out_at — whichever of
// the webhook or a poll gets there first applies the change; the other is
// a safe no-op, so this can't double-apply from a race or a repeat
// webhook delivery.
// #2484: the session claim and the trust_tier raise used to be two
// sequential awaited .run() calls -- an interruption between them (a
// transient D1 error, or the isolate hitting a CPU/time limit) could leave
// processed_at already set with trust_tier never raised, and since every
// retry's own claim above short-circuits on processed_at IS NOT NULL, that
// stranded state had no retry path at all. Batched into one D1 transaction
// (same shape as #2174) so the two writes can no longer split. The users
// UPDATE's own EXISTS guard reads the session row *as this same batch just
// left it* (D1 batch statements run sequentially within one transaction),
// so it only fires when this call's own claim actually landed (or had
// already landed from an earlier, fully-completed call -- a replayed
// webhook re-applying the same value is a safe no-op either way); it's
// only ever included in the batch when `approved` is true in the first
// place, so a decline never reaches it.
async function applyDiditDecision(db, sessionId, userId, approved) {
  const statements = [
    db.prepare(`
      UPDATE didit_verification_sessions SET status = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE session_id = ? AND processed_at IS NULL
    `).bind(approved ? 'approved' : 'declined', sessionId),
  ];
  if (approved) {
    statements.push(db.prepare(`
      UPDATE users SET trust_tier = 'id_verified', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE user_id = ? AND EXISTS (
        SELECT 1 FROM didit_verification_sessions WHERE session_id = ? AND status = 'approved' AND processed_at IS NOT NULL
      )
    `).bind(userId, sessionId));
  }
  await db.batch(statements);
}

// Shared by handleDiditVerificationStatus (poll the current session) and
// handleDiditVerificationSession (#1038: reconcile a reused pending session
// before trusting it) -- both need to check a still-locally-pending session
// against Didit's own decision endpoint and apply any terminal outcome the
// same way the webhook does. Returns the resulting status
// ('approved'/'declined'/'pending'), or the session's own already-local
// status unchanged if Didit isn't configured to check.
export async function reconcileDiditSession(env, db, latest, userId) {
  // DIDIT_RESERVATION_TIMEOUT_MS's own comment: a session_id that's still
  // its own local placeholder was never actually told to Didit, so asking
  // Didit about it can only ever fail (it recognizes no such session) --
  // every caller reaching this function from a still-pending `latest` row
  // was treating that failure as an uncaught exception before this guard.
  // Reported as 'pending' (its own real, current status) rather than
  // throwing; reserveDiditSession's own stale-placeholder cleanup is what
  // actually unblocks a genuinely abandoned one, not this function.
  if (latest.session_id.startsWith('pending-')) return 'pending';
  if (!diditConfigured(env)) return latest.status;
  const decision = await diditRequest(env, 'GET', `v3/session/${encodeURIComponent(latest.session_id)}/decision/`);
  const overallStatus = decision.status;
  if (!Object.prototype.hasOwnProperty.call(DIDIT_TERMINAL_STATUSES, overallStatus)) {
    return 'pending';
  }
  const approved = DIDIT_TERMINAL_STATUSES[overallStatus];
  await applyDiditDecision(db, latest.session_id, userId, approved);
  return approved ? 'approved' : 'declined';
}

// Polling fallback for the frontend after a builder returns from Didit's
// hosted verification UI: reconciles directly against Didit's own session
// endpoint whenever a builder's latest session is still locally pending,
// rather than requiring the webhook to have already landed.
export async function handleDiditVerificationStatus(request, env, db) {
  const user = await requireCurrentUser(request, db);
  if (user.trust_tier === 'id_verified') return json({ status: 'approved' });
  const latest = await latestDiditSession(db, user.user_id);
  if (!latest) return json({ status: 'none' });
  if (latest.processed_at !== null) {
    return json({ status: latest.status });
  }
  // #1037: rate-limited before the diditConfigured check inside
  // reconcileDiditSession (not after), same ordering #839 already
  // established for handlePurchaseFinalize's own "unrate-limited
  // third-party call" fix — this way the guard still applies to every
  // still-pending poll regardless of whether Didit happens to be
  // configured, rather than only in production. Nothing to rate-limit yet
  // if processed_at is already set above: no outbound call would ever
  // happen for a session that's no longer pending.
  await checkRateLimit(db, `didit-status:${user.user_id}`, DIDIT_STATUS_RATE_LIMIT_MAX);
  const status = await reconcileDiditSession(env, db, latest, user.user_id);
  return json({ status });
}

// Didit signs its webhook deliveries with an HMAC-SHA256 of the raw body,
// keyed by a webhook-specific secret configured in the Didit dashboard —
// verified here via a constant-time hex comparison (timingSafeEqual,
// already used elsewhere in this file for password/token checks), never a
// plain ===, so response timing can't leak how close a forged signature
// got. Reads the raw body text (not readJson) because the signature is
// computed over the exact bytes Didit sent, not this codebase's own
// re-serialization of a parsed object.
export async function handleDiditWebhook(request, env, db) {
  if (!env.DIDIT_WEBHOOK_SECRET) throw new HttpError('Didit webhook is not configured on this server yet.', 503);
  const rawBody = await request.text();
  const signatureHeader = request.headers.get('x-signature') || '';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.DIDIT_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const expectedSignature = bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))));
  if (!timingSafeEqual(signatureHeader, expectedSignature)) {
    throw new HttpError('Invalid webhook signature', 401);
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new HttpError('Webhook body is not valid JSON', 400);
  }
  const sessionId = payload.session_id;
  const overallStatus = payload.status;
  if (!sessionId || !Object.prototype.hasOwnProperty.call(DIDIT_TERMINAL_STATUSES, overallStatus)) {
    return json({ received: true });
  }
  const session = await db.prepare('SELECT * FROM didit_verification_sessions WHERE session_id = ?').bind(sessionId).first();
  if (!session) return json({ received: true });
  await applyDiditDecision(db, sessionId, session.user_id, DIDIT_TERMINAL_STATUSES[overallStatus]);
  return json({ received: true });
}
