// #3573, #3689: in Build, the selected item's name is the title of the item card
// that blooms beside the item (it no longer floats in the stack at the top of the
// screen, where on a phone a long name wrapped into the toolbar row). The card is
// wholly on screen, clear of the compass, the Undo/Redo pair and the toolbar row,
// and the top pill stays empty. 390x844, a placed Tree.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Name Label Clear Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const boxes = () => page.evaluate(() => {
  const box = (id) => {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, shown: r.height > 0 && getComputedStyle(el).display !== 'none' };
  };
  return { name: box('item-card'), pill: box('product-info'), toolbar: box('gizmo-mode-controls'), compass: box('compass-panel'), undo: box('undo-redo-panel') };
});

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(160, 380);
await page.waitForTimeout(800);

// E2E_SHOT_DIR=<dir> saves a still of the card (for a PR description).
if (process.env.E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/item-card-tools.png` });
const b = await boxes();
check(b.name.shown, `the item card is showing (${JSON.stringify(b)})`);
// #3689: with Move and Rotate gone the tool row holds only Trim, so a Tree (not trimmable) has no row at all.
check(!b.toolbar.shown, `the tool row is left out when it would be empty (${JSON.stringify(b.toolbar)})`);
check(!b.pill.shown, `the name is not also drawn in the top pill (${JSON.stringify(b.pill)})`);
check(b.name.left >= 0 && b.name.right <= 390 && b.name.top >= 0 && b.name.bottom <= 844, `the item card is wholly on screen (${JSON.stringify(b.name)})`);
check(await page.evaluate(() => document.getElementById('item-card-name').textContent.includes('Tree')), 'the card is titled with the item name');
check(!b.compass.shown, `the compass is not standing on the world, so the name cannot run under it (#3772)`);
check(b.name.top >= b.undo.bottom || b.name.right <= b.undo.left, `the name does not run under the Undo/Redo pair (${JSON.stringify({ name: b.name, undo: b.undo })})`);

// Selecting nothing again: the toolbar row goes, and nothing is left behind that
// would push the next one down.
await page.mouse.click(40, 600);
await page.waitForTimeout(500);
const after = await boxes();
check(!after.toolbar.shown, 'the toolbar row goes with the selection');
check(!after.name.shown, 'the item card goes with the selection');

await finish(browser, { pass: pass && errors.length === 0, label: '#3573, #3689: the item card clears the compass, Undo/Redo and the toolbar row', errors });
