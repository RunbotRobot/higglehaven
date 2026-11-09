// #3302 (owner decision 2026-11-09): "Send feedback" lives in Settings, in
// every mode, instead of as a Shop-only HUD pill. Walks Build, Shop and Sell
// on one account at phone width: the old pill is gone, Settings offers Send
// feedback, it opens the Submit Feedback modal over Settings with a real
// screenshot, closing it returns to Settings, and the submitted report
// carries `mode` plus a ring-buffer sample taken in that same mode (so Build
// and Sell reports are no longer empty). The POST is intercepted so the exact
// multipart body can be read; the backend's own handling is covered by
// worker/feedback.test.js.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Feedback Settings Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

let lastReport = null;
await page.route('**/api/feedback/bug-report', async (route) => {
  const buf = route.request().postDataBuffer();
  const text = buf ? buf.toString('latin1') : '';
  const metaMatch = text.match(/name="metadata"\r\n\r\n([\s\S]*?)\r\n--/);
  const shotMatch = text.match(/name="screenshot"; filename="feedback.png"\r\nContent-Type: image\/png\r\n\r\n([\s\S]*?)\r\n--/);
  lastReport = {
    metadata: metaMatch ? JSON.parse(metaMatch[1]) : null,
    screenshotBytes: shotMatch ? shotMatch[1].length : 0,
  };
  await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
});

const results = [];

async function sendFeedbackFromSettings(expectedMode) {
  lastReport = null;
  // Give the ring buffer's ~1Hz throttle a tick so this mode has a sample.
  await page.waitForTimeout(1600);
  const pillCount = await page.locator('#shop-feedback-btn').count();
  await openAccountMenu(page);
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
  await page.click('#settings-feedback-btn');
  await page.waitForSelector('#feedback-modal.visible', { timeout: 5000 });
  await page.waitForFunction(
    () => (document.getElementById('feedback-screenshot-preview').getAttribute('src') || '').startsWith('blob:'),
    null,
    { timeout: 8000 },
  );
  const previewOk = await page.evaluate(() => {
    const img = document.getElementById('feedback-screenshot-preview');
    return new Promise((resolve) => {
      if (img.complete) return resolve(img.naturalWidth > 0);
      img.addEventListener('load', () => resolve(img.naturalWidth > 0), { once: true });
      img.addEventListener('error', () => resolve(false), { once: true });
    });
  });
  await page.fill('#feedback-description', `Feedback from ${expectedMode}`);
  await page.click('#feedback-submit-btn');
  await page.waitForFunction(
    () => document.getElementById('feedback-status').textContent.includes('Thanks'),
    null,
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () => !document.getElementById('feedback-modal').classList.contains('visible'),
    null,
    { timeout: 5000 },
  );
  // Closing the feedback modal returns to Settings, still open and trapped.
  const settingsStillOpen = (await page.locator('#settings-modal.visible').count()) === 1;
  const focusInsideSettings = await page.evaluate(
    () => document.getElementById('settings-modal').contains(document.activeElement),
  );
  await page.click('#settings-close-btn');
  await page.waitForSelector('#settings-modal:not(.visible)', { state: 'attached', timeout: 5000 });

  const samples = lastReport?.metadata?.renderStateBuffer || [];
  const lastSample = samples[samples.length - 1] || {};
  const row = {
    mode: expectedMode,
    pillCount,
    previewOk,
    settingsStillOpen,
    focusInsideSettings,
    payloadMode: lastReport?.metadata?.mode,
    screenshotBytes: lastReport?.screenshotBytes,
    sampleMode: lastSample.mode,
    sampleHasCamera: !!lastSample.cameraPosition,
  };
  console.log(`${expectedMode}:`, JSON.stringify(row));
  results.push(row);
}

// Build (needs a claimed landlet), then Shop, then Sell -- each mode switch
// reloads the page, so each report only has that mode's own buffer.
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);
await sendFeedbackFromSettings('build');

await page.click('.mode-nav-btn[data-mode="shop"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 20000 });
await sendFeedbackFromSettings('shop');

await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.click('#seller-close-btn');
await page.waitForSelector('#seller-modal:not(.visible)', { state: 'attached', timeout: 5000 });
await sendFeedbackFromSettings('sell');

const pass = results.length === 3 && results.every((r) => (
  r.pillCount === 0 && r.previewOk && r.settingsStillOpen && r.focusInsideSettings
  && r.payloadMode === r.mode && r.screenshotBytes > 1000
  && r.sampleMode === r.mode && r.sampleHasCamera
)) && errors.length === 0;
await finish(browser, { pass, label: 'feedback-in-settings-all-modes (#3302)', errors });
