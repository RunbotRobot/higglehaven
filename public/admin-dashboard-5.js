// #2299: account suspension panel -- a thin form over handleSuspendAccount/
// handleUnsuspendAccount/handleSuspensionStatus (worker/index.js), same
// fetch/error shape as the fixtures panel's grant forms above. No lazy-
// init fetch needed on open (unlike models/flags) since there's nothing to
// list until an admin actually looks something up.
(function () {
  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    let body;
    try { body = await response.json(); } catch (_) { body = null; }
    if (!response.ok) throw new Error((body && body.error) || ('Request failed (' + response.status + ')'));
    return body;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderSuspensionStatus(container, suspension) {
    if (!suspension) {
      container.innerHTML = '<p class="empty">No active suspension.</p>';
      return;
    }
    container.innerHTML =
      '<div class="stat-grid">' +
      '<div class="stat"><div class="n">' + escapeHtml(suspension.suspendedAt || '—') + '</div><div class="l">Suspended at</div></div>' +
      '<div class="stat"><div class="n">' + escapeHtml(suspension.gracePeriodEndsAt || '—') + '</div><div class="l">Grace period ends</div></div>' +
      '</div>' +
      '<p><strong>Reason:</strong> ' + escapeHtml(suspension.reason || '—') + '</p>' +
      (suspension.evidenceNote ? '<p><strong>Evidence note:</strong> ' + escapeHtml(suspension.evidenceNote) + '</p>' : '');
  }

  window.__adminDashboardPanels.accounts = function initAccountsPanel() {
    const suspendForm = document.getElementById('suspendForm');
    const suspendErr = document.getElementById('suspendErr');
    const suspendOk = document.getElementById('suspendOk');
    const unsuspendForm = document.getElementById('unsuspendForm');
    const unsuspendErr = document.getElementById('unsuspendErr');
    const unsuspendOk = document.getElementById('unsuspendOk');
    const statusEmailInput = document.getElementById('suspensionStatusEmailInput');
    const statusBtn = document.getElementById('suspensionStatusBtn');
    const statusErr = document.getElementById('suspensionStatusErr');
    const statusResult = document.getElementById('suspensionStatusResult');
    const userSearchInput = document.getElementById('userSearchInput');
    const userSearchBtn = document.getElementById('userSearchBtn');
    const userSearchErr = document.getElementById('userSearchErr');
    const userSearchResultsWrap = document.getElementById('userSearchResultsWrap');
    const userDetailWrap = document.getElementById('userDetailWrap');
    // #3040: admin-initiated NCMEC report record (POST/GET /api/ncmec-reports).
    const ncmecForm = document.getElementById('ncmecReportForm');
    const ncmecErr = document.getElementById('ncmecReportErr');
    const ncmecOk = document.getElementById('ncmecReportOk');
    const ncmecSuspensionFields = document.getElementById('ncmecSuspensionFields');
    const ncmecRemovalFields = document.getElementById('ncmecRemovalFields');
    const ncmecListErr = document.getElementById('ncmecReportsListErr');
    const ncmecRefreshBtn = document.getElementById('ncmecReportsRefreshBtn');
    const ncmecWrap = document.getElementById('ncmecReportsWrap');

    function clearMsg(errEl, okEl) {
      errEl.hidden = true; errEl.textContent = '';
      if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
    }
    function showErr(errEl, message) { errEl.hidden = false; errEl.textContent = message; }
    function showOk(okEl, message) { okEl.hidden = false; okEl.textContent = message; }

    // #2757: picking a result (or landing on exactly one match) fills and
    // reveals the existing suspend form's email field, rather than making
    // an admin retype it -- the whole point of searching first is to
    // avoid a hand-typed, unconfirmed email reaching suspend-account.
    function useAccountForSuspend(email) {
      suspendForm.elements.email.value = email;
      suspendForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
      suspendForm.elements.reason.focus();
    }

    // #3040: shows the fields that apply to the chosen decision type.
    function syncNcmecFields() {
      const isRemoval = ncmecForm.elements.decisionType.value === 'content_removal';
      ncmecSuspensionFields.hidden = isRemoval;
      ncmecRemovalFields.hidden = !isRemoval;
    }

    // The Find-user suspension history is the only place an admin can see a
    // suspensionId, so its Report button fills the form from there.
    function useSuspensionForNcmecReport(suspensionId) {
      ncmecForm.elements.decisionType.value = 'account_suspension';
      syncNcmecFields();
      ncmecForm.elements.suspensionId.value = suspensionId;
      ncmecForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
      ncmecForm.elements.note.focus();
    }

    // "table:id, table:id" -> [{ sourceTable, sourceId }]; identifiers only.
    function parseContentRefs(text) {
      return text.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
        const colon = part.indexOf(':');
        if (colon < 1 || colon === part.length - 1) throw new Error('Related content must look like table:id, table:id');
        return { sourceTable: part.slice(0, colon).trim(), sourceId: part.slice(colon + 1).trim() };
      });
    }

    function renderNcmecReports(reports) {
      if (!reports.length) {
        ncmecWrap.innerHTML = '<p class="empty">No reports recorded.</p>';
        return;
      }
      ncmecWrap.innerHTML = `
        <table>
          <thead><tr><th>Recorded</th><th>Decision</th><th>Reported account</th><th>Content</th><th>Note</th></tr></thead>
          <tbody>${reports.map((r) => `
            <tr>
              <td>${escapeHtml(r.createdAt)}</td>
              <td>${escapeHtml(r.decisionType)}<br><small>${escapeHtml(r.decisionId)}</small></td>
              <td>${escapeHtml(r.reportedUserId)}</td>
              <td>${r.contentRefs.length ? r.contentRefs.map((c) => escapeHtml(c.sourceTable + ':' + c.sourceId)).join('<br>') : '—'}</td>
              <td>${escapeHtml(r.note || '')}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      `;
    }

    async function loadNcmecReports() {
      clearMsg(ncmecListErr);
      try {
        const body = await fetchJson('/api/ncmec-reports');
        renderNcmecReports(body.reports);
      } catch (error) {
        showErr(ncmecListErr, error.message);
      }
    }

    function renderUserDetail(detail) {
      const user = detail.user;
      const suspensions = detail.suspensions || [];
      const suspensionRows = suspensions.length
        ? suspensions.map((s) => `
          <tr>
            <td>${escapeHtml(s.suspendedAt)}</td>
            <td>${escapeHtml(s.reason)}</td>
            <td>${escapeHtml(s.gracePeriodEndsAt)}</td>
            <td>${s.escalatedAt ? 'Escalated ' + escapeHtml(s.escalatedAt) : (s.liftedAt ? 'Lifted ' + escapeHtml(s.liftedAt) : 'Active')}</td>
            <td><button class="secondary use-for-ncmec-btn" type="button" data-suspension-id="${escapeHtml(s.suspensionId)}">Report</button></td>
          </tr>
        `).join('')
        : '<tr><td colspan="5"><p class="empty">No suspension history.</p></td></tr>';
      userDetailWrap.innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="n">${escapeHtml(user.username)}</div><div class="l">Username</div></div>
          <div class="stat"><div class="n">${escapeHtml(user.email)}</div><div class="l">Email</div></div>
          <div class="stat"><div class="n">${escapeHtml(user.trustTier)}</div><div class="l">Trust tier</div></div>
          <div class="stat"><div class="n">${escapeHtml(user.createdAt)}</div><div class="l">Account created</div></div>
          <div class="stat"><div class="n">${user.builderId ? escapeHtml(user.builderLabel) : '—'}</div><div class="l">Builder profile</div></div>
          <div class="stat"><div class="n">${user.sellerId ? escapeHtml(user.sellerLabel) : '—'}</div><div class="l">Seller profile</div></div>
        </div>
        <button class="secondary use-for-suspend-btn" type="button">Suspend this account</button>
        <h3>Suspension history</h3>
        <table>
          <thead><tr><th>Suspended at</th><th>Reason</th><th>Grace period ends</th><th>Status</th><th></th></tr></thead>
          <tbody>${suspensionRows}</tbody>
        </table>
      `;
      userDetailWrap.querySelector('.use-for-suspend-btn').addEventListener('click', () => useAccountForSuspend(user.email));
      userDetailWrap.querySelectorAll('.use-for-ncmec-btn').forEach((btn) => {
        btn.addEventListener('click', () => useSuspensionForNcmecReport(btn.dataset.suspensionId));
      });
    }

    async function loadUserDetail(userId) {
      clearMsg(userSearchErr);
      userDetailWrap.innerHTML = '<p class="empty">Loading…</p>';
      try {
        const body = await fetchJson('/api/auth/admin-user-detail?userId=' + encodeURIComponent(userId));
        renderUserDetail(body);
      } catch (error) {
        showErr(userSearchErr, error.message);
        userDetailWrap.innerHTML = '';
      }
    }

    function renderUserSearchResults(users) {
      if (!users.length) {
        userSearchResultsWrap.innerHTML = '<p class="empty">No matching accounts.</p>';
        return;
      }
      // Exactly one unambiguous match -- skip straight to its detail view
      // instead of making the admin click through a one-row table.
      if (users.length === 1) {
        userSearchResultsWrap.innerHTML = '';
        loadUserDetail(users[0].userId);
        return;
      }
      const rows = users.map((u) => `
        <tr>
          <td>${escapeHtml(u.username)}</td>
          <td>${escapeHtml(u.email)}</td>
          <td>${escapeHtml(u.trustTier)}</td>
          <td>${u.hasBuilderProfile ? 'Builder' : ''}${u.hasBuilderProfile && u.hasSellerProfile ? ', ' : ''}${u.hasSellerProfile ? 'Seller' : ''}${(!u.hasBuilderProfile && !u.hasSellerProfile) ? '—' : ''}</td>
          <td>${u.hasActiveSuspension ? 'Suspended' : ''}</td>
          <td><button class="secondary view-user-btn" data-user-id="${escapeHtml(u.userId)}">View</button></td>
        </tr>
      `).join('');
      userSearchResultsWrap.innerHTML = `
        <table>
          <thead><tr><th>Username</th><th>Email</th><th>Trust tier</th><th>Profiles</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `;
      userSearchResultsWrap.querySelectorAll('.view-user-btn').forEach((btn) => {
        btn.addEventListener('click', () => loadUserDetail(btn.dataset.userId));
      });
    }

    async function searchUsers() {
      clearMsg(userSearchErr);
      const q = userSearchInput.value.trim();
      if (!q) { showErr(userSearchErr, 'Enter a username or email to search for.'); return; }
      userDetailWrap.innerHTML = '';
      userSearchBtn.disabled = true;
      userSearchResultsWrap.innerHTML = '<p class="empty">Searching…</p>';
      try {
        const body = await fetchJson('/api/auth/admin-user-search?q=' + encodeURIComponent(q));
        renderUserSearchResults(body.users || []);
      } catch (error) {
        showErr(userSearchErr, error.message);
        userSearchResultsWrap.innerHTML = '';
      } finally {
        userSearchBtn.disabled = false;
      }
    }

    userSearchBtn.addEventListener('click', searchUsers);
    userSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); searchUsers(); }
    });

    suspendForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearMsg(suspendErr, suspendOk);
      const email = suspendForm.elements.email.value.trim();
      const reason = suspendForm.elements.reason.value.trim();
      const evidenceNote = suspendForm.elements.evidenceNote.value.trim();
      const graceDaysRaw = suspendForm.elements.graceDays.value.trim();
      const removeContent = suspendForm.elements.removeContent.checked;
      const submitBtn = suspendForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const body = await fetchJson('/api/auth/suspend-account', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email, reason,
            ...(evidenceNote ? { evidenceNote } : {}),
            ...(graceDaysRaw ? { graceDays: Number(graceDaysRaw) } : {}),
            ...(removeContent ? { removeContent: true } : {}),
          }),
        });
        showOk(suspendOk, 'Suspended. Grace period ends ' + body.suspension.gracePeriodEndsAt +
          (body.removedContent ? ' — posted content removed.' : '.'));
        suspendForm.reset();
      } catch (error) {
        showErr(suspendErr, error.message);
      } finally {
        submitBtn.disabled = false;
      }
    });

    unsuspendForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearMsg(unsuspendErr, unsuspendOk);
      const email = unsuspendForm.elements.email.value.trim();
      const submitBtn = unsuspendForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await fetchJson('/api/auth/unsuspend-account', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        showOk(unsuspendOk, 'Unsuspended.');
        unsuspendForm.reset();
      } catch (error) {
        showErr(unsuspendErr, error.message);
      } finally {
        submitBtn.disabled = false;
      }
    });

    statusBtn.addEventListener('click', async () => {
      clearMsg(statusErr);
      const email = statusEmailInput.value.trim();
      if (!email) { showErr(statusErr, 'Enter an email to look up.'); return; }
      statusBtn.disabled = true;
      try {
        const body = await fetchJson('/api/auth/suspension-status?email=' + encodeURIComponent(email));
        renderSuspensionStatus(statusResult, body.suspension);
      } catch (error) {
        showErr(statusErr, error.message);
      } finally {
        statusBtn.disabled = false;
      }
    });

    ncmecForm.elements.decisionType.addEventListener('change', syncNcmecFields);
    ncmecRefreshBtn.addEventListener('click', loadNcmecReports);
    ncmecForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearMsg(ncmecErr, ncmecOk);
      const decisionType = ncmecForm.elements.decisionType.value;
      const note = ncmecForm.elements.note.value.trim();
      let payload;
      try {
        if (decisionType === 'account_suspension') {
          const contentRefsText = ncmecForm.elements.contentRefs.value.trim();
          payload = {
            decisionType,
            suspensionId: ncmecForm.elements.suspensionId.value.trim(),
            ...(contentRefsText ? { contentRefs: parseContentRefs(contentRefsText) } : {}),
          };
        } else {
          payload = {
            decisionType,
            sourceTable: ncmecForm.elements.sourceTable.value.trim(),
            sourceId: ncmecForm.elements.sourceId.value.trim(),
            reportedUserId: ncmecForm.elements.reportedUserId.value.trim(),
          };
        }
      } catch (error) {
        showErr(ncmecErr, error.message);
        return;
      }
      if (note) payload.note = note;
      // Permanent by design (the table rejects any later change), so make
      // the admin confirm before it is written.
      if (!window.confirm('Record this report? It is permanent and cannot be edited or deleted.')) return;
      const submitBtn = ncmecForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const body = await fetchJson('/api/ncmec-reports', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        showOk(ncmecOk, 'Report recorded (' + body.report.reportId + ').');
        ncmecForm.reset();
        syncNcmecFields();
        loadNcmecReports();
      } catch (error) {
        showErr(ncmecErr, error.message);
      } finally {
        submitBtn.disabled = false;
      }
    });

    loadNcmecReports();
  };
})();
