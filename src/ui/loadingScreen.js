// #1590: fades out the cold-start/mode-switch splash (#loading-screen, visible
// by default in index.html's own markup). main.js calls it once bootstrap() has
// settled, whichever mode it resolved into, including the declined-login dead
// ends: those are "nothing left to load" too, not stuck-mid-load.
//
// #3562: Build with no landlet stops at the claim sheet until the person has
// claimed one, so bootstrap() does not settle until then and the splash stayed
// solid behind the sheet, hiding the world the sheet tells them to fly around.
// The claim flow calls this as it opens the sheet: nothing is left to load that
// the sheet is waiting on. Idempotent.
export function hideLoadingScreen(doc = typeof document === 'undefined' ? null : document) {
  const el = doc && doc.getElementById('loading-screen');
  if (!el || el.classList.contains('loading-screen-hidden')) return;
  el.classList.add('loading-screen-hidden');
  el.addEventListener('transitionend', () => { el.style.display = 'none'; }, { once: true });
}
