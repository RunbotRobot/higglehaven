// #2718 (sub-issue of #2715, "[Tracking] In-app 'Submit Feedback' bug
// reports..."): the "Submit Feedback" button/modal -- screenshot capture,
// WebGL/browser info, and the #2717 ring buffer, submitted via
// src/api.js's submitFeedbackBugReport to POST /api/feedback/bug-report.
//
// #2719 (the Worker endpoint) has now landed, so a real submit succeeds --
// exercises the screenshot-capture, success-status, and auto-close flow
// end to end. The backend's own behavior (bug_reports row shape, R2
// storage, auth) is covered directly by worker/feedback.test.js; this
// test's own scope is the UI flow only.
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

// #2719 has landed -- a real submit now succeeds (201), so the UI's own
// success path runs: setFeedbackStatus('Thanks! ...', false), then
// handleFeedbackSubmit's setTimeout(closeFeedbackModal, 1200) auto-closes
// the modal shortly after. Polls for the specific success text rather
// than "#feedback-status:not(.error)" -- that compound selector already
// matches the modal's own empty initial state (openFeedbackModal's
// setFeedbackStatus('', false)) before the real submit even resolves, so
// it would resolve immediately instead of actually waiting for it.
await page.waitForFunction(
  () => document.getElementById('feedback-status').textContent.includes('Thanks'),
  null,
  { timeout: 10000 },
);
const statusText = (await page.textContent('#feedback-status')) || '';
console.log('feedback-status after a real successful submit (should be a friendly thank-you):', statusText);

// Waits for the modal's own auto-close rather than clicking Close -- a
// successful submit already schedules that 1.2s after the status above
// appears, so clicking the button too could race its own disabled state.
await page.waitForFunction(
  () => !document.getElementById('feedback-modal').classList.contains('visible'),
  null,
  { timeout: 5000 },
);
const modalStillVisible = await page.locator('#feedback-modal.visible').count();
console.log('modal auto-closed after a successful submit (should be 0):', modalStillVisible);

const pass = previewLoaded && statusText.length > 0 && modalStillVisible === 0 && errors.length === 0;
await finish(browser, { pass, label: 'shop-submit-feedback', errors });
