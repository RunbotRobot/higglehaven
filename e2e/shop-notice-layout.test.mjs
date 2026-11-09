// #3335: the orb rate-limit notice used to lay its buttons beside the text in a
// flex row, so at phone width the sentence wrapped onto seven short lines.
// Every notice shares one .shop-notice layout: the text on top at full width,
// the dismiss action in a small row beneath it. (#3348: the Copy button is
// gone; the text is copied by selecting it.)
import { launchPage, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ viewport: { width: 390, height: 844 } });

const measure = await page.evaluate(() => {
  const notice = document.getElementById('shop-credit-orb-rate-limit-notice');
  notice.querySelector('.shop-notice-text').textContent =
    'You can collect up to 20 orbs every 15 minutes. Try again in about 15 minutes.';
  notice.classList.add('visible');
  const text = notice.querySelector('.shop-notice-text').getBoundingClientRect();
  const box = notice.getBoundingClientRect();
  const actions = notice.querySelector('.shop-notice-actions').getBoundingClientRect();
  const dismiss = notice.querySelector('.shop-notice-dismiss-btn').getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(notice.querySelector('.shop-notice-text')).lineHeight) || 18;
  const selection = document.getElementById('selection-action-status');
  return {
    textShare: text.width / box.width,
    lines: Math.round(text.height / lineHeight),
    actionsBelowText: actions.top >= text.bottom - 0.5,
    buttonsInsideNotice: dismiss.right <= box.right + 0.5 && dismiss.left >= box.left,
    noCopyButton: !notice.querySelector('.shop-notice-copy-btn'),
    withinViewport: box.left >= 0 && box.right <= innerWidth,
    selectionIsSharedNotice: selection.classList.contains('shop-notice'),
    selectionDirection: getComputedStyle(selection).flexDirection,
  };
});
console.log('measured:', measure);

const pass =
  measure.textShare >= 0.8 &&
  measure.lines <= 3 &&
  measure.actionsBelowText &&
  measure.buttonsInsideNotice &&
  measure.noCopyButton &&
  measure.withinViewport &&
  measure.selectionIsSharedNotice &&
  measure.selectionDirection === 'column' &&
  errors.length === 0;
await finish(browser, { pass, label: 'notices put their dismiss action under the text at phone width, with no Copy button (#3335, #3348)', errors });
