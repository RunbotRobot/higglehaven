// #2388: themed modal collecting the category a moderation delete now
// requires server-side (deleteSignPost/deleteCalendarEvent/
// deleteProductReview's own moderation call sites -- see
// worker/lib/content-moderation.js), replacing nothing (this flow never had
// a native prompt()/confirm() to begin with), but following the same
// reusable Promise-based pattern #2761 established for promptBundleName
// rather than introducing one.
import { openModalA11y, closeModalA11y } from './modal.js';

const modalEl = document.getElementById('moderation-category-modal');
const cancelBtn = document.getElementById('moderation-category-cancel-btn');
const optionsEl = document.getElementById('moderation-category-options');
const deleteBtn = document.getElementById('moderation-category-delete-btn');

let resolvePrompt = null;

function close(result) {
  modalEl.classList.remove('visible');
  closeModalA11y(modalEl);
  const resolve = resolvePrompt;
  resolvePrompt = null;
  resolve?.(result);
}

function selectedCategory() {
  return optionsEl.querySelector('input[name="moderation-category"]:checked')?.value ?? null;
}

optionsEl.addEventListener('change', () => {
  deleteBtn.disabled = !selectedCategory();
});

cancelBtn.addEventListener('click', () => close(null));
deleteBtn.addEventListener('click', () => {
  const category = selectedCategory();
  if (!category) return;
  close(category);
});

// Resolves to the chosen category string on Delete, or `null` on Cancel/
// Escape -- same "null means cancelled" shape promptBundleName already uses.
export function promptModerationCategory() {
  return new Promise((resolve) => {
    resolvePrompt = resolve;
    for (const input of optionsEl.querySelectorAll('input[name="moderation-category"]')) {
      input.checked = false;
    }
    deleteBtn.disabled = true;
    modalEl.classList.add('visible');
    openModalA11y(modalEl, () => close(null));
  });
}
