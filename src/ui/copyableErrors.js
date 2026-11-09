// #3303 (owner decision: any text a user can read, they can copy; an error or
// refusal gets a Copy control). One mechanism for every modal status line
// instead of a Copy button wired into each surface: each element below keeps
// its own wording and its own `error` class convention, and this adds a single
// small Copy button right after it while it holds error text. A message the
// person was shown is also recorded for bug reports (src/ui/visibleMessages.js).
// The decision itself lives in copyableErrorRule.js (unit-tested); the DOM
// wiring here is covered by e2e/copyable-error-lines.test.mjs.
import { copyTextWithFeedback } from './copyText.js';
import { recordVisibleMessage } from './visibleMessages.js';
import { shouldOfferCopy } from './copyableErrorRule.js';

// The status lines that show an error or refusal inside a modal (or the account
// menu). Each toggles an `error` class when what it shows is an error; the two
// role="alert" lines are errors whenever they have text.
const COPYABLE_STATUS_IDS = [
  'auth-status', 'claim-status', 'upload-status', 'checkout-status', 'verify-status',
  'seller-status', 'feedback-status', 'friends-status', 'dm-status', 'my-lands-status',
  'confirm-modal-status', 'sell-this-too-form-error',
];

function installCopyButton(statusEl) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-error-btn';
  button.textContent = 'Copy';
  button.hidden = true;
  statusEl.insertAdjacentElement('afterend', button);
  let lastRecorded = '';
  const refresh = () => {
    const text = statusEl.textContent;
    const offer = shouldOfferCopy({
      text, hasErrorClass: statusEl.classList.contains('error'), role: statusEl.getAttribute('role'),
    });
    button.hidden = !offer;
    if (offer && text.trim() !== lastRecorded) {
      lastRecorded = text.trim();
      recordVisibleMessage(text);
    }
    if (!offer) lastRecorded = '';
  };
  button.addEventListener('click', () => copyTextWithFeedback(button, statusEl.textContent.trim()));
  new MutationObserver(refresh).observe(statusEl, {
    childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'],
  });
  refresh();
}

for (const id of COPYABLE_STATUS_IDS) {
  const el = document.getElementById(id);
  if (el) installCopyButton(el);
}
