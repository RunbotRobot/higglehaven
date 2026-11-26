// #4408 (regression guard, from the #4493 audit): the stem's lower end is a rounded tip in every frame, growing and
// folding included. That is two facts about the stem's path: a round line cap, and a dash gap wider than the path so no
// zero-length dash is left at the far end (a round cap on one would draw a dot). The fix was CSS only and shipped with
// no test; this reads the computed style of every stem path with the flower open and again mid-fold.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'StemTipTester', viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
await chooseIdentity(page, { mode: 'shop', label: 'StemTipTester', isNew: true });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });
await page.waitForTimeout(1500);

const stemStyle = () => page.evaluate(() => [...document.querySelectorAll('#bud-stem path')].map((p) => {
  const s = getComputedStyle(p);
  return { cap: s.strokeLinecap, dash: s.strokeDasharray };
}));

await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded');
await page.waitForTimeout(900);
const open = await stemStyle();
check(open.length >= 1, 'the open flower has a stem path');
check(open.every((p) => p.cap === 'round'), `every stem path has a round line cap (${JSON.stringify(open)})`);
// "1 2": a dash of 1 (the whole normalised path) then a gap of 2, so the gap is always wider than the path.
check(open.every((p) => /^1(px)?[ ,]+2(px)?$/.test(p.dash.trim())), `the dash gap is wider than the path (${JSON.stringify(open)})`);

await page.click('#account-menu-toggle'); // folds it
await page.waitForTimeout(120);
const folding = await stemStyle();
check(folding.every((p) => p.cap === 'round' && /^1(px)?[ ,]+2(px)?$/.test(p.dash.trim())), `the same holds while it folds (${JSON.stringify(folding)})`);

await finish(browser, { pass, label: '#4408: the flower\'s stem has a rounded tip, open and folding', errors });
