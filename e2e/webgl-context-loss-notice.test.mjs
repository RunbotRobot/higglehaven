// #1318: when the browser takes the WebGL context away (GPU reset, tab
// evicted, another tab claiming the GPU) the world used to go blank with no
// hint. A plain notice with a Reload button now shows while the context is
// lost and disappears by itself if the browser restores it. Drives a real
// context loss with the WEBGL_lose_context extension on the world canvas.
import { launchPage, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Context Loss Tester' });

const noticeVisible = () => page.locator('#graphics-interrupted-notice').isVisible();

const noticeBefore = await noticeVisible();
console.log('no notice before any context loss (should be false):', noticeBefore);

const supported = await page.evaluate(() => {
  const gl = document.getElementById('app').getContext('webgl2') || document.getElementById('app').getContext('webgl');
  const ext = gl && gl.getExtension('WEBGL_lose_context');
  if (!ext) return false;
  window.__loseCtx = ext;
  ext.loseContext();
  return true;
});
console.log('WEBGL_lose_context available (should be true):', supported);

await page.waitForSelector('#graphics-interrupted-notice', { timeout: 10000 }).catch(() => {});
const noticeAfterLoss = await noticeVisible();
console.log('notice visible after context loss (should be true):', noticeAfterLoss);
const noticeText = noticeAfterLoss ? await page.locator('#graphics-interrupted-notice').innerText() : '';
console.log('notice mentions Reload (should be true):', /reload/i.test(noticeText));

await page.evaluate(() => window.__loseCtx.restoreContext());
await page.waitForSelector('#graphics-interrupted-notice', { state: 'detached', timeout: 10000 }).catch(() => {});
const noticeAfterRestore = await noticeVisible();
console.log('notice gone after the context is restored (should be false):', noticeAfterRestore);

await finish(browser, {
  pass: supported && !noticeBefore && noticeAfterLoss && /reload/i.test(noticeText) && !noticeAfterRestore,
  label: 'webgl-context-loss-notice.test.mjs',
  errors,
});
