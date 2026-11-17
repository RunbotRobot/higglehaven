// #3700 (Sell in the bud, 2/6 of #3655; part of #3648; the owner's audit finding #3587): entering Sell
// lands on the showroom with nothing over it. My products used to open over the showroom by itself;
// it is now the My products petal of the bud, two taps away, and the showroom is walkable first.
// At 390x844: right after entry the My products sheet is not shown, the bud is, and
// the world view is live; two taps (the bud, then the petal) open the list with the seller's own
// products in it; closing it returns to the unobstructed showroom.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Sell Showroom Entry';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
// openProducts: false -- the shared helper would otherwise open the list for the tests that drive it.
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true, openProducts: false });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });
await page.waitForFunction(() => window.__sellWorldViewActive?.() === true, null, { timeout: 30000 });
await page.waitForTimeout(800);

const onEntry = {
  sheetShown: await page.locator('#seller-modal.visible').count(),
  sheetPainted: await page.locator('#seller-modal').isVisible(),
  bud: await page.locator('#account-menu-toggle').isVisible(),
  mode: await page.evaluate(() => document.body.dataset.mode),
};
console.log('on entry:', JSON.stringify(onEntry));

// Nothing solid over the middle of the screen: the element at the screen's centre is the world's
// canvas, not a panel.
const centre = await page.evaluate(() => {
  const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  return el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}` : null;
});
console.log('element at the centre of the screen on entry (should be the canvas):', centre);

// Two taps to My products.
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
await page.click('#bud-petal-sell-my-products');
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
const upload = await page.locator('#upload-model-btn').isVisible();
const status = (await page.textContent('#seller-status')) || '';
console.log('after two taps: upload button visible, status:', upload, JSON.stringify(status));

// Closing it returns to the unobstructed showroom.
await page.click('#seller-close-btn');
await page.waitForSelector('#seller-modal:not(.visible)', { state: 'attached', timeout: 5000 });
const afterClose = {
  sheetShown: await page.locator('#seller-modal.visible').count(),
  bud: await page.locator('#account-menu-toggle').isVisible(),
};
console.log('after closing:', JSON.stringify(afterClose));

const pass = onEntry.mode === 'sell' && onEntry.sheetShown === 0 && !onEntry.sheetPainted
  && onEntry.bud && String(centre).startsWith('canvas')
  && upload && afterClose.sheetShown === 0 && afterClose.bud
  && errors.length === 0;
await finish(browser, { pass, label: 'Sell opens on the showroom, My products two taps away (#3700)', errors });
