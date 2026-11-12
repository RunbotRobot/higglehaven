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

// #3464: one read for the session, its user and the user's suspension
// standing. requireCurrentUser used to pay a second sequential D1 round trip
// for the suspension lookup on every authenticated request; the EXISTS
// subquery runs inside the same statement (same predicate as before: an
// active, un-escalated account_suspensions row), so a suspended account is
// refused exactly as it was, one trip sooner. Returns { user, suspended },
// or null when there is no valid session.
async function sessionUserWithStanding(request, db) {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare(`
    SELECT users.*, EXISTS (
      SELECT 1 FROM account_suspensions
      WHERE account_suspensions.user_id = users.user_id
        AND account_suspensions.lifted_at IS NULL AND account_suspensions.escalated_at IS NULL
    ) AS suspended_standing FROM sessions
    JOIN users ON users.user_id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(tokenHash).first();
  if (!row) return null;
  const { suspended_standing: suspendedStanding, ...user } = row;
  return { user, suspended: suspendedStanding === 1 };
}

export async function currentUser(request, db) {
  const found = await sessionUserWithStanding(request, db);
  return found ? found.user : null;
}

export async function requireCurrentUser(request, db) {
  const found = await sessionUserWithStanding(request, db);
  if (!found) throw new HttpError('Not authenticated', 401);
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
  if (found.suspended) throw new HttpError('Your account is suspended', 403, { suspended: true });
  return found.user;
}

// #3088: the admin "override" branches of the moderation-delete endpoints
// (reviews, seller feedback, sign posts, calendar events) identify the
// requester through the NON-throwing currentUser(), which does not know about
// suspension -- so a suspended admin (still is_admin = 1, still holding a
// valid session) kept the override. Returns the user only when they are an
// admin in good standing; a suspended one gets null and falls through to the
// ordinary author/owner paths, which do go through requireCurrentUser. Same
// predicate requireCurrentUser and requireControlRoomAccess (#3000) use.
export async function adminInGoodStanding(db, user) {
  if (!user?.is_admin) return null;
  const activeSuspension = await db.prepare(`
    SELECT 1 FROM account_suspensions WHERE user_id = ? AND lifted_at IS NULL AND escalated_at IS NULL
  `).bind(user.user_id).first();
  return activeSuspension ? null : user;
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

// #2989 (sub-issue of #2305, "suspended-seller content" tracking): a
// standalone, non-throwing counterpart to requireCurrentUser's own
// account_suspensions lookup, for checking a THIRD PARTY's (a landlet
// owner's) standing rather than the calling session's own -- a suspended
// builder's own placed content needs to stop being interactable for
// everyone else, but the builder still needs full access to their own
// land (per #2989's own text), so this can never be folded into
// requireCurrentUser/requireSessionBuilder, both of which only ever check
// the caller. Joins through builders rather than taking a user_id
// directly since every call site below (handleInstancePurchase's landlet
// lookup, handleInstances' GET-by-landletId listing) only ever has a
// builder_id (landlets.owner_builder_id) in hand.
export async function builderHasActiveSuspension(db, builderId) {
  if (!builderId) return false;
  const row = await db.prepare(`
    SELECT 1 FROM builders
    JOIN account_suspensions ON account_suspensions.user_id = builders.user_id
    WHERE builders.builder_id = ? AND account_suspensions.lifted_at IS NULL AND account_suspensions.escalated_at IS NULL
  `).bind(builderId).first();
  return !!row;
}

// #3123: the same predicate as builderHasActiveSuspension, as a SQL fragment
// for list queries that must hide what a suspended builder left behind in a
// shared surface (nearby chat, friend voice channels) without a per-row
// lookup. `column` is a trusted, hard-coded builder_id column reference from
// the calling query, never user input.
export function builderNotSuspendedSql(column) {
  return `NOT EXISTS (
    SELECT 1 FROM builders AS suspended_check_b
    JOIN account_suspensions AS suspended_check_s ON suspended_check_s.user_id = suspended_check_b.user_id
    WHERE suspended_check_b.builder_id = ${column}
      AND suspended_check_s.lifted_at IS NULL AND suspended_check_s.escalated_at IS NULL
  )`;
}

// #3143 (Blocks 2/2): the one shared predicate every person-to-person surface
// uses to honour a block (AGENTS.md: "Parity across sibling surfaces"), so none
// can drift. Both arguments are trusted SQL expressions for a *builder_id*
// (a column reference or a `?` placeholder, never user text); each appears
// exactly once so a `?` costs exactly one bind. Blocks key on user_id, so the
// builder ids resolve through `builders` here -- #3141 removes that step later.
// notBlockedEitherWaySql: true unless either person blocked the other.
export function notBlockedEitherWaySql(builderExprA, builderExprB) {
  return `NOT EXISTS (
    SELECT 1 FROM user_blocks AS blk_check
    JOIN builders AS blk_a ON blk_a.builder_id = ${builderExprA}
    JOIN builders AS blk_b ON blk_b.builder_id = ${builderExprB}
    WHERE (blk_check.blocker_user_id = blk_a.user_id AND blk_check.blocked_user_id = blk_b.user_id)
       OR (blk_check.blocker_user_id = blk_b.user_id AND blk_check.blocked_user_id = blk_a.user_id)
  )`;
}

// notBlockedBySql: one direction only -- true unless the first person blocked
// the second. For surfaces where the blocked person must see no change at all
// (their own pending friend request stays visible to them) but the blocker's
// view hides it.
export function notBlockedBySql(blockerBuilderExpr, blockedBuilderExpr) {
  return `NOT EXISTS (
    SELECT 1 FROM user_blocks AS blk_check
    JOIN builders AS blk_a ON blk_a.builder_id = ${blockerBuilderExpr}
    JOIN builders AS blk_b ON blk_b.builder_id = ${blockedBuilderExpr}
    WHERE blk_check.blocker_user_id = blk_a.user_id AND blk_check.blocked_user_id = blk_b.user_id
  )`;
}

// notBlockedByUserSql: the same one-direction check as notBlockedBySql, for a
// table that is already keyed by user_id (#3141 moves the social tables over
// one at a time; direct_messages is one, #3146). Both arguments are trusted SQL
// expressions for a *user_id* (a column reference or a `?` placeholder, never
// user text); no builders join is needed.
export function notBlockedByUserSql(blockerUserExpr, blockedUserExpr) {
  return `NOT EXISTS (
    SELECT 1 FROM user_blocks AS blk_user_check
    WHERE blk_user_check.blocker_user_id = ${blockerUserExpr}
      AND blk_user_check.blocked_user_id = ${blockedUserExpr}
  )`;
}

// notBlockedEitherWayByUserSql: the either-direction counterpart, for the
// ephemeral social tables that key on user_id (#3147, 4/6 of #3141: presence,
// nearby chat, voice signaling, friend voice channels). Same contract as
// notBlockedEitherWaySql: both arguments are trusted SQL expressions for a
// *user_id* (a column reference or a `?` placeholder, never user text) and each
// appears exactly once, so a `?` costs exactly one bind. They are joined through
// `users` (every account keeps its users row, even after deletion) purely to
// reference each expression once.
export function notBlockedEitherWayByUserSql(userExprA, userExprB) {
  return `NOT EXISTS (
    SELECT 1 FROM user_blocks AS blk_user_check
    JOIN users AS blk_user_a ON blk_user_a.user_id = ${userExprA}
    JOIN users AS blk_user_b ON blk_user_b.user_id = ${userExprB}
    WHERE (blk_user_check.blocker_user_id = blk_user_a.user_id AND blk_user_check.blocked_user_id = blk_user_b.user_id)
       OR (blk_user_check.blocker_user_id = blk_user_b.user_id AND blk_user_check.blocked_user_id = blk_user_a.user_id)
  )`;
}

// userNotSuspendedSql: builderNotSuspendedSql (#3126) for a column that already
// holds a user_id, so the join through builders is not needed (#3147). `column`
// is a trusted, hard-coded user_id column reference, never user input.
export function userNotSuspendedSql(column) {
  return `NOT EXISTS (
    SELECT 1 FROM account_suspensions AS suspended_user_check
    WHERE suspended_user_check.user_id = ${column}
      AND suspended_user_check.lifted_at IS NULL AND suspended_user_check.escalated_at IS NULL
  )`;
}

// Single-pair user-id check for write paths (voice signal send).
export async function userBlockExistsBetween(db, userIdA, userIdB) {
  if (!userIdA || !userIdB) return false;
  const row = await db.prepare(`SELECT 1 AS hit WHERE (${notBlockedEitherWayByUserSql('?', '?')}) = 0`)
    .bind(userIdA, userIdB).first();
  return !!row;
}

// Single-pair JS checks for write paths (voice signal send, friend request).
export async function blockExistsBetween(db, builderIdA, builderIdB) {
  const row = await db.prepare(`SELECT 1 AS hit WHERE (${notBlockedEitherWaySql('?', '?')}) = 0`)
    .bind(builderIdA, builderIdB).first();
  return !!row;
}

export async function builderBlocks(db, blockerBuilderId, blockedBuilderId) {
  const row = await db.prepare(`SELECT 1 AS hit WHERE (${notBlockedBySql('?', '?')}) = 0`)
    .bind(blockerBuilderId, blockedBuilderId).first();
  return !!row;
}

// #3144 (1/6 of #3141): builders and sellers are role profiles hanging off one
// account, and a builder profile can be reset to a brand-new builder_id through
// ordinary self-service, so anything about a person as a person keys on
// users.user_id (AGENTS.md, "Anything about a person as a person keys on the
// account"). These resolvers are how the social tables that are still keyed by
// builder_id move over, one table per sub-issue: see docs/API.md's "Moving a
// table from builder ids to user ids" for the pattern. Each returns null when
// there is nothing to resolve (no such builder, or a pre-auth builder whose
// user_id is NULL; those rows exist -- migrations/0054 -- and must never be
// guessed at), and the set versions simply omit the ids they cannot resolve.
export async function userIdForBuilder(db, builderId) {
  if (!builderId) return null;
  const row = await db.prepare('SELECT user_id FROM builders WHERE builder_id = ?').bind(builderId).first();
  return row?.user_id ?? null;
}

export async function builderIdForUser(db, userId) {
  if (!userId) return null;
  const row = await db.prepare('SELECT builder_id FROM builders WHERE user_id = ?').bind(userId).first();
  return row?.builder_id ?? null;
}

// One bound parameter per id, and D1 allows 100 bound parameters per
// statement; a little headroom keeps a future extra condition from tipping it
// over. Same chunking idiom suspendedSellerTemplateIds below and
// selectModelUrlReferencesChunked (models.js) use for their own lists.
export const RESOLVER_CHUNK_SIZE = 90;

// Map<builderId, userId> for the builders in `builderIds` that have an account.
export async function userIdsForBuilders(db, builderIds) {
  const unique = [...new Set((builderIds || []).filter(Boolean))];
  const resolved = new Map();
  for (let i = 0; i < unique.length; i += RESOLVER_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + RESOLVER_CHUNK_SIZE);
    const { results } = await db.prepare(`
      SELECT builder_id, user_id FROM builders
      WHERE user_id IS NOT NULL AND builder_id IN (${chunk.map(() => '?').join(', ')})
    `).bind(...chunk).all();
    for (const row of results) resolved.set(row.builder_id, row.user_id);
  }
  return resolved;
}

// Map<userId, builderId> for the accounts in `userIds` that currently have a
// builder profile (at most one each, idx_builders_user_id).
export async function builderIdsForUsers(db, userIds) {
  const unique = [...new Set((userIds || []).filter(Boolean))];
  const resolved = new Map();
  for (let i = 0; i < unique.length; i += RESOLVER_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + RESOLVER_CHUNK_SIZE);
    const { results } = await db.prepare(`
      SELECT builder_id, user_id FROM builders
      WHERE user_id IN (${chunk.map(() => '?').join(', ')})
    `).bind(...chunk).all();
    for (const row of results) resolved.set(row.user_id, row.builder_id);
  }
  return resolved;
}

// #3034 (found via #3029): which of these templates belong to a seller under
// an active suspension -- the same predicate #2985 hides from the catalog
// (catalog.js) and #2986 snapshots+removes on suspend. Instance write paths
// use it so a builder can't place (POST /instances, /instances/batch) or
// re-place (PUT /landlets/:id/draft, "Restore to Editor") a suspended
// seller's product after the removal already happened.
export async function suspendedSellerTemplateIds(db, templateIds) {
  const unique = [...new Set(templateIds)];
  const suspended = new Set();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await db.prepare(`
      SELECT catalog_templates.template_id AS template_id FROM catalog_templates
      JOIN sellers ON sellers.seller_id = catalog_templates.seller_id
      JOIN account_suspensions ON account_suspensions.user_id = sellers.user_id
        AND account_suspensions.lifted_at IS NULL AND account_suspensions.escalated_at IS NULL
      WHERE catalog_templates.template_id IN (${placeholders})
      UNION
      -- #3057: a permanently closed seller (sellers row already deleted).
      SELECT catalog_templates.template_id AS template_id FROM catalog_templates
      JOIN closed_sellers ON closed_sellers.seller_id = catalog_templates.seller_id
      WHERE catalog_templates.template_id IN (${placeholders})
    `).bind(...chunk, ...chunk).all();
    for (const row of results) suspended.add(row.template_id);
  }
  return suspended;
}

export const SUSPENDED_SELLER_PLACEMENT_ERROR = 'This product is currently unavailable because its seller is suspended.';
