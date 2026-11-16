// #3639: with Multi-Select on, the Brush row widened the bottom-left panel and
// stretched "+ Add Item" over most of the Ground pill, so tapping the pill's
// middle or left side hit the panel and did nothing. The pill must be what a
// tap at its left end, centre and right end lands on, with Multi-Select off and on.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Ground Pill Tap Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

const hits = () => page.evaluate(() => {
  const r = document.getElementById('level-menu-toggle').getBoundingClientRect();
  const y = r.top + r.height / 2;
  const at = (x) => {
    const el = document.elementFromPoint(x, y);
    return el ? (el.closest('#level-menu-toggle') ? 'pill' : (el.id || el.tagName)) : null;
  };
  return { left: at(r.left + 6), centre: at(r.left + r.width / 2), right: at(r.right - 6), width: Math.round(r.width) };
});

const off = await hits();
await page.click('#toggle-multiselect');
await page.waitForSelector('#multiselect-brush-control.visible', { timeout: 5000 });
await page.waitForTimeout(300);
const on = await hits();
console.log('Multi-Select off:', JSON.stringify(off));
console.log('Multi-Select on: ', JSON.stringify(on));

const allPill = (h) => h.left === 'pill' && h.centre === 'pill' && h.right === 'pill';
const pass = allPill(off) && allPill(on) &&
  errors.filter((e) => !e.includes('Failed to load resource')).length === 0;
await finish(browser, { pass, label: 'The Ground pill is tappable at its left end, centre and right end with Multi-Select off and on (#3639)', errors });
