// #3569 (interface week, Shop audit #3544): the control that opens the account menu is the only
// way to Notices, Friends, My Purchases and Settings, so it must be a real touch target a person
// can find on any ground. It was a gear on a pill; the bud is that control now in every mode
// (Shop #3649, Build #3688, Sell #3712). Their own e2es cover what the bud does (bud.test.mjs,
// build-bud-add-item.test.mjs, sell-bud.test.mjs); this one keeps the original promise, that the
// toggle itself is large enough to hit and shows the bud's logo, not the old faint emoji.
// #3726: this test waited for the gear in Sell, which #3712 removed, and was red on main.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Gear Tester', viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'sell', label: 'Gear Tester', isNew: true });
await page.waitForSelector('body[data-mode="sell"][data-bud="on"]', { timeout: 30000 });
await page.waitForSelector('#account-menu-toggle .bud-logo', { state: 'visible', timeout: 30000 });

const m = await page.evaluate(() => {
  const el = document.getElementById('account-menu-toggle');
  const r = el.getBoundingClientRect();
  const gear = el.querySelector('.bud-gear');
  return { w: r.width, h: r.height, gearShown: !!gear && getComputedStyle(gear).display !== 'none', onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
});
console.log(JSON.stringify(m));
const pass = m.w >= 44 && m.h >= 44 && !m.gearShown && m.onScreen && errors.length === 0;
await finish(browser, { pass, label: 'account-toggle-readable (#3569, #3726): the bud toggle is a real touch target in Sell', errors });
