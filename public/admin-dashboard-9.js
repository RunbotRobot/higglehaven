// #4122: the Video-to-3D jobs panel. One admin-only list (GET /api/admin-video-jobs, the latest 50, no paging until
// 50 no longer reaches back a week) and, on a failed job, "Check the saved result" (POST .../check), which shows what
// the provider's output holds and whether saving it would work now. Nothing here changes a job or a credit.
(function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    let body;
    try { body = await response.json(); } catch (_) { body = null; }
    if (!response.ok) throw new Error((body && body.error) || ('Request failed (' + response.status + ')'));
    return body;
  }

  const REASONS = {
    download_refused: 'The provider refused the download of the finished model.',
    too_big: 'The finished model is over the size limit.',
    not_a_glb: 'The finished file is not a model we accept.',
    no_model_url: 'The provider reported success but gave no file.',
    store_error: 'Saving failed on our side.',
    task_not_successful: 'The provider says the task is not finished successfully.',
    would_save_now: 'The model would be saved if tried now.',
    unreadable: 'The kept reason could not be read.',
  };

  function describe(detail) {
    if (!detail) return '';
    const parts = [REASONS[detail.reason] || String(detail.reason || '')];
    if (detail.httpStatus) parts.push('HTTP ' + detail.httpStatus);
    if (detail.bytes != null) parts.push(detail.bytes + ' bytes');
    if (detail.contentType) parts.push(detail.contentType);
    if (detail.validatorMessage) parts.push(detail.validatorMessage);
    if (detail.outputKeys && detail.outputKeys.length) parts.push('provider output: ' + detail.outputKeys.join(', '));
    if (detail.checkedAt) parts.push('checked ' + detail.checkedAt);
    return parts.filter(Boolean).join(' · ');
  }

  const err = document.getElementById('videoJobsErr');
  const wrap = document.getElementById('videoJobsWrap');
  const countLine = document.getElementById('videoJobsCountLine');

  async function load() {
    err.hidden = true;
    countLine.textContent = 'Loading…';
    try {
      const body = await fetchJson('/api/admin-video-jobs');
      countLine.textContent = body.jobs.length === 0 ? 'No jobs yet.' : body.jobs.length + ' jobs' + (body.jobs.length >= body.limit ? ' (the latest ' + body.limit + ')' : '');
      wrap.innerHTML = body.jobs.length === 0 ? '' : '<table><thead><tr><th>Started</th><th>Builder</th><th>Status</th><th>Why</th><th></th></tr></thead><tbody>'
        + body.jobs.map((job) => '<tr data-job="' + escapeHtml(job.jobId) + '">'
          + '<td>' + escapeHtml(job.createdAt) + '</td>'
          + '<td>' + escapeHtml(job.username || '') + '</td>'
          + '<td>' + escapeHtml(job.status) + '</td>'
          + '<td class="video-job-why">' + escapeHtml(describe(job.detail) || job.message || '') + '</td>'
          + '<td>' + (job.canCheck ? '<button class="secondary" data-check="' + escapeHtml(job.jobId) + '">Check the saved result</button>' : '') + '</td>'
          + '</tr>').join('')
        + '</tbody></table>';
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      countLine.textContent = '';
    }
  }

  async function check(button) {
    const jobId = button.dataset.check;
    button.disabled = true;
    err.hidden = true;
    try {
      const result = await fetchJson('/api/admin-video-jobs/' + encodeURIComponent(jobId) + '/check', { method: 'POST' });
      const cell = button.closest('tr').querySelector('.video-job-why');
      cell.textContent = describe(result.detail);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      button.disabled = false;
    }
  }

  wrap.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-check]');
    if (button) check(button);
  });
  document.getElementById('videoJobsRefreshBtn').addEventListener('click', load);

  window.__adminDashboardPanels = window.__adminDashboardPanels || {};
  window.__adminDashboardPanels['video-jobs'] = load;
})();
