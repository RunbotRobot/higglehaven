// #3249: the product review flow (write, edit, delete) is one in-app modal,
// not a chain of native prompt()/alert() calls. A browser that suppresses
// native dialogs answers each of those with "cancel" at once, so Rate this
// Product did nothing and said nothing. This opens the modal directly (the
// in-world button needs real camera movement) with stubbed callbacks, dismisses
// every native dialog the instant it opens (what a suppressed dialog does),
// and checks: create mode, a server failure shown inside the modal and kept
// for a retry, the 280-character guard, and edit mode's prefill and Delete
// through the shared destructive-confirm modal.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Review Modal Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);
const nativeDialogs = [];
page.removeAllListeners('dialog');
page.on('dialog', async (dialog) => {
  nativeDialogs.push(dialog.type());
  await dialog.dismiss();
});

const visible = (sel) => page.evaluate((s) => document.querySelector(s)?.classList.contains('visible') ?? false, sel);

// --- create mode: a failing save shows its message inside the modal ---
await page.evaluate(() => {
  window.__reviewCalls = [];
  window.__reviewResult = undefined;
  window.__failNext = true;
  window.__openProductReviewModal({
    existing: null,
    onSubmit: async (payload) => {
      window.__reviewCalls.push(payload);
      if (window.__failNext) {
        window.__failNext = false;
        throw new Error('You need to buy this product before reviewing it.');
      }
    },
  }).then((r) => { window.__reviewResult = r; });
});
await page.waitForSelector('#product-review-modal.visible', { timeout: 5000 });
const createTitle = await page.textContent('#product-review-modal-title');
const defaultRating = await page.$eval('input[name="product-review-rating"]:checked', (el) => el.value);
const deleteHiddenOnCreate = await page.$eval('#product-review-delete-btn', (el) => el.hidden);
await page.check('input[name="product-review-rating"][value="4"]');
await page.fill('#product-review-text', 'Sturdy.');
await page.click('#product-review-save-btn');
await page.waitForSelector('#product-review-status:not([hidden])', { timeout: 5000 });
const errorText = await page.textContent('#product-review-status-text');
const stillOpenAfterError = await visible('#product-review-modal');
const copyBtnShown = await page.isVisible('#product-review-status-copy-btn');
const saveEnabledAfterError = await page.$eval('#product-review-save-btn', (el) => !el.disabled);
// Retry succeeds and closes the modal.
await page.click('#product-review-save-btn');
await page.waitForFunction(() => window.__reviewResult === true, null, { timeout: 5000 });
const closedAfterRetry = !(await visible('#product-review-modal'));
const calls = await page.evaluate(() => window.__reviewCalls);

// --- 280-character guard: onSubmit is not called ---
await page.evaluate(() => {
  window.__reviewCalls = [];
  window.__reviewResult = undefined;
  window.__openProductReviewModal({
    existing: null,
    onSubmit: async (payload) => { window.__reviewCalls.push(payload); },
  }).then((r) => { window.__reviewResult = r; });
});
await page.waitForSelector('#product-review-modal.visible', { timeout: 5000 });
await page.fill('#product-review-text', 'x'.repeat(281));
const overClass = await page.$eval('#product-review-count', (el) => el.classList.contains('over'));
await page.click('#product-review-save-btn');
await page.waitForSelector('#product-review-status:not([hidden])', { timeout: 5000 });
const overMsg = await page.textContent('#product-review-status-text');
const overCalls = await page.evaluate(() => window.__reviewCalls.length);
await page.click('#product-review-cancel-btn');
await page.waitForFunction(() => window.__reviewResult === false, null, { timeout: 5000 });

// --- edit mode: prefilled, Delete asks in the destructive-confirm modal ---
await page.evaluate(() => {
  window.__deleted = 0;
  window.__reviewResult = undefined;
  window.__openProductReviewModal({
    existing: { rating: 2, text: 'Meh.' },
    onSubmit: async () => {},
    onDelete: async () => { window.__deleted += 1; },
  }).then((r) => { window.__reviewResult = r; });
});
await page.waitForSelector('#product-review-modal.visible', { timeout: 5000 });
const editTitle = await page.textContent('#product-review-modal-title');
const editRating = await page.$eval('input[name="product-review-rating"]:checked', (el) => el.value);
const editText = await page.inputValue('#product-review-text');
const deleteShownOnEdit = await page.isVisible('#product-review-delete-btn');
await page.click('#product-review-delete-btn');
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
const confirmTitle = await page.textContent('#confirm-modal-title');
// Never mind keeps the review modal and deletes nothing.
await page.click('#confirm-modal-cancel-btn');
await page.waitForFunction(() => !document.getElementById('confirm-modal').classList.contains('visible'), null, { timeout: 5000 });
const reviewStillOpen = await visible('#product-review-modal');
const deletedAfterCancel = await page.evaluate(() => window.__deleted);
await page.click('#product-review-delete-btn');
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
await page.click('#confirm-modal-confirm-btn');
await page.waitForFunction(() => window.__reviewResult === true, null, { timeout: 5000 });
const deletedAfterConfirm = await page.evaluate(() => window.__deleted);
const bothClosed = !(await visible('#product-review-modal')) && !(await visible('#confirm-modal'));

console.log({ createTitle, defaultRating, deleteHiddenOnCreate, errorText, stillOpenAfterError, copyBtnShown, saveEnabledAfterError, closedAfterRetry, calls, overClass, overMsg, overCalls, editTitle, editRating, editText, deleteShownOnEdit, confirmTitle, reviewStillOpen, deletedAfterCancel, deletedAfterConfirm, bothClosed, nativeDialogs });

const pass = createTitle === 'Review this product' && defaultRating === '5' && deleteHiddenOnCreate &&
  errorText.includes('buy this product') && stillOpenAfterError && copyBtnShown && saveEnabledAfterError &&
  closedAfterRetry && calls.length === 2 && calls[1].rating === 4 && calls[1].text === 'Sturdy.' &&
  overClass && overMsg.includes('280') && overCalls === 0 &&
  editTitle === 'Your review' && editRating === '2' && editText === 'Meh.' && deleteShownOnEdit &&
  confirmTitle === 'Delete your review?' && reviewStillOpen && deletedAfterCancel === 0 &&
  deletedAfterConfirm === 1 && bothClosed &&
  nativeDialogs.length === 0 && errors.length === 0;
await finish(browser, { pass, label: '#3249: product review write/edit/delete is an in-app modal, no native dialogs', errors });
