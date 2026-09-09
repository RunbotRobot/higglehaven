// #541: Sell mode's new "List view" toggle — a thumbnail-first alternative
// to the Manage rows, and tapping a card should jump back into Manage with
// that product already expanded.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'List View Tester';
const PRODUCT_NAME = 'List View Crate';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

// Manage is the default view on open — the toggle exists and only List
// view's button is inactive yet.
const manageVisibleInitially = await page.locator('#seller-list').isVisible();
const listViewHiddenInitially = await page.locator('#seller-list-view').isHidden();
const manageBtnActiveInitially = await page.locator('.seller-view-btn[data-view="manage"]').evaluate((el) => el.classList.contains('active'));
console.log('Manage view showing on open (should be true):', manageVisibleInitially);
console.log('List view hidden on open (should be true):', listViewHiddenInitially);
console.log('Manage toggle button active on open (should be true):', manageBtnActiveInitially);

await page.click('.seller-view-btn[data-view="list"]');
await page.waitForTimeout(300);

const manageHiddenAfterToggle = await page.locator('#seller-list').isHidden();
const listViewVisibleAfterToggle = await page.locator('#seller-list-view').isVisible();
const listBtnActiveAfterToggle = await page.locator('.seller-view-btn[data-view="list"]').evaluate((el) => el.classList.contains('active'));
console.log('Manage view hidden after switching to List view (should be true):', manageHiddenAfterToggle);
console.log('List view showing after switching (should be true):', listViewVisibleAfterToggle);
console.log('List toggle button active after switching (should be true):', listBtnActiveAfterToggle);

const card = page.locator('.seller-card').filter({ hasText: PRODUCT_NAME });
const cardVisible = await card.isVisible();
const cardHasThumb = await card.locator('.seller-card-thumb').count();
const cardPriceText = await card.locator('.seller-card-price').textContent();
console.log('uploaded product shows as a card in List view (should be true):', cardVisible);
console.log('card has a thumbnail image (should be 1):', cardHasThumb);
console.log('card price text for an unpriced product (should say "Not priced"):', cardPriceText);

// Tapping the card should jump back to Manage with this product's row
// already expanded, not just switch views and leave the seller to find it.
await card.click();
await page.waitForTimeout(300);

const backOnManage = await page.locator('#seller-list').isVisible();
const manageBtnActiveAfterCardClick = await page.locator('.seller-view-btn[data-view="manage"]').evaluate((el) => el.classList.contains('active'));
const row = page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
const rowExpanded = await row.evaluate((el) => el.classList.contains('expanded'));
console.log('back on Manage view after tapping the card (should be true):', backOnManage);
console.log('Manage toggle button active after tapping the card (should be true):', manageBtnActiveAfterCardClick);
console.log('the tapped product\'s row is already expanded (should be true):', rowExpanded);

// Reopening the modal should reset back to Manage, same as Settings resets
// to its General tab. #540: clicking the Sell nav tab while already in Sell
// mode is now a no-op (same as Build/Shop's own tab, currentMode already
// matches) rather than the old always-reopens-the-modal special case —
// #seller-showcase-manage-btn (shown behind the modal, over the showcase
// array) is the real way back in now.
await page.click('#seller-close-btn');
await page.waitForTimeout(300);
await page.click('#seller-showcase-manage-btn');
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
const manageActiveAfterReopen = await page.locator('#seller-list').isVisible();
console.log('Manage view showing again after a close/reopen (should be true):', manageActiveAfterReopen);

const pass = manageVisibleInitially && listViewHiddenInitially && manageBtnActiveInitially &&
  manageHiddenAfterToggle && listViewVisibleAfterToggle && listBtnActiveAfterToggle &&
  cardVisible && cardHasThumb === 1 && cardPriceText.includes('Not priced') &&
  backOnManage && manageBtnActiveAfterCardClick && rowExpanded &&
  manageActiveAfterReopen &&
  errors.length === 0;
await finish(browser, { pass, label: 'Sell mode List view toggle', errors });
