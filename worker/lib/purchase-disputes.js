// #4648 (Disputes 1/3): the record of a Stripe dispute on a purchase. Written from the reversal webhook events the
// Worker already receives (charge.dispute.funds_withdrawn opens it, funds_reinstated marks it won); data.object is
// Stripe's Dispute. This moves no money and sends nothing to anyone: the clawback and its reversal are the purchase's
// own columns, handled by the code around the call. A failed write here is logged and never stops that code.
import { json } from './http.js';
import { requireAdmin } from './auth.js';

const OPEN = 'open';
const WON = 'won';

function isoFromUnixSeconds(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function textOrNull(value, max = 80) {
  return typeof value === 'string' && value ? value.slice(0, max) : null;
}

// The row for one dispute event, or null when the event does not name a dispute.
export function disputeRowFromEvent(event) {
  const object = event?.data?.object;
  if (!object || typeof object.id !== 'string' || !object.id) return null;
  const won = event.type === 'charge.dispute.funds_reinstated';
  return {
    disputeId: object.id,
    reason: textOrNull(object.reason),
    amountCents: Number.isInteger(object.amount) ? object.amount : null,
    status: textOrNull(object.status),
    evidenceDueBy: isoFromUnixSeconds(object.evidence_details?.due_by),
    outcome: won ? WON : OPEN,
    lastEventAt: Number.isFinite(event.created) ? event.created : null,
  };
}

// One statement: a new dispute is inserted; a known one is updated only by an event no older than the one it holds.
// A won dispute is never reopened by a stale withdrawal (the caller already drops those, this is the second guard).
export async function recordDisputeEvent(db, purchase, event) {
  const row = disputeRowFromEvent(event);
  if (!row) return;
  try {
    await db.prepare(`
      INSERT INTO purchase_disputes (dispute_id, purchase_id, reason, amount_cents, status, evidence_due_by, outcome, last_event_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (dispute_id) DO UPDATE SET
        reason = COALESCE(excluded.reason, purchase_disputes.reason),
        amount_cents = COALESCE(excluded.amount_cents, purchase_disputes.amount_cents),
        status = COALESCE(excluded.status, purchase_disputes.status),
        evidence_due_by = COALESCE(excluded.evidence_due_by, purchase_disputes.evidence_due_by),
        outcome = excluded.outcome,
        last_event_at = excluded.last_event_at
      WHERE purchase_disputes.last_event_at IS NULL OR excluded.last_event_at IS NULL
        OR purchase_disputes.last_event_at <= excluded.last_event_at
    `).bind(row.disputeId, purchase.purchase_id, row.reason, row.amountCents, row.status, row.evidenceDueBy, row.outcome, row.lastEventAt).run();
  } catch (err) {
    console.error('Could not record a dispute (the purchase was handled regardless):', err);
  }
}

// #4651 (Disputes 3/3): what the seller sees of a dispute on one of their orders. The seller reads the reason (in words),
// the amount, when Stripe stops taking evidence, whether any went, and how it stands; nothing internal (no error text).
export function disputeFromRow(row) {
  return {
    disputeId: row.dispute_id,
    reason: row.reason ?? null,
    amountCents: row.amount_cents ?? null,
    evidenceDueBy: row.evidence_due_by ?? null,
    outcome: row.outcome,
    evidenceSent: !!row.evidence_submitted_at,
    openedAt: row.opened_at,
  };
}

// The newest dispute of each of these purchases, as a Map keyed by purchase id (a purchase can go through more than one
// cycle; the latest is the one that matters). Chunked under D1's bound-parameter limit.
export async function latestDisputesByPurchase(db, purchaseIds) {
  const latest = new Map();
  const ids = [...new Set(purchaseIds)];
  for (let at = 0; at < ids.length; at += 90) {
    const chunk = ids.slice(at, at + 90);
    const { results } = await db.prepare(
      `SELECT * FROM purchase_disputes WHERE purchase_id IN (${chunk.map(() => '?').join(',')}) ORDER BY opened_at ASC, dispute_id ASC`,
    ).bind(...chunk).all();
    for (const row of results) latest.set(row.purchase_id, disputeFromRow(row));
  }
  return latest;
}

// #4651: the admin dashboard's list of disputes, open ones first and the soonest due date first. Full admin only: an
// order's seller, product and evidence are closed to a look-only admin like every other order read (worker/admin-viewer
// test). Built for today's size, as the owner's tools are: the newest 200, and totalCount says when there are more; past
// that this needs paging (#4060's rule). evidenceError is shown here and never to the seller.
export const ADMIN_DISPUTES_LIMIT = 200;

export async function handleAdminPurchaseDisputes(request, db) {
  await requireAdmin(request, db);
  const { results } = await db.prepare(`
    SELECT d.*, p.product_name, p.seller_name, p.shipped_at, p.tracking_number, p.is_digital_good
    FROM purchase_disputes d LEFT JOIN purchases p ON p.purchase_id = d.purchase_id
    ORDER BY (d.outcome = 'open') DESC, d.evidence_due_by IS NULL, d.evidence_due_by ASC, d.opened_at DESC
    LIMIT ?
  `).bind(ADMIN_DISPUTES_LIMIT).all();
  const total = await db.prepare('SELECT COUNT(*) AS count FROM purchase_disputes').first();
  return json({
    disputes: results.map((row) => ({
      ...disputeFromRow(row),
      purchaseId: row.purchase_id,
      productName: row.product_name ?? null,
      sellerName: row.seller_name ?? null,
      status: row.status ?? null,
      evidenceError: row.evidence_error ?? null,
      shipped: !!row.shipped_at,
      hasTracking: !!row.tracking_number,
      isDigitalGood: !!row.is_digital_good,
    })),
    totalCount: total.count,
    limit: ADMIN_DISPUTES_LIMIT,
  });
}
