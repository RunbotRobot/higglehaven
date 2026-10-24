// #2718 (sub-issue of #2715, "[Tracking] In-app 'Submit Feedback' bug
// reports..."): the "Submit Feedback" button/modal -- screenshot capture,
// WebGL/browser info, and the #2717 ring buffer, submitted via
// src/api.js's submitFeedbackBugReport to POST /api/feedback/bug-report.
//
// #2719 (the Worker endpoint) hasn't landed as of this test, so a real
// submit 404s -- this exercises that the UI surfaces that as an inline
// error (src/feedback/submitFeedbackUI.js's own setFeedbackStatus) rather
// than crashing, plus the screenshot-capture and close flows. Once #2719
// lands, a follow-up test can assert against a real stored bug_reports
// row instead.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Feedback Suite Tester';

const { browser, page, errors } = await launchPage();

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-feedback-btn.visible', { timeout: 10000 });

await page.click('#shop-feedback-btn');
await page.waitForSelector('#feedback-modal.visible', { timeout: 5000 });

// The screenshot capture is async (canvas.toBlob) -- wait for the preview
// <img>'s src to actually be populated rather than asserting at the
// instant the modal appears.
await page.waitForFunction(
  () => (document.getElementById('feedback-screenshot-preview').getAttribute('src') || '').startsWith('blob:'),
  { timeout: 5000 },
);
const previewLoaded = await page.evaluate(() => {
  const img = document.getElementById('feedback-screenshot-preview');
  return new Promise((resolve) => {
    if (img.complete) return resolve(img.naturalWidth > 0);
    img.addEventListener('load', () => resolve(img.naturalWidth > 0), { once: true });
    img.addEventListener('error', () => resolve(false), { once: true });
  });
});
console.log('screenshot preview actually loaded a non-empty image (should be true):', previewLoaded);

await page.fill('#feedback-description', 'Something looked wrong with the sky.');
await page.click('#feedback-submit-btn');

// #2719 hasn't landed yet -- expect the UI's own inline error path, not an
// unhandled rejection/crash. This deliberately triggers a real 404 --
// Chromium logs any non-2xx fetch response as "Failed to load resource"
// independent of whether the app handled it gracefully, same reason
// e2e/admin-dashboard-page.test.mjs/e2e/redeem-higgles-settings.test.mjs
// and others already filter this out of their own errors.length === 0
// check rather than avoiding the real error response.
await page.waitForSelector('#feedback-status.error', { timeout: 10000 });
const statusText = (await page.textContent('#feedback-status')) || '';
console.log('feedback-status after submit (should be a friendly, non-empty error; #2719 not landed yet):', statusText);

await page.click('#feedback-close-btn');
const modalStillVisible = await page.locator('#feedback-modal.visible').count();
console.log('modal closed after clicking close (should be 0):', modalStillVisible);

const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));
const pass = previewLoaded && statusText.length > 0 && modalStillVisible === 0 && unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'shop-submit-feedback', errors: unexpectedErrors });
