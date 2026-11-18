import { markStartup } from './startupMarks.js';

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
//
// #3738: a splash that is showing a failed stage stays up (the person has a
// sentence to read and Try again to tap), and the bar is filled and the tips
// stopped as the splash thins into the world.
import { completeLoadingBar, loadingFailed, stopLoadingTips } from './loadingStages.js';

export function hideLoadingScreen(doc = typeof document === 'undefined' ? null : document) {
  const el = doc && doc.getElementById('loading-screen');
  if (!el || el.classList.contains('loading-screen-hidden') || loadingFailed()) return;
  markStartup('loading-screen-hidden');
  completeLoadingBar(doc);
  // #3738: the first-open class (index.html) hides the old top controls until now.
  doc.documentElement?.classList?.remove('first-open');
  stopLoadingTips();
  el.classList.add('loading-screen-hidden');
  // #3752: the mode is on screen; the bud's petals, held open while it loaded, fold back in.
  doc.dispatchEvent?.(new Event('higglehaven:mode-ready'));
  // The fog's own fade ends last; a child's transition ending first must not
  // take the splash out early.
  const onEnd = (event) => {
    if (event && event.target !== el) return;
    el.removeEventListener('transitionend', onEnd);
    el.style.display = 'none';
  };
  el.addEventListener('transitionend', onEnd);
}
