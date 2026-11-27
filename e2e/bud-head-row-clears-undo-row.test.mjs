// #4567: in Build with the menu open, the lándlet's name card and the compass stood 9 px over the bottom of the
// undo/redo row (row y 52 to 92, compass y 83 to 131 at 390x844). Both now start below the row, in Build and Shop.
import { launchPage, chooseIdentity, goToMode, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Head Row';
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });
await openAccountMenu(page);
await page.waitForTimeout(1200);
const read = () => page.evaluate(() => {
  const box = (e) => (e ? e.getBoundingClientRect().toJSON() : null);
  const undo = document.getElementById('undo-redo-panel');
  return { head: box(document.getElementById('bud-head-row')), compass: box(document.getElementById('compass-panel')), undoBottom: undo ? parseFloat(getComputedStyle(undo).top) + 40 : null, undoShown: !!undo && undo.getBoundingClientRect().height > 0 };
});
const shop = await read();
check(shop.head && shop.head.top >= 92, `Shop: the head row starts at or below y 92 (${shop.head && Math.round(shop.head.top)})`);
check(shop.compass && shop.compass.top >= 92, `Shop: the compass starts at or below y 92 (${shop.compass && Math.round(shop.compass.top)})`);

await page.keyboard.press('Escape');
await page.waitForTimeout(600);
await goToMode(page, 'build');
await page.waitForSelector('body[data-mode="build"][data-bud="on"]', { timeout: 30000 });
await openAccountMenu(page);
await page.waitForTimeout(1200);
const build = await read();
const undoRect = await page.evaluate(() => { const u = document.getElementById('undo-redo-panel'); return u ? u.getBoundingClientRect().toJSON() : null; });
if (undoRect && undoRect.height > 0) {
  check(build.head.top >= undoRect.bottom, `Build: the head row (${Math.round(build.head.top)}) is below the undo/redo row (${Math.round(undoRect.bottom)})`);
  check(build.compass.top >= undoRect.bottom, `Build: the compass (${Math.round(build.compass.top)}) is below the undo/redo row (${Math.round(undoRect.bottom)})`);
} else {
  check(build.head.top >= 92, `Build: the head row starts at or below y 92 (${Math.round(build.head.top)})`);
}
await finish(browser, { pass, label: 'Head row clears the undo row', errors });
