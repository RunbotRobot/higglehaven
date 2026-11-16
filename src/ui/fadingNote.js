// #3552: a short success note that arrives, stays a few seconds, and fades by
// itself, in place of a blocking "Report submitted / Thank you / OK" modal
// laid over the modal the person had just used. Only for a success: a failure
// stays until dismissed (#3303), so it keeps using showNotice(). The text is
// selectable while shown (#3303), and the hidden state is click-through.
const DEFAULT_MS = 3500;
let el = null;
let timer = null;

function ensureEl() {
  if (el?.isConnected) return el;
  el = document.createElement('div');
  el.id = 'fading-note';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
  return el;
}

export function showFadingNote(text, { ms = DEFAULT_MS } = {}) {
  const node = ensureEl();
  node.textContent = text;
  node.classList.add('visible');
  clearTimeout(timer);
  timer = setTimeout(() => {
    node.classList.remove('visible');
    timer = null;
  }, ms);
  return node;
}
