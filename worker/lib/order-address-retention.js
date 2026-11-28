// #4636 (part of #4394, shipping): an order keeps its own copy of the address it shipped to (purchases.
// shipping_address_json, #4599) because the seller needs it to ship and a dispute about the parcel needs it. Once the
// order is closed it is needed for neither, so a sweep clears it ("an address is read only for the job it does"). The
// order, its price and its tracking stay.
//
// Closed means: refunded, or shipped and paid out to the seller (a paid-out order can no longer be disputed
// automatically, see disputeBlock in purchase-lifecycle.js). The grace after that covers a parcel still in a carrier's
// hands and a manual reconciliation; it is the one number to change if the owner wants a different one.
export const ORDER_ADDRESS_KEEP_DAYS = 30;

export async function clearClosedOrderAddresses(db, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - ORDER_ADDRESS_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.prepare(
    `UPDATE purchases SET shipping_address_json = NULL
      WHERE shipping_address_json IS NOT NULL
        AND ((refunded_at IS NOT NULL AND refunded_at < ?1)
          OR (paid_out_at IS NOT NULL AND shipped_at IS NOT NULL AND refunded_at IS NULL AND paid_out_at < ?1))`,
  ).bind(cutoff).run();
  return result.meta?.changes ?? 0;
}
