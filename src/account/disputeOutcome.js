// "Report a problem" on a My Purchases row (#3199): plain-language outcomes
// of POST /api/purchases/:id/dispute. Kept free of DOM and fetch so the copy
// can be unit tested. The copy says what the buyer will see next and never
// the internal rule that decided it (who counts as "established", the dollar
// threshold, a seller's return policy).
export const DISPUTE_PROMPT_TEXT = 'Report a problem with this order?';

export function disputeSuccessText(result) {
  if (result?.autoResolved) return 'Your refund has been issued.';
  // The endpoint leaves the order untouched in this case and nothing else in
  // the app acts on it yet, so do not promise a review that does not exist.
  return "This order can't be refunded automatically. Please contact the seller or support about it.";
}

export function disputeErrorText(err) {
  if (err?.status === 409) return 'This order has already been paid out to the seller, so please contact support.';
  return err?.message || "Couldn't report this problem. Please try again in a moment.";
}

// The row visibly becomes "Refunded" afterwards (No silent loss: money coming
// back to the buyer must show). Prefer the server's own timestamps from the
// returned purchase; fall back to "now" if a field is missing.
export function purchaseAfterDispute(purchase, result) {
  if (!result?.autoResolved) {
    // The buyer has just been told to contact the seller or support; offering
    // the same button again would only repeat that answer.
    return { ...purchase, canDispute: false };
  }
  const serverPurchase = result.purchase || {};
  return {
    ...purchase,
    refundedAt: serverPurchase.refundedAt || new Date().toISOString(),
    refundedAmountCents: serverPurchase.refundedAmountCents ?? purchase.totalCents,
    canDispute: false,
    canLeaveFeedback: false,
  };
}
