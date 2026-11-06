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
  // #2988: a permanently closed seller's items are never coming back, but
  // stay listed (with their name/image kept) so the builder still knows
  // what used to be here and can find a replacement.
  let status;
  if (slot.permanentAt) status = 'Its seller\'s account has been permanently closed, so it will not come back. Clear it whenever you like to free up the spot.';
  else if (slot.sellerSuspended) status = 'Removed while its seller is suspended. It returns automatically if the suspension is lifted.';
  // #3094: this is every other restore-skip (its level was removed while it
  // was pending, #3047; its template was deleted; the land changed hands).
  // The bare "could not be put back" gave no reason and no next step.
  else status = 'It could not be put back where it was (for example, the level it was on has since been removed). Clear it to free up the spot.';
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
      if (!confirm('Clear this for good? It will not come back, and the spot is free for something else.')) return;
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

// Returns the fetched slots (so a caller that needs them, such as the Build
// tab-focus reconcile in scene.js, doesn't fetch twice), or null when the
// fetch failed. A refresh that a newer one superseded still returns what it
// fetched (it just doesn't render it, the newer refresh owns the panel):
// #3192 -- two tab-focus handlers refresh at nearly the same moment, and
// handing the loser null made it conclude "nothing was removed" and skip
// telling the builder why items had left their land.
export async function refresh() {
  const myLoadToken = ++loadToken;
  let slots;
  try {
    slots = await fetchPendingRestorations();
  } catch {
    // Signed out, no builder profile, or a transient failure: nothing to
    // show, and nothing here is worth interrupting Build mode for.
    if (myLoadToken === loadToken) renderSlots([]);
    return null;
  }
  if (myLoadToken !== loadToken) return slots; // superseded: the newer refresh renders, this data is still valid
  renderSlots(slots);
  return slots;
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
