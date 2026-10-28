// #2565 (leaf of #2504/#2500's src/main.js module split, see #2503's design
// comment for the full dependency map): the Settings modal's chrome (DOM
// refs, tab dispatcher, open/close) plus the General tab now live here,
// extracted wholesale from src/main.js. Per the owner's Option A decision
// (2026-10-28, posted on #2565): each per-mode section is owned by its own
// feature module -- renderShopSettingsSection (src/shop/mode.js),
// renderBuildSettingsSection (src/build/scene.js), renderSellSettingsSection
// (src/sell/mode.js) -- and renderSettingsSection below just calls into
// each rather than reaching into their state directly. This module stays a
// thin chrome shell.
//
// renderIdentityField is a generic helper (kind/fetchProfile/renameProfile/
// deleteProfile/deleteWarning/onDeleted/onRenamed) shared by both Build's
// renderBuilderIdentityField and Sell's renderSellerIdentityField -- lives
// here (it reads/writes justDeletedIdentityKind and calls renderSettingsSection
// on delete, both chrome-owned) and is exported for those two modules to
// import.
//
// settingsRenderToken is read (never written) by every per-mode section
// below General's own helpers -- exported as a live `let` binding, same
// shape world/state.js's own builderId/currentLandletId already establish
// for cross-module state only one module ever writes.
//
// trimUnitLabelEls stays declared in main.js (it also needs an independent,
// Settings-unrelated initial paint there at load) -- exported, imported
// back here for refreshUnitDisplays' own repaint.
import { openModalA11y, closeModalA11y } from '../ui/modal.js';
import { getUnits, setUnits, unitSuffix } from '../settings.js';
import { currentMode } from '../world/state.js';
import { currentAuthUser, setCurrentAuthUser } from '../account/auth.js';
import { fetchMyTaxEducation, fetchNotificationPreferences, updateNotificationPreferences, submitTaxIdForm } from '../api.js';
import {
  updateTrimLengthInput, measurePointA, measurePointB, updateMeasureResultText,
} from '../build/scene.js';
import { sellerModalEl, renderActiveSellerView } from '../sell/mode.js';
import { trimUnitLabelEls } from '../main.js';
import { renderShopSettingsSection } from '../shop/mode.js';
import { renderBuildSettingsSection } from '../build/scene.js';
import { renderSellSettingsSection } from '../sell/mode.js';

// Settings: local, per-device display preferences — nothing here is ever
// sent to the server (see settings.js). Four sections exist as fixed tabs
// per the product ask even though only General/Units has a real setting
// today; Shop/Build/Sell show a placeholder rather than inventing controls
// nobody asked for yet.
const settingsModalEl = document.getElementById('settings-modal');
const settingsTabsEl = document.getElementById('settings-tabs');
export const settingsSectionEl = document.getElementById('settings-section');
const settingsBtn = document.getElementById('settings-btn');
const settingsCloseBtn = document.getElementById('settings-close-btn');

let activeSettingsTab = 'general';

// #1124: set right before renderSettingsSection() redraws the tab a
// Delete Account click just fired from, so the freshly re-rendered
// identity field (renderIdentityField below) can still show its own
// "Deleted" confirmation even though the DOM node that would have shown
// it got torn down along with everything else in the tab. Consumed
// (cleared) by the one renderIdentityField call whose kind matches, so a
// later, unrelated render never picks it up.
let justDeletedIdentityKind = null;

// #905: renderLandCapField/renderRedeemHigglesField/renderAuctionSection
// each await ensureBuilderIdentity() (a real network round-trip whenever
// Settings was opened from Shop mode before Build mode ever established
// builderId) before appending their own content to settingsSectionEl —
// but switching tabs (or reopening the modal) is synchronous and
// unconditional, so a tab switch mid-await let a since-superseded call's
// financially-relevant controls (Redeem Higgles, Start Auction) land on
// whatever tab is now showing. Bumped once per renderSettingsSection()
// call (covers both a tab click and a modal reopen, since both call it);
// same generation-counter idiom notificationsLoadToken/landletRenderToken
// already use elsewhere for the identical shape of race. Exported as a
// live binding — every per-mode section's own render function (Build/Sell,
// plus this module's own General-tab helpers) reads it, never writes it.
export let settingsRenderToken = 0;

// Called whenever the Units preference changes, so every on-screen length
// reflects it immediately rather than only after the next selection change
// or modal reopen.
function refreshUnitDisplays() {
  for (const el of trimUnitLabelEls) el.textContent = unitSuffix();
  updateTrimLengthInput();
  // #1939: the Measure tool's own live readout is unit-dependent (formatLength)
  // but was never covered here, unlike its sibling updateTrimLengthInput().
  if (measurePointA && measurePointB) updateMeasureResultText();
  if (sellerModalEl.classList.contains('visible')) renderActiveSellerView();
}

export function renderSettingsSection() {
  settingsRenderToken += 1;
  settingsSectionEl.innerHTML = '';
  for (const btn of settingsTabsEl.querySelectorAll('.settings-tab-btn')) {
    btn.classList.toggle('active', btn.dataset.section === activeSettingsTab);
    btn.setAttribute('aria-pressed', String(btn.dataset.section === activeSettingsTab));
  }

  if (activeSettingsTab === 'general') {
    renderGeneralSettingsSection();
    return;
  }
  if (activeSettingsTab === 'shop') {
    renderShopSettingsSection();
    return;
  }
  if (activeSettingsTab === 'build') {
    renderBuildSettingsSection();
    return;
  }
  if (activeSettingsTab === 'sell') {
    renderSellSettingsSection();
    return;
  }

  const note = document.createElement('div');
  note.className = 'settings-empty-note';
  note.textContent = 'Nothing to configure here yet.';
  settingsSectionEl.appendChild(note);
}

// Shown in Settings' General tab rather than an always-on-screen HUD
// overlay — decluttering the main view, now that it's the only way to
// read/copy exactly which commit is deployed.
const BUILD_INFO_TEXT = `build ${__BUILD_COMMIT__} · ${__BUILD_TIME__}`;

function renderGeneralSettingsSection() {
  const field = document.createElement('div');
  field.className = 'settings-field';
  const fieldLabel = document.createElement('span');
  fieldLabel.textContent = 'Units';
  field.appendChild(fieldLabel);

  const radioRow = document.createElement('div');
  radioRow.className = 'settings-radio-row';
  const currentUnits = getUnits();
  for (const [value, optionLabel] of [['m', 'Meters'], ['ft', 'Feet']]) {
    const optionLabelEl = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'settings-units';
    radio.value = value;
    radio.checked = currentUnits === value;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      setUnits(value);
      refreshUnitDisplays();
    });
    optionLabelEl.appendChild(radio);
    optionLabelEl.appendChild(document.createTextNode(optionLabel));
    radioRow.appendChild(optionLabelEl);
  }
  field.appendChild(radioRow);
  settingsSectionEl.appendChild(field);

  const versionField = document.createElement('div');
  versionField.className = 'settings-field';
  const versionLabel = document.createElement('span');
  versionLabel.textContent = 'Version';
  versionField.appendChild(versionLabel);
  const versionValue = document.createElement('div');
  versionValue.className = 'settings-empty-note';
  versionValue.textContent = BUILD_INFO_TEXT;
  versionField.appendChild(versionValue);
  settingsSectionEl.appendChild(versionField);

  renderTaxPaperworkField();
  renderTaxEducationField();
  renderNotificationPreferencesField();
}

// #2843 (sub-issue of #2841, docs/SPEC.md §7): general, jurisdiction-
// matched tax info (not advice) — read-only, right below the tax
// paperwork field above since the jurisdiction match comes from that same
// on-file W-9/W-8BEN. Same async-field-in-General shape as
// renderNotificationPreferencesField below (currentAuthUser-gated,
// settingsRenderToken-guarded against a tab switch/modal reopen racing
// the fetch).
async function renderTaxEducationField() {
  if (!currentAuthUser) return;
  const myToken = settingsRenderToken;

  const field = document.createElement('div');
  field.className = 'settings-field';
  const fieldLabel = document.createElement('span');
  fieldLabel.textContent = 'Tax Education';
  field.appendChild(fieldLabel);
  const status = document.createElement('div');
  status.className = 'settings-empty-note';
  status.textContent = 'Loading…';
  field.appendChild(status);
  settingsSectionEl.appendChild(field);

  let result;
  try {
    result = await fetchMyTaxEducation();
  } catch (err) {
    status.textContent = err.message || 'Could not load tax education content.';
    status.classList.add('error');
    return;
  }
  if (myToken !== settingsRenderToken) return;

  if (!result.jurisdiction) {
    // #2858/e2e fallout: deliberately avoids the substring "tax paperwork"
    // (case-insensitive) -- e2e/tax-paperwork-settings.test.mjs's own
    // `taxField` locator matches every .settings-field whose text contains
    // that phrase (it already relies on this to reach the submit button's
    // own "Submit tax paperwork" label via .last()), so this field's own
    // status text can't contain it too without becoming a second/third
    // match that locator's own .last() would then pick up instead of the
    // real form-submission status it's checking.
    status.textContent = 'Submit the form above to see general tax info for your jurisdiction.';
    return;
  }
  if (!result.entries.length) {
    status.textContent = 'No general tax info is available for your jurisdiction yet.';
    return;
  }
  field.removeChild(status);

  const note = document.createElement('div');
  note.className = 'settings-empty-note';
  note.textContent = 'General information only — not personalized tax advice.';
  field.appendChild(note);

  for (const entry of result.entries) {
    const entryWrap = document.createElement('details');
    entryWrap.className = 'tax-education-entry';
    const summary = document.createElement('summary');
    summary.textContent = entry.title;
    entryWrap.appendChild(summary);
    const body = document.createElement('p');
    body.textContent = entry.body;
    entryWrap.appendChild(body);
    field.appendChild(entryWrap);
  }
}

// #2067 (leaf sub-issue of #1973, part of #1947): account-level opt-in
// for an email alert on top of the dashboard notification already fired
// unconditionally when one of this builder's placed products sells out.
// Same async-field-in-General shape as renderTaxPaperworkField just
// above (currentAuthUser-gated, settingsRenderToken-guarded against a
// tab switch/modal reopen racing the fetch).
async function renderNotificationPreferencesField() {
  if (!currentAuthUser) return;
  const myToken = settingsRenderToken;

  const field = document.createElement('div');
  field.className = 'settings-field';
  const fieldLabel = document.createElement('span');
  fieldLabel.textContent = 'Notifications';
  field.appendChild(fieldLabel);
  const status = document.createElement('div');
  status.className = 'settings-empty-note';
  status.textContent = 'Loading…';
  field.appendChild(status);
  settingsSectionEl.appendChild(field);

  let prefs;
  try {
    prefs = await fetchNotificationPreferences();
  } catch (err) {
    status.textContent = err.message || 'Could not load your notification preferences.';
    status.classList.add('error');
    return;
  }
  if (myToken !== settingsRenderToken) return;
  field.removeChild(status);

  const row = document.createElement('div');
  row.className = 'settings-radio-row';
  const labelEl = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = !!prefs.notifySoldOutEmail;
  checkbox.addEventListener('change', async () => {
    const desired = checkbox.checked;
    checkbox.disabled = true;
    try {
      await updateNotificationPreferences({ notifySoldOutEmail: desired });
    } catch (err) {
      checkbox.checked = !desired;
      alert(err.message || 'Could not update this preference.');
    } finally {
      checkbox.disabled = false;
    }
  });
  labelEl.appendChild(checkbox);
  labelEl.appendChild(document.createTextNode('Email me when one of my placed products sells out'));
  row.appendChild(labelEl);
  field.appendChild(row);

  const note = document.createElement('div');
  note.className = 'settings-empty-note';
  note.textContent = 'You always get a dashboard notification when this happens — this adds an email on top.';
  field.appendChild(note);
}

// #614: POST /api/tax/id-form (W-9/W-8BEN collection) has existed on the
// backend since #621, and the earnings-threshold gate that actually blocks
// redemption/payout without it (#615) has been live just as long — but
// nothing in this file ever called the submission endpoint, leaving a real
// account with no in-app way to unblock itself once it crosses the
// threshold (worker/index.js's taxThresholdPayoutBlockedError literally
// tells the user to call the raw API). Lives in General (not Build/Sell)
// since the combined threshold spans both a builder's higgles commissions
// and a seller's real-money payouts.
async function renderTaxPaperworkField() {
  if (!currentAuthUser) return;

  const statusField = document.createElement('div');
  statusField.className = 'settings-field';
  const statusLabel = document.createElement('span');
  statusLabel.textContent = 'Tax Paperwork';
  statusField.appendChild(statusLabel);
  const statusNote = document.createElement('div');
  statusNote.className = 'settings-empty-note';
  statusNote.setAttribute('role', 'status');
  statusNote.setAttribute('aria-live', 'polite');
  statusField.appendChild(statusNote);
  settingsSectionEl.appendChild(statusField);

  function refreshStatusNote() {
    if (currentAuthUser.taxFormType) {
      const formLabel = currentAuthUser.taxFormType === 'w9' ? 'W-9' : 'W-8BEN';
      const completedDate = new Date(currentAuthUser.taxFormCompletedAt).toLocaleDateString();
      statusNote.textContent = `${formLabel} on file since ${completedDate}. Submitting again below replaces it.`;
    } else {
      statusNote.textContent = 'No tax paperwork on file yet — required once your combined earnings ' +
        'cross this year\'s reporting threshold (see the account menu\'s own notice for where you stand).';
    }
  }
  refreshStatusNote();

  const formField = document.createElement('div');
  formField.className = 'settings-field';
  settingsSectionEl.appendChild(formField);

  const typeRow = document.createElement('div');
  typeRow.className = 'settings-radio-row';
  const typeInputs = {};
  for (const [value, optionLabel] of [['w9', 'W-9 (US person)'], ['w8ben', 'W-8BEN (non-US person)']]) {
    const optionLabelEl = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'tax-form-type';
    radio.value = value;
    radio.checked = (currentAuthUser.taxFormType || 'w9') === value;
    optionLabelEl.appendChild(radio);
    optionLabelEl.appendChild(document.createTextNode(optionLabel));
    typeRow.appendChild(optionLabelEl);
    typeInputs[value] = radio;
  }
  formField.appendChild(typeRow);

  // #2344: maxLength here mirrors this form's own server-side caps --
  // legalName/addressLine1 go through taxFormTextValue's 200-char
  // MAX_TAX_FORM_TEXT_LENGTH, every other field through labelValue's
  // 100-char MAX_LABEL_LENGTH (worker/index.js's validateTaxIdForm).
  const commonFields = [
    ['legalName', 'Legal name', 'text', 200],
    ['addressLine1', 'Street address', 'text', 200],
    ['city', 'City', 'text', 100],
  ];
  const w9Fields = [
    ['state', 'State', 'text', 100],
    ['postalCode', 'ZIP code', 'text', 100],
    ['taxIdNumber', 'SSN or EIN', 'text', 100],
  ];
  const w8benFields = [
    ['country', 'Country', 'text', 100],
    ['countryOfCitizenship', 'Country of citizenship', 'text', 100],
    ['foreignTaxId', 'Foreign tax ID', 'text', 100],
  ];
  const form = document.createElement('div');
  form.className = 'stripe-onboarding-form';
  const inputs = {};
  function addFormInputs(specs) {
    const labels = [];
    for (const [key, fieldLabel, type, maxLength] of specs) {
      const label = document.createElement('label');
      label.textContent = fieldLabel;
      const input = document.createElement('input');
      input.type = type;
      input.maxLength = maxLength;
      label.appendChild(input);
      form.appendChild(label);
      inputs[key] = input;
      labels.push(label);
    }
    return labels;
  }
  addFormInputs(commonFields);
  const w9Labels = addFormInputs(w9Fields);
  const w8benLabels = addFormInputs(w8benFields);

  function refreshFieldVisibility() {
    const isW9 = typeInputs.w9.checked;
    for (const label of w9Labels) label.hidden = !isW9;
    for (const label of w8benLabels) label.hidden = isW9;
  }
  refreshFieldVisibility();
  typeInputs.w9.addEventListener('change', refreshFieldVisibility);
  typeInputs.w8ben.addEventListener('change', refreshFieldVisibility);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'version-action-btn';
  submitBtn.textContent = currentAuthUser.taxFormType ? 'Update tax paperwork' : 'Submit tax paperwork';
  form.appendChild(submitBtn);
  const formStatus = document.createElement('div');
  formStatus.className = 'settings-empty-note';
  form.appendChild(formStatus);

  submitBtn.addEventListener('click', async () => {
    formStatus.textContent = '';
    formStatus.classList.remove('error');
    submitBtn.disabled = true;
    try {
      const formType = typeInputs.w9.checked ? 'w9' : 'w8ben';
      const specificFields = formType === 'w9' ? w9Fields : w8benFields;
      const payload = { formType };
      for (const [key] of commonFields) payload[key] = inputs[key].value;
      for (const [key] of specificFields) payload[key] = inputs[key].value;
      const result = await submitTaxIdForm(payload);
      setCurrentAuthUser({ ...currentAuthUser, taxFormType: result.taxFormType, taxFormCompletedAt: result.taxFormCompletedAt });
      refreshStatusNote();
      submitBtn.textContent = 'Update tax paperwork';
      formStatus.textContent = 'Submitted.';
    } catch (err) {
      formStatus.textContent = err.message || 'Could not submit — check the fields above.';
      formStatus.classList.add('error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  formField.appendChild(form);
}

// #724: renameBuilder/deleteBuilder/renameSeller had real, working,
// documented backend endpoints (docs/API.md's "Builders"/"Sellers") but no
// UI ever called any of them. Shared between the Build and Sell settings
// tabs since a builder identity and a seller identity work identically
// here — only the fetch/rename/delete calls and the delete warning differ.
// Exported for src/build/scene.js's renderBuilderIdentityField and
// src/sell/mode.js's renderSellerIdentityField (#2565) -- lives here rather
// than either of those modules since it reads/writes justDeletedIdentityKind
// and calls renderSettingsSection, both chrome-owned.
export async function renderIdentityField(kind, { fetchProfile, idKey, renameProfile, deleteProfile, deleteWarning, onDeleted, onRenamed }) {
  const field = document.createElement('div');
  field.className = 'settings-field';
  const label = document.createElement('span');
  label.textContent = `${kind} Identity`;
  field.appendChild(label);
  const status = document.createElement('div');
  status.className = 'settings-empty-note';
  status.textContent = 'Loading…';
  field.appendChild(status);
  settingsSectionEl.appendChild(field);

  let profile;
  try {
    profile = await fetchProfile();
  } catch (err) {
    status.textContent = err.message || `Could not load your ${kind.toLowerCase()} identity.`;
    status.classList.add('error');
    return;
  }

  const nameRow = document.createElement('div');
  field.insertBefore(nameRow, status);

  const actions = document.createElement('div');
  actions.className = 'version-row-actions';
  field.insertBefore(actions, status);

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'version-action-btn';
  renameBtn.textContent = 'Rename';
  actions.appendChild(renameBtn);

  const deleteBtn = document.createElement('button');
  if (deleteProfile) {
    deleteBtn.type = 'button';
    deleteBtn.className = 'version-action-btn';
    // #1149: this used to say "Delete Account," which was never true — it
    // only ever reset this one profile (land/build/balance released, a
    // fresh profile auto-created), while the real login account kept
    // working the whole time. Real account deletion now lives in the
    // Account panel (see auth-delete-account-btn); this stays what it
    // always actually was, just honestly labeled.
    deleteBtn.textContent = 'Reset Profile';
    actions.appendChild(deleteBtn);
  }

  function renderName() {
    nameRow.textContent = profile.label;
  }
  renderName();
  // #1124: this render may be the one renderSettingsSection() triggered
  // right after a Reset Profile click redrew the whole tab — if so, show
  // the same confirmation the old, identity-field-only refresh used to,
  // rather than a blank status now that a fresh profile (not the deleted
  // one) is what fetchProfile() above actually returned.
  if (justDeletedIdentityKind === kind) {
    justDeletedIdentityKind = null;
    status.textContent = `Reset — a fresh ${kind.toLowerCase()} identity was created.`;
  } else {
    status.textContent = '';
  }

  renameBtn.addEventListener('click', async () => {
    const next = prompt(`Rename your ${kind.toLowerCase()} identity`, profile.label);
    if (!next || !next.trim() || next.trim() === profile.label) return;
    if (next.trim().length > 100) {
      alert('Keep it to 100 characters or fewer.');
      return;
    }
    status.textContent = '';
    status.classList.remove('error');
    renameBtn.disabled = true;
    try {
      profile = await renameProfile(profile[idKey], next.trim());
      renderName();
      // #741: shopBuilderLabels (a Shop-mode-only cache) has no other way
      // to learn about a rename that happens mid-session — let the caller
      // patch whatever cache it keeps, same shape as onDeleted above.
      onRenamed?.(profile[idKey], profile.label);
    } catch (err) {
      status.textContent = err.message || 'Could not rename.';
      status.classList.add('error');
    } finally {
      renameBtn.disabled = false;
    }
  });

  if (deleteProfile) {
    deleteBtn.addEventListener('click', async () => {
      // #740: deleteWarning may be a function of the current profile (e.g.
      // to disclose a real-money-backed balance that's about to be
      // forfeited) rather than a fixed string — resolved fresh on every
      // click since `profile` can have changed since renderIdentityField
      // was first called.
      const warningText = typeof deleteWarning === 'function' ? deleteWarning(profile) : deleteWarning;
      if (!confirm(warningText)) return;
      status.textContent = '';
      status.classList.remove('error');
      deleteBtn.disabled = true;
      try {
        await deleteProfile(profile[idKey]);
        // #738: the caller's cached module-level id (builderId/sellerId)
        // must be cleared here, before fetchProfile() re-provisions a
        // fresh identity server-side -- ensureBuilderIdentity()'s own
        // `if (builderId) return builderId;` short-circuit would otherwise
        // keep every later action (claim, bid, build) pinned to the
        // just-deleted, now-nonexistent id until a full page reload.
        onDeleted?.();
        // #1124: Land Cap/Redeem Higgles/Active Auctions (Build tab) and
        // Payout Account (Sell tab) each fetch their own data once at
        // tab-render time and never re-fetch on their own — patching only
        // this field's own nameRow/status (the old behavior) left them
        // showing the just-deleted identity's stale figures. A full
        // renderSettingsSection() redraw — the same thing a manual tab
        // switch already triggers — is what actually refreshes every
        // sibling field against the fresh, auto-provisioned identity, not
        // just this one.
        justDeletedIdentityKind = kind;
        renderSettingsSection();
        return;
      } catch (err) {
        status.textContent = err.message || 'Could not delete.';
        status.classList.add('error');
      } finally {
        deleteBtn.disabled = false;
      }
    });
  }
}

// Owner (Control Room feedback): "When a user opens the menu, it should
// default to the menu tab of the site tab they're already in (Shop,
// Build, or Sell)." activeSettingsTab used to just persist whatever tab
// was last clicked (starting at 'general'), so opening Settings from
// Build mode after a previous session left it on e.g. Shop showed the
// wrong tab first. currentMode's own values ('shop'/'build'/'sell')
// match the settings-tab-btn dataset values exactly.
export function openSettingsModal() {
  if (currentMode === 'shop' || currentMode === 'build' || currentMode === 'sell') {
    activeSettingsTab = currentMode;
  }
  renderSettingsSection();
  settingsModalEl.classList.add('visible');
  openModalA11y(settingsModalEl, closeSettingsModal);
}
export function closeSettingsModal() {
  settingsModalEl.classList.remove('visible');
  closeModalA11y(settingsModalEl);
}
settingsBtn.addEventListener('click', openSettingsModal);
settingsCloseBtn.addEventListener('click', closeSettingsModal);

for (const btn of settingsTabsEl.querySelectorAll('.settings-tab-btn')) {
  btn.addEventListener('click', () => {
    activeSettingsTab = btn.dataset.section;
    renderSettingsSection();
  });
}
