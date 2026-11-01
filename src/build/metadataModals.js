// #2560 (part of #2504/#2500's src/main.js module split, see #2503's design
// comment for the full dependency map): the product-metadata modals
// operating on a selected productMeshes entry -- sign posts, calendar
// events, backup chain -- extracted wholesale from src/main.js. Save
// Bundle (the other button declared alongside these in main.js) is a
// separate concern (Bundles, not per-instance metadata) and stays in
// main.js.
//
// hideBackupReferenceMesh stays exported: src/catalog/picker.js (#2558)
// needs it for its own closeCatalogPicker cleanup when a Backup Chain pick
// session ends (the low-opacity placement reference this module shows
// must disappear the moment the picker closes, pick or cancel alike).
import { openModalA11y, closeModalA11y } from '../ui/modal.js';
import { promptModerationCategory } from '../ui/moderationCategoryModal.js';
import {
  fetchSignPosts, deleteSignPost,
  fetchCalendarEvents, deleteCalendarEvent, editCalendarEvent,
  fetchInstanceBackups, addInstanceBackup, reorderInstanceBackups, deleteInstanceBackup,
} from '../api.js';
import { findTemplate, createMeshForInstance, disposeObject } from '../world/models.js';
import { currentAuthUser } from '../account/auth.js';
import { openCatalogPickerForPick } from '../catalog/picker.js';
import { selectedMeshes, updateSelectionUI, persistLayout, syncUpdate, landletElevationGroup } from './scene.js';

const communitySignBtn = document.getElementById('toggle-community-sign');
const communityCalendarBtn = document.getElementById('toggle-community-calendar');
const backupChainBtn = document.getElementById('toggle-backup-chain');

// Community Sign (docs/SPEC.md §6, docs/API.md's "Community signs") — an
// immediate-PATCH flag on the single selected instance the first time (the
// same pattern the Seller modal's own Flooring button uses for a
// per-instance/per-template boolean rather than a form with its own Save
// step). Once already flagged, this same button instead opens the Manage
// Posts panel (#sign-posts-modal, below) rather than un-flagging directly
// — un-flagging lives inside that panel's own "Remove Community Sign"
// button instead. A dedicated always-present "Manage Posts" toolbar button
// was tried first and reverted: on a phone-width viewport it pushed
// #gizmo-mode-controls' wrapped button row tall enough to physically
// overlap and intercept taps meant for the 3D canvas beneath it (caught by
// e2e/bundles.test.mjs — an unrelated test — suddenly failing to select a
// placed tree). Folding both actions into one button removes that extra
// row entirely.
communitySignBtn.addEventListener('click', async () => {
  if (selectedMeshes.size !== 1) return;
  const [mesh] = selectedMeshes;
  if (mesh.userData.isCommunitySign) {
    openSignPostsModal(mesh);
    return;
  }
  mesh.userData.isCommunitySign = true;
  updateSelectionUI();
  persistLayout();
  await syncUpdate(mesh);
});

// A builder's moderation view onto one sign's posts (see docs/API.md's
// "Community signs"), reusing the same modal shell #notifications-modal
// already establishes. Build mode never renders a sign's post sprites
// itself (those are Shop-mode-only, see registerShopSign), so this modal
// is the only place a builder ever sees what's actually been posted.
const signPostsModalEl = document.getElementById('sign-posts-modal');
const signPostsCloseBtn = document.getElementById('sign-posts-close-btn');
const signPostsListEl = document.getElementById('sign-posts-list');
const signPostsEmptyEl = document.getElementById('sign-posts-empty');
const signPostsTruncatedEl = document.getElementById('sign-posts-truncated');
const signPostsUnflagBtn = document.getElementById('sign-posts-unflag-btn');
let signPostsTargetMesh = null;
// Guards against reopening this modal on a different mesh before an
// earlier renderSignPosts()'s own await resolves — without it, the
// earlier call's stale fetch can land after the target has switched and
// append its rows (with the old instanceId baked into each delete
// button) onto a list the user now believes belongs to the new mesh.
// Same pattern as axisPreviewLoadToken/claimMapLoadToken elsewhere in
// this file.
let signPostsLoadToken = 0;

function formatSignPostTime(isoString) {
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

async function renderSignPosts() {
  signPostsListEl.innerHTML = '';
  signPostsTruncatedEl.hidden = true;
  if (!signPostsTargetMesh) return;
  const myLoadToken = ++signPostsLoadToken;
  const instanceId = signPostsTargetMesh.userData.instanceId;
  let posts;
  let totalCount;
  try {
    ({ posts, totalCount } = await fetchSignPosts(instanceId));
  } catch (err) {
    if (myLoadToken !== signPostsLoadToken) return; // superseded while fetching
    signPostsEmptyEl.textContent = err.message || 'Could not load posts.';
    signPostsEmptyEl.hidden = false;
    return;
  }
  if (myLoadToken !== signPostsLoadToken) return; // superseded — a newer call owns the list now
  // #1128: same reset-on-success fix as reviewEmptyEl in the Seller
  // modal — without it a past fetch failure leaves this stuck on its
  // error message forever, even once a later load succeeds with zero posts.
  signPostsEmptyEl.textContent = 'No posts on this sign yet.';
  signPostsEmptyEl.hidden = posts.length > 0;
  // #1274: posts is windowed to the newest 200 (worker/index.js's
  // handleSignPosts); totalCount is the real, uncapped count, so this is
  // the only way to tell a builder older posts exist but aren't shown.
  signPostsTruncatedEl.hidden = totalCount <= posts.length;
  signPostsTruncatedEl.textContent = `Showing newest ${posts.length} of ${totalCount} posts.`;
  for (const post of posts) {
    const row = document.createElement('div');
    row.className = 'sign-post-row';
    const body = document.createElement('div');
    body.className = 'sign-post-row-body';
    const author = document.createElement('div');
    author.className = 'sign-post-row-author';
    author.textContent = post.authorLabel;
    body.appendChild(author);
    const text = document.createElement('div');
    text.textContent = post.text;
    body.appendChild(text);
    const time = document.createElement('div');
    time.className = 'sign-post-row-time';
    time.textContent = formatSignPostTime(post.createdAt);
    body.appendChild(time);
    row.appendChild(body);
    const deleteRowBtn = document.createElement('button');
    deleteRowBtn.className = 'sign-post-row-delete';
    deleteRowBtn.type = 'button';
    deleteRowBtn.textContent = '×';
    deleteRowBtn.setAttribute('aria-label', 'Delete post');
    deleteRowBtn.addEventListener('click', async () => {
      // #2388: this panel is the landlet owner's moderation view -- the
      // server now requires a removal category on that path (see
      // worker/lib/content-moderation.js), collected here instead of the
      // native confirm() this flow used before.
      const category = await promptModerationCategory();
      if (!category) return;
      deleteRowBtn.disabled = true;
      try {
        await deleteSignPost(instanceId, post.postId, { category });
        await renderSignPosts();
      } catch (err) {
        alert(err.message || 'Could not delete this post.');
        // #2963: re-render instead of just re-enabling the button -- a
        // concurrent delete of this same post (the author's own composer,
        // or a second open copy of this panel) is exactly the kind of
        // failure this alert fires for, and leaving the stale row in
        // place just repeats the same dead-end delete on every retry.
        await renderSignPosts();
      }
    });
    row.appendChild(deleteRowBtn);
    signPostsListEl.appendChild(row);
  }
}

function openSignPostsModal(mesh) {
  signPostsTargetMesh = mesh;
  signPostsModalEl.classList.add('visible');
  openModalA11y(signPostsModalEl, closeSignPostsModal);
  renderSignPosts();
}
function closeSignPostsModal() {
  signPostsModalEl.classList.remove('visible');
  signPostsTargetMesh = null;
  closeModalA11y(signPostsModalEl);
}
signPostsCloseBtn.addEventListener('click', closeSignPostsModal);
signPostsUnflagBtn.addEventListener('click', async () => {
  if (!signPostsTargetMesh) return;
  const mesh = signPostsTargetMesh;
  mesh.userData.isCommunitySign = false;
  signPostsModalEl.classList.remove('visible');
  signPostsTargetMesh = null;
  closeModalA11y(signPostsModalEl);
  updateSelectionUI();
  persistLayout();
  await syncUpdate(mesh);
});

// Community Calendar (docs/SPEC.md §6, docs/API.md's "Community
// calendar") — structurally identical to Community Sign just above (same
// toggle-then-manage button design, same reasoning), deliberately kept as
// its own independent flag/table rather than merged with signs — see
// migrations/0042's own comment.
communityCalendarBtn.addEventListener('click', async () => {
  if (selectedMeshes.size !== 1) return;
  const [mesh] = selectedMeshes;
  if (mesh.userData.isCommunityCalendar) {
    openCalendarEventsModal(mesh);
    return;
  }
  mesh.userData.isCommunityCalendar = true;
  updateSelectionUI();
  persistLayout();
  await syncUpdate(mesh);
});

// A builder's moderation view onto one calendar's events — same shell/
// pattern as the sign posts modal just above.
const calendarEventsModalEl = document.getElementById('calendar-events-modal');
const calendarEventsCloseBtn = document.getElementById('calendar-events-close-btn');
const calendarEventsListEl = document.getElementById('calendar-events-list');
const calendarEventsEmptyEl = document.getElementById('calendar-events-empty');
const calendarEventsTruncatedEl = document.getElementById('calendar-events-truncated');
const calendarEventsUnflagBtn = document.getElementById('calendar-events-unflag-btn');
let calendarEventsTargetMesh = null;
// See signPostsLoadToken above — same reopen-on-a-different-mesh race,
// same fix.
let calendarEventsLoadToken = 0;

function formatCalendarEventTime(isoString) {
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

async function renderCalendarEvents() {
  calendarEventsListEl.innerHTML = '';
  calendarEventsTruncatedEl.hidden = true;
  if (!calendarEventsTargetMesh) return;
  const myLoadToken = ++calendarEventsLoadToken;
  const instanceId = calendarEventsTargetMesh.userData.instanceId;
  let events;
  let totalCount;
  try {
    ({ events, totalCount } = await fetchCalendarEvents(instanceId));
  } catch (err) {
    if (myLoadToken !== calendarEventsLoadToken) return; // superseded while fetching
    calendarEventsEmptyEl.textContent = err.message || 'Could not load events.';
    calendarEventsEmptyEl.hidden = false;
    return;
  }
  if (myLoadToken !== calendarEventsLoadToken) return; // superseded — a newer call owns the list now
  // #1128: same reset-on-success fix as reviewEmptyEl in the Seller
  // modal — without it a past fetch failure leaves this stuck on its
  // error message forever, even once a later load succeeds with zero events.
  calendarEventsEmptyEl.textContent = 'No events on this calendar yet.';
  calendarEventsEmptyEl.hidden = events.length > 0;
  // #1274: same truncation signal as sign posts above (handleCalendarEvents
  // windows to the newest 200 but returns the real, uncapped totalCount).
  calendarEventsTruncatedEl.hidden = totalCount <= events.length;
  calendarEventsTruncatedEl.textContent = `Showing newest ${events.length} of ${totalCount} events.`;
  for (const event of events) {
    const row = document.createElement('div');
    row.className = 'calendar-event-row';
    const body = document.createElement('div');
    body.className = 'calendar-event-row-body';
    const author = document.createElement('div');
    author.className = 'calendar-event-row-author';
    author.textContent = event.authorLabel;
    body.appendChild(author);
    const text = document.createElement('div');
    text.textContent = event.text;
    body.appendChild(text);
    const time = document.createElement('div');
    time.className = 'calendar-event-row-time';
    time.textContent = formatCalendarEventTime(event.createdAt);
    body.appendChild(time);
    if (event.scheduledAt) {
      const schedule = document.createElement('div');
      schedule.className = 'calendar-event-row-time';
      schedule.textContent = event.triggeredAt
        ? `🎉 Fired at ${formatCalendarEventTime(event.triggeredAt)}`
        : `⏳ Scheduled for ${formatCalendarEventTime(event.scheduledAt)}`;
      body.appendChild(schedule);
    }
    row.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'calendar-event-row-actions';
    // #1975: editing is author-only (handleCalendarEvents' own PATCH
    // branch 403s "Not your event" for anyone else) — this modal lists
    // every event on the calendar, not just this viewer's own, so the
    // edit button only renders for rows this session's own account
    // authored, same userId-match idiom as the sign-post/product-review
    // "myPost"/"myReview" checks use elsewhere.
    if (event.userId && currentAuthUser && event.userId === currentAuthUser.userId) {
      const editRowBtn = document.createElement('button');
      editRowBtn.className = 'calendar-event-row-edit';
      editRowBtn.type = 'button';
      editRowBtn.textContent = '✎';
      editRowBtn.setAttribute('aria-label', 'Edit event');
      editRowBtn.addEventListener('click', async () => {
        const newText = prompt('Edit this event (up to 280 characters):', event.text);
        if (newText === null) return;
        if (!newText.trim()) {
          alert('Event text cannot be empty.');
          return;
        }
        if (newText.trim().length > 280) {
          alert('Keep it to 280 characters or fewer.');
          return;
        }
        editRowBtn.disabled = true;
        try {
          await editCalendarEvent(instanceId, event.eventId, { text: newText.trim() });
          await renderCalendarEvents();
        } catch (err) {
          alert(err.message || 'Could not update this event.');
          // #2963: re-render instead of just re-enabling the button -- see
          // the sign-posts delete handler's own comment above.
          await renderCalendarEvents();
        }
      });
      actions.appendChild(editRowBtn);
    }
    const deleteRowBtn = document.createElement('button');
    deleteRowBtn.className = 'calendar-event-row-delete';
    deleteRowBtn.type = 'button';
    deleteRowBtn.textContent = '×';
    deleteRowBtn.setAttribute('aria-label', 'Delete event');
    deleteRowBtn.addEventListener('click', async () => {
      // #2388: same moderation-category requirement as the sign-posts panel
      // above -- this panel lists (and lets the landlet owner delete) every
      // event on the calendar, not just this viewer's own.
      const category = await promptModerationCategory();
      if (!category) return;
      deleteRowBtn.disabled = true;
      try {
        await deleteCalendarEvent(instanceId, event.eventId, { category });
        await renderCalendarEvents();
      } catch (err) {
        alert(err.message || 'Could not delete this event.');
        // #2963: re-render instead of just re-enabling the button -- see
        // the sign-posts delete handler's own comment above.
        await renderCalendarEvents();
      }
    });
    actions.appendChild(deleteRowBtn);
    row.appendChild(actions);
    calendarEventsListEl.appendChild(row);
  }
}

function openCalendarEventsModal(mesh) {
  calendarEventsTargetMesh = mesh;
  calendarEventsModalEl.classList.add('visible');
  openModalA11y(calendarEventsModalEl, closeCalendarEventsModal);
  renderCalendarEvents();
}
function closeCalendarEventsModal() {
  calendarEventsModalEl.classList.remove('visible');
  calendarEventsTargetMesh = null;
  closeModalA11y(calendarEventsModalEl);
}
calendarEventsCloseBtn.addEventListener('click', closeCalendarEventsModal);
calendarEventsUnflagBtn.addEventListener('click', async () => {
  if (!calendarEventsTargetMesh) return;
  const mesh = calendarEventsTargetMesh;
  mesh.userData.isCommunityCalendar = false;
  calendarEventsModalEl.classList.remove('visible');
  calendarEventsTargetMesh = null;
  closeModalA11y(calendarEventsModalEl);
  updateSelectionUI();
  persistLayout();
  await syncUpdate(mesh);
});

// Backup Chain (#2050/#2051, docs/API.md's "Placed instance backup
// chains") — an ordered, per-instance list of replacement products,
// auto-activated server-side the moment the active one sells out. Unlike
// Community Sign/Calendar above, every placed instance can have one (it's
// not gated behind some other flag), so this button always opens the same
// manage panel directly rather than toggling a flag first — see
// backupChainBtn's own disabled-only (no active state) line in
// updateSelectionUI.
const backupChainModalEl = document.getElementById('backup-chain-modal');
const backupChainCloseBtn = document.getElementById('backup-chain-close-btn');
const backupChainListEl = document.getElementById('backup-chain-list');
const backupChainEmptyEl = document.getElementById('backup-chain-empty');
const backupChainAddBtn = document.getElementById('backup-chain-add-btn');
let backupChainTargetMesh = null;
// Same stale-fetch guard idiom as signPostsLoadToken/calendarEventsLoadToken
// above.
let backupChainLoadToken = 0;

// #2051: the low-opacity placement/alignment reference the owner
// explicitly asked for ("when placing a backup product, the existing
// product should be visible in low opacity") — a second, independent
// rebuild of the currently-selected instance's own mesh at its own
// position, shown only while the catalog picker is open for a backup
// pick. Never added to productMeshes, so it's automatically never a
// raycast target for selection or the placement-click handler (both only
// ever check that array) — no separate "non-interactive" flag needed,
// same reasoning addBuildModeNeighborOutlines' own low-opacity overlay
// already relies on.
const BACKUP_REFERENCE_OPACITY = 0.35;
let backupReferenceMesh = null;

async function showBackupReferenceMesh(mesh) {
  hideBackupReferenceMesh();
  const reference = await createMeshForInstance({
    templateId: mesh.userData.template.templateId,
    x: mesh.position.x,
    y: mesh.position.y,
    z: mesh.position.z,
    rotationX: mesh.rotation.x,
    rotationY: mesh.rotation.y,
    rotationZ: mesh.rotation.z,
    crop: mesh.userData.crop,
    scale: mesh.userData.scale,
    label: mesh.userData.label,
  });
  if (!reference) return;
  // Same "traverse every part's material(s), including a multi-mesh
  // loaded GLTF" idiom as setShopAvatarOpacity — a product mesh can have
  // arbitrarily many parts, unlike a simple procedural box.
  reference.traverse((object) => {
    if (!object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      material.transparent = true;
      material.opacity = BACKUP_REFERENCE_OPACITY;
    }
  });
  // #2871: x/y/z above was copied straight from mesh.position (already
  // landletElevationGroup-local post-reparenting), so the reference needs
  // to live in that same group to render at the matching height.
  landletElevationGroup.add(reference);
  backupReferenceMesh = reference;
}

// Exported for src/catalog/picker.js (#2558) -- its own closeCatalogPicker
// needs this same cleanup when a Backup Chain pick session ends.
export function hideBackupReferenceMesh() {
  if (!backupReferenceMesh) return;
  landletElevationGroup.remove(backupReferenceMesh);
  disposeObject(backupReferenceMesh);
  backupReferenceMesh = null;
}
// #2051: e2e-only hook (same window.__test* convention as
// window.__testShopAvatarHasTransparentMaterial above) -- lets a test
// confirm the low-opacity placement reference actually appears while the
// catalog picker is open for a backup pick, and is gone again once it
// closes, without needing to read raw WebGL pixels. Always inert unless a
// test calls it.
window.__testBackupReferenceMeshVisible = () => backupReferenceMesh !== null;

function formatInstanceBackupTemplateName(templateId) {
  return findTemplate(templateId)?.name ?? templateId;
}

async function renderBackupChain() {
  backupChainListEl.innerHTML = '';
  if (!backupChainTargetMesh) return;
  const myLoadToken = ++backupChainLoadToken;
  const instanceId = backupChainTargetMesh.userData.instanceId;
  let backups;
  try {
    ({ backups } = await fetchInstanceBackups(instanceId));
  } catch (err) {
    if (myLoadToken !== backupChainLoadToken) return; // superseded while fetching
    backupChainEmptyEl.textContent = err.message || 'Could not load the backup chain.';
    backupChainEmptyEl.hidden = false;
    return;
  }
  if (myLoadToken !== backupChainLoadToken) return; // superseded — a newer call owns the list now
  // #1128-style reset-on-success: without this, a past fetch failure
  // leaves this stuck on its error message forever, even once a later
  // load succeeds with an empty (but genuinely empty) chain.
  backupChainEmptyEl.textContent = 'No backups configured yet.';
  backupChainEmptyEl.hidden = backups.length > 0;
  backups.forEach((backup, index) => {
    const row = document.createElement('div');
    row.className = 'backup-chain-row';
    const name = document.createElement('span');
    name.className = 'backup-chain-row-name';
    name.textContent = `${index + 1}. ${formatInstanceBackupTemplateName(backup.templateId)}`;
    row.appendChild(name);
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'backup-chain-row-up';
    upBtn.textContent = '▲';
    upBtn.setAttribute('aria-label', 'Move up in the chain');
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => reorderBackupChainRow(backups, index, index - 1));
    row.appendChild(upBtn);
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'backup-chain-row-down';
    downBtn.textContent = '▼';
    downBtn.setAttribute('aria-label', 'Move down in the chain');
    downBtn.disabled = index === backups.length - 1;
    downBtn.addEventListener('click', () => reorderBackupChainRow(backups, index, index + 1));
    row.appendChild(downBtn);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'backup-chain-row-remove';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', 'Remove backup');
    removeBtn.addEventListener('click', async () => {
      if (!confirm('Remove this backup? This can\'t be undone.')) return;
      removeBtn.disabled = true;
      try {
        await deleteInstanceBackup(instanceId, backup.backupId);
        await renderBackupChain();
      } catch (err) {
        alert(err.message || 'Could not remove this backup.');
        // #2969: re-render instead of just re-enabling the button -- a
        // concurrent delete of this same backup (a second open copy of
        // this panel) is exactly the kind of failure this alert fires
        // for, and leaving the stale row in place just repeats the same
        // dead-end delete on every retry. Same fix #2963/metadataModals.js's
        // sign-posts/calendar-events handlers already got.
        await renderBackupChain();
      }
    });
    row.appendChild(removeBtn);
    backupChainListEl.appendChild(row);
  });
}

async function reorderBackupChainRow(backups, fromIndex, toIndex) {
  const reordered = [...backups];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);
  const instanceId = backupChainTargetMesh.userData.instanceId;
  // Every row's Up/Down button closes over this same `backups` snapshot, so
  // a second reorder click anywhere in the list (same row or a different
  // one) before this request resolves would compute its own move against
  // the same now-stale ordering -- reorderInstanceBackups is a full-replace
  // PUT, so whichever response lands last would silently discard the other.
  // Disabling every currently-enabled button for the duration (restoring
  // only those, not a row's own boundary-disabled Up/Down) closes that
  // window the same way removeBtn's own disable-during-await already does.
  const buttonsToRestore = [...backupChainListEl.querySelectorAll('button:not(:disabled)')];
  buttonsToRestore.forEach((btn) => { btn.disabled = true; });
  try {
    await reorderInstanceBackups(instanceId, reordered.map((backup) => backup.backupId));
    await renderBackupChain();
  } catch (err) {
    alert(err.message || 'Could not reorder the backup chain.');
    // #2969: re-render instead of just re-enabling the buttons -- see
    // removeBtn's own handler above. A concurrent delete of one of these
    // backups (a second open copy of this panel) would 409 this full-
    // replace reorder, and simply re-enabling buttons against the now-
    // stale `backups` list this closure captured would let every retry
    // keep targeting a backup_id that no longer exists.
    await renderBackupChain();
  }
}

function openBackupChainModal(mesh) {
  backupChainTargetMesh = mesh;
  backupChainModalEl.classList.add('visible');
  openModalA11y(backupChainModalEl, closeBackupChainModal);
  renderBackupChain();
}
function closeBackupChainModal() {
  backupChainModalEl.classList.remove('visible');
  backupChainTargetMesh = null;
  hideBackupReferenceMesh();
  closeModalA11y(backupChainModalEl);
}
backupChainCloseBtn.addEventListener('click', closeBackupChainModal);
backupChainBtn.addEventListener('click', () => {
  if (selectedMeshes.size !== 1) return;
  const [mesh] = selectedMeshes;
  openBackupChainModal(mesh);
});
backupChainAddBtn.addEventListener('click', async () => {
  if (!backupChainTargetMesh) return;
  const mesh = backupChainTargetMesh;
  const instanceId = mesh.userData.instanceId;
  closeBackupChainModal();
  await showBackupReferenceMesh(mesh);
  openCatalogPickerForPick(
    async (template) => {
      try {
        await addInstanceBackup(instanceId, { templateId: template.templateId });
        await renderBackupChain();
      } catch (err) {
        alert(err.message || 'Could not add this backup.');
      }
    },
    () => openBackupChainModal(mesh),
  );
});
