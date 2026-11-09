// #3249: one in-app modal for writing, editing and deleting a product review,
// replacing the chain of native prompt()/alert() calls Shop's review handler
// used (a "type edit or delete" prompt, a rating prompt, a comment prompt and
// alert()s for every outcome). A browser that suppresses native dialogs
// answered each of those with "cancel" at once, so Rate this Product did
// nothing and said nothing. Here the rating is a radio group, the comment has
// a live count against the 280 limit (#2005 -- prompt() could not show one),
// and an error from the server is shown inside the modal, where the person
// just tapped, and stays until the next attempt, as selectable text (#3303).
// Deleting goes through the shared destructive-confirm modal (#3278).
import { openModalA11y, closeModalA11y } from './modal.js';
import { confirmDestructive } from './confirmModal.js';

export const REVIEW_COMMENT_MAX = 280;

const modalEl = document.getElementById('product-review-modal');
const titleEl = document.getElementById('product-review-modal-title');
const closeBtn = document.getElementById('product-review-close-btn');
const ratingEls = [...document.querySelectorAll('input[name="product-review-rating"]')];
const textEl = document.getElementById('product-review-text');
const countEl = document.getElementById('product-review-count');
const statusEl = document.getElementById('product-review-status');
const statusTextEl = document.getElementById('product-review-status-text');
const deleteBtn = document.getElementById('product-review-delete-btn');
const cancelBtn = document.getElementById('product-review-cancel-btn');
const saveBtn = document.getElementById('product-review-save-btn');

let session = null;

function setStatus(message) {
  statusTextEl.textContent = message;
  statusEl.hidden = !message;
}

function setBusy(busy) {
  saveBtn.disabled = busy;
  cancelBtn.disabled = busy;
  closeBtn.disabled = busy;
  deleteBtn.disabled = busy;
}

function selectedRating() {
  const checked = ratingEls.find((el) => el.checked);
  return checked ? Number(checked.value) : null;
}

function updateCount() {
  const length = textEl.value.trim().length;
  countEl.textContent = `${length}/${REVIEW_COMMENT_MAX}`;
  countEl.classList.toggle('over', length > REVIEW_COMMENT_MAX);
}

function finish(result) {
  if (!session) return;
  const { resolve, returnFocusEl } = session;
  session = null;
  modalEl.classList.remove('visible');
  closeModalA11y(modalEl);
  setStatus('');
  setBusy(false);
  if (returnFocusEl?.isConnected && returnFocusEl.offsetParent !== null) {
    returnFocusEl.focus({ preventScroll: true });
  }
  resolve(result);
}

function cancel() {
  if (!session || session.busy) return;
  finish(false);
}

async function save() {
  if (!session || session.busy) return;
  const rating = selectedRating();
  if (rating === null) {
    setStatus('Choose a star rating from 1 to 5.');
    return;
  }
  const text = textEl.value.trim();
  if (text.length > REVIEW_COMMENT_MAX) {
    setStatus(`Keep the comment to ${REVIEW_COMMENT_MAX} characters or fewer (it is ${text.length}).`);
    return;
  }
  setStatus('');
  session.busy = true;
  setBusy(true);
  try {
    await session.onSubmit({ rating, text });
  } catch (err) {
    if (!session) return;
    session.busy = false;
    setBusy(false);
    setStatus(err?.message || "Couldn't save your review. Please try again.");
    saveBtn.focus({ preventScroll: true });
    return;
  }
  if (session) session.busy = false;
  finish(true);
}

async function remove() {
  if (!session || session.busy || !session.onDelete) return;
  const { onDelete } = session;
  setStatus('');
  const deleted = await confirmDestructive({
    title: 'Delete your review?',
    message: 'Your star rating and comment will be removed from this product.',
    confirmLabel: 'Delete review',
    onConfirm: onDelete,
    restoreModalEl: modalEl,
    restoreCloseFn: cancel,
    returnFocusEl: deleteBtn,
  });
  if (deleted) finish(true);
}

closeBtn.addEventListener('click', cancel);
cancelBtn.addEventListener('click', cancel);
saveBtn.addEventListener('click', save);
deleteBtn.addEventListener('click', remove);
textEl.addEventListener('input', updateCount);

// `existing` ({ rating, text }) switches the modal to edit mode and shows the
// Delete button. `onSubmit({ rating, text })` and `onDelete()` run while the
// modal stays open; a throw is shown inside it. Resolves true once saved or
// deleted, false on cancel/Escape/X.
export function openProductReviewModal({ existing = null, onSubmit, onDelete = null, returnFocusEl = null } = {}) {
  if (session) finish(false);
  return new Promise((resolve) => {
    session = { resolve, onSubmit, onDelete: existing ? onDelete : null, returnFocusEl, busy: false };
    titleEl.textContent = existing ? 'Your review' : 'Review this product';
    const initialRating = existing ? existing.rating : 5;
    for (const el of ratingEls) el.checked = Number(el.value) === initialRating;
    textEl.value = existing?.text || '';
    updateCount();
    setStatus('');
    setBusy(false);
    deleteBtn.hidden = !session.onDelete;
    saveBtn.textContent = existing ? 'Save changes' : 'Post review';
    modalEl.classList.add('visible');
    openModalA11y(modalEl, cancel);
    textEl.focus({ preventScroll: true });
  });
}

// E2E hook (same idea as window.__friendsMapPoints): Shop's in-world "Rate
// this Product" button needs real camera movement to reach, so the test opens
// this modal directly with stubbed callbacks.
window.__openProductReviewModal = openProductReviewModal;
