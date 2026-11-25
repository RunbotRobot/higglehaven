// #4077: the admin dashboard's "Delete account" for the owner's clean-up of test accounts. It runs the
// SAME cascade a person's own deletion runs (cascadeDeleteAccount, worker/index.js) -- no second code
// path -- so listings, builds, sessions, friends and the rest end exactly as they do there, and the
// orders other people hold keep their own record ("An order is its own record").
//
// Two routes, both admin-only:
//   GET  /api/auth/admin-delete-account-preview?userId=  what goes with the account, in counts, and any
//                                                          refusal, so the modal can say so before a tap
//   POST /api/auth/admin-delete-account                    { userId, confirmUsername, includeFleet? }
//
// Refused, each with its reason: the admin's own account, any other admin, an account that is already
// deleted, an account that still owns a lándlet (the owner returns lándlets to the greenbelt first, #4075),
// and -- unless includeFleet is true -- a fleet account or an assistant. Money still owed either way (an
// unpaid payout, an order in flight) is refused by the cascade's own guards with their own words.
//
// The deletion is recorded in the admin action log after it succeeds (the cascade runs its own batch, so
// the log row cannot ride in it); the counts are read before, so the record says what went.
import { HttpError, json } from './http.js';
import { readJson } from './validation.js';
import { requireAdmin, requireAdminOrViewer } from './auth.js';
import { emailFor } from './admin-viewer-mask.js';
import { isAssistantUsername } from './fleet-agents.js';
import { adminActionLogStatement } from './admin-log.js';
import { cascadeDeleteAccount } from '../index.js';

async function targetAndCounts(db, userId) {
  const user = await db.prepare(`
    SELECT user_id, username, email, is_admin, is_fleet, deleted_at FROM users WHERE user_id = ?
  `).bind(userId).first();
  if (!user) throw new HttpError('No account with that id', 404);
  const builder = await db.prepare('SELECT builder_id FROM builders WHERE user_id = ?').bind(userId).first();
  const seller = await db.prepare('SELECT seller_id FROM sellers WHERE user_id = ?').bind(userId).first();
  const count = async (sql, ...binds) => (await db.prepare(sql).bind(...binds).first()).n;
  const counts = {
    landletsClaimed: builder
      ? await count(`SELECT count(*) AS n FROM landlets WHERE status = 'claimed' AND owner_builder_id = ?`, builder.builder_id)
      : 0,
    productsListed: seller
      ? await count('SELECT count(*) AS n FROM catalog_templates WHERE delisted_at IS NULL AND seller_id = ?', seller.seller_id)
      : 0,
    ordersAsBuyer: await count('SELECT count(*) AS n FROM purchases WHERE buyer_user_id = ?', userId),
    ordersAsSeller: await count('SELECT count(*) AS n FROM purchases WHERE seller_user_id = ?', userId),
    friends: await count(`SELECT count(*) AS n FROM friendships WHERE status = 'accepted'
      AND (requester_user_id = ?1 OR recipient_user_id = ?1)`, userId),
  };
  return { user, counts };
}

function kindOf(user) {
  if (user.is_admin === 1) return 'admin';
  if (user.is_fleet === 1) return isAssistantUsername(user.username) ? 'assistant' : 'fleet';
  return 'person';
}

// The reason this account cannot be deleted, or null. includeFleet is the explicit second tick.
function refusalFor(admin, user, counts, includeFleet) {
  if (user.deleted_at) return 'This account is already deleted.';
  if (user.user_id === admin.user_id) return 'You cannot delete your own account from here.';
  if (user.is_admin === 1) return 'Another admin\'s account cannot be deleted from here.';
  if (counts.landletsClaimed > 0) return 'Return its lándlet to the greenbelt first.';
  if (user.is_fleet === 1 && !includeFleet) {
    return `This is a ${kindOf(user) === 'assistant' ? 'assistant' : 'fleet'} account. Tick the box to delete it anyway.`;
  }
  return null;
}

export async function handleAdminDeleteAccountPreview(request, db, url) {
  const admin = await requireAdminOrViewer(request, db); // #4175: the preview only reads; the delete below stays admin-only
  const userId = url.searchParams.get('userId') || '';
  if (!userId) throw new HttpError('userId is required', 400);
  const { user, counts } = await targetAndCounts(db, userId);
  const fleet = user.is_fleet === 1 && user.is_admin !== 1;
  return json({
    account: { userId: user.user_id, username: user.username, email: emailFor(admin, user.email), kind: kindOf(user) },
    counts,
    refusal: refusalFor(admin, user, counts, false),
    // Whether the only thing in the way is the explicit tick for a fleet account or assistant.
    needsFleetTick: fleet && refusalFor(admin, user, counts, true) === null,
  });
}

export async function handleAdminDeleteAccount(request, db, env = null) {
  const admin = await requireAdmin(request, db);
  const input = await readJson(request);
  const userId = typeof input.userId === 'string' ? input.userId : '';
  if (!userId) throw new HttpError('userId is required', 400);
  const { user, counts } = await targetAndCounts(db, userId);
  const refusal = refusalFor(admin, user, counts, input.includeFleet === true);
  if (refusal) throw new HttpError(refusal, 409);
  if (input.confirmUsername !== user.username) {
    throw new HttpError('Type the account\'s username to confirm.', 400);
  }

  await cascadeDeleteAccount(db, user.user_id, env);

  await adminActionLogStatement(db, admin.user_id, 'delete_account', 'user', user.user_id, {
    username: user.username,
    email: user.email,
    kind: kindOf(user),
    ...counts,
  }).run();
  return json({ accountDeleted: true, userId: user.user_id });
}
