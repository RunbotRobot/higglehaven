// #2501: fixed-window rate limiting (migrations/0057), used from 67
// distinct handle* route handlers (plus checkAccessGate) across auth,
// commerce, and admin endpoints alike -- extracted verbatim, zero
// behavior change. RATE_LIMIT_WINDOW_MS is exported too since worker/
// index.js's own pruneExpiredAuthState (the sweep that deletes expired
// rate_limit_events rows) shares this same window constant.
import { HttpError } from './http.js';

// Fixed-window rate limiting for the auth endpoints that are both
// unauthenticated and repeatable and (once RESEND_API_KEY is configured)
// can trigger a real outbound email to an arbitrary address: signup and
// password-reset-request. Login already has its own real per-account
// lockout (failed_login_attempts/locked_until, worker/index.js).
// resend-verification (#363) is session-gated rather than IP+email
// bucketed like the two above — it doesn't have an arbitrary-address
// enumeration angle to guard against, but still needs a cap keyed by the
// caller's own user id, or one logged-in user could loop it indefinitely.
//
// Bucketed by client IP + the specific email being targeted, not IP alone
// — this limits hammering one target from one source without any new
// Cloudflare bindings, and (deliberately) means the existing test suite's
// per-case unique emails never collide with each other in the same D1.
// Deliberately scoped: this stops targeted retry/harassment of one email
// address, not an IP spraying signups across many distinct addresses —
// that broader case is already substantially covered today by the
// private-preview access-gate passphrase (see checkAccessGate) blocking
// these endpoints from anyone who doesn't already have it, and would need
// something like Cloudflare Turnstile/Bot Management if the gate ever
// comes off, not just a bigger version of this.
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

// #3441: where a bucket stands right now, without spending one of its slots.
// The same numbers a 429 carries ({ limit, windowSeconds, retryAfterSeconds })
// plus how many are left, so a client can tell a person they are at a limit
// before they touch the thing, from the server's own figures rather than a
// second copy of the limit. retryAfterSeconds is when the next slot frees (the
// oldest in-window event ageing out); 0 when nothing is used yet.
export async function rateLimitStanding(db, bucketKey, maxAttempts) {
  const row = await rateLimitStandingStatement(db, bucketKey).first();
  return rateLimitStandingFromRow(row, maxAttempts);
}

// #3464: the standing's one query as a prepared statement, so a caller that
// is already sending a db.batch can add it to that round trip instead of
// paying another one after it.
export function rateLimitStandingStatement(db, bucketKey) {
  return db.prepare(
    'SELECT COUNT(*) AS used, MIN(created_at) AS oldest FROM rate_limit_events WHERE bucket_key = ? AND created_at >= ?',
  ).bind(bucketKey, Date.now() - RATE_LIMIT_WINDOW_MS);
}

export function rateLimitStandingFromRow(row, maxAttempts) {
  const now = Date.now();
  const used = row?.used ?? 0;
  return {
    limit: maxAttempts,
    windowSeconds: RATE_LIMIT_WINDOW_MS / 1000,
    remaining: Math.max(0, maxAttempts - used),
    retryAfterSeconds: used > 0 ? Math.max(1, Math.ceil(((row.oldest ?? now) + RATE_LIMIT_WINDOW_MS - now) / 1000)) : 0,
  };
}

// #3464: the check-and-increment INSERT as a prepared statement, so a caller
// already sending a db.batch can add it to that round trip. Pair it with
// rateLimitRefusal() on the statement's result.
export function rateLimitInsertStatement(db, bucketKey, maxAttempts) {
  const now = Date.now();
  // A separate SELECT-then-INSERT here would be a check-then-act race:
  // concurrent requests sharing a bucket (e.g. a burst from one IP) could
  // all read the same under-the-limit count before any of their inserts
  // committed, letting a burst blow well past maxAttempts. Folding the
  // count check into the INSERT's own WHERE clause makes the whole
  // check-and-increment one atomic statement instead -- nothing can
  // interleave inside it. `changes` is 0 exactly when the subquery's count
  // was already at or over the limit, i.e. the guard blocked the insert.
  // Old rows outside the window are filtered here rather than actively
  // deleted per call now -- actual cleanup is pruneExpiredAuthState's job
  // (run from the same cron as world growth), so a rate-limit check no
  // longer needs its own separate write just to stay tidy.
  return db.prepare(`
    INSERT INTO rate_limit_events (bucket_key, created_at)
    SELECT ?1, ?2
    WHERE (SELECT COUNT(*) FROM rate_limit_events WHERE bucket_key = ?1 AND created_at >= ?3) < ?4
  `).bind(bucketKey, now, now - RATE_LIMIT_WINDOW_MS, maxAttempts);
}

// #3464: throws the 429 when the insert above was blocked (changes === 0);
// does nothing when it went through.
export async function rateLimitRefusal(db, result, bucketKey, maxAttempts) {
  if (result.meta.changes !== 0) return;
  const now = Date.now();
  // #3258 (owner decision: a message that limits an action states how much
  // and until when): the 429 body carries the numbers so no client has to
  // hard-code a limit the server owns. The bucket is back under its limit
  // once its oldest in-window event ages out, so that is the wait. Only the
  // failure path pays for this extra read.
  const oldest = await db.prepare(
    'SELECT MIN(created_at) AS oldest FROM rate_limit_events WHERE bucket_key = ? AND created_at >= ?',
  ).bind(bucketKey, now - RATE_LIMIT_WINDOW_MS).first();
  const oldestMs = oldest?.oldest ?? now;
  const retryAfterSeconds = Math.max(1, Math.ceil((oldestMs + RATE_LIMIT_WINDOW_MS - now) / 1000));
  throw new HttpError('Too many attempts. Please wait a while and try again.', 429, {
    limit: maxAttempts,
    windowSeconds: RATE_LIMIT_WINDOW_MS / 1000,
    retryAfterSeconds,
  });
}

export async function checkRateLimit(db, bucketKey, maxAttempts) {
  const result = await rateLimitInsertStatement(db, bucketKey, maxAttempts).run();
  await rateLimitRefusal(db, result, bucketKey, maxAttempts);
}
