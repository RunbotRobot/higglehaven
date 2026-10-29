// #2388 (owner decision 2026-10-20): the moderator/admin-removal
// counterpart to recordContentEditHistory (worker/index.js) -- that
// function only ever runs on an author's own self-edit/delete.
// moderation_removal_snapshots (migrations/0168) is the separate,
// admin-only table a moderator/admin/seller removal now writes to
// instead, so these two concerns -- an author's own dispute-ready
// history vs. a moderator's removal record -- never share storage,
// visibility, or retention policy.
import { HttpError } from './http.js';

// The owner's own suggested category set, open to refinement later per
// that same decision -- deliberately a fixed, small list (not free
// text), since category is what drives the retention split below, not
// just a label.
export const MODERATION_REMOVAL_CATEGORIES = ['harassment', 'spam', 'scam', 'sexual_content', 'other'];

// Validates the `category` field every moderator/admin/seller removal
// path now requires in its request body -- shared by every call site so
// the 400 message and the allowed set can never drift between
// sign_posts/calendar_events/product_reviews.
export function moderationRemovalCategory(input) {
  const category = input?.category;
  if (typeof category !== 'string' || !MODERATION_REMOVAL_CATEGORIES.includes(category)) {
    throw new HttpError(`category must be one of: ${MODERATION_REMOVAL_CATEGORIES.join(', ')}`, 400);
  }
  return category;
}

// Owner decision (2026-10-20): "If category is sexual_content: hard
// delete, nothing retained anywhere... not in a snapshot, not even as a
// text fragment... no exceptions." Every other category gets a real
// snapshot of the row as it existed right before removal, same dispute-
// retention spirit as recordContentEditHistory's own author-initiated
// snapshots. `removedByUserId` may be null (the product_reviews
// anonymous/orphaned-template delete path has no authenticated caller at
// all) -- moderation_removal_snapshots.removed_by_user_id is nullable
// for exactly this reason, same as user_content_edit_history's own
// ON DELETE SET NULL column.
export async function recordModerationRemovalSnapshot(db, sourceTable, sourceId, category, row, removedByUserId) {
  await db.prepare(`
    INSERT INTO moderation_removal_snapshots
      (snapshot_id, source_table, source_id, removed_category, snapshot_json, removed_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    `modsnap-${crypto.randomUUID()}`,
    sourceTable,
    sourceId,
    category,
    category === 'sexual_content' ? null : JSON.stringify(row),
    removedByUserId ?? null,
  ).run();
}
