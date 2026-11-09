// #3249: where an action's outcome is reported in place of window.alert().
// A browser that suppresses native dialogs (Chrome after "prevent this page
// from creating additional dialogs", some embedded/PWA contexts, a dialog
// requested while another is pending) drops alert() without a trace, so a
// seller whose refund failed saw nothing. This puts the message in the row or
// block the tap happened in, as a polite live region, and keeps one element
// per container so a retry replaces the old message instead of stacking.
//
// container: the element to append the message to.
// text: the message; empty clears it.
// error: true for a failure (red), false for a plain confirmation.
export function showInlineActionStatus(container, text, { error = true } = {}) {
  let el = container.querySelector(':scope > .inline-action-status');
  if (!el) {
    el = document.createElement('div');
    el.className = 'inline-action-status settings-empty-note';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    container.appendChild(el);
  }
  el.textContent = text;
  el.classList.toggle('error', Boolean(text) && error);
  el.hidden = !text;
  return el;
}
