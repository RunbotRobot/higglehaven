// #2528: the core "who is the currently authenticated user" chain --
// currentUser/requireCurrentUser (30 call sites)/requireAdmin (44 call
// sites, each one itself routing through requireCurrentUser), plus the
// cookie/hash/cookie-name primitives they depend on. Extracted verbatim,
// zero behavior change.
//
// Deliberately NOT included here: requireSessionBuilder/requireVerifiedSession
// (and assertVerified/assertOwner alongside them) -- #2501 already found
// these drag in more than a mechanical move allows, and investigating
// further for this issue confirmed why: requireSessionBuilder's own
// getOrCreateBuilderForUser has 13 call sites of its own spanning many
// handlers that have nothing to do with authentication (handleMyBuilder,
// handleMyOwnedAvatars, and more), reading/writing the builders table --
// genuinely builder-PROFILE domain logic, not an auth-chain internal, and
// slated for its own feature-area leaf (#2535) under #2502's own
// breakdown. Moving requireSessionBuilder here now would mean either this
// module reaching back into worker/index.js for a function that's about
// to move again once #2535 lands (exactly the churn #2528's own body
// warned against), or dragging builder-profile logic into an "auth"
// module where it doesn't belong. Filed as its own narrower follow-up
// (see that issue for the full writeup) rather than forced through here.
import { HttpError } from './http.js';
import { bytesToHex } from './crypto.js';

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
