// #3780 (part of #3771): the lettering-styles page at /design-directions/wordmark.html. The owner opens
// it on their phone to choose which styles and colour pairs builders get for their lándlet's name, so it
// has to load clean under the site's enforcing CSP (fonts from the site itself only, no <style>
// element), show the same three names in each of seven styles with their own face actually loaded,
// fit a 390 px screen, and let a colour pair be tried on every style.
import { launchPage, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const res = await page.goto(new URL('/design-directions/wordmark.html', page.url()).toString(), { waitUntil: 'load' });
check(res?.status() === 200, `the page answers 200 (got ${res?.status()})`);
await page.evaluate(() => document.fonts.ready);

check(await page.locator('.card').count() === 7, 'seven styles are shown');
for (const card of await page.locator('.card').all()) {
  const id = await card.getAttribute('id');
  check(await card.locator('.wm-name').count() === 3, `${id}: shows the same three names`);
  const names = await card.locator('.wm-name').allTextContents();
  check(names.includes('Maple lándlet'), `${id}: the accent a shows in "Maple lándlet"`);
}

// Each style draws in its own face, and every face loaded (a missing file would silently fall back).
const faces = await page.evaluate(() => [...document.fonts].map((f) => ({ family: f.family, status: f.status })));
check(faces.length === 7 && faces.every((f) => f.status === 'loaded'), `all seven faces loaded: ${JSON.stringify(faces)}`);
const families = await page.evaluate(() => [...document.querySelectorAll('.card')].map((c) => getComputedStyle(c.querySelector('.wm-name')).fontFamily));
check(new Set(families).size === 7, `each style uses its own face: ${JSON.stringify(families)}`);

// The long name wraps rather than running off the screen or being cut.
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the page does not scroll sideways at phone width');
const longHeight = await page.evaluate(() => {
  const el = [...document.querySelectorAll('#style-round .wm-name')][1];
  return { h: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) };
});
check(longHeight.h > longHeight.line * 1.5, `the long name wraps onto a second line (${JSON.stringify(longHeight)})`);

// A colour pair is tried on every style at once.
const before = await page.evaluate(() => getComputedStyle(document.querySelector('#style-serif .wm-name')).color);
await page.click('.pair-btn[data-pair="berry"]');
const after = await page.evaluate(() => getComputedStyle(document.querySelector('#style-serif .wm-name')).color);
check(before !== after && after === 'rgb(138, 36, 80)', `tapping Berry recolours the names (${before} -> ${after})`);
check(await page.locator('.pair-btn[aria-pressed="true"]').count() === 1, 'exactly one colour pair is marked chosen');

// The licences for the bundled faces are served next to them.
const licences = await page.request.get(new URL('/design-directions/wordmark-fonts/LICENSES.txt', page.url()).toString());
check(licences.status() === 200 && (await licences.text()).includes('SIL OPEN FONT LICENSE'), 'the font licences are served with the faces');
check(await page.locator('style').count() === 0, 'the page uses no <style> element (the policy refuses it)');

await finish(browser, { pass, label: '#3780: the lettering-styles page loads under the site policy, shows seven styles with their own faces, and tries a colour pair on all', errors });
