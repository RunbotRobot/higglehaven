// #4060: the Users table on the Accounts tab. One admin-only request (GET /api/auth/admin-users) returns
// every user, capped, with the column definitions; sorting, filtering and the choice of columns all
// happen here, in the page. The sort, filters, search and columns are remembered in this browser.
(function () {
  const PREFS_KEY = 'hh-admin-users-table-v1';

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    let body;
    try { body = await response.json(); } catch (_) { body = null; }
    if (!response.ok) throw new Error((body && body.error) || ('Request failed (' + response.status + ')'));
    return body;
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
  function savePrefs(prefs) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* remembered only when the browser allows */ }
  }

  const isNil = (v) => v === null || v === undefined || v === '';
  const dollars = window.hhFormatCents; // #4681

  // #4073: every column has a set width (from its kind) the owner can change by dragging the right edge of
  // its heading; widths are remembered with the rest of the view and "Reset view" clears them. Wide enough
  // for the filter control under the heading (two date boxes, or a min and a max).
  const DEFAULT_WIDTHS = { text: 170, choice: 140, bool: 100, number: 140, money: 150, date: 280 };
  const USERNAME_WIDTH = 200;
  const MIN_WIDTH = 56;
  const MAX_WIDTH = 800;
  const clampWidth = (n) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(n)));
  function defaultWidth(col) {
    return col.key === 'username' ? USERNAME_WIDTH : (DEFAULT_WIDTHS[col.kind] || DEFAULT_WIDTHS.text);
  }

  // The text a cell shows, and the value its filters and sort read.
  function displayText(col, value) {
    if (isNil(value)) return '—';
    if (col.kind === 'bool') return value ? 'Yes' : 'No';
    if (col.kind === 'money') return dollars(value);
    if (col.kind === 'date') {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
    }
    return String(value);
  }
  function titleText(col, value) {
    return col.kind === 'date' && !isNil(value) ? String(value) : '';
  }

  function compareValues(col, a, b) {
    if (isNil(a) && isNil(b)) return 0;
    if (isNil(a)) return 1; // empty values sort last whichever way the column goes
    if (isNil(b)) return -1;
    if (col.kind === 'number' || col.kind === 'money') return a - b;
    if (col.kind === 'bool') return (a ? 1 : 0) - (b ? 1 : 0);
    if (col.kind === 'date') return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
  }

  function localDay(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function passesFilter(col, filter, value) {
    if (!filter) return true;
    if (col.kind === 'text') {
      const q = (filter.q || '').trim().toLowerCase();
      return !q || String(value == null ? '' : value).toLowerCase().includes(q);
    }
    if (col.kind === 'bool') {
      if (filter.v === 'yes') return value === true;
      if (filter.v === 'no') return value === false || isNil(value);
      return true;
    }
    if (col.kind === 'choice') {
      if (isNil(filter.v)) return true;
      return filter.v === '__none__' ? isNil(value) : value === filter.v;
    }
    if (col.kind === 'number' || col.kind === 'money') {
      const hasMin = filter.min !== '' && filter.min != null;
      const hasMax = filter.max !== '' && filter.max != null;
      if (!hasMin && !hasMax) return true;
      if (isNil(value)) return false;
      const scale = col.kind === 'money' ? 100 : 1;
      const n = value / scale;
      if (hasMin && n < Number(filter.min)) return false;
      if (hasMax && n > Number(filter.max)) return false;
      return true;
    }
    if (col.kind === 'date') {
      if (!filter.from && !filter.to) return true;
      if (isNil(value)) return false;
      const day = localDay(value);
      if (!day) return false;
      if (filter.from && day < filter.from) return false;
      if (filter.to && day > filter.to) return false;
      return true;
    }
    return true;
  }

  function filterIsActive(col, filter) {
    if (!filter) return false;
    if (col.kind === 'text') return Boolean((filter.q || '').trim());
    if (col.kind === 'bool' || col.kind === 'choice') return !isNil(filter.v) && filter.v !== 'any';
    if (col.kind === 'number' || col.kind === 'money') return !isNil(filter.min) || !isNil(filter.max);
    if (col.kind === 'date') return Boolean(filter.from || filter.to);
    return false;
  }

  let started = false;
  window.__adminUsersTableInit = function initUsersTable() {
    if (started) return;
    started = true;
    const wrap = document.getElementById('usersTableWrap');
    const countLine = document.getElementById('usersCountLine');
    const capLine = document.getElementById('usersCapLine');
    const searchInput = document.getElementById('usersSearchInput');
    const columnsBtn = document.getElementById('usersColumnsBtn');
    const chooser = document.getElementById('usersColumnChooser');
    const clearBtn = document.getElementById('usersClearBtn');
    const resetBtn = document.getElementById('usersResetBtn');
    const refreshBtn = document.getElementById('usersRefreshBtn');
    const errLine = document.getElementById('userSearchErr');

    let columns = [];
    let users = [];
    let total = 0;
    let prefs = { visible: null, sort: { key: 'createdAt', dir: 'desc' }, filters: {}, search: '', widths: {} };
    const saved = loadPrefs();
    if (saved && typeof saved === 'object') prefs = { ...prefs, ...saved, filters: saved.filters || {}, widths: saved.widths && typeof saved.widths === 'object' ? saved.widths : {} };
    searchInput.value = prefs.search || '';

    const colByKey = () => new Map(columns.map((c) => [c.key, c]));
    function defaultVisible() { return columns.filter((c) => c.default).map((c) => c.key); }
    function visibleColumns() {
      const byKey = colByKey();
      const keys = (prefs.visible && prefs.visible.length ? prefs.visible : defaultVisible()).filter((k) => byKey.has(k));
      const rest = keys.filter((k) => k !== 'username');
      return ['username', ...rest].map((k) => byKey.get(k)); // the username column is always first and always shown
    }
    function persist() { savePrefs(prefs); }
    function widthOf(col) {
      const w = Number(prefs.widths && prefs.widths[col.key]);
      return Number.isFinite(w) && w > 0 ? clampWidth(w) : defaultWidth(col);
    }

    function rowMatches(user, cols) {
      for (const col of columns) {
        if (!passesFilter(col, prefs.filters[col.key], user[col.key])) return false;
      }
      const q = (prefs.search || '').trim().toLowerCase();
      if (q) {
        const hay = columns.some((col) => displayText(col, user[col.key]).toLowerCase().includes(q)
          || String(user[col.key] == null ? '' : user[col.key]).toLowerCase().includes(q));
        if (!hay) return false;
      }
      return true;
    }

    function shownUsers() {
      const byKey = colByKey();
      const sortCol = byKey.get(prefs.sort && prefs.sort.key) || byKey.get('createdAt');
      const dir = prefs.sort && prefs.sort.dir === 'asc' ? 1 : -1;
      const rows = users.filter((u) => rowMatches(u));
      if (sortCol) {
        rows.sort((a, b) => {
          const av = a[sortCol.key];
          const bv = b[sortCol.key];
          if (isNil(av) && !isNil(bv)) return 1;
          if (!isNil(av) && isNil(bv)) return -1;
          return dir * compareValues(sortCol, av, bv);
        });
      }
      return rows;
    }

    function filterControl(col) {
      const f = prefs.filters[col.key] || {};
      const label = escapeHtml(col.label);
      if (col.kind === 'bool') {
        const v = f.v || 'any';
        return '<select data-filter="' + col.key + '" aria-label="Filter ' + label + '">'
          + ['any', 'yes', 'no'].map((o) => '<option value="' + o + '"' + (v === o ? ' selected' : '') + '>' + (o === 'any' ? 'Any' : o === 'yes' ? 'Yes' : 'No') + '</option>').join('')
          + '</select>';
      }
      if (col.kind === 'choice') {
        const values = [...new Set(users.map((u) => u[col.key]).filter((v) => !isNil(v)))].sort((a, b) => String(a).localeCompare(String(b)));
        const hasNone = users.some((u) => isNil(u[col.key]));
        const v = isNil(f.v) ? '' : f.v;
        return '<select data-filter="' + col.key + '" aria-label="Filter ' + label + '"><option value="">Any</option>'
          + values.map((o) => '<option value="' + escapeHtml(o) + '"' + (v === o ? ' selected' : '') + '>' + escapeHtml(o) + '</option>').join('')
          + (hasNone ? '<option value="__none__"' + (v === '__none__' ? ' selected' : '') + '>(none)</option>' : '')
          + '</select>';
      }
      if (col.kind === 'number' || col.kind === 'money') {
        return '<span class="users-range"><input type="number" inputmode="decimal" data-filter="' + col.key + '" data-part="min" placeholder="min" value="' + escapeHtml(f.min == null ? '' : f.min) + '" aria-label="' + label + ' at least" />'
          + '<input type="number" inputmode="decimal" data-filter="' + col.key + '" data-part="max" placeholder="max" value="' + escapeHtml(f.max == null ? '' : f.max) + '" aria-label="' + label + ' at most" /></span>';
      }
      if (col.kind === 'date') {
        return '<span class="users-range"><input type="date" data-filter="' + col.key + '" data-part="from" value="' + escapeHtml(f.from || '') + '" aria-label="' + label + ' from" />'
          + '<input type="date" data-filter="' + col.key + '" data-part="to" value="' + escapeHtml(f.to || '') + '" aria-label="' + label + ' to" /></span>';
      }
      return '<input type="search" data-filter="' + col.key + '" placeholder="contains" value="' + escapeHtml(f.q || '') + '" aria-label="Filter ' + label + '" />';
    }

    // The heading rows (names to sort by, and the filter controls) are drawn when the columns or the sort
    // change, not while typing in a filter, so a filter box keeps focus as its rows narrow.
    function renderTable() {
      const cols = visibleColumns();
      const sortKey = prefs.sort && prefs.sort.key;
      const head = cols.map((col) => {
        const active = col.key === sortKey;
        const arrow = active ? (prefs.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
        return '<th scope="col" data-key="' + col.key + '"' + (active ? ' aria-sort="' + (prefs.sort.dir === 'asc' ? 'ascending' : 'descending') + '"' : '')
          + (col.title ? ' title="' + escapeHtml(col.title) + '"' : '') + '>'
          + '<button type="button" class="users-sort" data-sort="' + col.key + '">' + escapeHtml(col.label) + arrow + '</button>'
          + '<span class="users-resize" role="separator" aria-orientation="vertical" tabindex="0" data-resize="' + col.key + '"'
          + ' aria-label="Resize the ' + escapeHtml(col.label) + ' column" title="Drag to resize; double-click to reset"></span></th>';
      }).join('');
      const filters = cols.map((col) => '<th class="users-filter-cell">' + filterControl(col) + '</th>').join('');
      const colgroup = '<colgroup>' + cols.map((col) => '<col data-col="' + col.key + '" style="width:' + widthOf(col) + 'px" />').join('') + '</colgroup>';
      const total = cols.reduce((sum, col) => sum + widthOf(col), 0);
      wrap.innerHTML = '<table class="users-table" style="width:' + total + 'px">' + colgroup + '<thead><tr>' + head + '</tr><tr class="users-filter-row">' + filters + '</tr></thead><tbody id="usersTbody"></tbody></table>'
        + '<p class="empty" id="usersEmpty" hidden>No users match these filters.</p>';
      renderBody();
    }

    // Sets one column's width on the drawn table (no redraw, so a drag stays smooth and a filter keeps focus).
    function applyWidth(key) {
      const col = colByKey().get(key);
      const el = wrap.querySelector('col[data-col="' + key + '"]');
      const table = wrap.querySelector('.users-table');
      if (!col || !el || !table) return;
      el.style.width = widthOf(col) + 'px';
      table.style.width = visibleColumns().reduce((sum, c) => sum + widthOf(c), 0) + 'px';
    }
    function setWidth(key, px, { save = false } = {}) {
      if (px == null) delete prefs.widths[key]; else prefs.widths[key] = clampWidth(px);
      applyWidth(key);
      if (save) persist();
    }

    function renderBody() {
      const cols = visibleColumns();
      const tbody = document.getElementById('usersTbody');
      if (!tbody) return;
      const rows = shownUsers();
      tbody.innerHTML = rows.map((u) => '<tr data-user-id="' + escapeHtml(u.userId) + '">' + cols.map((col, i) => {
        const text = displayText(col, u[col.key]);
        const title = titleText(col, u[col.key]) || (text === '—' ? '' : text); // #4073: a cut value is shown in full here
        const cls = (col.kind === 'number' || col.kind === 'money' ? ' class="users-num"' : '') ;
        if (i === 0) {
          return '<td class="users-first"><span class="users-open" role="button" tabindex="0" title="' + escapeHtml(text) + ' (open this account below)">' + escapeHtml(text) + '</span></td>';
        }
        return '<td' + cls + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + escapeHtml(text) + '</td>';
      }).join('') + '</tr>').join('');
      const empty = document.getElementById('usersEmpty');
      if (empty) empty.hidden = rows.length > 0;
      const anyFilter = columns.some((c) => filterIsActive(c, prefs.filters[c.key])) || (prefs.search || '').trim();
      countLine.textContent = 'Showing ' + rows.length + ' of ' + users.length + ' user' + (users.length === 1 ? '' : 's') + (anyFilter ? ' (filtered)' : '') + '.';
      clearBtn.hidden = !anyFilter;
    }

    function renderChooser() {
      const byGroup = new Map();
      for (const col of columns) {
        if (!byGroup.has(col.group)) byGroup.set(col.group, []);
        byGroup.get(col.group).push(col);
      }
      const shown = new Set(visibleColumns().map((c) => c.key));
      const groups = [...byGroup.entries()].map(([group, cols]) => '<fieldset><legend>' + escapeHtml(group) + '</legend>'
        + '<div class="users-bulk"><button type="button" class="secondary" data-bulk="group-all" data-group="' + escapeHtml(group) + '">Select all</button>'
        + '<button type="button" class="secondary" data-bulk="group-none" data-group="' + escapeHtml(group) + '">Deselect all</button></div>'
        + cols.map((c) => '<label class="users-check"><input type="checkbox" data-col="' + c.key + '"' + (shown.has(c.key) ? ' checked' : '')
          + (c.key === 'username' ? ' disabled' : '') + ' /> ' + escapeHtml(c.label) + '</label>').join('') + '</fieldset>').join('');
      const order = visibleColumns().map((c, i, all) => '<li>' + escapeHtml(c.label)
        + (c.key === 'username' ? '' : ' <button type="button" class="secondary users-move" data-move="up" data-col="' + c.key + '"' + (i <= 1 ? ' disabled' : '') + ' aria-label="Move ' + escapeHtml(c.label) + ' left">←</button>'
          + '<button type="button" class="secondary users-move" data-move="down" data-col="' + c.key + '"' + (i === all.length - 1 ? ' disabled' : '') + ' aria-label="Move ' + escapeHtml(c.label) + ' right">→</button>')
        + '</li>').join('');
      const bulk = '<div class="users-bulk users-bulk-all"><button type="button" class="secondary" data-bulk="all">Select all</button>'
        + '<button type="button" class="secondary" data-bulk="none">Deselect all</button></div>';
      chooser.innerHTML = bulk + '<div class="users-chooser-groups">' + groups + '</div><h3>Order, left to right</h3><ol class="users-order">' + order + '</ol>';
    }

    function setVisible(keys) {
      prefs.visible = keys;
      persist();
      renderTable();
      if (!chooser.hidden) renderChooser();
    }

    chooser.addEventListener('change', (e) => {
      const key = e.target && e.target.dataset && e.target.dataset.col;
      if (!key || e.target.type !== 'checkbox') return;
      const keys = visibleColumns().map((c) => c.key);
      if (e.target.checked) { if (!keys.includes(key)) keys.push(key); } else { keys.splice(keys.indexOf(key), 1); }
      setVisible(keys);
    });
    chooser.addEventListener('click', (e) => {
      const bulkBtn = e.target.closest && e.target.closest('[data-bulk]');
      if (bulkBtn) {
        // #4073: Select all / Deselect all, for everything or for one group. Username is always shown, and
        // the columns already on keep their order; newly selected ones join at the end in the table's own order.
        const mode = bulkBtn.dataset.bulk;
        const inScope = (col) => mode === 'all' || mode === 'none' || col.group === bulkBtn.dataset.group;
        const keep = visibleColumns().map((c) => c.key).filter((k) => k === 'username' || !(mode.endsWith('none') && inScope(colByKey().get(k))));
        if (mode.endsWith('all')) {
          for (const col of columns) if (inScope(col) && !keep.includes(col.key)) keep.push(col.key);
        }
        setVisible(keep);
        return;
      }
      const btn = e.target.closest && e.target.closest('.users-move');
      if (!btn) return;
      const keys = visibleColumns().map((c) => c.key);
      const i = keys.indexOf(btn.dataset.col);
      const j = btn.dataset.move === 'up' ? i - 1 : i + 1;
      if (i < 1 || j < 1 || j >= keys.length) return;
      [keys[i], keys[j]] = [keys[j], keys[i]];
      setVisible(keys);
    });
    columnsBtn.addEventListener('click', () => {
      chooser.hidden = !chooser.hidden;
      columnsBtn.setAttribute('aria-expanded', String(!chooser.hidden));
      if (!chooser.hidden) renderChooser();
    });

    wrap.addEventListener('click', (e) => {
      const sortBtn = e.target.closest && e.target.closest('.users-sort');
      if (sortBtn) {
        const key = sortBtn.dataset.sort;
        prefs.sort = prefs.sort && prefs.sort.key === key && prefs.sort.dir === 'asc' ? { key, dir: 'desc' } : { key, dir: prefs.sort && prefs.sort.key === key ? 'asc' : (colByKey().get(key).kind === 'text' ? 'asc' : 'desc') };
        persist();
        renderTable();
        return;
      }
      const open = e.target.closest && e.target.closest('.users-open');
      // A drag to select text is not a tap on the name: leave it alone.
      if (open && !String(window.getSelection && window.getSelection()).length) {
        const row = open.closest('tr');
        if (window.__adminLoadUserDetail) window.__adminLoadUserDetail(row.dataset.userId);
        const detail = document.getElementById('userDetailWrap');
        if (detail && detail.scrollIntoView) detail.scrollIntoView({ block: 'nearest' });
      }
    });
    wrap.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('users-open')) {
        e.preventDefault();
        e.target.click();
      }
    });
    function onFilterInput(e) {
      const el = e.target;
      const key = el.dataset && el.dataset.filter;
      if (!key) return;
      const col = colByKey().get(key);
      const f = { ...(prefs.filters[key] || {}) };
      if (col.kind === 'text') f.q = el.value;
      else if (col.kind === 'bool' || col.kind === 'choice') f.v = el.value;
      else f[el.dataset.part] = el.value;
      if (filterIsActive(col, f)) prefs.filters[key] = f; else delete prefs.filters[key];
      persist();
      renderBody();
    }
    wrap.addEventListener('input', onFilterInput);
    wrap.addEventListener('change', onFilterInput);

    // #4073: drag the right edge of a heading to change that column's width, by mouse or touch. The handle
    // sits beside the sort button (not on it), so a drag never sorts. Double-click or double-tap resets the
    // column; with the keyboard, the arrow keys nudge it and Home or Delete resets it.
    let drag = null;
    let lastTap = { key: null, at: 0 };
    wrap.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest && e.target.closest('.users-resize');
      if (!handle) return;
      e.preventDefault();
      const col = colByKey().get(handle.dataset.resize);
      if (!col) return;
      drag = { key: col.key, startX: e.clientX, startWidth: widthOf(col), moved: false, pointerType: e.pointerType };
      try { handle.setPointerCapture(e.pointerId); } catch (_) { /* a synthetic pointer cannot be captured */ }
      handle.classList.add('dragging');
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (drag.moved) setWidth(drag.key, drag.startWidth + dx);
    });
    function endDrag(e) {
      if (!drag) return;
      const done = drag;
      drag = null;
      const handle = e.target.closest && e.target.closest('.users-resize');
      if (handle) handle.classList.remove('dragging');
      if (done.moved) { persist(); lastTap = { key: null, at: 0 }; return; }
      // A tap that did not move: two within 400 ms on the same edge (a double-tap) put the width back.
      if (done.pointerType !== 'mouse') {
        const now = Date.now();
        if (lastTap.key === done.key && now - lastTap.at < 400) { setWidth(done.key, null, { save: true }); lastTap = { key: null, at: 0 }; }
        else lastTap = { key: done.key, at: now };
      }
    }
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);
    wrap.addEventListener('dblclick', (e) => {
      const handle = e.target.closest && e.target.closest('.users-resize');
      if (handle) setWidth(handle.dataset.resize, null, { save: true });
    });
    wrap.addEventListener('keydown', (e) => {
      const handle = e.target.closest && e.target.closest('.users-resize');
      if (!handle) return;
      const col = colByKey().get(handle.dataset.resize);
      if (!col) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setWidth(col.key, widthOf(col) + (e.key === 'ArrowRight' ? 16 : -16), { save: true });
      } else if (e.key === 'Home' || e.key === 'Delete') {
        e.preventDefault();
        setWidth(col.key, null, { save: true });
      }
    });

    searchInput.addEventListener('input', () => { prefs.search = searchInput.value; persist(); renderBody(); });
    clearBtn.addEventListener('click', () => {
      prefs.filters = {};
      prefs.search = '';
      searchInput.value = '';
      persist();
      renderTable();
    });
    resetBtn.addEventListener('click', () => {
      prefs = { visible: null, sort: { key: 'createdAt', dir: 'desc' }, filters: {}, search: '', widths: {} };
      searchInput.value = '';
      persist();
      renderTable();
      if (!chooser.hidden) renderChooser();
    });

    async function load() {
      errLine.hidden = true;
      countLine.textContent = 'Loading…';
      capLine.hidden = true;
      wrap.innerHTML = '<p class="empty">Loading users…</p>';
      try {
        const body = await fetchJson('/api/auth/admin-users');
        columns = body.columns || [];
        users = body.users || [];
        total = body.total || users.length;
        if (body.truncated) {
          capLine.textContent = 'Showing the first ' + users.length + ' of ' + total + ' users (the most recent). The table needs paging now; file that before it matters.';
          capLine.hidden = false;
        }
        renderTable();
      } catch (error) {
        countLine.textContent = '';
        wrap.innerHTML = '<p class="err">Could not load the users: ' + escapeHtml(error.message) + ' <button type="button" class="secondary" id="usersRetryBtn">Try again</button></p>';
        const retry = document.getElementById('usersRetryBtn');
        if (retry) retry.addEventListener('click', load);
      }
    }
    refreshBtn.addEventListener('click', load);
    load();
  };
})();
