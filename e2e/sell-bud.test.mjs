// #3699 (Sell in the bud, 1/6 of #3655; part of #3648): in Sell the interface is the bud. Covers at
// 390x844: the old top row (wordmark pill, gear, Shop/Build/Sell pills) and the bottom-right
// Products button are gone; the bud unfolds into My products, How to move, Settings and the Shop and
// Build mode buttons; My products opens from its petal (two taps) after the list has been closed;
// How to move is a leaf that closes with Escape.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Sell Bud Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForSelector('body[data-bud="on"]', { timeout: 10000 });
await page.click('#seller-close-btn');
await page.waitForTimeout(500);

const shown = (selector) => page.locator(selector).isVisible();
const rest = {
  bud: await shown('#account-menu-toggle'),
  logo: await shown('#account-menu-toggle .bud-logo'),
  gear: await shown('#account-menu-toggle .bud-gear'),
  wordmark: await shown('#wordmark-panel'),
  modeNav: await shown('#mode-nav'),
  productsButton: await page.locator('#seller-showcase-manage-btn').count(),
  panelOpen: await page.locator('#account-menu-panel.expanded').count(),
};
console.log('at rest in Sell:', JSON.stringify(rest));

await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded');
await page.waitForTimeout(500);
const open = {
  myProducts: await shown('#bud-petal-sell-my-products'),
  howToMove: await shown('#bud-petal-sell-how-to-move'),
  shopHowToMove: await shown('#bud-petal-shop-how-to-move'),
  settings: await shown('#settings-btn'),
  shop: await shown('.mode-nav-btn[data-mode="shop"]'),
  build: await shown('.mode-nav-btn[data-mode="build"]'),
  sellItself: await shown('.mode-nav-btn[data-mode="sell"]'),
};
console.log('unfolded:', JSON.stringify(open));

// My products from its petal: two taps from the showroom.
await page.click('#bud-petal-sell-my-products');
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
const foldedAfterPetal = (await page.locator('#account-menu-panel.expanded').count()) === 0;
console.log('bud folded after the petal (should be true):', foldedAfterPetal);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

// How to move: a leaf, closed with Escape.
await page.click('#account-menu-toggle');
await page.click('#bud-petal-sell-how-to-move');
await page.waitForSelector('#bud-leaf-how-to-move');
const leafTitle = await page.textContent('#bud-leaf-how-to-move h2');
await page.keyboard.press('Escape');
const leafClosed = (await page.locator('#bud-leaf-how-to-move').count()) === 0;
console.log('leaf:', leafTitle, leafClosed);

// Settings stays two taps.
await page.click('#account-menu-toggle');
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });

const pass = rest.bud && rest.logo && !rest.gear && !rest.wordmark && !rest.modeNav && rest.productsButton === 0
  && rest.panelOpen === 0
  && open.myProducts && open.howToMove && !open.shopHowToMove && open.settings && open.shop && open.build && !open.sellItself
  && foldedAfterPetal && leafTitle === 'How to move' && leafClosed
  && errors.length === 0;
await finish(browser, { pass, label: 'Sell in the bud (#3699)', errors });
