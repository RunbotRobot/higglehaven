// #2842 (sub-issue of #2841): jurisdiction-keyed tax education content --
// admin CRUD + the reviewed_at/reviewed_by gate. Same apiFetch/escapeHtml/
// monotonic-load-token shape as every other panel's own script above.
(function () {
  const errLine = document.getElementById('taxEducationErr');
  const tableWrap = document.getElementById('taxEducationTableWrap');
  const countryFilterInput = document.getElementById('taxEducationCountryFilterInput');
  const editWrap = document.getElementById('taxEducationEditWrap');
  const editTitle = document.getElementById('taxEducationEditTitle');
  const countryInput = document.getElementById('taxEducationCountryInput');
  const stateInput = document.getElementById('taxEducationStateInput');
  const titleInput = document.getElementById('taxEducationTitleInput');
  const bodyInput = document.getElementById('taxEducationBodyInput');
  let editingId = null;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function clearError() { errLine.hidden = true; errLine.textContent = ''; }
  function showError(message) { errLine.hidden = false; errLine.textContent = message; }

  async function apiFetch(path, options) {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options && options.headers) },
    });
    let body = null;
    try { body = await response.json(); } catch (_) { /* no body */ }
    if (!response.ok) throw new Error((body && body.error) || ('Request failed (' + response.status + ')'));
    return body;
  }

  let loadToken = 0;

  async function loadEntries() {
    const myToken = ++loadToken;
    clearError();
    tableWrap.innerHTML = '<p class="empty">Loading…</p>';
    const countryCode = countryFilterInput.value.trim();
    const query = countryCode ? ('?countryCode=' + encodeURIComponent(countryCode)) : '';
    let body;
    try {
      body = await apiFetch('/api/tax-education' + query);
    } catch (error) {
      if (myToken !== loadToken) return;
      showError(error.message);
      tableWrap.innerHTML = '<p class="empty">Failed to load.</p>';
      return;
    }
    if (myToken !== loadToken) return;
    renderEntries(body.entries || []);
  }

  function renderEntries(entries) {
    if (!entries.length) {
      tableWrap.innerHTML = '<p class="empty">No entries.</p>';
      return;
    }
    const rows = entries.map((entry) => `
      <tr>
        <td>${escapeHtml(entry.countryCode)}${entry.stateCode ? '-' + escapeHtml(entry.stateCode) : ''}</td>
        <td>${escapeHtml(entry.title)}</td>
        <td>${entry.reviewed ? 'Reviewed (' + escapeHtml(entry.reviewedBy) + ')' : 'Not reviewed'}</td>
        <td>
          <button class="secondary edit-btn" data-id="${escapeHtml(entry.id)}">Edit</button>
          <button class="secondary review-btn" data-id="${escapeHtml(entry.id)}" data-reviewed="${entry.reviewed ? '1' : '0'}">${entry.reviewed ? 'Un-review' : 'Mark reviewed'}</button>
          <button class="secondary delete-btn" data-id="${escapeHtml(entry.id)}">Delete</button>
        </td>
      </tr>
    `).join('');
    tableWrap.innerHTML = `
      <table>
        <thead><tr><th>Jurisdiction</th><th>Title</th><th>Review status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    tableWrap.querySelectorAll('.edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => openEdit(btn.dataset.id, entries.find((e) => e.id === btn.dataset.id)));
    });
    tableWrap.querySelectorAll('.review-btn').forEach((btn) => {
      btn.addEventListener('click', () => setReviewed(btn.dataset.id, btn.dataset.reviewed !== '1'));
    });
    tableWrap.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => deleteEntry(btn.dataset.id));
    });
  }

  function openNew() {
    editingId = null;
    editTitle.textContent = 'New entry';
    countryInput.value = '';
    stateInput.value = '';
    titleInput.value = '';
    bodyInput.value = '';
    editWrap.hidden = false;
  }

  function openEdit(id, entry) {
    editingId = id;
    editTitle.textContent = 'Edit entry';
    countryInput.value = entry ? entry.countryCode : '';
    stateInput.value = (entry && entry.stateCode) || '';
    titleInput.value = entry ? entry.title : '';
    bodyInput.value = entry ? entry.body : '';
    editWrap.hidden = false;
  }

  function closeEdit() {
    editingId = null;
    editWrap.hidden = true;
  }

  async function saveEntry() {
    clearError();
    const payload = {
      countryCode: countryInput.value.trim(),
      stateCode: stateInput.value.trim() || null,
      title: titleInput.value.trim(),
      body: bodyInput.value,
    };
    try {
      if (editingId) {
        await apiFetch('/api/tax-education/' + encodeURIComponent(editingId), { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await apiFetch('/api/tax-education', { method: 'POST', body: JSON.stringify(payload) });
      }
    } catch (error) {
      showError(error.message);
      return;
    }
    closeEdit();
    loadEntries();
  }

  async function setReviewed(id, reviewed) {
    clearError();
    try {
      await apiFetch('/api/tax-education/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ reviewed }) });
    } catch (error) {
      showError(error.message);
      return;
    }
    loadEntries();
  }

  async function deleteEntry(id) {
    if (!confirm('Delete this entry?')) return;
    clearError();
    try {
      await apiFetch('/api/tax-education/' + encodeURIComponent(id), { method: 'DELETE' });
    } catch (error) {
      showError(error.message);
      return;
    }
    loadEntries();
  }

  document.getElementById('taxEducationRefreshBtn').addEventListener('click', loadEntries);
  document.getElementById('taxEducationNewBtn').addEventListener('click', openNew);
  document.getElementById('taxEducationSaveBtn').addEventListener('click', saveEntry);
  document.getElementById('taxEducationEditCancelBtn').addEventListener('click', closeEdit);
  countryFilterInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadEntries(); });

  loadEntries();
})();
