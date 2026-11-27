// One sale of one of the signed-in seller's products, with its Mark shipped and Refund actions. It
// is the row the product's own Sales panel (src/sell/mode.js) always drew, moved here unchanged so
// the Orders leaf (#3704, src/sell/ordersLeaf.js) shows exactly the same row: the same server
// routes, the same rules for when each action is offered, nothing about money changes.
// `onChanged` redraws the list after an action succeeds; `showProduct` adds the product's name
// (the leaf lists every product's sales together).
import { markPurchaseShipped, setPurchaseTracking, refundPurchase } from '../api.js';
import { showInlineActionStatus } from '../ui/inlineActionStatus.js';
import { confirmDestructive } from '../ui/confirmModal.js';
import { formatPriceCents } from '../main.js';
import { sellerKeepsCents } from './saleEarnings.js';

// #4600: the two optional boxes a seller can fill when they ship an order (and later correct): who carried it and the
// number the buyer can follow it by. Both start empty, with their words in the box and as the accessible name.
function buildTrackingBoxes(carrier, trackingNumber) {
  const box = document.createElement('div');
  box.className = 'product-sale-row-tracking';
  const make = (label, value, max) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'product-sale-row-tracking-input';
    input.maxLength = max;
    input.placeholder = label;
    input.setAttribute('aria-label', label);
    input.value = value || '';
    return input;
  };
  const carrierInput = make('Carrier (optional)', carrier, 40);
  const numberInput = make('Tracking number (optional)', trackingNumber, 64);
  box.append(carrierInput, numberInput);
  return { box, values: () => ({ carrier: carrierInput.value, trackingNumber: numberInput.value }) };
}

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
  // #4585: a card sale says what the seller keeps; the host's higgles commission is not the seller's money.
  const keeps = sellerKeepsCents(purchase);
  commission.textContent = keeps == null
    ? `You earned ${formatPriceCents(purchase.builderShareCents)}`
    : `You keep ${formatPriceCents(keeps)}`;
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
      // #4600: the carrier and tracking number the buyer reads, with a way to add or correct them.
      const line = document.createElement('div');
      line.className = 'product-sale-row-tracking-line';
      const parts = [purchase.shippingCarrier, purchase.trackingNumber ? `Tracking ${purchase.trackingNumber}` : ''].filter(Boolean);
      line.textContent = parts.length ? parts.join(' · ') : 'No carrier or tracking number given.';
      shipping.appendChild(line);
      const editBtn = document.createElement('button');
      editBtn.className = 'product-sale-row-ship-btn';
      editBtn.type = 'button';
      editBtn.textContent = parts.length ? 'Edit tracking' : 'Add tracking';
      editBtn.addEventListener('click', () => {
        const { box, values } = buildTrackingBoxes(purchase.shippingCarrier, purchase.trackingNumber);
        const saveBtn = document.createElement('button');
        saveBtn.className = 'product-sale-row-ship-btn';
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save tracking';
        saveBtn.addEventListener('click', async () => {
          saveBtn.disabled = true;
          showInlineActionStatus(shipping, '');
          try {
            await setPurchaseTracking(purchase.purchaseId, values());
            await onChanged();
          } catch (err) {
            showInlineActionStatus(shipping, err.message || 'Couldn\'t save the tracking details.');
            saveBtn.disabled = false;
          }
        });
        editBtn.replaceWith(box, saveBtn);
      });
      shipping.appendChild(editBtn);
    } else {
      const trackingBoxes = buildTrackingBoxes('', '');
      shipping.appendChild(trackingBoxes.box);
      const shipBtn = document.createElement('button');
      shipBtn.className = 'product-sale-row-ship-btn';
      shipBtn.type = 'button';
      shipBtn.textContent = 'Mark shipped';
      shipBtn.addEventListener('click', async () => {
        shipBtn.disabled = true;
        showInlineActionStatus(shipping, '');
        try {
          await markPurchaseShipped(purchase.purchaseId, trackingBoxes.values());
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
  } else if (purchase.noReturns) {
    // #4341: the seller turned returns off for this product and the server refuses a refund on it, so say that
    // here (and where to change it) instead of offering a button that can only refuse.
    const noReturnsLabel = document.createElement('div');
    noReturnsLabel.className = 'product-sale-row-refunded';
    noReturnsLabel.textContent = 'Returns are turned off for this product';
    saleRow.appendChild(noReturnsLabel);
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
        // #4340: a card order sends back 99% of its total (the server says how much); say that figure.
        message: `Refund ${purchase.buyerLabel || 'the buyer'} ${formatPriceCents(purchase.refundCents ?? purchase.totalCents)}${purchase.refundCents != null && purchase.refundCents !== purchase.totalCents ? ` (99% of ${formatPriceCents(purchase.totalCents)})` : ''} for ${purchase.productName || 'this order'}? This can't be undone.`,
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
