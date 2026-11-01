// #2532 (sub-issue of #2502, itself sub-issue of #2500's worker/index.js
// module split): product & seller reputation route handlers -- catalog
// template reviews (docs/SPEC.md §5's "Review incentives," docs/API.md's
// "Product reviews"), the counterfeit/policy-violation flag queue + strike
// ladder (#1212/#2018), and per-purchase seller feedback (#1096/#1738).
// Extracted verbatim, zero behavior change.
//
// Deliberately NOT included here: requireSessionSeller/sellerExists/
// recordContentEditHistory/reviewFromRow/sellerFeedbackFromRow -- each is
// genuinely shared beyond this file (requireSessionSeller/sellerExists
// across dozens of other handlers; recordContentEditHistory also by
// calendar_events' own PATCH/DELETE; reviewFromRow/sellerFeedbackFromRow
// also by handleExportData's own GDPR export), so they stay in
// worker/index.js and are imported back below, the same
// one-directional-except-for-genuinely-shared-state shape
// worker/lib/builder-profile.js's own comment documents for its own
// templateFromRow/recomputeLandCap imports (#2535), and worker/lib/
// credit-orbs.js's own comment documents for requireSessionBuilder (#2541).
// requireSessionBuilder itself now lives in ./auth.js (moved there after
// this module was first written -- see that module's own comment) and is
// imported directly from there instead, not re-imported back from index.js.
import { json, HttpError, clientIp } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import { readJson, stringValue } from './validation.js';
import { fireNotification } from './notifications.js';
import { currentUser, requireAdmin, assertOwner, requireSessionBuilder } from './auth.js';
import { adminActionLogStatement } from './admin-log.js';
import { moderationRemovalCategory, recordModerationRemovalSnapshot } from './content-moderation.js';
import {
  requireSessionSeller, sellerExists, recordContentEditHistory,
  reviewFromRow, sellerFeedbackFromRow,
} from '../index.js';

// Reviews on a catalog template (docs/SPEC.md §5's "Review incentives,"
// docs/API.md's "Product reviews," migrations/0048) — nested under
// /catalog/:templateId/reviews rather than a top-level /product-reviews
// collection, same "never exists independent of its parent" reasoning as
// sign posts/calendar events. Attached to the *template* (the product
// itself), not to any one placed instance of it — see migrations/0048's own
// comment for why 0047's original instance-level design was wrong. No
// opt-in flag: every catalog template is already product-like by
// definition, so every one is reviewable. DELETE (moderation) is gated to
// the template's own seller, same "if (existing.seller_id)" pattern the
// catalog template's own PATCH/DELETE handler above already uses — an
// unowned/orphaned template's reviews get the same per-IP throttle
// (below) the catalog template's own DELETE already needed for the exact
// same reason (#520): with no owning seller to gate the request behind a
// session, an unthrottled anonymous caller could otherwise wipe every
// review on that template in an unbounded flood.
const PRODUCT_REVIEW_DELETE_RATE_LIMIT_MAX = 20;

// #804: review creation itself had no rate limit at all — the one outlier
// among comparable free-text-identity writes in this file (sign posts,
// calendar events, purchases, builder/seller creation, and even this
// endpoint's own DELETE branch below all have one). Originally keyed by
// clientIp since authorLabel was free text matched only against
// purchases.buyer_label (also free text); #1113 now requires a session, so
// this is keyed by builder_id like this file's other session-gated mutation
// rate limits (e.g. FRIENDSHIP_MUTATE_RATE_LIMIT_MAX).
const PRODUCT_REVIEW_CREATE_RATE_LIMIT_MAX = 20;

// #1975: same missing-rate-limit gap this file's other owner-gated CRUD
// mutations already closed (SIGN_POST_EDIT_RATE_LIMIT_MAX, #1830), for the
// new author-only edit branch below.
const PRODUCT_REVIEW_EDIT_RATE_LIMIT_MAX = 20;

// #2422: same "a dropped POST response and the innocent manual retry it
// invites" protection signPostIdempotencyKey/calendarEventIdempotencyKey
// already give their own structurally identical POSTs. Scoped by
// templateId+builderId rather than a purchase_id, since purchase_id isn't
// known until after the eligibility lookup the retry would otherwise fail
// against (a successful first attempt already consumed the purchase it
// reviewed).
function productReviewIdempotencyKey(templateId, builderId, rawKey) {
  if (typeof rawKey !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(rawKey)) return undefined;
  return `review:${templateId}:${builderId}:${rawKey}`;
}

export async function handleProductReviews(request, db, route) {
  const templateId = route[1];

  if (request.method === 'GET' && route.length === 3) {
    const template = await db.prepare('SELECT template_id FROM catalog_templates WHERE template_id = ?').bind(templateId).first();
    if (!template) return json({ error: 'Catalog template not found' }, 404);
    // #416: this was ORDER BY created_at with no DESC — ascending, so once a
    // product passed 200 reviews, the LIMIT window was always the *oldest*
    // 200, permanently hiding every review submitted after that point (the
    // same #356 already fixed for sign_posts/calendar_events). DESC picks
    // the right window (always the newest 200); .reverse() restores the
    // response's own ascending (oldest-of-the-window-first) order.
    const { results } = await db.prepare(`
      SELECT * FROM product_reviews WHERE template_id = ? ORDER BY created_at DESC LIMIT 200
    `).bind(templateId).all();
    const reviews = results.reverse().map(reviewFromRow);
    // averageRating/count are the product's real, all-time summary, not
    // derived from the LIMIT-200 page above (docs/API.md documents them as
    // authoritative — "no caller needs to re-derive it from the list
    // itself" — so past 200 reviews they'd otherwise silently become "the
    // 200 oldest reviews' average" instead of the whole product's).
    const summary = await db.prepare(`
      SELECT AVG(rating) AS average_rating, COUNT(*) AS count FROM product_reviews WHERE template_id = ?
    `).bind(templateId).first();
    const averageRating = summary.count === 0 ? null : summary.average_rating;
    return json({ reviews, averageRating, count: summary.count });
  }

  if (request.method === 'POST' && route.length === 3) {
    const template = await db.prepare('SELECT template_id, name, seller_id FROM catalog_templates WHERE template_id = ?').bind(templateId).first();
    if (!template) return json({ error: 'Catalog template not found' }, 404);
    // #1113 (closing #893's spoofing gap): now requires a session —
    // authorLabel is no longer client-supplied, and eligibility is a real
    // purchase_id lookup (purchases.buyer_builder_id, migrations/0099)
    // instead of a caller-supplied, non-unique, mutable label matched
    // against purchases.buyer_label. Every real purchase already requires
    // a verified session (N44), so this is a strict tightening, not a new
    // restriction on anyone who could legitimately review something.
    const sessionBuilder = await requireSessionBuilder(request, db);
    await checkRateLimit(db, `product-review-create:${sessionBuilder.builder_id}`, PRODUCT_REVIEW_CREATE_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const authorLabel = sessionBuilder.label;
    const rating = Number(input.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new HttpError('rating must be an integer from 1 to 5', 400);
    }
    const text = input.text === undefined || input.text === null || input.text === ''
      ? null
      : stringValue(input.text, 'text');
    if (text && text.length > 280) throw new HttpError('text must be 280 characters or fewer', 400);
    // #2422: a retry that reuses the same (validated) client-supplied key
    // finds its own already-landed row here and returns it instead of
    // hitting the eligibility check below -- which a successful first
    // attempt already consumed the one purchase it reviewed against, so a
    // naive retry would otherwise either 400 ("no eligible purchase") or,
    // if the shopper has a second unreviewed purchase of this same
    // product, silently create a second, distinct review that was never
    // the retry's intent. Checked before the eligibility lookup for
    // exactly that reason. Same content-match-before-reuse guard
    // signPostIdempotencyKey/#1778 already established for its own sibling.
    const idempotencyKey = productReviewIdempotencyKey(templateId, sessionBuilder.builder_id, input.idempotencyKey);
    let existingReview = null;
    if (idempotencyKey) {
      existingReview = await db.prepare('SELECT * FROM product_reviews WHERE review_id = ? AND template_id = ?')
        .bind(idempotencyKey, templateId).first();
      if (existingReview && existingReview.rating === rating && existingReview.text === text) {
        return json({ review: reviewFromRow(existingReview) });
      }
    }
    // The caller's own oldest unreviewed, unrefunded purchase of this
    // template — a real foreign key, not a label match. This SELECT alone
    // isn't the actual guard against double-reviewing (see the INSERT's own
    // WHERE NOT EXISTS below for that); it's just what turns "no eligible
    // purchase at all" into a clean 400 instead of a confusing 409.
    const purchase = await db.prepare(`
      SELECT purchase_id FROM purchases
      WHERE template_id = ? AND buyer_builder_id = ? AND refunded_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM product_reviews WHERE purchase_id = purchases.purchase_id)
      ORDER BY created_at ASC LIMIT 1
    `).bind(templateId, sessionBuilder.builder_id).first();
    if (!purchase) {
      throw new HttpError('Only a shopper who has purchased this product, and not yet reviewed that purchase, can review it', 400);
    }
    // One review per purchase (migrations/0100, replacing migrations/0059's
    // per-label guard) — the SELECT above is a point-in-time read, not a
    // consumption check, so without this the same purchase could otherwise
    // back an unbounded number of reviews. A separate SELECT-then-INSERT
    // here would be a check-then-act race (two concurrent submits against
    // the same purchase_id could both pass the SELECT before either INSERT
    // commits) — folding the existence check into the INSERT's own WHERE
    // clause instead makes the whole check-and-insert one atomic statement,
    // same idiom checkRateLimit uses for its own check-then-act race.
    // #1385: the eligibility SELECT above already required refunded_at IS
    // NULL, but that's the same stale-read problem — a refund landing
    // between that SELECT and this INSERT would otherwise leave nothing
    // blocking the insert, since the only atomic guard was "not already
    // reviewed." Re-checking refunded_at IS NULL here too, in the same
    // WHERE clause, closes that race the same way the double-review guard
    // already does. `changes === 0` means one of the two guards blocked
    // the insert; re-reading disambiguates which for a clearer error.
    const reviewId = (idempotencyKey && !existingReview) ? idempotencyKey : `review-${crypto.randomUUID()}`;
    // #1975: records who actually wrote this review (sessionBuilder.user_id),
    // the same sign_posts.user_id pattern (#1830/migrations/0125) — lets the
    // PATCH/DELETE branches below check real ownership instead of having no
    // identity to check at all.
    const result = await db.prepare(`
      INSERT INTO product_reviews (review_id, template_id, author_label, rating, text, purchase_id, user_id)
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM product_reviews WHERE purchase_id = ?
      )
      AND EXISTS (
        SELECT 1 FROM purchases WHERE purchase_id = ? AND refunded_at IS NULL
      )
    `).bind(
      reviewId, templateId, authorLabel, rating, text, purchase.purchase_id, sessionBuilder.user_id,
      purchase.purchase_id, purchase.purchase_id,
    ).run();
    if (result.meta.changes === 0) {
      const stillEligible = await db.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?')
        .bind(purchase.purchase_id).first();
      if (stillEligible?.refunded_at) {
        throw new HttpError('This purchase has been refunded and can no longer be reviewed', 409);
      }
      throw new HttpError('This purchase has already been reviewed', 409);
    }
    // #1043: every other real "something happened that the other party
    // should passively learn about" event in this file fires a
    // notification (a new bid, an auction selling, a sale, a friend
    // request — see notifyOfNewBid/the friendship POST branch above) — a
    // new review had no notification path at all. Best-effort, fired
    // after the write it's about, same convention as those. A seller-less
    // or dangling seller_id (same guard the DELETE branch below uses)
    // simply has nobody to notify.
    if (template.seller_id && await sellerExists(db, template.seller_id)) {
      const owner = await db.prepare(`
        SELECT b.builder_id AS builder_id FROM sellers s
        JOIN builders b ON b.user_id = s.user_id
        WHERE s.seller_id = ?
      `).bind(template.seller_id).first();
      if (owner) {
        await fireNotification(db, owner.builder_id,
          `"${authorLabel}" left a ${rating}-star review on "${template.name}".`);
      }
    }
    const row = await db.prepare('SELECT * FROM product_reviews WHERE review_id = ?').bind(reviewId).first();
    // #2429: same re-SELECT race #2364 fixed for this resource's PATCH
    // sibling, never applied to this POST/create branch -- a concurrent
    // admin delete landing in the awaited gap since the INSERT above can
    // remove the row before this re-SELECT runs.
    if (!row) return json({ error: 'Review not found' }, 404);
    return json({ review: reviewFromRow(row) }, 201);
  }

  if (request.method === 'PATCH' && route.length === 4) {
    const reviewId = route[3];
    const existing = await db.prepare('SELECT * FROM product_reviews WHERE review_id = ? AND template_id = ?').bind(reviewId, templateId).first();
    if (!existing) return json({ error: 'Review not found' }, 404);
    // #1975: editing is author-only -- there's no moderation equivalent for
    // PATCH the way DELETE has one (a seller moderating an unwanted review
    // removes it; rewriting someone else's review under their own name
    // isn't the same kind of action), same reasoning sign_posts' own PATCH
    // (#1830) already settled. A pre-#1975 review with no user_id at all
    // (user_id IS NULL) can never match here, same as DELETE's own
    // author-path below -- there's nobody on record to own it.
    const sessionBuilder = await requireSessionBuilder(request, db);
    if (existing.user_id === null || existing.user_id !== sessionBuilder.user_id) {
      throw new HttpError('Not your review', 403);
    }
    await checkRateLimit(db, `product-review-edit:${sessionBuilder.user_id}`, PRODUCT_REVIEW_EDIT_RATE_LIMIT_MAX);
    const input = await readJson(request);
    let rating = existing.rating;
    if (input.rating !== undefined) {
      rating = Number(input.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new HttpError('rating must be an integer from 1 to 5', 400);
      }
    }
    // Only an explicitly-present `text` key changes it -- an omitted key
    // keeps the review's existing text, the same "distinguish omitted from
    // explicitly cleared" shape bundles' own PATCH (COALESCE-based) handles,
    // just computed in JS here since text's own null-clearing rule (empty
    // string also means "no text", matching POST's own rule above) doesn't
    // map onto COALESCE's "null parameter means keep the old value" directly.
    let text = existing.text;
    if ('text' in input) {
      text = (input.text === null || input.text === '') ? null : stringValue(input.text, 'text');
    }
    if (text && text.length > 280) throw new HttpError('text must be 280 characters or fewer', 400);
    // Same "point-in-time read, real awaited gaps after it" race this file's
    // other author-direct mutations guard against (sign_posts' own PATCH).
    const updated = await db.prepare('UPDATE product_reviews SET rating = ?, text = ? WHERE review_id = ? AND user_id = ?')
      .bind(rating, text, reviewId, sessionBuilder.user_id).run();
    if (updated.meta.changes === 0) {
      throw new HttpError('Review changed concurrently — refetch and retry', 409);
    }
    // #1975/#2122: snapshot the pre-edit row for disputes -- logged only
    // after the update is confirmed to have actually happened (a concurrent
    // delete could otherwise win the race first and leave a false edit
    // snapshot for an edit that never took effect), same "logged only after
    // confirmed" idiom the delete_review_override admin branch below uses.
    await recordContentEditHistory(db, 'product_reviews', reviewId, 'edit', existing, sessionBuilder.user_id);
    const row = await db.prepare('SELECT * FROM product_reviews WHERE review_id = ?').bind(reviewId).first();
    // #2364: the UPDATE's own meta.changes check above only confirms it
    // matched a row at the moment it ran -- a concurrent admin DELETE (the
    // sibling branch below) landing in the awaited gap since (readJson/
    // checkRateLimit/recordContentEditHistory) can remove the row before
    // this re-SELECT runs. Same guard #2354 added for sign_posts/
    // calendar_events' identical shape.
    if (!row) return json({ error: 'Review not found' }, 404);
    return json({ review: reviewFromRow(row) });
  }

  if (request.method === 'DELETE' && route.length === 4) {
    const reviewId = route[3];
    const existing = await db.prepare('SELECT * FROM product_reviews WHERE review_id = ? AND template_id = ?').bind(reviewId, templateId).first();
    if (!existing) return json({ error: 'Review not found' }, 404);
    const template = await db.prepare('SELECT seller_id FROM catalog_templates WHERE template_id = ?').bind(templateId).first();
    // #1712: an admin can remove any review outright (harassment, doxxing,
    // other policy violations) regardless of whether the template's own
    // seller is reachable or ever acts on it -- checked first, via the
    // non-throwing currentUser lookup, since an admin isn't necessarily
    // that seller and shouldn't be forced through the ownership check below.
    const requester = await currentUser(request, db);
    const admin = requester && requester.is_admin ? requester : null;
    // #1975: the review's own author can remove it directly, alongside the
    // existing admin/seller moderation paths below -- same "either should be
    // able to remove it" shape sign_posts' own DELETE (#1830) already
    // settled. Checked after the admin branch (an admin override always
    // wins) but before seller moderation, since an author removing their
    // own review is not moderation and shouldn't need a reachable seller at
    // all. A pre-#1975 review with no user_id (user_id IS NULL) can never
    // match here, so it falls through to the existing paths exactly as it
    // always has.
    if (!admin && requester && existing.user_id !== null && existing.user_id === requester.user_id) {
      await checkRateLimit(db, `product-review-delete:${requester.user_id}`, PRODUCT_REVIEW_DELETE_RATE_LIMIT_MAX);
      const deletedByAuthor = await db.prepare('DELETE FROM product_reviews WHERE review_id = ? AND user_id = ?')
        .bind(reviewId, requester.user_id).run();
      if (deletedByAuthor.meta.changes === 0) {
        throw new HttpError('Review changed concurrently — refetch and retry', 409);
      }
      // #1975/#2122: logged only after the delete is confirmed to have
      // actually happened, same reasoning as the PATCH branch above.
      await recordContentEditHistory(db, 'product_reviews', reviewId, 'delete', existing, requester.user_id);
      return json({ deleted: true });
    }
    // #2388: every moderation path below (admin, seller, and the anonymous/
    // orphaned-template fallback) now requires a category, unlike the
    // author's own self-delete branch above which already returned. Read
    // and validated before the shared DELETE runs, same as this file's own
    // PATCH branch validates input before its UPDATE.
    let category;
    if (admin) {
      await checkRateLimit(db, `product-review-delete:${admin.user_id}`, PRODUCT_REVIEW_DELETE_RATE_LIMIT_MAX);
      category = moderationRemovalCategory(await readJson(request));
    } else if (template?.seller_id && await sellerExists(db, template.seller_id)) {
      const sessionSeller = await requireSessionSeller(request, db);
      assertOwner(template.seller_id, sessionSeller.seller_id, 'Not your catalog template');
      // #990: unlike the anonymous/orphaned-template branch below (#564),
      // this authenticated-owner branch never had a rate limit at all --
      // same gap class already closed for other authenticated mutation
      // actions in this file (FRIENDSHIP_MUTATE_RATE_LIMIT_MAX #899,
      // CALENDAR_EVENT_DELETE_RATE_LIMIT_MAX #944).
      await checkRateLimit(db, `product-review-delete:${sessionSeller.seller_id}`, PRODUCT_REVIEW_DELETE_RATE_LIMIT_MAX);
      category = moderationRemovalCategory(await readJson(request));
    } else {
      await checkRateLimit(db, `product-review-delete:${clientIp(request)}`, PRODUCT_REVIEW_DELETE_RATE_LIMIT_MAX);
      category = moderationRemovalCategory(await readJson(request));
    }
    const result = await db.prepare('DELETE FROM product_reviews WHERE review_id = ?').bind(reviewId).run();
    // `admin` is only set on the admin-override branch above; an ordinary
    // seller-initiated (or anonymous orphaned-template) delete logs nothing
    // here, same convention as handlePurchaseRefund's/handleMarkShipped's
    // own admin-override logging. Logged only after the delete is confirmed
    // to have actually happened -- the existence check above and this DELETE
    // aren't atomic, so a concurrent delete (another admin, or the owning
    // seller's own moderation path) can win the race first; a log row for a
    // deletion that didn't happen would misattribute it to this admin, same
    // "logged only after confirmed" idiom delete_land_candidate already uses.
    if (admin && result.meta.changes === 1) {
      await adminActionLogStatement(db, admin.user_id, 'delete_review_override', 'product_review', reviewId).run();
    }
    // #2388: same "logged only after confirmed" idiom -- requester may be
    // null here (the anonymous/orphaned-template branch has no authenticated
    // caller at all), which recordModerationRemovalSnapshot's own
    // removedByUserId param is nullable for exactly this reason.
    if (result.meta.changes === 1) {
      await recordModerationRemovalSnapshot(db, 'product_reviews', reviewId, category, existing, requester?.user_id ?? null);
    }
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
}

// #2017 (sub-issue of #1212, owner-settled shape 2026-10-13): a shopper-
// facing counterfeit-flag endpoint plus the admin resolve action on the
// same listing. Zero-cost/consequence-free for the flagger by design (the
// owner's own words: "don't punish good-faith reports") -- no rate limit
// beyond the ordinary anti-spam one below, and no visible penalty to the
// flagger's own account regardless of outcome.
const PRODUCT_FLAG_CREATE_RATE_LIMIT_MAX = 20;
// Auto-hide threshold: once this many *distinct* flaggers (migrations/0131's
// own UNIQUE constraint is what makes this actually distinct) are pending
// against one template, new purchases of it block automatically pending
// admin review -- see handleInstancePurchase's own flagged_hidden_at guard.
const PRODUCT_FLAG_AUTO_HIDE_THRESHOLD = 3;

// #2941 (owner decision, 2026-10-31, same decision that settled #2215's
// own option 2): a flag from an account whose signup Turnstile check
// actively failed (migrations/0171 -- NULL here means either a clean
// pass OR the feature being off at signup time, never "suspect by
// default") counts for less, composing with the IP-dedup factor below
// rather than replacing it, per #2941's own sequencing note. 0.5, not 0:
// unlike an exact shared IP (a near-certain same-device signal), a single
// failed/missing Turnstile check is a softer signal on its own (the real
// failure modes #2941 itself calls out -- a privacy-hardened browser, an
// in-app webview, an aggressive script blocker -- are not bot traffic),
// so it discounts rather than zeroes a flag outright.
const TURNSTILE_FAILED_FLAG_WEIGHT_MULTIPLIER = 0.5;

// #2215 (owner decision, 2026-10-31, option 2): the first pending flag
// against a listing from a given real IP counts fully toward the
// auto-hide threshold; any further pending flag sharing that same IP
// counts for nothing -- the same "first one counts, repeats don't" shape
// migrations/0131's own UNIQUE(template_id, flagger_builder_id) already
// gives distinct builder accounts, extended to a signal several cheaply-
// created accounts on one device/network can't each fake independently.
// clientIp(request)'s own 'unknown' fallback (no cf-connecting-ip header)
// is deliberately never treated as a real match here -- every caller with
// no header would otherwise collide on that one literal string and get
// zeroed out together, which isn't a same-device signal at all.
async function computeProductFlagWeight(db, templateId, flaggerIp, flaggerUserId) {
  if (flaggerIp === 'unknown') return 1;
  const sameIpPending = await db.prepare(`
    SELECT 1 FROM product_flags WHERE template_id = ? AND status = 'pending' AND flagger_ip = ? LIMIT 1
  `).bind(templateId, flaggerIp).first();
  const ipWeight = sameIpPending ? 0 : 1;
  if (ipWeight === 0) return 0;
  const flagger = await db.prepare('SELECT turnstile_failed_at FROM users WHERE user_id = ?').bind(flaggerUserId).first();
  return flagger?.turnstile_failed_at ? ipWeight * TURNSTILE_FAILED_FLAG_WEIGHT_MULTIPLIER : ipWeight;
}

export async function handleProductFlags(request, db, route) {
  const templateId = route[1];

  if (request.method === 'POST' && route.length === 3) {
    const template = await db.prepare('SELECT template_id, flagged_hidden_at, seller_id, product_id FROM catalog_templates WHERE template_id = ?').bind(templateId).first();
    if (!template) return json({ error: 'Catalog template not found' }, 404);
    const sessionBuilder = await requireSessionBuilder(request, db);
    await checkRateLimit(db, `product-flag-create:${sessionBuilder.builder_id}`, PRODUCT_FLAG_CREATE_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const reason = input.reason === undefined || input.reason === null || input.reason === ''
      ? null
      : stringValue(input.reason, 'reason');
    if (reason && reason.length > 280) throw new HttpError('reason must be 280 characters or fewer', 400);
    // migrations/0131's own UNIQUE(template_id, flagger_builder_id) is the
    // real guard against the same builder inflating their own listing's
    // distinct-flagger count -- a second flag from the same builder on the
    // same template hits that constraint and surfaces as a clean 409 via
    // this file's own top-level databaseHttpError fallback, same as every
    // other unhandled UNIQUE violation in this file.
    const flagId = `product-flag-${crypto.randomUUID()}`;
    const flaggerIp = clientIp(request);
    const weight = await computeProductFlagWeight(db, templateId, flaggerIp, sessionBuilder.user_id);
    await db.prepare(`
      INSERT INTO product_flags (flag_id, template_id, flagger_builder_id, reason, flagger_ip, weight)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(flagId, templateId, sessionBuilder.builder_id, reason, flaggerIp, weight).run();
    // Re-checked after the insert (not a cached count from before it) so a
    // concurrent flag from a different builder landing in between is never
    // silently lost from the threshold decision. pendingCount stays the
    // real, unweighted flag count (what admins see as "how many accounts
    // flagged this") -- pendingWeight is the separate, signal-adjusted sum
    // the auto-hide decision actually uses.
    const { pendingCount, pendingWeight } = await db.prepare(`
      SELECT COUNT(*) AS pendingCount, COALESCE(SUM(weight), 0) AS pendingWeight
      FROM product_flags WHERE template_id = ? AND status = 'pending'
    `).bind(templateId).first();
    let autoHidden = false;
    if (!template.flagged_hidden_at && pendingWeight >= PRODUCT_FLAG_AUTO_HIDE_THRESHOLD) {
      const hideResult = await db.prepare(`
        UPDATE catalog_templates SET flagged_hidden_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE template_id = ? AND flagged_hidden_at IS NULL
      `).bind(templateId).run();
      autoHidden = hideResult.meta.changes === 1;
      // #2783: without this, a shared product (#2749's products table)
      // auto-hidden here stays purchasable through a brand-new sibling
      // listing -- POST /api/catalog/listings only checks products.
      // flagged_hidden_at, which auto-hide never used to touch. Narrower
      // than the approve branch below on purpose: no sibling-listing
      // cascade, no placed_instances deletion, no strike -- those stay
      // admin-approve-only, matching this file's existing "provisional
      // (auto-hide) vs. confirmed (approve)" distinction. Just enough to
      // close the new-listing bypass for the product under review.
      if (autoHidden && template.product_id) {
        await db.prepare(`
          UPDATE products SET flagged_hidden_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE product_id = ? AND flagged_hidden_at IS NULL
        `).bind(template.product_id).run();
      }
      // #2056: auto-hide blocks every future purchase of this listing
      // immediately, well before any admin reviews the flags -- the same
      // practical effect on the seller as the admin-confirmed `approve`
      // branch below, which already notifies. Best-effort, same seller-
      // resolved-via-shared-user_id join that branch already uses.
      if (autoHidden && template.seller_id) {
        const owner = await db.prepare(`
          SELECT b.builder_id AS builder_id FROM sellers s
          JOIN builders b ON b.user_id = s.user_id
          WHERE s.seller_id = ?
        `).bind(template.seller_id).first();
        if (owner) {
          await fireNotification(db, owner.builder_id,
            'A listing of yours was automatically hidden pending review after multiple counterfeit/policy flags. New purchases are blocked until an admin resolves it.');
        }
      }
    }
    return json({ flagId, pendingCount, pendingWeight, autoHidden }, 201);
  }

  if (request.method === 'POST' && route.length === 4 && route[3] === 'resolve') {
    const admin = await requireAdmin(request, db);
    await checkRateLimit(db, `product-flag-resolve:${admin.user_id}`, PRODUCT_FLAG_CREATE_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const action = stringValue(input.action, 'action');
    if (action !== 'approve' && action !== 'reject') {
      throw new HttpError("action must be 'approve' or 'reject'", 400);
    }
    // #2018: lets an admin skip straight to the strike ladder's permanent-
    // removal rung for a single severe violation (confirmed counterfeit,
    // fraud, minor-safety), regardless of the seller's prior strike count --
    // only meaningful on approve, silently ignored otherwise.
    const severe = input.severe === true;
    const template = await db.prepare('SELECT template_id, seller_id, product_id FROM catalog_templates WHERE template_id = ?').bind(templateId).first();
    if (!template) return json({ error: 'Catalog template not found' }, 404);
    // Resolves every still-pending flag on this listing at once -- a flag is
    // a report against the *listing*, not an individually-adjudicated claim,
    // matching the owner's own "approve = remove listing" framing (one
    // decision per listing, not one per flag).
    const resolvedStatus = action === 'approve' ? 'approved' : 'rejected';
    const resolved = await db.prepare(`
      UPDATE product_flags SET status = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), resolved_by_admin_user_id = ?
      WHERE template_id = ? AND status = 'pending'
    `).bind(resolvedStatus, admin.user_id, templateId).run();
    if (resolved.meta.changes === 0) {
      throw new HttpError('No pending flags on this listing to resolve', 400);
    }
    if (action === 'approve') {
      // Stays hidden permanently (this UPDATE is a no-op if auto-hide
      // already set it) -- approving confirms the listing should no longer
      // be purchasable, it does not hard-delete catalog_templates itself
      // (that would trip assertCatalogTemplatesDeletable for any template
      // still saved into someone's layout library, a real, if rare, edge
      // case not worth forcing through here).
      await db.prepare(`
        UPDATE catalog_templates SET flagged_hidden_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE template_id = ? AND flagged_hidden_at IS NULL
      `).bind(templateId).run();
      // #2749: migrations/0153 lets more than one seller's own listing
      // (catalog_templates row) share the same underlying `products` row.
      // An admin-confirmed counterfeit/policy removal is a decision about
      // the product itself, not just the one listing the flags happened to
      // land on -- so it cascades to every sibling listing of the same
      // product, and to every already-placed instance of any of them,
      // across every landlet.
      // Gated on an actual sibling existing, not just product_id being set
      // (#2793): #2748/#2776 made the ordinary POST /catalog create path
      // back every new template with its own 1:1 products row at creation
      // time, so product_id is now set on nearly every listing, including
      // an entirely unshared one with no sibling at all. Before that
      // change, product_id being set was a reliable proxy for "this is a
      // genuinely shared product" (only true for a backfilled/explicitly-
      // attached listing) -- treating it as that same proxy today means
      // this cascade's own DELETE FROM placed_instances now fires on every
      // single approved flag, destructively removing the flagged listing's
      // already-placed instances everywhere even when there is no sibling
      // listing to clean up after -- a real behavior change nobody decided
      // (the primary hide statement just above this comment exists
      // specifically to avoid that: "does not hard-delete catalog_templates
      // itself... a real, if rare, edge case not worth forcing through
      // here"). Re-checking for a genuine sibling restores that original
      // intent for the common, unshared case.
      const siblingCount = template.product_id
        ? (await db.prepare('SELECT COUNT(*) AS siblingCount FROM catalog_templates WHERE product_id = ?')
          .bind(template.product_id).first()).siblingCount
        : 0;
      if (template.product_id && siblingCount > 1) {
        await db.prepare(`
          UPDATE products SET flagged_hidden_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE product_id = ? AND flagged_hidden_at IS NULL
        `).bind(template.product_id).run();
        await db.prepare(`
          UPDATE catalog_templates SET flagged_hidden_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE product_id = ? AND flagged_hidden_at IS NULL
        `).bind(template.product_id).run();
        await db.prepare(`
          DELETE FROM placed_instances WHERE template_id IN (
            SELECT template_id FROM catalog_templates WHERE product_id = ?
          )
        `).bind(template.product_id).run();
        // Best-effort notification to every *other* seller whose own
        // listing of the same product just got cascade-hidden -- unlike
        // the flagged listing's own seller below, they get no strike (the
        // flag was never against their listing), just a heads-up.
        const siblingSellers = await db.prepare(`
          SELECT DISTINCT b.builder_id AS builder_id
          FROM catalog_templates ct
          JOIN sellers s ON s.seller_id = ct.seller_id
          JOIN builders b ON b.user_id = s.user_id
          WHERE ct.product_id = ? AND ct.seller_id IS NOT NULL AND ct.seller_id != ?
        `).bind(template.product_id, template.seller_id ?? '').all();
        for (const sibling of siblingSellers.results) {
          await fireNotification(db, sibling.builder_id,
            'A product you sell was removed from the catalog after an admin-confirmed counterfeit/policy-violation flag against another seller\'s listing of the same shared product. No action was taken against your own account.');
        }
      }
      if (template.seller_id) {
        await db.prepare('UPDATE sellers SET strike_count = strike_count + 1 WHERE seller_id = ?').bind(template.seller_id).run();
        // Best-effort notification, same seller-resolved-via-shared-user_id
        // join handleSellerFeedbackCreate's own notification already uses.
        const owner = await db.prepare(`
          SELECT b.builder_id AS builder_id FROM sellers s
          JOIN builders b ON b.user_id = s.user_id
          WHERE s.seller_id = ?
        `).bind(template.seller_id).first();
        if (owner) {
          await fireNotification(db, owner.builder_id,
            'A product listing of yours was removed after an admin-confirmed counterfeit/policy-violation flag. A strike was added to your account.');
        }
        // #2018: the strike ladder itself -- reads the just-incremented
        // count fresh, so it always acts on the real post-increment total.
        await applyStrikeLadderConsequence(db, {
          sellerId: template.seller_id, ownerBuilderId: owner?.builder_id ?? null,
          adminUserId: admin.user_id, severe, templateId,
        });
      }
    } else {
      // Reject restores purchasability if auto-hide had already kicked in
      // for this listing -- never touched if an admin escalated straight to
      // removal without auto-hide ever firing.
      // #2467: but never when an earlier flag batch on this same listing was
      // already `approve`d -- that hide is permanent (see the approve branch's
      // own comment above), and nothing records *why* flagged_hidden_at is set,
      // so an unscoped UPDATE here would silently undo a confirmed-counterfeit
      // removal the moment any later, even weak/empty-reason, flag on the same
      // listing gets rejected.
      await db.prepare(`
        UPDATE catalog_templates SET flagged_hidden_at = NULL
        WHERE template_id = ? AND NOT EXISTS (SELECT 1 FROM product_flags WHERE template_id = ? AND status = 'approved')
      `).bind(templateId, templateId).run();
      // #2914: auto-hide (above) sets products.flagged_hidden_at too, for
      // any template with a product_id -- the reject clear above only ever
      // touched catalog_templates, so that product-level hide stayed set
      // forever, with no code path anywhere to ever clear it again,
      // permanently blocking any future POST /catalog/listings onto this
      // product (worker/lib/catalog.js's own flagged_hidden_at check).
      // Same "never undo an approved removal" guard as the per-template
      // clear just above, scoped to the whole product: stays hidden if ANY
      // sibling listing of this product has its own approved flag batch
      // (the approve branch's own cascade intentionally sets this for a
      // confirmed-counterfeit product), clears otherwise.
      if (template.product_id) {
        await db.prepare(`
          UPDATE products SET flagged_hidden_at = NULL
          WHERE product_id = ? AND NOT EXISTS (
            SELECT 1 FROM product_flags pf
            JOIN catalog_templates ct ON ct.template_id = pf.template_id
            WHERE ct.product_id = ? AND pf.status = 'approved'
          )
        `).bind(template.product_id, template.product_id).run();
      }
    }
    await adminActionLogStatement(db, admin.user_id, `${resolvedStatus}_product_flags`, 'catalog_template', templateId, {
      flagsResolved: resolved.meta.changes,
    }).run();
    return json({ resolvedStatus, flagsResolved: resolved.meta.changes });
  }

  return json({ error: 'Not found' }, 404);
}

// #2018 (sub-issue of #1212, owner-settled shape on #1212's own comment
// thread, 2026-10-13): warning (1st violation) -> temporary suspension
// (2nd violation, or 1st *severe* one) -> permanent removal (3rd
// violation, or any single severe one, skipping the ladder entirely).
// "Permanent" reuses #1201's own suspension tool at its maximum graceDays
// (365) rather than a separate hard-delete mechanism -- #1201's own
// resolution ruled out admin-initiated hard deletion outright, and #2033's
// own auto-escalation (worker/index.js's escalateExpiredSuspensions, run
// from scheduled()) is what actually turns an unlifted suspension into a
// real deletion; this rung's job is only to start that clock and make sure
// a later, lesser violation never pulls it backward.
const STRIKE_LADDER_TEMPORARY_GRACE_DAYS = 7;
const STRIKE_LADDER_PERMANENT_GRACE_DAYS = 365;

async function applyStrikeLadderConsequence(db, { sellerId, ownerBuilderId, adminUserId, severe, templateId }) {
  const seller = await db.prepare('SELECT user_id, strike_count FROM sellers WHERE seller_id = ?').bind(sellerId).first();
  // No linked account to act on -- same "dangling seller" tolerance this
  // file already extends elsewhere (e.g. handleSellerFeedbackDelete).
  if (!seller || !seller.user_id) return;
  if (!severe && seller.strike_count <= 1) {
    if (ownerBuilderId) {
      await fireNotification(db, ownerBuilderId,
        'Warning: a counterfeit/policy-violation flag against one of your listings was confirmed by an admin. A repeat violation will result in a temporary account suspension.');
    }
    return;
  }
  const permanent = severe || seller.strike_count >= 3;
  const graceDays = permanent ? STRIKE_LADDER_PERMANENT_GRACE_DAYS : STRIKE_LADDER_TEMPORARY_GRACE_DAYS;
  const reason = permanent
    ? `Strike ladder: permanent removal (${severe ? 'severe violation' : `strike ${seller.strike_count}`}) -- template ${templateId}`
    : `Strike ladder: temporary suspension (strike ${seller.strike_count}) -- template ${templateId}`;
  await applySuspensionLadderRung(db, { userId: seller.user_id, adminUserId, reason, graceDays });
  if (ownerBuilderId) {
    await fireNotification(db, ownerBuilderId, permanent
      ? 'Your account has been suspended indefinitely after a confirmed counterfeit/policy violation. This suspension will not be lifted.'
      : `Your account has been temporarily suspended for ${STRIKE_LADDER_TEMPORARY_GRACE_DAYS} days after a confirmed counterfeit/policy violation.`);
  }
}

// Distinct from handleSuspendAccount's own plain insert-only path (which
// must keep 409ing on an already-active suspension, per that endpoint's
// existing contract) -- the strike ladder is the one caller that can
// legitimately land on an account its own earlier rung already suspended
// (e.g. the 2nd-violation 7-day suspension, followed later by a 3rd/severe
// violation), and escalating the existing row forward -- never shortening
// it -- is the correct behavior there, not a 409 or a second, conflicting
// active row.
async function applySuspensionLadderRung(db, { userId, adminUserId, reason, graceDays }) {
  const gracePeriodEndsAt = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000).toISOString();
  const suspensionId = `suspension-${crypto.randomUUID()}`;
  const inserted = await db.prepare(`
    INSERT INTO account_suspensions (suspension_id, user_id, admin_user_id, reason, grace_period_ends_at)
    SELECT ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM account_suspensions WHERE user_id = ? AND lifted_at IS NULL AND escalated_at IS NULL
    )
  `).bind(suspensionId, userId, adminUserId, reason, gracePeriodEndsAt, userId).run();
  if (inserted.meta.changes === 1) {
    await adminActionLogStatement(db, adminUserId, 'suspend_account', 'user', userId, {
      suspensionId, reason, gracePeriodEndsAt,
    }).run();
    return;
  }
  const active = await db.prepare(`
    SELECT * FROM account_suspensions WHERE user_id = ? AND lifted_at IS NULL AND escalated_at IS NULL
  `).bind(userId).first();
  if (!active || active.grace_period_ends_at >= gracePeriodEndsAt) return;
  const updated = await db.prepare(`
    UPDATE account_suspensions SET grace_period_ends_at = ?
    WHERE suspension_id = ? AND grace_period_ends_at < ?
  `).bind(gracePeriodEndsAt, active.suspension_id, gracePeriodEndsAt).run();
  if (updated.meta.changes === 1) {
    await adminActionLogStatement(db, adminUserId, 'escalate_suspension', 'user', userId, {
      suspensionId: active.suspension_id, reason, newGracePeriodEndsAt: gracePeriodEndsAt,
    }).run();
  }
}

export async function handleProductFlagsList(request, db, url) {
  await requireAdmin(request, db);
  // One row per *listing* with pending flags, not one per flag -- an admin
  // resolves a listing's whole pending set in one action (see
  // handleProductFlags' own POST .../resolve above), so the queue should
  // read the same way, with the per-flag detail (reasons, flagger history)
  // available via a follow-up fetch if ever needed rather than cluttering
  // this summary view.
  const { results } = await db.prepare(`
    SELECT
      pf.template_id AS templateId,
      ct.name AS templateName,
      ct.seller_id AS sellerId,
      COUNT(*) AS pendingCount,
      MIN(pf.created_at) AS firstFlaggedAt,
      MAX(pf.created_at) AS lastFlaggedAt
    FROM product_flags pf
    JOIN catalog_templates ct ON ct.template_id = pf.template_id
    WHERE pf.status = 'pending'
    GROUP BY pf.template_id
    ORDER BY lastFlaggedAt DESC
    LIMIT 200
  `).all();
  // #2110: same totalCount-alongside-the-cap pattern as handleSignPosts/
  // handleCalendarEvents/handlePurchases -- without it, an admin reviewing
  // this trust-and-safety queue has no way to tell "200 of 200" from "200
  // of 1400", silently dropping older pending listings off the end once
  // the cap is reached. Counts distinct flagged templates, matching what
  // the capped query above is itself grouped and capped by.
  const total = await db.prepare(`
    SELECT COUNT(DISTINCT template_id) AS count FROM product_flags WHERE status = 'pending'
  `).first();
  return json({ listings: results, totalCount: total.count });
}

// Issue #1096 (owner decision via Control Room, 2026-10-01): distinct from
// product_reviews (migrations/0047/0048) — a review rates the *product*,
// shared across every seller who lists it; this rates one specific
// seller's own service (listing accuracy, timeliness, communication) for
// one specific purchase from them. Mirrors handleProductReviews' own
// purchase-gating and rate-limit shape (see that function's own comments
// for the full reasoning) — the differences are purely that this is keyed
// to one exact purchase_id rather than a template_id/buyer_builder_id
// pair, since the owner's own ask was "one to one with a purchase." #1123:
// this had drifted to mirror handleProductReviews' *pre*-#893-fix shape
// (a client-supplied authorLabel matched against free-text buyer_label) —
// now updated to the same session-derived, buyer_builder_id-based
// eligibility check #1113/#1116 already brought to product reviews.
const SELLER_FEEDBACK_CREATE_RATE_LIMIT_MAX = 20;

// #1975 (owner decision via #1738, 2026-10-13): the feedback's own author
// (the purchase's buyer) gets the same self-edit/delete #1975 already gave
// sign posts/product reviews/calendar events. Unlike those three,
// seller_feedback gets no new user_id column for it — the buyer's identity
// is already permanently on record via purchases.buyer_builder_id
// (migrations/0099), the same real, session-verified, never-reassigned
// identity handleSellerFeedbackCreate's own eligibility check already
// uses, so authorization and this row shape's own userId field both
// resolve it with a join instead. A purchase whose buyer later self-
// deletes their account nulls buyer_builder_id (ON DELETE SET NULL) —
// same as every other precedent's "legacy/no author on record" case, such
// a row can never be claimed by anyone as their own.
const SELLER_FEEDBACK_SELECT_WITH_BUYER = `
  SELECT f.*, bld.user_id AS buyer_user_id FROM seller_feedback f
  JOIN purchases p ON p.purchase_id = f.purchase_id
  LEFT JOIN builders bld ON bld.builder_id = p.buyer_builder_id
`;

export async function handleSellerFeedbackCreate(request, env, purchaseId) {
  const db = env.DB;
  const purchase = await db.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
  if (!purchase) throw new HttpError('Purchase not found', 404);
  if (!purchase.seller_id) {
    throw new HttpError('This purchase has no seller to leave feedback for', 400);
  }
  // #1123 (closing the same spoofing gap #893 already fixed for product
  // reviews): requires a session — authorLabel is no longer client-supplied,
  // and eligibility is a real buyer_builder_id match (migrations/0099)
  // instead of a caller-supplied, non-unique, mutable label matched against
  // purchases.buyer_label.
  const sessionBuilder = await requireSessionBuilder(request, db);
  await checkRateLimit(db, `seller-feedback-create:${sessionBuilder.builder_id}`, SELLER_FEEDBACK_CREATE_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const authorLabel = sessionBuilder.label;
  // Same #357 refunded-purchase exclusion handleProductReviews uses — a
  // shopper made whole by a refund has no standing to also rate that same
  // transaction's service.
  if (purchase.buyer_builder_id !== sessionBuilder.builder_id || purchase.refunded_at) {
    throw new HttpError('Only the buyer of this purchase can leave feedback', 400);
  }
  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new HttpError('rating must be an integer from 1 to 5', 400);
  }
  const text = input.text === undefined || input.text === null || input.text === ''
    ? null
    : stringValue(input.text, 'text');
  if (text && text.length > 280) throw new HttpError('text must be 280 characters or fewer', 400);
  // One feedback per purchase (migrations/0097's own UNIQUE constraint on
  // purchase_id is the DB-level backstop) — folding the existence check
  // into the INSERT's own WHERE clause, same atomic check-and-insert idiom
  // handleProductReviews' own comment explains, avoids a check-then-act
  // race between two concurrent submits for the same purchase ever
  // reaching the UNIQUE constraint as a raw, unhandled error.
  // #1385: the eager refunded_at check above has the same stale-read
  // problem handleProductReviews' own INSERT guard just closed — a refund
  // landing between that check and this INSERT would otherwise leave
  // nothing blocking it, since the only atomic guard was "not already
  // left." Re-checking refunded_at IS NULL here too closes that race.
  const feedbackId = `seller-feedback-${crypto.randomUUID()}`;
  const result = await db.prepare(`
    INSERT INTO seller_feedback (feedback_id, purchase_id, seller_id, author_label, rating, text)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM seller_feedback WHERE purchase_id = ?)
    AND EXISTS (SELECT 1 FROM purchases WHERE purchase_id = ? AND refunded_at IS NULL)
  `).bind(feedbackId, purchaseId, purchase.seller_id, authorLabel, rating, text, purchaseId, purchaseId).run();
  if (result.meta.changes === 0) {
    const stillEligible = await db.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?')
      .bind(purchaseId).first();
    if (stillEligible?.refunded_at) {
      throw new HttpError('This purchase has been refunded and can no longer have feedback left for it', 409);
    }
    throw new HttpError('Feedback has already been left for this purchase', 409);
  }
  // Best-effort notification, same convention as handleProductReviews'
  // own POST — seller resolved to their own builder profile via the
  // shared user_id both tables carry; a dangling seller_id has nobody to
  // notify and is silently skipped (sellerExists already confirmed above
  // isn't needed here since a dangling seller_id just means the join
  // below returns nothing).
  const owner = await db.prepare(`
    SELECT b.builder_id AS builder_id FROM sellers s
    JOIN builders b ON b.user_id = s.user_id
    WHERE s.seller_id = ?
  `).bind(purchase.seller_id).first();
  if (owner) {
    await fireNotification(db, owner.builder_id,
      `"${authorLabel}" left ${rating}-star feedback on a purchase from you.`);
  }
  const row = await db.prepare(`${SELLER_FEEDBACK_SELECT_WITH_BUYER} WHERE f.feedback_id = ?`).bind(feedbackId).first();
  // #2429: same re-SELECT race #2364 fixed for this resource's PATCH
  // sibling, never applied to this POST/create branch -- a concurrent
  // admin delete can remove the row before this re-SELECT runs.
  if (!row) return json({ error: 'Feedback not found' }, 404);
  return json({ feedback: sellerFeedbackFromRow(row) }, 201);
}

// #1975/#1738: author-only edit for the feedback's own author (the
// purchase's buyer) — mirrors product_reviews'/calendar_events' own PATCH
// shape exactly (see SELLER_FEEDBACK_SELECT_WITH_BUYER's own comment above
// for why this is gated via a join instead of a native user_id column).
// No moderation equivalent for PATCH, same reasoning as those two:
// rewriting someone else's feedback under their own name isn't a kind of
// moderation action that exists anywhere else in this file.
const SELLER_FEEDBACK_EDIT_RATE_LIMIT_MAX = 20;

export async function handleSellerFeedbackEdit(request, env, purchaseId) {
  const db = env.DB;
  const existing = await db.prepare(`${SELLER_FEEDBACK_SELECT_WITH_BUYER} WHERE f.purchase_id = ?`).bind(purchaseId).first();
  if (!existing) return json({ error: 'Feedback not found' }, 404);
  const sessionBuilder = await requireSessionBuilder(request, db);
  if (existing.buyer_user_id === null || existing.buyer_user_id !== sessionBuilder.user_id) {
    throw new HttpError('Not your feedback', 403);
  }
  await checkRateLimit(db, `seller-feedback-edit:${sessionBuilder.user_id}`, SELLER_FEEDBACK_EDIT_RATE_LIMIT_MAX);
  const input = await readJson(request);
  let rating = existing.rating;
  if (input.rating !== undefined) {
    rating = Number(input.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new HttpError('rating must be an integer from 1 to 5', 400);
    }
  }
  // Same omitted-vs-explicitly-cleared distinction product_reviews' own
  // PATCH already makes — an absent `text` key keeps the existing value, an
  // explicit null/empty string clears it.
  let text = existing.text;
  if ('text' in input) {
    text = (input.text === null || input.text === '') ? null : stringValue(input.text, 'text');
  }
  if (text && text.length > 280) throw new HttpError('text must be 280 characters or fewer', 400);
  // Same "point-in-time read, real awaited gaps after it" race this file's
  // other author-direct mutations guard against — re-verified atomically via
  // the same join authorization used above, not just the eager read.
  const updated = await db.prepare(`
    UPDATE seller_feedback SET rating = ?, text = ? WHERE purchase_id = ? AND EXISTS (
      SELECT 1 FROM purchases p JOIN builders bld ON bld.builder_id = p.buyer_builder_id
      WHERE p.purchase_id = seller_feedback.purchase_id AND bld.user_id = ?
    )
  `).bind(rating, text, purchaseId, sessionBuilder.user_id).run();
  if (updated.meta.changes === 0) {
    throw new HttpError('Feedback changed concurrently — refetch and retry', 409);
  }
  // #1975/#2122: snapshot the pre-edit row for disputes -- logged only
  // after the update is confirmed to have actually happened, same "logged
  // only after confirmed" idiom the admin-DELETE branch below uses.
  await recordContentEditHistory(db, 'seller_feedback', existing.feedback_id, 'edit', existing, sessionBuilder.user_id);
  const row = await db.prepare(`${SELLER_FEEDBACK_SELECT_WITH_BUYER} WHERE f.purchase_id = ?`).bind(purchaseId).first();
  // #2364: same concurrent-admin-delete race #2354 fixed for sign_posts/
  // calendar_events -- the UPDATE's own meta.changes check above only
  // confirms it matched a row at the moment it ran, not that it still
  // exists by the time this re-SELECT runs.
  if (!row) return json({ error: 'Feedback not found' }, 404);
  return json({ feedback: sellerFeedbackFromRow(row) });
}

// #1738 (owner confirmed, 2026-10-13): seller_feedback rates a person's own
// conduct on a transaction, not a product -- unlike product_reviews' own
// DELETE branch, which lets the reviewed template's seller self-delete,
// self-delete here would let a seller scrub legitimate negative feedback
// about their own conduct. Admin-only removal remains the sole moderation
// route for the rated seller's side — there is deliberately no third,
// seller-moderation branch the way product_reviews has one, since #1738's
// own resolution confirmed the rated seller never gets to remove feedback
// about themselves, ever. #1975 (same thread): the feedback's own author
// (the buyer who actually wrote it) is a different person from the rated
// seller and gets the ordinary author-direct removal every other
// self-authored content type in this file already has — ON DELETE SET
// NULL on purchases.buyer_builder_id means a buyer who later self-deletes
// their account can never come back and claim it (same "legacy/no author
// on record" case SELLER_FEEDBACK_SELECT_WITH_BUYER's own comment
// describes), so it falls through to admin-only exactly as it always has.
// Keyed by purchaseId (not a separate feedbackId) since migrations/0097's
// own UNIQUE constraint on purchase_id already makes it a 1-to-1 resource,
// the same shape POST .../feedback above already uses.
const SELLER_FEEDBACK_DELETE_RATE_LIMIT_MAX = 20;

export async function handleSellerFeedbackDelete(request, env, purchaseId) {
  const db = env.DB;
  const existing = await db.prepare(`${SELLER_FEEDBACK_SELECT_WITH_BUYER} WHERE f.purchase_id = ?`).bind(purchaseId).first();
  if (!existing) return json({ error: 'Feedback not found' }, 404);
  const requester = await currentUser(request, db);
  const admin = requester && requester.is_admin ? requester : null;
  if (!admin && requester && existing.buyer_user_id !== null && existing.buyer_user_id === requester.user_id) {
    await checkRateLimit(db, `seller-feedback-delete:${requester.user_id}`, SELLER_FEEDBACK_DELETE_RATE_LIMIT_MAX);
    const deletedByAuthor = await db.prepare(`
      DELETE FROM seller_feedback WHERE purchase_id = ? AND EXISTS (
        SELECT 1 FROM purchases p JOIN builders bld ON bld.builder_id = p.buyer_builder_id
        WHERE p.purchase_id = seller_feedback.purchase_id AND bld.user_id = ?
      )
    `).bind(purchaseId, requester.user_id).run();
    if (deletedByAuthor.meta.changes === 0) {
      throw new HttpError('Feedback changed concurrently — refetch and retry', 409);
    }
    // #1975/#2122: logged only after the delete is confirmed to have
    // actually happened, same reasoning as the PATCH branch above.
    await recordContentEditHistory(db, 'seller_feedback', existing.feedback_id, 'delete', existing, requester.user_id);
    return json({ deleted: true });
  }
  const resolvedAdmin = admin || await requireAdmin(request, db);
  await checkRateLimit(db, `seller-feedback-delete:${resolvedAdmin.user_id}`, SELLER_FEEDBACK_DELETE_RATE_LIMIT_MAX);
  const result = await db.prepare('DELETE FROM seller_feedback WHERE purchase_id = ?').bind(purchaseId).run();
  // #2003: the existence check above and this DELETE aren't atomic, so a
  // concurrent delete (another admin retrying, say) can win the race
  // first -- logged only after confirmed to have actually happened, same
  // "logged only after confirmed" idiom delete_review_override/
  // delete_land_candidate already use, so a deletion that didn't happen
  // is never misattributed to this admin.
  if (result.meta.changes === 1) {
    await adminActionLogStatement(db, resolvedAdmin.user_id, 'delete_seller_feedback', 'seller_feedback', existing.feedback_id).run();
  }
  return json({ deleted: true });
}

export async function handleSellerFeedbackList(db, sellerId) {
  // Public, same reasoning as GET .../reviews being unauthenticated — a
  // rating is meant to be seen, not just by the seller themself. The only
  // UI surfacing it today is the Seller modal (necessarily the seller's
  // own, since opening someone else's isn't possible), which is what makes
  // it read as "seller-facing" in practice without the API itself needing
  // to restrict who can ask.
  const { results } = await db.prepare(`
    ${SELLER_FEEDBACK_SELECT_WITH_BUYER} WHERE f.seller_id = ? ORDER BY f.created_at DESC LIMIT 200
  `).bind(sellerId).all();
  const feedback = results.reverse().map(sellerFeedbackFromRow);
  // averageRating/count are the seller's real, all-time summary, not
  // derived from the LIMIT-200 page above — same reasoning as
  // handleProductReviews' own averageRating comment.
  const summary = await db.prepare(`
    SELECT AVG(rating) AS average_rating, COUNT(*) AS count FROM seller_feedback WHERE seller_id = ?
  `).bind(sellerId).first();
  const averageRating = summary.count === 0 ? null : summary.average_rating;
  return json({ feedback, averageRating, count: summary.count });
}

