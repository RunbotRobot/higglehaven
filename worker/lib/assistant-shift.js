// #3449 (part of #3444): assistants on shift. An assistant session (a Claude Code
// session whose only job is helping shoppers, owner decision 2026-11-11) has no
// browser, so it keeps itself on shift with a heartbeat and the server decides
// where it stands.
//
//   POST /api/assistant/heartbeat { busy?: boolean }
//     Only an assistant account (a fleet account whose username is an agent
//     name, see fleet-agents.js) may call it; anyone else, a coding session's
//     fleet account included, gets 403.
//
// While the heartbeat is fresh the assistant appears in GET /api/presence for
// shoppers standing on its landlet; when it lapses the assistant is simply gone.
import { json, HttpError } from './http.js';
import { requireSessionBuilder } from './auth.js';
import { checkRateLimit } from './rate-limit.js';
import { readJson } from './validation.js';
import { ASSISTANT_AGENT_NAMES, isAssistantUsername } from './fleet-agents.js';

// A heartbeat younger than this means on shift. The session beats well inside
// it (every 30 s); a missed beat or two does not make the assistant vanish.
export const ASSISTANT_SHIFT_STALE_AFTER_MS = 90_000;
const ASSISTANT_HEARTBEAT_RATE_LIMIT_MAX = 60;
// A ring of spots around a public landlet's centre, so two assistants on one
// landlet do not stand on each other.
const ASSISTANT_SPOT_RADIUS_M = 6;

// Pure: where an assistant stands. Public land only (greenbelt: a builder's own
// landlet is never used), one landlet per assistant chosen by its place in the
// agent list, so it is stable while the set of greenbelt landlets is. Returns
// null when there is no public landlet at all.
//   landlets: [{ landlet_id, center_x_m, center_y_m, elevation_m }]
export function assistantSpot(agentName, landlets) {
  if (!landlets.length) return null;
  const index = Math.max(0, ASSISTANT_AGENT_NAMES.findIndex((name) => name.toLowerCase() === String(agentName).toLowerCase()));
  const sorted = [...landlets].sort((a, b) => (a.landlet_id < b.landlet_id ? -1 : a.landlet_id > b.landlet_id ? 1 : 0));
  const landlet = sorted[index % sorted.length];
  // Assistants sharing a landlet take different points on the ring.
  const sharing = Math.floor(index / sorted.length);
  const angle = (sharing * 2.399963) % (Math.PI * 2); // golden angle: spread, never repeating
  return {
    landletId: landlet.landlet_id,
    x: landlet.center_x_m + Math.cos(angle) * ASSISTANT_SPOT_RADIUS_M,
    y: landlet.center_y_m + Math.sin(angle) * ASSISTANT_SPOT_RADIUS_M,
    z: landlet.elevation_m ?? 0,
    // Facing the landlet's centre, where arriving shoppers come from.
    heading: Math.atan2(-Math.sin(angle), -Math.cos(angle)),
  };
}

export async function handleAssistant(request, db, route) {
  if (request.method === 'POST' && route.length === 2 && route[1] === 'heartbeat') {
    const sessionBuilder = await requireSessionBuilder(request, db);
    const account = await db.prepare('SELECT is_fleet, username FROM users WHERE user_id = ?').bind(sessionBuilder.user_id).first();
    if (account?.is_fleet !== 1 || !isAssistantUsername(account.username)) {
      throw new HttpError('Only an assistant account can report that it is on shift.', 403);
    }
    await checkRateLimit(db, `assistant-heartbeat:${sessionBuilder.user_id}`, ASSISTANT_HEARTBEAT_RATE_LIMIT_MAX);
    const input = await readJson(request);
    if (input.busy !== undefined && typeof input.busy !== 'boolean') {
      throw new HttpError('busy must be true or false', 400);
    }
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO assistant_shifts (user_id, last_seen_at, busy) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
        busy = CASE WHEN ? THEN excluded.busy ELSE assistant_shifts.busy END
    `).bind(sessionBuilder.user_id, now, input.busy ? 1 : 0, input.busy === undefined ? 0 : 1).run();
    return json({ onShift: true, busy: Boolean(input.busy), at: now });
  }
  return json({ error: 'Not found' }, 404);
}

// Presence rows for the assistants on shift whose spot is this landlet, in the
// shape handlePresence's other rows have (plus the fields avatarPresenceFromRow
// reads for an assistant). Empty when none are on shift or the landlet is not an
// assistant's spot.
export async function onShiftAssistantRowsFor(db, landletId, excludeUserIds = []) {
  const staleBefore = new Date(Date.now() - ASSISTANT_SHIFT_STALE_AFTER_MS).toISOString();
  const { results: shifts } = await db.prepare(`
    SELECT assistant_shifts.user_id, assistant_shifts.last_seen_at, assistant_shifts.busy,
      users.username AS fleet_username, users.is_fleet AS is_fleet, builders.builder_id AS builder_id
    FROM assistant_shifts
    JOIN users ON users.user_id = assistant_shifts.user_id
    JOIN builders ON builders.user_id = assistant_shifts.user_id
    WHERE assistant_shifts.last_seen_at >= ? AND users.is_fleet = 1
  `).bind(staleBefore).all();
  const onShift = shifts.filter((row) => isAssistantUsername(row.fleet_username) && !excludeUserIds.includes(row.user_id));
  if (!onShift.length) return [];
  const { results: landlets } = await db.prepare(
    "SELECT landlet_id, center_x_m, center_y_m, elevation_m FROM landlets WHERE status = 'greenbelt'",
  ).all();
  const rows = [];
  for (const shift of onShift) {
    const spot = assistantSpot(shift.fleet_username, landlets);
    if (!spot || spot.landletId !== landletId) continue;
    rows.push({
      user_id: shift.user_id,
      builder_id: shift.builder_id,
      landlet_id: spot.landletId,
      x: spot.x, y: spot.y, z: spot.z, heading: spot.heading,
      flying: 0,
      updated_at: shift.last_seen_at,
      is_fleet: 1,
      fleet_username: shift.fleet_username,
      assistant_busy: shift.busy === 1,
    });
  }
  return rows;
}
