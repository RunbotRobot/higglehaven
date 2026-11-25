// #4175 (slice c): the owner's switch for the look-only admin role. A full admin turns it on or off for one
// account from the admin dashboard (a confirmation modal says what the account will see); no session sets the
// flag by SQL. Each change is written to the admin log, in the same batch as the change.
//
// Who may be given it: a fleet account that is not an assistant. The role exists so a coding session can look
// at the owner's tools, and a coding session signs in as a fleet account. A person's account, an assistant
// (which reads shoppers' text) and an admin (who has more already) are refused, each with its reason.
import { HttpError, json } from './http.js';
import { readJson } from './validation.js';
import { requireAdmin, requireAdminOrViewer } from './auth.js';
import { isAssistantUsername } from './fleet-agents.js';
import { adminActionLogStatement } from './admin-log.js';

// Why this account cannot hold the role, or null when it can. Used by the route and by the dashboard (through
// the user detail), so the control is not drawn for an account it can only refuse.
export function viewerRefusalFor(user) {
  if (user.deleted_at) return 'That account has been deleted.';
  if (user.is_admin === 1) return 'An admin already has full access.';
  if (user.is_fleet !== 1) return 'Look-only access is only for a fleet account.';
  if (isAssistantUsername(user.username)) return 'An assistant cannot be given look-only access.';
  return null;
}

export async function handleAdminSetViewer(request, db) {
  const admin = await requireAdmin(request, db);
  const input = await readJson(request);
  const userId = typeof input.userId === 'string' ? input.userId : '';
  if (!userId) throw new HttpError('userId is required', 400);
  if (typeof input.enabled !== 'boolean') throw new HttpError('enabled must be true or false', 400);
  const user = await db.prepare(
    'SELECT user_id, username, is_admin, is_fleet, is_admin_viewer, deleted_at FROM users WHERE user_id = ?',
  ).bind(userId).first();
  if (!user) throw new HttpError('No account with that userId', 404);
  // Turning it off is always allowed (an account that stopped qualifying must still be able to lose it).
  if (input.enabled) {
    const refusal = viewerRefusalFor(user);
    if (refusal) throw new HttpError(refusal, 409);
  }
  const target = input.enabled ? 1 : 0;
  if (user.is_admin_viewer === target) return json({ userId, adminViewer: input.enabled, changed: false });
  await db.batch([
    db.prepare("UPDATE users SET is_admin_viewer = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?").bind(target, userId),
    adminActionLogStatement(db, admin.user_id, input.enabled ? 'admin_viewer_granted' : 'admin_viewer_removed', 'user', userId, { username: user.username }),
  ]);
  return json({ userId, adminViewer: input.enabled, changed: true });
}

// GET /api/auth/admin-role: which dashboard this caller has. The page asks once when it opens; a viewer's
// ask is the "page open" line in the admin log (the dashboard route itself hands off to a static file).
export async function handleAdminRole(request, db) {
  const user = await requireAdminOrViewer(request, db);
  if (!user.adminViewer) return json({ role: 'admin' });
  await adminActionLogStatement(db, user.user_id, 'admin_viewer_page_open', 'page', '/admin/dashboard', { username: user.username }).run();
  return json({ role: 'viewer' });
}
