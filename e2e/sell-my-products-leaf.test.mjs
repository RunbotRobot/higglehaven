// #3701 (Sell in the bud, 3/6 of #3655; part of #3648; the owner's audit findings #3588 and #3586):
// My products is a leaf of the bud, not a dimmed full-screen dialog. At 390x844 with the list opened
// from its petal: it grows from just under the bud at the top-left (no dimming scrim, so the showroom
// shows around it), keeps the compass uncovered, has its close control in the upper-right corner, and
// has ONE row of controls above the first product (Upload Model and Sell This Too; the Manage / List
// view switch sits in the leaf's header beside the title, clear of the close control). Opening the bud while the list is open folds the list, so the petals never
// unfold over it (higglehaven1's look at the live site), and the bud's petal column carries no bare
// "Lándlet cap" line in Sell (it belongs to building).
import { launchPage, chooseIdentity, openMyProducts, finish } from './helpers.mjs';

const LABEL = 'Sell Leaf Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true, openProducts: false });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });
await page.waitForFunction(() => window.__sellWorldViewActive?.() === true, null, { timeout: 30000 });
await openMyProducts(page);
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(600);

if (process.env.SELL_LEAF_SHOTS) await page.screenshot({ path: `${process.env.SELL_LEAF_SHOTS}/leaf-open.png` });

const box = async (selector) => page.locator(selector).boundingBox();
const leaf = await box('#seller-modal-content');
const close = await box('#seller-close-btn');
const upload = await box('#upload-model-btn');
const sellThisToo = await box('#sell-this-too-btn');
const toggle = await box('#seller-view-toggle');
const bud = await box('#account-menu-toggle');
const scrim = await page.evaluate(() => getComputedStyle(document.getElementById('seller-modal')).backgroundColor);
const radius = await page.evaluate(() => getComputedStyle(document.getElementById('seller-modal-content')).borderTopLeftRadius);
const filtersShown = await page.locator('#seller-filter-controls').isVisible();
console.log('leaf box:', JSON.stringify(leaf), 'close:', JSON.stringify(close), 'bud:', JSON.stringify(bud));
console.log('controls:', JSON.stringify({ upload, sellThisToo, toggle }), 'scrim:', scrim, 'radius:', radius);

const oneRow = Math.abs(upload.y - sellThisToo.y) <= 12;
// The view switch is in the header: above the controls row, inside the leaf, not under the close control.
const switchInHeader = toggle.y + toggle.height <= upload.y && toggle.x >= leaf.x && toggle.x + toggle.width <= close.x;
const aboveFirstProduct = Math.max(upload.y + upload.height, sellThisToo.y + sellThisToo.height);
const listTop = (await box('#seller-list')).y;
const leafShape = leaf.x >= 0 && leaf.x + leaf.width <= 332 && leaf.y >= bud.y + bud.height - 4;
const closeUpperRight = close.x + close.width >= leaf.x + leaf.width - 24 && close.y <= leaf.y + 24;
const noScrim = scrim === 'rgba(0, 0, 0, 0)' || scrim === 'transparent';
console.log('one row:', oneRow, 'switch in header:', switchInHeader, 'controls end at', aboveFirstProduct, 'list starts at', listTop, 'leaf shape:', leafShape, 'close upper-right:', closeUpperRight);

// The bud opening folds the leaf; the petals are then on a clear screen.
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
await page.waitForTimeout(400);
const afterBud = {
  leafStillShown: await page.locator('#seller-modal.visible').count(),
  petals: await page.locator('#bud-petal-sell-my-products').isVisible(),
  landCapShown: await page.locator('#account-menu-landcap').isVisible(),
};
console.log('bud opened over the open list:', JSON.stringify(afterBud));
if (process.env.SELL_LEAF_SHOTS) await page.screenshot({ path: `${process.env.SELL_LEAF_SHOTS}/bud-open.png` });

// The list comes back from its petal and closes with its own close control.
await page.click('#bud-petal-sell-my-products');
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.click('#seller-close-btn');
await page.waitForSelector('#seller-modal:not(.visible)', { state: 'attached', timeout: 5000 });

const pass = oneRow && switchInHeader && listTop >= aboveFirstProduct - 1 && !filtersShown
  && leafShape && closeUpperRight && noScrim
  && afterBud.leafStillShown === 0 && afterBud.petals && !afterBud.landCapShown
  && errors.length === 0;
await finish(browser, { pass, label: 'My products is a leaf with one row of controls (#3701)', errors });
