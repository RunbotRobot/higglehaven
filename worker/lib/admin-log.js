// #2501: accountability-record helper for admin-gated mutations, used
// from 26 distinct handle* route handlers plus 9 other internal callers
// spanning auth, land, commerce, and scheduled-task code -- extracted
// verbatim, zero behavior change.

// #814: accountability record for an admin-gated mutation — who did what,
// not just whether it was allowed. Returns a statement (same shape as
// worker/index.js's own notificationStatement) so call sites can batch it
// atomically alongside their own mutation rather than risk the mutation
// succeeding with no log row if a separate .run() failed. detail is any
// small JSON-serializable context worth keeping (e.g. the affected
// email/amount); optional since not every action needs it.
export function adminActionLogStatement(db, adminUserId, actionType, targetType, targetId, detail) {
  return db.prepare(
    'INSERT INTO admin_action_log (log_id, admin_user_id, action_type, target_type, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(
    `admin-action-${crypto.randomUUID()}`,
    adminUserId,
    actionType,
    targetType ?? null,
    targetId ?? null,
    detail !== undefined ? JSON.stringify(detail) : null,
  );
}
