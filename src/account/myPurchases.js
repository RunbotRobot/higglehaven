// "My Purchases" (#3197/#3198): row rendering for the account-menu panel.
// Kept out of menu.js so the plain-language wording is testable. Copy
// describes what the buyer sees, never internals.
import { createSellerFeedback, editSellerFeedback, deleteSellerFeedback } from '../api.js';

const money = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function purchaseStatusText(purchase) {
  if (purchase.refundedAt) return 'Refunded';
  if (purchase.isDigitalGood) return 'Digital: ready';
  if (purchase.shippedAt) return 'Shipped';
  return 'Order placed';
}

const stars = (rating) => '★'.repeat(rating) + '☆'.repeat(5 - rating);

// Plain words for the failures a buyer can actually hit; anything else shows
// the server's own message.
function feedbackErrorText(err) {
  if (err.status === 409) return 'That changed while you were editing, so we reloaded it. Please check and try again.';
  if (err.status === 429) return "You've made a lot of changes in a short time. Please try again in a little while.";
  if (err.status === 403) return "That feedback isn't yours to change.";
  return err.message || 'Could not save your feedback. Please try again.';
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'my-purchase-action';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// callbacks: { onChanged(updatedPurchase) } -- a local update from the API's
// own response; { onReload() } -- re-fetch the list from the server (after a
// delete, or a 409, when the local copy can't be trusted).
export function createPurchaseRow(purchase, { onChanged = () => {}, onReload = () => {} } = {}) {
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

  const feedbackArea = document.createElement('div');
  feedbackArea.className = 'my-purchase-feedback';
  row.appendChild(feedbackArea);

  const status = document.createElement('div');
  status.className = 'my-purchase-feedback-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  function showSummary() {
    feedbackArea.textContent = '';
    if (purchase.feedback) {
      const summary = document.createElement('div');
      summary.className = 'my-purchase-feedback-summary';
      summary.textContent = `Your feedback: ${stars(purchase.feedback.rating)}${purchase.feedback.text ? ` "${purchase.feedback.text}"` : ''}`;
      const actions = document.createElement('div');
      actions.className = 'my-purchase-actions';
      actions.append(
        button('Edit feedback', () => showForm()),
        button('Delete feedback', () => remove()),
      );
      feedbackArea.append(summary, actions);
    } else if (purchase.canLeaveFeedback) {
      const actions = document.createElement('div');
      actions.className = 'my-purchase-actions';
      actions.append(button('Rate this seller', () => showForm()));
      feedbackArea.appendChild(actions);
    }
    feedbackArea.appendChild(status);
  }

  async function remove() {
    status.textContent = '';
    try {
      await deleteSellerFeedback(purchase.purchaseId);
    } catch (err) {
      status.textContent = feedbackErrorText(err);
      if (err.status === 409) onReload();
      return;
    }
    onReload(); // whether it can be rated again is the server's call
  }

  function showForm() {
    feedbackArea.textContent = '';
    const form = document.createElement('form');
    form.className = 'my-purchase-feedback-form';
    const label = document.createElement('label');
    label.textContent = 'Rating ';
    const select = document.createElement('select');
    select.name = 'rating';
    select.setAttribute('aria-label', 'Rating');
    for (let n = 5; n >= 1; n -= 1) {
      const option = document.createElement('option');
      option.value = String(n);
      option.textContent = `${n} ${n === 1 ? 'star' : 'stars'}`;
      select.appendChild(option);
    }
    select.value = String(purchase.feedback ? purchase.feedback.rating : 5);
    label.appendChild(select);
    const text = document.createElement('textarea');
    text.name = 'text';
    text.maxLength = 280;
    text.rows = 3;
    text.placeholder = 'Add a comment (optional)';
    text.setAttribute('aria-label', 'Comment');
    text.value = purchase.feedback?.text || '';
    const actions = document.createElement('div');
    actions.className = 'my-purchase-actions';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'my-purchase-action';
    save.textContent = 'Save feedback';
    actions.append(save, button('Cancel', () => showSummary()));
    form.append(label, text, actions, status);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      status.textContent = '';
      save.disabled = true;
      const input = { rating: Number(select.value), text: text.value.trim() };
      try {
        const feedback = purchase.feedback
          ? await editSellerFeedback(purchase.purchaseId, input)
          : await createSellerFeedback(purchase.purchaseId, input);
        purchase = { ...purchase, canLeaveFeedback: false, feedback: { rating: feedback.rating, text: feedback.text } };
        onChanged(purchase);
        showSummary();
      } catch (err) {
        save.disabled = false;
        status.textContent = feedbackErrorText(err);
        if (err.status === 409) onReload();
      }
    });
    feedbackArea.appendChild(form);
    select.focus();
  }

  showSummary();
  return row;
}
