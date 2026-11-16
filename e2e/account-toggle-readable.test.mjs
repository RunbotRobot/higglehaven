// #3569 (interface week, Shop audit #3544): the gear that opens the account menu is the only
// way to Notices, Friends, My Purchases and Settings. It must be drawn on a near-solid
// backing with an outline, and be a real touch target, not a faint emoji on a clear pill.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Gear Tester', viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'shop', label: 'Gear Tester', isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 20000 });

const m = await page.evaluate(() => {
  const el = document.getElementById('account-menu-toggle');
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const alpha = (c) => { const x = c.match(/[\d.]+/g).map(Number); return x.length > 3 ? x[3] : 1; };
  return { w: r.width, h: r.height, bg: alpha(cs.backgroundColor), border: parseFloat(cs.borderTopWidth), fontSize: parseFloat(cs.fontSize) };
});
console.log(JSON.stringify(m));
const pass = m.w >= 44 && m.h >= 36 && m.bg >= 0.9 && m.border >= 1 && m.fontSize >= 16 && errors.length === 0;
await finish(browser, { pass, label: 'account-toggle-readable (#3569)', errors });
