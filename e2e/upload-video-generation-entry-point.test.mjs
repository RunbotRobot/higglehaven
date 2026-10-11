// #1620 (sub-issue of #1616): the "Generate from video" entry point
// alongside the existing Upload Model flow. TRIPO_API_KEY is never
// configured in local dev/e2e (same convention as every other
// third-party-API integration in this codebase, see worker/index.js's
// tripoConfigured), so a real generation can't be exercised end-to-end
// here -- this test instead covers everything reachable without one: the
// mode toggle, picking a real video file and extracting frames from it in
// the browser (src/main.js's extractVideoFrames, exercised for real
// against e2e/fixtures/test-object-video.webm), submitting the job, and
// getting a clear error with the "back to manual upload" fallback once
// the (unconfigured) backend 503s -- rather than the modal silently
// freezing or looking broken, which is the issue's own explicit ask.
//
// e2e/fixtures/test-object-video.webm is a generated fixture: a 2-second,
// 320x240 VP8 webm (no real-world counterpart) recorded from an animated
// canvas via MediaRecorder, picked purely to be a real, decodable video
// file small enough to commit.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = path.join(REPO_ROOT, 'e2e', 'fixtures', 'test-object-video.webm');

const LABEL = 'Video Gen Entry Point Tester';
const PRODUCT_NAME = 'Suite Video-Generated Product';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });

// Before toggling: the manual file row is visible, the video row is not.
const fileRowVisibleInitially = await page.isVisible('#upload-file-label');
const videoSectionHiddenInitially = await page.evaluate(() => document.getElementById('upload-video-section').hidden);
console.log('manual file row visible before toggling (should be true):', fileRowVisibleInitially);
console.log('video section hidden before toggling (should be true):', videoSectionHiddenInitially);

await page.fill('#upload-name', PRODUCT_NAME);
await page.click('#upload-mode-video-btn');

const videoSectionVisibleAfterToggle = await page.evaluate(() => !document.getElementById('upload-video-section').hidden);
const fileRowHiddenAfterToggle = await page.evaluate(() => document.getElementById('upload-file-label').hidden);
const submitLabelInVideoMode = await page.textContent('#upload-submit-btn');
console.log('video section visible after toggling (should be true):', videoSectionVisibleAfterToggle);
console.log('manual file row hidden after toggling (should be true):', fileRowHiddenAfterToggle);
console.log('submit button reads "Generate Model" in video mode (should be true):', submitLabelInVideoMode.trim() === 'Generate Model');

await page.setInputFiles('#upload-video-input', FIXTURE_PATH);
await page.click('#upload-submit-btn');

// extractVideoFrames (real decode + canvas draw of the real fixture) runs
// before the job-create request ever fires -- generous timeout for that
// plus the request/response round trip.
const reachedTerminalStatus = await page
  .waitForFunction(
    () => {
      const status = document.getElementById('upload-status');
      return status && status.classList.contains('error') && status.textContent.trim().length > 0;
    },
    { timeout: 20000 },
  )
  .then(() => true)
  .catch(() => false);
const statusText = await page.textContent('#upload-status').catch(() => '');
console.log('reached an error status after submitting (should be true):', reachedTerminalStatus);
console.log('error status text (diagnostic only, expect something about video generation not being configured):', statusText);

// The whole point of this sub-issue's "On failure, a clear retry/fallback
// path" ask: the modal must not be left stuck disabled/looking broken --
// the submit button re-enables and the manual-upload toggle is still
// reachable.
const submitReenabled = await page.evaluate(() => !document.getElementById('upload-submit-btn').disabled);
console.log('submit button re-enabled after the failure (should be true):', submitReenabled);

await page.click('#upload-mode-file-btn');
const backToFileMode = await page.evaluate(() => {
  const fileLabel = document.getElementById('upload-file-label');
  const videoSection = document.getElementById('upload-video-section');
  return !fileLabel.hidden && videoSection.hidden;
});
console.log('"Back to manual file upload" restores the file-pick row (should be true):', backToFileMode);

// This test deliberately drives the (expected, handled) "provider not
// configured" failure path -- unlike every other e2e test in this suite,
// which only exercises happy paths and can assert errors.length === 0
// outright. The 503 resource-load log and the matching console.error
// (src/main.js's handleUploadVideoStep, same "report the real error"
// convention handleUploadFileStep's own outer catch already uses) are
// both expected here; anything else in `errors` would be a genuine,
// unexpected failure.
const unexpectedErrors = errors.filter(
  (message) => !message.includes('503') && !message.includes('Video-to-3D generation is not configured'),
);
console.log('unexpected page errors (should be empty):', unexpectedErrors);

const pass = fileRowVisibleInitially && videoSectionHiddenInitially && videoSectionVisibleAfterToggle
  && fileRowHiddenAfterToggle && submitLabelInVideoMode.trim() === 'Generate Model'
  && reachedTerminalStatus && submitReenabled && backToFileMode && unexpectedErrors.length === 0;
await finish(browser, {
  pass,
  label: 'The "Generate from video" entry point toggles correctly, extracts real frames from a picked video, and fails gracefully with a working manual-upload fallback when the provider is unconfigured (#1620)',
  errors: unexpectedErrors,
});
