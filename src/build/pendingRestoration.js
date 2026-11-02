// #2987 (3/5 of #2305): the builder-facing view of #2986's suspended-seller
// removals. When a seller is suspended, their products are taken off every
// builder's land (snapshotted, and put back automatically if the suspension
// is lifted). This gives the affected builder, in Build mode only, a
// "Removed Items" button (shown only while at least one slot is pending)
// opening a list of what used to be there -- name, category, image, where
// -- plus a "Clear" action to give up on a slot for good and free it up for
// a different product. Shoppers never see any of this: the endpoint behind
// it only ever returns the signed-in builder's own records.
import { openModalA11y, closeModalA11y } from '../ui/modal.js';
import { fetchPendingRestorations, clearPendingRestoration } from '../api.js';
import { authInitPromise, currentAuthUser } from '../account/auth.js';

const buttonEl = document.getElementById('pending-restoration-btn');
const modalEl = document.getElementById('pending-restoration-modal');
const closeBtn = document.getElementById('pending-restoration-close-btn');
const listEl = document.getElementById('pending-restoration-list');
const emptyEl = document.getElementById('pending-restoration-empty');

// Same stale-fetch guard idiom as backupChainLoadToken in metadataModals.js.
let loadToken = 0;

function formatMeters(value) {
  return typeof value === 'number' ? value.toFixed(1) : '?';
}

function describeSlot(slot) {
  const name = slot.templateName || 'A product that is no longer listed';
  const where = `at ${formatMeters(slot.position.x)}, ${formatMeters(slot.position.y)} m`;
  const status = slot.sellerSuspended
    ? 'Removed while its seller is suspended. It returns automatically if the suspension is lifted.'
    : 'Could not be put back automatically.';
  return { name, where, status };
}

function renderSlots(slots) {
  listEl.innerHTML = '';
  buttonEl.hidden = slots.length === 0;
  buttonEl.textContent = slots.length > 0 ? `Removed Items (${slots.length})` : 'Removed Items';
  emptyEl.hidden = slots.length > 0;
  for (const slot of slots) {
    const { name, where, status } = describeSlot(slot);
    const row = document.createElement('div');
    row.className = 'pending-restoration-row';
    row.dataset.snapshotId = slot.snapshotId;
    if (slot.imageUrl) {
      const img = document.createElement('img');
      img.className = 'pending-restoration-row-image';
      img.src = slot.imageUrl;
      img.alt = '';
      row.appendChild(img);
    }
    const text = document.createElement('div');
    text.className = 'pending-restoration-row-text';
    const nameEl = document.createElement('div');
    nameEl.className = 'pending-restoration-row-name';
    nameEl.textContent = slot.category ? `${name} (${slot.category})` : name;
    const detailEl = document.createElement('div');
    detailEl.className = 'pending-restoration-row-detail';
    detailEl.textContent = `${where}. ${status}`;
    text.append(nameEl, detailEl);
    row.appendChild(text);
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'pending-restoration-row-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.setAttribute('aria-label', `Clear ${name} for good`);
    clearBtn.addEventListener('click', async () => {
      if (!confirm('Clear this for good? It will not come back even if the seller is reinstated, and the spot is free for something else.')) return;
      clearBtn.disabled = true;
      try {
        await clearPendingRestoration(slot.snapshotId);
      } catch (err) {
        alert(err.message || 'Could not clear this item.');
      }
      // Re-fetch rather than splice locally: a failed clear (or a second
      // open copy of this panel clearing the same slot) leaves the list
      // exactly as the server now has it.
      await refresh();
    });
    row.appendChild(clearBtn);
    listEl.appendChild(row);
  }
}

export async function refresh() {
  const myLoadToken = ++loadToken;
  let slots;
  try {
    slots = await fetchPendingRestorations();
  } catch {
    // Signed out, no builder profile, or a transient failure: nothing to
    // show, and nothing here is worth interrupting Build mode for.
    if (myLoadToken === loadToken) renderSlots([]);
    return;
  }
  if (myLoadToken !== loadToken) return; // superseded by a newer refresh
  renderSlots(slots);
}

function openModal() {
  modalEl.classList.add('visible');
  openModalA11y(modalEl, closeModal);
  refresh();
}
function closeModal() {
  modalEl.classList.remove('visible');
  closeModalA11y(modalEl);
}
buttonEl.addEventListener('click', openModal);
closeBtn.addEventListener('click', closeModal);

authInitPromise.then(() => {
  if (currentAuthUser) refresh();
});
