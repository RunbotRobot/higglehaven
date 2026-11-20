// #3754: the head options on the flower mock-up page (/design-directions/flower.html). The owner
// tapped Today/A/B/C/D and the picture never changed: the drawings are <svg>, and `hidden` is not
// a property of an SVGElement, so the script's assignment only made an expando. Tapping each
// option must show exactly that head (and no other) on a phone-size screen.
import { launchPage, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ viewport: { width: 390, height: 844 } });
await page.goto(new URL('/design-directions/flower.html', page.url()).toString(), { waitUntil: 'networkidle' });
await page.waitForSelector('#head-picks .pick');

const picks = await page.$$eval('#head-picks .pick', (els) => els.map((b) => b.dataset.pick));
const rows = [];
for (const pick of picks) {
  await page.click(`#head-picks .pick[data-pick="${pick}"]`, { force: true });
  rows.push(await page.evaluate((chosen) => {
    const arts = Array.prototype.slice.call(document.querySelectorAll('.head-art'));
    const shown = arts.filter((a) => getComputedStyle(a).display !== 'none').map((a) => a.dataset.head);
    const pressed = Array.prototype.slice.call(document.querySelectorAll('#head-picks .pick'))
      .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.pick);
    return { chosen, shown, pressed };
  }, pick));
}
console.log(JSON.stringify(rows));

const pass = picks.length >= 2
  && rows.every((r) => r.shown.length === 1 && r.shown[0] === r.chosen && r.pressed.length === 1 && r.pressed[0] === r.chosen)
  && errors.length === 0;
await finish(browser, { pass, label: 'design-flower-head-picks (#3754)', errors });
