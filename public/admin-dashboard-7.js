(function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function formatCents(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  // #2402: endsAt is a raw ISO-8601 instant (worker/index.js's
  // activeAuctionConflict) -- format it the same way #2352's
  // handleSuspendAccount fix formats its own *EndsAt field, rather than
  // interpolating the raw instant.
  function formatEndsAt(isoString) {
    return new Date(isoString).toLocaleString();
  }

  // #1822: landlet override panel -- look up a landlet by id, then
  // force-complete a stuck `generating` landlet or reassign a `claimed`
  // one's owner by hand. The judgment calls this needed (land cap is a
  // hard rule even here, and an active auction blocks the reassignment
  // unless explicitly cancelled) are already enforced server-side by
  // #1281/#1711 -- this panel is just a form over those guarded endpoints,
  // not a reason to re-implement their checks client-side.
  window.__adminDashboardPanels.landlets = function initLandletsPanel() {
    const errLine = document.getElementById('landletsErr');
    const lookupInput = document.getElementById('landletLookupInput');
    const detailWrap = document.getElementById('landletDetailWrap');
    const statGrid = document.getElementById('landletStatGrid');
    const forceCompleteWrap = document.getElementById('landletForceCompleteWrap');
    const forceCompleteNote = document.getElementById('landletForceCompleteNote');
    const reassignWrap = document.getElementById('landletReassignWrap');
    const reassignTargetInput = document.getElementById('landletReassignTargetInput');
    const auctionConflictWrap = document.getElementById('landletAuctionConflictWrap');
    const auctionDetailsEl = document.getElementById('landletAuctionDetails');

    function clearError() { errLine.hidden = true; errLine.textContent = ''; }
    function showError(message) { errLine.hidden = false; errLine.textContent = message; }

    async function apiFetch(path, options) {
      const response = await fetch(path, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options && options.headers) },
      });
      let body = null;
      try { body = await response.json(); } catch (_) { /* no body */ }
      if (!response.ok) {
        const error = new Error((body && body.error) || ('Request failed (' + response.status + ')'));
        // #1711's 409 response carries the active-auction conflict's own
        // details alongside `error` -- attach it to the thrown Error so
        // the reassign flow below can offer the cancel-and-proceed choice
        // without a second round trip.
        if (body && body.activeAuction) error.activeAuction = body.activeAuction;
        throw error;
      }
      return body;
    }

    let currentLandlet = null;

    function renderLandlet(landlet) {
      currentLandlet = landlet;
      statGrid.innerHTML = `
        <div class="stat"><div class="n mono">${escapeHtml(landlet.landletId)}</div><div class="l">id</div></div>
        <div class="stat"><div class="n">${escapeHtml(landlet.status)}</div><div class="l">status</div></div>
        <div class="stat"><div class="n mono">${escapeHtml(landlet.ownerBuilderId || '—')}</div><div class="l">owner</div></div>
        <div class="stat"><div class="n">${escapeHtml(landlet.areaM2)}</div><div class="l">area m²</div></div>
        <div class="stat"><div class="n">${escapeHtml(landlet.generatedAt || '—')}</div><div class="l">generated</div></div>
      `;
      detailWrap.hidden = false;
      forceCompleteWrap.hidden = landlet.status !== 'generating';
      forceCompleteNote.hidden = true;
      reassignWrap.hidden = landlet.status !== 'claimed';
      auctionConflictWrap.hidden = true;
      reassignTargetInput.value = '';
      renderGreenbelt(landlet);
    }

    // #4075: Make greenbelt. The button is disabled, with its reason, when there is nothing to release.
    const greenbeltBtn = document.getElementById('landletGreenbeltBtn');
    const greenbeltHint = document.getElementById('landletGreenbeltHint');
    const greenbeltModal = document.getElementById('landletGreenbeltModal');
    const greenbeltModalErr = document.getElementById('landletGreenbeltModalErr');
    const GREENBELT_HINT = greenbeltHint.textContent;
    function renderGreenbelt(landlet) {
      const claimed = landlet.status === 'claimed' && landlet.ownerBuilderId;
      greenbeltBtn.disabled = !claimed;
      greenbeltHint.textContent = claimed ? GREENBELT_HINT
        : (landlet.status === 'greenbelt' ? 'This landlet is already greenbelt.' : 'Only a claimed landlet can be made greenbelt.');
      greenbeltModal.hidden = true;
    }
    greenbeltBtn.addEventListener('click', () => {
      if (!currentLandlet) return;
      document.getElementById('landletGreenbeltModalBody').textContent = 'Landlet ' + currentLandlet.landletId
        + ' (owner ' + currentLandlet.ownerBuilderId + ') goes back to the greenbelt. Everything the owner built there is moved into their saved layouts, '
        + 'its published versions and levels are cleared, and the owner gets a notice. Anyone can then claim it. This is written to the admin log.';
      greenbeltModalErr.hidden = true;
      greenbeltModal.hidden = false;
      document.getElementById('landletGreenbeltConfirmBtn').focus();
    });
    document.getElementById('landletGreenbeltCancelBtn').addEventListener('click', () => { greenbeltModal.hidden = true; });
    document.getElementById('landletGreenbeltConfirmBtn').addEventListener('click', async () => {
      if (!currentLandlet) return;
      try {
        const body = await apiFetch('/api/landlets/' + encodeURIComponent(currentLandlet.landletId) + '/make-greenbelt', { method: 'POST', body: '{}' });
        renderLandlet(body.landlet);
      } catch (error) {
        greenbeltModalErr.textContent = error.message;
        greenbeltModalErr.hidden = false;
      }
    });

    // #2062/#2072: lookupLandlet() and forceComplete()/reassign() below all
    // race each other -- a lookup, a force-complete, and a reassign-owner
    // call can each be in flight at once, all resolving into the very same
    // renderLandlet() (which also reassigns currentLandlet). Every one of
    // them increments this single shared token, so whichever call is
    // actually the LATEST one started always wins the eventual render,
    // regardless of which order their responses happen to land in -- same
    // monotonic-token idiom every other panel in this file already uses
    // (loadRosterToken, worldLoadToken, ringsLoadToken, etc.), just shared
    // across three call sites instead of one.
    let landletLookupToken = 0;

    // #4074: "Look up" first tries the text as an exact id, exactly as before; when that finds nothing it
    // searches by name, id or owner. One match loads straight away, several are listed to choose from.
    const searchResultsEl = document.getElementById('landletSearchResults');
    const searchNoteEl = document.getElementById('landletSearchNote');
    function clearSearchResults() {
      searchResultsEl.hidden = true;
      searchResultsEl.innerHTML = '';
      searchNoteEl.hidden = true;
      searchNoteEl.textContent = '';
    }

    async function loadLandletById(landletId, myToken) {
      const body = await apiFetch('/api/landlets/' + encodeURIComponent(landletId));
      if (myToken !== landletLookupToken) return;
      renderLandlet(body.landlet);
    }

    function renderSearchResults(result) {
      searchResultsEl.innerHTML = result.landlets.map((l) => `
        <button type="button" class="landlet-search-row" data-landlet-id="${escapeHtml(l.landletId)}">
          <span class="mono">${escapeHtml(l.landletId)}</span>
          <span>${escapeHtml(l.name)}</span>
          <span>${escapeHtml(l.ownerUsername || (l.status === 'claimed' ? 'owner unknown' : 'unowned'))}</span>
          <span>${escapeHtml(l.status)}</span>
          <span>${escapeHtml(Math.round(l.areaM2))} m²</span>
        </button>`).join('');
      searchResultsEl.hidden = false;
      searchNoteEl.hidden = false;
      searchNoteEl.textContent = result.total > result.shown
        ? 'Showing ' + result.shown + ' of ' + result.total + (result.scanCapped ? '+' : '') + ' — type more to narrow it.'
        : result.total + (result.total === 1 ? ' lándlet' : ' lándlets') + ' found. Choose one to load it.';
    }

    async function lookupLandlet() {
      clearError();
      clearSearchResults();
      const query = lookupInput.value.trim();
      if (!query) return;
      const myLandletLookupToken = ++landletLookupToken;
      try {
        await loadLandletById(query, myLandletLookupToken);
        return;
      } catch (idError) {
        if (myLandletLookupToken !== landletLookupToken) return;
        try {
          const result = await apiFetch('/api/auth/admin-landlet-search?q=' + encodeURIComponent(query));
          if (myLandletLookupToken !== landletLookupToken) return;
          if (result.landlets.length === 1) {
            await loadLandletById(result.landlets[0].landletId, myLandletLookupToken);
            return;
          }
          if (result.landlets.length > 1) {
            detailWrap.hidden = true;
            renderSearchResults(result);
            return;
          }
        } catch (_) { /* the search is a convenience; the id lookup's own message below is the honest one */ }
        if (myLandletLookupToken !== landletLookupToken) return;
        detailWrap.hidden = true;
        showError(idError.message);
      }
    }

    searchResultsEl.addEventListener('click', (e) => {
      const row = e.target.closest('.landlet-search-row');
      if (!row) return;
      lookupInput.value = row.dataset.landletId;
      lookupLandlet();
    });

    async function forceComplete() {
      if (!currentLandlet) return;
      clearError();
      const myLandletLookupToken = ++landletLookupToken;
      try {
        const body = await apiFetch(
          '/api/landlets/' + encodeURIComponent(currentLandlet.landletId) + '/generation-complete',
          { method: 'POST' },
        );
        if (myLandletLookupToken !== landletLookupToken) return;
        renderLandlet(body.landlet);
        // #1888: a landlet the world circle doesn't yet fully enclose stays
        // "generating" even after this call succeeds (generatedAt is set,
        // but expandWorldOnce promotes it to greenbelt later) -- without
        // this, the button just stays visible with no sign anything
        // happened, indistinguishable from a no-op.
        if (body.landlet.status === 'generating') {
          forceCompleteNote.hidden = false;
          forceCompleteNote.textContent = 'Generation marked complete; this landlet will become greenbelt once a world expansion encloses it.';
        }
      } catch (error) {
        if (myLandletLookupToken !== landletLookupToken) return;
        showError(error.message);
      }
    }

    async function reassign(cancelActiveAuction) {
      if (!currentLandlet) return;
      const ownerBuilderId = reassignTargetInput.value.trim();
      if (!ownerBuilderId) return;
      clearError();
      const myLandletLookupToken = ++landletLookupToken;
      const payload = { ownerBuilderId };
      if (cancelActiveAuction) payload.cancelActiveAuction = true;
      try {
        const body = await apiFetch(
          '/api/landlets/' + encodeURIComponent(currentLandlet.landletId) + '/reassign-owner',
          { method: 'POST', body: JSON.stringify(payload) },
        );
        if (myLandletLookupToken !== landletLookupToken) return;
        renderLandlet(body.landlet);
      } catch (error) {
        if (myLandletLookupToken !== landletLookupToken) return;
        if (error.activeAuction) {
          const a = error.activeAuction;
          auctionDetailsEl.textContent = 'Active auction ' + a.auctionId + ': starting bid '
            + formatCents(a.startingBidCents) + ', high bid ' + (a.highBidCents == null ? 'none yet' : formatCents(a.highBidCents))
            + ', ' + a.bidderCount + ' bidder(s), ends ' + formatEndsAt(a.endsAt) + '.';
          auctionConflictWrap.hidden = false;
          return;
        }
        showError(error.message);
      }
    }

    document.getElementById('landletLookupBtn').addEventListener('click', lookupLandlet);
    lookupInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') lookupLandlet(); });
    document.getElementById('landletForceCompleteBtn').addEventListener('click', forceComplete);
    document.getElementById('landletReassignBtn').addEventListener('click', () => reassign(false));
    document.getElementById('landletCancelAuctionReassignBtn').addEventListener('click', async () => {
      if (!(await window.adminConfirm({ title: 'Cancel auction', message: 'Cancel the active auction and reassign this landlet?', confirmLabel: 'Cancel auction' }))) return;
      reassign(true);
    });
    document.getElementById('landletAuctionAbortBtn').addEventListener('click', () => {
      auctionConflictWrap.hidden = true;
    });
  };
})();
