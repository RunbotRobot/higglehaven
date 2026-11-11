// #1820: R2 model storage panel -- lazy-initialized on first tab open
// (see window.__adminDashboardPanels above) since the R2 listing/usage
// call is comparatively expensive and shouldn't run until the admin
// actually opens this tab.
(function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function formatBytes(bytes) {
    // Same GB-tier convention as src/main.js's own formatBytes (#1571).
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'GB';
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + 'KB';
    return bytes + 'B';
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    let body;
    try { body = await response.json(); } catch (_) { body = null; }
    if (!response.ok) throw new Error((body && body.error) || ('Request failed (' + response.status + ')'));
    return body;
  }

  window.__adminDashboardPanels.models = function initModelsPanel() {
    const storageCard = document.getElementById('modelsStorageCard');
    const errLine = document.getElementById('modelsErr');
    const tableWrap = document.getElementById('modelsTableWrap');
    const loadMoreWrap = document.getElementById('modelsLoadMoreWrap');
    const loadMoreBtn = document.getElementById('modelsLoadMoreBtn');
    const refreshBtn = document.getElementById('modelsRefreshBtn');
    const maxInput = document.getElementById('modelsCleanupMax');
    const dryRunBtn = document.getElementById('modelsDryRunBtn');
    const realRunBtn = document.getElementById('modelsRealRunBtn');
    const cleanupErr = document.getElementById('modelsCleanupErr');
    const cleanupResult = document.getElementById('modelsCleanupResult');

    let rows = [];
    let nextCursor = null;
    // #1878: a slower, overlapping loadModelsPage call (e.g. an in-flight
    // "Load more" overtaken by a fresh "Refresh") could otherwise have its
    // stale response concat onto -- or overwrite -- whatever `rows` holds
    // by the time it lands, corrupting the list with duplicate/stale/out-
    // of-order rows. Same monotonic-token guard admin-action-log.html's
    // load() (#1857) already uses.
    let modelsLoadToken = 0;
    // The dry run's own target set is what "Delete now" is allowed to act
    // on -- re-running cleanup for real against a stale dry run could
    // delete something a template started referencing in the meantime
    // (same reasoning as cleanupUnreferencedModels' own re-check right
    // before its delete), so any change to maxDeletes, or a real run
    // completing, clears this and requires a fresh dry run first.
    let lastDryRunMaxDeletes = null;

    function clearErr(el) { el.hidden = true; el.textContent = ''; }
    function showErr(el, message) { el.hidden = false; el.textContent = message; }

    function disarmRealRun() {
      lastDryRunMaxDeletes = null;
      realRunBtn.disabled = true;
    }
    maxInput.addEventListener('input', disarmRealRun);

    async function loadStorage() {
      try {
        const usage = await fetchJson('/api/models/storage');
        const pct = Math.min(100, usage.utilizationRatio * 100);
        const barClass = usage.utilizationRatio >= 0.9 ? 'crit' : usage.utilizationRatio >= 0.7 ? 'warn' : '';
        storageCard.innerHTML =
          '<strong>' + formatBytes(usage.usedBytes) + '</strong> used of ' + formatBytes(usage.capBytes) +
          ' (' + usage.objectCount + ' objects, ' + formatBytes(usage.availableBytes) + ' available)' +
          '<div class="models-storage-bar"><div class="models-storage-bar-fill ' + barClass + '" style="width:' + pct.toFixed(1) + '%"></div></div>';
      } catch (error) {
        storageCard.textContent = 'Failed to load storage usage: ' + error.message;
      }
    }

    function renderTable() {
      if (!rows.length) {
        tableWrap.innerHTML = '<p class="empty">No uploaded models/thumbnails.</p>';
        return;
      }
      const body = rows.map((row) => {
        const refs = [];
        if (row.referencedByTemplateIds.length) refs.push('template: ' + row.referencedByTemplateIds.join(', '));
        if (row.referencedByVideoJobIds.length) refs.push('videoJob: ' + row.referencedByVideoJobIds.join(', '));
        if (row.referencedByControlRoomIds.length) refs.push('controlRoom: ' + row.referencedByControlRoomIds.join(', '));
        // #3414: a product's mid/far model, so a mismatched reduction is visible here.
        if ((row.referencedAsTierBy || []).length) refs.push('reduced model of: ' + row.referencedAsTierBy.join(', '));
        return '<tr>' +
          '<td>' + escapeHtml(row.modelUrl) + '</td>' +
          '<td>' + formatBytes(row.sizeBytes) + '</td>' +
          '<td>' + escapeHtml(row.uploadedAt || '—') + '</td>' +
          '<td class="ref-ids">' + (refs.length ? escapeHtml(refs.join(' · ')) : (row.deletable ? '<span class="deletable-tag">unreferenced</span>' : '—')) + '</td>' +
          '<td>' + (row.deletable ? '<button class="secondary model-delete-btn" data-model-url="' + escapeHtml(row.modelUrl) + '">Delete</button>' : '—') + '</td>' +
          '</tr>';
      }).join('');
      tableWrap.innerHTML =
        '<table><thead><tr><th>Model URL</th><th>Size</th><th>Uploaded</th><th>Referenced by</th><th></th></tr></thead><tbody>' + body + '</tbody></table>';
      tableWrap.querySelectorAll('.model-delete-btn').forEach((btn) => {
        btn.addEventListener('click', () => deleteModel(btn.dataset.modelUrl));
      });
    }

    // #2355: the one single-object escape hatch docs/API.md describes for
    // reclaiming one specific unreferenced upload, same DELETE /uploads/:key
    // endpoint the admin-only bulk cleanup flow above already exercises --
    // this just wires it to one row instead of a bucket-wide sweep. Only
    // ever enabled (see renderTable's own `row.deletable` check) for a row
    // the server already reports as unreferenced; the DELETE handler's own
    // last-step referenced-model re-check is still the real guard.
    async function deleteModel(modelUrl) {
      if (!window.confirm('Permanently delete ' + modelUrl + ' from R2? This cannot be undone.')) return;
      clearErr(errLine);
      try {
        await fetchJson(modelUrl, { method: 'DELETE' });
        rows = rows.filter((row) => row.modelUrl !== modelUrl);
        renderTable();
        loadStorage();
      } catch (error) {
        showErr(errLine, error.message);
      }
    }

    async function loadModelsPage(cursor) {
      const myLoadToken = ++modelsLoadToken;
      clearErr(errLine);
      const params = new URLSearchParams({ limit: '100' });
      if (cursor) params.set('cursor', cursor);
      try {
        const body = await fetchJson('/api/models?' + params.toString());
        if (myLoadToken !== modelsLoadToken) return;
        rows = cursor ? rows.concat(body.models) : body.models;
        nextCursor = body.nextCursor;
        loadMoreWrap.hidden = !nextCursor;
        renderTable();
      } catch (error) {
        if (myLoadToken !== modelsLoadToken) return;
        showErr(errLine, error.message);
      }
    }

    refreshBtn.addEventListener('click', () => { rows = []; nextCursor = null; loadModelsPage(null); });
    loadMoreBtn.addEventListener('click', () => loadModelsPage(nextCursor));

    async function runCleanup(dryRun) {
      clearErr(cleanupErr);
      const maxDeletes = Number(maxInput.value);
      if (!Number.isInteger(maxDeletes) || maxDeletes < 1 || maxDeletes > 100) {
        showErr(cleanupErr, 'Max deletes must be an integer from 1 to 100.');
        return;
      }
      dryRunBtn.disabled = true;
      realRunBtn.disabled = true;
      try {
        const result = await fetchJson('/api/models/cleanup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ maxDeletes, dryRun }),
        });
        const verb = dryRun ? 'Would delete' : 'Deleted';
        cleanupResult.innerHTML =
          '<p>' + verb + ' <strong>' + result.targetCount + '</strong> object(s), reclaiming ' + formatBytes(result.reclaimedBytes) +
          (result.completeScan ? '' : ' (bucket has more unreferenced objects beyond this maxDeletes cap)') + '.</p>' +
          (result.targetModelUrls.length
            ? '<p class="ref-ids">' + escapeHtml(result.targetModelUrls.join(', ')) + '</p>'
            : '');
        if (dryRun) {
          // Only this exact maxDeletes' own dry-run result arms the real
          // run -- changing the number (disarmRealRun, wired above) or a
          // completed real run both require a fresh dry run first, so
          // "Delete now" never fires against a stale preview.
          lastDryRunMaxDeletes = maxDeletes;
          realRunBtn.disabled = false;
        } else {
          disarmRealRun();
          // The objects just deleted are now gone from R2 -- refresh both
          // the list and the storage card rather than leaving stale rows
          // (including ones this very run just removed) on screen.
          rows = []; nextCursor = null;
          loadModelsPage(null);
          loadStorage();
        }
      } catch (error) {
        showErr(cleanupErr, error.message);
      } finally {
        dryRunBtn.disabled = false;
        // #2525: this must be an unconditional re-sync, not a one-way
        // "disable only" guard -- a thrown real-run request (network blip,
        // a 409, a transient 5xx) left lastDryRunMaxDeletes/maxDeletes
        // still equal (nothing cleared the arm), so the old `if` left
        // realRunBtn stuck disabled forever even though its arming state
        // was still genuinely valid.
        realRunBtn.disabled = (lastDryRunMaxDeletes !== maxDeletes);
      }
    }
    dryRunBtn.addEventListener('click', () => runCleanup(true));
    realRunBtn.addEventListener('click', () => {
      if (lastDryRunMaxDeletes !== Number(maxInput.value)) return; // stale arm guard, belt-and-suspenders
      if (!window.confirm('Permanently delete these unreferenced uploads from R2? This cannot be undone.')) return;
      runCleanup(false);
    });

    loadStorage();
    loadModelsPage(null);
  };
})();
