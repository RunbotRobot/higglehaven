// #3657: the first-visit hints, end to end on a phone: in the air the first words are about flying, each
// gesture the person makes retires its hint and brings the next, the last one leaves nothing on screen, and
// the device remembers so a reload shows none. The ordering and the wording are unit-tested
// (src/ui/firstVisitHints.test.js); this proves the page wires them (the world-gesture event, the stored
// "done", the hint node) so that a hint that is missing or stays would fail here.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Hints Sequence';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
// Hints are for real people's pointers, so report the page as not automated as the neighbouring hint test does.
// (The test browser has a fine pointer, so the words are the keyboard's; the order is the same.)
await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
await page.reload({ waitUntil: 'networkidle' });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 20000 });

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const hint = () => page.evaluate(() => {
  const el = document.getElementById('world-hint');
  return { text: el?.textContent ?? '', visible: !!el && el.classList.contains('visible') };
});
const gesture = (kind) => page.evaluate((k) => window.dispatchEvent(new CustomEvent('higglehaven:world-gesture', { detail: { kind: k } })), kind);

await page.waitForSelector('#world-hint.visible', { timeout: 20000 });
const first = await hint();
console.log('first hint:', JSON.stringify(first));
check(/fly/i.test(first.text), `the first words are about flying (${first.text})`);

await gesture('walk');
await page.waitForTimeout(200);
const second = await hint();
console.log('after walking:', JSON.stringify(second));
check(second.visible && /look around/i.test(second.text), `after the person moves, the next hint is about looking (${second.text})`);

await gesture('look');
await page.waitForTimeout(200);
const third = await hint();
console.log('after looking:', JSON.stringify(third));
// In the air the last hint is about coming down (the double-tap, or T on a keyboard).
check(third.visible && /double-tap|press t/i.test(third.text), `after looking, the last hint is about the take-off and landing key (${third.text})`);

await gesture('fly');
await page.waitForTimeout(200);
const last = await hint();
console.log('after the last gesture:', JSON.stringify(last));
check(!last.visible, 'no hint stays on screen after the last gesture');
const remembered = await page.evaluate(() => localStorage.getItem('higglehaven.firstHints.done'));
check(remembered === '1', `the device remembers the hints are done (${remembered})`);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.shop-ready', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
const again = await hint();
check(!again.visible, `a reload shows no hint again (${JSON.stringify(again)})`);

await finish(browser, { pass: pass && errors.length === 0, label: 'First-visit hints advance with each gesture, end, and are remembered (#3657)', errors });
