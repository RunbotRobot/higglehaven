// #3303/#3348 (owner decision: any text a user can read, they can copy, by
// selecting it with the platform's own selection; no Copy control anywhere).
// What remains of the original per-modal mechanism: a message the person was
// shown in a modal status line is recorded for bug reports
// (src/ui/visibleMessages.js), so a report carries the exact words even when
// they could not be read back. One observer per line instead of a call in each
// surface. The error decision lives in copyableErrorRule.js (unit-tested).
import { recordVisibleMessage } from './visibleMessages.js';
import { isErrorLine } from './copyableErrorRule.js';

// The status lines that show an error or refusal inside a modal (or the account
// menu). Each toggles an `error` class when what it shows is an error; the two
// role="alert" lines are errors whenever they have text.
const ERROR_STATUS_IDS = [
  'auth-status', 'claim-status', 'upload-status', 'checkout-status', 'verify-status',
  'seller-status', 'feedback-status', 'friends-status', 'dm-status', 'my-lands-status',
  'confirm-modal-status', 'sell-this-too-form-error',
];

function watchStatusLine(statusEl) {
  let lastRecorded = '';
  const refresh = () => {
    const text = statusEl.textContent;
    if (isErrorLine({
      text, hasErrorClass: statusEl.classList.contains('error'), role: statusEl.getAttribute('role'),
    })) {
      if (text.trim() !== lastRecorded) {
        lastRecorded = text.trim();
        recordVisibleMessage(text);
      }
    } else {
      lastRecorded = '';
    }
  };
  new MutationObserver(refresh).observe(statusEl, {
    childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'],
  });
  refresh();
}

for (const id of ERROR_STATUS_IDS) {
  const el = document.getElementById(id);
  if (el) watchStatusLine(el);
}
