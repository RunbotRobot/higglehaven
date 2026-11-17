// Build in the bud (#3654, part of #3648): the plan page's five moments over one view of the world.
// A mock-up: nothing here talks to the server. Classic script (the site's CSP allows this origin only).
(function () {
  'use strict';

  var stage = document.getElementById('stage');
  var fit = document.getElementById('stage-fit');
  var bud = document.getElementById('bud');
  var coverEl = document.getElementById('cover');
  var captionEl = document.getElementById('caption');
  var markEl = document.getElementById('mark');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.moment-btn'));
  var STAGE_W = 390;
  var STAGE_H = 844;
  var scale = 1;

  var MOMENTS = {
    enter: { open: true, mark: 'Building', today: 'about 9% with nothing selected', caption: 'Entering Build: the same bud, now wearing a small Building mark. Its five petals are the Build tools that stay.' },
    place: { open: false, mark: 'Building', today: 'about 40% with the catalog open', caption: 'Add item opens a short strip of recent items and a search line, not a panel. Drag the ghost where it should go; lifting drops it out of fog.' },
    select: { open: false, mark: 'Building', today: 'about 25% with one item selected', caption: 'Tap an item: yellow handles appear on it (corners resize, the ring rotates, the body moves), and its card blooms beside it.' },
    many: { open: false, mark: 'Selecting', today: 'about 12% with Multi-Select on', caption: 'Selecting is on (Tools petal): hold and paint, then one card for all of it, with Bundle among its actions.' },
    levels: { open: false, mark: 'Building', today: 'about 16% with the level menu open', caption: 'Levels says which floor you are on, and builds or digs one more. It replaces the Ground pill and the level menu.' }
  };

  function fitStage() {
    scale = Math.min(1, document.documentElement.clientWidth / STAGE_W);
    fit.style.setProperty('--s', String(scale));
    document.documentElement.style.setProperty('--s', String(scale));
  }

  // The same idea as `scripts/live-site.mjs --cover-report`, on this page's own elements (marked data-ui).
  function coverShare() {
    var cell = 6;
    var cols = Math.ceil(STAGE_W / cell);
    var rows = Math.ceil(STAGE_H / cell);
    var grid = new Uint8Array(cols * rows);
    var box = stage.getBoundingClientRect();
    Array.prototype.forEach.call(stage.querySelectorAll('[data-ui]'), function (el) {
      var cs = getComputedStyle(el);
      var li = el.closest('li');
      var opacity = parseFloat(cs.opacity) * (li ? parseFloat(getComputedStyle(li).opacity) : 1);
      var hiddenAncestor = false;
      for (var n = el; n && n !== stage; n = n.parentElement) {
        if (getComputedStyle(n).display === 'none') hiddenAncestor = true;
      }
      if (hiddenAncestor || cs.visibility === 'hidden' || opacity < 0.05) return;
      var r = el.getBoundingClientRect();
      var x0 = Math.max(0, Math.floor((r.left - box.left) / scale / cell));
      var x1 = Math.min(cols - 1, Math.floor((r.right - box.left) / scale / cell));
      var y0 = Math.max(0, Math.floor((r.top - box.top) / scale / cell));
      var y1 = Math.min(rows - 1, Math.floor((r.bottom - box.top) / scale / cell));
      for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) grid[y * cols + x] = 1;
    });
    var covered = 0;
    for (var i = 0; i < grid.length; i++) covered += grid[i];
    return (covered / grid.length) * 100;
  }

  function showCover(today) {
    window.setTimeout(function () {
      var share = coverShare();
      var text = share < 0.5 ? 'under 1%' : 'about ' + Math.round(share) + '%';
      coverEl.innerHTML = 'Covers <strong>' + text + '</strong> of the screen here. Today&rsquo;s Build: ' + today + '.';
    }, 650);
  }

  function setOpen(open) {
    stage.dataset.open = open ? 'true' : 'false';
    bud.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function setMoment(name) {
    var m = MOMENTS[name];
    stage.dataset.moment = name;
    buttons.forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.moment === name ? 'true' : 'false'); });
    markEl.textContent = m.mark;
    captionEl.textContent = m.caption;
    setOpen(m.open);
    showCover(m.today);
  }

  buttons.forEach(function (b) { b.addEventListener('click', function () { setMoment(b.dataset.moment); }); });
  bud.addEventListener('click', function () { setOpen(stage.dataset.open !== 'true'); showCover(MOMENTS[stage.dataset.moment].today); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && stage.dataset.open === 'true') { setOpen(false); bud.focus(); }
  });
  window.addEventListener('resize', fitStage);

  fitStage();
  setMoment('enter');
})();
