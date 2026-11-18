// #3776: an order is its own record. What a purchase says it bought is the
// product_name / product_kind / seller_name copied onto the row when the
// purchase was made (migration 0230), never the live catalog row, so a seller
// deleting or renaming the product, or leaving, cannot change an old order.
//
// What an order with nothing surviving reads as. It has no bracketed
// placeholder: the order still shows its own date and price beside this.
export const ORPHANED_PRODUCT_NAME = 'A product the seller has since deleted';
export const ORPHANED_SELLER_NAME = 'A seller who has since left';

// The recorded name for a purchase, or null when none survives. Takes the
// purchase row if the caller already has product_name on it, else reads it.
export async function purchaseProductName(db, purchase) {
  if (purchase && typeof purchase.product_name === 'string' && purchase.product_name) return purchase.product_name;
  if (!purchase?.purchase_id) return null;
  const row = await db.prepare('SELECT product_name FROM purchases WHERE purchase_id = ?').bind(purchase.purchase_id).first();
  if (row?.product_name) return row.product_name;
  // An order made before the record existed and not yet backfilled: the live
  // row is still the best source.
  const live = await db.prepare('SELECT name FROM catalog_templates WHERE template_id = ?').bind(purchase.template_id).first();
  return live?.name || null;
}
