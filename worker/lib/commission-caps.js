// #1109 (owner decision, 2026-10-27): velocity-based limits on commission
// cash outs, to close the chargeback fraud gap a plain refund's own
// REFUND_PAYOUT_RATE haircut (migrations/0052) can't reach -- see
// migrations/0160_commission_holds.sql's own comment for the full
// mechanism (credit-time cap-and-escrow).
//
// Two cap shapes, chosen by the SELLING builder's own established-or-not
// status (not the buyer's):
// - Established (>= MIN_ESTABLISHED_COUNTERPARTIES distinct counterparties
//   with a non-refunded sale): a PER-SALE cap, ESTABLISHED_CAP_MULTIPLIER
//   times that builder's own historical average commission per distinct
//   counterparty -- averaging each counterparty's own average first (not
//   a flat average over every row) is what stops one counterparty's
//   repeat purchases from padding the figure, per the owner's own
//   anti-padding design.
// - New/unestablished: a CUMULATIVE cap, NEW_BUILDER_FLAT_CAP_CENTS total
//   commission ever credited from any one counterparty, matching the
//   original issue's own "cap total commission aggregated from any single
//   buyer at a flat 20 dollars" wording.
//
// Exact numbers below were explicitly delegated to engineering judgment
// by the owner ("I trust the fleet's judgment better than mine") --
// reasoning for each is in PR #1109's own description, not repeated here
// as a wall of comment text.
export const MIN_ESTABLISHED_COUNTERPARTIES = 5;
export const NEW_BUILDER_FLAT_CAP_CENTS = 2000; // $20
export const ESTABLISHED_CAP_MULTIPLIER = 5;
export const COMMISSION_HOLD_DURATION_DAYS = 14; // 2 weeks

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The counterparty key both cap paths group by: a real buyer_builder_id
// (#1112) when the buyer still has a live account, falling back to the
// free-text buyer_label otherwise (an unauthenticated/self-deleted buyer,
// or a pre-#1112 row) -- same COALESCE the owner's own proposal comment
// on #1109 specified.
export function counterpartyKeyFor(buyerBuilderId, buyerLabel) {
  return buyerBuilderId || buyerLabel;
}

// How much of *this* sale's commission can be credited to the seller
// right now -- the caller does `creditNowCents = Math.min(builderShareCents,
// remainingCapCents)` regardless of which path below produced the number,
// so both paths return "remaining headroom for this sale," not the raw
// cap itself, even though the established path's own cap is a per-sale
// limit (so "headroom" and "the cap" are the same number there) while the
// new-builder path's cap is cumulative across every past sale to this
// counterparty (so "headroom" is the cap minus what's already been
// credited from them, which can be less than the flat cap or, once
// exhausted, zero).
export async function remainingCommissionCapCents(db, { builderId, counterpartyKey }) {
  const { results: counterpartyAverages } = await db.prepare(`
    SELECT COALESCE(buyer_builder_id, buyer_label) AS counterparty, AVG(builder_share_cents) AS avg_share_cents
    FROM purchases
    WHERE builder_id = ? AND refunded_at IS NULL AND COALESCE(buyer_builder_id, buyer_label) IS NOT NULL
    GROUP BY counterparty
  `).bind(builderId).all();

  if (counterpartyAverages.length >= MIN_ESTABLISHED_COUNTERPARTIES) {
    const overallAverage = counterpartyAverages.reduce((sum, row) => sum + row.avg_share_cents, 0) / counterpartyAverages.length;
    return Math.round(ESTABLISHED_CAP_MULTIPLIER * overallAverage);
  }

  const alreadyCredited = await db.prepare(`
    SELECT COALESCE(SUM(builder_share_cents), 0) AS total FROM purchases
    WHERE builder_id = ? AND refunded_at IS NULL AND COALESCE(buyer_builder_id, buyer_label) = ?
  `).bind(builderId, counterpartyKey).first();
  return Math.max(0, NEW_BUILDER_FLAT_CAP_CENTS - alreadyCredited.total);
}

// Builds the commission_holds insert statement for the portion of a
// sale's commission this cap defers rather than credits immediately --
// same `${prefix}-${crypto.randomUUID()}` id convention as every other
// generated id in this codebase (earnings-/purchase-/hold- all follow the
// same shape).
export function commissionHoldInsertStatement(db, { purchaseId, builderId, amountCents }) {
  const holdId = `hold-${crypto.randomUUID()}`;
  const releaseAt = new Date(Date.now() + COMMISSION_HOLD_DURATION_DAYS * MS_PER_DAY).toISOString();
  return db.prepare(`
    INSERT INTO commission_holds (hold_id, purchase_id, builder_id, amount_cents, release_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(holdId, purchaseId, builderId, amountCents, releaseAt);
}

// #1109's own release trigger for an escrowed commission -- wired into
// worker/index.js's scheduled() the same way every other cron sweep there
// is. Per-hold error isolation mirrors resolveDueAuctions' own (worker/
// index.js) -- a single poisoned row must never block every other
// builder's own due release behind it.
export async function releaseDueCommissionHolds(db) {
  const { results } = await db.prepare(`
    SELECT * FROM commission_holds
    WHERE release_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND released_at IS NULL AND revoked_at IS NULL
  `).all();
  for (const hold of results) {
    try {
      await releaseOrRevokeHold(db, hold);
    } catch (err) {
      console.error('releaseDueCommissionHolds: failed to resolve', hold.hold_id, err);
    }
  }
}

async function releaseOrRevokeHold(db, hold) {
  // Defensive re-check: clawBackPurchaseCommission (worker/lib/purchase-
  // lifecycle.js) already revokes a hold the moment its underlying
  // purchase is refunded/charged-back, so this should already be excluded
  // by the sweep's own `revoked_at IS NULL` filter above by the time this
  // runs -- but re-checking the purchase itself, not just trusting this
  // hold row's own already-read revoked_at, closes any ordering/race gap
  // between that revoke and this sweep picking the row up first.
  const purchase = await db.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?').bind(hold.purchase_id).first();
  if (purchase?.refunded_at) {
    await db.prepare('UPDATE commission_holds SET revoked_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE hold_id = ? AND released_at IS NULL AND revoked_at IS NULL')
      .bind(hold.hold_id).run();
    return;
  }
  await db.batch([
    db.prepare('UPDATE builders SET higgles_balance_cents = higgles_balance_cents + ? WHERE builder_id = ?')
      .bind(hold.amount_cents, hold.builder_id),
    db.prepare('INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)')
      .bind(`earnings-${crypto.randomUUID()}`, hold.builder_id, hold.amount_cents),
    db.prepare('UPDATE commission_holds SET released_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE hold_id = ? AND released_at IS NULL AND revoked_at IS NULL')
      .bind(hold.hold_id),
  ]);
}
