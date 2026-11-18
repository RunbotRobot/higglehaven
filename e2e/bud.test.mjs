// #3649 (part of #3648, interface week #3539; the owner chose direction C): in Shop the
// interface folds into one bud. Covers: only the bud stands on the screen (the old top row is
// gone there), it carries the word Menu until it has been opened once, it unfolds and folds,
// every petal reaches what it should, a leaf opens with its close control upper right.
// #3723: Shop, Build and Sell are a half-ring of three petals at the bud's corner, hidden until it
// is unfolded, the same three in every mode with the current one marked.
// #3752: the petals are shapes joined to the bud that grow out of it, the chosen one stays lit while
// its mode loads (the ring held open across the reload), and they fold back when the mode is up.
import { launchPage, chooseIdentity, openAccountMenu, goToMode, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Bud Tester', viewport: { width: 390, height: 844 } });
// What the ring did across the mode switch: each distinct "state:lit petal" the page passed through,
// kept in sessionStorage so it survives the reload (#3752).
await page.addInitScript(() => {
  const note = () => {
    if (!document.body) return;
    const state = document.body.getAttribute('data-bud-ring') || 'none';
    const lit = [...document.querySelectorAll('#bud-modes .mode-nav-btn[aria-current="true"]')].map((b) => b.dataset.mode).join('+');
    const log = JSON.parse(sessionStorage.getItem('ringlog') || '[]');
    const entry = `${state}:${lit}`;
    if (log[log.length - 1] !== entry) { log.push(entry); sessionStorage.setItem('ringlog', JSON.stringify(log)); }
  };
  new MutationObserver(note).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-bud-ring', 'aria-current', 'data-bud'] });
});
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

// #3752: the petals unfold from the bud: the tap starts their animation at once.
const unfoldAnimations = await page.evaluate(() => {
  document.getElementById('account-menu-toggle').click();
  return [...document.querySelectorAll('#bud-modes .mode-nav-btn')].map((b) => b.getAnimations().map((a) => a.animationName).join());
});
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
  help: await shown('#bud-petal-general-help'),
};
console.log('unfolded:', JSON.stringify(open));

// #3723, #3752: the ring. Four petals (three places and Menu) of their own, the current one marked, each a turned shape
// whose base is joined to the bud (a point just outside the bud, along its angle, lands on the
// petal), 44px wide at the widest, apart from each other, inside the screen, and the column of
// things you open starts below them. The word beside the bud steps aside while they are out.
const ring = await page.evaluate(() => {
  const r = (el) => el.getBoundingClientRect().toJSON();
  const mode = (m) => document.querySelector(`#bud-modes .mode-nav-btn[data-mode="${m}"]`);
  const modes = ['shop', 'build', 'sell'];
  const boxes = modes.map((m) => r(mode(m)));
  const centres = boxes.map((b) => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 }));
  const bud = r(document.getElementById('account-menu-toggle'));
  const hub = { x: bud.left + bud.width / 2, y: bud.top + bud.height / 2 };
  const angles = [6, 36, 66]; // #3760: four petals now (the fourth, Menu, is at 96)
  const column = [...document.querySelectorAll('#account-menu-panel button')].filter((b) => b.offsetParent !== null).map((b) => r(b));
  const word = document.querySelector('#account-menu-toggle .bud-word');
  return {
    current: modes.filter((m) => mode(m).getAttribute('aria-current') === 'true'),
    apart: [[0, 1], [1, 2], [0, 2]].every(([i, j]) => Math.hypot(centres[i].x - centres[j].x, centres[i].y - centres[j].y) >= 34) // #3760: four petals 30 degrees apart; they meet only at their widest,
    joined: modes.every((m, i) => {
      const t = (angles[i] * Math.PI) / 180;
      const hit = document.elementFromPoint(hub.x + Math.cos(t) * 40, hub.y + Math.sin(t) * 40);
      return hit && (hit === mode(m) || mode(m).contains(hit));
    }),
    tipsHit: modes.every((m, i) => {
      const t = (angles[i] * Math.PI) / 180;
      const hit = document.elementFromPoint(hub.x + Math.cos(t) * 90, hub.y + Math.sin(t) * 90);
      return hit && (hit === mode(m) || mode(m).contains(hit));
    }),
    wide: modes.every((m) => mode(m).offsetHeight >= 44),
    labelsUpright: modes.every((m) => {
      const label = mode(m).querySelector('.mode-nav-label').getBoundingClientRect();
      return label.width > label.height;
    }),
    inside: boxes.every((b) => b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight),
    columnBelow: column.length > 0 && column.every((b) => b.top >= Math.max(...boxes.map((x) => x.bottom)) - 1),
    wordHidden: word ? getComputedStyle(word).visibility === 'hidden' || !word.offsetParent : true,
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

// A leaf: "?" (Help).
await page.click('#account-menu-toggle');
await page.click('#bud-petal-general-help');
await page.waitForSelector('#bud-leaf-help');
await page.waitForTimeout(500);
const leaf = await box('#bud-leaf-help');
const closeBox = await box('#bud-leaf-help .bud-leaf-close');
const leafTitle = await page.textContent('#bud-leaf-help h2');
const leafInfo = {
  title: leafTitle,
  closeUpperRight: closeBox.x + closeBox.width / 2 > leaf.x + leaf.width * 0.75 && closeBox.y + closeBox.height / 2 < leaf.y + 60,
  panelFolded: (await page.locator('#account-menu-panel.expanded').count()) === 0,
  insideViewport: leaf.x >= 0 && leaf.x + leaf.width <= 390,
};
console.log('leaf:', JSON.stringify(leafInfo));
await page.keyboard.press('Escape');
const leafClosedByEscape = (await page.locator('#bud-leaf-help').count()) === 0;
await page.click('#account-menu-toggle');
await page.click('#bud-petal-general-help');
await page.click('#bud-leaf-help .bud-leaf-close');
const leafClosedByX = (await page.locator('#bud-leaf-help').count()) === 0;

// Settings in two taps.
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('#settings-close-btn');

// Sell has the bud too, and the same ring.
await page.reload();
await page.waitForSelector('body.shop-ready', { timeout: 20000 });
const wordAfterReload = await shown('#account-menu-toggle .bud-word');
// Choosing another mode in the ring: the chosen petal is lit at once with the ring still out, the
// page goes there, and when the mode is on screen the petals fold back into the bud (#3752).
await page.evaluate(() => sessionStorage.removeItem('ringlog'));
await page.click('#account-menu-toggle');
await page.waitForTimeout(450);
await page.click('#bud-modes .mode-nav-btn[data-mode="sell"]');
await page.waitForSelector('body[data-mode="sell"]', { timeout: 30000 }); // the mode is decided after the page first paints
await page.waitForSelector('body[data-bud="on"]', { timeout: 20000 });
await page.waitForFunction(() => getComputedStyle(document.getElementById('bud-modes')).display === 'none', null, { timeout: 30000 });
const ringLog = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ringlog') || '[]'));
const afterPick = {
  folded: (await page.locator('#account-menu-panel.expanded').count()) === 0,
  ringHidden: await page.evaluate(() => getComputedStyle(document.getElementById('bud-modes')).display === 'none'),
  ringLog,
  heldLit: ringLog.indexOf('held:sell') >= 0,
  foldedAfterHeld: ringLog.indexOf('folding:sell') > ringLog.indexOf('held:sell') && ringLog[ringLog.length - 1] === 'none:sell',
};
await page.click('#account-menu-toggle');
const inSell = await page.evaluate(() => ({
  bud: document.body.dataset.bud,
  modeNav: document.getElementById('mode-nav').offsetParent !== null,
  all: ['shop', 'build', 'sell'].every((m) => document.querySelector(`#bud-modes .mode-nav-btn[data-mode="${m}"]`)?.offsetParent !== null),
  current: [...document.querySelectorAll('#bud-modes .mode-nav-btn[aria-current="true"]')].map((b) => b.dataset.mode),
}));
// The mode you are already in has nothing to load: tapping its petal opens that place's own menu (#3760)
// and the bud stays open.
const sameModeTap = await (async () => {
  await page.click('#bud-modes .mode-nav-btn[data-mode="sell"]');
  await page.waitForSelector('#bud-petal-sell-my-products', { state: 'visible', timeout: 5000 });
  return { stayedOnSell: await page.evaluate(() => document.body.dataset.mode) };
})();
console.log('in Sell:', JSON.stringify({ afterPick, inSell, sameModeTap }));

const pass = rest.bud && rest.logo && !rest.gear && rest.word && !rest.wordmark && !rest.modeNav && !rest.ringAtRest
  && Math.round(rest.budBox.width) === 56 && rest.panelOpen === 0
  && open.expanded === 'true' && open.settings && open.friends && open.purchases && open.build && open.sell && open.shopPetal && open.help
  && ring.current.join() === 'shop' && ring.apart && ring.joined && ring.tipsHit && ring.wide && ring.labelsUpright
  && ring.inside && ring.columnBelow && ring.wordHidden
  && unfoldAnimations.length === 3 && unfoldAnimations.every((a) => a.includes('bud-grow'))
  && ring.inColumn === 0 && ring.group === 'Places and menu'
  && afterPick.folded && afterPick.ringHidden && afterPick.heldLit && afterPick.foldedAfterHeld
  && sameModeTap.stayedOnSell === 'sell'
  && foldedByBud && foldedByEscape && !wordAfterOpen && !wordAfterReload
  && leafInfo.title === 'Help' && leafInfo.closeUpperRight && leafInfo.panelFolded && leafInfo.insideViewport
  && leafClosedByEscape && leafClosedByX
  && inSell.bud === 'on' && !inSell.modeNav && inSell.all && inSell.current.join() === 'sell'
  && errors.length === 0;
await finish(browser, { pass, label: 'bud (#3649, #3723, #3752)', errors });
