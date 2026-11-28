// #4651 (Disputes 3/3, part of #4648): what a seller reads on an order the buyer's bank has disputed. The reason in plain
// words, when the bank stops taking evidence, whether any was sent, and how it stands. Pure, so it is tested without a
// page; the sale row (src/sell/saleRow.js) draws the sentence as selectable text. Nothing here is Stripe's own wording.
const REASON_WORDS = {
  product_not_received: "the buyer's bank says the item was not received",
  fraudulent: "the buyer's bank says the card was used without permission",
  unrecognized: 'the buyer does not recognise the charge',
  duplicate: "the buyer's bank says they were charged twice",
  product_unacceptable: 'the buyer says the item was not as described',
  credit_not_processed: 'the buyer says a refund they expected did not arrive',
};
const GENERAL = "the buyer's bank opened a dispute";

export function disputeReasonWords(reason) {
  return REASON_WORDS[reason] || GENERAL;
}

function dueDateText(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// `now` is a Date (a parameter so a test can fix it). `canAddTracking`: the order is a physical one with no tracking
// number yet, so the seller is pointed at the box that already exists on the row.
export function disputeSentence(dispute, { now = new Date(), canAddTracking = false } = {}) {
  if (!dispute) return '';
  const lead = `Disputed: ${disputeReasonWords(dispute.reason)}.`;
  if (dispute.outcome === 'won') return `${lead} Won: the money counts toward your earnings again.`;
  const parts = [lead];
  const due = dueDateText(dispute.evidenceDueBy);
  const overdue = due && new Date(dispute.evidenceDueBy).getTime() < now.getTime();
  if (dispute.evidenceSent) parts.push('Evidence was sent.');
  else if (overdue) parts.push('The evidence period is over; the bank decides.');
  else if (due) parts.push(`Evidence is due ${due}.`);
  if (!dispute.evidenceSent && !overdue && canAddTracking) parts.push('Add the carrier and tracking number below if you have them.');
  return parts.join(' ');
}
