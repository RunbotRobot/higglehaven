// #4651 (Disputes 3/3, part of #4648): the Disputes panel, the owner's list of Stripe disputes on orders. Open ones
// first and the soonest due date first; the server (GET /api/auth/admin-purchase-disputes) decides what is shown, and a
// look-only admin is answered by admin-dashboard-0.js with the plain refusal, so nothing here asks for it.
// Built for today's size: the newest 200 (the server says when there are more).
(function () {
  const statusLine = document.getElementById('disputesStatusLine');
  const errLine = document.getElementById('disputesErrLine');
  const tableWrap = document.getElementById('disputesTableWrap');
  const refreshBtn = document.getElementById('disputesRefreshBtn');
  if (!statusLine || !tableWrap) return;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function dollars(cents) {
    return Number.isInteger(cents) ? '$' + (cents / 100).toFixed(2) : '';
  }
  function when(iso) {
    const date = iso ? new Date(iso) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : '';
  }
  function evidenceText(d) {
    if (d.evidenceSent) return 'Sent';
    if (d.evidenceError) return 'Not sent: ' + d.evidenceError;
    if (d.outcome === 'won') return 'Not needed';
    return d.shipped || d.isDigitalGood ? 'Not sent yet' : 'Not sent; the order is not shipped';
  }

  let token = 0;
  async function load() {
    const mine = ++token;
    errLine.hidden = true;
    statusLine.textContent = 'Loading…';
    let body;
    try {
      const response = await fetch('/api/auth/admin-purchase-disputes');
      try { body = await response.json(); } catch (_) { body = null; }
      if (!response.ok) throw new Error((body && body.error) || ('Request failed (' + response.status + ')'));
    } catch (error) {
      if (mine !== token) return;
      errLine.hidden = false;
      errLine.textContent = error.message;
      statusLine.textContent = 'Failed to load.';
      tableWrap.innerHTML = '';
      return;
    }
    if (mine !== token) return;
    const disputes = body.disputes || [];
    const open = disputes.filter((d) => d.outcome === 'open').length;
    statusLine.textContent = disputes.length
      ? open + ' open · ' + disputes.length + ' shown' + (body.totalCount > disputes.length ? ' of ' + body.totalCount : '')
      : 'No disputes.';
    if (!disputes.length) { tableWrap.innerHTML = ''; return; }
    tableWrap.innerHTML = '<table><thead><tr><th>Evidence due</th><th>Product</th><th>Seller</th><th>Reason</th><th>Amount</th>'
      + '<th>Outcome</th><th>Evidence</th><th>Purchase id</th></tr></thead><tbody>'
      + disputes.map((d) => '<tr data-dispute-id="' + escapeHtml(d.disputeId) + '"><td>' + escapeHtml(when(d.evidenceDueBy)) + '</td><td>'
        + escapeHtml(d.productName || '') + '</td><td>' + escapeHtml(d.sellerName || '') + '</td><td>' + escapeHtml(d.reason || '')
        + '</td><td>' + escapeHtml(dollars(d.amountCents)) + '</td><td>' + escapeHtml(d.outcome) + '</td><td>'
        + escapeHtml(evidenceText(d)) + '</td><td>' + escapeHtml(d.purchaseId) + '</td></tr>').join('')
      + '</tbody></table>';
  }

  refreshBtn.addEventListener('click', load);
  // Read when the panel is first opened (admin-dashboard-1.js), not when the page opens; a look-only admin's dashboard
  // drops this entry and shows the plain note instead (admin-dashboard-10.js).
  window.__adminDashboardPanels = window.__adminDashboardPanels || {};
  window.__adminDashboardPanels.disputes = load;
})();
