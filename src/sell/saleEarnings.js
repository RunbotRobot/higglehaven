// #4585: what a sale row tells the seller about the money. A card sale pays the seller its total minus the
// commission (docs/SPEC.md section 5: $98 of $100), net of any partial refund, the same figure
// worker/lib/seller-payouts-tax.js pays out. The row used to print `builderShareCents`, the lándlet host's
// higgles commission (about 1% of the sale), under "You earned", so a seller read $0.24 on a $24.00 sale.
// Pure, so it is unit-tested without the page.
export function sellerKeepsCents(purchase) {
  if (purchase.refundCents == null) return null; // not a card payment: no money moved to the seller
  const total = Number(purchase.totalCents);
  if (!(total > 0)) return 0;
  const gross = total - Number(purchase.commissionCents || 0);
  const refunded = Number(purchase.refundedAmountCents || 0);
  return Math.max(0, Math.round((gross * (total - refunded)) / total));
}
