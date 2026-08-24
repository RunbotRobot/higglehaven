// Regression coverage for the UI-chrome redesign work (tasks #87-102): the
// identity picker's collapse-until-tapped rows and selected-row highlight,
// contextual Build/Sell button labels, the Cancel path back out of "Choose
// a seller," X-close buttons on modals, the Add Item catalog picker's
// opaque background and hint-hiding, and the pale-pill vs dark-panel color
// split.
import { launchPage, finish } from './helpers.mjs';

const LABEL = 'Chrome Suite Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// --- Sell nav: active immediately, Close button visible right away (#88, #89) ---
await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForSelector('#identity-modal.visible', { timeout: 10000 });
const sellNavActiveImmediately = await page.locator('.mode-nav-btn[data-mode="sell"]').evaluate((el) => el.classList.contains('active'));
console.log('Sell nav active immediately on click (should be true):', sellNavActiveImmediately);
const closeBtnVisible = await page.locator('#identity-close-btn').isVisible();
console.log('Close button visible in "Choose a seller" (should be true):', closeBtnVisible);

// --- Identity row: collapsed until tapped, highlighted once expanded (#87, #100) ---
await page.click('#identity-new-btn');
await page.waitForTimeout(500);
const row = () => page.locator('.identity-row').filter({ hasText: LABEL });
const actionsVisibleBefore = await row().locator('.identity-row-actions').isVisible();
console.log('row actions hidden before tapping (should be false):', actionsVisibleBefore);
const expandedBeforeTap = await row().last().evaluate((el) => el.classList.contains('expanded'));
await row().locator('.identity-row-toggle').last().click();
await page.waitForTimeout(300);
const actionsVisibleAfter = await row().locator('.identity-row-actions').isVisible();
const expandedAfterTap = await row().last().evaluate((el) => el.classList.contains('expanded'));
console.log('row actions visible after tapping (should be true):', actionsVisibleAfter);
console.log('row expanded/highlighted after tapping (should be true):', expandedAfterTap);

// --- Contextual choose-button label reads "Sell" here, not "Play" (#101) ---
const chooseLabel = await row().locator('.identity-choose-btn').last().textContent();
console.log('choose button label on the seller picker (should be "Sell"):', chooseLabel);

// --- Cancel out entirely: back to Shop, nav no longer stuck active (#88) ---
await page.click('#identity-close-btn');
await page.waitForTimeout(500);
const modalGoneAfterCancel = await page.locator('#identity-modal.visible').count();
const sellNavActiveAfterCancel = await page.locator('.mode-nav-btn[data-mode="sell"]').evaluate((el) => el.classList.contains('active'));
const sellerModalOpenedAfterCancel = await page.locator('#seller-modal.visible').count();
console.log('identity modal closed after Cancel (should be 0):', modalGoneAfterCancel);
console.log('Sell nav no longer stuck active after cancel (should be false):', sellNavActiveAfterCancel);
console.log('seller modal did not open after cancel (should be 0):', sellerModalOpenedAfterCancel);

// --- Re-open, actually choose this time -> Upload Model lives in Seller modal (#90) ---
await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForSelector('#identity-modal.visible', { timeout: 10000 });
await row().locator('.identity-row-toggle').last().click();
await page.waitForTimeout(300);
await row().locator('.identity-choose-btn').last().click();
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
const uploadBtnInSeller = await page.locator('#seller-modal #upload-model-btn').count();
console.log('Upload Model button lives inside Seller modal (should be 1):', uploadBtnInSeller);

// --- X-close buttons exist on every modal that has one, and open/close it (#98) ---
const sellerCloseIsX = await page.locator('#seller-close-btn').evaluate((el) => el.classList.contains('modal-close-btn') && el.textContent.includes('×'));
console.log('Seller modal close is an X button (should be true):', sellerCloseIsX);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
const settingsCloseIsX = await page.locator('#settings-close-btn').evaluate((el) => el.classList.contains('modal-close-btn') && el.textContent.includes('×'));
console.log('Settings modal close is an X button (should be true):', settingsCloseIsX);
await page.click('#settings-close-btn');
await page.waitForTimeout(300);

// --- Catalog picker: opaque background, hides the "Tap a product" hint while open (#96, #97) ---
await page.click('.mode-nav-btn[data-mode="build"]');
await page.waitForSelector('#identity-modal.visible', { timeout: 10000 });
await page.click('#identity-new-btn');
await page.waitForTimeout(500);
const buildRow = page.locator('.identity-row').filter({ hasText: LABEL });
await buildRow.locator('.identity-row-toggle').last().click();
await page.waitForTimeout(300);
await buildRow.locator('.identity-choose-btn').last().click();
await page.waitForSelector('#claim-modal.visible', { timeout: 10000 });
await page.waitForTimeout(2000);
const claimStatus = await page.textContent('#claim-status');
if (claimStatus?.includes("hasn't grown")) {
  await page.click('#claim-grow-btn');
  await page.waitForTimeout(3000);
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
await page.waitForSelector('#identity-btn', { timeout: 10000 });

const hintVisibleBeforePicker = await page.locator('#product-info').isVisible();
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
const hintHiddenWhilePickerOpen = await page.locator('#product-info').isHidden();
console.log('hint visible before opening Add Item (should be true):', hintVisibleBeforePicker);
console.log('hint hidden while catalog picker is open (should be true):', hintHiddenWhilePickerOpen);

const pickerBg = await page.locator('#catalog-picker').evaluate((el) => getComputedStyle(el).backgroundColor);
console.log('catalog picker background (should be near-opaque, alpha close to 1):', pickerBg);
const pickerOpaque = /,\s*0?\.9\d*\s*\)/.test(pickerBg) || /,\s*1\s*\)/.test(pickerBg) || !pickerBg.includes(',');

await page.locator('#catalog-picker-close-btn').click();
await page.waitForTimeout(300);
const hintVisibleAfterClosingPicker = await page.locator('#product-info').isVisible();
console.log('hint visible again after closing catalog picker (should be true):', hintVisibleAfterClosingPicker);

// --- Pale-pill vs dark-panel color split (#99): the two token buckets should
// resolve to genuinely different, non-default values, not just be unset. ---
const pillRgb = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pill-rgb').trim());
const panelRgb = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--panel-rgb').trim());
console.log('--pill-rgb (should be the pale green, "214 232 190"):', pillRgb);
console.log('--panel-rgb (should be the dark green, "36 56 20"):', panelRgb);

const pass = sellNavActiveImmediately && closeBtnVisible &&
  !actionsVisibleBefore && !expandedBeforeTap && actionsVisibleAfter && expandedAfterTap &&
  chooseLabel.trim() === 'Sell' &&
  modalGoneAfterCancel === 0 && !sellNavActiveAfterCancel && sellerModalOpenedAfterCancel === 0 &&
  uploadBtnInSeller === 1 && sellerCloseIsX && settingsCloseIsX &&
  hintVisibleBeforePicker && hintHiddenWhilePickerOpen && pickerOpaque && hintVisibleAfterClosingPicker &&
  pillRgb === '214 232 190' && panelRgb === '36 56 20' &&
  errors.length === 0;
await finish(browser, { pass, label: 'identity picker + modal chrome + catalog picker UI redesign', errors });
