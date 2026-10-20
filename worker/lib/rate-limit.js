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

export async function checkRateLimit(db, bucketKey, maxAttempts) {
  const now = Date.now();
  // A separate SELECT-then-INSERT here would be a check-then-act race:
  // concurrent requests sharing a bucket (e.g. a burst from one IP) could
  // all read the same under-the-limit count before any of their inserts
  // committed, letting a burst blow well past maxAttempts. Folding the
  // count check into the INSERT's own WHERE clause makes the whole
  // check-and-increment one atomic statement instead — nothing can
  // interleave inside it. `changes` is 0 exactly when the subquery's count
  // was already at or over the limit, i.e. the guard blocked the insert.
  // Old rows outside the window are filtered here rather than actively
  // deleted per call now — actual cleanup is pruneExpiredAuthState's job
  // (run from the same cron as world growth), so a rate-limit check no
  // longer needs its own separate write just to stay tidy.
  const result = await db.prepare(`
    INSERT INTO rate_limit_events (bucket_key, created_at)
    SELECT ?1, ?2
    WHERE (SELECT COUNT(*) FROM rate_limit_events WHERE bucket_key = ?1 AND created_at >= ?3) < ?4
  `).bind(bucketKey, now, now - RATE_LIMIT_WINDOW_MS, maxAttempts).run();
  if (result.meta.changes === 0) {
    throw new HttpError('Too many attempts. Please wait a while and try again.', 429);
  }
}
