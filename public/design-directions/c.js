// Direction C, "one bud" (#3602, part of #3540 and interface week #3539).
// A mock-up page, not the app: three moments over three real views of the world, a bud that opens
// into petals, a product card that blooms beside the product, and a settings leaf. Nothing here
// talks to the server. Classic script (the site's CSP allows scripts from this origin only).
(function () {
  'use strict';

  var stage = document.getElementById('stage');
  var fit = document.getElementById('stage-fit');
  var world = document.getElementById('world');
  var bud = document.getElementById('bud');
  var hotspot = document.getElementById('product-hotspot');
  var bloom = document.getElementById('product-bloom');
  var leaf = document.getElementById('settings-leaf');
  var coverEl = document.getElementById('cover');
  var momentButtons = Array.prototype.slice.call(document.querySelectorAll('.moment-btn'));

  var PICTURES = { walk: 'c-walk.jpg', product: 'c-product.jpg', settings: 'c-settings.jpg' };
  var STAGE_W = 390;
  var STAGE_H = 844;
  var scale = 1;
  var idleTimer = null;

  // The page is a phone screen drawn at its real size; on a narrower page, scale it to fit.
  function fitStage() {
    scale = Math.min(1, (document.documentElement.clientWidth - 0) / STAGE_W);
    fit.style.setProperty('--s', String(scale));
    document.documentElement.style.setProperty('--s', String(scale));
  }

  // Share of the screen painted by interface, overlap counted once: the same idea as
  // `scripts/live-site.mjs --cover-report`, on this mock-up's own elements (marked data-ui).
  function coverShare() {
    var cell = 6;
    var cols = Math.ceil(STAGE_W / cell);
    var rows = Math.ceil(STAGE_H / cell);
    var grid = new Uint8Array(cols * rows);
    var stageBox = stage.getBoundingClientRect();
    var els = stage.querySelectorAll('[data-ui]');
    Array.prototype.forEach.call(els, function (el) {
      if (el.hidden || el.closest('[hidden]')) return;
      var cs = getComputedStyle(el);
      var li = el.closest('li');
      var opacity = parseFloat(cs.opacity) * (li ? parseFloat(getComputedStyle(li).opacity) : 1);
      if (cs.display === 'none' || cs.visibility === 'hidden' || opacity < 0.05) return;
      var r = el.getBoundingClientRect();
      var x0 = Math.max(0, Math.floor((r.left - stageBox.left) / scale / cell));
      var x1 = Math.min(cols - 1, Math.floor((r.right - stageBox.left) / scale / cell));
      var y0 = Math.max(0, Math.floor((r.top - stageBox.top) / scale / cell));
      var y1 = Math.min(rows - 1, Math.floor((r.bottom - stageBox.top) / scale / cell));
      for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) grid[y * cols + x] = 1;
    });
    var covered = 0;
    for (var i = 0; i < grid.length; i++) covered += grid[i];
    return (covered / grid.length) * 100;
  }

  function showCover() {
    // Wait for the open/close transitions to settle before measuring.
    window.setTimeout(function () {
      var share = coverShare();
      var text = share < 0.5 ? 'under 1%' : 'about ' + Math.round(share) + '%';
      coverEl.innerHTML = 'Covers <strong>' + text + '</strong> of the screen right now. Today’s app: about 11% walking, 100% in Settings.';
    }, 650);
  }

  function setOpen(open) {
    stage.dataset.open = open ? 'true' : 'false';
    bud.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) stage.dataset.learned = 'true';
    wake();
    showCover();
  }

  function setMoment(name) {
    stage.dataset.moment = name;
    world.src = PICTURES[name];
    momentButtons.forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.moment === name ? 'true' : 'false'); });
    bloom.hidden = name !== 'product';
    leaf.hidden = name !== 'settings';
    setOpen(false);
    if (name === 'walk') restartHint();
  }

  // The hint fades away by itself ("there when needed, gone when not"); replay it when Walking is chosen.
  function restartHint() {
    var old = document.getElementById('hint');
    var fresh = old.cloneNode(true);
    old.parentNode.replaceChild(fresh, old);
  }

  // A bud left alone lets go of attention: it dims after a few seconds and wakes on any touch.
  function wake() {
    stage.dataset.idle = 'false';
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(function () { stage.dataset.idle = 'true'; }, 3500);
  }

  bud.addEventListener('click', function () {
    setOpen(stage.dataset.open !== 'true');
  });

  hotspot.addEventListener('click', function () {
    setMoment('product');
  });

  document.getElementById('petals').addEventListener('click', function (event) {
    var petal = event.target.closest('.petal');
    if (!petal) return;
    if (petal.dataset.go === 'settings') setMoment('settings');
    else setOpen(false);
  });

  momentButtons.forEach(function (b) {
    b.addEventListener('click', function () { setMoment(b.dataset.moment); });
  });

  // Tapping the world (anything that is not a tool) puts the bud away and lets a card thin away.
  stage.addEventListener('click', function (event) {
    if (event.target.closest('[data-ui], .hotspot')) return;
    if (stage.dataset.open === 'true') setOpen(false);
    if (stage.dataset.moment !== 'walk') setMoment('walk');
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && stage.dataset.open === 'true') {
      setOpen(false);
      bud.focus();
    }
  });

  stage.addEventListener('pointerdown', wake);

  // Small working toggles, so the settings leaf feels real.
  var ease = document.getElementById('ease-switch');
  ease.addEventListener('click', function () {
    ease.setAttribute('aria-checked', ease.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  });
  Array.prototype.forEach.call(document.querySelectorAll('.seg'), function (seg) {
    seg.addEventListener('click', function (event) {
      var btn = event.target.closest('.seg-btn');
      if (!btn) return;
      Array.prototype.forEach.call(seg.querySelectorAll('.seg-btn'), function (b) { b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
    });
  });

  document.getElementById('buy-btn').addEventListener('click', function () {
    // A mock-up: nothing is bought. The petal answers the touch, and that is all.
    var buy = document.getElementById('buy-btn');
    buy.textContent = 'Added (example)';
    window.setTimeout(function () { buy.textContent = 'Buy'; }, 1400);
  });

  window.addEventListener('resize', fitStage);
  fitStage();
  setMoment('walk');
  // Expose the measured share for the page's own test and for whoever reviews it.
  window.__coverShare = coverShare;
  window.__setMoment = setMoment;
})();
