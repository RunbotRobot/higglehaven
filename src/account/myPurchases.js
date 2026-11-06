// "My Purchases" (#3197): row rendering for the account-menu panel. Kept out
// of menu.js so the plain-language status wording is a pure, testable
// function. Copy describes what the buyer sees, never internals.
import {
  DISPUTE_PROMPT_TEXT, disputeSuccessText, disputeErrorText, purchaseAfterDispute,
} from './disputeOutcome.js';

const money = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function purchaseStatusText(purchase) {
  if (purchase.refundedAt) return 'Refunded';
  if (purchase.isDigitalGood) return 'Digital: ready';
  if (purchase.shippedAt) return 'Shipped';
  return 'Order placed';
}

// `options.dispute(purchaseId)` is the API call (passed in by menu.js so this
// module stays free of network imports). Without it, no actions are offered.
export function createPurchaseRow(purchase, options = {}, note = '') {
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
  const noteEl = document.createElement('div');
  noteEl.className = 'my-purchase-note';
  noteEl.setAttribute('role', 'status');
  noteEl.textContent = note;
  noteEl.hidden = !note;
  row.appendChild(noteEl);
  if (purchase.canDispute && options.dispute) row.appendChild(createDisputeControl(row, purchase, options, noteEl));
  return row;
}

// "Report a problem" (#3199): a two-step inline confirm (a dispute can move
// real money), a control that is disabled while the request is in flight so a
// double click sends one request, and a plain-words outcome afterwards.
function createDisputeControl(row, purchase, options, noteEl) {
  const actions = document.createElement('div');
  actions.className = 'my-purchase-actions';
  const reportBtn = document.createElement('button');
  reportBtn.type = 'button';
  reportBtn.className = 'my-purchase-action-btn my-purchase-dispute-btn';
  reportBtn.textContent = 'Report a problem';

  const confirmBox = document.createElement('div');
  confirmBox.className = 'my-purchase-confirm';
  confirmBox.hidden = true;
  const prompt = document.createElement('span');
  prompt.textContent = DISPUTE_PROMPT_TEXT;
  const yesBtn = document.createElement('button');
  yesBtn.type = 'button';
  yesBtn.className = 'my-purchase-action-btn my-purchase-dispute-confirm-btn';
  yesBtn.textContent = 'Yes, report it';
  const noBtn = document.createElement('button');
  noBtn.type = 'button';
  noBtn.className = 'my-purchase-action-btn my-purchase-dispute-cancel-btn';
  noBtn.textContent = 'Never mind';
  confirmBox.append(prompt, yesBtn, noBtn);
  actions.append(reportBtn, confirmBox);

  reportBtn.addEventListener('click', () => {
    reportBtn.hidden = true;
    confirmBox.hidden = false;
    noteEl.hidden = true;
    yesBtn.focus();
  });
  noBtn.addEventListener('click', () => {
    confirmBox.hidden = true;
    reportBtn.hidden = false;
    reportBtn.focus();
  });
  let inFlight = false;
  yesBtn.addEventListener('click', async () => {
    if (inFlight) return;
    inFlight = true;
    yesBtn.disabled = true;
    noBtn.disabled = true;
    try {
      const result = await options.dispute(purchase.purchaseId);
      const updated = purchaseAfterDispute(purchase, result);
      // Rebuild from the updated purchase so a refund shows as "Refunded"
      // and the control is gone; a non-refund keeps the order as it was.
      row.replaceWith(createPurchaseRow(updated, options, disputeSuccessText(result)));
    } catch (err) {
      noteEl.textContent = disputeErrorText(err);
      noteEl.hidden = false;
      confirmBox.hidden = true;
      reportBtn.hidden = false;
      yesBtn.disabled = false;
      noBtn.disabled = false;
      inFlight = false;
    }
  });
  return actions;
}
