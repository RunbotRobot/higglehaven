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
  } catch (e) { /* the ring simply waits for the app */ }
})();
