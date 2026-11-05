// #3140 (sub-issue 1/2 of #3124, owner-approved 2026-11-05): a durable block
// between two people, keyed on the account (user_id). Standing decisions
// applied here (AGENTS.md): "A block is silent" -- the blocked person is
// never told, by notification or by any response that differs from a
// stranger's; "Anything about a person as a person keys on the account".
// This module lands the table's API; the per-surface filters that make a
// block take effect on presence, chat, voice, DMs and friend requests are
// #3143 (2/2), each tested on its own.
import { json, HttpError } from './http.js';
import { readJson } from './validation.js';
import { checkRateLimit } from './rate-limit.js';
import { requireCurrentUser } from './auth.js';

const BLOCK_MUTATE_RATE_LIMIT_MAX = 20;
const BLOCK_LIST_LIMIT = 200;

function optionalId(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new HttpError(`${field} must be a non-empty string`, 400);
  }
  return value.trim();
}

// The client knows the other person by whichever id the surface it is on
// exposes (a builder id on presence, chat and friends; a user id elsewhere).
// Never trust a client-supplied mapping: the server resolves a builder id to
// its account itself. Returns null when no live account matches.
async function resolveTargetUserId(db, { userId, builderId }) {
  if (userId) {
    const row = await db.prepare('SELECT user_id FROM users WHERE user_id = ? AND deleted_at IS NULL')
      .bind(userId).first();
    return row ? row.user_id : null;
  }
  const row = await db.prepare(`
    SELECT u.user_id AS user_id FROM builders b
    JOIN users u ON u.user_id = b.user_id
    WHERE b.builder_id = ? AND u.deleted_at IS NULL
  `).bind(builderId).first();
  return row ? row.user_id : null;
}

function blockFromRow(row) {
  return { userId: row.blocked_user_id, username: row.username, blockedAt: row.created_at };
}

// POST /api/blocks, DELETE /api/blocks/:userId, GET /api/blocks. Any signed-in
// account may block: blocking is protective, so it deliberately does not need
// ID verification, only a current (not suspended) session.
export async function handleBlocks(request, db, route) {
  const user = await requireCurrentUser(request, db);

  if (request.method === 'GET' && route.length === 1) {
    const { results } = await db.prepare(`
      SELECT b.blocked_user_id AS blocked_user_id, u.username AS username, b.created_at AS created_at
      FROM user_blocks b
      JOIN users u ON u.user_id = b.blocked_user_id
      WHERE b.blocker_user_id = ?
      ORDER BY b.created_at DESC, b.blocked_user_id
      LIMIT ?
    `).bind(user.user_id, BLOCK_LIST_LIMIT).all();
    return json({ blocks: results.map(blockFromRow) });
  }

  if (request.method === 'POST' && route.length === 1) {
    await checkRateLimit(db, `block-mutate:${user.user_id}`, BLOCK_MUTATE_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const userId = optionalId(input.userId, 'userId');
    const builderId = optionalId(input.builderId, 'builderId');
    if (!userId && !builderId) throw new HttpError('userId or builderId is required', 400);
    const targetUserId = await resolveTargetUserId(db, { userId, builderId });
    if (!targetUserId) throw new HttpError('That person could not be found', 404);
    if (targetUserId === user.user_id) throw new HttpError("You can't block yourself", 400);
    // One atomic batch: the block row, and the silent severing of any
    // friendship or pending request between the two people. Friendships are
    // still keyed on builder ids (#3141 migrates them), so both directions
    // are matched through each account's builder profile. No notification
    // is written for either side: a block is silent.
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO user_blocks (blocker_user_id, blocked_user_id) VALUES (?, ?)')
        .bind(user.user_id, targetUserId),
      db.prepare(`
        DELETE FROM friendships
        WHERE (requester_builder_id IN (SELECT builder_id FROM builders WHERE user_id = ?)
               AND recipient_builder_id IN (SELECT builder_id FROM builders WHERE user_id = ?))
           OR (requester_builder_id IN (SELECT builder_id FROM builders WHERE user_id = ?)
               AND recipient_builder_id IN (SELECT builder_id FROM builders WHERE user_id = ?))
      `).bind(user.user_id, targetUserId, targetUserId, user.user_id),
      // #3143: a block severs friend voice channel membership the same way it
      // severs the friendship -- the blocked person leaves the blocker's
      // channel and the blocker leaves theirs, silently.
      db.prepare(`
        DELETE FROM friend_voice_channel_members
        WHERE (owner_builder_id IN (SELECT builder_id FROM builders WHERE user_id = ?)
               AND member_builder_id IN (SELECT builder_id FROM builders WHERE user_id = ?))
           OR (owner_builder_id IN (SELECT builder_id FROM builders WHERE user_id = ?)
               AND member_builder_id IN (SELECT builder_id FROM builders WHERE user_id = ?))
      `).bind(user.user_id, targetUserId, targetUserId, user.user_id),
    ]);
    return json({ blocked: true, userId: targetUserId }, 201);
  }

  if (request.method === 'DELETE' && route.length === 2) {
    await checkRateLimit(db, `block-mutate:${user.user_id}`, BLOCK_MUTATE_RATE_LIMIT_MAX);
    // Idempotent: unblocking someone who isn't blocked is the same success.
    await db.prepare('DELETE FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?')
      .bind(user.user_id, route[1]).run();
    return json({ blocked: false, userId: route[1] });
  }

  return json({ error: 'Not found' }, 404);
}
