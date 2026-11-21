// #3874: the open menu on a phone turned on its side (844x390). The stem used to start 164px below the
// head, which left Settings and Help below the bottom of a 390px screen. On a short screen every leaf of
// the open menu is on the screen, the first leaf still starts below the ring of petals (nothing
// overlaps), and the sign/compass keep their place. Upright (390x844) the stem keeps its old start.
import { launchPage, chooseIdentity, goToMode, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Short Screen';
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

async function readMenu(page) {
  return page.evaluate(() => {
    const box = (e) => e.getBoundingClientRect().toJSON();
    const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const leaves = [...document.querySelectorAll('#account-menu-panel > button, #account-menu-panel > .bud-pair')].filter(shown).map((e) => ({ id: e.id || e.className, text: e.textContent.trim().slice(0, 14), ...box(e) }));
    const ring = [...document.querySelectorAll('#bud-modes .mode-nav-btn, #bud-modes .bud-menu-btn')].filter(shown).map(box);
    const head = document.getElementById('bud-head-row');
    return { leaves, ringBottom: Math.max(...ring.map((r) => r.bottom)), headBox: head ? box(head) : null, vh: innerHeight, vw: innerWidth };
  });
}

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 844, height: 390 } });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });
await openAccountMenu(page);
await page.waitForTimeout(1200);
const shop = await readMenu(page);
console.log('Shop 844x390:', JSON.stringify({ ringBottom: shop.ringBottom, leaves: shop.leaves.map((l) => `${l.text}:${Math.round(l.top)}-${Math.round(l.bottom)}`) }));
check(shop.leaves.length >= 4, `Shop's open menu has its leaves (${shop.leaves.length})`);
check(shop.leaves.every((l) => l.bottom <= shop.vh), `every leaf of the open Shop menu is on a 390px screen (lowest ends at ${Math.max(...shop.leaves.map((l) => l.bottom))})`);
check(shop.leaves[0].top >= shop.ringBottom, `the first leaf starts below the ring (${shop.leaves[0].top} vs ${shop.ringBottom})`);
check(shop.headBox && shop.headBox.bottom <= shop.leaves[0].top + 80 && shop.headBox.top >= 0, `the compass row stays where it was (${shop.headBox && Math.round(shop.headBox.top)}-${shop.headBox && Math.round(shop.headBox.bottom)})`);
check(shop.leaves.every((l, i) => i < 2 || l.top >= shop.leaves[i - 2].bottom - 1), 'leaves on the same side do not overlap');
check(shop.leaves.every((l) => l.right <= shop.vw && l.left >= 0), 'and inside the width');

await page.keyboard.press('Escape');
await page.waitForTimeout(600);
await goToMode(page, 'sell', { openProducts: false });
await page.waitForSelector('body[data-mode="sell"][data-bud="on"]', { timeout: 30000 });
await openAccountMenu(page);
await page.waitForTimeout(1200);
const sell = await readMenu(page);
console.log('Sell 844x390:', JSON.stringify({ ringBottom: sell.ringBottom, leaves: sell.leaves.map((l) => `${l.text}:${Math.round(l.top)}-${Math.round(l.bottom)}`) }));
check(sell.leaves.every((l) => l.bottom <= sell.vh), `every leaf of the open Sell menu is on a 390px screen (lowest ends at ${Math.max(...sell.leaves.map((l) => l.bottom))})`);
check(sell.leaves[0].top >= sell.ringBottom, 'Sell: the first leaf starts below the ring');

// Upright keeps the old start (the media query does not apply).
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
await openAccountMenu(page);
await page.waitForTimeout(1200);
const upright = await readMenu(page);
check(upright.leaves[0].top >= upright.ringBottom + 60, `upright, the stem still starts well below the ring (${upright.leaves[0].top} vs ${upright.ringBottom})`);

await finish(browser, { pass, label: 'Short screen', errors });
