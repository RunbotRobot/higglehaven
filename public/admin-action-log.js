(function () {
  const statusLine = document.getElementById('statusLine');
  const errLine = document.getElementById('errLine');
  const tableWrap = document.getElementById('tableWrap');
  const actionTypeInput = document.querySelector('input[name="actionType"]');
  const targetTypeInput = document.querySelector('input[name="targetType"]');
  const adminUserIdInput = document.querySelector('input[name="adminUserId"]');
  const targetIdInput = document.querySelector('input[name="targetId"]');

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function clearError() {
    errLine.hidden = true;
    errLine.textContent = '';
  }

  // #1857: a slower, overlapping load() (e.g. an earlier filter whose
  // request is still in flight) could otherwise land after a faster, newer
  // one and silently overwrite the table with stale rows -- same
  // monotonic-token guard src/main.js already uses everywhere a refetch can
  // race another one (bundlePickerLoadToken, dmLoadToken, friendsLoadToken).
  let loadToken = 0;

  async function load() {
    const myLoadToken = ++loadToken;
    clearError();
    statusLine.textContent = 'Loading…';
    const params = new URLSearchParams();
    if (actionTypeInput.value.trim()) params.set('actionType', actionTypeInput.value.trim());
    if (targetTypeInput.value.trim()) params.set('targetType', targetTypeInput.value.trim());
    if (adminUserIdInput.value.trim()) params.set('adminUserId', adminUserIdInput.value.trim());
    if (targetIdInput.value.trim()) params.set('targetId', targetIdInput.value.trim());
    const query = params.toString();
    let body;
    try {
      const response = await fetch('/api/admin-action-log' + (query ? '?' + query : ''), {
        headers: { 'content-type': 'application/json' },
      });
      try { body = await response.json(); } catch (_) { body = null; }
      if (!response.ok) throw new Error((body && body.error) || ('Request failed (' + response.status + ')'));
    } catch (error) {
      if (myLoadToken !== loadToken) return;
      errLine.hidden = false;
      errLine.textContent = error.message;
      statusLine.textContent = 'Failed to load.';
      return;
    }
    if (myLoadToken !== loadToken) return;
    render(body);
  }

  function render(body) {
    const entries = body.entries || [];
    // Up to 500 most-recent entries, same capped-list shape as the
    // Control Room task list -- entries.length can legitimately be less
    // than total (an older entry outside the cap), same distinction that
    // page's own header line makes.
    statusLine.textContent = entries.length + ' shown · ' + body.total + ' total';
    if (!entries.length) {
      tableWrap.innerHTML = '<p class="empty">No matching admin actions.</p>';
      return;
    }
    const rows = entries.map((entry) => `
      <tr>
        <td>${escapeHtml(entry.createdAt)}</td>
        <td>${escapeHtml(entry.adminUserId || '—')}</td>
        <td>${escapeHtml(entry.actionType)}</td>
        <td>${escapeHtml(entry.targetType || '—')}</td>
        <td>${escapeHtml(entry.targetId || '—')}</td>
        <td class="detail">${entry.detail ? escapeHtml(JSON.stringify(entry.detail)) : ''}</td>
      </tr>
    `).join('');
    tableWrap.innerHTML = `
      <table>
        <thead>
          <tr><th>When</th><th>Admin</th><th>Action</th><th>Target type</th><th>Target id</th><th>Detail</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  document.getElementById('filterBtn').addEventListener('click', load);
  document.getElementById('refreshBtn').addEventListener('click', load);
  document.getElementById('clearBtn').addEventListener('click', () => {
    actionTypeInput.value = '';
    targetTypeInput.value = '';
    adminUserIdInput.value = '';
    targetIdInput.value = '';
    load();
  });
  [actionTypeInput, targetTypeInput, adminUserIdInput, targetIdInput].forEach((input) => {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  });

  load();
})();
