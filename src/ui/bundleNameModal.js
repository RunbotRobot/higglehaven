// #2761: replaces the native prompt()/confirm() pair this app's bundle
// flow was the last holdout still using (Save Bundle's name prompt plus
// its own follow-up share confirm in src/main.js, and the bundle-tile
// rename prompt in src/catalog/picker.js). One small reusable modal
// covers both call sites -- the share checkbox only shown for the Save
// Bundle case.
import { openModalA11y, closeModalA11y } from './modal.js';

const modalEl = document.getElementById('bundle-name-modal');
const titleEl = document.getElementById('bundle-name-modal-title');
const cancelBtn = document.getElementById('bundle-name-cancel-btn');
const inputEl = document.getElementById('bundle-name-input');
const shareLabelEl = document.getElementById('bundle-name-share-label');
const shareCheckboxEl = document.getElementById('bundle-name-share-checkbox');
const saveBtn = document.getElementById('bundle-name-save-btn');

let resolvePrompt = null;

function close(result) {
  modalEl.classList.remove('visible');
  closeModalA11y(modalEl);
  const resolve = resolvePrompt;
  resolvePrompt = null;
  resolve?.(result);
}

function trySave() {
  const name = inputEl.value.trim();
  if (!name) return;
  close({ name, shared: shareLabelEl.hidden ? undefined : shareCheckboxEl.checked });
}

cancelBtn.addEventListener('click', () => close(null));
saveBtn.addEventListener('click', trySave);
inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    trySave();
  }
});

// Resolves to `{ name, shared }` (`shared` only set when `showShare` is
// true) on Save, or `null` on Cancel/Escape -- same "null means cancelled"
// shape the native prompt() this replaces returned.
export function promptBundleName({ title, initialName = '', showShare = false, initialShared = false } = {}) {
  return new Promise((resolve) => {
    resolvePrompt = resolve;
    titleEl.textContent = title;
    inputEl.value = initialName;
    shareLabelEl.hidden = !showShare;
    shareCheckboxEl.checked = initialShared;
    modalEl.classList.add('visible');
    openModalA11y(modalEl, () => close(null));
    inputEl.focus();
    inputEl.select();
  });
}
