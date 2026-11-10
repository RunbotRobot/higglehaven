// #3359 (part of #3249's native-dialog sweep): one in-app modal for the short
// text a shopper or builder leaves in the world -- a sign-post note (write,
// edit, delete your own) and a calendar event (text plus an optional
// date/time). It replaces chains of native prompt()/alert() calls: a browser
// that suppresses native dialogs answered each prompt with "cancel" at once,
// so tapping a sign or calendar did nothing and said nothing. The comment has
// a live count against the limit (#1920/#2015: prompt() could not show one and
// lost the typed text on a server-side rejection), a refusal or server error
// shows inside the modal as selectable text and keeps what was typed, and the
// optional date uses a real date/time field, so the "could not understand
// that date" case cannot happen. Deleting goes through the shared
// destructive-confirm modal (#3278).
import { openModalA11y, closeModalA11y } from './modal.js';
import { confirmDestructive } from './confirmModal.js';

export const NOTE_MAX_LENGTH = 280;

const modalEl = document.getElementById('note-modal');
const titleEl = document.getElementById('note-modal-title');
const closeBtn = document.getElementById('note-modal-close-btn');
const labelEl = document.getElementById('note-modal-label');
const textEl = document.getElementById('note-modal-text');
const countEl = document.getElementById('note-modal-count');
const scheduleLabelEl = document.getElementById('note-modal-schedule-label');
const scheduleEl = document.getElementById('note-modal-schedule');
const statusEl = document.getElementById('note-modal-status');
const deleteBtn = document.getElementById('note-modal-delete-btn');
const cancelBtn = document.getElementById('note-modal-cancel-btn');
const saveBtn = document.getElementById('note-modal-save-btn');

let session = null;

function setStatus(message) {
  statusEl.textContent = message;
  statusEl.hidden = !message;
}

function setBusy(busy) {
  saveBtn.disabled = busy;
  cancelBtn.disabled = busy;
  closeBtn.disabled = busy;
  deleteBtn.disabled = busy;
}

function updateCount() {
  const length = textEl.value.trim().length;
  countEl.textContent = `${length}/${session?.maxLength ?? NOTE_MAX_LENGTH}`;
  countEl.classList.toggle('over', length > (session?.maxLength ?? NOTE_MAX_LENGTH));
}

function finish(result) {
  if (!session) return;
  const { resolve, returnFocusEl } = session;
  session = null;
  modalEl.classList.remove('visible');
  closeModalA11y(modalEl);
  setStatus('');
  setBusy(false);
  if (returnFocusEl?.isConnected && returnFocusEl.offsetParent !== null) {
    returnFocusEl.focus({ preventScroll: true });
  }
  resolve(result);
}

function cancel() {
  if (!session || session.busy) return;
  finish(false);
}

async function save() {
  if (!session || session.busy) return;
  const text = textEl.value.trim();
  if (!text) {
    setStatus(session.emptyMessage);
    return;
  }
  if (text.length > session.maxLength) {
    setStatus(`Keep it to ${session.maxLength} characters or fewer (it is ${text.length}).`);
    return;
  }
  let scheduledAt;
  if (session.schedule && scheduleEl.value) {
    const parsed = new Date(scheduleEl.value);
    if (Number.isNaN(parsed.getTime())) {
      setStatus('Choose a valid date and time, or clear the field.');
      return;
    }
    scheduledAt = parsed.toISOString();
  }
  setStatus('');
  session.busy = true;
  setBusy(true);
  try {
    await session.onSubmit({ text, scheduledAt });
  } catch (err) {
    if (!session) return;
    session.busy = false;
    setBusy(false);
    setStatus(err?.message || "Couldn't save that. Please try again.");
    saveBtn.focus({ preventScroll: true });
    return;
  }
  if (session) session.busy = false;
  finish(true);
}

async function remove() {
  if (!session || session.busy || !session.onDelete) return;
  const { onDelete, deleteTitle, deleteMessage } = session;
  setStatus('');
  const deleted = await confirmDestructive({
    title: deleteTitle,
    message: deleteMessage,
    confirmLabel: 'Delete',
    onConfirm: onDelete,
    restoreModalEl: modalEl,
    restoreCloseFn: cancel,
    returnFocusEl: deleteBtn,
  });
  if (deleted) finish(true);
}

closeBtn.addEventListener('click', cancel);
cancelBtn.addEventListener('click', cancel);
saveBtn.addEventListener('click', save);
deleteBtn.addEventListener('click', remove);
textEl.addEventListener('input', updateCount);

// Resolves true once saved or deleted, false on cancel/Escape/X. `onSubmit({
// text, scheduledAt })` and `onDelete()` run while the modal stays open; a
// throw is shown inside it. `existing` ({ text }) switches to edit mode and
// shows Delete (when `onDelete` is given).
export function openTextNoteModal({
  title,
  label = 'Note',
  existing = null,
  schedule = false,
  maxLength = NOTE_MAX_LENGTH,
  submitLabel = null,
  emptyMessage = 'Write something first.',
  deleteTitle = 'Delete this note?',
  deleteMessage = 'It will be removed for everyone.',
  onSubmit,
  onDelete = null,
  returnFocusEl = null,
} = {}) {
  if (session) finish(false);
  return new Promise((resolve) => {
    session = {
      resolve, onSubmit, onDelete: existing ? onDelete : null, returnFocusEl, maxLength, schedule, emptyMessage, deleteTitle, deleteMessage, busy: false,
    };
    titleEl.textContent = title;
    labelEl.textContent = label;
    textEl.value = existing?.text || '';
    scheduleLabelEl.hidden = !schedule;
    scheduleEl.value = '';
    updateCount();
    setStatus('');
    setBusy(false);
    deleteBtn.hidden = !session.onDelete;
    saveBtn.textContent = submitLabel || (existing ? 'Save changes' : 'Post');
    modalEl.classList.add('visible');
    openModalA11y(modalEl, cancel);
    textEl.focus({ preventScroll: true });
  });
}

// E2E hook, same idea as window.__openProductReviewModal.
window.__openTextNoteModal = openTextNoteModal;
