// "My Purchases" (#3197): row rendering for the account-menu panel. Kept out
// of menu.js so the plain-language status wording is a pure, testable
// function. Copy describes what the buyer sees, never internals.
const money = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function purchaseStatusText(purchase) {
  if (purchase.refundedAt) return 'Refunded';
  if (purchase.isDigitalGood) return 'Digital: ready';
  if (purchase.shippedAt) return 'Shipped';
  return 'Order placed';
}

export function createPurchaseRow(purchase) {
  const row = document.createElement('div');
  row.className = 'my-purchase-row';
  row.dataset.purchaseId = purchase.purchaseId;
  const name = document.createElement('div');
  name.className = 'my-purchase-name';
  name.textContent = purchase.productName;
  const meta = document.createElement('div');
  meta.className = 'my-purchase-meta';
  const date = new Date(purchase.createdAt).toLocaleDateString();
  meta.textContent = `${purchase.sellerName} · ${date} · Qty ${purchase.quantity} · ${money(purchase.totalCents)} · ${purchaseStatusText(purchase)}`;
  row.append(name, meta);
  return row;
}
