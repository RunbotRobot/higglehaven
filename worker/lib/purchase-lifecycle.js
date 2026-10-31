// #2615 (leaf of #2540, itself sub-issue of #2502/#2500's worker/index.js
// module split): the purchase lifecycle actions reachable after a purchase
// already exists -- the /api/purchases dispatcher itself, marking a
// physical good shipped, confirming delivery via the unauthenticated
// tracking-link token, and the seller/admin-initiated refund + buyer-
// initiated auto-resolve dispute paths, plus every helper exclusively used
// by them. Extracted verbatim, zero behavior change. Depended on the
// sibling "purchase creation" leaf (#2614, worker/lib/purchase-creation.js)
// landing first for purchaseFromRow/handlePurchaseFinalize.
//
// Deliberately NOT included here (stays with the sibling "purchase
// creation" leaf, #2614, since this leaf's own functions only call it, not
// the other way around): purchaseFromRow, handlePurchaseFinalize, and
// every other helper exclusive to that leaf.
import { json, HttpError, clientIp } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import { readJson, stringValue } from './validation.js';
import { requireSessionBuilder, requireAdmin, assertOwner, sha256Hex } from './auth.js';
import { adminActionLogStatement } from './admin-log.js';
import { fireNotification } from './notifications.js';
import { handlePurchaseFinalize, purchaseFromRow } from './purchase-creation.js';
import { handleSellerFeedbackCreate, handleSellerFeedbackEdit, handleSellerFeedbackDelete } from './reputation.js';
import {
  stripeConfigured, stripeRequest, sellerExists, requireSessionSeller, formatCents,
} from '../index.js';

// #1978: workerd requires every named export of the main Worker entry
// module (worker/index.js) to be a function/class binding, not a plain
// const -- confirmed the hard way, per worker/lib/builder-profile.js's own
// comment on its identical D1_MAX_BOUND_PARAMETERS duplication. Duplicated
// here rather than exported-and-imported for that reason, same as
// worker/lib/stripe.js/seller-payouts-tax.js/seller-profile.js's own
// identical STRIPE_RATE_LIMIT_MAX copies -- this leaf's own
// handlePurchaseRefund is just one more caller of the same shared-key-rate-
// limit shape, not a reason to centralize it.
const STRIPE_RATE_LIMIT_MAX = 20;

// #651 (owner, Control Room, 2026-09-10): a real-money refund pays back
// only this fraction of the original total, never the full 100% — closes
// a fraud triangle (buy fake sale, cash out builder commission, refund
// full price) that a no-floor-guard refund would otherwise leave open. Set
// to exactly 1 - (PURCHASE_COMMISSION_RATE * PURCHASE_BUILDER_SPLIT), i.e.
// 1 minus the builder's typical share of a sale, so the haircut exactly
// offsets what the triangle could otherwise net — see handlePurchaseRefund's
// own comment for the full reasoning. Not derived from the other constants
// programmatically since the owner's own number (99%) is the actual
// policy, publish on a refund-policy page verbatim — this should change
// only if that policy itself changes, not silently drift if the
// commission rate ever does. #2614 moved PURCHASE_COMMISSION_RATE/
// PURCHASE_BUILDER_SPLIT themselves into worker/lib/purchase-creation.js;
// this constant's own derivation still references their values there.
const REFUND_PAYOUT_RATE = 0.99;
// #2020 (sub-issue of #1212, owner-settled shape 2026-10-13): "disputes/
// refund requests at or below $15-25... exact value at implementer's
// discretion within that range" — picked the midpoint.
const DISPUTE_AUTO_RESOLVE_THRESHOLD_CENTS = 2000;
const DISPUTE_RATE_LIMIT_MAX = 20;
// Same unauthenticated-by-design reasoning as PURCHASE_FINALIZE_RATE_LIMIT_MAX
// (worker/lib/purchase-creation.js, #2614) — handlePurchaseConfirmDelivery has
// no buyer account to authenticate against either, so it's keyed by client IP
// rather than a builder/seller id.
const CONFIRM_DELIVERY_RATE_LIMIT_MAX = 20;

export async function handlePurchases(request, env, route, url) {
  const db = env.DB;

  if (request.method === 'POST' && route.length === 2 && route[1] === 'finalize') {
    return handlePurchaseFinalize(request, env);
  }

  if (request.method === 'GET' && route.length === 1) {
    const builderId = url.searchParams.get('builderId');
    const templateId = url.searchParams.get('templateId');
    const danglingSeller = url.searchParams.get('danglingSeller');
    // #1824: the admin dashboard's purchases-fallback panel needs a way to
    // find the purchases its own refund/mark-shipped admin-override
    // branches exist for (a seller_id that's non-null but no longer in
    // `sellers` -- see sellerExists' own comment) -- there was no way to
    // list those before this, only the two session-scoped filters below.
    // Admin-only since, unlike builderId/templateId above, nothing here is
    // scoped back to the caller's own session at all.
    if (danglingSeller) {
      await requireAdmin(request, db);
      const { results } = await db.prepare(`
        SELECT * FROM purchases
        WHERE seller_id IS NOT NULL AND seller_id NOT IN (SELECT seller_id FROM sellers)
        ORDER BY created_at DESC LIMIT 100
      `).all();
      const total = await db.prepare(`
        SELECT COUNT(*) AS count FROM purchases
        WHERE seller_id IS NOT NULL AND seller_id NOT IN (SELECT seller_id FROM sellers)
      `).first();
      return json({ purchases: results.map(purchaseFromRow), totalCount: total.count });
    }
    // builderId lists everything hosted on that builder's own land (their
    // "did I earn commission" view); templateId lists every sale of one
    // product across every builder who happens to host an instance of it
    // (the product's own seller's "did my product sell" view — see
    // "Simulated purchases" / "Refunds" in docs/API.md). Exactly one is
    // required; there's no "list everything" mode.
    if (builderId) {
      const id = stringValue(builderId, 'builderId');
      const sessionBuilder = await requireSessionBuilder(request, db);
      assertOwner(id, sessionBuilder.builder_id, 'Not your purchases');
      const { results } = await db.prepare(`
        SELECT * FROM purchases WHERE builder_id = ? ORDER BY created_at DESC LIMIT 100
      `).bind(id).all();
      // The list above is capped at 100 rows (no pagination) — fine for the
      // list itself, but a naive .length undercounts once a builder has more
      // than 100 purchases. A dedicated COUNT has no such cap (same fix
      // already applied to the notifications unread badge).
      const total = await db.prepare('SELECT COUNT(*) AS count FROM purchases WHERE builder_id = ?').bind(id).first();
      return json({ purchases: results.map(purchaseFromRow), totalCount: total.count });
    }
    if (templateId) {
      const id = stringValue(templateId, 'templateId');
      const template = await db.prepare('SELECT seller_id FROM catalog_templates WHERE template_id = ?').bind(id).first();
      if (!template) throw new HttpError('Catalog template not found', 404);
      // #940: catalog_templates.seller_id has no FK constraint, so it can be
      // a genuinely dangling value once the owning seller self-deletes their
      // account (no live session can ever resolve to a deleted seller_id,
      // per getOrCreateSellerForUser) -- a plain truthiness check here would
      // 403 this endpoint forever, for everyone, the same way #932/#934/#936/
      // #937 already found on this resource's other sibling handlers.
      if (template.seller_id) {
        if (await sellerExists(db, template.seller_id)) {
          const sessionSeller = await requireSessionSeller(request, db);
          assertOwner(template.seller_id, sessionSeller.seller_id, 'Not your product');
        } else {
          await requireAdmin(request, db);
        }
      }
      const { results } = await db.prepare(`
        SELECT * FROM purchases WHERE template_id = ? ORDER BY created_at DESC LIMIT 100
      `).bind(id).all();
      const total = await db.prepare('SELECT COUNT(*) AS count FROM purchases WHERE template_id = ?').bind(id).first();
      return json({ purchases: results.map(purchaseFromRow), totalCount: total.count });
    }
    throw new HttpError('builderId, templateId, or danglingSeller is required', 400);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'refund') {
    return handlePurchaseRefund(request, env, route[1]);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'dispute') {
    return handlePurchaseDispute(request, env, route[1]);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'mark-shipped') {
    return handleMarkShipped(request, env, route[1]);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'feedback') {
    return handleSellerFeedbackCreate(request, env, route[1]);
  }

  if (request.method === 'PATCH' && route.length === 3 && route[2] === 'feedback') {
    return handleSellerFeedbackEdit(request, env, route[1]);
  }

  if (request.method === 'DELETE' && route.length === 3 && route[2] === 'feedback') {
    return handleSellerFeedbackDelete(request, env, route[1]);
  }

  // Unauthenticated on purpose — see buildDeliveryConfirmFields' own
  // comment: there is no buyer account here to authenticate against, so
  // the unguessable token itself (hashed before ever reaching the DB) is
  // the only credential this needs, the same trust model a real
  // guest-checkout tracking link already relies on.
  if (request.method === 'POST' && route.length === 2 && route[1] === 'confirm-delivery') {
    return handlePurchaseConfirmDelivery(request, env);
  }

  return json({ error: 'Not found' }, 404);
}

// #454: seller-initiated (there's no buyer/shipping-carrier integration to
// do this automatically) — starts the 7-day fallback clock for a physical
// real-money purchase's payout hold (see PHYSICAL_GOOD_HOLD_DAYS). A
// digital good or a simulated (higgles) purchase has nothing to ship.
const MARK_SHIPPED_RATE_LIMIT_MAX = 20;

async function handleMarkShipped(request, env, purchaseId) {
  const db = env.DB;
  const purchase = await db.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
  if (!purchase) return json({ error: 'Purchase not found' }, 404);
  // #937: seller_id can be non-null yet dangling -- pointing at a seller row
  // DELETE /api/sellers/:id already removed. Without this sellerExists
  // check, assertOwner below would 403 forever once that happens (no live
  // session can ever match an id no longer in `sellers`), permanently
  // locking out this purchase's mark-shipped call. Mirrors
  // handlePurchaseRefund's own fallback to requireAdmin for the same reason.
  let admin;
  if (purchase.seller_id && await sellerExists(db, purchase.seller_id)) {
    const sessionSeller = await requireSessionSeller(request, db);
    assertOwner(purchase.seller_id, sessionSeller.seller_id, 'Not your product');
  } else {
    admin = await requireAdmin(request, db);
  }
  await checkRateLimit(db, `mark-shipped:${admin ? admin.user_id : purchase.seller_id}`, MARK_SHIPPED_RATE_LIMIT_MAX);
  if (!purchase.payment_intent_id) {
    throw new HttpError('Only real-money purchases can be marked shipped', 400);
  }
  if (purchase.is_digital_good) {
    throw new HttpError('Digital goods have nothing to ship', 400);
  }
  if (purchase.shipped_at) {
    throw new HttpError('This purchase is already marked shipped', 409);
  }
  if (purchase.refunded_at) {
    throw new HttpError('This purchase has been refunded', 400);
  }
  // #925: the shipped_at check above and this UPDATE were a check-then-act
  // race -- two concurrent requests could both pass the check and both
  // write, silently overwriting shipped_at with whichever landed second.
  // Folding the guard into the UPDATE's own WHERE clause closes it, same
  // pattern as the other claim-before-act writes in this file (landlet-
  // level guards, friendship-accept, refund guards).
  // #1384: also re-checks refunded_at IS NULL here, not just above -- the
  // eager refunded_at read a few lines up is a fast-path only, same as
  // #925's own shipped_at read; a concurrent handlePurchaseRefund landing
  // in the window between that read and this write used to still let
  // shipped_at get set (and the "it shipped!" notification fire) on a
  // purchase that was, by the time this actually committed, refunded.
  const result = await db.prepare(
    'UPDATE purchases SET shipped_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE purchase_id = ? AND shipped_at IS NULL AND refunded_at IS NULL',
  ).bind(purchaseId).run();
  if (result.meta.changes === 0) {
    const current = await db.prepare('SELECT shipped_at, refunded_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    if (current.refunded_at) throw new HttpError('This purchase has been refunded', 400);
    throw new HttpError('This purchase is already marked shipped', 409);
  }
  // Logged only once the update above actually succeeded, same reasoning as
  // handlePurchaseRefund's own admin-override log: `admin` is only set on
  // the dangling/ownerless-fallback branch above, so an ordinary
  // seller-initiated mark-shipped logs nothing here.
  if (admin) {
    await adminActionLogStatement(db, admin.user_id, 'mark_shipped_override', 'purchase', purchaseId).run();
  }
  // #1288: every other "something happened that the other party should
  // passively learn about" event already fires a notification (dimension
  // changes, auction bids/sales, purchase sale/refund, friend requests,
  // reviews) -- the buyer waiting on a physical purchase was the one
  // missing. buyer_builder_id (not purchase.builder_id, the *hosting*
  // builder clawBackPurchaseCommission notifies for a different reason)
  // can be null (pre-#1112 purchase, or a self-deleted buyer -- ON DELETE
  // SET NULL), so skipped silently rather than erroring, same guard
  // clawBackPurchaseCommission uses for its own nullable builder_id.
  if (purchase.buyer_builder_id) {
    const template = await db.prepare('SELECT name FROM catalog_templates WHERE template_id = ?')
      .bind(purchase.template_id).first();
    await fireNotification(db, purchase.buyer_builder_id,
      `"${template?.name || 'A product'}" has shipped!`);
  }
  const updated = await db.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
  return json({ purchase: purchaseFromRow(updated) });
}

async function handlePurchaseConfirmDelivery(request, env) {
  const db = env.DB;
  await checkRateLimit(db, `confirm-delivery:${clientIp(request)}`, CONFIRM_DELIVERY_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const token = stringValue(input.token, 'token');
  const tokenHash = await sha256Hex(token);
  const purchase = await db.prepare('SELECT purchase_id, template_id, seller_id, delivery_confirmed_at, refunded_at FROM purchases WHERE delivery_confirm_token_hash = ?')
    .bind(tokenHash).first();
  if (!purchase) throw new HttpError('This delivery-confirmation link is invalid.', 400);
  if (purchase.refunded_at) throw new HttpError('This purchase has been refunded.', 400);
  // Idempotent — clicking an already-confirmed link again (a second visit,
  // a bookmark) is a no-op, not an error. #1361: the guard is folded into
  // the UPDATE's own WHERE clause rather than branching on the preceding
  // read, so two concurrent requests with the same token can't both pass a
  // stale check and both fire the notification below — same pattern as
  // handleMarkShipped's own #925 fix just above.
  // #1384: also re-checks refunded_at IS NULL here, not just above -- the
  // eager read a few lines up is a fast-path only, same as #925's own
  // shipped_at read; a concurrent handlePurchaseRefund landing in the
  // window between that read and this write used to still let
  // delivery_confirmed_at get set (releasing the seller's payout hold
  // early and notifying them) on a purchase that was, by the time this
  // actually committed, refunded.
  const result = await db.prepare(
    'UPDATE purchases SET delivery_confirmed_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE purchase_id = ? AND delivery_confirmed_at IS NULL AND refunded_at IS NULL',
  ).bind(purchase.purchase_id).run();
  if (result.meta.changes === 0) {
    // Disambiguates the two reasons this UPDATE could no-op: already
    // confirmed (genuinely idempotent, still returns success below) vs.
    // refunded in the race window just described (not idempotent -- the
    // purchase was never actually confirmed, so this must still error the
    // same way the eager check above would have caught it synchronously).
    const current = await db.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?').bind(purchase.purchase_id).first();
    if (current.refunded_at) throw new HttpError('This purchase has been refunded.', 400);
  }
  if (result.meta.changes > 0) {
    // #1289: per #1043's own convention, every other real "something
    // happened that the other party should passively learn about" event in
    // this file fires a notification — this is also what releases the
    // seller's payout hold early (ahead of the 7-day shipped-at fallback,
    // see docs/API.md's "Seller payout" section), so the seller has a real
    // reason to want to know rather than re-poll for it. A seller-less or
    // dangling seller_id (same guard handleProductReviews' own notification
    // code uses) simply has nobody to notify.
    if (purchase.seller_id && await sellerExists(db, purchase.seller_id)) {
      const template = await db.prepare('SELECT name FROM catalog_templates WHERE template_id = ?')
        .bind(purchase.template_id).first();
      const owner = await db.prepare(`
        SELECT b.builder_id AS builder_id FROM sellers s
        JOIN builders b ON b.user_id = s.user_id
        WHERE s.seller_id = ?
      `).bind(purchase.seller_id).first();
      if (owner) {
        await fireNotification(db, owner.builder_id,
          `"${template?.name || 'A product'}" delivery was confirmed by the buyer.`);
      }
    }
  }
  return json({ confirmed: true });
}

// #871: stable across a genuine client/network retry of the same refund
// (unlike a fresh crypto.randomUUID() per call), so a lost-response retry
// reuses the same Idempotency-Key and Stripe recognizes it as a duplicate
// instead of processing a second real refund. Exported for direct testing,
// since STRIPE_SECRET_KEY is never configured in this test suite.
export function refundIdempotencyKey(purchaseId) {
  return `refund:${purchaseId}`;
}

// #1086: the builder-commission clawback a reversed purchase needs —
// debit the host builder's higgles_balance_cents by the full
// builder_share_cents (allowed to go negative, per the 2026-09-10
// decision #651's own comments reference) and notify them, then revoke
// any avatar ownership that purchase granted. Shared by
// handlePurchaseRefund (this app's own seller/admin-initiated endpoint)
// and handlePurchaseReversalWebhookEvent (a Stripe-initiated chargeback
// or dashboard refund) — the side effect is identical either way; only
// who's authorized to trigger it, and whether the caller also needs to
// reverse the Stripe charge itself, differ.
// Exported so #1122's own regression test can exercise the debit/notify
// split directly, the same way refundIdempotencyKey above is exported for
// its own refund-path test.
export async function clawBackPurchaseCommission(db, purchase, templateName) {
  // builder_id can be null (migrations/0062 — SET NULL on the host
  // builder's account deletion, not CASCADE, so this purchase's own record
  // survives). Nothing to claw a balance back from in that case, and
  // notifications.builder_id is itself NOT NULL, so skip both statements
  // rather than crediting/notifying a builder that no longer exists.
  if (purchase.builder_id) {
    // #1109: part of this sale's commission may have been deferred into
    // an escrowed commission_holds row (worker/lib/commission-caps.js)
    // rather than ever actually credited to higgles_balance_cents at
    // purchase time -- clawing back the full purchase.builder_share_cents
    // unconditionally would pull that never-credited amount out of the
    // balance too, driving it artificially negative. Clawing back only
    // what was actually credited (builder_share_cents minus any still-
    // active hold's own amount_cents), and revoking that hold in the same
    // step so releaseDueCommissionHolds' own cron sweep never later
    // credits a hold whose underlying purchase has since been reversed,
    // keeps this correct whether or not a cap ever applied to this sale.
    // The common case (no hold row at all) behaves exactly as before.
    //
    // #2936: revoke-first, not read-first. A plain pre-read SELECT here
    // (the old shape) can go stale against a concurrent releaseDueCommissionHolds
    // sweep -- if the sweep's own credit+release already committed between
    // this function's read and its debit, the debit below would still
    // only remove the pre-sweep "immediate share," under-clawing back by
    // exactly the amount the sweep just (correctly, on its own) credited.
    // This guarded UPDATE's own WHERE (released_at IS NULL AND revoked_at
    // IS NULL) is the live, atomic answer to "is this hold still mine to
    // exclude from the debit, right now" -- RETURNING hands back the
    // revoked hold's own amount_cents in the same atomic step a separate
    // SELECT-then-UPDATE couldn't guarantee. If a concurrent sweep's own
    // credit already won, this WHERE simply finds no row (0 rows), and
    // activeHoldAmountCents correctly stays 0 -- that hold's money was
    // already credited elsewhere, so none of it should be excluded from
    // this debit either; the full builder_share_cents (minus whatever an
    // earlier partial refund already recovered, below) gets clawed back,
    // correctly reclaiming what the sweep just credited.
    const revokedHold = await db.prepare(`
      UPDATE commission_holds SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE purchase_id = ? AND released_at IS NULL AND revoked_at IS NULL
      RETURNING amount_cents
    `).bind(purchase.purchase_id).first();
    const activeHoldAmountCents = revokedHold?.amount_cents ?? 0;
    const creditedCents = purchase.builder_share_cents - activeHoldAmountCents;
    // #2247: an earlier PARTIAL refund (handlePartialRefundWebhookEvent,
    // worker/lib/stripe.js) may already have proportionally clawed back
    // part of this same commission before this full reversal landed --
    // purchase.refunded_amount_cents is read by this function's caller
    // before THIS reversal's own guarded UPDATE runs, so it still holds
    // whatever cumulative partial-refund total had accumulated up to (but
    // not including) this full reversal. Clawing back the full
    // creditedCents again on top of that would double-count the portion
    // already recovered. `|| 0` covers a hand-built purchase object with
    // no such field (e.g. this file's own notification-fk-race test) the
    // same way its missing total_cents already does.
    const alreadyClawedBackCents = purchase.total_cents > 0
      ? Math.min(creditedCents, Math.round((creditedCents * (purchase.refunded_amount_cents || 0)) / purchase.total_cents))
      : 0;
    const clawbackAmountCents = creditedCents - alreadyClawedBackCents;
    if (clawbackAmountCents > 0) {
      await db.prepare('UPDATE builders SET higgles_balance_cents = higgles_balance_cents - ? WHERE builder_id = ?')
        .bind(clawbackAmountCents, purchase.builder_id).run();
    }
    // #1122: fired separately, after the debit above commits — a self-
    // delete race on purchase.builder_id between this function's caller
    // reading the purchase row and this point would otherwise fail the
    // notification's own FK and roll back the clawback debit along with it.
    await fireNotification(db, purchase.builder_id,
      `"${templateName}" purchase refunded — ${formatCents(clawbackAmountCents)} commission clawed back.`);
  }

  // #754: without this, a refunded avatar purchase left the buyer holding
  // (and able to keep equipped) an item they were just refunded for,
  // forever — nothing else revokes owned_avatars on refund. Looked up by
  // purchase_id (migrations/0085) rather than blindly deleted, so
  // equipped_avatar_template_id is only cleared for the builder who
  // actually held this exact grant (a no-op if the grant predates 0085, or
  // was never made — e.g. the buyer had self-deleted by finalize time).
  //
  // #801: this used to be gated behind `template?.category === 'avatar'`,
  // re-deriving "was this an avatar purchase" from catalog_templates' own
  // *live* category — but category is an ordinary mutable field (PATCH
  // /api/catalog/:id), so a seller changing it away from 'avatar' after the
  // sale silently skipped this whole block, letting the buyer keep the item
  // (and their refund) forever, the exact fraud shape #754 existed to
  // close. The owned_avatar_purchases row keyed by purchase_id is already
  // the correct, purchase-time-locked signal (same reasoning migrations/
  // 0085's own comment gave for owned_avatars.purchase_id) — it only ever
  // exists when the template genuinely was category 'avatar' at purchase
  // time, so checking it directly is both sufficient and immune to a later
  // category edit.
  //
  // #1033: a buyer can legitimately hold more than one unrefunded purchase
  // of the same avatar template (two separately-placed instances, both
  // bought) — owned_avatars' own single nullable purchase_id column only
  // ever tracked the FIRST one, so refunding it used to revoke ownership
  // even while a second, still-valid purchase backed the exact same grant.
  // owned_avatar_purchases (migrations/0094) records one row per granting
  // purchase, so this can now correctly check whether any OTHER unrefunded
  // purchase still exists before revoking — only clearing owned_avatars/
  // equip state once the count actually reaches zero.
  // #1261: the count-check used to be a separate SELECT, read after the
  // purchase_id row's own DELETE but before the owned_avatars DELETE/equip
  // clear below -- a non-atomic gap a concurrent grant of a NEW, unrefunded
  // purchase of the exact same (builder_id, template_id) could land in,
  // between the stale "nothing else backs this" read and the unconditional
  // delete that read justified. Folding the check directly into each
  // statement's own WHERE NOT EXISTS, inside the same db.batch as the
  // purchase_id row's own DELETE, makes the whole decrement-and-maybe-
  // revoke one atomic transaction -- no separate read for another
  // concurrent request's write to land in the middle of.
  const grant = await db.prepare(
    'SELECT builder_id, template_id FROM owned_avatar_purchases WHERE purchase_id = ?',
  ).bind(purchase.purchase_id).first();
  if (grant) {
    await db.batch([
      db.prepare('DELETE FROM owned_avatar_purchases WHERE purchase_id = ?').bind(purchase.purchase_id),
      db.prepare(`
        DELETE FROM owned_avatars WHERE builder_id = ? AND template_id = ?
        AND NOT EXISTS (SELECT 1 FROM owned_avatar_purchases WHERE builder_id = ? AND template_id = ?)
      `).bind(grant.builder_id, grant.template_id, grant.builder_id, grant.template_id),
      db.prepare(`
        UPDATE builders SET equipped_avatar_template_id = NULL
        WHERE builder_id = ? AND equipped_avatar_template_id = ?
        AND NOT EXISTS (SELECT 1 FROM owned_avatar_purchases WHERE builder_id = ? AND template_id = ?)
      `).bind(grant.builder_id, grant.template_id, grant.builder_id, grant.template_id),
    ]);
  }

  // #1163/#1251: same purchase_id-keyed, purchase-time-locked revocation as
  // the owned_avatars block just above, for owned_animations instead —
  // #1164 later added an "equipped" column (builders.equipped_animation_
  // template_id) that this block never got updated to clear, the same gap
  // #754 fixed for avatars.
  // #1261: same atomicity fix as the owned_avatars block above, same reason.
  const animationGrant = await db.prepare(
    'SELECT builder_id, template_id FROM owned_animation_purchases WHERE purchase_id = ?',
  ).bind(purchase.purchase_id).first();
  if (animationGrant) {
    await db.batch([
      db.prepare('DELETE FROM owned_animation_purchases WHERE purchase_id = ?').bind(purchase.purchase_id),
      db.prepare(`
        DELETE FROM owned_animations WHERE builder_id = ? AND template_id = ?
        AND NOT EXISTS (SELECT 1 FROM owned_animation_purchases WHERE builder_id = ? AND template_id = ?)
      `).bind(animationGrant.builder_id, animationGrant.template_id, animationGrant.builder_id, animationGrant.template_id),
      db.prepare(`
        UPDATE builders SET equipped_animation_template_id = NULL
        WHERE builder_id = ? AND equipped_animation_template_id = ?
        AND NOT EXISTS (SELECT 1 FROM owned_animation_purchases WHERE builder_id = ? AND template_id = ?)
      `).bind(animationGrant.builder_id, animationGrant.template_id, animationGrant.builder_id, animationGrant.template_id),
    ]);
  }
}

// The atomic refunded_at guard and (for a real-money purchase) the actual
// Stripe reversal — shared by handlePurchaseRefund (seller/admin-initiated)
// and, as of #2020, the buyer-initiated auto-resolve dispute path below.
// Extracted for the same reason #1086 already extracted
// clawBackPurchaseCommission just above: two independent trigger paths
// performing the identical money-moving step must never be free to drift
// apart from each other. Returns false if a concurrent request (a refund,
// a payout claim, or another dispute) already won the race; the caller is
// responsible for re-reading the row to report why.
async function finalizeRefundReversal(env, purchase) {
  const db = env.DB;
  // The refunded_at read at each caller's own top is a fast-path only — two
  // concurrent reversal requests (a double-click, a client retry, or a
  // buyer's dispute racing a seller's own refund) can both pass it before
  // either write lands. This conditional UPDATE is the actual atomic guard.
  // #1061: also re-checks paid_out_at IS NULL here, not just at each
  // caller's own eager check above — a concurrent claimPurchasesForPayout
  // (POST /sellers/me/payouts) landing in the window would otherwise still
  // let a reversal through, pulling money that's supposed to be backing
  // other, still-unpaid sales.
  const guard = await db.prepare(
    `UPDATE purchases SET refunded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE purchase_id = ? AND refunded_at IS NULL AND paid_out_at IS NULL`,
  ).bind(purchase.purchase_id).run();
  if (guard.meta.changes === 0) return false;

  // #348: a real-money purchase (payment_intent_id set — see #453) needs its
  // Stripe charge actually reversed, not just the local row flagged.
  // reverse_transfer pulls the seller's own share back out of their
  // connected-account balance; refund_application_fee reverses
  // higglehaven's own cut too, proportional to the same capped amount. If
  // Stripe's call fails, the guard above is released (refunded_at reset to
  // NULL) and the error propagates before the builder's higgles balance is
  // ever touched — a failed real-money reversal should never look like a
  // successful refund, and should stay retryable.
  //
  // Owner (Control Room, 2026-09-10, on #651): REFUND_PAYOUT_RATE caps what
  // actually comes back to the buyer at 99% of the original total rather
  // than a full reversal, closing a fraud triangle where cashing out a
  // builder's real commission then refunding the full price nets the
  // cashed-out commission for free — see that constant's own comment. This
  // protection applies identically no matter which path triggered the
  // reversal.
  if (purchase.payment_intent_id) {
    if (!stripeConfigured(env)) {
      await db.prepare('UPDATE purchases SET refunded_at = NULL WHERE purchase_id = ?').bind(purchase.purchase_id).run();
      throw new HttpError('Stripe payments are not configured on this server yet.', 503);
    }
    const refundAmountCents = Math.round(purchase.total_cents * REFUND_PAYOUT_RATE);
    try {
      await stripeRequest(env, 'POST', 'refunds', {
        payment_intent: purchase.payment_intent_id,
        amount: refundAmountCents,
        reverse_transfer: true,
        refund_application_fee: true,
      }, refundIdempotencyKey(purchase.purchase_id));
    } catch (err) {
      await db.prepare('UPDATE purchases SET refunded_at = NULL WHERE purchase_id = ?').bind(purchase.purchase_id).run();
      throw err;
    }
  }
  return true;
}

// Refund + higgles-commission clawback (migrations/0052_purchase_refunds.sql
// — see its own comment for why only higgles_balance_cents is touched, not
// higgles_earnings_events/land cap). Reachable from the Seller modal's own
// "Sales" panel on the product being refunded — a seller-initiated action
// (standing in for a real customer-service-initiated refund, per
// docs/SPEC.md §6's no-personal-support-contact policy), not shopper
// self-service, since shoppers have no account here to authenticate a
// "my purchases" view against in the first place.
async function handlePurchaseRefund(request, env, purchaseId) {
  const db = env.DB;
  const purchase = await db.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
  if (!purchase) return json({ error: 'Purchase not found' }, 404);
  // A purchase's seller_id can genuinely be null — catalog templates don't
  // require a sellerId at creation (an admin/system-owned placeholder
  // item can still be priced and purchased). That's fine for creating one,
  // but a refund actually claws back real higgles from a builder's
  // balance, so it can never fall through to "no owner, no check" the way
  // read-only/creation paths on ownerless resources do elsewhere — it
  // needs admin instead, the same fallback used for the other genuinely
  // ownerless-but-sensitive mutations (see requireAdmin's other callers).
  // sellerExists also catches a *dangling* (non-null but deleted) seller_id
  // the same way — otherwise a refund on a purchase whose seller has since
  // deleted their account would 403 forever, since no live session can
  // ever match an id that no longer exists in `sellers`.
  // Tracked only for the admin-override branch below (undefined on an
  // ordinary seller-initiated refund) — used to write an accountability
  // log entry for this specific override once the refund actually goes
  // through, per #813/#817: refunding on a seller's behalf, with no
  // record of which admin acted, is exactly the kind of sensitive
  // ownerless-fallback mutation that tracking issue exists to close.
  let admin;
  if (purchase.seller_id && await sellerExists(db, purchase.seller_id)) {
    const sessionSeller = await requireSessionSeller(request, db);
    assertOwner(purchase.seller_id, sessionSeller.seller_id, 'Not your product');
    // #1302: same "real outbound Stripe API call on the shared key" gap
    // #948/#1050 already closed for the other Stripe-calling handlers —
    // the refund below fires an unconditional real Stripe `refunds` call,
    // so it needs the identical guard. Same placement precedent: right
    // after the session/identity resolves, ahead of the rest of the
    // function.
    await checkRateLimit(db, `purchase-refund:${sessionSeller.seller_id}`, STRIPE_RATE_LIMIT_MAX);
  } else {
    admin = await requireAdmin(request, db);
    await checkRateLimit(db, `purchase-refund:${admin.user_id}`, STRIPE_RATE_LIMIT_MAX);
  }
  if (purchase.refunded_at) {
    throw new HttpError('This purchase has already been refunded', 409);
  }
  // Found via backlog audit: migrations/0072's own comment establishes
  // paid_out_at as meaning this purchase's seller-share has actually left
  // the platform via a triggered Stripe payout. Stripe's reverse_transfer
  // below debits whatever balance currently sits in the connected
  // account, not funds earmarked to this specific transfer — so refunding
  // a purchase that's already been paid out would silently pull money
  // that's supposed to be backing other, still-unpaid sales in that same
  // balance. Rejecting outright (rather than deciding what should happen
  // next — a separate chargeback? docked from the seller's next payout?)
  // matches this file's existing "guarantee money is never unaccounted
  // for, leave the policy call to a human" approach elsewhere (see
  // writeOrphanedPurchaseRow's own comment).
  if (purchase.paid_out_at) {
    throw new HttpError('This purchase has already been paid out and can no longer be refunded automatically — contact support for manual reconciliation.', 409);
  }
  // Owner (Control Room, 2026-09-10, on #651): a refund must never be
  // blocked just because a builder already redeemed their commission for
  // real cash — "a shopper should not be punished for the chance
  // occurrence of a builder cashing out... higglehaven will have to bear
  // the financial burden of the negative balance." A prior version of
  // this function rejected the refund here the same way paid_out_at does
  // above; removed per that direction — the unconditional clawback below
  // is now allowed to drive higgles_balance_cents negative.
  const template = await db.prepare('SELECT name, category, metadata_json FROM catalog_templates WHERE template_id = ?')
    .bind(purchase.template_id).first();
  if (template && JSON.parse(template.metadata_json || '{}').noReturns) {
    throw new HttpError('This product\'s seller does not accept returns', 400);
  }
  const templateName = template?.name || 'A product';

  // Run alone, not batched with the balance/notification statements below,
  // since D1's db.batch doesn't support skipping later statements based on
  // an earlier one's row count within the same call. Whichever request's
  // UPDATE loses the race (see finalizeRefundReversal's own comment on the
  // guard it runs) affects 0 rows and gets rejected here before it can
  // touch the builder's balance at all.
  if (!(await finalizeRefundReversal(env, purchase))) {
    const current = await db.prepare('SELECT refunded_at, paid_out_at FROM purchases WHERE purchase_id = ?')
      .bind(purchaseId).first();
    if (current?.paid_out_at) {
      throw new HttpError('This purchase has already been paid out and can no longer be refunded automatically — contact support for manual reconciliation.', 409);
    }
    throw new HttpError('This purchase has already been refunded', 409);
  }

  // #1086: the balance clawback, notification, and avatar-ownership
  // revocation below are identical regardless of which side initiated the
  // reversal (this endpoint, a bank chargeback, or a Stripe-dashboard
  // refund) — extracted into clawBackPurchaseCommission so the webhook
  // path handling the latter two can reuse the exact same logic rather
  // than drifting out of sync with it over time.
  await clawBackPurchaseCommission(db, purchase, templateName);

  // Logged last, only once every step above (including the real Stripe
  // reversal) has actually completed — not batched with any of them, since
  // several are conditional or already have their own atomicity concerns
  // (see the refunded_at guard's own comment above) and a log entry for a
  // refund that didn't actually complete would misattribute it to this
  // admin. `admin` is only set on the ownerless-fallback branch above; an
  // ordinary seller-initiated refund logs nothing here.
  if (admin) {
    await adminActionLogStatement(db, admin.user_id, 'refund_override', 'purchase', purchaseId, { templateName }).run();
  }

  const row = await db.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
  return json({ purchase: purchaseFromRow(row) });
}

// #2020 (sub-issue of #1212, owner-settled shape 2026-10-13, SPEC.md §5's
// "Low-value disputes from established accounts: auto-resolved in buyer's
// favor" bullet): unlike handlePurchaseRefund above (seller/admin-
// initiated), this is the buyer's own self-service path — there was no
// buyer-facing dispute/refund-request endpoint anywhere before this (see
// that handler's own comment on why refunding has always been seller/
// admin-only). Eligibility is derived entirely from this schema's existing
// signals, since builders carry no strike/flag column of their own (unlike
// sellers.strike_count, migrations/0131): "established" = at least one
// OTHER completed (non-refunded) purchase and zero refunded/disputed ones
// of this buyer's own. Anything that fails either test, or the dollar
// threshold, falls through to today's unchanged (i.e. no automated) path —
// this never fabricates a "pending review" state nothing else in this app
// reads, it only ever actually moves money when the owner's own
// auto-resolve conditions are met.
async function handlePurchaseDispute(request, env, purchaseId) {
  const db = env.DB;
  const sessionBuilder = await requireSessionBuilder(request, db);
  await checkRateLimit(db, `purchase-dispute:${sessionBuilder.builder_id}`, DISPUTE_RATE_LIMIT_MAX);
  const purchase = await db.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
  if (!purchase) throw new HttpError('Purchase not found', 404);
  // Same buyer-ownership gate handleSellerFeedbackCreate uses (#1123) — a
  // dispute is the buyer's own standing to raise, not the seller's, the
  // hosting builder's, or an onlooker's.
  if (purchase.buyer_builder_id !== sessionBuilder.builder_id) {
    throw new HttpError('Only the buyer of this purchase can dispute it', 400);
  }
  if (purchase.refunded_at) {
    throw new HttpError('This purchase has already been refunded', 409);
  }
  if (purchase.paid_out_at) {
    throw new HttpError('This purchase has already been paid out and can no longer be refunded automatically — contact support for manual reconciliation.', 409);
  }

  const history = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM purchases WHERE buyer_builder_id = ? AND purchase_id != ? AND refunded_at IS NULL) AS completedCount,
      (SELECT COUNT(*) FROM purchases WHERE buyer_builder_id = ? AND refunded_at IS NOT NULL) AS refundedCount
  `).bind(sessionBuilder.builder_id, purchaseId, sessionBuilder.builder_id).first();
  const established = history.completedCount > 0 && history.refundedCount === 0;
  const lowValue = purchase.total_cents <= DISPUTE_AUTO_RESOLVE_THRESHOLD_CENTS;
  if (!established || !lowValue) {
    return json({ autoResolved: false, purchase: purchaseFromRow(purchase) });
  }

  const template = await db.prepare('SELECT name, metadata_json FROM catalog_templates WHERE template_id = ?')
    .bind(purchase.template_id).first();
  // #2020 only auto-resolves "in the buyer's favor" — a seller's own
  // no-returns policy (the same guard handlePurchaseRefund enforces above)
  // still applies; this isn't a bypass of that choice, just a faster path
  // to the same outcome a seller-initiated refund would reach anyway.
  if (template && JSON.parse(template.metadata_json || '{}').noReturns) {
    return json({ autoResolved: false, purchase: purchaseFromRow(purchase) });
  }
  const templateName = template?.name || 'A product';

  // #2224: the refundedCount read above is a plain SELECT taken at the top
  // of each independent call -- two concurrent disputes for different
  // purchases from the same buyer can both observe refundedCount === 0
  // before either's refund actually commits, so both pass `established`
  // and both would otherwise reach finalizeRefundReversal. This claim is
  // the real atomic guard, the same "claim first, release on failure"
  // idiom reserveDiditSession/reserveVideoGenerationJob already use for
  // their own per-builder one-at-a-time locks (migrations/0095,
  // worker/index.js's INSERT ... WHERE NOT EXISTS above) -- only the
  // request that wins this INSERT may proceed, and the loser falls
  // through exactly like today's unestablished/high-value path. Never
  // deleted on success: it becomes the permanent "this buyer has already
  // used their one-time auto-resolve pass" record, closing the race
  // without relying on purchases.refunded_at having committed yet.
  const claimed = await db.prepare(`
    INSERT INTO dispute_auto_resolve_claims (builder_id, purchase_id)
    SELECT ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM dispute_auto_resolve_claims WHERE builder_id = ?
    )
  `).bind(sessionBuilder.builder_id, purchaseId, sessionBuilder.builder_id).run();
  if (claimed.meta.changes === 0) {
    return json({ autoResolved: false, purchase: purchaseFromRow(purchase) });
  }

  let refundSucceeded;
  try {
    refundSucceeded = await finalizeRefundReversal(env, purchase);
  } catch (err) {
    // The claim above only reserves this buyer's one-time pass for this
    // attempt -- if finalizeRefundReversal never actually moved any money
    // (Stripe misconfigured, the outbound refund call itself failed), the
    // pass must not be permanently burned for nothing.
    await db.prepare('DELETE FROM dispute_auto_resolve_claims WHERE builder_id = ?').bind(sessionBuilder.builder_id).run();
    throw err;
  }
  if (!refundSucceeded) {
    await db.prepare('DELETE FROM dispute_auto_resolve_claims WHERE builder_id = ?').bind(sessionBuilder.builder_id).run();
    const current = await db.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    return json({ autoResolved: false, purchase: purchaseFromRow(current) });
  }
  await clawBackPurchaseCommission(db, purchase, templateName);
  // null adminUserId, same convention adminActionLogStatement's own video-
  // generation-sweep caller uses for a system/automated action with no
  // human admin in the loop — this is exactly that: nobody reviewed it.
  await adminActionLogStatement(db, null, 'dispute_auto_resolved', 'purchase', purchaseId, { templateName, totalCents: purchase.total_cents }).run();

  const row = await db.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
  return json({ autoResolved: true, purchase: purchaseFromRow(row) });
}
