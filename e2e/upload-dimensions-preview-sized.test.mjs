// #3251: the Upload wizard's "Confirm Dimensions" step showed a large blank
// box above the size fields. showUploadDimensionPreview measured its canvas
// (getBoundingClientRect) and created the WebGL renderer while that step was
// still `hidden` (display: none), so the rect was 0x0 and the drawing buffer
// was sized 0x0 -- nothing could ever be drawn. The step is now revealed from
// inside showUploadDimensionPreview just before measuring, and a
// ResizeObserver keeps the buffer in step with later layout changes.
//
// Asserts on the canvas's real laid-out size and its WebGL drawing-buffer
// size (not pixel content, which a non-preserved drawing buffer can't be
// read back reliably), at a phone width, then again after the viewport
// changes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Upload Preview Size Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await page.setViewportSize({ width: 390, height: 780 });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', 'Preview Size Crate');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForSelector('#upload-step-dimensions:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(500);

const sizes = () => page.evaluate(() => {
  const canvas = document.querySelector('#upload-dimensions-preview canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  return { cssW: Math.round(rect.width), cssH: Math.round(rect.height), bufW: canvas.width, bufH: canvas.height };
});

const first = await sizes();
console.log('preview canvas sizes on opening the step (css and buffer should all be > 1):', JSON.stringify(first));
const firstOk = !!first && first.cssW > 1 && first.cssH > 1 && first.bufW > 1 && first.bufH > 1;

await page.setViewportSize({ width: 320, height: 780 });
await page.waitForTimeout(600);
const second = await sizes();
console.log('preview canvas sizes after the viewport narrows (buffer should have followed the css width):', JSON.stringify(second));
const dpr = await page.evaluate(() => Math.min(window.devicePixelRatio, 2));
const followed = !!second && second.cssW > 1 && second.cssW < first.cssW && Math.abs(second.bufW - second.cssW * dpr) <= 2;

const pass = firstOk && followed && errors.length === 0;
await finish(browser, {
  pass,
  label: 'Upload wizard Confirm Dimensions: the model preview canvas has a real size when the step opens and follows later layout changes (#3251)',
  errors,
});
