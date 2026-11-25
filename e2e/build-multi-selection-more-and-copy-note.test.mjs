// #4336 (from the #4275 walk): with two items selected, More no longer draws Community sign, Community calendar
// and Backup chain greyed out (a control a person can only be refused is left out, #3574); they are back
// for one item. And Copy's "Copied N items" is seen: at phone width it sits at 84 px, below the head and any
// note beside it, and nothing covers it (the walk's stills showed nothing; this could not reproduce that, so
// it stays as the check that it keeps showing). 390x844.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Multi More Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}
const title = () => page.textContent('#item-card-name');
const singleOnlyHidden = () => page.evaluate(() => ['toggle-community-sign', 'toggle-community-calendar', 'toggle-backup-chain']
  .map((id) => document.getElementById(id).hidden));

await placeTreeAt(120, 420);
await placeTreeAt(220, 420);
await page.mouse.click(60, 600);
await page.waitForTimeout(300);
const [posA, posB] = await page.evaluate(() => window.__testProductScreenPositions());

// One item: the three are offered.
await page.mouse.click(posA.x, posA.y);
await page.waitForTimeout(500);
await page.click('#item-card-more-btn');
await page.waitForTimeout(300);
const one = await singleOnlyHidden();
check(one.every((hidden) => hidden === false), `one item selected: Community sign, Community calendar and Backup chain are offered (hidden: ${one})`);
await page.mouse.click(60, 600);
await page.waitForTimeout(300);

// Two items: they are left out, not greyed.
await page.click('#toggle-multiselect');
await page.waitForTimeout(300);
await page.mouse.move(posA.x, posA.y);
await page.mouse.down();
await page.mouse.move(posB.x, posB.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
check((await title()).includes('2 items selected'), `two items are selected (${await title()})`);
if (!(await page.isVisible('#toggle-community-sign'))) await page.click('#item-card-more-btn').catch(() => {});
const two = await singleOnlyHidden();
check(two.every((hidden) => hidden === true), `two items selected: the three are left out (hidden: ${two})`);

// Copy says so where it can be seen, also while a note beside the head shows (stood in for by the body
// attribute the real one sets).
// (Selecting is switched off first: while it is on the card lets touches through to the world.)
await page.click('#toggle-multiselect');
await page.waitForTimeout(500);
const copyState = await page.evaluate(() => { const b = document.getElementById('copy-item'); const r = b.getBoundingClientRect(); return { disabled: b.disabled, w: r.width, h: r.height, pe: getComputedStyle(b).pointerEvents, card: document.getElementById('item-card').hidden, held: document.getElementById('item-card').dataset.held }; });
console.log('copy button state before Copy:', JSON.stringify(copyState));
await page.evaluate(() => document.body.setAttribute('data-bud-note', 'friend-requests'));
await page.waitForTimeout(400);
await page.click('#copy-item');
await page.waitForTimeout(300);
const pill = await page.evaluate(() => {
  const el = document.getElementById('product-info');
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { text: el.textContent, hidden: el.hidden, top: r.top, left: r.left, width: r.width, height: r.height, coveredBy: hit && !el.contains(hit) ? (hit.id || hit.className || hit.tagName) : null };
});
console.log('the Copy confirmation:', JSON.stringify(pill));
check(!pill.hidden && /Copied 2 items/.test(pill.text), `Copy confirms (${JSON.stringify(pill)})`);
check(pill.coveredBy === null, `nothing covers the confirmation (${pill.coveredBy})`);

await finish(browser, { pass, label: '#4336: More leaves out what two items cannot use, and Copy is seen under a head note', errors: errors.filter((e) => !e.includes('Failed to load resource')) });
