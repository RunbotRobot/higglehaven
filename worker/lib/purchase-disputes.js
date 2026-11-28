// #4648 (Disputes 1/3): the record of a Stripe dispute on a purchase. Written from the reversal webhook events the
// Worker already receives (charge.dispute.funds_withdrawn opens it, funds_reinstated marks it won); data.object is
// Stripe's Dispute. This moves no money and sends nothing to anyone: the clawback and its reversal are the purchase's
// own columns, handled by the code around the call. A failed write here is logged and never stops that code.
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
