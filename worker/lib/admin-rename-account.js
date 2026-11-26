// #4407 (part 2): the admin dashboard's "Rename" for the owner's one existing name with a space. The owner decided a
// username has no spaces and asked for the existing ones to change, and that no session does it by hand or by SQL
// ("Clean-up of live data is done by the owner's own tap"): so this is the tool.
//
//   POST /api/auth/admin-rename-account   { userId, newUsername }   full admin only (a look-only account is refused)
//
// It applies the SAME rule as sign-up and a person's own rename (normalizeUsername, the reserved names, the folded
// uniqueness), so a name it sets is one a person could have chosen. It sets the account's username and its builder
// label together, as the person's own rename does ("One alias per person"); everything that shows the name follows.
// The person gets a notice saying their name changed and why ("No silent loss"), and the change is written to the
// admin log. Refused, each with its reason: an account that is deleted, a fleet account or assistant (their names are
// the fleet's), and a name someone else already holds.
import { HttpError, json } from './http.js';
import { readJson } from './validation.js';
import { requireAdmin } from './auth.js';
import { normalizeUsername, usernameSkeleton, isReservedSkeleton } from './username-rules.js';
import { ensureUsernameSkeletons } from './username-store.js';
import { adminActionLogStatement } from './admin-log.js';
import { fireNotification } from './notifications.js';

const TAKEN = 'That name is already taken -- names must be unique, ignoring case';

export async function handleAdminRenameAccount(request, db) {
  const admin = await requireAdmin(request, db);
  const input = await readJson(request);
  const userId = typeof input.userId === 'string' ? input.userId : '';
  if (!userId) throw new HttpError('userId is required', 400);
  const user = await db.prepare('SELECT user_id, username, is_fleet, deleted_at FROM users WHERE user_id = ?').bind(userId).first();
  if (!user) throw new HttpError('No account with that id', 404);
  if (user.deleted_at) throw new HttpError('This account is deleted.', 409);
  if (user.is_fleet === 1) throw new HttpError('A fleet account or assistant keeps its name.', 409);

  // Strict on purpose: the admin tool never takes a name with a space, on any server.
  const username = normalizeUsername(input.newUsername);
  if (username === user.username) throw new HttpError('That is already this account\'s name.', 400);
  const skeleton = usernameSkeleton(username);
  if (isReservedSkeleton(skeleton)) throw new HttpError(TAKEN, 409);
  await ensureUsernameSkeletons(db);

  const builder = await db.prepare('SELECT builder_id FROM builders WHERE user_id = ?').bind(userId).first();
  // Same guard as the person's own rename (worker/index.js): no other account may hold the name or its folded form,
  // and no other builder its label; the label update only lands if the username update just before it did.
  const statements = [db.prepare(`
    UPDATE users SET username = ?, username_skeleton = ?
    WHERE user_id = ?
      AND NOT EXISTS (SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND user_id != ?)
      AND NOT EXISTS (SELECT 1 FROM users WHERE username_skeleton = ? AND user_id != ?)
      AND NOT EXISTS (SELECT 1 FROM builders WHERE label = ? COLLATE NOCASE AND user_id != ?)
  `).bind(username, skeleton, userId, username, userId, skeleton, userId, username, userId)];
  if (builder) {
    statements.push(db.prepare(`
      UPDATE builders SET label = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE builder_id = ? AND EXISTS (SELECT 1 FROM users WHERE user_id = ? AND username = ?)
    `).bind(username, builder.builder_id, userId, username));
  }
  const results = await db.batch(statements);
  if (results.some((result) => result.meta.changes === 0)) throw new HttpError(TAKEN, 409);

  await adminActionLogStatement(db, admin.user_id, 'rename_account', 'user', userId, {
    oldUsername: user.username,
    newUsername: username,
  }).run();
  if (builder) {
    // What a person reads: no issue numbers, no internals (public-facing copy rule).
    await fireNotification(db, builder.builder_id,
      `Your name was changed from "${user.username}" to "${username}". A name on higglehaven has no spaces. Everything shows the new name.`);
  }
  return json({ renamed: true, userId, oldUsername: user.username, username });
}
