// #3754: the head on the flower mock-up page (/design-directions/flower.html). The owner chose
// option C (the solid green bud, logo in cream) after the page's Today/A/B/C/D buttons turned out
// not to work (the drawings are <svg>, and `hidden` is not a property of an SVGElement). The
// options are gone now; the page shows exactly one head, option C, and no picker.
import { launchPage, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ viewport: { width: 390, height: 844 } });
await page.goto(new URL('/design-directions/flower.html', page.url()).toString(), { waitUntil: 'networkidle' });
await page.waitForSelector('#head');

const row = await page.evaluate(() => {
  const arts = Array.prototype.slice.call(document.querySelectorAll('.head-art'));
  return {
    arts: arts.map((a) => a.dataset.head),
    shown: arts.filter((a) => getComputedStyle(a).display !== 'none').map((a) => a.dataset.head),
    picker: !!document.getElementById('head-picks'),
    options: Array.prototype.slice.call(document.querySelectorAll('.option')).map((o) => o.id),
  };
});
console.log(JSON.stringify(row));

const pass = row.arts.length === 1 && row.shown.length === 1 && row.shown[0] === 'c'
  && !row.picker && row.options.length === 1 && row.options[0] === 'opt-c'
  && errors.length === 0;
await finish(browser, { pass, label: 'design-flower-head (#3754)', errors });
