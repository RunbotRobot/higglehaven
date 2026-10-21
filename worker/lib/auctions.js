// #2538 (sub-issue of #2502, itself sub-issue of #2500's worker/index.js
// module split): bundle (docs/API.md's "Bundles") and land-acquisition-
// auction (docs/SPEC.md §5, migrations/0045_auctions.sql, docs/API.md's
// "Land acquisition auctions") route handlers. Extracted verbatim, zero
// behavior change.
//
// Deliberately NOT included here: requireSessionBuilder/assertOwner
// (shared across dozens of other handlers), requireLandlet (shared by
// every landlet-touching handler), recomputeLandCap/LANDLET_RELEASED_VIA_
// AUCTION_SQL/LAND_CAP_DISPLAY_ROUNDING_BUFFER_M2 (the land-cap domain —
// shared by handleLandletLevels too, not auction-specific), formatCents/
// nonnegativeInteger/positiveInteger/validateCropShape/validateScale
// (generic utilities used across the whole file), and resolveAuctionIfDue/
// resolveDueAuctions (the auction-*resolution* subsystem, which stays with
// resolveAuction/the scheduled() cron handler that also calls it directly)
// -- each of these stays in worker/index.js and is imported back below,
// the same one-directional-except-for-genuinely-shared-state shape
// worker/lib/reputation.js's own comment documents for requireSessionSeller
// (#2532).
import { json, HttpError, clientIp } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import {
  readJson, stringValue, labelValue, decodeCursor, encodeCursor, queryLimit, assertReferencesExist, finiteNumber,
} from './validation.js';
import { fireNotifications } from './notifications.js';
import { requireSessionBuilder, assertOwner } from './auth.js';
import {
  requireLandlet, recomputeLandCap, resolveAuctionIfDue, resolveDueAuctions,
  nonnegativeInteger, positiveInteger, validateCropShape, validateScale, formatCents,
  LANDLET_RELEASED_VIA_AUCTION_SQL, LAND_CAP_DISPLAY_ROUNDING_BUFFER_M2,
} from '../index.js';

// Saved groups a builder can stamp down together in one tap (see
// docs/API.md's "Bundles") — a named, persisted version of the same
// relative-offset shape the frontend's own Copy/Paste already builds in
// memory (copySelection/placeClipboardItems in src/main.js). No rename of
// a bundle's *contents* here — only its name/shared flag — since there's no
// frontend flow for editing a saved bundle's items; delete and re-save
// covers that.
//
// `shared` (see migrations/0040_bundle_sharing.sql) only controls
// visibility — a shared bundle is still owned by whoever created it, and
// stays editable/deletable only by its own builder (session-checked below)
// even once shared; sharing never transfers ownership.
//
// #791: unlike every other repeatable write in this file — sign posts
// (SIGN_POST_RATE_LIMIT_MAX, #337), calendar events
// (CALENDAR_EVENT_RATE_LIMIT_MAX), friend requests
// (FRIEND_REQUEST_RATE_LIMIT_MAX) — creating a bundle had no
// checkRateLimit call at all, letting an authenticated builder insert
// unlimited bundles rows in a tight loop, each immediately visible,
// unauthenticated, on the public Community tab once `shared: true`.
// Bucketed by builder id, not IP, same reasoning as those other
// authenticated-action limits.
const BUNDLE_CREATE_RATE_LIMIT_MAX = 20;

// #892: #791 above only rate-limited creating a bundle — renaming/toggling
// `shared` (PATCH/PUT) and deleting one never got the same treatment, so a
// single already-created bundle could be mutated or deleted an unbounded
// number of times per second by its own owner's session. Same shape as
// #520/#564/#804's own PATCH-vs-DELETE-sibling gaps elsewhere in this file.
// Bucketed by builder id, same reasoning as BUNDLE_CREATE_RATE_LIMIT_MAX;
// PATCH and DELETE share one bucket since both are "mutate an existing
// bundle" actions, not two independently-abusable surfaces.
const BUNDLE_MUTATE_RATE_LIMIT_MAX = 20;

// #1720: same shape as purchaseIdempotencyKey (#473/#974) — the client
// mints+persists a key across a retry of what it considers the same save
// attempt (most commonly a dropped response after the INSERT already
// landed), and the server dedupes on it before inserting, reusing the key
// as the row's own primary key the same way writePurchaseRow does. Folded
// into builderId so one builder's own stale/retried key can never collide
// with an unrelated builder's bundle, the same cross-account guard #974
// added for purchases. A missing or malformed key just degrades to no
// idempotency protection for that one request, same as purchases.
function bundleIdempotencyKey(builderId, rawKey) {
  if (typeof rawKey !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(rawKey)) return undefined;
  return `bundle:${builderId}:${rawKey}`;
}

export async function handleBundles(request, db, route, url) {
  if (request.method === 'GET' && route.length === 1) {
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    // Two independent listings, not one filtered by both: `shared=true` is
    // the community tab (every builder's shared bundles, not just one
    // builder's), while `builderId` alone is "my bundles" (everything this
    // builder owns, shared or not) — a builder's own shared bundles should
    // keep showing in their own private list too, not move out of it.
    if (url.searchParams.get('shared') === 'true') {
      const conditions = ['shared = 1'];
      const bindings = [];
      // Newest-first, same tiebreak-on-id shape GET /api/notifications
      // already uses for its own DESC cursor pagination.
      if (cursor) {
        conditions.push('(created_at < ? OR (created_at = ? AND bundle_id < ?))');
        bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
      const { results } = await db.prepare(`
        SELECT * FROM bundles WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC, bundle_id DESC LIMIT ?
      `).bind(...bindings, limit + 1).all();
      const hasMore = results.length > limit;
      const page = results.slice(0, limit);
      const last = page.at(-1);
      return json({
        bundles: page.map(bundleFromRow),
        nextCursor: hasMore ? encodeCursor(last.created_at, last.bundle_id) : null,
      });
    }
    const sessionBuilder = await requireSessionBuilder(request, db);
    const builderIdParam = url.searchParams.get('builderId');
    const builderId = builderIdParam === null ? sessionBuilder.builder_id : stringValue(builderIdParam, 'builderId');
    assertOwner(builderId, sessionBuilder.builder_id, 'Not your bundles');
    const conditions = ['builder_id = ?'];
    const bindings = [builderId];
    if (cursor) {
      conditions.push('(created_at < ? OR (created_at = ? AND bundle_id < ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const { results } = await db.prepare(`
      SELECT * FROM bundles WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, bundle_id DESC LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      bundles: page.map(bundleFromRow),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.bundle_id) : null,
    });
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    // builderId always comes from the session now, never the request body —
    // saving a bundle "as" someone else isn't a feature.
    const sessionBuilder = await requireSessionBuilder(request, db);
    await checkRateLimit(db, `bundle-create:${sessionBuilder.builder_id}`, BUNDLE_CREATE_RATE_LIMIT_MAX);
    const builderId = sessionBuilder.builder_id;
    const name = labelValue(input.name, 'name');
    const items = validateBundleItems(input.items);
    const shared = input.shared === true;
    await assertReferencesExist(db, 'catalog_templates', 'template_id', items.map((item) => item.templateId), 'items[].templateId');
    const idempotencyKey = bundleIdempotencyKey(builderId, input.idempotencyKey);
    let bundleId = idempotencyKey || `bundle-${crypto.randomUUID()}`;
    // #1873: unlike a purchase (pinned to a fixed instance), the Save
    // Bundle handler's own prompt()/confirm() pair can legitimately
    // produce a different `shared` answer on a same-key resubmit after a
    // lost response -- the client's own key is deliberately not
    // namespaced by `shared` (see bundleIdempotencyKey's callers). Only
    // honor the dedup hit when the content actually matches; on a
    // mismatch this is a genuinely new attempt, so mint a fresh id
    // rather than reusing the idempotency-derived one, which the stale
    // row already occupies.
    if (idempotencyKey) {
      const existing = await db.prepare('SELECT * FROM bundles WHERE bundle_id = ?').bind(idempotencyKey).first();
      if (existing) {
        if (bundleContentMatches(existing, name, items, shared)) return json({ bundle: bundleFromRow(existing) });
        bundleId = `bundle-${crypto.randomUUID()}`;
      }
    }
    await db.prepare(`
      INSERT INTO bundles (bundle_id, builder_id, name, items_json, shared) VALUES (?, ?, ?, ?, ?)
    `).bind(bundleId, builderId, name, JSON.stringify(items), shared ? 1 : 0).run();
    const row = await db.prepare('SELECT * FROM bundles WHERE bundle_id = ?').bind(bundleId).first();
    // #2469: a concurrent DELETE of this same bundle (the id is
    // predictable from the idempotency key, so a same-owner retry/second
    // tab can target it) or a self-delete cascade can remove this row in
    // the await gap since the INSERT -- same race shape #2426 already
    // fixed for this resource's own PATCH, not an uncaught
    // bundleFromRow(undefined) crash.
    if (!row) return json({ error: 'Bundle not found' }, 404);
    return json({ bundle: bundleFromRow(row) }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM bundles WHERE bundle_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Bundle not found' }, 404);
    const sessionBuilder = await requireSessionBuilder(request, db);
    assertOwner(existing.builder_id, sessionBuilder.builder_id, 'Not your bundle');
    await checkRateLimit(db, `bundle-mutate:${sessionBuilder.builder_id}`, BUNDLE_MUTATE_RATE_LIMIT_MAX);
    const input = await readJson(request);
    // Both fields optional and independent — a rename shouldn't have to
    // also resend the current shared flag, and vice versa. #468: this used
    // to fill in whichever field the caller omitted from `existing` (read
    // once at the top of this handler) and write BOTH fields back
    // unconditionally — so two concurrent partial updates (a rename and a
    // share-toggle landing close together) each recomputed the OTHER
    // field from the same pre-race snapshot, and whichever UPDATE landed
    // second silently clobbered the first with that stale value. Binding
    // `null` for an omitted field and resolving it via COALESCE at the SQL
    // level instead makes the merge atomic against whatever the row
    // actually holds at UPDATE time, not a value read before this
    // request's own await gap.
    const name = input.name === undefined ? null : labelValue(input.name, 'name');
    const shared = input.shared === undefined ? null : (input.shared === true ? 1 : 0);
    // Found via backlog audit: without checking this UPDATE's own
    // meta.changes, a concurrent DELETE of this bundle landing between the
    // existence check above and this UPDATE would silently affect 0 rows —
    // the follow-up SELECT below then returns undefined, and
    // bundleFromRow(undefined) throws an uncaught TypeError (a 500) instead
    // of the clean 404 this should be. Same shape as #288's friendship fix.
    const result = await db.prepare(`
      UPDATE bundles SET name = COALESCE(?, name), shared = COALESCE(?, shared), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bundle_id = ?
    `).bind(name, shared, route[1]).run();
    if (result.meta.changes === 0) return json({ error: 'Bundle not found' }, 404);
    // #2426: result.meta.changes === 0 only proves the UPDATE matched a row
    // at the moment it ran -- a concurrent DELETE landing in the single
    // await gap between that UPDATE committing and this re-SELECT removes
    // the row anyway, so bundleFromRow(undefined) would otherwise throw a
    // raw 500 instead of a clean 404. Same idiom as #2334/#2354/#2364.
    const updated = await db.prepare('SELECT * FROM bundles WHERE bundle_id = ?').bind(route[1]).first();
    if (!updated) return json({ error: 'Bundle not found' }, 404);
    return json({ bundle: bundleFromRow(updated) });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM bundles WHERE bundle_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Bundle not found' }, 404);
    const sessionBuilder = await requireSessionBuilder(request, db);
    assertOwner(existing.builder_id, sessionBuilder.builder_id, 'Not your bundle');
    await checkRateLimit(db, `bundle-mutate:${sessionBuilder.builder_id}`, BUNDLE_MUTATE_RATE_LIMIT_MAX);
    await db.prepare('DELETE FROM bundles WHERE bundle_id = ?').bind(route[1]).run();
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
}

// Each item is { templateId, dx, dy, dz, rotationX, rotationY, rotationZ,
// crop, scale } — dx/dy/dz and the rotations are offsets/orientations, not
// positions, so (unlike most other dimension-shaped fields in this file)
// they're allowed to be negative or zero. Reuses validateCropShape and
// validateScale directly since this is exactly the shape those already
// validate for a placed instance.
function validateBundleItems(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError('items must be a non-empty array', 400);
  }
  // #1974 (owner report): 250 was blocking legitimate large builds (a
  // 32-foot brick wall with a door, saved as one bundle) -- there's no
  // per-item batch insert here to worry about (the whole thing is stored
  // as one items_json blob below, a single row write), so the real ceiling
  // is D1's own documented max string/BLOB/row size (2,000,000 bytes).
  // Each item's JSON is on the order of a couple hundred bytes, so 2000
  // items lands around half a megabyte -- comfortably inside that limit
  // with room to spare, while still being a real sanity bound against a
  // genuinely pathological payload.
  if (input.length > 2000) {
    throw new HttpError('items cannot exceed 2000 entries', 400);
  }
  return input.map((item, index) => ({
    templateId: stringValue(item.templateId, `items[${index}].templateId`),
    dx: finiteNumber(item.dx, `items[${index}].dx`),
    dy: finiteNumber(item.dy, `items[${index}].dy`),
    dz: finiteNumber(item.dz, `items[${index}].dz`),
    rotationX: finiteNumber(item.rotationX ?? 0, `items[${index}].rotationX`),
    rotationY: finiteNumber(item.rotationY ?? 0, `items[${index}].rotationY`),
    rotationZ: finiteNumber(item.rotationZ ?? 0, `items[${index}].rotationZ`),
    crop: validateCropShape(item.crop),
    scale: validateScale(item.scale),
  }));
}

// #1873: compares an existing row (raw DB shape) against this request's
// own name/items/shared, mirroring #1758's templateContentMatches.
function bundleContentMatches(existingRow, name, items, shared) {
  return existingRow.name === name
    && existingRow.items_json === JSON.stringify(items)
    && Boolean(existingRow.shared) === shared;
}

export function bundleFromRow(row) {
  return {
    bundleId: row.bundle_id,
    builderId: row.builder_id,
    name: row.name,
    items: JSON.parse(row.items_json),
    shared: Boolean(row.shared),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Land acquisition auctions (docs/SPEC.md §5, migrations/0045_auctions.sql,
// docs/API.md's "Land acquisition auctions"). Two entry points into this
// module: handleStartAuction is reached via POST /api/landlets/:id/auction
// (a landlet-scoped nested route, called from handleLandlets — the same
// pattern /versions and /draft already use), and handleAuctions handles
// everything under the top-level /api/auctions collection itself.
// #886: approved as a safety net against a compromised session or a runaway
// script, not to restrict deliberate admin/owner action — same reasoning
// and limit as this file's other per-builder mutation rate limits (e.g.
// FRIENDSHIP_MUTATE_RATE_LIMIT_MAX) rather than a stricter bound, since the
// endpoint's own natural throttles (one active auction per landlet, a
// 1-hour-minimum duration) already made outright spam impractical.
const AUCTION_START_RATE_LIMIT_MAX = 20;
// #1290: handleAuctionBids' POST branch fires notifyOfNewBid on every
// successful bid (the seller, plus the previous high bidder on an outbid) —
// the same "notification fan-out on an unthrottled write" shape
// FRIENDSHIP_MUTATE_RATE_LIMIT_MAX/BUNDLE_MUTATE_RATE_LIMIT_MAX/
// CATALOG_PATCH_RATE_LIMIT_MAX were each already added to guard against.
const AUCTION_BID_RATE_LIMIT_MAX = 20;
// #1741: resolveAuctionIfDue's underlying resolveAuction can credit a real
// higgles balance, transfer land ownership, and fire notifications to both
// parties the first time an ended auction is observed — reachable
// unauthenticated via both the single-item GET below and POST .../resolve.
// Repeated hits after the first are harmless no-ops (resolveAuction's own
// `WHERE status = 'active'` guard), but this was still the one endpoint in
// this resolve/trigger shape without the IP-keyed rate limit its own sibling
// (EVENT_TRIGGER_RATE_LIMIT_MAX, which explicitly calls out this endpoint by
// name in its own comment) already has.
const AUCTION_RESOLVE_RATE_LIMIT_MAX = 20;

// #1790: the list branch below triggers the same resolveDueAuctions sweep,
// but — unlike the single-item GET/POST .../resolve above, each a rare,
// deliberate action — it's hit on every full Settings redraw while the
// Build tab's auction section is showing (renderAuctionSection in
// src/main.js), the same "full renderSettingsSection() redraw after each
// mutation" idiom this file's own comments describe elsewhere. A single
// ordinary e2e session exercising one auction's bidding/bid-history UI
// already issues ~20 of these GETs, so sharing AUCTION_RESOLVE_RATE_LIMIT_MAX's
// tight budget (sized for a rare single-auction trigger) starved real
// interactive use — confirmed by a 429 on exactly this GET during CI.
// Its own separate, more generous bucket keeps the original unauthenticated-
// sweep protection without that false positive.
const AUCTION_LIST_RATE_LIMIT_MAX = 200;

export async function handleStartAuction(request, db, landletId) {
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
  const landlet = await requireLandlet(db, landletId);
  const input = await readJson(request);
  // builderId always comes from the session now, never the request body —
  // starting an auction "as" someone else isn't a feature.
  const sessionBuilder = await requireSessionBuilder(request, db);
  const builderId = sessionBuilder.builder_id;
  await checkRateLimit(db, `auction-start:${builderId}`, AUCTION_START_RATE_LIMIT_MAX);
  if (landlet.status !== 'claimed' || landlet.owner_builder_id !== builderId) {
    throw new HttpError('Only the current owner of a claimed landlet can start an auction on it', 400);
  }
  const startingBidCents = input.startingBidCents === undefined ? 0 : nonnegativeInteger(input.startingBidCents, 'startingBidCents');
  // "Default 24-hour duration for inactivity-triggered listings; builder-
  // initiated voluntary auctions may set custom duration" — every auction
  // reachable through this endpoint is still builder-initiated. #325's
  // autoAuctionInactiveLandlets (the inactivity-detection job this comment
  // used to say didn't exist) never calls handleStartAuction at all — it
  // INSERTs its own auction row directly and duplicates this same
  // 24-hour default independently (see its own comment). Capped at a year
  // as a sanity bound against a malformed request producing an absurd
  // ends_at — not itself a spec requirement.
  const durationHours = input.durationHours === undefined ? 24 : positiveInteger(input.durationHours, 'durationHours');
  if (durationHours > 8760) throw new HttpError('durationHours must be 8760 (one year) or fewer', 400);

  const auctionId = `auction-${crypto.randomUUID()}`;
  const endsAt = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();
  // Folding the "no active auction yet" check into the INSERT's own WHERE
  // NOT EXISTS makes the check-and-insert one atomic statement — a
  // separate SELECT-then-INSERT would let two concurrent starts for the
  // same landlet both pass the check before either INSERT commits,
  // leaving two simultaneously-active auctions that would later both
  // independently resolve and double-transfer the same land (#265). Same
  // idiom already used for product_reviews/auction_bids/friendships.
  //
  // #809: this used to only re-check "no active auction" — the same #415
  // hazard every other landlet-mutating endpoint in this file (version
  // create/activate, instance batch write) is already hardened against
  // was missed here. resolveAuction flips an auction's own status to
  // 'ended' as its own standalone write, well before the landlet's
  // owner_builder_id actually transfers a few statements later — a
  // second POST landing in that gap saw a stale owner_builder_id match
  // and an auction already 'ended' (so NOT EXISTS(active) passed too),
  // letting the just-outbid former owner open a *second* active auction
  // on land they no longer owned. Re-pinning status='claimed' AND
  // owner_builder_id into this same atomic WHERE closes it exactly like
  // #415's other fixes do.
  const inserted = await db.prepare(`
    INSERT INTO auctions (auction_id, landlet_id, seller_builder_id, starting_bid_cents, ends_at)
    SELECT ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM auctions WHERE landlet_id = ? AND status = 'active'
    )
    AND EXISTS (
      SELECT 1 FROM landlets WHERE landlet_id = ? AND status = 'claimed' AND owner_builder_id IS ?
    )
  `).bind(auctionId, landletId, builderId, startingBidCents, endsAt, landletId, landletId, builderId).run();
  if (inserted.meta.changes === 0) {
    const current = await db.prepare('SELECT status, owner_builder_id FROM landlets WHERE landlet_id = ?').bind(landletId).first();
    if (!current || current.status !== 'claimed' || current.owner_builder_id !== builderId) {
      throw new HttpError('You no longer own this landlet — refetch and retry', 409);
    }
    throw new HttpError('This landlet already has an active auction', 409);
  }
  const row = await db.prepare('SELECT * FROM auctions WHERE auction_id = ?').bind(auctionId).first();
  // #2427: a concurrent self-delete can remove this just-created, still-
  // zero-bid auction (builderDeletionStatements) between the INSERT above
  // and this re-SELECT, same idiom as #2334/#2354/#2364/#2391/#2392.
  if (!row) throw new HttpError('This landlet no longer has an active auction — it may have been removed concurrently', 409);
  return json({ auction: await auctionFromRow(db, row) }, 201);
}
export async function handleAuctions(request, db, route, url) {
  if (request.method === 'GET' && route.length === 1) {
    // #1790: resolveDueAuctions below does the same resolve-sweep as the
    // two rate-limited branches further down (#1741), just batched over up
    // to AUCTION_SWEEP_LIMIT auctions instead of one — same guard needed,
    // but its own separate, more generous bucket (see AUCTION_LIST_RATE_LIMIT_MAX's
    // own comment for why it can't share auction-resolve's tight budget).
    await checkRateLimit(db, `auction-list:${clientIp(request)}`, AUCTION_LIST_RATE_LIMIT_MAX);
    await resolveDueAuctions(db);
    const status = url.searchParams.get('status');
    if (status !== null && !['active', 'ended'].includes(status)) {
      throw new HttpError('status must be active or ended', 400);
    }
    const landletIdParam = url.searchParams.get('landletId');
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const conditions = [];
    const bindings = [];
    if (status) {
      conditions.push('status = ?');
      bindings.push(status);
    }
    if (landletIdParam !== null) {
      conditions.push('landlet_id = ?');
      bindings.push(stringValue(landletIdParam, 'landletId'));
    }
    if (cursor) {
      conditions.push('(created_at > ? OR (created_at = ? AND auction_id > ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { results } = await db.prepare(`
      SELECT * FROM auctions ${where}
      ORDER BY created_at, auction_id LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      auctions: await auctionsFromRowsBatch(db, page),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.auction_id) : null,
    });
  }

  if (request.method === 'GET' && route.length === 2) {
    await checkRateLimit(db, `auction-resolve:${clientIp(request)}`, AUCTION_RESOLVE_RATE_LIMIT_MAX);
    const auction = await requireAuction(db, route[1]);
    const resolved = await resolveAuctionIfDue(db, auction);
    return json({ auction: await auctionFromRow(db, resolved) });
  }

  if (route.length === 3 && route[2] === 'bids') {
    return handleAuctionBids(request, db, route);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'resolve') {
    await checkRateLimit(db, `auction-resolve:${clientIp(request)}`, AUCTION_RESOLVE_RATE_LIMIT_MAX);
    const auction = await requireAuction(db, route[1]);
    const resolved = await resolveAuctionIfDue(db, auction);
    if (resolved.status === 'active') {
      throw new HttpError('This auction has not ended yet', 409);
    }
    return json({ auction: await auctionFromRow(db, resolved) });
  }

  return json({ error: 'Not found' }, 404);
}

export async function handleAuctionBids(request, db, route) {
  const auctionId = route[1];

  if (request.method === 'GET') {
    await requireAuction(db, auctionId);
    const { results } = await db.prepare(`
      SELECT * FROM auction_bids WHERE auction_id = ? ORDER BY amount_cents DESC, created_at LIMIT 200
    `).bind(auctionId).all();
    // Same totalCount-alongside-the-cap pattern as handleSignPosts/
    // handleCalendarEvents (#356) — lets a caller tell the 200-row cap
    // ever actually truncates something.
    const total = await db.prepare('SELECT COUNT(*) AS count FROM auction_bids WHERE auction_id = ?').bind(auctionId).first();
    return json({ bids: results.map(auctionBidFromRow), totalCount: total.count });
  }

  if (request.method === 'POST') {
    const auction = await requireAuction(db, auctionId);
    const resolved = await resolveAuctionIfDue(db, auction);
    if (resolved.status !== 'active') {
      throw new HttpError('This auction has already ended', 409);
    }
    const input = await readJson(request);
    // builderId always comes from the session now, never the request body —
    // bidding "as" someone else isn't a feature.
    const sessionBuilder = await requireSessionBuilder(request, db);
    const builderId = sessionBuilder.builder_id;
    await checkRateLimit(db, `auction-bid:${builderId}`, AUCTION_BID_RATE_LIMIT_MAX);
    if (builderId === resolved.seller_builder_id) {
      throw new HttpError('The seller cannot bid on their own auction', 400);
    }
    const amountCents = nonnegativeInteger(input.amountCents, 'amountCents');
    // starting_bid_cents is immutable once the auction is created, so this
    // floor is safe to check against the value already read above — no
    // race window here. The "must exceed the current highest bid" floor
    // below is the one that actually moves under concurrent bids, so that
    // one is enforced atomically instead.
    if (amountCents < resolved.starting_bid_cents) {
      throw new HttpError(`amountCents must be at least ${resolved.starting_bid_cents}`, 400);
    }
    // #489 (owner-confirmed): land cap now gates bidding, not just
    // vertical construction — a bid is only ever a *ground* landlet
    // changing hands (resolveAuction deletes the sold landlet's levels
    // before transferring it, so its levels' cap_consumed_m2 never
    // transfers), so the only area that matters here is the auctioned
    // landlet's own area_m2. Checked against what winning would add to
    // the bidder's own current owned area, same ratchet-then-check
    // pattern as the level-add gate above.
    const auctionedLandlet = await db.prepare('SELECT area_m2 FROM landlets WHERE landlet_id = ?').bind(resolved.landlet_id).first();
    const bidderCap = await recomputeLandCap(db, builderId);
    // #629 (owner-confirmed, 2026-09-10): a bid now needs to actually be
    // affordable, holding both higgles and land cap until the bidder is
    // outbid or the auction closes — otherwise a builder could bid on more
    // auctions than their balance/cap could ever cover if more than one
    // resolved in their favor. "Held" is computed live off the bidder's own
    // currently-highest bid on each of their OTHER active auctions (never
    // stored separately) — the moment a higher bid supersedes one, it drops
    // out of this sum on its own, which is the "released on outbid" half;
    // resolveAuction's own atomic per-auction debit is what actually
    // enforces this at settlement time (this check is the up-front,
    // best-effort half — see that function's own comment on why a narrow
    // race here is acceptable).
    const heldElsewhere = await db.prepare(`
      SELECT COALESCE(SUM(ab.amount_cents), 0) AS higglesCents, COALESCE(SUM(l.area_m2), 0) AS areaM2
      FROM auction_bids ab
      JOIN auctions a ON a.auction_id = ab.auction_id
      JOIN landlets l ON l.landlet_id = a.landlet_id
      WHERE ab.bidder_builder_id = ? AND a.status = 'active' AND a.auction_id != ?
        AND ab.amount_cents = (SELECT MAX(amount_cents) FROM auction_bids WHERE auction_id = ab.auction_id)
    `).bind(builderId, auctionId).first();
    if (heldElsewhere.higglesCents + amountCents > sessionBuilder.higgles_balance_cents) {
      throw new HttpError(
        `This bid needs ${formatCents(amountCents)}, but only `
        + `${formatCents(Math.max(sessionBuilder.higgles_balance_cents - heldElsewhere.higglesCents, 0))} `
        + `is available after what your other active bids are already holding`,
        400,
      );
    }
    const committedAreaM2 = bidderCap.ownedAreaM2 + heldElsewhere.areaM2 + auctionedLandlet.area_m2;
    if (committedAreaM2 > bidderCap.nextCap + LAND_CAP_DISPLAY_ROUNDING_BUFFER_M2) {
      throw new HttpError(
        `Winning this auction would take you to ${committedAreaM2.toFixed(2)}m² `
        + `(including what your other active bids are already holding), over your ${bidderCap.nextCap}m² land cap`,
        409,
      );
    }
    const bidId = `bid-${crypto.randomUUID()}`;
    // A read-then-insert here (read the highest bid, validate against it,
    // insert) would be the same TOCTOU shape this codebase deliberately
    // avoids elsewhere (landlet claim's atomic UPDATE ... WHERE, the
    // calendar-event trigger's UPDATE ... WHERE triggered_at IS NULL):
    // two concurrent bids could both read the same stale highest, both
    // pass validation, and both land even though each bid must strictly
    // exceed whatever the highest actually is by the time it's inserted.
    // This conditional insert makes "no existing bid already meets or
    // beats this amount" part of the write itself.
    // #489: the eager land-cap check above reads a snapshot of the
    // bidder's owned area, so two concurrent bids from the same builder
    // on two *different* auctions could each individually pass it and
    // jointly land them over cap if both won. Re-derives owned area live
    // at INSERT time and folds it into the same atomic statement as the
    // existing highest-bid guard, so this bid only actually lands if the
    // builder is still under cap the instant it's written.
    // #2412: the two guards below (highest-bid, land-cap) were the only
    // ones folded into this atomic write -- nothing re-checked that the
    // auction itself was still active at INSERT time, so a concurrent
    // resolution (resolveDueAuctions' sweep, another caller's /resolve,
    // or just another GET triggering resolveAuctionIfDue) landing in the
    // gap between the up-front check above and this INSERT could let a
    // bid attach to an auction that has already ended. Folding the same
    // live EXISTS check resolveAuction's own atomic status-flip guard
    // uses closes that window the same way every other auction-racing
    // write in this file already does.
    const inserted = await db.prepare(`
      INSERT INTO auction_bids (bid_id, auction_id, bidder_builder_id, amount_cents)
      SELECT ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM auctions WHERE auction_id = ? AND status = 'active'
      )
        AND NOT EXISTS (
          SELECT 1 FROM auction_bids WHERE auction_id = ? AND amount_cents >= ?
        )
        AND (
          SELECT b.land_cap_m2 FROM builders b WHERE b.builder_id = ?
        ) + ? >= (
          ?
          + COALESCE((
              SELECT SUM(area_m2) FROM landlets AS owned
              WHERE owned.owner_builder_id = ? AND owned.status = 'claimed'
                AND NOT ${LANDLET_RELEASED_VIA_AUCTION_SQL}
            ), 0)
          + COALESCE((
              SELECT SUM(ll.cap_consumed_m2) FROM landlet_levels ll
              JOIN landlets AS owned ON owned.landlet_id = ll.landlet_id
              WHERE owned.owner_builder_id = ? AND owned.status = 'claimed'
                AND NOT ${LANDLET_RELEASED_VIA_AUCTION_SQL}
            ), 0)
        )
    `).bind(
      bidId, auctionId, builderId, amountCents, auctionId, auctionId, amountCents,
      builderId, LAND_CAP_DISPLAY_ROUNDING_BUFFER_M2, auctionedLandlet.area_m2, builderId, builderId,
    ).run();
    if (inserted.meta.changes === 0) {
      const currentAuction = await db.prepare('SELECT status FROM auctions WHERE auction_id = ?').bind(auctionId).first();
      if (currentAuction.status !== 'active') {
        throw new HttpError('This auction has already ended', 409);
      }
      const currentHighest = await db.prepare(`
        SELECT amount_cents FROM auction_bids WHERE auction_id = ? ORDER BY amount_cents DESC, created_at LIMIT 1
      `).bind(auctionId).first();
      if (currentHighest && currentHighest.amount_cents >= amountCents) {
        throw new HttpError(`amountCents must be at least ${currentHighest.amount_cents + 1}`, 400);
      }
      throw new HttpError('This would put you over your land cap — please retry', 409);
    }
    await db.prepare(`UPDATE auctions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE auction_id = ?`).bind(auctionId).run();
    // Re-derived after the insert (excluding the bid just inserted) rather
    // than reusing a pre-insert read, which could be stale by the time this
    // bid actually landed.
    const previousHighest = await db.prepare(`
      SELECT * FROM auction_bids WHERE auction_id = ? AND bid_id != ? ORDER BY amount_cents DESC, created_at LIMIT 1
    `).bind(auctionId, bidId).first();
    await notifyOfNewBid(db, resolved, amountCents, builderId, previousHighest);
    const bidRow = await db.prepare('SELECT * FROM auction_bids WHERE bid_id = ?').bind(bidId).first();
    return json({ bid: auctionBidFromRow(bidRow) }, 201);
  }

  return json({ error: 'Not found' }, 404);
}

async function requireAuction(db, auctionId) {
  const row = await db.prepare('SELECT * FROM auctions WHERE auction_id = ?').bind(auctionId).first();
  if (!row) throw new HttpError('Auction not found', 404);
  return row;
}
// Bid-notification counterpart to resolveAuction's own — fired right
// after a bid is successfully recorded, not batched atomically with it
// (best-effort, same convention notifyBuildersOfDimensionChange already
// follows: notifications are informational, never worth failing the
// actual write over).
async function notifyOfNewBid(db, auction, amountCents, bidderBuilderId, previousHighest) {
  const notifications = [
    { builderId: auction.seller_builder_id,
      message: `New bid of ${formatCents(amountCents)} on your auction for ${auction.landlet_id}.` },
  ];
  if (previousHighest && previousHighest.bidder_builder_id !== bidderBuilderId) {
    notifications.push({ builderId: previousHighest.bidder_builder_id,
      message: `You've been outbid on ${auction.landlet_id} — new high bid ${formatCents(amountCents)}.` });
  }
  await fireNotifications(db, notifications);
}
// Pure formula shared by the single-auction and batched shaping paths
// below — the auction row plus its highest bid/bid count in, the JSON
// shape out.
function auctionShape(row, highestBidCents, bidCount) {
  return {
    auctionId: row.auction_id,
    landletId: row.landlet_id,
    sellerBuilderId: row.seller_builder_id,
    startingBidCents: row.starting_bid_cents,
    status: row.status,
    endsAt: row.ends_at,
    winningBidId: row.winning_bid_id,
    highestBidCents,
    bidCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function auctionFromRow(db, row) {
  const highest = await db.prepare(`
    SELECT amount_cents FROM auction_bids WHERE auction_id = ? ORDER BY amount_cents DESC, created_at LIMIT 1
  `).bind(row.auction_id).first();
  const bidCount = await db.prepare('SELECT COUNT(*) AS n FROM auction_bids WHERE auction_id = ?').bind(row.auction_id).first();
  return auctionShape(row, highest ? highest.amount_cents : null, bidCount.n);
}

// List-endpoint version of the above: instead of the same 2 queries
// repeated once per auction (an N+1 round-trip pattern — up to `limit`
// auctions per page, each awaiting 2 sequential D1 queries), pulls the
// highest bid and bid count for every auction on the page in exactly one
// grouped query, then shapes each row in memory. Auctions with no bids at
// all simply have no row in the grouped results, matching auctionFromRow's
// `null`/`0` fallback.
async function auctionsFromRowsBatch(db, rows) {
  if (rows.length === 0) return [];
  const placeholders = rows.map(() => '?').join(', ');
  const { results } = await db.prepare(`
    SELECT auction_id, MAX(amount_cents) AS highest, COUNT(*) AS n
    FROM auction_bids WHERE auction_id IN (${placeholders}) GROUP BY auction_id
  `).bind(...rows.map((row) => row.auction_id)).all();
  const byAuction = new Map(results.map((row) => [row.auction_id, row]));
  return rows.map((row) => {
    const bids = byAuction.get(row.auction_id);
    return auctionShape(row, bids ? bids.highest : null, bids ? bids.n : 0);
  });
}

function auctionBidFromRow(row) {
  return {
    bidId: row.bid_id,
    auctionId: row.auction_id,
    bidderBuilderId: row.bidder_builder_id,
    amountCents: row.amount_cents,
    createdAt: row.created_at,
  };
}
