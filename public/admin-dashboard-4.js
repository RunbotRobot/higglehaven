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
      loadRefundBuyers();
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

  // --- Refund buyers on an approved counterfeit flag (#4376) ---
  const rbErr = document.getElementById('refundBuyersErr');
  const rbTableWrap = document.getElementById('refundBuyersTableWrap');
  const rbDialog = document.getElementById('refundBuyersDialog');
  const rbBody = document.getElementById('refundBuyersBody');
  const rbDialogErr = document.getElementById('refundBuyersDialogErr');
  const rbConfirm = document.getElementById('refundBuyersConfirm');
  const rbCancel = document.getElementById('refundBuyersCancel');
  let rbPlan = null;
  let rbBusy = false;
  const dollars = (cents) => '$' + (cents / 100).toFixed(2);
  const orders = (n) => n + (n === 1 ? ' order' : ' orders');

  async function loadRefundBuyers() {
    rbErr.hidden = true;
    let body;
    try {
      body = await apiFetch('/api/product-flags?status=approved');
    } catch (error) {
      rbErr.hidden = false;
      rbErr.textContent = error.message;
      rbTableWrap.innerHTML = '';
      return;
    }
    const listings = body.listings || [];
    if (!listings.length) {
      rbTableWrap.innerHTML = '<p class="empty">No approved flag has orders left to refund.</p>';
      return;
    }
    rbTableWrap.innerHTML = '<table><thead><tr><th>Listing</th><th>Seller id</th><th>Approved</th><th>Orders to refund</th><th>Action</th></tr></thead><tbody>'
      + listings.map((l) => `<tr data-template-id="${escapeHtml(l.templateId)}"><td>${escapeHtml(l.templateName)}<br><small>${escapeHtml(l.templateId)}</small></td><td>${escapeHtml(l.sellerId)}</td><td>${escapeHtml(l.resolvedAt)}</td><td>${l.openOrders}</td><td><button class="danger action-refund-buyers">Refund buyers…</button></td></tr>`).join('')
      + '</tbody></table>';
    rbTableWrap.querySelectorAll('tr[data-template-id]').forEach((row) => {
      row.querySelector('.action-refund-buyers').addEventListener('click', () => openRefundBuyers(row.dataset.templateId));
    });
  }

  function describePlan(plan) {
    const notRefundable = plan.notRefundableCount
      ? `<p><strong>${orders(plan.notRefundableCount)} (${dollars(plan.notRefundableCents)}) cannot be refunded here</strong>: the seller was already paid out, or the order was refunded in part. Nothing is taken from the seller's other earnings, and the platform is not covering them. They stay as they are; their count and total go in the admin log.</p>`
      : '';
    return `<p>This repays the buyers of <strong>${escapeHtml(plan.productName)}</strong>, a listing removed after a confirmed counterfeit report.</p>
      <ul>
        <li><strong>${plan.refundCount}</strong> ${plan.refundCount === 1 ? 'buyer' : 'buyers'} will be refunded</li>
        <li><strong>${dollars(plan.refundCents)}</strong> goes back to them (99% of ${dollars(plan.orderTotalCents)} paid)</li>
      </ul>${notRefundable}`;
  }

  async function openRefundBuyers(templateId) {
    rbDialogErr.hidden = true; rbDialogErr.textContent = '';
    rbErr.hidden = true;
    let body;
    try {
      body = await apiFetch('/api/product-flags/' + encodeURIComponent(templateId) + '/refund-buyers');
    } catch (error) {
      rbErr.hidden = false;
      rbErr.textContent = error.message;
      return;
    }
    rbPlan = body.refundBuyers;
    rbBody.innerHTML = describePlan(rbPlan);
    rbConfirm.disabled = rbPlan.refundCount === 0;
    rbConfirm.textContent = 'Refund ' + dollars(rbPlan.refundCents);
    rbCancel.textContent = 'Cancel';
    rbDialog.showModal();
    rbCancel.focus();
  }

  rbCancel.addEventListener('click', () => { if (!rbBusy) rbDialog.close(); });
  rbDialog.addEventListener('cancel', (e) => { if (rbBusy) e.preventDefault(); });
  document.getElementById('refundBuyersForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (rbBusy || !rbPlan) return;
    rbBusy = true;
    rbConfirm.disabled = true;
    rbDialogErr.hidden = true;
    let refunded = 0; let refundedCents = 0; let failed = 0; let firstError = null;
    // The server does a few orders per press and says what is left; the count and total it is sent are the ones the
    // admin confirmed (first press) or the ones the last answer said remained (later presses).
    let expect = rbPlan;
    try {
      for (let guard = 0; guard < 200 && expect.refundCount > 0; guard += 1) {
        rbBody.innerHTML = `<p>Refunding… ${refunded} done, ${expect.refundCount} to go.</p>`;
        const result = await apiFetch('/api/product-flags/' + encodeURIComponent(rbPlan.templateId) + '/refund-buyers', {
          method: 'POST',
          body: JSON.stringify({ expectedCount: expect.refundCount, expectedRefundCents: expect.refundCents }),
        });
        refunded += result.refunded; refundedCents += result.refundedCents; failed += result.failed;
        firstError = firstError || result.firstError;
        expect = result.refundBuyers;
        if (result.refunded === 0) break; // no progress this press: stop and say why instead of looping
      }
    } catch (error) {
      rbDialogErr.hidden = false;
      rbDialogErr.textContent = error.message;
    }
    rbBusy = false;
    rbBody.innerHTML = `<p><strong>${orders(refunded)} refunded, ${dollars(refundedCents)} on its way back to buyers.</strong> Each was told why.</p>`
      + (expect && expect.refundCount ? `<p>${orders(expect.refundCount)} still to refund${failed ? ` (${failed} failed${firstError ? ': ' + escapeHtml(firstError) : ''})` : ''}. Open Refund buyers again to carry on.</p>` : '')
      + (expect && expect.notRefundableCount ? `<p>${orders(expect.notRefundableCount)} (${dollars(expect.notRefundableCents)}) could not be refunded here.</p>` : '');
    rbConfirm.disabled = true;
    rbCancel.textContent = 'Close';
    await loadRefundBuyers();
  });

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

  document.getElementById('productFlagsRefreshBtn').addEventListener('click', () => { loadProductFlags(); loadRefundBuyers(); });
  document.getElementById('selfDealingFlagsRefreshBtn').addEventListener('click', loadSelfDealingFlags);

  window.__adminDashboardPanels.flags = function initFlagsPanel() {
    loadProductFlags();
    loadRefundBuyers();
    loadSelfDealingFlags();
  };
})();
