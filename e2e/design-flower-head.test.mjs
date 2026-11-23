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
// #4032: the page shows the shape of #4025: three petals (no Menu petal), a row of four icons beside the head,
// and the open place's own stem; one tap on the head opens all of it together.
await page.click('#head');
await page.waitForTimeout(1200);
const shape = await page.evaluate(() => {
  const visible = (el) => getComputedStyle(el).opacity === '1';
  const stem = document.querySelector('.stem.on');
  return {
    petals: Array.prototype.slice.call(document.querySelectorAll('.petal')).map((p) => p.dataset.petal),
    petalsShown: Array.prototype.slice.call(document.querySelectorAll('.petal')).filter(visible).length,
    row: Array.prototype.slice.call(document.querySelectorAll('.top')).filter(visible).map((t) => t.textContent.trim()),
    stem: stem ? stem.dataset.stem : null,
    leaves: stem ? Array.prototype.slice.call(stem.querySelectorAll('.leaf')).map((l) => l.textContent.trim()) : [],
    menuStem: !!document.querySelector('[data-stem="menu"]'),
  };
});
console.log(JSON.stringify(row), JSON.stringify(shape));

const pass = row.arts.length === 1 && row.shown.length === 1 && row.shown[0] === 'c'
  && !row.picker && row.options.length === 1 && row.options[0] === 'opt-c'
  && shape.petals.join() === 'shop,build,sell' && shape.petalsShown === 3
  && shape.row.join() === 'You,Notices,Settings,Help' && shape.stem === 'shop'
  && shape.leaves.join() === 'Friends,Purchases,Chat,Nearby' && !shape.menuStem
  && errors.length === 0;
await finish(browser, { pass, label: 'design-flower-head (#3754, #4032)', errors });
