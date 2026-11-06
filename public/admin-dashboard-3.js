// #1824: Purchases (admin fallback) panel -- refund/mark-shipped for a
// purchase whose seller_id is dangling (the seller deleted their
// account). Loads the full list up front (danglingSeller is a narrow,
// rare case in practice -- a deleted-seller purchase, not an everyday
// one -- so there's no pagination here, same as admin-action-log.html's
// own single-page-of-results posture) and filters client-side by
// purchase id, rather than round-tripping per keystroke.
(function () {
  const statusLine = document.getElementById('purchasesStatusLine');
  const errLine = document.getElementById('purchasesErrLine');
  const tableWrap = document.getElementById('purchasesTableWrap');
  const filterInput = document.getElementById('purchasesFilterInput');
  let purchases = [];

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function formatCents(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  function clearError() {
    errLine.hidden = true;
    errLine.textContent = '';
  }

  let purchasesLoadToken = 0;

  async function load() {
    const myLoadToken = ++purchasesLoadToken;
    clearError();
    statusLine.textContent = 'Loading…';
    let body;
    try {
      const response = await fetch('/api/purchases?danglingSeller=1', {
        headers: { 'content-type': 'application/json' },
      });
      try { body = await response.json(); } catch (_) { body = null; }
      if (!response.ok) throw new Error((body && body.error) || ('Request failed (' + response.status + ')'));
    } catch (error) {
      if (myLoadToken !== purchasesLoadToken) return;
      errLine.hidden = false;
      errLine.textContent = error.message;
      statusLine.textContent = 'Failed to load.';
      return;
    }
    if (myLoadToken !== purchasesLoadToken) return;
    purchases = body.purchases || [];
    statusLine.textContent = purchases.length + ' shown · ' + body.totalCount + ' total';
    render();
  }

  // Mirrors the server's own validation on each action (handleMarkShipped/
  // handlePurchaseRefund in worker/index.js) just enough to disable a
  // button that would otherwise only ever 400 -- the server is still the
  // real source of truth either way, this is purely a UX nicety.
  function canRefund(purchase) {
    return !purchase.refundedAt;
  }
  function canMarkShipped(purchase) {
    return !purchase.refundedAt && !purchase.shippedAt && !purchase.isDigitalGood && !!purchase.paymentIntentId;
  }

  async function act(purchaseId, action, statusEl) {
    // #2081: a real, unconditional Stripe refund (handlePurchaseRefund) with
    // no "are you sure" step was the one dangerous action in this dashboard
    // without one — every other irreversible admin action here already
    // confirms first (revoke-admin, delete-land-candidate, tax-form
    // approve/file/void, R2 model delete, auction-cancel-and-reassign).
    if (action === 'refund' && !confirm('Refund purchase ' + purchaseId + '? This cannot be undone.')) return;
    statusEl.textContent = 'Working…';
    statusEl.classList.remove('error');
    try {
      const response = await fetch('/api/purchases/' + encodeURIComponent(purchaseId) + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      let body;
      try { body = await response.json(); } catch (_) { body = null; }
      if (!response.ok) throw new Error((body && body.error) || ('Request failed (' + response.status + ')'));
      statusEl.textContent = action === 'refund' ? 'Refunded.' : 'Marked shipped.';
      await load();
    } catch (error) {
      statusEl.classList.add('error');
      statusEl.textContent = error.message;
    }
  }

  function render() {
    const filter = filterInput.value.trim();
    const filtered = filter ? purchases.filter((p) => p.purchaseId.includes(filter)) : purchases;
    if (!filtered.length) {
      tableWrap.innerHTML = '<p class="empty">No matching purchases.</p>';
      return;
    }
    const rows = filtered.map((p) => `
      <tr data-purchase-id="${escapeHtml(p.purchaseId)}">
        <td>${escapeHtml(p.createdAt)}</td>
        <td>${escapeHtml(p.purchaseId)}</td>
        <td>${escapeHtml(p.templateId)}</td>
        <td>${escapeHtml(p.sellerId)} (deleted)</td>
        <td>${escapeHtml(p.buyerLabel || '—')}</td>
        <td>${formatCents(p.totalCents)}</td>
        <td>${p.refundedAt ? 'Refunded ' + escapeHtml(p.refundedAt) : (p.shippedAt ? 'Shipped ' + escapeHtml(p.shippedAt) : '—')}</td>
        <td>
          <button class="danger action-refund" ${canRefund(p) ? '' : 'disabled'}>Refund</button>
          <button class="secondary action-ship" ${canMarkShipped(p) ? '' : 'disabled'}>Mark Shipped</button>
          <div class="row-status"></div>
        </td>
      </tr>
    `).join('');
    tableWrap.innerHTML = `
      <table>
        <thead>
          <tr><th>When</th><th>Purchase id</th><th>Template</th><th>Seller</th><th>Buyer</th><th>Total</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    tableWrap.querySelectorAll('tr[data-purchase-id]').forEach((row) => {
      const purchaseId = row.dataset.purchaseId;
      const statusEl = row.querySelector('.row-status');
      row.querySelector('.action-refund').addEventListener('click', () => act(purchaseId, 'refund', statusEl));
      row.querySelector('.action-ship').addEventListener('click', () => act(purchaseId, 'mark-shipped', statusEl));
    });
  }

  document.getElementById('purchasesRefreshBtn').addEventListener('click', load);
  filterInput.addEventListener('input', render);

  load();
})();
