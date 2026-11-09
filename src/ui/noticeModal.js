// #3249: an in-app notice for an outcome the person has to be able to read,
// select and copy -- the replacement for window.alert() where the message
// matters (a purchase result, a refusal). A browser can suppress alert() and
// drop it without a trace, which for "Purchase complete" would also lose the
// one-time delivery-confirm link (the server stores only its hash). Unlike a
// toast, it stays until the person closes it (#3303: an error or refusal is
// never timed out), its text is selectable, and `copyText` (a link, an error
// to send on) sits in a read-only field the person selects from themselves
// (#3303 as amended: copying is the platform's own selection, never a Copy
// button).
import { openModalA11y, closeModalA11y } from './modal.js';

const modalEl = document.getElementById('notice-modal');
const titleEl = document.getElementById('notice-modal-title');
const messageEl = document.getElementById('notice-modal-message');
const copyRowEl = document.getElementById('notice-modal-copy-row');
const copyFieldEl = document.getElementById('notice-modal-copy-field');
const closeBtn = document.getElementById('notice-modal-close-btn');
const okBtn = document.getElementById('notice-modal-ok-btn');

let session = null;

function finish() {
  if (!session) return;
  const { resolve, returnFocusEl } = session;
  session = null;
  modalEl.classList.remove('visible');
  closeModalA11y(modalEl);
  if (returnFocusEl?.isConnected && returnFocusEl.offsetParent !== null) {
    returnFocusEl.focus({ preventScroll: true });
  }
  resolve();
}

closeBtn.addEventListener('click', finish);
okBtn.addEventListener('click', finish);

function present({ title, message, copyText = null, okLabel = 'OK', returnFocusEl = null }) {
  return new Promise((resolve) => {
    session = { resolve, returnFocusEl };
    titleEl.textContent = title;
    messageEl.textContent = message;
    copyRowEl.hidden = !copyText;
    copyFieldEl.value = copyText || '';
    okBtn.textContent = okLabel;
    modalEl.classList.add('visible');
    openModalA11y(modalEl, finish);
    okBtn.focus({ preventScroll: true });
  });
}

// Notices queue, one at a time, like the alert() calls they replace: a second
// one raised while the first is open waits its turn instead of replacing it
// (several Build sync failures can land together, and each must be read).
let queue = Promise.resolve();

// Resolves once the person closes it. `copyText` (optional) is shown in a
// read-only, selectable field.
export function showNotice(options = {}) {
  const shown = queue.then(() => present(options));
  queue = shown.catch(() => {});
  return shown;
}

// E2E hook, same idea as window.__openProductReviewModal.
window.__showNotice = showNotice;
