// #3359: the in-app replacement for the window.prompt() the nearby-chat and
// voice report flows used to collect an optional reason. A browser that
// suppresses native dialogs answers prompt() with "cancel", so a person could
// not report anyone at all. Same Promise shape as promptBundleName: resolves
// to { reason } on Report (reason is "" when left blank) or null on
// Cancel/Escape/close, and a cancelled modal submits nothing.
import { openModalA11y, closeModalA11y } from './modal.js';

const modalEl = document.getElementById('report-reason-modal');
const titleEl = document.getElementById('report-reason-modal-title');
const closeBtn = document.getElementById('report-reason-cancel-btn');
const inputEl = document.getElementById('report-reason-input');
const submitBtn = document.getElementById('report-reason-submit-btn');

let resolvePrompt = null;

function close(result) {
  modalEl.classList.remove('visible');
  closeModalA11y(modalEl);
  const resolve = resolvePrompt;
  resolvePrompt = null;
  resolve?.(result);
}

closeBtn.addEventListener('click', () => close(null));
submitBtn.addEventListener('click', () => close({ reason: inputEl.value.trim() }));

export function promptReportReason({ title }) {
  if (resolvePrompt) close(null);
  return new Promise((resolve) => {
    resolvePrompt = resolve;
    titleEl.textContent = title;
    inputEl.value = '';
    modalEl.classList.add('visible');
    openModalA11y(modalEl, () => close(null));
    inputEl.focus({ preventScroll: true });
  });
}
