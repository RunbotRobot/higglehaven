// #4242: zoomed in close on an item that fills the screen, the item's card has no clear place beside it, above
// it or below it. It docks to the top or bottom edge as a short strip, clear of the item's middle (where the
// rings are), and while a ring is held it stays exactly where it is and lets touches through. 390x844.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Item Card Fills Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const cardState = () => page.evaluate(() => {
  const el = document.getElementById('item-card');
  const r = el.getBoundingClientRect();
  return { shown: !el.hidden && r.height > 0, side: el.dataset.side, edge: el.dataset.edge, held: el.dataset.held, capped: el.dataset.capped,
    top: r.top, bottom: r.bottom, left: r.left, right: r.right, pointer: getComputedStyle(el).pointerEvents, opacity: getComputedStyle(el).opacity };
});

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(160, 380);
await page.waitForTimeout(1000);

const normal = await cardState();
console.log('card before zooming:', JSON.stringify(normal));
check(normal.shown && normal.edge === 'false', 'beside an item that does not fill the view, the card is the ordinary card');

// A catalog item small enough never reaches the real threshold even at the closest zoom, so the test lowers the
// share of the screen's width an item must cover to count as filling the view (window.__testSetCardFillsViewShare).
await page.evaluate(() => window.__testSetCardFillsViewShare(0.2));
await page.mouse.move(195, 430);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(600);
const anchor = await page.evaluate(() => window.__testItemCardAnchor());
console.log('anchor after zooming:', JSON.stringify(anchor));
check(anchor && anchor.fills === true, 'zooming in reaches an item that fills the view');
await page.waitForTimeout(500);

const docked = await cardState();
console.log('card when the item fills the view:', JSON.stringify(docked));
check(docked.shown, 'the card is still showing');
check(docked.edge === 'true', 'it has no pointer (there is no point to point at)');
const atTop = docked.top <= 52 + 1;
const atBottom = docked.bottom >= 844 - 12 - 1;
check(atTop || atBottom, `it is docked to an edge of the screen (${docked.top}..${docked.bottom})`);
check(docked.bottom - docked.top <= 844 * 0.4, `it is a short strip (${docked.bottom - docked.top}px)`);
const middle = anchor ? anchor.y : 422;
check(!(docked.top <= middle && docked.bottom >= middle), `it does not cover the item's middle, where the rings are (${middle})`);

// A ring held: the card stays where it is, fainter, and lets touches through.
await page.evaluate(() => { window.__holdProbe = true; });
const held = await page.evaluate(() => {
  const el = document.getElementById('item-card');
  el.dataset.held = 'true'; // what a held ring sets (itemCard.js), forced here so the test needs no ring drag
  return { pointer: getComputedStyle(el).pointerEvents, opacity: Number(getComputedStyle(el).opacity) };
});
check(held.pointer === 'none' && held.opacity < 0.6, `a held card lets touches through and fades (${JSON.stringify(held)})`);
await page.evaluate(() => { document.getElementById('item-card').dataset.held = 'false'; });

await finish(browser, { pass, label: 'Build item card docks clear of an item that fills the view (#4242)', errors });
