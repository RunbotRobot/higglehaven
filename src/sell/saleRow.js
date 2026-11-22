// One sale of one of the signed-in seller's products, with its Mark shipped and Refund actions. It
// is the row the product's own Sales panel (src/sell/mode.js) always drew, moved here unchanged so
// the Orders leaf (#3704, src/sell/ordersLeaf.js) shows exactly the same row: the same server
// routes, the same rules for when each action is offered, nothing about money changes.
// `onChanged` redraws the list after an action succeeds; `showProduct` adds the product's name
// (the leaf lists every product's sales together).
import { markPurchaseShipped, refundPurchase } from '../api.js';
import { showInlineActionStatus } from '../ui/inlineActionStatus.js';
import { confirmDestructive } from '../ui/confirmModal.js';
import { formatPriceCents } from '../main.js';

export function buildSaleRow(purchase, { onChanged, showProduct = false }) {
  const saleRow = document.createElement('div');
  saleRow.className = 'product-sale-row';
  const body = document.createElement('div');
  body.className = 'product-sale-row-body';
  if (showProduct && purchase.productName) {
    // #3704: the Orders leaf lists every product's sales together, so each row says which product.
    const product = document.createElement('div');
    product.className = 'product-sale-row-product';
    product.textContent = purchase.productName;
    body.appendChild(product);
  }
  const summary = document.createElement('div');
  summary.className = 'product-sale-row-summary';
  summary.textContent = `${purchase.buyerLabel || 'Anonymous'} — ${purchase.quantity}x, ${formatPriceCents(purchase.totalCents)} total`;
  body.appendChild(summary);
  const commission = document.createElement('div');
  commission.className = 'product-sale-row-commission';
  commission.textContent = `You earned ${formatPriceCents(purchase.builderShareCents)}`;
  body.appendChild(commission);
  const time = document.createElement('div');
  time.className = 'product-sale-row-time';
  const date = new Date(purchase.createdAt);
  time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  body.appendChild(time);
  saleRow.appendChild(body);

  // #454: a physical (non-digital-good) real-money purchase holds
  // its payout until delivery is confirmed or 7 days after shipping
  // — this is the seller's own side of starting that fallback clock.
  // Neither a digital good (nothing to ship) nor a simulated
  // (higgles) sale (no real Stripe balance to ever hold) shows this.
  if (purchase.paymentIntentId && !purchase.isDigitalGood && !purchase.refundedAt) {
    const shipping = document.createElement('div');
    shipping.className = 'product-sale-row-shipping';
    if (purchase.deliveryConfirmedAt) {
      shipping.textContent = 'Delivery confirmed — available to cash out.';
    } else if (purchase.shippedAt) {
      shipping.textContent = `Shipped ${new Date(purchase.shippedAt).toLocaleDateString()} — available 7 days after shipping if not confirmed sooner.`;
    } else {
      const shipBtn = document.createElement('button');
      shipBtn.className = 'product-sale-row-ship-btn';
      shipBtn.type = 'button';
      shipBtn.textContent = 'Mark shipped';
      shipBtn.addEventListener('click', async () => {
        shipBtn.disabled = true;
        showInlineActionStatus(shipping, '');
        try {
          await markPurchaseShipped(purchase.purchaseId);
          await onChanged();
        } catch (err) {
          // #3249: in the row, not alert() (a suppressed dialog is silent).
          showInlineActionStatus(shipping, err.message || 'Couldn\'t mark this purchase shipped.');
          shipBtn.disabled = false;
        }
      });
      shipping.appendChild(shipBtn);
    }
    body.appendChild(shipping);
  }

  if (purchase.refundedAt) {
    const refundedLabel = document.createElement('div');
    refundedLabel.className = 'product-sale-row-refunded';
    refundedLabel.textContent = 'Refunded';
    saleRow.appendChild(refundedLabel);
  } else if (purchase.paidOutAt) {
    // #599: the backend now rejects a refund once paid_out_at is
    // set (that seller-share has already left the platform via a
    // real payout) — mirror that here instead of showing an active
    // button that would just 409.
    const paidOutLabel = document.createElement('div');
    paidOutLabel.className = 'product-sale-row-refunded';
    paidOutLabel.textContent = 'Paid out — contact support for a refund';
    saleRow.appendChild(paidOutLabel);
  } else {
    const refundBtn = document.createElement('button');
    refundBtn.className = 'product-sale-row-refund-btn';
    refundBtn.type = 'button';
    refundBtn.textContent = 'Refund';
    refundBtn.addEventListener('click', async () => {
      showInlineActionStatus(body, '');
      // Giving a buyer their money back cannot be taken back, so it is confirmed in the app's own modal (owner
      // decision "A destructive action is confirmed in its own in-app modal"); a refusal shows in that modal.
      const confirmed = await confirmDestructive({
        title: 'Refund this order?',
        message: `Refund ${purchase.buyerLabel || 'the buyer'} ${formatPriceCents(purchase.totalCents)} for ${purchase.productName || 'this order'}? This can't be undone.`,
        confirmLabel: 'Refund',
        returnFocusEl: refundBtn,
        onConfirm: async () => {
          try {
            await refundPurchase(purchase.purchaseId);
          } catch (err) {
            throw new Error(err.message || 'Couldn\'t refund this purchase.');
          }
        },
      });
      if (confirmed) await onChanged();
    });
    saleRow.appendChild(refundBtn);
  }
  return saleRow;
}
