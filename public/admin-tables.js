// #4134: one shared piece for every table in the admin dashboard. Tap a row and it stays marked while the table is
// scrolled sideways or down (a reading aid only: it selects nothing and runs nothing); tap it again, or another row,
// to move the mark. A tap on a button or link in the row still does that control's job and also marks the row. The
// header rows stay in view and the first column stays in place by CSS (admin-dashboard.css); this script only owns
// the mark. A table that redraws (a sort, a filter, a refresh) keeps the mark on the same row, found again by its
// first two cells. Classic script: the site's CSP allows scripts from this origin only.
(function () {
  'use strict';
  var MARK = 'row-marked';
  var marked = new Map(); // table key -> row key

  function tableKey(table) {
    if (table.id) return '#' + table.id;
    var panel = table.closest('.panel');
    var all = Array.prototype.slice.call((panel || document).querySelectorAll('table'));
    return (panel && panel.id ? panel.id : 'page') + ':' + all.indexOf(table);
  }
  function rowKey(row) {
    var cells = row.cells;
    return (cells[0] ? cells[0].textContent.trim() : '') + '\u0001' + (cells[1] ? cells[1].textContent.trim() : '');
  }
  function clear(table) {
    Array.prototype.forEach.call(table.querySelectorAll('tbody tr.' + MARK), function (row) {
      row.classList.remove(MARK);
      row.removeAttribute('aria-selected');
    });
  }
  function setMark(table, row) {
    clear(table);
    row.classList.add(MARK);
    row.setAttribute('aria-selected', 'true');
    marked.set(tableKey(table), rowKey(row));
  }

  document.addEventListener('click', function (event) {
    var cell = event.target.closest && event.target.closest('main tbody td');
    if (!cell) return;
    var row = cell.parentElement;
    var table = row.closest('table');
    if (!table) return;
    // Someone selecting text to copy it is not asking for a mark.
    var selection = window.getSelection && window.getSelection();
    if (selection && !selection.isCollapsed && String(selection).trim() !== '') return;
    if (row.classList.contains(MARK)) {
      clear(table);
      marked.delete(tableKey(table));
    } else {
      setMark(table, row);
    }
  });

  // A second header row (the Users table's filter row) sticks just under the first, so it needs the first one's
  // height, which changes with the width of the screen and of the columns.
  function fixHeads() {
    Array.prototype.forEach.call(document.querySelectorAll('main thead'), function (thead) {
      if (thead.rows.length < 2) return;
      var table = thead.closest('table');
      table.style.setProperty('--users-head-h', thead.rows[0].getBoundingClientRect().height + 'px');
    });
  }
  window.addEventListener('resize', fixHeads);

  // After a table is redrawn, put the mark back on the same row if it is still there.
  var pending = false;
  function reapply() {
    pending = false;
    fixHeads();
    marked.forEach(function (key, tKey) {
      var table = Array.prototype.slice.call(document.querySelectorAll('main table')).filter(function (t) { return tableKey(t) === tKey; })[0];
      if (!table || table.querySelector('tbody tr.' + MARK)) return;
      var rows = table.querySelectorAll('tbody tr');
      for (var i = 0; i < rows.length; i++) {
        if (rowKey(rows[i]) === key) {
          rows[i].classList.add(MARK);
          rows[i].setAttribute('aria-selected', 'true');
          return;
        }
      }
    });
  }
  fixHeads();
  var main = document.querySelector('main');
  if (main && window.MutationObserver) {
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(reapply);
    }).observe(main, { childList: true, subtree: true });
  }
})();
