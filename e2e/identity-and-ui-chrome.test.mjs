// Regression coverage for modal chrome that's still relevant after real
// login (docs/API.md's "Authentication") replaced the old dev-mode
// identity picker: the Sell nav's active-immediately/reverts-on-cancel
// behavior, X-close buttons on modals, the Add Item catalog picker's
// opaque background and hint-hiding, and the pale-green-pill vs
// pale-yellow-panel color split. The old picker's own mechanics (rows
// collapsed until tapped, a contextual choose-button label, "+ New
// identity") no longer exist — Build/Sell entry is a real signup/login
// form now, not a list to pick from.
import { launchPage, openAccountMenu, growWorldAsAdmin, finish } from './helpers.mjs';

const LABEL = 'Chrome Suite Tester';
const EMAIL = `chrome-suite-${Date.now()}@e2e.test`;
const PASSWORD = 'e2e-test-password-123';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// --- Sell nav: active immediately, real login wall shown (#88, #89) ---
await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForSelector('#auth-modal.visible', { timeout: 10000 });
const sellNavActiveImmediately = await page.locator('.mode-nav-btn[data-mode="sell"]').evaluate((el) => el.classList.contains('active'));
console.log('Sell nav active immediately on click (should be true):', sellNavActiveImmediately);
const closeBtnVisible = await page.locator('#auth-close-btn').isVisible();
console.log('Close button visible on the login wall (should be true):', closeBtnVisible);

// --- Cancel out entirely: back to Shop, nav no longer stuck active (#88) ---
await page.click('#auth-close-btn');
await page.waitForTimeout(500);
const modalGoneAfterCancel = await page.locator('#auth-modal.visible').count();
const sellNavActiveAfterCancel = await page.locator('.mode-nav-btn[data-mode="sell"]').evaluate((el) => el.classList.contains('active'));
const sellerModalOpenedAfterCancel = await page.locator('#seller-modal.visible').count();
console.log('auth modal closed after Cancel (should be 0):', modalGoneAfterCancel);
console.log('Sell nav no longer stuck active after cancel (should be false):', sellNavActiveAfterCancel);
console.log('seller modal did not open after cancel (should be 0):', sellerModalOpenedAfterCancel);

// --- Re-open, actually sign up this time -> Upload Model lives in Seller modal (#90) ---
await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForSelector('#auth-modal.visible', { timeout: 10000 });
await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-name', LABEL);
await page.fill('#auth-signup-email', EMAIL);
await page.fill('#auth-signup-password', PASSWORD);
await page.click('#auth-signup-form button[type="submit"]');
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
const uploadBtnInSeller = await page.locator('#seller-modal #upload-model-btn').count();
console.log('Upload Model button lives inside Seller modal (should be 1):', uploadBtnInSeller);

// --- X-close buttons exist on every modal that has one, and open/close it (#98) ---
const sellerCloseIsX = await page.locator('#seller-close-btn').evaluate((el) => el.classList.contains('modal-close-btn') && el.textContent.includes('×'));
console.log('Seller modal close is an X button (should be true):', sellerCloseIsX);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
const settingsCloseIsX = await page.locator('#settings-close-btn').evaluate((el) => el.classList.contains('modal-close-btn') && el.textContent.includes('×'));
console.log('Settings modal close is an X button (should be true):', settingsCloseIsX);
await page.click('#settings-close-btn');
await page.waitForTimeout(300);

// --- Catalog picker: opaque background, hides product-info while open (#96, #97) ---
// Already logged in from the Sell signup above — entering Build mode now
// resolves the same account's builder profile silently, no login prompt.
await page.click('.mode-nav-btn[data-mode="build"]');
await page.waitForSelector('#claim-modal.visible', { timeout: 10000 });
await page.waitForTimeout(2000);
const claimStatus = await page.textContent('#claim-status');
if (claimStatus?.includes('check back again shortly')) {
  await growWorldAsAdmin();
  await page.click('#claim-refresh-btn');
  await page.waitForTimeout(2000);
}
const canvasBox = await page.locator('#claim-map-canvas').boundingBox();
for (const [fx, fy] of [[0.5, 0.5], [0.4, 0.4], [0.4, 0.3], [0.5, 0.3], [0.2, 0.4], [0.1, 0.4]]) {
  await page.mouse.click(canvasBox.x + canvasBox.width * fx, canvasBox.y + canvasBox.height * fy);
  await page.waitForTimeout(250);
  const selection = await page.textContent('#claim-selection-name');
  if (selection && selection.includes('Available')) break;
}
await page.click('#claim-confirm-btn');
await page.waitForTimeout(2500);
await page.waitForSelector('#account-menu-toggle', { timeout: 10000 });

// #product-info no longer shows an idle "Tap a product to inspect it"
// hint (removed — permanent screen space spent stating the obvious), so
// there's nothing to hide/reveal here unless something's actually
// selected first. Place and select a Tree to get it showing real content.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

const hintVisibleBeforePicker = await page.locator('#product-info').isVisible();
const hintTextBeforePicker = await page.textContent('#product-info');
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
const hintHiddenWhilePickerOpen = await page.locator('#product-info').isHidden();
console.log('product-info visible before reopening Add Item, showing the placed Tree (should be true):', hintVisibleBeforePicker, hintTextBeforePicker);
console.log('product-info hidden while catalog picker is open (should be true):', hintHiddenWhilePickerOpen);

const pickerBg = await page.locator('#catalog-picker').evaluate((el) => getComputedStyle(el).backgroundColor);
console.log('catalog picker background (should be near-opaque, alpha close to 1):', pickerBg);
const pickerOpaque = /,\s*0?\.9\d*\s*\)/.test(pickerBg) || /,\s*1\s*\)/.test(pickerBg) || !pickerBg.includes(',');

await page.locator('#catalog-picker-close-btn').click();
await page.waitForTimeout(300);
const hintVisibleAfterClosingPicker = await page.locator('#product-info').isVisible();
console.log('product-info visible again after closing catalog picker (should be true):', hintVisibleAfterClosingPicker);

// --- Pale-green pill vs pale-yellow panel color split: the two token
// buckets should resolve to genuinely different, non-default values, not
// just be unset. Both are pale/bright now (docs/SPEC.md §1's "Visual
// brand direction") — this used to check pale-pill-vs-dark-panel, before
// the dialogs' own dark background was replaced for reading too heavy/
// ominous. ---
const pillRgb = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pill-rgb').trim());
const panelRgb = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--panel-rgb').trim());
console.log('--pill-rgb (should be the pale green, "214 232 190"):', pillRgb);
console.log('--panel-rgb (should be the pale yellow, "250 240 199"):', panelRgb);

const pass = sellNavActiveImmediately && closeBtnVisible &&
  modalGoneAfterCancel === 0 && !sellNavActiveAfterCancel && sellerModalOpenedAfterCancel === 0 &&
  uploadBtnInSeller === 1 && sellerCloseIsX && settingsCloseIsX &&
  hintVisibleBeforePicker && hintTextBeforePicker.includes('Tree') && hintHiddenWhilePickerOpen &&
  pickerOpaque && hintVisibleAfterClosingPicker &&
  pillRgb === '214 232 190' && panelRgb === '250 240 199' &&
  errors.length === 0;
await finish(browser, { pass, label: 'real login wall + modal chrome + catalog picker UI', errors });
