// #3913 / #3544: the walk hint ("Drag on the left half of the screen to walk") waits while a leaf
// has the person's attention. The first fix only matched `.bud-leaf`; Friends, Settings and the
// other leaves are dialogs, so the hint still showed under them (seen live, Friends leaf, 390x844).
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Hint Under Leaf';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
// The hint is for a real person's pointer, not an automated one (firstVisitHints.js), so this page
// reports itself as not automated before it loads.
await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
await page.reload({ waitUntil: 'networkidle' });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 20000 });

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const hintVisibility = () => page.evaluate(() => {
  const el = document.getElementById('world-hint');
  return el ? getComputedStyle(el).visibility : 'absent';
});

const shown = await page.waitForSelector('#world-hint.visible', { timeout: 20000 }).then(() => true, () => false);
check(shown, 'the walk hint is showing before any leaf is open');
check((await hintVisibility()) === 'visible', `the hint is drawn with no leaf open (${await hintVisibility()})`);

await openAccountMenu(page);
for (const [button, dialog, closeBtn] of [
  ['#friends-btn', '#friends-modal.visible', '#friends-close-btn'],
  ['#settings-btn', '#settings-modal.visible', '#settings-close-btn'],
]) {
  if (!(await page.locator('#account-menu-panel.expanded').count())) await openAccountMenu(page);
  await page.click(button);
  await page.waitForSelector(dialog, { timeout: 10000 });
  await page.waitForTimeout(300);
  check((await hintVisibility()) === 'hidden', `${button}: the hint waits under the open leaf (${await hintVisibility()})`);
  await page.click(closeBtn);
  await page.waitForSelector(dialog, { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  check((await hintVisibility()) === 'visible', `${button}: the hint is back when the leaf is closed (${await hintVisibility()})`);
}
await finish(browser, { pass: pass && errors.length === 0, label: 'The walk hint waits under Friends and Settings leaves (#3913)', errors });
