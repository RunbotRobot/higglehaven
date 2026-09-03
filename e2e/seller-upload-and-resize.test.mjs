// Seller uploads a real model, confirms its measured dimensions, creates
// the product, a builder places it, then the seller corrects its size via
// the Edit Size panel — which should rescale the actual model file and
// notify the builder who has one placed (see docs/API.md's "Notifications"
// and "Editing a product's size" sections).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Seller Suite Tester';
const PRODUCT_NAME = 'Suite Crate';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// A builder identity + claimed landlet is what will end up on the receiving
// end of the resize notification, so set that up first.
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

const badgeHiddenInitially = await page.locator('#notifications-badge').isHidden();
console.log('notifications badge hidden before any notice (should be true):', badgeHiddenInitially);

// Seller identity is a genuinely separate roster from builders — the first
// visit to Sell needs its own picker even with a builder already chosen.
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
const fileStepVisible = await page.locator('#upload-step-file').isVisible();
console.log('upload file step visible initially (should be true):', fileStepVisible);

await page.fill('#upload-name', PRODUCT_NAME);
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);

const originalX = Number(await page.locator('.upload-dimension-input[data-axis="x"]').inputValue());
console.log('measured original width (should be > 0):', originalX);

await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

const sellerListText = await page.textContent('#seller-list');
const productListed = sellerListText.includes(PRODUCT_NAME);
console.log('new product listed in seller list (should be true):', productListed);

await page.click('#seller-close-btn');
await page.waitForTimeout(300);

// Place it via Build's ordinary Add Item flow. Sell is a modal overlay, not
// a real mode transition (#mode-nav's own click handler never changes
// currentMode for it), so Build mode — entered once, at the top of this
// test — is still live underneath; no need to re-pick a builder identity.
await page.waitForTimeout(500);
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: PRODUCT_NAME }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(1000);

// Back to Sell: expand the row, open Edit Size, double the width, Save.
// The seller identity is already active this session (ensureSellerIdentity
// short-circuits once sellerId is set), so the identity picker doesn't
// reopen at all this time — just the nav click straight into the modal.
await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('button', { hasText: 'Edit Size' }).click();
await page.waitForTimeout(300);

const xInput = row().locator('.seller-size-row').nth(0).locator('input');
const yInput = row().locator('.seller-size-row').nth(1).locator('input');
const xBefore = Number(await xInput.inputValue());
const yBefore = Number(await yInput.inputValue());
const newX = Number((xBefore * 2).toFixed(2));
await xInput.fill(String(newX));
await xInput.dispatchEvent('input');
await page.waitForTimeout(300);
const yAfter = Number(await yInput.inputValue());
console.log('Y scaled proportionally after doubling X (should be ~2x):', yBefore, '->', yAfter);
const scaledProportionally = Math.abs(yAfter - yBefore * 2) < 0.02;

await row().locator('button', { hasText: 'Save Size' }).click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.seller-size-status')).some((el) => el.textContent.includes('notified')),
  { timeout: 20000 },
);
const saveStatus = await row().locator('.seller-size-status').textContent();
console.log('save status (should mention notified):', saveStatus);

await page.click('#seller-close-btn');
await page.waitForTimeout(500);

// The collapsed account menu itself summarizes an unread badge as a small
// dot (index.html's #account-menu:has(#notifications-badge:not([hidden]))
// rule) — checkable without expanding the menu at all.
const dotVisibleBeforeExpanding = await page.evaluate(() => {
  const toggle = document.getElementById('account-menu-toggle');
  const style = getComputedStyle(toggle, '::after');
  return style.content !== 'none' && style.content !== '';
});
console.log('account menu toggle shows an unread dot before expanding (should be true):', dotVisibleBeforeExpanding);

await openAccountMenu(page);
const badgeVisible = await page.locator('#notifications-badge').isVisible();
const badgeText = await page.locator('#notifications-badge').textContent();
console.log('notifications badge after resize (should be visible, count 1):', badgeVisible, badgeText);

await page.click('#notifications-btn');
await page.waitForSelector('#notifications-modal.visible', { timeout: 5000 });
// The list is itself gated behind an async fetch (renderNotifications in
// src/main.js) — poll for the actual notice rather than guessing a fixed
// delay, the same class of flake fixed elsewhere in this suite earlier
// this session.
await page.waitForFunction(
  (name) => document.querySelector('.notification-row')?.textContent.includes(name),
  PRODUCT_NAME,
  { timeout: 10000 },
);
const noticeText = await page.locator('.notification-row').first().textContent();
console.log('notice text (should mention product name and "resized"):', noticeText);

await page.click('.notification-row');
await page.waitForTimeout(500);
await page.click('#notifications-close-btn');
await page.waitForTimeout(300);
const badgeHiddenAfterRead = await page.locator('#notifications-badge').isHidden();
console.log('badge hidden after reading the only notice (should be true):', badgeHiddenAfterRead);

const pass = badgeHiddenInitially && fileStepVisible && originalX > 0 && productListed &&
  scaledProportionally && saveStatus.includes('notified') &&
  dotVisibleBeforeExpanding &&
  badgeVisible && badgeText === '1' &&
  noticeText.includes(PRODUCT_NAME) && noticeText.toLowerCase().includes('resized') &&
  badgeHiddenAfterRead &&
  errors.length === 0;
await finish(browser, { pass, label: 'seller upload, edit size, builder notification', errors });
