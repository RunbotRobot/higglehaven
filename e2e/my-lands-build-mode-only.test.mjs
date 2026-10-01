// Regression test for #1167 (owner direction, 2026-10-01): My Lands
// shipped in #1150/PR #1160 as a row in the global account menu
// (#my-lands-btn), which is shared across every mode -- nothing ever
// gated its visibility on currentMode, so it showed in Shop and Sell too,
// not just Build as the owner wanted. Fixed by toggling myLandsBtn.hidden
// alongside the account menu's other mode-conditional rows
// (accountMenuLandCapEl), recomputed each time the menu is opened.
//
// Verified here across all three modes in one session (no page reload
// between Shop and Build, since claimLandlet already lands on Build) --
// the button must be hidden in Shop, visible in Build, and hidden again
// in Sell.
import {
  launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish,
} from './helpers.mjs';

const LABEL = 'My Lands Mode Gate Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await openAccountMenu(page);
const visibleInShop = await page.locator('#my-lands-btn').isVisible();
console.log('My Lands visible in Shop mode (should be false):', visibleInShop);
// Collapse the menu again before switching modes, the same way a real
// user clicking elsewhere (or the mode-nav tab) would.
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel:not(.expanded)', { state: 'attached', timeout: 5000 });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: false });
await claimLandlet(page);
await openAccountMenu(page);
const visibleInBuild = await page.locator('#my-lands-btn').isVisible();
console.log('My Lands visible in Build mode (should be true):', visibleInBuild);
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel:not(.expanded)', { state: 'attached', timeout: 5000 });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: false });
await openAccountMenu(page);
const visibleInSell = await page.locator('#my-lands-btn').isVisible();
console.log('My Lands visible in Sell mode (should be false):', visibleInSell);

const pass = !visibleInShop && visibleInBuild && !visibleInSell && errors.length === 0;
await finish(browser, { pass, label: 'My Lands only shows in the account menu while in Build mode (#1167)', errors });
