// #2537: presence/friendships/direct-messages/notifications -- the
// "social" domain (docs/SPEC.md §6: friend requests, social map, presence).
// Extracted verbatim from worker/index.js, zero behavior change.
//
// handleNotifications lives here rather than in worker/lib/notifications.js:
// that module is a shared low-level helper layer (notificationStatement/
// fireNotification/fireNotifications) imported from well outside the social
// domain -- auctions, disputes, admin actions all fire notifications through
// it. Bolting the full /api/notifications route handler (with its own
// auth/rate-limit/validation imports) onto that file would couple a
// cross-cutting helper module to one caller's route-handling needs. Every
// other extracted route-handler domain (builder-profile.js, auth-routes.js)
// keeps its own handlers in its own module and imports the shared low-level
// helpers it needs, rather than growing them in place -- handleNotifications
// follows that same precedent, as a fourth "my own social stuff" endpoint
// alongside presence/friendships/direct-messages, all reachable only by the
// session's own builder.
import { json, HttpError } from './http.js';
import {
  readJson, stringValue, finiteNumber, queryLimit, decodeCursor, encodeCursor,
} from './validation.js';
import { checkRateLimit } from './rate-limit.js';
import { requireCurrentUser, assertOwner, requireSessionBuilder } from './auth.js';
import { fireNotification } from './notifications.js';
import { getOrCreateBuilderForUser } from './builder-profile.js';
// requireLandlet/assertReferenceExists/labelsByBuilderId/
// ownedLandletsByBuilderId all stay in worker/index.js -- each is shared
// well outside the social domain, or, for labelsByBuilderId/
// ownedLandletsByBuilderId, is also needed by exportSocialSection
// (handleExportData), which itself stays in worker/index.js. See each
// symbol's own comment there for why it can't move here instead. This is
// the same intentional, safe circular import worker/lib/builder-profile.js
// and worker/lib/auth-routes.js already establish -- safe because every
// cross-reference below is read only inside an async handler function at
// request time, never at module evaluation time.
//
// requireSessionBuilder itself now lives in ./auth.js (moved there by
// #2543 after this module was first written -- see worker/lib/
// reputation.js's own comment for the same note) and is imported directly
// from there above, not re-imported back from index.js.
import {
  requireLandlet, assertReferenceExists,
  labelsByBuilderId, ownedLandletsByBuilderId,
} from '../index.js';

// Builder-facing notifications (see notifyBuildersOfDimensionChange) — a
// plain read-and-acknowledge list, not a full inbox: cursor-paginated
// (#320, see GET below) but no DELETE, since a read notification is still
// useful history for "wait, when did that change?"
// #984: the mark-read (PATCH) and mark-all-read (POST) branches below had
// no checkRateLimit call at all, unlike this file's other authenticated
// mutation resources (BUNDLE_MUTATE_RATE_LIMIT_MAX #892,
// FRIENDSHIP_MUTATE_RATE_LIMIT_MAX #899) — each is a real, uncached D1
// write with no cap on how often a builder can fire it against their own
// account.
const NOTIFICATION_MUTATE_RATE_LIMIT_MAX = 20;

export async function handleNotifications(request, db, route, url) {
  // Ahead of the generic list GET below (same "specific path before generic
  // CRUD" ordering handleBuilders' own GET /me uses) — the list itself is
  // capped at 100 rows (no pagination, matching this file's other
  // uncapped-in-practice lists like bundles/purchases), so its own length
  // can't answer "how many are unread" once a builder has more than that —
  // found via backlog audit: a popular auction alone can generate 100+ bid
  // notifications for its seller, at which point the unread badge
  // (refreshNotificationsBadge in src/main.js) was silently undercounting
  // by reading the capped list's own .length. A dedicated COUNT query has
  // no such cap.
  if (request.method === 'GET' && route.length === 2 && route[1] === 'unread-count') {
    const sessionBuilder = await requireSessionBuilder(request, db);
    const count = await db.prepare(`
      SELECT COUNT(*) AS count FROM notifications WHERE builder_id = ? AND read_at IS NULL
    `).bind(sessionBuilder.builder_id).first();
    return json({ count: count.count });
  }

  if (request.method === 'GET' && route.length === 1) {
    const sessionBuilder = await requireSessionBuilder(request, db);
    const builderIdParam = url.searchParams.get('builderId');
    const builderId = builderIdParam === null ? sessionBuilder.builder_id : stringValue(builderIdParam, 'builderId');
    assertOwner(builderId, sessionBuilder.builder_id, 'Not your notifications');
    const unreadOnlyParam = url.searchParams.get('unreadOnly');
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const conditions = ['builder_id = ?'];
    const bindings = [builderId];
    if (unreadOnlyParam === 'true') conditions.push('read_at IS NULL');
    // Newest-first (unlike this file's other cursor-paginated lists, all
    // ascending) — "older than the last row already seen" is the opposite
    // comparison, and DESC on both the primary and tiebreak columns keeps
    // one consistent page order across cursor pages, same as those.
    if (cursor) {
      conditions.push('(created_at < ? OR (created_at = ? AND notification_id < ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const { results } = await db.prepare(`
      SELECT * FROM notifications WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, notification_id DESC LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      notifications: page.map(notificationFromRow),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.notification_id) : null,
    });
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM notifications WHERE notification_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Notification not found' }, 404);
    const sessionBuilder = await requireSessionBuilder(request, db);
    assertOwner(existing.builder_id, sessionBuilder.builder_id, 'Not your notification');
    await checkRateLimit(db, `notification-mutate:${sessionBuilder.builder_id}`, NOTIFICATION_MUTATE_RATE_LIMIT_MAX);
    const input = await readJson(request);
    if (input.read === true) {
      // #2509: guarded on read_at IS NULL, matching every sibling mark-read
      // write (mark-all-read just below, direct-message mark-read, the
      // sold-out-marker dismiss) -- without it, a second PATCH (e.g. a fast
      // double-tap/Enter-plus-click before the first request's response
      // clears the click handler) re-stamps read_at to a later time than
      // when the user actually first read it.
      await db.prepare(`
        UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE notification_id = ? AND read_at IS NULL
      `).bind(route[1]).run();
    }
    const updated = await db.prepare('SELECT * FROM notifications WHERE notification_id = ?').bind(route[1]).first();
    // #2334: not found here means a concurrent self-delete cascade-deleted
    // this notification between the existence check above and here (three
    // awaits apart) -- a genuine 404, same shape handleFriendships' own
    // PATCH/accept branch already guards against, not a fabricated 200 or
    // an uncaught notificationFromRow(undefined) crash.
    if (!updated) return json({ error: 'Notification not found' }, 404);
    return json({ notification: notificationFromRow(updated) });
  }

  if (request.method === 'POST' && route.length === 2 && route[1] === 'mark-all-read') {
    // builderId always comes from the session now, never the request body —
    // marking someone else's notifications read isn't a feature.
    const sessionBuilder = await requireSessionBuilder(request, db);
    const builderId = sessionBuilder.builder_id;
    await checkRateLimit(db, `notification-mutate:${builderId}`, NOTIFICATION_MUTATE_RATE_LIMIT_MAX);
    await db.prepare(`
      UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE builder_id = ? AND read_at IS NULL
    `).bind(builderId).run();
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}

// Exported for worker/index.js's own exportSocialSection (handleExportData)
// -- see that function's own call site for why it stays there.
export function notificationFromRow(row) {
  return {
    notificationId: row.notification_id,
    builderId: row.builder_id,
    message: row.message,
    templateId: row.template_id,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

// #1099 (sub-issue of #1095, the multiplayer-presence tracking issue):
// returns other builders' last-reported avatar_presence rows, scoped to a
// single landlet/region at a time -- never the whole world's positions in
// one response, both for payload size and so a shopper elsewhere isn't
// visibly tracking someone's live position for no reason. Pairs with
// #1098's POST endpoint, which is the only writer of this table.
//
// A row older than this is treated as "not actually present" rather than
// a genuinely live position -- #1098's own POST endpoint rate-limits a
// given builder to roughly one write per 1-2s, so a few missed reports
// (a dropped request, brief network hiccup) shouldn't make them flicker
// out, but a builder who closed the tab or lost connectivity entirely
// should disappear within a handful of seconds, not linger indefinitely.
// The fuller version of this (actually deleting long-stale rows, not just
// filtering them at read time) is #1101's own scope.
const PRESENCE_STALE_AFTER_MS = 10_000;

// #1438: every other list-shaped GET in this file caps its row count (either
// real pagination, or a flat LIMIT 200 for a "snapshot, not something to
// paginate through" resource like sign_posts/calendar_events/seller_feedback
// above) -- this one was missed. A landlet with many concurrent visitors at
// once would otherwise return every one of them in a single response, and
// the client spawns a real avatar mesh group per entry on every poll tick.
const PRESENCE_NEARBY_LIMIT = 200;

// #1098 (sub-issue of #1095, multiplayer presence): a 15-minute window is
// this file's one shared RATE_LIMIT_WINDOW_MS (defined further below), so a
// literal cap here is picked to approximate the issue's own "~1 write per
// 1-2s" sustained target over that window, not a true per-second throttle —
// a burst can still spend the whole budget faster, same tradeoff every
// other checkRateLimit call in this file already accepts.
const PRESENCE_REPORT_RATE_LIMIT_MAX = 600;

// #1767: the "who's nearby" GET below had no rate limit at all, unlike its
// own POST sibling above and every other poll-while-something-is-live GET
// in this file (DIDIT_STATUS_RATE_LIMIT_MAX, VIDEO_GENERATION_STATUS_RATE_LIMIT_MAX).
// The client polls this at the same ~1/s cadence as its own presence
// report (SHOP_PRESENCE_POLL_INTERVAL_MS in src/main.js), so it shares
// PRESENCE_REPORT_RATE_LIMIT_MAX's own budget rather than the slower
// ~120/window peers, which poll a much less frequent async job status.
const PRESENCE_NEARBY_RATE_LIMIT_MAX = PRESENCE_REPORT_RATE_LIMIT_MAX;

// #2779 (sub-issue of #2777): extracted out of the GET branch below so the
// new nearby-chat endpoint further down this file can reuse the exact same
// "what landlet is the caller actually in right now" derivation -- #2269's
// own anti-spoof reasoning (never trust a client-supplied landletId; always
// derive it from the caller's own last-reported, not-yet-stale
// avatar_presence row) applies just as much to scoping a chat message as it
// does to scoping a presence read. null means "nowhere recent enough" —
// no nearby anything, presence or chat alike.
async function callersCurrentLandletId(db, builderId) {
  const staleBefore = new Date(Date.now() - PRESENCE_STALE_AFTER_MS).toISOString();
  const ownPresence = await db.prepare('SELECT landlet_id, updated_at FROM avatar_presence WHERE builder_id = ?')
    .bind(builderId).first();
  return ownPresence && ownPresence.updated_at >= staleBefore ? ownPresence.landlet_id : null;
}

export async function handlePresence(request, db, route, url) {
  // #1176 (sub-issue of #1174, spawn flow's "Go to Last Location" button):
  // the caller's own last-reported row, unfiltered by staleness or
  // landletId — unlike the GET below, this is "wherever I was last,"
  // however long ago, not "who's nearby right now." null when the caller
  // has never reported a position at all.
  if (request.method === 'GET' && route.length === 2 && route[1] === 'me') {
    const sessionBuilder = await requireSessionBuilder(request, db);
    const row = await db.prepare('SELECT * FROM avatar_presence WHERE builder_id = ?')
      .bind(sessionBuilder.builder_id).first();
    return json({ presence: row ? avatarPresenceFromRow(row) : null });
  }

  if (request.method === 'GET' && route.length === 1) {
    const sessionBuilder = await requireSessionBuilder(request, db);
    await checkRateLimit(db, `presence-nearby:${sessionBuilder.builder_id}`, PRESENCE_NEARBY_RATE_LIMIT_MAX);
    const staleBefore = new Date(Date.now() - PRESENCE_STALE_AFTER_MS).toISOString();
    // #2269: a client-supplied `landletId` query param used to be trusted
    // outright -- any verified account could enumerate landlet ids via the
    // public GET /api/landlets and then poll this endpoint for any of
    // them, continuously reading everyone else's live position there with
    // no proximity/consent requirement at all, defeating this function's
    // own stated "a shopper elsewhere isn't visibly tracking someone's
    // live position" intent above. Derive the landlet from the caller's
    // own last-reported avatar_presence row instead -- the same "don't
    // trust a client-supplied location claim" fix already applied to the
    // credit-orb collect endpoint (#2222) -- so a caller can only ever see
    // who's nearby wherever they themselves actually, recently were.
    const landletId = await callersCurrentLandletId(db, sessionBuilder.builder_id);
    if (landletId === null) {
      return json({ avatars: [] });
    }
    const { results } = await db.prepare(`
      SELECT * FROM avatar_presence
      WHERE landlet_id = ? AND builder_id != ? AND updated_at >= ?
      ORDER BY updated_at DESC LIMIT ${PRESENCE_NEARBY_LIMIT}
    `).bind(landletId, sessionBuilder.builder_id, staleBefore).all();
    // #2043: docs/SPEC.md's "Flying avatars are invisible to other users" --
    // the client is the one actually hiding the mesh, but a flying avatar's
    // position is still withheld here too, not just left to the renderer's
    // own discretion to respect. Never withhold the caller's own row from
    // themselves (irrelevant here, this query already excludes builder_id =
    // self) or from GET .../me (that endpoint is "where was I," unaffected).
    return json({ avatars: results.filter((row) => !row.flying).map(avatarPresenceFromRow) });
  }

  // #1098: upserts the caller's own live position into avatar_presence
  // (#1097/migrations/0100). Client-side movement throttling (only report
  // on meaningful movement) is the client-integration sub-issue's job
  // (#1100) — this endpoint stays safe to call as often as a client
  // likes, the rate limit above is the only thing actually bounding
  // write frequency.
  if (request.method === 'POST' && route.length === 1) {
    const sessionBuilder = await requireSessionBuilder(request, db);
    await checkRateLimit(db, `presence-report:${sessionBuilder.builder_id}`, PRESENCE_REPORT_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const x = finiteNumber(input.x, 'x');
    const y = finiteNumber(input.y, 'y');
    const z = finiteNumber(input.z, 'z');
    const heading = input.heading === undefined || input.heading === null ? null : finiteNumber(input.heading, 'heading');
    // #2043: whether the reporting builder is currently flying, so the
    // nearby-avatars GET above can withhold them per docs/SPEC.md's
    // "Flying avatars are invisible to other users" -- optional/defaults
    // to false so an older client (or a report with no flight state to
    // report) never accidentally marks someone permanently flying.
    const flying = input.flying === true;
    let landletId = null;
    if (input.landletId !== undefined && input.landletId !== null) {
      landletId = stringValue(input.landletId, 'landletId');
      // Cheap spoof guard: reject a report for a landlet that doesn't even
      // exist rather than trusting any client-supplied string verbatim —
      // #1099's own GET scopes its query by this column, so a bogus value
      // here would otherwise silently poison that lookup. This doesn't (and
      // can't cheaply) confirm the caller is actually near this landlet,
      // only that it's a real one.
      await requireLandlet(db, landletId);
    }
    await db.prepare(`
      INSERT INTO avatar_presence (builder_id, landlet_id, x, y, z, heading, flying, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(builder_id) DO UPDATE SET
        landlet_id = excluded.landlet_id, x = excluded.x, y = excluded.y, z = excluded.z,
        heading = excluded.heading, flying = excluded.flying, updated_at = excluded.updated_at
    `).bind(sessionBuilder.builder_id, landletId, x, y, z, heading, flying ? 1 : 0).run();
    const row = await db.prepare('SELECT * FROM avatar_presence WHERE builder_id = ?')
      .bind(sessionBuilder.builder_id).first();
    // #2492: not found here means a concurrent self-delete (migrations/0100's
    // own ON DELETE CASCADE on builder_id) landed in the single await gap
    // between the upsert above and this re-SELECT -- a genuine 404, same
    // race shape #2334/#2354/#2391/#2428/#2429 already fixed elsewhere, not
    // an uncaught null-dereference crash.
    if (!row) return json({ error: 'Your account was deleted concurrently — please sign in again' }, 404);
    return json({
      presence: {
        landletId: row.landlet_id,
        x: row.x,
        y: row.y,
        z: row.z,
        heading: row.heading,
        flying: Boolean(row.flying),
        updatedAt: row.updated_at,
      },
    });
  }

  return json({ error: 'Not found' }, 404);
}

// #2779 (sub-issue of #2777, proximity voice chat + general text chat):
// docs/SPEC.md §2's "Text chat available as an alternative [to voice]" --
// a nearby-avatars-only (not friend-only, not DM) text channel. Sized the
// same as DIRECT_MESSAGE_SEND_RATE_LIMIT_MAX's own window but higher, since
// an active nearby conversation between several people plausibly sends far
// more than DMs' own "occasional message to one specific friend" pattern.
const NEARBY_CHAT_SEND_RATE_LIMIT_MAX = 60;
// Same reasoning as PRESENCE_NEARBY_RATE_LIMIT_MAX above -- the client
// polls this at a comparable cadence while the chat panel is open (see
// src/shop/nearbyChat.js's own NEARBY_CHAT_POLL_INTERVAL_MS).
const NEARBY_CHAT_POLL_RATE_LIMIT_MAX = PRESENCE_REPORT_RATE_LIMIT_MAX;
const NEARBY_CHAT_POLL_LIMIT = 50;

function nearbyChatMessageFromRow(row) {
  return {
    messageId: row.message_id,
    builderId: row.builder_id,
    text: row.text,
    createdAt: row.created_at,
  };
}

export async function handleNearbyChat(request, db, route, url) {
  // docs/SPEC.md §6: "Full social features (voice, messaging, direct
  // communication) require government-ID verification specifically" --
  // the same id_verified-specific bar direct messages enforce above, not
  // presence/avatar-visibility's own looser "any non-'none' tier" gate.
  if (request.method === 'GET' && route.length === 1) {
    const sessionBuilder = await requireIdVerifiedSessionBuilder(request, db);
    await checkRateLimit(db, `nearby-chat-poll:${sessionBuilder.builder_id}`, NEARBY_CHAT_POLL_RATE_LIMIT_MAX);
    const landletId = await callersCurrentLandletId(db, sessionBuilder.builder_id);
    if (landletId === null) {
      // #2802: landletId still reported (null here) so the client can tell
      // "no nearby landlet" apart from an actual landlet id change -- see
      // this function's own comment on the main branch's landletId below.
      return json({ messages: [], nextCursor: null, landletId: null });
    }
    const limit = queryLimit(url.searchParams.get('limit'), NEARBY_CHAT_POLL_LIMIT);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const conditions = ['landlet_id = ?'];
    const bindings = [landletId];
    if (cursor) {
      // Ascending/"poll forward from here" ordering, unlike direct_messages'
      // own descending/"most recent page" cursor above -- this is a live feed
      // a client tails forward in time, not a history a client pages
      // backward through.
      conditions.push('(created_at > ? OR (created_at = ? AND message_id > ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const { results } = await db.prepare(`
      SELECT * FROM nearby_chat_messages WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ASC, message_id ASC LIMIT ?
    `).bind(...bindings, limit).all();
    const last = results.at(-1);
    return json({
      messages: results.map(nearbyChatMessageFromRow),
      // No new rows this poll -- echo the caller's own cursor back rather
      // than null, so a quiet stretch doesn't make the client forget its
      // place and silently re-fetch the same history it already has.
      nextCursor: last ? encodeCursor(last.created_at, last.message_id) : url.searchParams.get('cursor'),
      // #2802: the cursor above is only ever meaningful scoped to this one
      // landlet (the WHERE clause binds to it directly) -- without this, a
      // shopper who crosses into a different landlet has no way to tell,
      // so the client kept polling with a cursor computed against the
      // landlet they just left, silently skipping that landlet's own
      // already-older messages and mixing both conversations into one log.
      landletId,
    });
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    const sessionBuilder = await requireIdVerifiedSessionBuilder(request, db);
    await checkRateLimit(db, `nearby-chat-send:${sessionBuilder.builder_id}`, NEARBY_CHAT_SEND_RATE_LIMIT_MAX);
    const landletId = await callersCurrentLandletId(db, sessionBuilder.builder_id);
    if (landletId === null) {
      throw new HttpError('A recent position report is required before sending a nearby chat message', 400);
    }
    const text = stringValue(input.text, 'text');
    if (text.length > 280) throw new HttpError('text must be 280 characters or fewer', 400);
    const messageId = `nearby-chat-${crypto.randomUUID()}`;
    await db.prepare(`
      INSERT INTO nearby_chat_messages (message_id, builder_id, landlet_id, text)
      VALUES (?, ?, ?, ?)
    `).bind(messageId, sessionBuilder.builder_id, landletId, text).run();
    const row = await db.prepare('SELECT * FROM nearby_chat_messages WHERE message_id = ?').bind(messageId).first();
    return json({ message: nearbyChatMessageFromRow(row) }, 201);
  }

  return json({ error: 'Not found' }, 404);
}

function avatarPresenceFromRow(row) {
  return {
    builderId: row.builder_id,
    landletId: row.landlet_id,
    x: row.x,
    y: row.y,
    z: row.z,
    heading: row.heading,
    flying: Boolean(row.flying),
    updatedAt: row.updated_at,
  };
}

// Friend requests (docs/SPEC.md §6: "Friend/group systems: standard friend
// requests; social map shows an accepted friend's location."). One row per
// relationship, direction preserved (requester/recipient), status flips
// pending -> accepted in place. PATCH is gated to the recipient (only they
// can accept) and DELETE to either side (either can end/decline it) — both
// enforced below via requireSessionBuilder + assertOwner, not left to the
// frontend to police.
//
// "Social map" is deliberately simplified to each accepted friend's owned
// lándlet center — exact coordinates, not fuzzed (owner decision, #1195: a
// mutual accept is a real consent step, so there's no reason to withhold
// precision once it's happened). This predates #1095's own avatar_presence
// table (live position tracking) — upgrading to a friend's actual current
// position is #1044's own remit (friend "follow"/"stay with"), not a
// change made here. A builder's claimed lándlet is the one stable,
// already-known location the backend actually has for them.
// See the POST branch's own comment below (issue #369) — an authenticated
// builder id, not an IP, since this gates a real account's own request
// volume rather than an anonymous caller's.
const FRIEND_REQUEST_RATE_LIMIT_MAX = 20;
// #899: the accept (PATCH) and decline/cancel/unfriend (DELETE) branches
// below had no checkRateLimit call at all, unlike POST just above — each
// fires a real notification to the other party (same shape #369 already
// throttled for creation), same fix pattern as BUNDLE_MUTATE_RATE_LIMIT_MAX
// (#892).
const FRIENDSHIP_MUTATE_RATE_LIMIT_MAX = 20;

export async function handleFriendships(request, db, route, url) {
  if (request.method === 'GET' && route.length === 1) {
    const sessionBuilder = await requireSessionBuilder(request, db);
    const builderIdParam = url.searchParams.get('builderId');
    const builderId = builderIdParam === null ? sessionBuilder.builder_id : stringValue(builderIdParam, 'builderId');
    assertOwner(builderId, sessionBuilder.builder_id, 'Not your friendships');
    // #728: cursor-paginated, same newest-first shape GET /api/notifications
    // already uses (DESC on both the primary and tiebreak columns) — this
    // endpoint had no LIMIT at all before, the one list handler in this file
    // that #711's own sibling-endpoint audit missed.
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const conditions = ['(requester_builder_id = ? OR recipient_builder_id = ?)'];
    const bindings = [builderId, builderId];
    if (cursor) {
      conditions.push('(created_at < ? OR (created_at = ? AND friendship_id < ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const { results } = await db.prepare(`
      SELECT * FROM friendships WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, friendship_id DESC LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const otherBuilderIds = page.map((row) =>
      row.requester_builder_id === builderId ? row.recipient_builder_id : row.requester_builder_id);
    const labelsById = await labelsByBuilderId(db, otherBuilderIds);
    const landletsById = await ownedLandletsByBuilderId(db, otherBuilderIds);
    const last = page.at(-1);
    return json({
      friendships: page.map((row) => friendshipFromRow(row, builderId, labelsById, landletsById)),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.friendship_id) : null,
    });
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    // requesterBuilderId always comes from the session now, never the
    // request body — sending a friend request "as" someone else isn't a
    // feature. recipientBuilderId stays client-supplied: it's a reference to
    // who the request targets, not a claim of identity.
    const sessionBuilder = await requireSessionBuilder(request, db);
    const requesterBuilderId = sessionBuilder.builder_id;
    // The existing-pair guard below only blocks a repeat against the *same*
    // recipient — cycling through fresh, previously-unrequested recipients
    // sidesteps it entirely, and each one fires a real notification (see
    // below), so this needs its own throttle (#369).
    await checkRateLimit(db, `friend-request:${requesterBuilderId}`, FRIEND_REQUEST_RATE_LIMIT_MAX);
    const recipientBuilderId = stringValue(input.recipientBuilderId, 'recipientBuilderId');
    if (requesterBuilderId === recipientBuilderId) {
      throw new HttpError('requesterBuilderId and recipientBuilderId must be different builders', 400);
    }
    await assertReferenceExists(db, 'builders', 'builder_id', requesterBuilderId, 'requesterBuilderId');
    await assertReferenceExists(db, 'builders', 'builder_id', recipientBuilderId, 'recipientBuilderId');
    // Folding the duplicate-pair check into the INSERT's own WHERE NOT
    // EXISTS makes the check-and-insert one atomic statement — a separate
    // SELECT-then-INSERT would let two concurrent requests for the same
    // pair (e.g. A and B both sending a request to each other at once)
    // both pass the check before either INSERT commits, same idiom
    // product_reviews/auction_bids already use for this exact race shape.
    const friendshipId = `friendship-${crypto.randomUUID()}`;
    const inserted = await db.prepare(`
      INSERT INTO friendships (friendship_id, requester_builder_id, recipient_builder_id)
      SELECT ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM friendships
        WHERE (requester_builder_id = ? AND recipient_builder_id = ?)
           OR (requester_builder_id = ? AND recipient_builder_id = ?)
      )
    `).bind(
      friendshipId, requesterBuilderId, recipientBuilderId,
      requesterBuilderId, recipientBuilderId, recipientBuilderId, requesterBuilderId,
    ).run();
    if (inserted.meta.changes === 0) {
      throw new HttpError('A friendship or pending request already exists between these builders', 409);
    }
    // Found via backlog audit (#319): a new request/an acceptance had no
    // passive way to reach the other side — they'd have to proactively
    // re-poll GET /api/friendships. Best-effort, same as every other
    // notification in this file (fired after the write it's about, not
    // batched atomically with it).
    await fireNotification(db, recipientBuilderId,
      `${sessionBuilder.label} sent you a friend request.`);
    const row = await db.prepare('SELECT * FROM friendships WHERE friendship_id = ?').bind(friendshipId).first();
    // #2469: a concurrent DELETE (the recipient declining the request we
    // just notified them about, or either side's own self-delete cascade)
    // can remove this row in the await gap since the INSERT -- a genuine
    // 404, same race shape #2334/#2354/#2364/#2391/#2392/#2429/#2430
    // already fixed elsewhere, not an uncaught friendshipFromRow(undefined)
    // crash.
    if (!row) return json({ error: 'Friendship not found' }, 404);
    const labelsById = await labelsByBuilderId(db, [recipientBuilderId]);
    const landletsById = await ownedLandletsByBuilderId(db, [recipientBuilderId]);
    return json({ friendship: friendshipFromRow(row, requesterBuilderId, labelsById, landletsById) }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM friendships WHERE friendship_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Friendship not found' }, 404);
    // Only the recipient can accept a request — the requester accepting
    // their own request would skip the other side's consent entirely.
    const sessionBuilder = await requireSessionBuilder(request, db);
    assertOwner(existing.recipient_builder_id, sessionBuilder.builder_id, 'Only the recipient can accept a friend request');
    await checkRateLimit(db, `friendship-mutate:${sessionBuilder.builder_id}`, FRIENDSHIP_MUTATE_RATE_LIMIT_MAX);
    const input = await readJson(request);
    if (input.status !== 'accepted') throw new HttpError('status must be "accepted"', 400);
    // #353: gated on the row's *current* status (mirroring resolveAuction's
    // `WHERE status = 'active'` and the calendar-trigger's `WHERE
    // triggered_at IS NULL`) so a repeated accept of an already-accepted
    // friendship is a silent no-op instead of re-sending the notification
    // below on every single call — previously this UPDATE matched
    // regardless of the row's status, so the recipient could spam the
    // requester with unlimited duplicate notifications just by re-PATCHing.
    // meta.changes === 0 here is ambiguous on its own (already-accepted, or
    // a concurrent DELETE mid-race) — disambiguated below via the
    // follow-up SELECT instead of trusting this count alone.
    const result = await db.prepare(`UPDATE friendships SET status = 'accepted' WHERE friendship_id = ? AND status = 'pending'`).bind(route[1]).run();
    // Same "no passive way to find out" gap as the new-request notification
    // above (#319), for the requester's side of an acceptance — only fired
    // when this call is the one that actually made the transition.
    if (result.meta.changes === 1) {
      await fireNotification(db, existing.requester_builder_id,
        `${sessionBuilder.label} accepted your friend request.`);
    }
    const updated = await db.prepare('SELECT * FROM friendships WHERE friendship_id = ?').bind(route[1]).first();
    // Not found here means a concurrent DELETE (the requester cancelling,
    // or either side unfriending) landed between the existence check above
    // and the UPDATE — a genuine 404, distinct from the already-accepted
    // no-op case above (where this SELECT still finds the row).
    if (!updated) return json({ error: 'Friendship not found' }, 404);
    const labelsById = await labelsByBuilderId(db, [updated.requester_builder_id]);
    const landletsById = await ownedLandletsByBuilderId(db, [updated.requester_builder_id]);
    return json({ friendship: friendshipFromRow(updated, updated.recipient_builder_id, labelsById, landletsById) });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM friendships WHERE friendship_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Friendship not found' }, 404);
    // Either side of the friendship can end it (or decline/cancel a pending
    // request) — not just the one who happened to send it.
    const sessionBuilder = await requireSessionBuilder(request, db);
    if (sessionBuilder.builder_id !== existing.requester_builder_id
      && sessionBuilder.builder_id !== existing.recipient_builder_id) {
      throw new HttpError('Not your friendship', 403);
    }
    await checkRateLimit(db, `friendship-mutate:${sessionBuilder.builder_id}`, FRIENDSHIP_MUTATE_RATE_LIMIT_MAX);
    // #857: same "no passive way to find out" gap #319 already fixed for
    // request/accept — a decline left the original requester with nothing
    // but re-polling GET /api/friendships to notice the row just vanished.
    // Scoped to an actual decline (still pending, recipient is the one
    // deleting it) — the requester cancelling their own pending request,
    // and unfriending an already-accepted friendship, are deliberately out
    // of scope here. #858: the owner confirmed unfriending an accepted
    // friendship should stay silent (no notification), matching the
    // mainstream silent-unfriend convention, so this isn't a gap to fix.
    const isDecline = existing.status === 'pending' && sessionBuilder.builder_id === existing.recipient_builder_id;
    // #1006: gated on the DELETE's own `WHERE status = 'pending'`, the same
    // shape #353 already established for the sibling PATCH/accept branch —
    // this used to decide whether to notify purely from the pre-fetch
    // `existing.status` above, never re-verified against whether this call
    // actually removed a row. Two concurrent DELETEs on the same pending
    // friendship both read `existing.status === 'pending'` and both fired
    // the notification, even though only one of them could actually delete
    // the row.
    const result = isDecline
      ? await db.prepare(`DELETE FROM friendships WHERE friendship_id = ? AND status = 'pending'`).bind(route[1]).run()
      : await db.prepare('DELETE FROM friendships WHERE friendship_id = ?').bind(route[1]).run();
    if (isDecline && result.meta.changes === 1) {
      await fireNotification(db, existing.requester_builder_id,
        `${sessionBuilder.label} declined your friend request.`);
    } else if (isDecline && result.meta.changes === 0) {
      // #1197: the response below used to be unconditional, so a decline
      // that lost a race to a concurrent PATCH/accept (same recipient, two
      // tabs/devices) reported `deleted: true` even though the row
      // survived, now 'accepted' — this re-fetch disambiguates the same
      // `meta.changes === 0` ambiguity the PATCH/accept branch above
      // already comments on (already-gone vs. still there under a
      // different status), rather than trusting the count alone. A missing
      // row here means some concurrent delete/cancel/unfriend already
      // reached the same end state this call wanted — `deleted: true`
      // below is still accurate for that case, so only a row that's still
      // there (no longer pending) needs its own response.
      const stillThere = await db.prepare('SELECT friendship_id FROM friendships WHERE friendship_id = ?').bind(route[1]).first();
      if (stillThere) {
        throw new HttpError('Friendship was accepted before this decline could take effect', 409);
      }
    }
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
}

// Exported for worker/index.js's own exportSocialSection (handleExportData)
// -- see that function's own call site for why it stays there.
export function friendshipFromRow(row, viewerBuilderId, labelsById, landletsById) {
  const otherBuilderId = row.requester_builder_id === viewerBuilderId
    ? row.recipient_builder_id
    : row.requester_builder_id;
  // Owner (#610): "It's public knowledge who owns a lánd when you're
  // already looking at it. But it seems like a further invasion of
  // privacy to be able to provide a path from a stranger to their lánd.
  // Let's not show the pending friend's lánd location until the friend
  // request is accepted." A landlet's owner is discoverable in-world by
  // walking up to it, but a pending friend request (sent OR received,
  // before either side has actually agreed to connect) shouldn't hand
  // either party a shortcut straight to the other's home before that
  // consent exists.
  const landlet = row.status === 'accepted' ? (landletsById.get(otherBuilderId) ?? null) : null;
  return {
    friendshipId: row.friendship_id,
    requesterBuilderId: row.requester_builder_id,
    recipientBuilderId: row.recipient_builder_id,
    status: row.status,
    createdAt: row.created_at,
    otherBuilderId,
    otherLabel: labelsById.get(otherBuilderId) ?? null,
    direction: row.requester_builder_id === viewerBuilderId ? 'outgoing' : 'incoming',
    otherLandlet: landlet ? { landletId: landlet.landletId, name: landlet.name, center: landlet.center } : null,
  };
}

// #1637 (resolves #1002): direct messages between two id_verified builders
// who are already friends. A real notification fires on every send (same
// shape as the friend-request/accept notifications above), so this needs
// its own rate-limit bucket, same #369/#899 reasoning.
const DIRECT_MESSAGE_SEND_RATE_LIMIT_MAX = 20;
// #2260: mark-read fires no notification and isn't a deliberate, abuse-prone
// action the way a send is -- unlike notification mark-read (#984), which
// only ever fires on a human click (tapping one row, or "Mark all read"),
// this one is auto-fired by the client on every single render of an open DM
// thread (on open, and again after every message sent), so the same
// 20/15min budget sized for click frequency starved under ordinary chat
// activity alone. Sized well above anything that frequency can plausibly
// hit instead of removing the cap outright, since it's still a real,
// uncached D1 write per call.
const DIRECT_MESSAGE_MARK_READ_RATE_LIMIT_MAX = 200;

// DM is gated on a stronger bar than ordinary account verification
// (assertVerified's trust_tier !== 'none', used everywhere else) — #1002's
// own requirement is specifically trust_tier === 'id_verified' for BOTH
// sides, so this is its own assert rather than reusing assertVerified.
function assertIdVerified(user, message) {
  if (user.trust_tier !== 'id_verified') {
    throw new HttpError(message, 403, { idVerificationRequired: true });
  }
}

async function requireIdVerifiedSessionBuilder(request, db) {
  const user = await requireCurrentUser(request, db);
  assertIdVerified(user, 'ID verification is required to use direct messages.');
  return getOrCreateBuilderForUser(db, user);
}

// #1719: same "client mints+persists a key across a retry of what it
// considers the same attempt" pattern as purchaseIdempotencyKey/#473 —
// a dropped response after the message already landed server-side looks,
// client-side, identical to the send never reaching us at all, and
// dmComposeInput's text isn't cleared on error, inviting an innocent
// resubmit of the exact same text. Namespaced with both builder ids so a
// key can never collide across two different senders or threads. A
// missing or malformed key degrades to no idempotency protection for
// this one request, same defense-in-depth reasoning as the purchase path.
function directMessageIdempotencyKey(senderBuilderId, recipientBuilderId, rawKey) {
  if (typeof rawKey !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(rawKey)) return undefined;
  return `message:${senderBuilderId}:${recipientBuilderId}:${rawKey}`;
}

// No existing isFriendsWith-style helper covers a single pair×status
// check — every other friendship need in this file is answered by the
// generic list endpoint. Mirrors the exact unordered-pair shape
// POST /api/friendships' own duplicate-check WHERE NOT EXISTS already uses.
async function assertAcceptedFriendship(db, builderIdA, builderIdB) {
  const row = await db.prepare(`
    SELECT 1 FROM friendships
    WHERE status = 'accepted'
      AND ((requester_builder_id = ? AND recipient_builder_id = ?)
        OR (requester_builder_id = ? AND recipient_builder_id = ?))
  `).bind(builderIdA, builderIdB, builderIdB, builderIdA).first();
  if (!row) {
    throw new HttpError('Direct messages require an existing accepted friendship between these builders', 403);
  }
}

export async function handleDirectMessages(request, db, route, url) {
  // Ahead of the generic list GET below, same "specific path before generic
  // CRUD" ordering GET /api/notifications/unread-count already uses for
  // its own sibling badge-count route.
  if (request.method === 'GET' && route.length === 2 && route[1] === 'unread-count') {
    const sessionBuilder = await requireIdVerifiedSessionBuilder(request, db);
    const count = await db.prepare(`
      SELECT COUNT(*) AS count FROM direct_messages WHERE recipient_builder_id = ? AND read_at IS NULL
    `).bind(sessionBuilder.builder_id).first();
    return json({ count: count.count });
  }

  if (request.method === 'GET' && route.length === 1) {
    const sessionBuilder = await requireIdVerifiedSessionBuilder(request, db);
    const withBuilderId = stringValue(url.searchParams.get('withBuilderId'), 'withBuilderId');
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    // No friendship check on read — once sent, a message stays visible in
    // history the same way email/chat history survives an unfriend; only a
    // NEW send (POST below) is gated on a currently-accepted friendship.
    const conditions = [`
      ((sender_builder_id = ? AND recipient_builder_id = ?)
        OR (sender_builder_id = ? AND recipient_builder_id = ?))
    `];
    const bindings = [sessionBuilder.builder_id, withBuilderId, withBuilderId, sessionBuilder.builder_id];
    if (cursor) {
      conditions.push('(created_at < ? OR (created_at = ? AND message_id < ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const { results } = await db.prepare(`
      SELECT * FROM direct_messages WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, message_id DESC LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      messages: page.map(directMessageFromRow),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.message_id) : null,
    });
  }

  if (request.method === 'POST' && route.length === 1) {
    // Same readJson-then-session-then-rate-limit-then-validate ordering
    // POST /api/friendships uses just above.
    const input = await readJson(request);
    const sessionBuilder = await requireIdVerifiedSessionBuilder(request, db);
    const senderBuilderId = sessionBuilder.builder_id;
    await checkRateLimit(db, `direct-message-send:${senderBuilderId}`, DIRECT_MESSAGE_SEND_RATE_LIMIT_MAX);
    const recipientBuilderId = stringValue(input.recipientBuilderId, 'recipientBuilderId');
    if (senderBuilderId === recipientBuilderId) {
      throw new HttpError('recipientBuilderId must be a different builder', 400);
    }
    const text = stringValue(input.text, 'text');
    if (text.length > 280) throw new HttpError('text must be 280 characters or fewer', 400);
    // assertReferenceExists alone isn't enough here — the recipient's own
    // trust_tier (on `users`, not `builders`) needs checking too, so this
    // is its own query rather than assertReferenceExists + a second lookup.
    const recipient = await db.prepare(`
      SELECT b.builder_id, u.trust_tier FROM builders b
      LEFT JOIN users u ON u.user_id = b.user_id
      WHERE b.builder_id = ?
    `).bind(recipientBuilderId).first();
    if (!recipient) throw new HttpError(`recipientBuilderId "${recipientBuilderId}" does not exist`, 400);
    // #2415: friendship must be checked before the recipient's trust_tier --
    // trust_tier is never exposed through any public lookup (publicBuilderFromRow,
    // #807), but checking it first let any id_verified builder probe an
    // arbitrary stranger's verification status via the two 403s' distinct
    // messages, with no friendship or consent from the target.
    await assertAcceptedFriendship(db, senderBuilderId, recipientBuilderId);
    if (recipient.trust_tier !== 'id_verified') {
      // #2414: no idVerificationRequired flag here -- unlike assertIdVerified's
      // check of the caller's OWN tier above, there's nothing the caller's
      // account can do about someone else's verification (docs/API.md's
      // "Direct messages" section).
      throw new HttpError('The recipient must be ID-verified to receive direct messages', 403);
    }
    // #1719: a retry (network blip after this exact write already landed)
    // finds it here instead of delivering the same text twice — mirrors
    // writePurchaseRow's own idempotency check, keyed off message_id
    // itself the same way.
    const idempotencyKey = directMessageIdempotencyKey(senderBuilderId, recipientBuilderId, input.idempotencyKey);
    let existing = null;
    if (idempotencyKey) {
      existing = await db.prepare('SELECT * FROM direct_messages WHERE message_id = ?').bind(idempotencyKey).first();
      // #1750: the client only clears its cached key on a successful send
      // (src/main.js's compose handler), so a dropped response followed by
      // a genuinely different message to the same recipient within the
      // 5-minute TTL reuses this same key. Returning the stale row here
      // unconditionally would silently swallow that different message —
      // only treat this as the retry it's meant to catch when the text
      // actually matches.
      if (existing && existing.text === text) return json({ message: directMessageFromRow(existing) });
    }
    // A key that collided with someone else's differently-texted row (the
    // mismatch above) must not be reused as this row's own id — it already
    // belongs to that other row. Mint a genuine fresh id instead, same as
    // the "missing/malformed key" fallback below already does.
    const messageId = (idempotencyKey && !existing) ? idempotencyKey : `message-${crypto.randomUUID()}`;
    // #1802: assertAcceptedFriendship above is a point-in-time check — a
    // concurrent unfriend (the recipient's own DELETE /api/friendships/:id)
    // landing between that check and this write would otherwise still let
    // the message through, undermining the one guarantee this gate exists
    // for. Same atomic-fold idiom handleMyAvatar/handleInstances etc. already
    // use for this exact race shape (#801/#929/#1327/#960/#456/#1772/#1773):
    // the eager assert above stays for the common-case clean 403, and this
    // WHERE EXISTS on the INSERT itself is the real race guard.
    const insertResult = await db.prepare(`
      INSERT INTO direct_messages (message_id, sender_builder_id, recipient_builder_id, text)
      SELECT ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM friendships
        WHERE status = 'accepted'
          AND ((requester_builder_id = ? AND recipient_builder_id = ?)
            OR (requester_builder_id = ? AND recipient_builder_id = ?))
      )
    `).bind(
      messageId, senderBuilderId, recipientBuilderId, text,
      senderBuilderId, recipientBuilderId, recipientBuilderId, senderBuilderId,
    ).run();
    if (insertResult.meta.changes === 0) {
      throw new HttpError('Direct messages require an existing accepted friendship between these builders', 403);
    }
    // Same "no passive way to find out" gap #319 already fixed for friend
    // requests — best-effort, after the write it's about, not batched
    // atomically with it.
    await fireNotification(db, recipientBuilderId, `${sessionBuilder.label} sent you a message.`);
    const row = await db.prepare('SELECT * FROM direct_messages WHERE message_id = ?').bind(messageId).first();
    return json({ message: directMessageFromRow(row) }, 201);
  }

  if (request.method === 'POST' && route.length === 2 && route[1] === 'mark-read') {
    // withBuilderId always comes from the request body here (unlike a
    // single-row PATCH by id) since this marks a whole thread's worth of
    // received messages read in one call, mirroring POST
    // /api/notifications/mark-all-read's own bulk shape.
    const sessionBuilder = await requireIdVerifiedSessionBuilder(request, db);
    // #1889: session -> rate limit -> readJson -> validate, matching the
    // dominant order this file's other mutating endpoints use (e.g.
    // friendships' PATCH/DELETE, calendar events, sign posts).
    await checkRateLimit(db, `direct-message-mark-read:${sessionBuilder.builder_id}`, DIRECT_MESSAGE_MARK_READ_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const withBuilderId = stringValue(input.withBuilderId, 'withBuilderId');
    await db.prepare(`
      UPDATE direct_messages SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE recipient_builder_id = ? AND sender_builder_id = ? AND read_at IS NULL
    `).bind(sessionBuilder.builder_id, withBuilderId).run();
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}

// Exported for worker/index.js's own exportSocialSection (handleExportData)
// -- see that function's own call site for why it stays there.
export function directMessageFromRow(row) {
  return {
    messageId: row.message_id,
    senderBuilderId: row.sender_builder_id,
    recipientBuilderId: row.recipient_builder_id,
    text: row.text,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}
