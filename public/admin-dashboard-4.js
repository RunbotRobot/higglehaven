// #2178: Trust & Safety panel -- counterfeit/policy flags (#2017) and
// self-dealing flags (#2019) review queues, the only two requireAdmin-gated
// capabilities #1817 never got a page for (both landed after that tracking
// issue's own inventory was written). Lazy-initialized on first tab open,
// same pattern as the models/landlets panels below, since this tab may be
// opened rarely.
(function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

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

  // --- Counterfeit / policy flags (#2017) ---
  const pfErr = document.getElementById('productFlagsErr');
  const pfStatus = document.getElementById('productFlagsStatusLine');
  const pfTableWrap = document.getElementById('productFlagsTableWrap');
  let pfLoadToken = 0;

  async function loadProductFlags() {
    const myToken = ++pfLoadToken;
    pfErr.hidden = true;
    pfStatus.textContent = 'Loading…';
    let body;
    try {
      body = await apiFetch('/api/product-flags');
    } catch (error) {
      if (myToken !== pfLoadToken) return;
      pfErr.hidden = false;
      pfErr.textContent = error.message;
      pfStatus.textContent = 'Failed to load.';
      return;
    }
    if (myToken !== pfLoadToken) return;
    const listings = body.listings || [];
    pfStatus.textContent = listings.length + ' shown · ' + body.totalCount + ' total';
    renderProductFlags(listings);
  }

  async function resolveProductFlag(templateId, action, statusEl) {
    if (action === 'approve' && !confirm('Approve flag(s) against ' + templateId + '? This permanently removes the listing from sale and adds a strike to the seller.')) return;
    statusEl.textContent = 'Working…';
    statusEl.classList.remove('error');
    try {
      const body = await apiFetch('/api/catalog/' + encodeURIComponent(templateId) + '/flags/resolve', {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      statusEl.textContent = body.resolvedStatus + ' (' + body.flagsResolved + ' flag(s)).';
      await loadProductFlags();
    } catch (error) {
      statusEl.classList.add('error');
      statusEl.textContent = error.message;
    }
  }

  function renderProductFlags(listings) {
    if (!listings.length) {
      pfTableWrap.innerHTML = '<p class="empty">No pending flags.</p>';
      return;
    }
    const rows = listings.map((l) => `
      <tr data-template-id="${escapeHtml(l.templateId)}">
        <td>${escapeHtml(l.templateName)}</td>
        <td>${escapeHtml(l.templateId)}</td>
        <td>${escapeHtml(l.sellerId)}</td>
        <td>${l.pendingCount}</td>
        <td>${escapeHtml(l.lastFlaggedAt)}</td>
        <td>
          <button class="danger action-approve">Approve (remove)</button>
          <button class="secondary action-reject">Reject</button>
          <div class="row-status"></div>
        </td>
      </tr>
    `).join('');
    pfTableWrap.innerHTML = `
      <table>
        <thead>
          <tr><th>Template</th><th>Template id</th><th>Seller id</th><th>Pending</th><th>Last flagged</th><th>Actions</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    pfTableWrap.querySelectorAll('tr[data-template-id]').forEach((row) => {
      const templateId = row.dataset.templateId;
      const statusEl = row.querySelector('.row-status');
      row.querySelector('.action-approve').addEventListener('click', () => resolveProductFlag(templateId, 'approve', statusEl));
      row.querySelector('.action-reject').addEventListener('click', () => resolveProductFlag(templateId, 'reject', statusEl));
    });
  }

  // --- Self-dealing flags (#2019) ---
  const sdErr = document.getElementById('selfDealingFlagsErr');
  const sdStatus = document.getElementById('selfDealingFlagsStatusLine');
  const sdTableWrap = document.getElementById('selfDealingFlagsTableWrap');
  let sdLoadToken = 0;

  async function loadSelfDealingFlags() {
    const myToken = ++sdLoadToken;
    sdErr.hidden = true;
    sdStatus.textContent = 'Loading…';
    let body;
    try {
      body = await apiFetch('/api/self-dealing-flags');
    } catch (error) {
      if (myToken !== sdLoadToken) return;
      sdErr.hidden = false;
      sdErr.textContent = error.message;
      sdStatus.textContent = 'Failed to load.';
      return;
    }
    if (myToken !== sdLoadToken) return;
    const flags = body.flags || [];
    sdStatus.textContent = flags.length + ' shown · ' + body.totalCount + ' total';
    renderSelfDealingFlags(flags);
  }

  async function reviewSelfDealingFlag(flagId, notesInput, statusEl) {
    const notes = notesInput.value.trim();
    statusEl.textContent = 'Working…';
    statusEl.classList.remove('error');
    try {
      await apiFetch('/api/self-dealing-flags/' + encodeURIComponent(flagId) + '/review', {
        method: 'POST',
        body: JSON.stringify(notes ? { notes } : {}),
      });
      statusEl.textContent = 'Reviewed.';
      await loadSelfDealingFlags();
    } catch (error) {
      statusEl.classList.add('error');
      statusEl.textContent = error.message;
    }
  }

  function renderSelfDealingFlags(flags) {
    if (!flags.length) {
      sdTableWrap.innerHTML = '<p class="empty">No pending flags.</p>';
      return;
    }
    const rows = flags.map((f) => `
      <tr data-flag-id="${escapeHtml(f.flagId)}">
        <td>${escapeHtml(f.createdAt)}</td>
        <td>${escapeHtml(f.purchaseId)}</td>
        <td>${escapeHtml(f.templateId)}</td>
        <td>${escapeHtml(f.buyerBuilderId)}</td>
        <td>${escapeHtml(f.builderId)}</td>
        <td>${(f.totalCents / 100).toFixed(2)}</td>
        <td>${escapeHtml((f.matchedSignals || []).join(', '))}</td>
        <td>
          <input class="review-notes" placeholder="Optional note" aria-label="Review note" />
          <button class="secondary action-review">Review</button>
          <div class="row-status"></div>
        </td>
      </tr>
    `).join('');
    sdTableWrap.innerHTML = `
      <table>
        <thead>
          <tr><th>Flagged</th><th>Purchase</th><th>Template</th><th>Buyer builder</th><th>Host builder</th><th>Total ($)</th><th>Matched on</th><th>Actions</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    sdTableWrap.querySelectorAll('tr[data-flag-id]').forEach((row) => {
      const flagId = row.dataset.flagId;
      const notesInput = row.querySelector('.review-notes');
      const statusEl = row.querySelector('.row-status');
      row.querySelector('.action-review').addEventListener('click', () => reviewSelfDealingFlag(flagId, notesInput, statusEl));
    });
  }

  document.getElementById('productFlagsRefreshBtn').addEventListener('click', loadProductFlags);
  document.getElementById('selfDealingFlagsRefreshBtn').addEventListener('click', loadSelfDealingFlags);

  window.__adminDashboardPanels.flags = function initFlagsPanel() {
    loadProductFlags();
    loadSelfDealingFlags();
  };
})();
