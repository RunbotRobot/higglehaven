// "Report a problem" on a My purchases row (#3199): plain-language outcomes
// of POST /api/purchases/:id/dispute. Kept free of DOM and fetch so the copy
// can be unit tested. The copy says what the buyer will see next and never
// the internal rule that decided it (who counts as "established", the dollar
// threshold, a seller's return policy).
export const DISPUTE_PROMPT_TEXT = 'Report a problem with this order?';

// #4573 (the buying walk): "Yes, report it" can refund the order on the spot, which for a digital good also takes it
// out of what the buyer owns and wears. The confirmation used to say only "Report a problem with this order?", so a
// person with a small complaint could press it and lose the item without having been told that was possible. It now
// says what may happen, never the rule that decides it (who counts as established, the dollar threshold).
// A digital purchase: the seller marked it a digital good, or it is an avatar or an animation (those are granted to the
// buyer's owned list, with nothing to ship). The disclaimer flag alone missed every avatar.
export function isDigitalPurchase(purchase) {
  return !!purchase?.isDigitalGood || purchase?.productKind === 'avatar' || purchase?.productKind === 'animation';
}

export function disputePromptText(purchase) {
  return isDigitalPurchase(purchase)
    ? `${DISPUTE_PROMPT_TEXT} If it can be refunded right away, you'll get your money back and the item leaves what you own.`
    : `${DISPUTE_PROMPT_TEXT} If it can be refunded right away, you'll get your money back.`;
}

export function disputeSuccessText(result) {
  if (result?.autoResolved) return 'Your refund has been issued.';
  // The endpoint leaves the order untouched in this case and nothing else in
  // the app acts on it yet, so do not promise a review that does not exist.
  return "This order can't be refunded automatically. Contact the seller or support about it.";
}

export function disputeErrorText(err) {
  if (err?.status === 409) return 'This order has already been paid out to the seller, so contact support.';
  return err?.message || "Couldn't report this problem. Try again in a moment.";
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
    canReviewProduct: false,
  };
}
