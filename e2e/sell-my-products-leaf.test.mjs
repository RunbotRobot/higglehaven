// #3701 (Sell in the bud, 3/6 of #3655; part of #3648; the owner's audit findings #3588 and #3586):
// My products is a leaf of the bud, not a dimmed full-screen dialog. At 390x844 with the list opened
// from its petal: it grows from just under the bud at the top-left (no dimming scrim, so the showroom
// shows around it), runs to the same margin on the right as on the left (#3772: nothing stands in the upper right now), and has its close control in the upper-right corner
// with the Manage / List view switch in the header beside the title, clear of the close control.
// (Add a product and Sell this too are petals now, #3716; the bud over an open list is
// sell-bud-over-open-sheet.test.mjs.)
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
const toggle = await box('#seller-view-toggle');
const bud = await box('#account-menu-toggle');
const scrim = await page.evaluate(() => getComputedStyle(document.getElementById('seller-modal')).backgroundColor);
const radius = await page.evaluate(() => getComputedStyle(document.getElementById('seller-modal-content')).borderTopLeftRadius);
const filtersShown = await page.locator('#seller-filter-controls').isVisible();
console.log('leaf box:', JSON.stringify(leaf), 'close:', JSON.stringify(close), 'bud:', JSON.stringify(bud));
console.log('switch:', JSON.stringify(toggle), 'scrim:', scrim, 'radius:', radius);

// The view switch is in the header: inside the leaf, left of the close control.
const switchInHeader = toggle.x >= leaf.x && toggle.x + toggle.width <= close.x && toggle.y < leaf.y + 70;
const leafShape = leaf.x >= 0 && Math.abs((390 - (leaf.x + leaf.width)) - leaf.x) <= 2 && leaf.y >= bud.y + bud.height - 4;
const closeUpperRight = close.x + close.width >= leaf.x + leaf.width - 24 && close.y <= leaf.y + 24;
const noScrim = scrim === 'rgba(0, 0, 0, 0)' || scrim === 'transparent';
console.log('switch in header:', switchInHeader, 'leaf shape:', leafShape, 'close upper-right:', closeUpperRight);

await page.click('#seller-close-btn');
await page.waitForSelector('#seller-modal:not(.visible)', { state: 'attached', timeout: 5000 });

const pass = switchInHeader && leafShape && closeUpperRight && noScrim && errors.length === 0;
await finish(browser, { pass, label: 'My products is a leaf under the bud (#3701)', errors });
