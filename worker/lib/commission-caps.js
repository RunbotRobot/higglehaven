// #1109 (owner decision, 2026-10-27): velocity-based limits on commission
// cash outs, to close the chargeback fraud gap a plain refund's own
// REFUND_PAYOUT_RATE haircut (migrations/0052) can't reach -- see
// migrations/0164_commission_holds.sql's own comment for the full
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

// #2879: used to be one function (remainingCommissionCapCents) that read
// the new-builder cumulative total with a plain pre-batch SELECT, handed
// the resulting number back to the caller to apply later in its own
// batch -- a classic TOCTOU (worker/lib/purchase-creation.js's purchase
// INSERT, the write that number ends up gating, happens strictly later).
// Two near-simultaneous sales from the same counterparty could each read
// "$0 already credited," each independently credit their own full share,
// and jointly blow past NEW_BUILDER_FLAT_CAP_CENTS -- found via a
// backlog-exploration pass, no concurrency test existed to catch it.
//
// Split in two: this half (the established-builder per-sale cap) has no
// concurrency problem of its own and stays a plain pre-read -- it's a
// flat per-sale limit derived from historical averages, so two concurrent
// sales each independently satisfy it regardless of each other, never
// accumulating against one another the way the cumulative cap does. Only
// the new-builder cumulative path's actual credit application needed to
// move into commissionCreditClaimStatement's atomic write, below -- see
// that function's own comment for the mechanics.
export async function commissionCapPlanFor(db, { builderId }) {
  const { results: counterpartyAverages } = await db.prepare(`
    SELECT COALESCE(buyer_builder_id, buyer_label) AS counterparty, AVG(builder_share_cents) AS avg_share_cents
    FROM purchases
    WHERE builder_id = ? AND refunded_at IS NULL AND COALESCE(buyer_builder_id, buyer_label) IS NOT NULL
    GROUP BY counterparty
  `).bind(builderId).all();

  if (counterpartyAverages.length >= MIN_ESTABLISHED_COUNTERPARTIES) {
    const overallAverage = counterpartyAverages.reduce((sum, row) => sum + row.avg_share_cents, 0) / counterpartyAverages.length;
    return { established: true, capCents: Math.round(ESTABLISHED_CAP_MULTIPLIER * overallAverage) };
  }
  return { established: false };
}

// #2879: the new-builder cumulative cap's credit decision, made and
// applied atomically in one statement instead of a separate pre-read --
// the same "fold the check into the write's own guarded WHERE/subquery,
// evaluated live instead of trusting an earlier read" idiom worker/lib/
// land.js's claim UPDATE, auctions.js's bid INSERT, and world-generation.js's
// settings UPDATE already use elsewhere in this codebase.
//
// Must be pushed into the SAME db.batch() as this sale's own purchase row
// INSERT, and ordered strictly after it -- the subquery below sums
// `purchases.builder_share_cents` (the same "every non-refunded sale's
// full share counts against future cap headroom, whether actually
// credited or still escrowed" semantics the old pre-read used) for every
// OTHER non-refunded purchase from this counterparty (purchase_id != ?
// excludes this sale's own just-inserted row), evaluated fresh at the
// instant this UPDATE actually executes -- never a value read before the
// transaction started. Two concurrent sales' claims are then strictly
// ordered relative to each other (each sees whichever purchase rows had
// already committed first), which is what keeps their combined credited
// total from ever exceeding the cap: see issue #2879 for the inductive
// argument.
//
// amountExpr appears twice (SET and RETURNING) since SQLite has no
// per-statement variable to compute it once and reuse across clauses --
// it's a pure function of already-committed rows as of this statement's
// own execution, so evaluating it twice within the one statement can't
// introduce any staleness between the two.
//
// RETURNING credited_cents is how the caller learns the actual split
// (credited now vs. escrowed) without a second read: worker/index.js's
// own RETURNING-based writes (e.g. the landlet-release UPDATE in
// builderDeletionStatements) are the precedent for reading a write's own
// effect straight off its result instead of a follow-up SELECT.
export function commissionCreditClaimStatement(db, { purchaseId, builderId, counterpartyKey, builderShareCents }) {
  const amountExpr = `
    MAX(0, MIN(?, ? - COALESCE((
      SELECT SUM(builder_share_cents) FROM purchases
      WHERE builder_id = ? AND refunded_at IS NULL AND purchase_id != ?
        AND COALESCE(buyer_builder_id, buyer_label) = ?
    ), 0)))
  `;
  const amountArgs = [builderShareCents, NEW_BUILDER_FLAT_CAP_CENTS, builderId, purchaseId, counterpartyKey];
  return db.prepare(`
    UPDATE builders
    SET higgles_balance_cents = higgles_balance_cents + ${amountExpr}
    WHERE builder_id = ?
    RETURNING ${amountExpr} AS credited_cents
  `).bind(...amountArgs, builderId, ...amountArgs);
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
  // #2880: builder_id can now be null (migrations/0165 switched its own FK
  // from CASCADE to SET NULL) if the builder self-deleted while this hold
  // was still outstanding. Crediting a null builder_id would violate
  // higgles_earnings_events.builder_id's own NOT NULL constraint and fail
  // this whole batch -- not destructive (the hold row survives, this
  // function is just retried every sweep), but also never actually
  // resolves it, so it'd log a swallowed error forever. What should
  // actually happen to a null-builder hold's money on release is a real
  // policy decision, not made here (see #2880) -- leaving it untouched
  // (neither released nor revoked) keeps it queryable/visible pending
  // that decision instead of guessing at it.
  if (hold.builder_id === null) return;
  await db.batch([
    db.prepare('UPDATE builders SET higgles_balance_cents = higgles_balance_cents + ? WHERE builder_id = ?')
      .bind(hold.amount_cents, hold.builder_id),
    db.prepare('INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)')
      .bind(`earnings-${crypto.randomUUID()}`, hold.builder_id, hold.amount_cents),
    db.prepare('UPDATE commission_holds SET released_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE hold_id = ? AND released_at IS NULL AND revoked_at IS NULL')
      .bind(hold.hold_id),
  ]);
}
