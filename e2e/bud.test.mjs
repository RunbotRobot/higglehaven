// #3649 (part of #3648, interface week #3539; the owner chose direction C): in Shop the
// interface folds into one bud. Covers: only the bud stands on the screen (the old top row is
// gone there), it carries the word Menu until it has been opened once, it unfolds and folds,
// every petal reaches what it should, a leaf opens with its close control upper right, and
// Build keeps its own controls until it gets petals.
import { launchPage, chooseIdentity, openAccountMenu, goToMode, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Bud Tester', viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'shop', label: 'Bud Tester', isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 20000 });

const shown = (selector) => page.locator(selector).isVisible();
const box = (selector) => page.locator(selector).boundingBox();

const rest = {
  bud: await shown('#account-menu-toggle'),
  logo: await shown('#account-menu-toggle .bud-logo'),
  gear: await shown('#account-menu-toggle .bud-gear'),
  word: await shown('#account-menu-toggle .bud-word'),
  wordmark: await shown('#wordmark-panel'),
  modeNav: await shown('#mode-nav'),
  budBox: await box('#account-menu-toggle'),
  panelOpen: await page.locator('#account-menu-panel.expanded').count(),
};
console.log('at rest in Shop:', JSON.stringify(rest));

await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded');
await page.waitForTimeout(500);
const open = {
  expanded: await page.getAttribute('#account-menu-toggle', 'aria-expanded'),
  settings: await shown('#settings-btn'),
  friends: await shown('#friends-btn'),
  purchases: await shown('#my-purchases-btn'),
  build: await shown('.mode-nav-btn[data-mode="build"]'),
  sell: await shown('.mode-nav-btn[data-mode="sell"]'),
  shopPetal: await shown('.mode-nav-btn[data-mode="shop"]'),
  howToMove: await shown('#bud-petal-shop-how-to-move'),
};
console.log('unfolded:', JSON.stringify(open));

// Folding: the bud again, then Escape.
await page.click('#account-menu-toggle');
const foldedByBud = (await page.locator('#account-menu-panel.expanded').count()) === 0;
await page.click('#account-menu-toggle');
await page.keyboard.press('Escape');
const foldedByEscape = (await page.locator('#account-menu-panel.expanded').count()) === 0;
const wordAfterOpen = await shown('#account-menu-toggle .bud-word');

// A leaf: How to move.
await page.click('#account-menu-toggle');
await page.click('#bud-petal-shop-how-to-move');
await page.waitForSelector('#bud-leaf-how-to-move');
await page.waitForTimeout(500);
const leaf = await box('#bud-leaf-how-to-move');
const closeBox = await box('#bud-leaf-how-to-move .bud-leaf-close');
const leafTitle = await page.textContent('#bud-leaf-how-to-move h2');
const leafInfo = {
  title: leafTitle,
  closeUpperRight: closeBox.x + closeBox.width / 2 > leaf.x + leaf.width * 0.75 && closeBox.y + closeBox.height / 2 < leaf.y + 60,
  panelFolded: (await page.locator('#account-menu-panel.expanded').count()) === 0,
  insideViewport: leaf.x >= 0 && leaf.x + leaf.width <= 390,
};
console.log('leaf:', JSON.stringify(leafInfo));
await page.keyboard.press('Escape');
const leafClosedByEscape = (await page.locator('#bud-leaf-how-to-move').count()) === 0;
await page.click('#account-menu-toggle');
await page.click('#bud-petal-shop-how-to-move');
await page.click('#bud-leaf-how-to-move .bud-leaf-close');
const leafClosedByX = (await page.locator('#bud-leaf-how-to-move').count()) === 0;

// Settings in two taps.
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('#settings-close-btn');

// Sell has the bud too (#3699), as Build does (#3688): the old top row and the gear are gone there.
// (Main's version of this check still expected Sell to keep its row, red since both landed.)
await page.reload();
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 20000 });
const wordAfterReload = await shown('#account-menu-toggle .bud-word');
await goToMode(page, 'sell');
await page.waitForSelector('body[data-mode="sell"]', { timeout: 30000 }); // the mode is decided after the page first paints
await page.waitForSelector('body[data-bud="on"]', { timeout: 20000 });
const inBuild = {
  budOff: await page.evaluate(() => document.body.dataset.bud),
  modeNav: await shown('#mode-nav'),
  wordmark: await shown('#wordmark-panel'),
  gear: await shown('#account-menu-toggle .bud-gear'),
};
console.log('in Sell:', JSON.stringify(inBuild));

const pass = rest.bud && rest.logo && !rest.gear && rest.word && !rest.wordmark && !rest.modeNav
  && Math.round(rest.budBox.width) === 56 && rest.panelOpen === 0
  && open.expanded === 'true' && open.settings && open.friends && open.purchases && open.build && open.sell && !open.shopPetal && open.howToMove
  && foldedByBud && foldedByEscape && !wordAfterOpen && !wordAfterReload
  && leafInfo.title === 'How to move' && leafInfo.closeUpperRight && leafInfo.panelFolded && leafInfo.insideViewport
  && leafClosedByEscape && leafClosedByX
  && inBuild.budOff === 'on' && !inBuild.modeNav && !inBuild.wordmark && !inBuild.gear
  && errors.length === 0;
await finish(browser, { pass, label: 'bud (#3649)', errors });
