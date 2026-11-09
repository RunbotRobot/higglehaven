// #3335: the orb rate-limit notice used to lay its Copy and x buttons beside
// the text in a flex row, so at phone width the sentence wrapped onto seven
// short lines. Every copyable notice now shares one .shop-notice layout: the
// text on top at full width, the actions in a small row beneath it.
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
  const copy = notice.querySelector('.shop-notice-copy-btn').getBoundingClientRect();
  const dismiss = notice.querySelector('.shop-notice-dismiss-btn').getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(notice.querySelector('.shop-notice-text')).lineHeight) || 18;
  const selection = document.getElementById('selection-action-status');
  return {
    textShare: text.width / box.width,
    lines: Math.round(text.height / lineHeight),
    actionsBelowText: actions.top >= text.bottom - 0.5,
    buttonsInsideNotice: copy.right <= box.right + 0.5 && dismiss.right <= box.right + 0.5 && dismiss.left > copy.left,
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
  measure.withinViewport &&
  measure.selectionIsSharedNotice &&
  measure.selectionDirection === 'column' &&
  errors.length === 0;
await finish(browser, { pass, label: 'copyable notices put their actions under the text at phone width (#3335)', errors });
