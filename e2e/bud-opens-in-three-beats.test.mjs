// #4027 (part of #3759, the flower): the flower grows in three overlapping beats in about half a second: the
// petals and the top row form, then the stem draws down from the head, then the leaves unfurl top to bottom.
// Nothing waits on it: a leaf pressed the moment it is on screen is never refused, and a second press on the head
// during the opening folds it. Under reduced motion it opens at once.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Beats Tester', viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
await chooseIdentity(page, { mode: 'shop', label: 'Beats Tester', isNew: true });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });
await page.waitForTimeout(1500);

// The timing of every animation the opening starts, in ms from the press (delay included).
const timings = async () => page.evaluate(() => document.getAnimations()
  .filter((a) => /bud-grow|bud-unfold|bud-stem-grow|bud-row-grow/.test(a.animationName || ''))
  .map((a) => {
    const t = a.effect.getComputedTiming();
    const el = a.effect.target;
    const kind = el.closest?.('#bud-stem') ? 'stem' : el.closest?.('#bud-modes') ? 'petal' : el.closest?.('#bud-row') ? 'row' : el.closest?.('#account-menu-panel') ? 'leaf' : 'other';
    return { kind, start: t.delay, end: t.endTime };
  }));

await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded');
const list = await timings();
const by = (k) => list.filter((e) => e.kind === k);
console.log('beats:', JSON.stringify(Object.fromEntries(['petal', 'row', 'stem', 'leaf'].map((k) => [k, [Math.min(...by(k).map((e) => e.start)), Math.max(...by(k).map((e) => e.end))]]))));
check(by('petal').length === 3 && by('row').length >= 3 && by('stem').length >= 1 && by('leaf').length >= 3, `petals, row, stem and leaves all grow (${list.map((e) => e.kind).join()})`);
const firstStart = (k) => Math.min(...by(k).map((e) => e.start));
const lastEnd = (k) => Math.max(...by(k).map((e) => e.end));
check(firstStart('petal') <= 1 && firstStart('row') <= 1, 'the petals and the top row start at once');
check(firstStart('stem') > firstStart('petal') && firstStart('stem') < lastEnd('petal'), 'the stem starts after the petals begin and before they are done (the beats overlap)');
check(firstStart('leaf') > firstStart('stem') && firstStart('leaf') < lastEnd('stem'), 'the leaves start after the stem begins and before it is done');
// #4038: the row items grow out of the head left to right, each from the head's centre line.
const rowStarts = by('row').map((e) => e.start);
check(rowStarts.length >= 3 && rowStarts.every((x, i) => i === 0 || x > rowStarts[i - 1]), `the row items grow one after another, left to right (${rowStarts})`);
const pulls = await page.evaluate(() => [...document.querySelectorAll('#bud-row button')].filter((b) => !b.hidden).map((b) => parseFloat(b.style.getPropertyValue('--row-pull'))));
check(pulls.length >= 3 && pulls.every((x) => x < 0) && pulls.every((x, i) => i === 0 || x < pulls[i - 1]), `each row item travels from the head's centre line, the further ones further (${pulls})`);
const starts = by('leaf').map((e) => e.start).sort((a, b) => a - b);
check(starts.every((s, i) => i === 0 || s > starts[i - 1]), 'the leaves unfurl one after another, top to bottom');
const total = Math.max(...list.map((e) => e.end));
console.log('total opening (ms):', total);
check(total <= 560, `the whole opening is about half a second (${total} ms)`);

// A leaf pressed the moment the opening begins is not refused (pointer events are never withheld).
await page.click('#account-menu-toggle'); // fold again
await page.waitForFunction(() => !document.getElementById('account-menu-panel').classList.contains('expanded'), null, { timeout: 5000 });
await page.waitForTimeout(900);
await page.click('#account-menu-toggle');
const opened = await page.evaluate(async () => {
  const leaf = document.getElementById('my-purchases-btn');
  const style = getComputedStyle(leaf);
  return { pointer: style.pointerEvents, display: style.display };
});
check(opened.pointer !== 'none' && opened.display !== 'none', `a leaf takes presses from the first frame (${JSON.stringify(opened)})`);
await page.click('#my-purchases-btn', { timeout: 3000 });
check((await page.locator('#bud-leaf-purchases, #purchases-modal.visible').count()) >= 0, 'pressed');

// A second press on the head during the opening folds it.
await page.waitForTimeout(600);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(700);
await page.click('#account-menu-toggle');
await page.waitForTimeout(120);
await page.click('#account-menu-toggle');
const folded = await page.waitForFunction(() => !document.getElementById('account-menu-panel').classList.contains('expanded'), null, { timeout: 3000 }).then(() => true, () => false);
check(folded, 'a second press on the head in the middle of the opening folds it');

// Reduced motion: everything is there at once.
await page.waitForTimeout(900);
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded');
const slow = (await timings()).filter((e) => e.end > 200);
check(slow.length === 0, `under reduced motion nothing takes long (${JSON.stringify(slow)})`);

await finish(browser, { pass, label: '#4027: the flower opens in three overlapping beats in about half a second, never refuses a press, and opens at once under reduced motion', errors });
