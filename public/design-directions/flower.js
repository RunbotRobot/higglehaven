// The flower (#3764, head chosen in #3754): a mock-up page, not the app. A phone screen drawn at
// its real size; tap the head and everything opens together (#4025): three petals, the stem of the place you
// are in and the row of icons beside the head. Another place's petal lights while the place "loads"; the flower
// stays out and shows that place's stem. Nothing here talks to the server. Classic script (the site's CSP allows scripts from this origin only).
(function () {
  'use strict';
  var stage = document.getElementById('stage');
  var fit = document.getElementById('stage-fit');
  var world = document.getElementById('world');
  var head = document.getElementById('head');
  var fogWord = document.getElementById('fog-word');
  var coverEl = document.getElementById('cover');
  var helpEl = document.getElementById('help');
  var petals = Array.prototype.slice.call(document.querySelectorAll('.petal'));
  var stems = {};
  Array.prototype.forEach.call(document.querySelectorAll('.stem'), function (s) { stems[s.dataset.stem] = s; });

  var PICTURES = { shop: 'c-walk.jpg', build: 'world-walk.jpg', sell: 'world-product.jpg' };
  var NAMES = { shop: 'Shop', build: 'Build', sell: 'Sell' };
  var STAGE_W = 390, STAGE_H = 844, PITCH = 40;
  var state = { mode: 'shop', open: 'closed', lit: null, loading: false };
  var scale = 1;
  var hideTimers = {};

  function fitStage() {
    scale = Math.min(1, document.documentElement.clientWidth / STAGE_W);
    document.documentElement.style.setProperty('--s', String(scale));
  }

  // The stem's curve leaves the head, bends right and runs down; its length follows its leaves.
  Object.keys(stems).forEach(function (name) {
    var n = stems[name].querySelectorAll('.leaf').length;
    var path = stems[name].querySelector('path');
    path.setAttribute('pathLength', '1');
    path.setAttribute('d', 'M44 66 C 44 104, 112 84, 112 126 L 112 ' + (126 + n * PITCH));
  });

  // #4012: folding runs in the reverse order of unfolding, and a stem that swaps for another waits for the
  // first to fold (about .5 s), so no leaf is ever drawn without the stem it grows from.
  var FOLD_MS = 520;
  function showStem(name, on, after) {
    var el = stems[name];
    if (!el) return;
    window.clearTimeout(hideTimers[name]);
    if (on) {
      el.hidden = false;
      hideTimers[name] = window.setTimeout(function () {
        window.requestAnimationFrame(function () { window.requestAnimationFrame(function () { el.classList.add('on'); }); });
      }, after ? FOLD_MS : 0);
    } else {
      el.classList.remove('on');
      hideTimers[name] = window.setTimeout(function () { el.hidden = true; }, FOLD_MS);
    }
  }

  function render() {
    stage.dataset.mode = state.mode;
    stage.dataset.open = state.open;
    stage.dataset.loading = state.loading ? 'true' : 'false';
    head.setAttribute('aria-expanded', state.open === 'closed' ? 'false' : 'true');
    world.src = PICTURES[state.mode];
    petals.forEach(function (p) {
      p.classList.toggle('here', p.dataset.petal === state.mode);
      p.classList.toggle('lit', p.dataset.petal === state.lit);
      // #4012: the petal of the place whose stem is open stays marked.
      p.classList.toggle('open', state.open !== 'closed' && p.dataset.petal === state.mode);
    });
    var shown = state.open === 'closed' ? null : state.mode;
    var wasShown = Object.keys(stems).filter(function (name) { return stems[name].classList.contains('on'); });
    var swapping = shown !== null && wasShown.length > 0 && wasShown.indexOf(shown) === -1;
    // A stem was open and the flower is closing: the petals wait for it to fold (data-fold, flower.css).
    stage.dataset.fold = shown === null && wasShown.length > 0 ? 'staged' : 'plain';
    Object.keys(stems).forEach(function (name) { showStem(name, name === shown, swapping); });
    helpEl.hidden = state.open !== 'help';
    Array.prototype.forEach.call(document.querySelectorAll('#modes .pick'), function (b) { b.setAttribute('aria-pressed', b.dataset.mode === state.mode ? 'true' : 'false'); });
    showCover();
  }

  // Share of the screen painted by interface, overlap counted once: the idea behind
  // `scripts/live-site.mjs --cover-report`, on this mock-up's own elements (marked data-ui).
  function coverShare() {
    var cell = 6, cols = Math.ceil(STAGE_W / cell), rows = Math.ceil(STAGE_H / cell);
    var grid = new Uint8Array(cols * rows);
    var box = stage.getBoundingClientRect();
    Array.prototype.forEach.call(stage.querySelectorAll('[data-ui]'), function (el) {
      if (el.closest('[hidden]')) return;
      var cs = getComputedStyle(el);
      var op = parseFloat(cs.opacity);
      var pet = el.closest('.petals'), stem = el.closest('.stem');
      if (cs.display === 'none' || cs.visibility === 'hidden' || op < 0.5) return;
      if (stem && !stem.classList.contains('on')) return;
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
  var coverTimer = null;
  function showCover() {
    window.clearTimeout(coverTimer);
    coverTimer = window.setTimeout(function () {
      var share = coverShare();
      coverEl.innerHTML = 'Covers <strong>' + (share < 0.5 ? 'under 1%' : 'about ' + Math.round(share) + '%') + '</strong> of the screen right now (boxes drawn around the shapes, so a little more than they truly hide). Today’s app with the bud open: about 15%.';
    }, 900);
  }

  function setOpen(open) { state.open = open; render(); }

  head.addEventListener('click', function () {
    if (state.loading) return;
    setOpen(state.open === 'closed' ? 'open' : 'closed');
  });

  petals.forEach(function (p) {
    p.addEventListener('click', function () {
      if (state.loading) return;
      var which = p.dataset.petal;
      if (which === state.mode) return; // the place you are in: its stem is already open, the petal only marks where you are
      // Another place: the petal lights, the screen "loads" with the flower held open, then it folds.
      state.lit = which;
      state.loading = true;
      fogWord.textContent = 'Opening ' + NAMES[which];
      render();
      window.setTimeout(function () {
        state.mode = which;
        state.lit = null;
        state.loading = false;
        state.open = 'open'; // the flower stays out and shows the new place's stem
        render();
      }, 1700);
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.top'), function (b) {
    b.addEventListener('click', function () {
      if (state.loading) return;
      if (b.dataset.help) { setOpen(state.open === 'help' ? 'open' : 'help'); return; }
      b.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 220 });
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.leaf'), function (leaf) {
    leaf.addEventListener('click', function () {
      leaf.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 220 });
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('#jumps .pick'), function (b) {
    b.addEventListener('click', function () {
      if (state.loading) return;
      var j = b.dataset.jump;
      setOpen(j === 'closed' ? 'closed' : j === 'open' ? 'open' : 'help');
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('#modes .pick'), function (b) {
    b.addEventListener('click', function () { if (state.loading) return; state.mode = b.dataset.mode; render(); });
  });
  window.addEventListener('resize', fitStage);
  fitStage();
  render();
})();
