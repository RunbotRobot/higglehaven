// #4407: Rename account, the owner's tool for an existing name with a space (a username has no spaces). The button is
// drawn by renderUserDetail (admin-dashboard-5.js); this file holds its confirmation dialog, which shows the old and
// the new name before anything changes. The server applies the same rule as sign-up, writes the admin log line and
// tells the person; a refusal shows here.
(function () {
  const dialog = document.getElementById('renameAccountDialog');
  if (!dialog) return;
  const body = document.getElementById('renameAccountBody');
  const input = document.getElementById('renameAccountInput');
  const preview = document.getElementById('renameAccountPreview');
  const err = document.getElementById('renameAccountErr');
  const confirmBtn = document.getElementById('renameAccountConfirm');
  let target = null;

  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // What the admin has typed, and whether it can be sent. The server decides everything else (reserved or taken names).
  function sync() {
    const next = input.value.trim();
    let problem = '';
    if (!next) problem = '';
    else if (/\s/.test(next)) problem = 'A name can\'t have spaces. Try ' + esc(next.replace(/\s+/g, '_')) + '.';
    else if (next === target.username) problem = 'That is already this account\'s name.';
    preview.innerHTML = next && !problem
      ? '<strong>' + esc(target.username) + '</strong> becomes <strong>' + esc(next) + '</strong>.'
      : problem;
    confirmBtn.disabled = !next || Boolean(problem);
  }
  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    let result;
    try { result = await response.json(); } catch (_) { result = null; }
    if (!response.ok) throw new Error((result && result.error) || ('Request failed (' + response.status + ')'));
    return result;
  }

  window.__adminOpenRenameDialog = function (user) {
    target = user;
    err.hidden = true; err.textContent = '';
    input.value = String(user.username).replace(/\s+/g, '');
    body.innerHTML = '<p>The name <strong>' + esc(user.username) + '</strong> is changed everywhere it shows (their account and builder name). '
      + 'They get a notice saying it changed and why. A name has no spaces.</p>';
    sync();
    dialog.showModal();
    input.focus();
    input.select();
  };

  input.addEventListener('input', sync);
  document.getElementById('renameAccountCancel').addEventListener('click', () => dialog.close());
  document.getElementById('renameAccountForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!target || confirmBtn.disabled) return;
    confirmBtn.disabled = true;
    err.hidden = true;
    try {
      await fetchJson('/api/auth/admin-rename-account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: target.userId, newUsername: input.value.trim() }),
      });
      dialog.close();
      if (window.__adminLoadUserDetail) window.__adminLoadUserDetail(target.userId);
      const refreshUsers = document.getElementById('usersRefreshBtn');
      if (refreshUsers) refreshUsers.click();
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
      sync();
    }
  });
})();
