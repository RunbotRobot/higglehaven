(function () {
  // Panels register a one-time init (lazy-loaded on first activation, not
  // on page load) via window.__adminDashboardPanels[name] -- keeps an
  // unopened panel's own fetches from firing for no reason, and lets each
  // panel's own script block stay self-contained.
  window.__adminDashboardPanels = window.__adminDashboardPanels || {};
  const initialized = new Set();
  const buttons = [...document.querySelectorAll('nav button.nav-item')];
  const panels = [...document.querySelectorAll('main .panel')];
  function activate(name) {
    // #1966: same aria-current gap already fixed for the main app's own
    // toggle/tab groups (#1503/#1760/#1842/#1901) -- the .active class alone
    // never told a screen reader which panel is current.
    buttons.forEach((btn) => {
      const isActive = btn.dataset.panel === name;
      btn.classList.toggle('active', isActive);
      if (isActive) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    panels.forEach((panel) => panel.classList.toggle('active', panel.id === 'panel-' + name));
    if (!initialized.has(name) && window.__adminDashboardPanels[name]) {
      initialized.add(name);
      window.__adminDashboardPanels[name]();
    }
  }
  buttons.forEach((btn) => btn.addEventListener('click', () => activate(btn.dataset.panel)));

  // #1826: the two admin-gated test/ops fixture grants. Both endpoints take
  // { amountCents } and are additive -- the form collects a dollar amount
  // (matching this app's existing price-input convention, e.g. src/main.js's
  // own `Math.round(dollars * 100)`) and converts it before sending, since an
  // admin typing a grant amount thinks in dollars, not cents.
  const GRANTS = {
    'land-cap-grants': {
      builderIdField: 'landCapBuilderId',
      amountField: 'landCapAmountDollars',
      describeSuccess: (body) => `Granted. New land cap: ${body.landCapM2} m².`,
    },
    'higgles-grants': {
      builderIdField: 'higglesBuilderId',
      amountField: 'higglesAmountDollars',
      describeSuccess: (body) => `Granted. New higgles balance: $${(body.higglesBalanceCents / 100).toFixed(2)}.`,
    },
  };

  document.querySelectorAll('.fixtures-panel form[data-grant]').forEach((form) => {
    const grantType = form.dataset.grant;
    const config = GRANTS[grantType];
    const resultEl = document.querySelector(`.grant-result[data-result="${grantType}"]`);
    const submitBtn = form.querySelector('button[type="submit"]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const builderId = form.elements[config.builderIdField].value.trim();
      const dollars = Number(form.elements[config.amountField].value);
      resultEl.className = 'grant-result';
      resultEl.textContent = '';
      if (!builderId || !Number.isFinite(dollars) || dollars < 0) {
        resultEl.className = 'grant-result error';
        resultEl.textContent = 'Enter a builder id and a non-negative amount.';
        return;
      }
      const amountCents = Math.round(dollars * 100);
      submitBtn.disabled = true;
      let body;
      try {
        const response = await fetch(`/api/builders/${encodeURIComponent(builderId)}/${grantType}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amountCents }),
        });
        try { body = await response.json(); } catch (_) { body = null; }
        if (!response.ok) throw new Error((body && body.error) || `Request failed (${response.status})`);
        resultEl.className = 'grant-result success';
        resultEl.textContent = config.describeSuccess(body);
      } catch (error) {
        resultEl.className = 'grant-result error';
        resultEl.textContent = error.message;
      } finally {
        submitBtn.disabled = false;
      }
    });
  });
})();

// #1819: roster panel -- list/grant/revoke admins. Same fetch/render/
// escapeHtml shape as admin-action-log.html's own script (same-origin
// fetch already carries the hh_session cookie, no explicit credentials
// option needed).
(function () {
  const errLine = document.getElementById('rosterErr');
  const tableWrap = document.getElementById('rosterTableWrap');
  const grantEmailInput = document.getElementById('grantEmailInput');

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function clearError() {
    errLine.hidden = true;
    errLine.textContent = '';
  }

  function showError(message) {
    errLine.hidden = false;
    errLine.textContent = message;
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

  // #1877: same monotonic-token guard #1857/PR #1861 already shipped for
  // admin-action-log.html's own load() -- loadRoster() is called from four
  // places that can overlap (initial load, Refresh, and grantAdmin/
  // revokeAdmin's own success paths), so a slower, earlier call landing
  // after a faster, newer one could otherwise silently overwrite the table
  // with stale rows.
  let loadRosterToken = 0;

  async function loadRoster() {
    const myLoadRosterToken = ++loadRosterToken;
    clearError();
    tableWrap.innerHTML = '<p class="empty">Loading…</p>';
    let body;
    try {
      body = await apiFetch('/api/auth/admins');
    } catch (error) {
      if (myLoadRosterToken !== loadRosterToken) return;
      showError(error.message);
      tableWrap.innerHTML = '<p class="empty">Failed to load.</p>';
      return;
    }
    if (myLoadRosterToken !== loadRosterToken) return;
    renderRoster(body.admins || []);
  }

  function renderRoster(admins) {
    if (!admins.length) {
      tableWrap.innerHTML = '<p class="empty">No admins.</p>';
      return;
    }
    const rows = admins.map((admin) => `
      <tr>
        <td>${escapeHtml(admin.email)}</td>
        <td>${escapeHtml(admin.username || '—')}</td>
        <td>${escapeHtml(admin.adminGrantedAt || admin.createdAt)}</td>
        <td><button class="secondary revoke-btn" data-email="${escapeHtml(admin.email)}">Revoke</button></td>
      </tr>
    `).join('');
    tableWrap.innerHTML = `
      <table>
        <thead><tr><th>Email</th><th>Username</th><th>Admin since</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    tableWrap.querySelectorAll('.revoke-btn').forEach((btn) => {
      btn.addEventListener('click', () => revokeAdmin(btn.dataset.email));
    });
  }

  async function revokeAdmin(email) {
    if (!confirm('Revoke admin access for ' + email + '?')) return;
    clearError();
    try {
      await apiFetch('/api/auth/revoke-admin', { method: 'POST', body: JSON.stringify({ email }) });
    } catch (error) {
      // #1819: the server's own "cannot revoke the last remaining admin"
      // 409 lands here unchanged -- no separate client-side check needed.
      showError(error.message);
      return;
    }
    loadRoster();
  }

  async function grantAdmin() {
    const email = grantEmailInput.value.trim();
    if (!email) return;
    clearError();
    try {
      await apiFetch('/api/auth/grant-admin', { method: 'POST', body: JSON.stringify({ email }) });
    } catch (error) {
      showError(error.message);
      return;
    }
    grantEmailInput.value = '';
    loadRoster();
  }

  document.getElementById('grantBtn').addEventListener('click', grantAdmin);
  document.getElementById('rosterRefreshBtn').addEventListener('click', loadRoster);
  grantEmailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') grantAdmin(); });

  loadRoster();
})();

// #1821: world settings + land-candidate/ring generation and browse/CRUD
// panel. Same apiFetch/escapeHtml shape as the roster panel's own script
// above -- each panel script is a self-contained IIFE in this codebase (no
// shared module), so these are redefined locally rather than imported.
(function () {
  const errLine = document.getElementById('worldErr');

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function clearError() {
    errLine.hidden = true;
    errLine.textContent = '';
  }

  function showError(message) {
    errLine.hidden = false;
    errLine.textContent = message;
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

  // --- World settings ---

  const worldSummaryEl = document.getElementById('worldSummary');
  const worldRadiusInput = document.getElementById('worldRadiusInput');
  const worldIncrementInput = document.getElementById('worldIncrementInput');
  const worldGreenbeltInput = document.getElementById('worldGreenbeltInput');
  const worldRotationInput = document.getElementById('worldRotationInput');
  const worldDayCycleInput = document.getElementById('worldDayCycleInput');
  const worldMetadataInput = document.getElementById('worldMetadataInput');
  // #1927: same monotonic-token guard loadModelsPage/loadRoster/loadRings/
  // loadCandidates already use -- loadWorld() is called from six independent
  // sites (Refresh, generateMosaic, generateRing, completeRing, submitBatch,
  // initial load) that can race, and without it an earlier-sent request's
  // stale world snapshot can land after and overwrite a fresher one.
  // #2099: loadWorld()/saveWorld()/expandWorld() below all race each other --
  // a refresh, a save, and an expand can each be in flight at once, all
  // resolving into the very same renderWorld(). Every one of them increments
  // this single shared token, so whichever call is actually the LATEST one
  // started always wins the eventual render, regardless of which order their
  // responses happen to land in -- same shared-token idiom as the Landlets
  // panel's landletLookupToken (#2062/#2072).
  let worldLoadToken = 0;

  function renderWorld(world) {
    const counts = world.landletCounts || {};
    worldSummaryEl.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="n">${escapeHtml(world.radiusM)}</div><div class="l">radiusM</div></div>
        <div class="stat"><div class="n">${escapeHtml(world.expansionIncrementM)}</div><div class="l">incrementM</div></div>
        <div class="stat"><div class="n">${escapeHtml(world.greenbeltMinRatio)}</div><div class="l">greenbelt min ratio</div></div>
        <div class="stat"><div class="n">${escapeHtml(counts.greenbeltRatio)}</div><div class="l">greenbelt ratio</div></div>
        <div class="stat"><div class="n">${escapeHtml(counts.total)}</div><div class="l">total landlets</div></div>
        <div class="stat"><div class="n">${escapeHtml(counts.claimed)}</div><div class="l">claimed</div></div>
        <div class="stat"><div class="n">${escapeHtml(counts.generating)}</div><div class="l">generating</div></div>
        <div class="stat"><div class="n">${escapeHtml(counts.greenbelt)}</div><div class="l">greenbelt</div></div>
        <div class="stat"><div class="n">${escapeHtml(counts.water)}</div><div class="l">water</div></div>
      </div>
    `;
    worldRadiusInput.value = world.radiusM;
    worldIncrementInput.value = world.expansionIncrementM;
    worldGreenbeltInput.value = world.greenbeltMinRatio;
    worldRotationInput.value = world.coordinateRotationDeg;
    worldDayCycleInput.value = world.dayCycleHours;
    worldMetadataInput.value = JSON.stringify(world.metadata || {});
  }

  async function loadWorld() {
    const myLoadToken = ++worldLoadToken;
    clearError();
    try {
      const body = await apiFetch('/api/world');
      if (myLoadToken !== worldLoadToken) return;
      renderWorld(body.world);
    } catch (error) {
      if (myLoadToken !== worldLoadToken) return;
      showError(error.message);
    }
  }

  async function saveWorld() {
    clearError();
    let metadata;
    try {
      metadata = worldMetadataInput.value.trim() ? JSON.parse(worldMetadataInput.value) : {};
    } catch (_) {
      showError('World metadata is not valid JSON');
      return;
    }
    const myLoadToken = ++worldLoadToken;
    try {
      const body = await apiFetch('/api/world', {
        method: 'PATCH',
        body: JSON.stringify({
          radiusM: Number(worldRadiusInput.value),
          expansionIncrementM: Number(worldIncrementInput.value),
          greenbeltMinRatio: Number(worldGreenbeltInput.value),
          coordinateRotationDeg: Number(worldRotationInput.value),
          dayCycleHours: Number(worldDayCycleInput.value),
          metadata,
        }),
      });
      if (myLoadToken !== worldLoadToken) return;
      renderWorld(body.world);
    } catch (error) {
      if (myLoadToken !== worldLoadToken) return;
      showError(error.message);
    }
  }

  async function expandWorld() {
    clearError();
    const myLoadToken = ++worldLoadToken;
    try {
      const body = await apiFetch('/api/world/expand', { method: 'POST' });
      if (myLoadToken !== worldLoadToken) return;
      renderWorld(body.world);
      const expansion = body.expansion;
      alert(
        'World expanded: ' + expansion.previousRadiusM + 'm → ' + expansion.newRadiusM + 'm.\n'
        + 'Promoted to greenbelt: ' + expansion.promotedLandletIds.length + '\n'
        + 'Started generating: ' + expansion.startedGeneratingLandletIds.length + '\n'
        + 'Rings ready for generation-complete: ' + (expansion.readyRingIds.join(', ') || 'none'),
      );
    } catch (error) {
      if (myLoadToken !== worldLoadToken) return;
      // A 409 here ("Greenbelt reserve is at or above the expansion
      // threshold") is a normal, expected outcome, not a bug -- surfaced
      // the same as any other error so the admin sees why nothing changed.
      showError(error.message);
    }
  }

  document.getElementById('worldRefreshBtn').addEventListener('click', loadWorld);
  document.getElementById('worldSaveBtn').addEventListener('click', saveWorld);
  document.getElementById('worldExpandBtn').addEventListener('click', expandWorld);

  // --- Generate mosaic / ring ---

  async function generateMosaic() {
    clearError();
    const prefix = document.getElementById('mosaicPrefixInput').value.trim();
    if (!prefix) {
      showError('Prefix is required.');
      return;
    }
    try {
      const body = await apiFetch('/api/land-candidates/generate-mosaic', {
        method: 'POST',
        body: JSON.stringify({ prefix, count: 16 }),
      });
      alert('Mosaic generated: ' + body.candidates.length + ' candidates, starter landlet ' + body.starterLandletId + '.');
      loadCandidates();
      loadWorld();
    } catch (error) {
      showError(error.message);
    }
  }

  async function generateRing() {
    clearError();
    const prefix = document.getElementById('ringPrefixInput').value.trim();
    const count = Number(document.getElementById('ringCountInput').value);
    if (!prefix || !count) {
      showError('Prefix and count are required.');
      return;
    }
    const innerRadiusRaw = document.getElementById('ringInnerRadiusInput').value.trim();
    const startAngleRaw = document.getElementById('ringStartAngleInput').value.trim();
    const distribution = document.getElementById('ringDistributionSelect').value;
    const adjacentToRingId = document.getElementById('ringAdjacentInput').value.trim();
    const payload = { prefix, count };
    if (adjacentToRingId) {
      payload.adjacentToRingId = adjacentToRingId;
    } else {
      if (innerRadiusRaw) payload.innerRadiusM = Number(innerRadiusRaw);
      if (startAngleRaw) payload.startAngleRad = Number(startAngleRaw);
    }
    if (distribution) payload.distribution = distribution;
    try {
      const body = await apiFetch('/api/land-candidates/generate-ring', { method: 'POST', body: JSON.stringify(payload) });
      alert('Ring generated: ' + body.candidates.length + ' candidates (' + body.innerRadiusM + 'm – ' + body.outerRadiusM + 'm).');
      loadRings();
      loadCandidates();
      loadWorld();
    } catch (error) {
      showError(error.message);
    }
  }

  document.getElementById('mosaicGenerateBtn').addEventListener('click', generateMosaic);
  document.getElementById('ringGenerateBtn').addEventListener('click', generateRing);

  // --- Land candidate rings ---

  const ringsTableWrap = document.getElementById('ringsTableWrap');
  const ringsLoadMoreBtn = document.getElementById('ringsLoadMoreBtn');
  const ringDetailWrap = document.getElementById('ringDetailWrap');
  let ringsRows = [];
  let ringsNextCursor = null;
  // #1909: same monotonic-token guard loadModelsPage already uses -- without
  // it, a "Load more" response landing after a later "Refresh" reset (or two
  // overlapping Refresh clicks) can apply out of order, duplicating or
  // reverting rows with no ordering protection.
  let ringsLoadToken = 0;
  // #2073: same monotonic-token guard as ringsLoadToken just above --
  // viewRing() has no re-entrancy protection of its own, so an admin
  // clicking "Details" on one ring and then another before the first
  // response lands can have the slower response overwrite the faster
  // one, showing a ring that doesn't match the admin's last click.
  let ringDetailLoadToken = 0;

  function renderRings() {
    if (!ringsRows.length) {
      ringsTableWrap.innerHTML = '<p class="empty">No rings.</p>';
      ringsLoadMoreBtn.hidden = true;
      return;
    }
    const rows = ringsRows.map((ring) => `
      <tr>
        <td class="mono">${escapeHtml(ring.ringId)}</td>
        <td>${escapeHtml(ring.innerRadiusM)}</td>
        <td>${escapeHtml(ring.outerRadiusM)}</td>
        <td>${escapeHtml(ring.candidateCount)}</td>
        <td>${escapeHtml(ring.distribution || '—')}</td>
        <td>
          <button class="secondary ring-view-btn" data-ring-id="${escapeHtml(ring.ringId)}">Details</button>
          <button class="secondary ring-complete-btn" data-ring-id="${escapeHtml(ring.ringId)}">Generation complete</button>
        </td>
      </tr>
    `).join('');
    ringsTableWrap.innerHTML = `
      <table>
        <thead><tr><th>Ring ID</th><th>Inner m</th><th>Outer m</th><th>Count</th><th>Distribution</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    ringsLoadMoreBtn.hidden = !ringsNextCursor;
    ringsTableWrap.querySelectorAll('.ring-view-btn').forEach((btn) => {
      btn.addEventListener('click', () => viewRing(btn.dataset.ringId));
    });
    ringsTableWrap.querySelectorAll('.ring-complete-btn').forEach((btn) => {
      btn.addEventListener('click', () => completeRing(btn.dataset.ringId));
    });
  }

  async function loadRings(append) {
    const myLoadToken = ++ringsLoadToken;
    clearError();
    if (!append) {
      ringsRows = [];
      ringsTableWrap.innerHTML = '<p class="empty">Loading…</p>';
    }
    const params = new URLSearchParams();
    const adjacentFilter = document.getElementById('ringsFilterAdjacentInput').value.trim();
    if (adjacentFilter) params.set('adjacentToRingId', adjacentFilter);
    if (append && ringsNextCursor) params.set('cursor', ringsNextCursor);
    try {
      const body = await apiFetch('/api/land-candidate-rings?' + params.toString());
      if (myLoadToken !== ringsLoadToken) return;
      ringsRows = append ? ringsRows.concat(body.rings) : body.rings;
      ringsNextCursor = body.nextCursor;
      renderRings();
    } catch (error) {
      if (myLoadToken !== ringsLoadToken) return;
      showError(error.message);
      if (!append) ringsTableWrap.innerHTML = '<p class="empty">Failed to load.</p>';
    }
  }

  async function viewRing(ringId) {
    const myDetailLoadToken = ++ringDetailLoadToken;
    clearError();
    try {
      const body = await apiFetch('/api/land-candidate-rings/' + encodeURIComponent(ringId));
      if (myDetailLoadToken !== ringDetailLoadToken) return;
      document.getElementById('ringDetailId').textContent = body.ring.ringId;
      document.getElementById('ringDetailBody').textContent = JSON.stringify(body.ring, null, 2);
      ringDetailWrap.hidden = false;
    } catch (error) {
      if (myDetailLoadToken !== ringDetailLoadToken) return;
      showError(error.message);
    }
  }

  async function completeRing(ringId) {
    clearError();
    try {
      const body = await apiFetch('/api/land-candidate-rings/' + encodeURIComponent(ringId) + '/generation-complete', { method: 'POST' });
      alert('Ring ' + ringId + ' marked complete: ' + body.landlets.length + ' landlet(s) completed.');
      loadRings();
      loadWorld();
    } catch (error) {
      // A 409 here ("All ring candidates must be materialized...") is a
      // normal, expected state while the ring is still generating, not a bug.
      showError(error.message);
    }
  }

  document.getElementById('ringsRefreshBtn').addEventListener('click', () => loadRings(false));
  document.getElementById('ringsLoadMoreBtn').addEventListener('click', () => loadRings(true));
  document.getElementById('ringDetailCloseBtn').addEventListener('click', () => { ringDetailWrap.hidden = true; });

  // --- Land candidates browse/CRUD ---

  const candidatesTableWrap = document.getElementById('candidatesTableWrap');
  const candidatesLoadMoreBtn = document.getElementById('candidatesLoadMoreBtn');
  const candidateEditWrap = document.getElementById('candidateEditWrap');
  const candidateEditInput = document.getElementById('candidateEditInput');
  let candidatesRows = [];
  let candidatesNextCursor = null;
  let editingCandidateId = null;
  // #1910: a slower, overlapping loadCandidates call (e.g. an in-flight
  // "Load more" overtaken by a fresh "Refresh") could otherwise have its
  // stale response concat onto -- or overwrite -- whatever `candidatesRows`
  // holds by the time it lands. Same monotonic-token guard loadModelsPage
  // (#1878) and admin-action-log.html's load() (#1857) already use.
  let candidatesLoadToken = 0;

  function renderCandidates() {
    if (!candidatesRows.length) {
      candidatesTableWrap.innerHTML = '<p class="empty">No land candidates.</p>';
      candidatesLoadMoreBtn.hidden = true;
      return;
    }
    const rows = candidatesRows.map((candidate) => `
      <tr>
        <td class="mono">${escapeHtml(candidate.landletId)}</td>
        <td>${escapeHtml(candidate.name)}</td>
        <td>${escapeHtml(candidate.areaM2)}</td>
        <td>${escapeHtml(candidate.landClass)}</td>
        <td>${escapeHtml(candidate.landType)}</td>
        <td>${escapeHtml(candidate.ringId || '—')}</td>
        <td>${escapeHtml(candidate.materializedAt || '—')}</td>
        <td>
          <button class="secondary candidate-edit-btn" data-id="${escapeHtml(candidate.landletId)}">Edit</button>
          <button class="secondary candidate-delete-btn" data-id="${escapeHtml(candidate.landletId)}">Delete</button>
        </td>
      </tr>
    `).join('');
    candidatesTableWrap.innerHTML = `
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>Area m²</th><th>Class</th><th>Type</th><th>Ring</th><th>Materialized</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    candidatesLoadMoreBtn.hidden = !candidatesNextCursor;
    candidatesTableWrap.querySelectorAll('.candidate-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => startEditCandidate(btn.dataset.id));
    });
    candidatesTableWrap.querySelectorAll('.candidate-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => deleteCandidate(btn.dataset.id));
    });
  }

  async function loadCandidates(append) {
    const myLoadToken = ++candidatesLoadToken;
    clearError();
    if (!append) {
      candidatesRows = [];
      candidatesTableWrap.innerHTML = '<p class="empty">Loading…</p>';
    }
    const params = new URLSearchParams();
    const state = document.getElementById('candidatesStateSelect').value;
    if (state) params.set('state', state);
    const ringId = document.getElementById('candidatesRingIdInput').value.trim();
    if (ringId) params.set('ringId', ringId);
    if (append && candidatesNextCursor) params.set('cursor', candidatesNextCursor);
    try {
      const body = await apiFetch('/api/land-candidates?' + params.toString());
      if (myLoadToken !== candidatesLoadToken) return;
      candidatesRows = append ? candidatesRows.concat(body.candidates) : body.candidates;
      candidatesNextCursor = body.nextCursor;
      renderCandidates();
    } catch (error) {
      if (myLoadToken !== candidatesLoadToken) return;
      showError(error.message);
      if (!append) candidatesTableWrap.innerHTML = '<p class="empty">Failed to load.</p>';
    }
  }

  function startEditCandidate(landletId) {
    const candidate = candidatesRows.find((c) => c.landletId === landletId);
    if (!candidate) return;
    editingCandidateId = landletId;
    document.getElementById('candidateEditId').textContent = landletId;
    candidateEditInput.value = JSON.stringify({
      name: candidate.name,
      areaM2: candidate.areaM2,
      center: candidate.center,
      landClass: candidate.landClass,
      landType: candidate.landType,
      polygon: candidate.polygon,
      metadata: candidate.metadata,
    }, null, 2);
    candidateEditWrap.hidden = false;
  }

  async function saveCandidateEdit() {
    clearError();
    let patch;
    try {
      patch = JSON.parse(candidateEditInput.value);
    } catch (_) {
      showError('Candidate edit is not valid JSON');
      return;
    }
    try {
      await apiFetch('/api/land-candidates/' + encodeURIComponent(editingCandidateId), {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      candidateEditWrap.hidden = true;
      loadCandidates();
    } catch (error) {
      // A 409 here (materialized / ring-member immutability) is the
      // server's own validation, not re-implemented client-side -- surfaced
      // as-is per #1821's own scope note.
      showError(error.message);
    }
  }

  async function deleteCandidate(landletId) {
    if (!confirm('Delete land candidate ' + landletId + '?')) return;
    clearError();
    try {
      await apiFetch('/api/land-candidates/' + encodeURIComponent(landletId), { method: 'DELETE' });
      loadCandidates();
    } catch (error) {
      showError(error.message);
    }
  }

  document.getElementById('candidatesRefreshBtn').addEventListener('click', () => loadCandidates(false));
  document.getElementById('candidatesLoadMoreBtn').addEventListener('click', () => loadCandidates(true));
  document.getElementById('candidateEditSaveBtn').addEventListener('click', saveCandidateEdit);
  document.getElementById('candidateEditCancelBtn').addEventListener('click', () => { candidateEditWrap.hidden = true; });

  // --- Bulk-create (batch) ---

  async function submitBatch() {
    clearError();
    let candidates;
    try {
      candidates = JSON.parse(document.getElementById('batchInput').value);
    } catch (_) {
      showError('Batch input is not valid JSON');
      return;
    }
    if (!Array.isArray(candidates) || !candidates.length) {
      showError('Batch input must be a non-empty JSON array');
      return;
    }
    try {
      const body = await apiFetch('/api/land-candidates/batch', {
        method: 'POST',
        body: JSON.stringify({ candidates }),
      });
      alert('Batch created: ' + body.candidates.length + ' candidate(s), ' + body.landlets.length + ' materialized immediately.');
      document.getElementById('batchInput').value = '';
      loadCandidates();
      loadWorld();
    } catch (error) {
      // Overlap-against-existing-or-each-other 409s are the server's own
      // atomic validation (the whole batch rolls back) -- surfaced as-is.
      showError(error.message);
    }
  }

  document.getElementById('batchSubmitBtn').addEventListener('click', submitBatch);

  loadWorld();
  loadRings();
  loadCandidates();
})();

// #1823: tax / 1099 e-filing panel -- review/approve/file/void, plus the
// vendor connection test. Same fetch/render/escapeHtml shape as the roster
// panel's own script just above.
(function () {
  const errLine = document.getElementById('taxErr');
  const okLine = document.getElementById('taxOk');
  const tableWrap = document.getElementById('taxTableWrap');
  const yearInput = document.getElementById('taxYearInput');

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function clearMessages() {
    errLine.hidden = true;
    errLine.textContent = '';
    okLine.hidden = true;
    okLine.textContent = '';
  }

  function showError(message) {
    okLine.hidden = true;
    errLine.hidden = false;
    errLine.textContent = message;
  }

  function showOk(message) {
    errLine.hidden = true;
    okLine.hidden = false;
    okLine.textContent = message;
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

  let taxFormsLoadToken = 0;

  async function loadForms() {
    const myLoadToken = ++taxFormsLoadToken;
    clearMessages();
    tableWrap.innerHTML = '<p class="empty">Loading…</p>';
    const year = yearInput.value.trim();
    const query = year ? ('?year=' + encodeURIComponent(year)) : '';
    let body;
    try {
      body = await apiFetch('/api/tax/admin-forms' + query);
    } catch (error) {
      if (myLoadToken !== taxFormsLoadToken) return;
      showError(error.message);
      tableWrap.innerHTML = '<p class="empty">Failed to load.</p>';
      return;
    }
    if (myLoadToken !== taxFormsLoadToken) return;
    if (!yearInput.value) yearInput.value = body.year;
    renderForms(body.forms || []);
  }

  // Which action buttons a form's current status allows -- mirrors the
  // server's own transition guards (handleTax in worker/index.js) exactly,
  // so a disabled-looking action here never contradicts the 409 the server
  // would otherwise return for it.
  function actionsForStatus(status) {
    const actions = [];
    if (status === 'draft') actions.push('approve', 'void');
    if (status === 'approved') actions.push('file', 'void');
    return actions;
  }

  function renderForms(forms) {
    if (!forms.length) {
      tableWrap.innerHTML = '<p class="empty">No 1099 forms for this year.</p>';
      return;
    }
    const rows = forms.map((form) => {
      const buttons = actionsForStatus(form.status).map((action) => {
        const label = action === 'approve' ? 'Approve' : action === 'file' ? 'File' : 'Void';
        const cls = action === 'file' ? 'danger' : 'secondary';
        return `<button class="${cls} form-action-btn" data-form-id="${escapeHtml(form.formId)}" data-action="${action}">${label}</button>`;
      }).join(' ');
      return `
        <tr>
          <td>${escapeHtml(form.email || '—')}</td>
          <td>${escapeHtml(form.formType)}</td>
          <td><span class="status-pill status-${escapeHtml(form.status)}">${escapeHtml(form.status)}</span></td>
          <td>$${(form.grossIncomeCents / 100).toFixed(2)}</td>
          <td>${form.taxPaperworkOnFile ? 'Yes' : 'No'}</td>
          <td>${escapeHtml(form.filingReference || '—')}</td>
          <td>${buttons}</td>
        </tr>
      `;
    }).join('');
    tableWrap.innerHTML = `
      <table>
        <thead><tr>
          <th>Payee</th><th>Form</th><th>Status</th><th>Gross income</th>
          <th>Paperwork on file</th><th>Filing reference</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    tableWrap.querySelectorAll('.form-action-btn').forEach((btn) => {
      btn.addEventListener('click', () => runAction(btn.dataset.formId, btn.dataset.action));
    });
  }

  async function runAction(formId, action) {
    // #1823: /file is a real, irreversible transmission to the e-filing
    // vendor -- its own confirmation wording says so explicitly, separate
    // from approve/void's lighter-weight confirms.
    const prompt = action === 'file'
      ? 'File this form with the e-filing vendor? This transmits a real submission and cannot be undone here.'
      : (action === 'void' ? 'Void this form?' : 'Approve this form?');
    if (!confirm(prompt)) return;
    clearMessages();
    try {
      await apiFetch('/api/tax/admin-forms/' + encodeURIComponent(formId) + '/' + action, { method: 'POST' });
    } catch (error) {
      showError(error.message);
      return;
    }
    loadForms();
  }

  async function testConnection() {
    clearMessages();
    try {
      await apiFetch('/api/tax/efiling-connection-test');
    } catch (error) {
      showError(error.message);
      return;
    }
    showOk('Connected.');
  }

  document.getElementById('taxLoadBtn').addEventListener('click', loadForms);
  document.getElementById('taxConnectionTestBtn').addEventListener('click', testConnection);
  yearInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadForms(); });

  loadForms();
})();
