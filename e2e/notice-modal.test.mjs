// #3249: Shop's Buy no longer depends on native dialogs. The purchase result
// is an in-app notice (src/ui/noticeModal.js) that stays until closed, can be
// selected, and gives the one-time delivery-confirm link a Copy button -- a
// suppressed alert() would have lost that link for good. Buy's confirmation is
// the shared confirm modal with a neutral (green) button, not the red
// destructive one. The real Buy flow needs a Stripe-backed sale, so it is
// exercised by purchase-checkout-real-stripe.test.mjs; this opens the same
// modules directly and dismisses every native dialog the instant it opens
// (what a suppressed dialog does).
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Notice Modal Tester';
const LINK = 'https://example.test/confirm-delivery/abc123';
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

// --- notice with a delivery link ---
await page.evaluate((link) => {
  window.__noticeDone = false;
  window.__showNotice({
    title: 'Purchase complete',
    message: 'Thank you! Copy this link now.',
    copyText: link,
  }).then(() => { window.__noticeDone = true; });
}, LINK);
await page.waitForSelector('#notice-modal.visible', { timeout: 5000 });
const title = await page.textContent('#notice-modal-title');
const copyRowShown = await page.isVisible('#notice-modal-copy-row');
const fieldValue = await page.inputValue('#notice-modal-copy-field');
const selectable = await page.evaluate(() => {
  const msg = getComputedStyle(document.getElementById('notice-modal-message'));
  const field = getComputedStyle(document.getElementById('notice-modal-copy-field'));
  return msg.userSelect !== 'none' && msg.pointerEvents !== 'none' && field.userSelect !== 'none';
});
await page.click('#notice-modal-copy-btn');
const copyBtnLabel = await page.textContent('#notice-modal-copy-btn');
// Still there well past the old 8-second auto-dismiss.
await page.waitForTimeout(9000);
const stillOpenAfterWait = await visible('#notice-modal');
await page.keyboard.press('Escape');
await page.waitForFunction(() => window.__noticeDone === true, null, { timeout: 5000 });
const closedByEscape = !(await visible('#notice-modal'));

// --- plain notice: no copy row ---
await page.evaluate(() => { window.__noticeDone = false; window.__showNotice({ title: 'Purchase complete', message: 'Thank you!' }).then(() => { window.__noticeDone = true; }); });
await page.waitForSelector('#notice-modal.visible', { timeout: 5000 });
const copyRowHiddenWhenPlain = !(await page.isVisible('#notice-modal-copy-row'));
await page.click('#notice-modal-ok-btn');
await page.waitForFunction(() => window.__noticeDone === true, null, { timeout: 5000 });

// --- neutral confirm: green button, resolves true / false ---
const bgOf = () => page.$eval('#confirm-modal-confirm-btn', (el) => getComputedStyle(el).backgroundColor);
await page.evaluate(() => {
  window.__confirmResult = undefined;
  window.__confirmAction({ title: 'Buy "Widget"?', message: '$5.00.', confirmLabel: 'Buy' }).then((r) => { window.__confirmResult = r; });
});
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
const neutralClass = await page.$eval('#confirm-modal-confirm-btn', (el) => el.classList.contains('neutral'));
const neutralBg = await bgOf();
const confirmLabel = await page.textContent('#confirm-modal-confirm-btn');
await page.click('#confirm-modal-confirm-btn');
await page.waitForFunction(() => window.__confirmResult === true, null, { timeout: 5000 });
await page.evaluate(() => {
  window.__confirmResult = undefined;
  window.__confirmAction({ title: 'Buy "Widget"?', message: '$5.00.', confirmLabel: 'Buy' }).then((r) => { window.__confirmResult = r; });
});
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
await page.click('#confirm-modal-cancel-btn');
await page.waitForFunction(() => window.__confirmResult === false, null, { timeout: 5000 });

console.log({ title, copyRowShown, fieldValue, selectable, copyBtnLabel, stillOpenAfterWait, closedByEscape, copyRowHiddenWhenPlain, neutralClass, neutralBg, confirmLabel, nativeDialogs });
const pass = title === 'Purchase complete' && copyRowShown && fieldValue === LINK && selectable &&
  (copyBtnLabel === 'Copied!' || copyBtnLabel === "Couldn't copy") &&
  stillOpenAfterWait && closedByEscape && copyRowHiddenWhenPlain &&
  neutralClass && neutralBg !== 'rgb(168, 58, 39)' && confirmLabel === 'Buy' &&
  nativeDialogs.length === 0 && errors.length === 0;
await finish(browser, { pass, label: '#3249: purchase result notice and neutral Buy confirm are in-app modals', errors });
