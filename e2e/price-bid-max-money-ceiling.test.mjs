// #2330: four client-side dollar-amount checks (upload wizard price, seller
// "Edit Price" panel, auction "Start Auction" starting bid, auction "Place
// Bid") validated only `dollars < 0`, with no upper bound -- unlike the
// Start Auction form's own duration field, which already mirrors the
// server's cap client-side (#1922). The server's real ceiling is
// MAX_MONEY_CENTS (worker/index.js, 100,000,000 cents = $1,000,000); an
// over-the-cap value used to pass client validation and surface the raw
// server error string instead of a friendly one. This is all pure
// client-side validation (checked before any fetch for the over-cap case),
// so no real money/balance setup is needed to exercise it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const OVER_CAP_DOLLARS = '1000001'; // one dollar past the $1,000,000 cap

const SELLER = 'Max Money Ceiling Seller';
const BIDDER = 'Max Money Ceiling Bidder';
const PRODUCT_NAME = 'Ceiling Test Crate';

const sellerSession = await launchPage({ promptAnswer: SELLER });
const bidderSession = await launchPage({ promptAnswer: BIDDER });
const sellerPage = sellerSession.page;
const bidderPage = bidderSession.page;

await chooseIdentity(sellerPage, { mode: 'build', label: SELLER, isNew: true });
await claimLandlet(sellerPage);

// --- 1. Upload wizard price field ---
await chooseIdentity(sellerPage, { mode: 'sell', label: SELLER, isNew: true });
await sellerPage.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await sellerPage.waitForTimeout(300);
await sellerPage.click('#upload-model-btn');
await sellerPage.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await sellerPage.fill('#upload-name', PRODUCT_NAME);
await sellerPage.fill('#upload-price', OVER_CAP_DOLLARS);
await sellerPage.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await sellerPage.click('#upload-submit-btn');
await sellerPage.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await sellerPage.waitForTimeout(300);
await sellerPage.click('#upload-submit-btn');
await sellerPage.waitForFunction(
  () => document.getElementById('upload-status')?.textContent.includes('$1,000,000'),
  null,
  { timeout: 10000 },
);
const uploadOverCapStatus = await sellerPage.locator('#upload-status').textContent();
console.log('upload price over the cap rejected client-side (should mention $1,000,000, not a raw server error):', uploadOverCapStatus);
const uploadModalStillOpen = await sellerPage.locator('#upload-modal.visible').count();
console.log('upload modal still open after the rejected price, confirming no fetch was sent (should be 1):', uploadModalStillOpen);

// A valid price still works normally -- not a regression to "nothing can
// ever be uploaded". #upload-price lives on the file step, already hidden
// now that the wizard has moved to the dimensions step (where this re-check
// runs) -- force bypasses the hidden-ancestor actionability check, same as
// just editing the retained value directly would.
await sellerPage.evaluate(() => {
  const input = document.getElementById('upload-price');
  input.value = '10.00';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await sellerPage.click('#upload-submit-btn');
await sellerPage.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
await sellerPage.waitForTimeout(500);

// --- 2. Seller "Edit Price" panel ---
const row = () => sellerPage.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await sellerPage.waitForTimeout(300);
await row().locator('button', { hasText: 'Edit Price' }).click();
await row().locator('.seller-price-input').fill(OVER_CAP_DOLLARS);
await row().locator('button', { hasText: 'Save Price' }).click();
await sellerPage.waitForFunction(
  () => Array.from(document.querySelectorAll('.seller-price-status')).some((el) => el.textContent.includes('$1,000,000')),
  null,
  { timeout: 10000 },
);
const editPriceOverCapStatus = await row().locator('.seller-price-status').textContent();
console.log('Edit Price over the cap rejected client-side (should mention $1,000,000):', editPriceOverCapStatus);

// --- 3. Auction "Start Auction" starting-bid field ---
await openAccountMenu(sellerPage);
await sellerPage.click('#settings-btn');
await sellerPage.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await sellerPage.click('.settings-tab-btn[data-section="build"]');
const startField = sellerPage.locator('.settings-field', { has: sellerPage.locator('.auction-start-form') });
const startForm = startField.locator('.auction-start-form');
await startForm.waitFor({ timeout: 10000 });
const startStatus = startField.locator('.settings-empty-note');
await startForm.locator('input').nth(0).fill(OVER_CAP_DOLLARS);
await startForm.locator('input').nth(1).fill('1'); // duration 1 hour, valid
await sellerPage.click('.auction-start-btn');
await sellerPage.waitForFunction(
  () => [...document.querySelectorAll('.settings-field .settings-empty-note')].some((el) => el.textContent.includes('$1,000,000')),
  null,
  { timeout: 10000 },
);
const startBidOverCapStatus = await startStatus.textContent();
console.log('Start Auction starting bid over the cap rejected client-side (should mention $1,000,000):', startBidOverCapStatus);
const startFormStillPresent = await sellerPage.locator('.auction-start-form').count();
console.log('start form still present after the rejected starting bid, confirming no fetch was sent (should be 1):', startFormStillPresent);

// A valid starting bid still starts the auction normally.
await startForm.locator('input').nth(0).fill('5');
await sellerPage.click('.auction-start-btn');
await sellerPage.waitForFunction(
  () => document.querySelector('.settings-field .auction-row')?.textContent.includes('Your auction is live'),
  null,
  { timeout: 30000 },
);
await sellerPage.click('#settings-close-btn');
await sellerPage.waitForTimeout(300);

// --- 4. Auction "Place Bid" field ---
await chooseIdentity(bidderPage, { mode: 'build', label: BIDDER, isNew: true });
await claimLandlet(bidderPage);
await openAccountMenu(bidderPage);
await bidderPage.click('#settings-btn');
await bidderPage.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await bidderPage.click('.settings-tab-btn[data-section="build"]');
const auctionsListItems = bidderPage.locator('.auction-list .auction-row');
await auctionsListItems.first().waitFor({ timeout: 10000 });

let lastAlertMessage = null;
bidderPage.on('dialog', (dialog) => { lastAlertMessage = dialog.message(); });
const bidInput = auctionsListItems.first().locator('.auction-row-bid-input');
await bidInput.fill(OVER_CAP_DOLLARS);
await auctionsListItems.first().locator('.auction-bid-btn').click();
await bidderPage.waitForTimeout(300);
console.log('alert shown for an over-the-cap bid (should mention $1,000,000):', lastAlertMessage);
const placeBidOverCapAlertOk = lastAlertMessage === 'Enter a bid of $1,000,000.00 or less.';

await bidderSession.browser.close();

// Assembled here, after every interaction has happened, rather than at
// launch time -- #2735: a spread copy taken right after launchPage() would
// freeze on the still-empty source arrays and never see a real error.
const errors = [...sellerSession.errors, ...bidderSession.errors];
const pass = uploadOverCapStatus.includes('$1,000,000') && !uploadOverCapStatus.includes('must be a non-negative integer') &&
  uploadModalStillOpen === 1 &&
  editPriceOverCapStatus.includes('$1,000,000') &&
  startBidOverCapStatus.includes('$1,000,000') &&
  startFormStillPresent === 1 &&
  placeBidOverCapAlertOk &&
  errors.length === 0;
await finish(sellerSession.browser, {
  pass,
  label: '#2330: upload/seller-price/auction-start/place-bid all reject an over-MAX_MONEY_CENTS value client-side with a friendly message',
  errors,
});
