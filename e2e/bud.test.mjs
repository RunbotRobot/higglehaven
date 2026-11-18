// #3649 (part of #3648, interface week #3539; the owner chose direction C): in Shop the
// interface folds into one bud. Covers: only the bud stands on the screen (the old top row is
// gone there), it carries the word Menu until it has been opened once, it unfolds and folds,
// every petal reaches what it should, a leaf opens with its close control upper right.
// #3723: Shop, Build and Sell are a half-ring of three petals at the bud's corner, hidden until it
// is unfolded, the same three in every mode with the current one marked.
import { launchPage, chooseIdentity, openAccountMenu, goToMode, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Bud Tester', viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'shop', label: 'Bud Tester', isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 20000 });

const shown = (selector) => page.locator(selector).isVisible();
const box = (selector) => page.locator(selector).boundingBox();

const rest = {
  bud: await shown('#account-menu-toggle'),
  logo: await shown('#account-menu-toggle .bud-logo'),
  gear: await shown('#account-menu-toggle .bud-gear'),
  word: await shown('#account-menu-toggle .bud-word'),
  wordmark: await shown('#wordmark-panel'),
  modeNav: await shown('#mode-nav'),
  ringAtRest: await shown('#bud-modes'),
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
  build: await shown('#bud-modes .mode-nav-btn[data-mode="build"]'),
  sell: await shown('#bud-modes .mode-nav-btn[data-mode="sell"]'),
  shopPetal: await shown('#bud-modes .mode-nav-btn[data-mode="shop"]'),
  howToMove: await shown('#bud-petal-shop-how-to-move'),
};
console.log('unfolded:', JSON.stringify(open));

// #3723: the ring. Three petals of their own, the current one marked, each clear of the bud and
// of each other, inside the screen, and the column of things you open starts below them.
const ring = await page.evaluate(() => {
  const r = (el) => el.getBoundingClientRect().toJSON();
  const mode = (m) => document.querySelector(`#bud-modes .mode-nav-btn[data-mode="${m}"]`);
  const boxes = ['shop', 'build', 'sell'].map((m) => r(mode(m)));
  const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const bud = r(document.getElementById('account-menu-toggle'));
  const column = [...document.querySelectorAll('#account-menu-panel button')].filter((b) => b.offsetParent !== null).map((b) => r(b));
  return {
    current: ['shop', 'build', 'sell'].filter((m) => mode(m).getAttribute('aria-current') === 'true'),
    apart: !overlap(boxes[0], boxes[1]) && !overlap(boxes[1], boxes[2]) && !overlap(boxes[0], boxes[2]),
    clearOfBud: boxes.every((b) => !overlap(b, bud)),
    inside: boxes.every((b) => b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight),
    rightAndBelow: boxes[0].left > bud.right - 1 && boxes[2].top > bud.bottom - 1,
    columnBelow: column.length > 0 && column.every((b) => b.top >= Math.max(...boxes.map((x) => x.bottom)) - 1),
    inColumn: document.querySelectorAll('#account-menu-panel .mode-nav-btn').length,
    group: document.getElementById('bud-modes').getAttribute('aria-label'),
  };
});
console.log('ring:', JSON.stringify(ring));
await page.waitForTimeout(100);

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

// Sell has the bud too, and the same ring.
await page.reload();
await page.waitForSelector('body.shop-ready', { timeout: 20000 });
const wordAfterReload = await shown('#account-menu-toggle .bud-word');
// Choosing another mode in the ring goes there and folds the bud.
await page.click('#account-menu-toggle');
await page.click('#bud-modes .mode-nav-btn[data-mode="sell"]');
await page.waitForSelector('body[data-mode="sell"]', { timeout: 30000 }); // the mode is decided after the page first paints
await page.waitForSelector('body[data-bud="on"]', { timeout: 20000 });
const afterPick = {
  folded: (await page.locator('#account-menu-panel.expanded').count()) === 0,
  ringHidden: !(await shown('#bud-modes')),
};
await page.click('#account-menu-toggle');
const inSell = await page.evaluate(() => ({
  bud: document.body.dataset.bud,
  modeNav: document.getElementById('mode-nav').offsetParent !== null,
  all: ['shop', 'build', 'sell'].every((m) => document.querySelector(`#bud-modes .mode-nav-btn[data-mode="${m}"]`)?.offsetParent !== null),
  current: [...document.querySelectorAll('#bud-modes .mode-nav-btn[aria-current="true"]')].map((b) => b.dataset.mode),
}));
console.log('in Sell:', JSON.stringify({ afterPick, inSell }));

const pass = rest.bud && rest.logo && !rest.gear && rest.word && !rest.wordmark && !rest.modeNav && !rest.ringAtRest
  && Math.round(rest.budBox.width) === 56 && rest.panelOpen === 0
  && open.expanded === 'true' && open.settings && open.friends && open.purchases && open.build && open.sell && open.shopPetal && open.howToMove
  && ring.current.join() === 'shop' && ring.apart && ring.clearOfBud && ring.inside && ring.rightAndBelow && ring.columnBelow
  && ring.inColumn === 0 && ring.group === 'Places'
  && afterPick.folded && afterPick.ringHidden
  && foldedByBud && foldedByEscape && !wordAfterOpen && !wordAfterReload
  && leafInfo.title === 'How to move' && leafInfo.closeUpperRight && leafInfo.panelFolded && leafInfo.insideViewport
  && leafClosedByEscape && leafClosedByX
  && inSell.bud === 'on' && !inSell.modeNav && inSell.all && inSell.current.join() === 'sell'
  && errors.length === 0;
await finish(browser, { pass, label: 'bud (#3649, #3723)', errors });
