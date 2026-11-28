// #4410: the item's card opens clear of every ring and arrow of the selection ("a card never covers the thing it is
// about"), above it as well as below it. The up arrow reaches farther up than the down arrow does down (perspective),
// so a card above the item needs more room than a card below. 390x844, an item low on the screen (the card goes above)
// and one high on it (the card goes below).
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Card Clear Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

async function placeTreeAt(y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).first().click();
  await page.waitForTimeout(300);
  await page.mouse.click(195, y);
  await page.waitForTimeout(1200);
}

async function cardVersusArrows(label) {
  const read = await page.evaluate(() => {
    const e = document.getElementById('item-card');
    const b = e.getBoundingClientRect();
    return { card: { left: b.left, top: b.top, right: b.right, bottom: b.bottom }, side: e.dataset.side, arrows: window.__testAxisHandlePoints() };
  });
  console.log(label, 'side', read.side, 'card', JSON.stringify([read.card.left, read.card.top, read.card.right, read.card.bottom].map(Math.round)), 'arrows', JSON.stringify(read.arrows.map((p) => `${p.axis}${Math.round(p.x)},${Math.round(p.y)}`)));
  check(read.arrows.length === 6, `${label}: six arrows`);
  const PAD = 14; // the point the hook gives is the arrow tip; a little room round it
  for (const p of read.arrows) {
    const inside = p.x > read.card.left - PAD && p.x < read.card.right + PAD && p.y > read.card.top - PAD && p.y < read.card.bottom + PAD;
    check(!inside, `${label}: the ${p.axis} arrow at ${Math.round(p.x)},${Math.round(p.y)} is clear of the card`);
  }
  return read.side;
}

// #4624: the card's buttons are drawn small (28 and 32px) so the card stays small, but a finger just outside each still
// lands on a card button, not on the card behind it: 3px above and below each action button, 5px outside Close. The four
// action buttons wrap onto two rows, and where two rows meet the gap is shared between them, so a point there may belong to
// the neighbour; what must never happen is a neighbour's tap area reaching into a drawn button (Delete stealing a tap from
// Save bundle), so a point 1px inside every drawn edge must hit its own button.
async function tapAreas(label) {
  const misses = await page.evaluate(() => {
    const out = [];
    const actions = ['save-bundle-item', 'copy-item', 'delete-item', 'item-card-more-btn'];
    const hit = (id, points, mayBe = [id]) => {
      const b = document.getElementById(id);
      if (!b || b.hidden || b.getClientRects().length === 0) { out.push(`${id} not shown`); return; }
      const r = b.getBoundingClientRect();
      for (const [name, x, y, own] of points(r)) {
        const el = document.elementFromPoint(x, y);
        const ok = own ? el === b : mayBe.includes(el?.id);
        if (!ok) out.push(`${id} ${name} (${Math.round(x)},${Math.round(y)}) hit ${el?.id || el?.tagName}`);
      }
    };
    for (const id of actions) {
      hit(id, (r) => [
        ['3px above', r.left + r.width / 2, r.top - 3, false], ['3px below', r.left + r.width / 2, r.bottom + 3, false],
        ['1px inside the top', r.left + r.width / 2, r.top + 1, true], ['1px inside the bottom', r.left + r.width / 2, r.bottom - 1, true],
      ], actions);
    }
    hit('item-card-close-btn', (r) => [['5px out the top', r.left + r.width / 2, r.top - 5, true], ['5px out the left', r.left - 5, r.top + r.height / 2, true]]);
    return out;
  });
  check(misses.length === 0, `${label}: a finger just outside each card button lands on one, and none steals from another (${misses.join('; ')})`);
}

await placeTreeAt(640); // low on the screen: the card goes above
await tapAreas('item low');
const sideLow = await cardVersusArrows('item low');
check(sideLow === 'above', `the card is above an item low on the screen (it is ${sideLow})`);

// Select a second item higher on the screen instead.
await page.click('#item-card-close-btn').catch(() => {});
await page.waitForTimeout(600);
await placeTreeAt(400);
const sideHigh = await cardVersusArrows('item high');
check(sideHigh === 'below', `and below an item higher on the screen (it is ${sideHigh})`);

await finish(browser, { pass: pass && errors.length === 0, label: '#4410: the item card opens clear of every arrow, above the item or below it', errors });
