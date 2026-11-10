// #3335 / #3377: every dismissible notice shares one layout (.shop-notice):
// the text takes the width and the dismiss x sits in the upper-right corner,
// on the first line, as a close control normally does. It used to sit in a
// row beneath the text (#3335 put Copy and x there; #3348 removed Copy and
// left the x alone on its own line).
import { launchPage, finish } from './helpers.mjs';

async function measureNotice(page, selector, longText) {
  return page.evaluate(([sel, long]) => {
    const notice = document.querySelector(sel);
    // The Build status lives in a toolbar that is not shown in this mode, so
    // measure it where it can be laid out.
    if (!notice.offsetParent && getComputedStyle(notice).position !== 'fixed') document.body.appendChild(notice);
    notice.hidden = false;
    notice.classList.add('visible');
    const padX = (el) => parseFloat(getComputedStyle(el).paddingLeft) + parseFloat(getComputedStyle(el).paddingRight);
    const textEl = notice.querySelector('.shop-notice-text');
    const dismiss = notice.querySelector('.shop-notice-dismiss-btn');
    const rects = () => ({
      box: notice.getBoundingClientRect(),
      text: textEl.getBoundingClientRect(),
      btn: dismiss.getBoundingClientRect(),
    });
    textEl.textContent = long;
    const longRects = rects();
    textEl.textContent = 'Short.';
    const short = rects();
    const cs = getComputedStyle(notice);
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const lineHeight = parseFloat(getComputedStyle(textEl).lineHeight) || 18;
    return {
      insideNotice: longRects.btn.left >= longRects.box.left && longRects.btn.right <= longRects.box.right + 0.5
        && longRects.btn.top >= longRects.box.top - 0.5 && longRects.btn.bottom <= longRects.box.bottom + 0.5,
      topGap: longRects.btn.top - longRects.box.top,
      rightGap: longRects.box.right - longRects.btn.right,
      noOverlap: longRects.text.right <= longRects.btn.left + 0.5,
      tapTarget: Math.min(longRects.btn.width, longRects.btn.height),
      // The text takes all the width except the room the x needs (24px margin).
      textLoss: Math.abs(longRects.box.width - padX(notice) - 24 - longRects.text.width),
      lines: Math.round(longRects.text.height / (parseFloat(getComputedStyle(textEl).lineHeight) || 18)),
      oneLineHeight: short.box.height,
      oneLineMax: short.text.height + pad + 1,
      oneLineText: short.text.height <= lineHeight * 1.5,
      selectable: getComputedStyle(notice).userSelect === 'text' || getComputedStyle(textEl).userSelect === 'text',
    };
  }, [selector, longText]);
}

function check(label, m) {
  console.log(label, m);
  return m.insideNotice && m.topGap >= 0 && m.topGap <= 6 && m.rightGap >= 0 && m.rightGap <= 6
    && m.noOverlap && m.tapTarget >= 32 && m.textLoss <= 1.5 && m.lines <= 3 && m.oneLineText
    && m.oneLineHeight <= m.oneLineMax;
}

let pass = true;
for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  const { browser, page, errors } = await launchPage({ viewport });
  const orb = await measureNotice(page, '#shop-credit-orb-rate-limit-notice',
    'You can collect up to 20 orbs every 15 minutes. Try again in about 15 minutes.');
  const build = await measureNotice(page, '#selection-action-status',
    'Those items cannot be bundled because one of them is outside this lándlet.');
  const ok = check(`orb notice @${viewport.width}:`, orb) && check(`build status @${viewport.width}:`, build)
    && orb.selectable && errors.length === 0;
  pass = pass && ok;
  await browser.close();
}
const { browser, errors } = await launchPage();
await finish(browser, { pass, label: 'dismissible notices put their x in the upper-right corner without growing (#3377)', errors });
