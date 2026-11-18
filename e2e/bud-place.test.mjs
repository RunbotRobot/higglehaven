// #3770 (part of #3759): the lándlet a person is on is named at the top of the open menu, before any
// leaf, as a small wordmark with "by <builder>" under it, in the same spot in every mode that has a
// place. In Build it names the lándlet being built; in Sell (the showroom is not a real place) it
// names nothing. Selectable text, nothing happens on a tap, clear of the head and the ring of modes.
// 390x844.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, goToMode, finish } from './helpers.mjs';

const LABEL = 'Place Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(1000);

await openAccountMenu(page);
await page.waitForSelector('#account-menu-landlet-info:not([hidden])', { timeout: 10000 });
await page.waitForTimeout(600);
const build = await page.evaluate(() => {
  const el = document.getElementById('account-menu-landlet-info');
  const rect = (e) => e.getBoundingClientRect().toJSON();
  const box = rect(el);
  const others = [...document.querySelectorAll('#bud-modes .mode-nav-btn, #account-menu-toggle')].map(rect);
  const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  return {
    name: el.querySelector('.bud-place-name').textContent,
    by: el.querySelector('.bud-place-by').textContent,
    box,
    clear: others.every((o) => !overlap(box, o)),
    inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
    selectable: getComputedStyle(el).userSelect !== 'none',
    nameFont: getComputedStyle(el.querySelector('.bud-place-name')).fontSize,
    byFont: getComputedStyle(el.querySelector('.bud-place-by')).fontSize,
    aboveColumn: box.bottom <= document.querySelector('#account-menu-panel button:not([hidden])').getBoundingClientRect().top + 1,
  };
});
console.log('Build header:', JSON.stringify(build));
check(build.name.length > 0, 'Build names the lándlet being built');
check(build.by === `by ${LABEL}`, `and the builder under it (${build.by})`);
check(build.clear, 'it is clear of the bud and the ring of modes');
check(build.inside, 'it is inside the screen');
check(build.selectable, 'it is selectable text');
check(parseFloat(build.nameFont) > parseFloat(build.byFont), 'the name is the main thing and the builder is small');
check(build.aboveColumn, 'it comes before the first leaf');
if (process.env.STILLS_DIR) await page.screenshot({ path: `${process.env.STILLS_DIR}/place-build.png` });
// #3844: long names. A long one wraps at spaces (a word that fits is never cut), stays between the
// ring and the compass, never runs down over the first leaf, and scrolls inside itself with a fade.
const longName = 'Where the AI sessions that build higglehaven try things out and then some more words about it all';
const shortName = 'The AI sessions playground';
const readSign = (name) => page.evaluate(async (n) => {
  window.__testShowBudPlace({ name: n, builder: 'higglehaven0' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const el = document.getElementById('account-menu-landlet-info');
  const nameEl = el.querySelector('.bud-place-name');
  const box = el.getBoundingClientRect();
  const compass = document.getElementById('compass-panel').getBoundingClientRect();
  const firstLeaf = document.querySelector('#account-menu-panel button:not([hidden])').getBoundingClientRect();
  // Which words are broken across lines? Wrap the text in a range per word and count rows each word spans.
  const text = nameEl.firstChild;
  const words = n.split(' ');
  let at = 0;
  const brokenWords = [];
  for (const w of words) {
    const range = document.createRange();
    range.setStart(text, at);
    range.setEnd(text, at + w.length);
    if (new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size > 1) brokenWords.push(w);
    at += w.length + 1;
  }
  return {
    w: Math.round(box.width), h: Math.round(box.height), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom),
    compassLeft: Math.round(compass.left), firstLeafTop: Math.round(firstLeaf.top),
    clipped: el.hasAttribute('data-clipped'), brokenWords,
  };
}, name);
const shortSign = await readSign(shortName);
const longSign = await readSign(longName);
console.log('short sign:', JSON.stringify(shortSign));
console.log('long sign:', JSON.stringify(longSign));
check(shortSign.brokenWords.length === 0, `no word of a short name is cut (${shortSign.brokenWords})`);
check(shortSign.w > 110, `the sign has room (${shortSign.w}px wide, it was 91)`);
check(longSign.brokenWords.length === 0, `no word of a long name is cut (${longSign.brokenWords})`);
check(longSign.right <= longSign.compassLeft + 1, 'the sign stays left of the compass');
check(longSign.bottom <= longSign.firstLeafTop, `the sign stops above the first leaf (${longSign.bottom} vs ${longSign.firstLeafTop})`);
check(longSign.clipped, 'a name too long for the cap says so with its fade');
check(!shortSign.clipped, 'a short name is not faded');
// A tap on it does nothing surprising: the menu stays as it is.
await page.click('#account-menu-landlet-info', { timeout: 3000 }).catch(() => {});
check(await page.evaluate(() => document.getElementById('account-menu-panel').classList.contains('expanded')), 'a tap on the name leaves the menu open');
await page.click('#account-menu-toggle');
await page.waitForTimeout(300);

await goToMode(page, 'sell');
await page.waitForTimeout(1500);
await openAccountMenu(page);
await page.waitForTimeout(600);
const sellHidden = await page.evaluate(() => document.getElementById('account-menu-landlet-info').hidden);
check(sellHidden, 'in Sell, the showroom is not a place: nothing is named');
if (process.env.STILLS_DIR) await page.screenshot({ path: `${process.env.STILLS_DIR}/place-sell.png` });

await finish(browser, { pass, label: '#3770: the lándlet is named at the top of the open menu (Build), nothing in Sell', errors });
