// Tap a colour pair to try it on every style (#3780). Plain script, no network.
(function () {
  const root = document.body;
  const buttons = Array.from(document.querySelectorAll('.pair-btn'));
  function apply(button) {
    root.style.setProperty('--wm-ink', button.dataset.ink);
    root.style.setProperty('--wm-accent', button.dataset.accent);
    root.dataset.pair = button.dataset.pair;
    for (const other of buttons) other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
  }
  for (const button of buttons) button.addEventListener('click', () => apply(button));
  apply(buttons[0]);
})();
