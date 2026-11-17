// #3689 (leaf 2/6 of #3654): tap an item in Build and its card blooms beside it.
// The card is titled with the item's name, carries Copy, Delete and More (which
// holds Snap), follows the item as the view moves, stays wholly on screen, and goes
// when the selection does. Delete is immediate and Undo brings the item back, as it
// did from the old toolbar. 390x844, a placed Tree.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Item Card Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const card = () => page.evaluate(() => {
  const el = document.getElementById('item-card');
  const r = el.getBoundingClientRect();
  const name = document.getElementById('item-card-name');
  return {
    shown: !el.hidden && r.height > 0,
    state: el.dataset.state,
    box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
    title: name.textContent,
    selectable: getComputedStyle(name).userSelect !== 'none',
    snapShown: document.getElementById('toggle-snap').getBoundingClientRect().height > 0,
  };
});

check(!(await card()).shown, 'no card before anything is selected');

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(160, 380);
await page.waitForTimeout(1200);

const c = await card();
check(c.shown, `the card shows once an item is selected (${JSON.stringify(c)})`);
check(c.state === 'open', `the card has finished blooming (${c.state})`);
check(c.title.includes('Tree'), `the card is titled with the item's name (${c.title})`);
check(c.selectable, 'the title can be selected and copied');
check(c.box.left >= 0 && c.box.right <= 390 && c.box.top >= 0 && c.box.bottom <= 844, `the card is wholly on screen (${JSON.stringify(c.box)})`);
check(!c.snapShown, 'Snap is folded into More until it is opened');
const anchor = await page.evaluate(() => window.__testItemCardAnchor());
check(anchor && !anchor.behind && Number.isFinite(anchor.x), `the card is anchored to the item on screen (${JSON.stringify(anchor)})`);

// More holds Snap; it toggles like it did on the toolbar.
await page.click('#item-card-more-btn');
check((await card()).snapShown, 'More shows Snap');
const snapBefore = await page.getAttribute('#toggle-snap', 'aria-pressed');
await page.click('#toggle-snap');
const snapAfter = await page.getAttribute('#toggle-snap', 'aria-pressed');
check(snapBefore === 'true' && snapAfter === 'false', `Snap toggles (${snapBefore} -> ${snapAfter})`);
await page.click('#toggle-snap');

// Copy says so at the top, as before.
await page.click('#copy-item');
await page.waitForTimeout(300);
check((await page.textContent('#product-info')).includes('Copied 1 item'), 'Copy confirms at the top');

// The card follows the item when the camera moves.
const before = await card();
await page.mouse.move(300, 500);
await page.mouse.down();
await page.mouse.move(250, 500, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(500);
const afterOrbit = await card();
check(afterOrbit.shown, 'the card is still showing after the view moves');
check(afterOrbit.box.left >= 0 && afterOrbit.box.right <= 390 && afterOrbit.box.top >= 0 && afterOrbit.box.bottom <= 844, 'it stays wholly on screen');
console.log('card before/after orbit:', JSON.stringify(before.box), JSON.stringify(afterOrbit.box));

// The close button clears the selection and the card with it.
await page.click('#item-card-close-btn');
await page.waitForTimeout(300);
check(!(await card()).shown, 'Close clears the selection and the card');

// Select again, Delete at once, Undo brings it back.
await page.evaluate(() => window.__testSelectAllProducts());
await page.waitForTimeout(300);
check((await card()).shown, 'the card shows for a selection made another way');
await page.click('#delete-item');
await page.waitForTimeout(500);
check(!(await card()).shown, 'Delete removes the item and the card goes');
await page.click('#undo-btn');
await page.waitForTimeout(800);
await page.evaluate(() => window.__testSelectAllProducts());
await page.waitForTimeout(300);
check((await card()).shown, 'Undo brings the item back');

await finish(browser, { pass: pass && errors.length === 0, label: '#3689: the item card blooms beside the selected item', errors });
