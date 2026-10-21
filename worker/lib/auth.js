// #2528: the core "who is the currently authenticated user" chain --
// currentUser/requireCurrentUser (30 call sites)/requireAdmin (44 call
// sites, each one itself routing through requireCurrentUser), plus the
// cookie/hash/cookie-name primitives they depend on. Extracted verbatim,
// zero behavior change.
//
// #2543: requireSessionBuilder/requireVerifiedSession/assertVerified join
// the chain here too, now that #2535 gave getOrCreateBuilderForUser (the
// one thing that blocked this -- see the git history on this comment for
// the full writeup) a stable home in worker/lib/builder-profile.js. That
// module already imports requireCurrentUser from here, so this adds a
// direct two-file cycle (auth.js <-> builder-profile.js) on top of the
// existing builder-profile.js <-> worker/index.js one -- still safe by
// the same reasoning builder-profile.js's own comment gives: every name
// crossing either edge is only read inside an async function body at
// request time, never at module-evaluation time, so ES module live
// bindings resolve the cycle correctly regardless of load order
// (confirmed via the full build + unit + e2e suite).
import { HttpError } from './http.js';
import { bytesToHex } from './crypto.js';
import { getOrCreateBuilderForUser } from './builder-profile.js';

export const SESSION_COOKIE_NAME = 'hh_session';

export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

export async function currentUser(request, db) {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare(`
    SELECT users.* FROM sessions
    JOIN users ON users.user_id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(tokenHash).first();
  return row || null;
}

export async function requireCurrentUser(request, db) {
  const user = await currentUser(request, db);
  if (!user) throw new HttpError('Not authenticated', 401);
  // #2030 (sub-issue of #1201): the single join point every authenticated
  // request goes through -- enforcing the check here, rather than in
  // currentUser() itself, is what lets this throw a distinct, client-
  // actionable error instead of the generic 401 a plain null would produce
  // (a suspended user's session is still valid; it's their standing that's
  // revoked, not their login). #2029's own admin endpoints read a TARGET
  // account's suspension state via a direct SELECT on account_suspensions,
  // never through currentUser/requireCurrentUser, so they're unaffected by
  // this -- only the CALLING admin's own session goes through this check,
  // the same as any other authenticated action.
  const activeSuspension = await db.prepare(`
    SELECT 1 FROM account_suspensions WHERE user_id = ? AND lifted_at IS NULL AND escalated_at IS NULL
  `).bind(user.user_id).first();
  if (activeSuspension) throw new HttpError('Your account is suspended', 403, { suspended: true });
  return user;
}

// Gates world-generation tooling (see migrations/0055_admin_role.sql) —
// manual /api/world settings edits and the land-candidate/ring endpoints.
// Deliberately NOT applied to the endpoints that actually grow the world
// day to day (see worker/index.js's own scheduled() export) — those run
// automatically, unauthenticated, as the trusted server itself, not
// through any HTTP request a session could gate.
export async function requireAdmin(request, db) {
  const user = await requireCurrentUser(request, db);
  if (!user.is_admin) throw new HttpError('Admin access required', 403);
  return user;
}

// #2538: thrown wherever an existing row's own owner column doesn't match
// the session's resolved builder/seller id -- the shared shape for every
// "is this actually yours" check across the file. Pure/zero-dependency.
export function assertOwner(actualOwnerId, sessionOwnerId, message) {
  if (actualOwnerId !== sessionOwnerId) throw new HttpError(message, 403);
}

// docs/SPEC.md §6 / #556: age attestation plus credit-card (or eventual
// government-ID, #589) verification gates every builder/seller-owned
// action from here on, not just newly created accounts. Owner decision
// (Control Room, 2026-09-09): "force everyone through the new gates, no
// grandfathering in" -- deliberately applied to every session, including
// ones that signed up before this existed. Scoped to requireSessionBuilder/
// requireSessionSeller (the latter still in worker/index.js, builder's own
// seller-domain counterpart) -- the ones that actually gate world/shop-
// selling activity -- not requireCurrentUser itself, so an unverified
// session can still reach its own account state (GET /api/builders|
// sellers/me) and the age-attest/card-setup-intent/confirm-card endpoints
// needed to clear this gate in the first place.
export function assertVerified(user) {
  if (user.age_attested_at === null || user.trust_tier === 'none') {
    throw new HttpError(
      'Age attestation and credit-card (or government-ID) verification are required to continue.',
      403,
      { verificationRequired: true },
    );
  }
}

// The authorization workhorse for every builder-owned mutation: resolves
// *your own* builder profile from the session (never a client-supplied
// builderId -- that field is exactly what let anyone act as anyone else
// before this pass, see the audit that prompted it) so a handler can
// compare it against whatever it's about to modify.
export async function requireSessionBuilder(request, db) {
  const user = await requireCurrentUser(request, db);
  assertVerified(user);
  // last_active_at is kept fresh inside getOrCreateBuilderForUser itself,
  // not here -- see that function's own comment.
  return getOrCreateBuilderForUser(db, user);
}

// N44 (owner, 2026-09-12): shopping/purchasing now requires the same
// age-attestation + credit-card-or-ID gate as Build/Sell ("restrict minors
// from using any part of the application"), but a purchase doesn't need a
// builder or seller profile the way requireSessionBuilder/requireSessionSeller
// provision -- just a real, verified account. Used by handleInstancePurchase.
export async function requireVerifiedSession(request, db) {
  const user = await requireCurrentUser(request, db);
  assertVerified(user);
  return user;
}
