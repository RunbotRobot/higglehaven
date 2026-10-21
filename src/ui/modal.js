// #1316: shared modal keyboard accessibility. role="dialog"/aria-modal are
// set on each modal element in index.html; this covers what markup alone
// can't — moving focus into a dialog when it opens, restoring it to
// whatever opened the dialog once it closes, trapping Tab/Shift+Tab inside
// the dialog while it's open, and closing the currently-open dialog on
// Escape. Only one modal is ever open at a time in this app, so a single
// tracked "active" modal (rather than a stack) matches how
// openModalA11y/closeModalA11y are called below.
let activeModalEl = null;
let activeModalCloseFn = null;
let modalReturnFocusEl = null;

export function getModalFocusable(modalEl) {
  return Array.from(modalEl.querySelectorAll(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((el) => el.offsetParent !== null);
}

export function openModalA11y(modalEl, closeFn) {
  activeModalEl = modalEl;
  activeModalCloseFn = closeFn || null;
  modalReturnFocusEl = document.activeElement;
  const target = getModalFocusable(modalEl)[0] || modalEl;
  target.focus({ preventScroll: true });
}

export function closeModalA11y(modalEl) {
  if (activeModalEl !== modalEl) return;
  activeModalEl = null;
  activeModalCloseFn = null;
  const returnTo = modalReturnFocusEl;
  modalReturnFocusEl = null;
  if (returnTo && document.body.contains(returnTo) && returnTo.offsetParent !== null) {
    returnTo.focus({ preventScroll: true });
  } else if (document.getElementById('account-menu-toggle')?.offsetParent !== null) {
    // The settings/notifications/friends/my-lands triggers all live inside
    // the collapsible account-menu panel (see openAccountMenu's own
    // comment in e2e/helpers.mjs), which auto-collapses — hiding the very
    // button that opened the modal — the moment that button is clicked.
    // Falling back to the toggle that controls the panel is a more useful
    // landing spot than leaving focus wherever the browser defaults it
    // (document.body) once the original trigger is no longer focusable.
    // Looked up by id rather than imported as `accountMenuToggle` (its
    // name in src/main.js) to keep this module's only dependency on the
    // rest of the app the DOM itself -- same element, same behavior.
    document.getElementById('account-menu-toggle').focus({ preventScroll: true });
  }
}

document.addEventListener('keydown', (event) => {
  if (!activeModalEl) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    activeModalCloseFn?.();
    return;
  }
  if (event.key === 'Tab') {
    const focusable = getModalFocusable(activeModalEl);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});
