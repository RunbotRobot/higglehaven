// People in the bud (#3653, part of #3648): the plan page's moments over one view of the world.
// A mock-up: nothing here talks to the server. Classic script (the site's CSP allows this origin only).
(function () {
  'use strict';

  var stage = document.getElementById('stage');
  var fit = document.getElementById('stage-fit');
  var bud = document.getElementById('bud');
  var coverEl = document.getElementById('cover');
  var captionEl = document.getElementById('caption');
  var wordEl = document.getElementById('word');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.moment-btn'));
  var STAGE_W = 390;
  var STAGE_H = 844;
  var scale = 1;

  var MOMENTS = {
    rest: { open: false, marked: false, word: '', today: 'about 1% for the Chat and microphone buttons, more with Chat open', caption: 'Resting: only the bud. Nothing is waiting, nothing is live.' },
    unread: { open: true, marked: true, word: '', today: 'about 1% for the buttons, plus a number badge on the gear', caption: 'Something is waiting: one yellow dot on the bud. Opening it shows which petals hold it (a friend request, a direct message). A dot, never a number, and no toast for each message.' },
    chat: { open: false, marked: false, word: '', today: 'about 35% with Chat open', caption: 'Chat opens as a leaf by the bud: Nearby, Messages, the box to type in, and who you can hear. Today’s separate voice list goes here.' },
    va: { open: true, marked: false, word: '', speaking: true, today: 'about 1% for the microphone button', caption: 'A. The microphone is a petal. While it is live the bud has a green ring, brighter while you speak. Nothing else stands on the world.' },
    vb: { open: false, marked: false, word: '', today: 'about 1% for the microphone button', caption: 'B. Hold the bud to talk, let go to mute. You cannot move and talk at once, and a slow tap can turn it on by mistake.' },
    vc: { open: false, marked: false, word: '', today: 'about 1% for the microphone button', caption: 'C. One small standing microphone beside the bud: one tap, and its colour says whether it is live.' }
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
      coverEl.innerHTML = 'Covers <strong>' + text + '</strong> of the screen here. Today: ' + today + '.';
    }, 650);
  }

  function setOpen(open) {
    stage.dataset.open = open ? 'true' : 'false';
    bud.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function setMoment(name) {
    var m = MOMENTS[name];
    stage.dataset.moment = name;
    stage.dataset.marked = m.marked ? 'true' : 'false';
    stage.dataset.speaking = m.speaking ? 'true' : 'false';
    buttons.forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.moment === name ? 'true' : 'false'); });
    wordEl.textContent = m.word;
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
  setMoment('rest');
})();
