// #4136: the database half of the username rules (worker/lib/username-rules.js is the pure half).
import { usernameSkeleton } from './username-rules.js';

const BACKFILL_BATCH = 200;

// Fills in the folded form for accounts that predate migration 0235 (and for accounts made by paths that do not set
// it, such as the fleet's own login). A few at a time, so no single request does a long write; each name check calls
// it first, so a name is always compared against every account that has one by then. At today's size one call covers
// everyone; past a few thousand unfilled rows it needs a bigger batch or a one-off script.
export async function ensureUsernameSkeletons(db) {
  for (let round = 0; round < 5; round += 1) {
    const { results } = await db.prepare(
      'SELECT user_id, username FROM users WHERE username_skeleton IS NULL LIMIT ?',
    ).bind(BACKFILL_BATCH).all();
    if (!results || results.length === 0) return;
    await db.batch(results.map((row) => db.prepare(
      'UPDATE users SET username_skeleton = ? WHERE user_id = ? AND username_skeleton IS NULL',
    ).bind(usernameSkeleton(row.username ?? ''), row.user_id)));
    if (results.length < BACKFILL_BATCH) return;
  }
}
