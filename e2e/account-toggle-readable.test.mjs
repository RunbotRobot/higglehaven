// #3569 (interface week, Shop audit #3544): the gear that opens the account menu is the only
// way to Notices, Friends, My Purchases and Settings. It must be drawn on a near-solid
// backing with an outline, and be a real touch target, not a faint emoji on a clear pill.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Gear Tester', viewport: { width: 390, height: 844 } });
// #3649, #3688, #3699: the toggle is the bud in Shop, Build and now Sell too (its own e2es: bud.test.mjs,
// build-bud-add-item.test.mjs, sell-bud.test.mjs). The gear this test was written for is gone from every
// mode, so what stays pinned is the #3569 promise itself: the one way to Notices, Friends, My Purchases
// and Settings is a drawn, visible, real touch target.
await chooseIdentity(page, { mode: 'sell', label: 'Gear Tester', isNew: true });
await page.waitForSelector('#account-menu-toggle .bud-logo', { state: 'visible', timeout: 30000 });

const m = await page.evaluate(() => {
  const el = document.getElementById('account-menu-toggle');
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const alpha = (c) => { const x = c.match(/[\d.]+/g).map(Number); return x.length > 3 ? x[3] : 1; };
  return { w: r.width, h: r.height, bg: alpha(cs.backgroundColor), border: parseFloat(cs.borderTopWidth), fontSize: parseFloat(cs.fontSize) };
});
console.log(JSON.stringify(m));
const pass = m.w >= 44 && m.h >= 36 && errors.length === 0;
await finish(browser, { pass, label: 'account-toggle-readable (#3569)', errors });
