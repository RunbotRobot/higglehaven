// #3278 (owner decision): a confirmation for a destructive action is its own
// in-app modal that takes focus, names the thing being removed, and offers a
// clear destructive button and a cancel. Never the browser's native confirm()
// (a suppressed one returns false at once and the action silently does
// nothing, #3249), and never an inline control that appears somewhere else on
// the page where it is easy to miss. One small reusable modal; call sites
// pass the title/message/button label.
//
// `onConfirm` (optional) runs the action while the modal is still open. If it
// throws, the error message is shown inside the modal, where the person just
// tapped, and the modal stays open so they can retry or cancel -- a refusal
// is never reported somewhere they are not looking. Resolves true once the
// action succeeded (or, with no onConfirm, once confirmed), false on
// cancel/Escape/X.
//
// The modal opens stacked over whatever modal launched it (same shape as the
// Upload modal over the Seller modal, #2515), and openModalA11y/
// closeModalA11y track a single active modal, so `restoreModalEl` +
// `restoreCloseFn` re-arm that parent's focus trap and Escape on close.
import { openModalA11y, closeModalA11y } from './modal.js';

const modalEl = document.getElementById('confirm-modal');
const closeBtn = document.getElementById('confirm-modal-close-btn');
const titleEl = document.getElementById('confirm-modal-title');
const messageEl = document.getElementById('confirm-modal-message');
const statusEl = document.getElementById('confirm-modal-status');
const cancelBtn = document.getElementById('confirm-modal-cancel-btn');
const confirmBtn = document.getElementById('confirm-modal-confirm-btn');

let session = null;

function setBusy(busy) {
  confirmBtn.disabled = busy;
  cancelBtn.disabled = busy;
  closeBtn.disabled = busy;
}

function finish(result) {
  if (!session) return;
  const { resolve, restoreModalEl, restoreCloseFn, returnFocusEl } = session;
  session = null;
  modalEl.classList.remove('visible');
  closeModalA11y(modalEl);
  statusEl.textContent = '';
  setBusy(false);
  if (restoreModalEl?.classList.contains('visible')) {
    openModalA11y(restoreModalEl, restoreCloseFn);
  }
  if (returnFocusEl?.isConnected && returnFocusEl.offsetParent !== null) {
    returnFocusEl.focus({ preventScroll: true });
  }
  resolve(result);
}

function cancel() {
  if (session?.busy) return;
  finish(false);
}

async function confirm() {
  if (!session || session.busy) return;
  statusEl.textContent = '';
  if (!session.onConfirm) {
    finish(true);
    return;
  }
  session.busy = true;
  setBusy(true);
  try {
    await session.onConfirm();
  } catch (err) {
    if (!session) return;
    session.busy = false;
    setBusy(false);
    statusEl.textContent = err?.message || "That didn't work. Please try again.";
    confirmBtn.focus({ preventScroll: true });
    return;
  }
  if (session) session.busy = false;
  finish(true);
}

closeBtn.addEventListener('click', cancel);
cancelBtn.addEventListener('click', cancel);
confirmBtn.addEventListener('click', confirm);

export function confirmDestructive({
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Never mind',
  // 'danger' (red) for removals; 'primary' (brand green) for a plain
  // are-you-sure that isn't destructive, such as a purchase.
  variant = 'danger',
  onConfirm = null,
  restoreModalEl = null,
  restoreCloseFn = null,
  returnFocusEl = null,
} = {}) {
  // A second request while one is open would orphan the first's promise:
  // resolve the earlier one as cancelled.
  if (session) finish(false);
  return new Promise((resolve) => {
    session = { resolve, onConfirm, restoreModalEl, restoreCloseFn, returnFocusEl, busy: false };
    titleEl.textContent = title;
    messageEl.textContent = message;
    statusEl.textContent = '';
    cancelBtn.textContent = cancelLabel;
    confirmBtn.textContent = confirmLabel;
    confirmBtn.dataset.variant = variant;
    setBusy(false);
    modalEl.classList.add('visible');
    openModalA11y(modalEl, cancel);
    // Land on the safe choice, not the destructive one.
    cancelBtn.focus({ preventScroll: true });
  });
}
