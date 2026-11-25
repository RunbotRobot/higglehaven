// #4175: the owner's switch for the look-only admin role. The button is drawn by renderUserDetail
// (admin-dashboard-5.js) only for an account that can hold the role or already does; this file holds its
// confirmation dialog. The server decides and writes the admin log line; a refusal shows here.
(function () {
  const dialog = document.getElementById('viewerAccessDialog');
  if (!dialog) return;
  const title = document.getElementById('viewerAccessTitle');
  const body = document.getElementById('viewerAccessBody');
  const err = document.getElementById('viewerAccessErr');
  const confirmBtn = document.getElementById('viewerAccessConfirm');
  let target = null;

  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    let result;
    try { result = await response.json(); } catch (_) { result = null; }
    if (!response.ok) throw new Error((result && result.error) || ('Request failed (' + response.status + ')'));
    return result;
  }

  window.__adminOpenViewerDialog = function (user) {
    target = user;
    err.hidden = true; err.textContent = '';
    confirmBtn.disabled = false;
    if (user.adminViewer) {
      title.textContent = 'Remove look-only access';
      body.innerHTML = '<p><strong>' + esc(user.username) + '</strong> will no longer be able to open the admin dashboard.</p>';
      confirmBtn.textContent = 'Remove access';
    } else {
      title.textContent = 'Give look-only access';
      body.innerHTML = '<p><strong>' + esc(user.username) + '</strong> will be able to open the admin dashboard and read what it shows: '
        + 'accounts, lándlets, jobs and the rest. Email addresses are masked, and card details, tax form details and notes are hidden. '
        + 'It cannot change anything. Every sign-in and page it opens is written to the admin log. You can remove access here at any time.</p>';
      confirmBtn.textContent = 'Give access';
    }
    dialog.showModal();
    confirmBtn.focus();
  };

  document.getElementById('viewerAccessCancel').addEventListener('click', () => dialog.close());
  document.getElementById('viewerAccessForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!target) return;
    confirmBtn.disabled = true;
    err.hidden = true;
    try {
      await fetchJson('/api/auth/admin-set-viewer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: target.userId, enabled: !target.adminViewer }),
      });
      dialog.close();
      if (window.__adminLoadUserDetail) window.__adminLoadUserDetail(target.userId);
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
      confirmBtn.disabled = false;
    }
  });
})();
