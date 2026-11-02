// #2529 (sub-issue of #2502, itself sub-issue of #2500): admin-bootstrap/
// grant/revoke and account-suspension handlers, extracted verbatim, zero
// behavior change. All requireAdmin/requireCurrentUser-gated, same shape
// as the control-room.js sibling leaf -- none of this touches
// requireSessionBuilder, so no circular-import blocker here either.
import { json, HttpError, clientIp } from './http.js';
import { readJson, stringValue } from './validation.js';
import { timingSafeEqual } from './crypto.js';
import { requireCurrentUser, requireAdmin } from './auth.js';
import { checkRateLimit } from './rate-limit.js';
import { adminActionLogStatement } from './admin-log.js';
import { fireNotification } from './notifications.js';
// #2542 (landed on main while this leaf's PR was in flight): normalizeEmail/
// userFromRow stay defined in worker/index.js itself (re-exported for
// worker/lib/auth-routes.js and worker/lib/stripe.js too) rather than
// worker/lib/auth.js -- imported back from there, same established
// worker/index.js <-> worker/lib/* shape auth-routes.js/stripe.js already use.
import { normalizeEmail, userFromRow } from '../index.js';

// The only way to become an admin (see migrations/0055_admin_role.sql) —
// requires both a real session AND a Worker secret only whoever deploys
// this app knows, never a self-service signup path the way builder/seller
// profiles are. Reusable, not one-time: anyone who currently holds the
// secret can promote themselves (or, by sharing it briefly, someone else)
// at any time — simpler than a "first admin only" ratchet, and matching
// this codebase's existing dev-mode-first, don't-build-what-isn't-needed-
// yet posture. Revoking admin status has no endpoint either; it's a rare
// enough operation to do directly against the database.
// Found via backlog audit (#360): unlike every other secret-bearing auth
// endpoint in this file (login's failed_login_attempts/locked_until
// lockout, signup/password-reset's checkRateLimit calls), this one had no
// brute-force protection at all — and it's the one endpoint that grants
// admin privilege, not just account access.
const ADMIN_BOOTSTRAP_RATE_LIMIT_MAX = 10;

export async function handleAdminBootstrap(request, env, db) {
  if (!env.ADMIN_BOOTSTRAP_SECRET) throw new HttpError('Admin bootstrap is not configured', 404);
  const user = await requireCurrentUser(request, db);
  await checkRateLimit(db, `admin-bootstrap:${clientIp(request)}`, ADMIN_BOOTSTRAP_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const secret = stringValue(input.secret, 'secret');
  if (!timingSafeEqual(secret, env.ADMIN_BOOTSTRAP_SECRET)) {
    throw new HttpError('Incorrect admin bootstrap secret', 403);
  }
  // #1074: this is the OTHER of the two routes that grant admin privilege
  // (see handleGrantAdmin's own #814 fix just below) -- #814's audit-trail
  // effort and its own sweep of admin-gated mutations (#815/#816/#817/#829)
  // never actually covered this one, leaving it the one privilege-
  // escalation path with no record anywhere of when it happened or which
  // account did it. Same atomic batch-with-the-grant shape as
  // handleGrantAdmin, so the two can never diverge.
  await db.batch([
    db.prepare('UPDATE users SET is_admin = 1, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE user_id = ?')
      .bind(user.user_id),
    adminActionLogStatement(db, user.user_id, 'admin_bootstrap', 'user', user.user_id),
  ]);
  const updated = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(user.user_id).first();
  return json({ user: userFromRow(updated) });
}

// The second way to become an admin, this one for an admin promoting
// someone else rather than bootstrapping themselves — requireAdmin-gated
// (a real is_admin session), deliberately NOT reachable via
// requireControlRoomAccess's CONTROL_ROOM_API_KEY path even though this
// is exposed from the Control Room admin page: that key exists so the
// ~12 Claude sessions can read/write the task board, not so any of them
// could mint real site admins. Same email lookup handleLogin already
// uses (normalizeEmail against the plain `email` column), so this finds
// exactly the account that email actually logs into.
// #2123: grant/revoke-admin mint or remove is_admin itself -- the one pair
// of admin mutations in this file with no rate limit at all, unlike
// suspend-account (ACCOUNT_SUSPENSION_RATE_LIMIT_MAX) and nearly every
// other admin-gated mutation here. Same bucket shape: keyed by the acting
// admin, not the target account, so one admin can't be throttled out by
// someone else's grants/revokes.
const ADMIN_GRANT_RATE_LIMIT_MAX = 20;

export async function handleGrantAdmin(request, db) {
  const admin = await requireAdmin(request, db);
  await checkRateLimit(db, `admin-grant:${admin.user_id}`, ADMIN_GRANT_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const email = normalizeEmail(input.email);
  const row = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!row) throw new HttpError('No account with that email', 404);
  // #814: this is privilege escalation with a real security blast radius
  // (see admin_action_log's own migration comment) — log who granted it,
  // batched with the grant itself so the two can never diverge.
  await db.batch([
    db.prepare('UPDATE users SET is_admin = 1, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE user_id = ?')
      .bind(row.user_id),
    adminActionLogStatement(db, admin.user_id, 'grant_admin', 'user', row.user_id, { granteeEmail: email }),
  ]);
  const updated = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(row.user_id).first();
  return json({ user: userFromRow(updated) });
}

// #1819 (sub-issue of #1817): the missing inverse of handleGrantAdmin that
// #1481 flagged as a product decision -- that issue's own scope has since
// decided it: revocation is allowed (including an admin revoking their own
// access), with the one invariant the Admin Dashboard roster panel needs
// enforced server-side, not just hinted at in the UI: this app must never
// end up with zero admins and no way back short of direct D1 access.
// The UPDATE's own "> 1 admins left" guard (not a separate SELECT-then-
// UPDATE) is the same atomic check-then-act idiom approve_1099_form's own
// status='draft' guard already uses above -- a second concurrent revoke
// racing the same count can't both succeed and leave zero admins, since
// each UPDATE re-evaluates the live COUNT at the moment it runs.
export async function handleRevokeAdmin(request, db) {
  const admin = await requireAdmin(request, db);
  await checkRateLimit(db, `admin-grant:${admin.user_id}`, ADMIN_GRANT_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const email = normalizeEmail(input.email);
  const row = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!row) throw new HttpError('No account with that email', 404);
  if (row.is_admin !== 1) throw new HttpError('That account is not currently an admin', 400);
  // #2307: a raw COUNT(is_admin=1) can't tell an operational admin from one
  // who is themselves already suspended (and thus just as unable to call
  // requireAdmin) -- the same reasoning handleSuspendAccount's own guard
  // above already documents for the identical invariant. Requires at least
  // one OTHER admin who is_admin=1 AND has no currently-active suspension,
  // same EXISTS shape #2270 added there.
  const result = await db.prepare(`
    UPDATE users SET is_admin = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = ? AND is_admin = 1
      AND EXISTS (
        SELECT 1 FROM users AS other_admin
        WHERE other_admin.is_admin = 1
          AND other_admin.user_id != ?
          AND NOT EXISTS (
            SELECT 1 FROM account_suspensions
            WHERE account_suspensions.user_id = other_admin.user_id
              AND lifted_at IS NULL AND escalated_at IS NULL
          )
      )
  `).bind(row.user_id, row.user_id).run();
  if (result.meta.changes === 0) throw new HttpError('Cannot revoke the last remaining admin', 409);
  // Logged only after confirmed (same reasoning as approve_1099_form's own
  // comment above) -- batching this with the UPDATE would commit a log row
  // for a revoke that the guard above actually blocked.
  await adminActionLogStatement(db, admin.user_id, 'revoke_admin', 'user', row.user_id, { granteeEmail: email }).run();
  const updated = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(row.user_id).first();
  return json({ user: userFromRow(updated) });
}

// Control Room feedback: "Please let admins see a list of all admins in
// the Control Room" — with (per handleGrantAdmin's own reasoning above)
// admin status being mintable only via a real session, an admin losing
// track of who currently holds it is otherwise unrecoverable without
// direct D1 access. requireAdmin-gated the same way grant-admin is (any
// admin can see the roster, not just whoever granted it), returning a
// deliberately narrow shape — userId/email/username/createdAt only, never
// the full userFromRow (trustTier, cardFunding, taxFormType, ...) every
// other admin viewing this roster has no reason to see about a peer.
export async function handleListAdmins(request, db) {
  await requireAdmin(request, db);
  // #1561: created_at is the account's signup date, not when is_admin was
  // set -- admin_action_log already records the exact grant moment (#814/
  // #1074's own accountability-trail reasoning), so read that back instead
  // of silently mislabeling a long-dormant account's later promotion as
  // "admin since" its original signup. Falls back to created_at (via
  // COALESCE/the client's `||`) for any admin whose grant predates that log.
  // #1797: both grant-type actions are reusable/repeatable on an already-
  // admin account (handleAdminBootstrap/handleGrantAdmin, no "already
  // admin" guard, no uniqueness constraint on this table) -- MIN, not MAX,
  // is the one that actually matches "the exact grant moment" above when a
  // later re-grant lands a second, newer log row.
  // #2319: that MIN alone goes stale across a real revoke-then-re-grant
  // cycle (a working path since #1819/#2307) -- admin_action_log is
  // strictly append-only, so a revoked-then-later-re-granted account's
  // MIN still returns the original, pre-revoke grant timestamp, spanning
  // a period the account genuinely was not an admin. Scopes the MIN to
  // only grant/bootstrap rows after this user's own most recent revoke,
  // falling back to the unscoped MIN when there's no intervening revoke.
  const { results } = await db.prepare(`
    SELECT users.user_id, users.email, users.username, users.created_at,
      (SELECT MIN(created_at) FROM admin_action_log AS grants
       WHERE grants.target_type = 'user' AND grants.target_id = users.user_id
         AND grants.action_type IN ('grant_admin', 'admin_bootstrap')
         AND grants.created_at > COALESCE(
           (SELECT MAX(created_at) FROM admin_action_log AS revokes
            WHERE revokes.target_type = 'user' AND revokes.target_id = users.user_id
              AND revokes.action_type = 'revoke_admin'),
           ''
         )
      ) AS admin_granted_at
    FROM users WHERE is_admin = 1
    ORDER BY COALESCE(admin_granted_at, users.created_at) ASC
  `).all();
  return json({
    admins: results.map((row) => ({
      userId: row.user_id, email: row.email, username: row.username,
      createdAt: row.created_at, adminGrantedAt: row.admin_granted_at,
    })),
  });
}

const ACCOUNT_SUSPENSION_RATE_LIMIT_MAX = 20;

// #2032 (sub-issue of #1201): the suspend action's optional sign-post/
// calendar-event removal cascade -- per the owner's own resolved call on
// #781: offered as part of suspending, not unconditionally automatic and
// not a separate manual step. Reuses the exact admin-override DELETE path
// #781 already added for a single post/event (same action_type/target_type
// per row in admin_action_log), just applied across every row this user
// authored instead of one at a time via the HTTP DELETE endpoints.
//
// calendar_events.user_id (migrations/0135) only exists going forward from
// that migration -- a pre-existing event has no attribution at all to
// check against (same limitation sign_posts accepted pre-#1830), so this
// can only ever find and remove a subset of a long-suspended user's older
// calendar events. Flagged in docs/API.md, not silently glossed over.
async function removeSuspendedUserPostedContent(db, adminUserId, suspendedUserId) {
  const { results: posts } = await db.prepare(
    'SELECT post_id FROM sign_posts WHERE user_id = ?',
  ).bind(suspendedUserId).all();
  const { results: events } = await db.prepare(
    'SELECT event_id FROM calendar_events WHERE user_id = ?',
  ).bind(suspendedUserId).all();
  const statements = [];
  for (const { post_id: postId } of posts) {
    statements.push(db.prepare('DELETE FROM sign_posts WHERE post_id = ?').bind(postId));
    statements.push(adminActionLogStatement(db, adminUserId, 'delete_sign_post_override', 'sign_post', postId));
  }
  for (const { event_id: eventId } of events) {
    statements.push(db.prepare('DELETE FROM calendar_events WHERE event_id = ?').bind(eventId));
    statements.push(adminActionLogStatement(db, adminUserId, 'delete_calendar_event_override', 'calendar_event', eventId));
  }
  if (statements.length > 0) await db.batch(statements);
  return { signPostsRemoved: posts.length, calendarEventsRemoved: events.length };
}

// #2986 (sub-issue 2/5 of #2305): a suspended seller's existing
// placements don't just become unpurchasable (#2985, the catalog-hide +
// purchase-block sub-issue) -- the owner's own decision is a harder
// "removed, but snapshotted" treatment: every already-placed instance of
// one of their listed products, across every builder's own landlet,
// comes out of the world immediately, with enough kept to restore it
// exactly if the seller is later unsuspended. Unlike removeContent above
// (an admin's own opt-in judgment call on the SUSPENDED user's own
// authored content), this always runs -- it's a structural consequence
// of the owner's explicit, unconditional decision for this specific
// feature, not a severity call per suspension.
//
// Synchronous, not a background sweep (one of #2986's own open
// questions) -- same reasoning #3004's own reassign-owner cleanup batch
// already runs its similarly fan-out, across-many-rows deletes
// synchronously inside the admin request rather than deferring to a cron
// sweep: this app's scale doesn't need one, and "in-flight purchases
// blocked too" elsewhere in #2305 already values the effect landing
// immediately, not on the next scheduled tick.
async function removeSuspendedSellerPlacedInstances(db, suspendedUserId) {
  const seller = await db.prepare('SELECT seller_id FROM sellers WHERE user_id = ?').bind(suspendedUserId).first();
  if (!seller) return { instancesRemoved: 0 };
  const { results: instances } = await db.prepare(`
    SELECT placed_instances.* FROM placed_instances
    JOIN catalog_templates ON catalog_templates.template_id = placed_instances.template_id
    WHERE catalog_templates.seller_id = ?
  `).bind(seller.seller_id).all();
  if (instances.length === 0) return { instancesRemoved: 0 };

  // #2764: no special group-membership handling needed here -- deleting
  // one member of a group never touches any other member's own group_id
  // (a group is just a shared opaque value, not a resource of its own),
  // and the full-row snapshot below (instance_json) already preserves
  // this instance's own group_id for restoreSuspendedSellerPlacedInstances
  // to reuse verbatim later.
  const landletIds = [...new Set(instances.map((instance) => instance.landlet_id))];
  const { results: landletRows } = await db.prepare(`
    SELECT landlet_id, owner_builder_id FROM landlets WHERE landlet_id IN (${landletIds.map(() => '?').join(', ')})
  `).bind(...landletIds).all();
  const ownerByLandletId = new Map(landletRows.map((row) => [row.landlet_id, row.owner_builder_id]));

  const statements = [];
  for (const instance of instances) {
    const builderId = ownerByLandletId.get(instance.landlet_id);
    // The landlet itself vanished (greenbelt again, or deleted) in the gap
    // between the SELECT above and here -- nothing to snapshot a builder
    // against, and placed_instances' own ON DELETE CASCADE from landlets
    // already took this row with it, so there's nothing left to delete
    // either.
    if (!builderId) continue;
    statements.push(db.prepare(`
      INSERT INTO suspended_seller_instance_snapshots
        (snapshot_id, seller_id, builder_id, landlet_id, template_id, instance_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(`sss-${crypto.randomUUID()}`, seller.seller_id, builderId, instance.landlet_id, instance.template_id, JSON.stringify(instance)));
    statements.push(db.prepare('DELETE FROM placed_instances WHERE instance_id = ?').bind(instance.instance_id));
  }
  if (statements.length > 0) await db.batch(statements);
  return { instancesRemoved: statements.length / 2 };
}

// The inverse of removeSuspendedSellerPlacedInstances above -- called
// once a seller's suspension is actually lifted, restoring every still-
// pending snapshot (cleared_at IS NULL -- sub-issue 3, #2987, is the only
// thing that ever sets it) exactly as it was removed. Skips (leaves
// un-restored, available to try again on a future unsuspend) a snapshot
// whose landlet no longer exists or has since changed owner --
// reassign-owner's own cleanup (#3004) already wipes a landlet's
// placed_instances on transfer, and restoring a since-suspended seller's
// old instance there would silently reintroduce exactly the "new owner
// inherits the previous owner's build content" bug #1280/#2508 exist to
// prevent -- or whose template has since been deleted entirely (as
// opposed to merely hidden/suspended -- nothing left to restore a
// reference to).
async function restoreSuspendedSellerPlacedInstances(db, sellerId) {
  const { results: snapshots } = await db.prepare(`
    SELECT * FROM suspended_seller_instance_snapshots
    WHERE seller_id = ? AND restored_at IS NULL AND cleared_at IS NULL
  `).bind(sellerId).all();
  if (snapshots.length === 0) return { instancesRestored: 0 };

  const now = new Date().toISOString();
  const statements = [];
  for (const snapshot of snapshots) {
    const landlet = await db.prepare('SELECT owner_builder_id FROM landlets WHERE landlet_id = ?').bind(snapshot.landlet_id).first();
    if (!landlet || landlet.owner_builder_id !== snapshot.builder_id) continue;
    const templateExists = await db.prepare('SELECT 1 FROM catalog_templates WHERE template_id = ?').bind(snapshot.template_id).first();
    if (!templateExists) continue;
    const saved = JSON.parse(snapshot.instance_json);
    const instanceId = `instance-${crypto.randomUUID()}`;
    // Re-checks the same owner match inside the write itself (#929/#960
    // idiom) -- the plain reads above are a point-in-time check, and a
    // landlet transfer landing in the gap since then must not let this
    // restore onto what's now a different owner's land.
    statements.push(db.prepare(`
      INSERT INTO placed_instances
        (instance_id, landlet_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale, is_community_sign, is_community_calendar, group_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id = ?)
    `).bind(
      instanceId, snapshot.landlet_id, snapshot.template_id,
      saved.x_m, saved.y_m, saved.z_m, saved.rotation_x_rad, saved.rotation_y_rad, saved.rotation_z_rad,
      saved.label, saved.crop_json, saved.scale, saved.is_community_sign, saved.is_community_calendar, saved.group_id,
      snapshot.landlet_id, snapshot.builder_id,
    ));
    // Only marks this snapshot restored if the INSERT just above actually
    // landed a row -- D1 serializes statements within one batch() in
    // order, so this subquery only ever runs after that INSERT has
    // already committed (or no-opped on the owner-match guard failing).
    statements.push(db.prepare(`
      UPDATE suspended_seller_instance_snapshots SET restored_at = ?
      WHERE snapshot_id = ? AND EXISTS (SELECT 1 FROM placed_instances WHERE instance_id = ?)
    `).bind(now, snapshot.snapshot_id, instanceId));
  }
  if (statements.length > 0) await db.batch(statements);
  return { instancesRestored: statements.length / 2 };
}

// #2029 (sub-issue of #1201): the foundational primitive for admin-
// initiated account suspension -- email-addressed and admin_action_log-
// recorded the same way grant-admin/revoke-admin above already are, since
// this is the same kind of "one admin acting on another account" shape.
// Deliberately reversible, not a hard delete (#1201's own owner-settled
// scope: "I don't see a strong case for admin-initiated hard deletion
// either... Build suspension only"). Guards against double-suspending the
// same account via a single INSERT ... WHERE NOT EXISTS rather than a
// separate SELECT-then-INSERT, so two concurrent suspend calls against the
// same account can't both land a second, divergent active-suspension row.
export async function handleSuspendAccount(request, db) {
  const admin = await requireAdmin(request, db);
  await checkRateLimit(db, `suspend-account:${admin.user_id}`, ACCOUNT_SUSPENSION_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const email = normalizeEmail(input.email);
  // #2708: reason/evidenceNote are otherwise unbounded, unlike every other
  // moderation free-text field (e.g. worker/lib/reputation.js's product-flag
  // reason) -- both are stored permanently and reason is replayed verbatim
  // into a user-facing notification, so this reuses that same 280-char cap.
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw new HttpError('reason is required', 400);
  if (reason.length > 280) throw new HttpError('reason must be 280 characters or fewer', 400);
  const evidenceNote = typeof input.evidenceNote === 'string' && input.evidenceNote.trim()
    ? input.evidenceNote.trim() : null;
  if (evidenceNote && evidenceNote.length > 280) throw new HttpError('evidenceNote must be 280 characters or fewer', 400);
  // #2032: opt-in, not the default -- see removeSuspendedUserPostedContent's
  // own comment for why this isn't unconditional.
  const removeContent = input.removeContent === true;
  // Owner-confirmed default (#1201, 2026-10-07): 30 days. A caller may
  // override it, but only within a sane range -- not unbounded, and not
  // zero/negative (that would mean "already past its own grace period,"
  // i.e. an immediate, unintended escalation on the very next #2033 run).
  const graceDays = input.graceDays === undefined ? 30 : Number(input.graceDays);
  if (!Number.isInteger(graceDays) || graceDays < 1 || graceDays > 365) {
    throw new HttpError('graceDays must be an integer between 1 and 365', 400);
  }

  const row = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!row) throw new HttpError('No account with that email', 404);

  const suspensionId = `suspension-${crypto.randomUUID()}`;
  const gracePeriodEndsAt = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000).toISOString();
  // Not batched with the log write below -- same reasoning as
  // handleRevokeAdmin's own comment above ("Logged only after confirmed"):
  // this INSERT's own WHERE NOT EXISTS can legitimately insert 0 rows, and
  // a batched log statement would commit regardless, misrecording a
  // suspension that never actually took effect.
  //
  // #2268: same "never end up with zero admins and no way back short of
  // direct D1 access" invariant handleRevokeAdmin's own guard enforces
  // above -- a suspended account can't call requireAdmin at all (it fails
  // requireCurrentUser's suspension check before is_admin is ever read),
  // so suspending the last admin was otherwise unrecoverable through the
  // app itself, and an unresolved suspension auto-escalates to a full
  // cascade delete once its grace period lapses (escalateExpiredSuspensions
  // below). Unlike handleRevokeAdmin, a raw COUNT(is_admin=1) isn't enough
  // here -- suspending never clears is_admin, so that count alone can't
  // tell an operational admin from one who is themselves already suspended
  // (and thus just as unable to call requireAdmin). The guard instead
  // requires at least one OTHER admin who is_admin=1 AND has no currently-
  // active suspension of their own. The live reads happen inside this same
  // atomic INSERT, not in a separate check-then-act step, for the same
  // "re-evaluates at the moment it runs" reasoning as handleRevokeAdmin's
  // own comment above.
  const result = await db.prepare(`
    INSERT INTO account_suspensions
      (suspension_id, user_id, admin_user_id, reason, evidence_note, grace_period_ends_at)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM account_suspensions
      WHERE user_id = ? AND lifted_at IS NULL AND escalated_at IS NULL
    )
    AND (
      (SELECT is_admin FROM users WHERE user_id = ?) = 0
      OR EXISTS (
        SELECT 1 FROM users AS other_admin
        WHERE other_admin.is_admin = 1
          AND other_admin.user_id != ?
          AND NOT EXISTS (
            SELECT 1 FROM account_suspensions
            WHERE account_suspensions.user_id = other_admin.user_id
              AND lifted_at IS NULL AND escalated_at IS NULL
          )
      )
    )
  `).bind(suspensionId, row.user_id, admin.user_id, reason, evidenceNote, gracePeriodEndsAt, row.user_id, row.user_id, row.user_id).run();
  if (result.meta.changes === 0) {
    const current = await db.prepare('SELECT is_admin FROM users WHERE user_id = ?').bind(row.user_id).first();
    if (current?.is_admin === 1) {
      const otherOperationalAdmin = await db.prepare(`
        SELECT 1 FROM users AS other_admin
        WHERE other_admin.is_admin = 1
          AND other_admin.user_id != ?
          AND NOT EXISTS (
            SELECT 1 FROM account_suspensions
            WHERE account_suspensions.user_id = other_admin.user_id
              AND lifted_at IS NULL AND escalated_at IS NULL
          )
      `).bind(row.user_id).first();
      if (!otherOperationalAdmin) throw new HttpError('Cannot suspend the last remaining admin', 409);
    }
    throw new HttpError('That account is already suspended', 409);
  }
  await adminActionLogStatement(db, admin.user_id, 'suspend_account', 'user', row.user_id, {
    suspensionId, reason, evidenceNote, gracePeriodEndsAt,
  }).run();

  // #2031: an automated in-app notice, not the full admin-only evidenceNote
  // -- and routes disputes through the third-party CS agency (docs/SPEC.md
  // §6 P122), never the operator directly. No builder row (never happened
  // for a real, non-dev-mode account, but some pre-#1092 free-text builders
  // predate the user_id link entirely) just means nothing to notify.
  const suspendedBuilder = await db.prepare('SELECT * FROM builders WHERE user_id = ?').bind(row.user_id).first();
  if (suspendedBuilder) {
    // #2351: fireNotification's message is rendered as plain, unparsed text
    // client-side (appendNotificationRow, src/main.js) -- format the date
    // here rather than interpolating the raw ISO instant.
    const gracePeriodEndsAtFormatted = new Date(gracePeriodEndsAt).toLocaleDateString();
    await fireNotification(db, suspendedBuilder.builder_id,
      `Your account has been suspended. Reason: ${reason}. This suspension is in effect until ${gracePeriodEndsAtFormatted} unless lifted sooner. To dispute this, contact our customer service team -- they handle all suspension disputes and appeals.`);
  }

  // #2032: run only after the suspension itself is confirmed landed -- a
  // removeContent request against an account that turned out to already be
  // suspended (the 409 above) must not remove anything.
  const removedContent = removeContent
    ? await removeSuspendedUserPostedContent(db, admin.user_id, row.user_id)
    : null;
  // #2986: unconditional, unlike removedContent above -- see that
  // function's own comment for why.
  const { instancesRemoved } = await removeSuspendedSellerPlacedInstances(db, row.user_id);

  return json({
    suspension: {
      suspensionId, userId: row.user_id, adminUserId: admin.user_id, reason, evidenceNote,
      suspendedAt: new Date().toISOString(), gracePeriodEndsAt,
    },
    ...(removedContent ? { removedContent } : {}),
    instancesRemoved,
  });
}

// The inverse of handleSuspendAccount above -- lifts the currently-active
// suspension (if any) for the given email. Same atomic check-then-act
// shape as handleRevokeAdmin's own last-admin guard: the UPDATE's own
// WHERE clause is what actually confirms there was something to lift,
// rather than a separate SELECT racing a concurrent lift of the same row.
export async function handleUnsuspendAccount(request, db) {
  const admin = await requireAdmin(request, db);
  // #2118: same admin-action shape as handleSuspendAccount above, which
  // already has this guard -- reusing its own rate limit bucket/threshold
  // rather than introducing a new one for the identical kind of action.
  await checkRateLimit(db, `unsuspend-account:${admin.user_id}`, ACCOUNT_SUSPENSION_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const email = normalizeEmail(input.email);
  const row = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!row) throw new HttpError('No account with that email', 404);

  const liftedAt = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE account_suspensions SET lifted_at = ?, lifted_by_admin_user_id = ?
    WHERE user_id = ? AND lifted_at IS NULL AND escalated_at IS NULL
  `).bind(liftedAt, admin.user_id, row.user_id).run();
  if (result.meta.changes === 0) throw new HttpError('That account has no active suspension', 409);
  const suspension = await db.prepare(`
    SELECT * FROM account_suspensions WHERE user_id = ? AND lifted_at = ? ORDER BY suspended_at DESC LIMIT 1
  `).bind(row.user_id, liftedAt).first();
  await adminActionLogStatement(db, admin.user_id, 'unsuspend_account', 'user', row.user_id, {
    suspensionId: suspension.suspension_id,
  }).run();

  // Mirrors handleSuspendAccount's own #2031 notice above -- the user was
  // told they were suspended, so they should also be told it's lifted,
  // rather than only discovering it by trying to log in anyway. Same
  // FK-swallow skip for a pre-#1092 free-text builder with no user_id link.
  const unsuspendedBuilder = await db.prepare('SELECT * FROM builders WHERE user_id = ?').bind(row.user_id).first();
  if (unsuspendedBuilder) {
    await fireNotification(db, unsuspendedBuilder.builder_id,
      'Your account suspension has been lifted. You can use higglehaven again.');
  }

  // #2986: restores every pending suspended-seller-content snapshot for
  // this account, if it has a seller profile at all.
  const unsuspendedSeller = await db.prepare('SELECT seller_id FROM sellers WHERE user_id = ?').bind(row.user_id).first();
  const { instancesRestored } = unsuspendedSeller
    ? await restoreSuspendedSellerPlacedInstances(db, unsuspendedSeller.seller_id)
    : { instancesRestored: 0 };

  return json({ suspension: { suspensionId: suspension.suspension_id, userId: row.user_id, liftedAt }, instancesRestored });
}

// #2985: a reusable version of the same "is this account currently
// suspended" check requireCurrentUser/handleSuspensionStatus/reputation.js
// each already inline their own copy of, for callers that need to check a
// THIRD PARTY's standing (a listing's seller, not the calling session) --
// e.g. blocking a purchase from, or hiding the catalog listings of, a
// suspended seller. userId may be null (a seller/builder row with no
// linked user, e.g. ON DELETE SET NULL after the account self-deleted, or
// a system/placeholder seller that was never a real account) -- that's
// never itself a suspension.
export async function isUserSuspended(db, userId) {
  if (!userId) return false;
  const active = await db.prepare(`
    SELECT 1 FROM account_suspensions WHERE user_id = ? AND lifted_at IS NULL AND escalated_at IS NULL
  `).bind(userId).first();
  return !!active;
}

// Lets an admin check an account's current suspension state before acting
// on it (or before #2030/#2031/#2032/#2033 each need to read it back for
// their own purposes) without direct D1 access.
export async function handleSuspensionStatus(request, db, url) {
  await requireAdmin(request, db);
  const email = normalizeEmail(url.searchParams.get('email') || '');
  if (!email) throw new HttpError('email query parameter is required', 400);
  const row = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!row) throw new HttpError('No account with that email', 404);
  const active = await db.prepare(`
    SELECT * FROM account_suspensions WHERE user_id = ? AND lifted_at IS NULL AND escalated_at IS NULL
  `).bind(row.user_id).first();
  return json({
    suspension: active ? {
      suspensionId: active.suspension_id,
      userId: active.user_id,
      adminUserId: active.admin_user_id,
      reason: active.reason,
      evidenceNote: active.evidence_note,
      suspendedAt: active.suspended_at,
      gracePeriodEndsAt: active.grace_period_ends_at,
    } : null,
  });
}

// #2757: suspend-account above takes only an exact email with no
// confirmation step -- the owner's own framing: "The 'Suspend account'
// feature should be from a page displaying information about a given
// user, so that we're sure we're suspending the right one." These two
// read-only lookups back that page: search finds candidates by partial,
// case-insensitive username/email match, and detail shows one account's
// full picture (including its past suspend/lift/escalate history, not
// just whether it's currently suspended) before an admin commits to
// suspend-account's own exact-email call. Deliberately unrated-limited,
// same as handleSuspensionStatus/handleListAdmins just above -- this
// codebase's established convention is that a read-only requireAdmin GET
// doesn't get its own checkRateLimit bucket the way a repeatable mutation
// does (suspend-account, grant-admin, etc.).
//
// Bounded (ADMIN_USER_SEARCH_RESULT_LIMIT) so a short/common query (e.g.
// "a") can't return the entire users table -- the results table this
// feeds is meant for picking one specific account out of a few
// candidates, not for browsing the whole roster.
const ADMIN_USER_SEARCH_RESULT_LIMIT = 25;

export async function handleAdminUserSearch(request, db, url) {
  await requireAdmin(request, db);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) throw new HttpError('q query parameter is required', 400);
  // Substring search via instr(), not LIKE -- confirmed directly against a
  // real D1 instance that a `col LIKE ?` comparison (with or without
  // ESCAPE/COLLATE NOCASE, with or without wrapping either side in
  // lower()) can outright reject an entirely unremarkable query string
  // (e.g. a plain hyphenated alphanumeric name, no wildcards at all) with
  // "LIKE or GLOB pattern too complex" -- some property of D1's own LIKE
  // pattern-complexity accounting, triggered by ordinary admin input this
  // feature can't predict or restrict. instr() needs no pattern syntax at
  // all (no wildcards to interpret, so no escaping needed either), and
  // the same probe confirmed it never hits this rejection. Case-
  // insensitivity comes from lower()-wrapping both sides directly, since
  // instr() has no COLLATE-based equivalent.
  const needle = q.toLowerCase();
  const { results } = await db.prepare(`
    SELECT
      users.user_id, users.username, users.email, users.trust_tier, users.created_at,
      builders.builder_id AS builder_id,
      sellers.seller_id AS seller_id,
      EXISTS (
        SELECT 1 FROM account_suspensions
        WHERE account_suspensions.user_id = users.user_id
          AND lifted_at IS NULL AND escalated_at IS NULL
      ) AS has_active_suspension
    FROM users
    LEFT JOIN builders ON builders.user_id = users.user_id
    LEFT JOIN sellers ON sellers.user_id = users.user_id
    WHERE instr(lower(users.username), ?) > 0
       OR instr(lower(users.email), ?) > 0
    ORDER BY users.username COLLATE NOCASE ASC
    LIMIT ?
  `).bind(needle, needle, ADMIN_USER_SEARCH_RESULT_LIMIT).all();
  return json({
    users: results.map((row) => ({
      userId: row.user_id,
      username: row.username,
      email: row.email,
      trustTier: row.trust_tier,
      createdAt: row.created_at,
      hasBuilderProfile: row.builder_id !== null,
      hasSellerProfile: row.seller_id !== null,
      hasActiveSuspension: row.has_active_suspension === 1,
    })),
  });
}

export async function handleAdminUserDetail(request, db, url) {
  await requireAdmin(request, db);
  const userId = (url.searchParams.get('userId') || '').trim();
  if (!userId) throw new HttpError('userId query parameter is required', 400);
  const row = await db.prepare(
    'SELECT user_id, username, email, trust_tier, created_at, email_verified_at FROM users WHERE user_id = ?',
  ).bind(userId).first();
  if (!row) throw new HttpError('No account with that userId', 404);
  const builder = await db.prepare('SELECT builder_id, label FROM builders WHERE user_id = ?').bind(userId).first();
  const seller = await db.prepare('SELECT seller_id, label FROM sellers WHERE user_id = ?').bind(userId).first();
  // Every past suspend/lift/escalate cycle for this account, not just
  // whether one is currently active (handleSuspensionStatus's own job) --
  // the whole point of this detail view is to let an admin see the full
  // history before deciding to suspend again.
  const { results: suspensionRows } = await db.prepare(`
    SELECT suspension_id, admin_user_id, reason, evidence_note, suspended_at,
      grace_period_ends_at, lifted_at, lifted_by_admin_user_id, escalated_at
    FROM account_suspensions WHERE user_id = ? ORDER BY suspended_at DESC
  `).bind(userId).all();
  return json({
    user: {
      userId: row.user_id,
      username: row.username,
      email: row.email,
      trustTier: row.trust_tier,
      createdAt: row.created_at,
      emailVerifiedAt: row.email_verified_at,
      builderId: builder ? builder.builder_id : null,
      builderLabel: builder ? builder.label : null,
      sellerId: seller ? seller.seller_id : null,
      sellerLabel: seller ? seller.label : null,
    },
    suspensions: suspensionRows.map((s) => ({
      suspensionId: s.suspension_id,
      adminUserId: s.admin_user_id,
      reason: s.reason,
      evidenceNote: s.evidence_note,
      suspendedAt: s.suspended_at,
      gracePeriodEndsAt: s.grace_period_ends_at,
      liftedAt: s.lifted_at,
      liftedByAdminUserId: s.lifted_by_admin_user_id,
      escalatedAt: s.escalated_at,
    })),
  });
}
