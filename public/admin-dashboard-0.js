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
  const CLOSED = /^\/api\/(models(\?|$)|ncmec-reports|auth\/suspension-status|admin-items-outside-landlets|tax\/admin-forms|auth\/admin-purchase-disputes|purchases|product-flags|self-dealing-flags)/;
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

// #4522: a destructive admin action is confirmed in the page's own dialog, never a browser confirm() ("A destructive
// action is confirmed in its own in-app modal, never a browser dialog and never an inline control", #3278). A phone
// browser can suppress a native dialog and answer false at once, so the button did nothing and said nothing.
//   adminConfirm({ title, message, confirmLabel }) -> Promise<boolean>
// The dialog names the thing, has one clearly destructive button and a cancel, takes focus (on Cancel, so an
// accidental Enter does not do the destructive thing) and gives back true only for the destructive button; Escape,
// Cancel and a click on the backdrop give false. The text is plain selectable text.
(function () {
  window.adminConfirm = function adminConfirm({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'confirm-dialog admin-confirm-dialog';
      dialog.setAttribute('role', 'alertdialog');
      const form = document.createElement('form');
      form.method = 'dialog';
      const heading = document.createElement('h3');
      heading.textContent = title;
      heading.id = 'adminConfirmTitle' + Math.random().toString(36).slice(2, 8);
      dialog.setAttribute('aria-labelledby', heading.id);
      const text = document.createElement('p');
      text.textContent = message;
      const toolbar = document.createElement('div');
      toolbar.className = 'toolbar';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'secondary admin-confirm-cancel';
      cancel.textContent = cancelLabel;
      const confirmButton = document.createElement('button');
      confirmButton.type = 'submit';
      confirmButton.className = 'danger admin-confirm-ok';
      confirmButton.textContent = confirmLabel;
      toolbar.append(cancel, confirmButton);
      form.append(heading, text, toolbar);
      dialog.append(form);
      document.body.append(dialog);
      let answer = false;
      const finish = () => { dialog.remove(); resolve(answer); };
      cancel.addEventListener('click', () => dialog.close());
      form.addEventListener('submit', () => { answer = true; });
      dialog.addEventListener('close', finish);
      dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); }); // the backdrop
      dialog.showModal();
      cancel.focus();
    });
  };
})();
