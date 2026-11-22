// #3752: a page opened by tapping a mode petal shows the bud's ring, the chosen petal lit, from the
// first paint. src/ui/bud.js writes the record just before the reload and reads it (and removes it)
// when the app starts; this tiny script only looks, so the ring is out while the app is still
// downloading. It runs before the bundle and touches nothing else.
(function () {
  try {
    var record = JSON.parse(sessionStorage.getItem('higglehaven.budSwitch') || 'null');
    if (!record || Date.now() - Number(record.at) > 60000) return;
    document.body.setAttribute('data-bud', 'on');
    document.body.setAttribute('data-bud-ring', 'held');
    var chosen = document.querySelector('.mode-nav-btn[data-mode="' + record.target + '"]');
    if (chosen) chosen.setAttribute('aria-current', 'true');
    // #3873: the world the person was in (src/ui/switchSnapshot.js drew it small at the tap) stays on screen,
    // under a pale fog veil, in place of the cold-open screen while the new mode loads. Used once.
    var raw = sessionStorage.getItem('higglehaven.switchSnapshot');
    if (raw) {
      sessionStorage.removeItem('higglehaven.switchSnapshot');
      var shot = JSON.parse(raw);
      var screen = document.getElementById('loading-screen');
      if (screen && shot && typeof shot.url === 'string' && shot.url.indexOf('data:image/') === 0 && Date.now() - Number(shot.at) <= 60000) {
        screen.style.backgroundImage = 'url("' + shot.url + '")';
        document.documentElement.classList.add('switch-snapshot');
      }
    }
  } catch (e) { /* the ring simply waits for the app */ }
})();
