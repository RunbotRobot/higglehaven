// Regression test for #539 (part of #538's Sell-mode-as-its-own-section
// tracking issue): the owner reported "This change will open up the
// ability to access the menu from Sell mode, which is currently not
// possible." Root cause: #topbar-left (wordmark + account-menu-toggle)
// sat below every full-viewport action modal's z-index, so the Seller
// modal's own full-viewport backdrop always covered it. Fixed by raising
// #topbar-left above that tier (see its own CSS comment for the full
// reasoning) — this test proves it's not just visually on top but
// actually clickable/interactive while Sell is open, since Playwright's
// own actionability checks fail a click on an element another one is
// covering.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Menu From Sell Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

// The real proof: clicking the toggle while Sell is open actually expands
// the panel (openAccountMenu's own waitForSelector would time out here
// pre-fix, since the click never lands on the covered toggle).
await openAccountMenu(page);
const panelExpandedOverSell = await page.locator('#account-menu-panel.expanded').count();
console.log('account menu panel expands while Sell modal is open (should be 1):', panelExpandedOverSell);

// And a row inside it is genuinely reachable too, not just the toggle —
// Settings should open on top of everything, Seller modal included.
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
const settingsOpenedOverSell = await page.locator('#settings-modal.visible').count();
console.log('Settings modal opens on top of the Seller modal (should be 1):', settingsOpenedOverSell);

await page.click('#settings-close-btn');
await page.waitForTimeout(300);

// My products is a bud leaf (#3701) and stays open behind what is opened from the bud (#3626, #3721:
// it fades, it does not fold), so closing Settings leaves Sell exactly as it was: the list still open.
const sellerStillOpen = await page.locator('#seller-modal.visible').count();
console.log('My products still open behind the bud after Settings (should be 1):', sellerStillOpen);

const pass = panelExpandedOverSell === 1 && settingsOpenedOverSell === 1 && sellerStillOpen === 1 &&
  errors.length === 0;
await finish(browser, { pass, label: '#539: the account menu (and modals opened from it) stay reachable while Sell mode is open', errors });
