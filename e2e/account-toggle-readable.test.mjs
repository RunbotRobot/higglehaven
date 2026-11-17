// #3569 (interface week, Shop audit #3544): the gear that opens the account menu is the only
// way to Notices, Friends, My Purchases and Settings. It must be drawn on a near-solid
// backing with an outline, and be a real touch target, not a faint emoji on a clear pill.
// #3649, #3688, #3699: in Shop, Build and Sell the toggle is the bud (its own e2es: bud.test.mjs,
// build-bud-add-item.test.mjs, sell-bud.test.mjs), a round 56px control carrying the logo that
// replaced the gear and its near-solid pill (the owner chose the bud's look, direction C). What is
// still true of the way into Notices, Friends, My Purchases and Settings: it is a real touch
// target and it is drawn, not a faint glyph. Checked here in Sell, the last mode to get the bud.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Gear Tester', viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'sell', label: 'Gear Tester', isNew: true });
await page.waitForSelector('body[data-bud="on"] #account-menu-toggle .bud-logo', { state: 'visible', timeout: 30000 });

const m = await page.evaluate(() => {
  const el = document.getElementById('account-menu-toggle');
  const r = el.getBoundingClientRect();
  const logo = el.querySelector('.bud-logo').getBoundingClientRect();
  return { w: r.width, h: r.height, logoW: logo.width, gear: getComputedStyle(el.querySelector('.bud-gear')).display };
});
console.log(JSON.stringify(m));
const pass = m.w >= 44 && m.h >= 44 && m.logoW >= 24 && m.gear === 'none' && errors.length === 0;
await finish(browser, { pass, label: 'account-toggle-readable (#3569, the bud)', errors });
