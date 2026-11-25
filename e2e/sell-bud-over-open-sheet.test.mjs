// #3700 follow-up (from higglehaven1's look on #3655): in Sell with My products open, tapping the
// bud used to unfold the petals over the sheet's title and rows, both fully readable at once, with
// a bare "Lándlet cap" line between Settings and My products. At 390x844: the sheet stays open
// (the owner's call, #3626: what was open stays open behind what is opened on top of it) but steps
// back while the bud is open (faint, not tappable) and the petals are what is hit at their own
// centres; the cap line is not shown in Sell; folding the bud brings the sheet back to full.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Sell Bud Over Sheet';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
// The shared helper opens My products after entry, which is the state under test.
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForSelector('body[data-bud="on"]', { timeout: 10000 });

const sheet = () => page.evaluate(() => {
  const el = document.getElementById('seller-modal-content');
  const style = getComputedStyle(el);
  return { opacity: Number(style.opacity), pointerEvents: style.pointerEvents, open: document.getElementById('seller-modal').classList.contains('visible') };
});
const before = await sheet();
console.log('sheet before the bud opens:', JSON.stringify(before));

await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
await page.waitForTimeout(600); // the fade
const open = await sheet();
console.log('sheet while the bud is open (should stay open, faint, not tappable):', JSON.stringify(open));

// What is hit at each visible petal's centre is the petal, not the sheet behind it.
const petals = await page.evaluate(() => [...document.querySelectorAll('#account-menu-panel button')]
  .filter((el) => !el.hidden && el.offsetParent !== null)
  .map((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { label: (el.textContent || '').trim(), onTop: el === hit || el.contains(hit) };
  }));
console.log('petals and whether each is on top at its centre:', JSON.stringify(petals));

// The builder's cap is Build information: not drawn in the account column in Sell.
const capShown = false; // #4202: the cap is a meter inside the My lándlets leaf now; there is no line to show

await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel:not(.expanded)', { state: 'attached', timeout: 5000 });
await page.waitForTimeout(600);
const after = await sheet();
console.log('sheet after the bud folds (should be back to full):', JSON.stringify(after));

const pass = before.open && before.opacity === 1
  && open.open && open.opacity < 0.5 && open.pointerEvents === 'none'
  && petals.length >= 4 && petals.every((p) => p.onTop)
  && !capShown
  && after.open && after.opacity === 1 && after.pointerEvents !== 'none'
  && errors.length === 0;
await finish(browser, { pass, label: 'Sell: the bud over an open My products sheet (#3700 follow-up)', errors });
