// #3569 (interface week, Shop audit #3544): the gear that opens the account menu was a faint emoji on a
// clear pill, the only way to Notices, Friends, My Purchases and Settings. It had to be drawn on a
// near-solid backing with an outline, and be a real touch target.
// #3699 (Sell in the bud, 1/6): in every mode that toggle is the bud now (Shop #3649, Build #3688, Sell
// #3699; the gear is hidden everywhere), so what has to stay readable is the bud: a real touch target
// carrying the logo, in Sell as in the others. (This test waited for the gear in Sell, which went
// stale when Sell got its petals; it was red on main from then on.)
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Gear Tester', viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'sell', label: 'Gear Tester', isNew: true });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });
await page.waitForSelector('#account-menu-toggle .bud-logo', { state: 'visible', timeout: 30000 });

const m = await page.evaluate(() => {
  const el = document.getElementById('account-menu-toggle');
  const r = el.getBoundingClientRect();
  const gear = el.querySelector('.bud-gear');
  return { w: r.width, h: r.height, gearShown: Boolean(gear && gear.offsetParent !== null), label: el.getAttribute('aria-label') || el.textContent.trim() };
});
console.log(JSON.stringify(m));
const pass = m.w >= 44 && m.h >= 44 && !m.gearShown && m.label.length > 0 && errors.length === 0;
await finish(browser, { pass, label: 'account toggle is a readable touch target in Sell (#3569, now the bud)', errors });
