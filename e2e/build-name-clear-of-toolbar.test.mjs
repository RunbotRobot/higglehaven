// #3573: in Build, the selected item's name sits above the toolbar row and clear
// of the compass and the Undo/Redo pair. On a phone a long name wraps to two
// lines; the name box used to end 3 px below where the toolbar row started, and
// the row's top was a fixed number that never followed the name. It now starts
// below the name wherever the name ends. 390x844, a placed Tree.
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
  return { name: box('product-info'), toolbar: box('gizmo-mode-controls'), compass: box('compass-panel'), undo: box('undo-redo-panel') };
});

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(160, 380);
await page.waitForTimeout(800);

const b = await boxes();
check(b.name.shown && b.toolbar.shown, `the name and the toolbar row are both showing (${JSON.stringify(b)})`);
check(b.toolbar.top >= b.name.bottom, `the toolbar row starts at or below the bottom of the name (toolbar ${b.toolbar.top}, name ${b.name.bottom})`);
check(b.name.right <= b.compass.left || b.name.bottom <= b.compass.top || b.name.left >= b.compass.right, `the name does not run under the compass (${JSON.stringify({ name: b.name, compass: b.compass })})`);
check(b.name.top >= b.undo.bottom || b.name.right <= b.undo.left, `the name does not run under the Undo/Redo pair (${JSON.stringify({ name: b.name, undo: b.undo })})`);

// Selecting nothing again: the toolbar row goes, and nothing is left behind that
// would push the next one down.
await page.mouse.click(40, 600);
await page.waitForTimeout(500);
const after = await boxes();
check(!after.toolbar.shown, 'the toolbar row goes with the selection');

await finish(browser, { pass: pass && errors.length === 0, label: '#3573: the item name clears the compass, Undo/Redo and the toolbar row', errors });
