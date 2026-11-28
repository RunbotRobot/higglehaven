// #4650 (Disputes 2/3, part of #4648): the evidence that answers a card dispute, built from the order's own record and
// sent to Stripe once before the due date. It moves no money; it speaks to the card network for the seller. Nothing
// beyond what the order already holds for this purpose is used (the order's copy of the address, carrier, tracking
// number, shipped date, delivery confirmation, the product's recorded name). A failure to reach Stripe is written on
// the dispute row and tried again on the next cron run until the due date; it is never silent and never stops anything.
import { shippingAddressFromRow } from './shipping-address.js';

const TEXT_MAX = 400;

const clip = (value, max = TEXT_MAX) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const dateOnly = (iso) => (typeof iso === 'string' && iso.length >= 10 && !Number.isNaN(Date.parse(iso)) ? iso.slice(0, 10) : null);

function addressText(address) {
  if (!address) return null;
  const place = [address.city, [address.region, address.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return clip([address.name, address.line1, address.line2, place, address.country].filter(Boolean).join(', '));
}

// The Stripe `evidence` fields for one order (a purchases row). Pure: fields with nothing behind them are left out.
export function buildDisputeEvidence(order) {
  const evidence = {};
  const product = clip(order.product_name, 200);
  if (product) {
    evidence.product_description = order.is_digital_good
      ? `${product} (a digital good, added to the buyer's account when it was bought)`
      : product;
  }
  const notes = [];
  if (order.created_at) notes.push(`Bought on ${dateOnly(order.created_at) ?? order.created_at}.`);
  if (order.is_digital_good) {
    notes.push('The buyer owns this item on their account and can use it there.');
  } else {
    const address = addressText(shippingAddressFromRow(order.shipping_address_json));
    if (address) evidence.shipping_address = address;
    const carrier = clip(order.shipping_carrier, 80);
    if (carrier) evidence.shipping_carrier = carrier;
    const tracking = clip(order.tracking_number, 80);
    if (tracking) evidence.shipping_tracking_number = tracking;
    const shipped = dateOnly(order.shipped_at);
    if (shipped) evidence.shipping_date = shipped;
    const delivered = dateOnly(order.delivery_confirmed_at);
    if (delivered) notes.push(`The buyer confirmed delivery on ${delivered}.`);
  }
  if (notes.length) evidence.uncategorized_text = notes.join(' ');
  return evidence;
}

const BATCH = 10;

// One cron pass. For each open dispute with no evidence sent and a due date still ahead: claim it (so two runs never
// send twice), send the evidence with submit true, and record the outcome. A failed send releases the claim and is
// recorded in evidence_error for the next run; a dispute past its due date is marked so and left alone.
export async function submitDueDisputeEvidence(env, db, { stripeRequest, nowMs = Date.now() }) {
  const { results } = await db.prepare(
    `SELECT d.dispute_id, d.evidence_due_by, p.*
       FROM purchase_disputes d JOIN purchases p ON p.purchase_id = d.purchase_id
      WHERE d.outcome = 'open' AND d.evidence_submitted_at IS NULL AND d.evidence_due_by IS NOT NULL
        AND (d.evidence_error IS NULL OR d.evidence_error NOT LIKE 'due date passed%')
      LIMIT ?`,
  ).bind(BATCH).all();
  let sent = 0;
  for (const row of results) {
    if (Date.parse(row.evidence_due_by) <= nowMs) {
      await db.prepare(`UPDATE purchase_disputes SET evidence_error = 'due date passed before the evidence was sent' WHERE dispute_id = ?`)
        .bind(row.dispute_id).run();
      continue;
    }
    const claimed = await db.prepare(
      `UPDATE purchase_disputes SET evidence_submitted_at = ?, evidence_error = NULL WHERE dispute_id = ? AND evidence_submitted_at IS NULL`,
    ).bind(new Date(nowMs).toISOString(), row.dispute_id).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      await stripeRequest(env, 'POST', `disputes/${encodeURIComponent(row.dispute_id)}`,
        { evidence: buildDisputeEvidence(row), submit: 'true' });
      sent += 1;
    } catch (err) {
      const message = String(err?.message || err).slice(0, 200);
      // A send whose reply was lost has already reached Stripe: its refusal of a second submit means it is done.
      if (/already|submitted/i.test(message)) { sent += 1; continue; }
      await db.prepare(`UPDATE purchase_disputes SET evidence_submitted_at = NULL, evidence_error = ? WHERE dispute_id = ?`)
        .bind(message, row.dispute_id).run();
      console.error('Could not send dispute evidence (tried again next run):', row.dispute_id, message);
    }
  }
  return sent;
}
