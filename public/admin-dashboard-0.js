// #4382: the dashboard asks once who is looking (GET /api/auth/admin-role: for a look-only admin this is also the
// admin log's page-open line) and keeps the answer in window.__adminRole for the scripts after it. Some panels read
// tax, order, flag or evidence detail when the page opens; a look-only account is not shown those, so those reads
// wait for the answer and, for a look-only account, are answered here with the plain refusal instead of a request
// the server would refuse (no refusal in the console). Everything else goes straight through, for everyone.
(function () {
  const realFetch = window.fetch.bind(window);
  window.__adminRole = realFetch('/api/auth/admin-role')
    .then((r) => (r.ok ? r.json() : null))
    .then((r) => (r && r.role) || null)
    .catch(() => null);
  window.__adminNotShown = 'Not shown to a look-only account.';
  const CLOSED = /^\/api\/(models(\?|$)|ncmec-reports|auth\/suspension-status|admin-items-outside-landlets|tax\/admin-forms|purchases|product-flags|self-dealing-flags)/;
  window.fetch = (input, options) => {
    const method = String((options && options.method) || (input && input.method) || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if ((method === 'GET' || method === 'HEAD') && CLOSED.test(url.replace(/^https?:\/\/[^/]+/, ''))) {
      return window.__adminRole.then((role) => (role === 'viewer'
        ? new Response(JSON.stringify({ error: window.__adminNotShown }), { status: 403, headers: { 'content-type': 'application/json' } })
        : realFetch(input, options)));
    }
    return realFetch(input, options);
  };
})();
