// #1318: when the browser takes the WebGL context away (GPU reset, tab
// evicted, another tab claiming the GPU) the world used to go blank with no
// hint. A word beside the head opening to a Reload button now shows while the context is
// lost and disappears by itself if the browser restores it. Drives a real
// context loss with the WEBGL_lose_context extension on the world canvas.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Context Loss Tester' });

// #3889: the flower (the head and its words) is there once a person is in the world, which is
// where a context loss matters.
await chooseIdentity(page, { mode: 'build', label: 'Context Loss Tester', isNew: true });
await claimLandlet(page);

// #3889: the notice is a word beside the flower's head (#bud-note, "Graphics paused") that opens
// a leaf with the sentence and a Reload button; the fixed top bar is gone.
const noteWord = () => page.evaluate(() => {
  const note = document.getElementById('bud-note');
  return note && document.body.hasAttribute('data-bud-note') ? note.textContent.trim() : '';
});
const noticeVisible = async () => (await noteWord()) === 'Graphics paused';

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

await page.waitForFunction(() => { const n = document.getElementById('bud-note'); return n && !n.hidden && n.textContent.trim() === 'Graphics paused'; }, null, { timeout: 10000 }).catch(() => {});
const noticeAfterLoss = await noticeVisible();
console.log('notice visible after context loss (should be true):', noticeAfterLoss);
let noticeText = '';
let reloadButton = false;
if (noticeAfterLoss) {
  await page.click('#bud-note');
  await page.waitForSelector('#bud-leaf-saying-graphics', { timeout: 5000 });
  noticeText = await page.locator('#bud-leaf-saying-graphics').innerText();
  reloadButton = (await page.locator('#saying-graphics-action').textContent()).trim() === 'Reload';
}
console.log('the opened leaf has a Reload button (should be true):', reloadButton);
const oldBarGone = (await page.locator('#graphics-interrupted-notice').count()) === 0;
console.log('the old fixed bar is gone (should be true):', oldBarGone);
console.log('notice mentions Reload (should be true):', /reload/i.test(noticeText));

await page.evaluate(() => window.__loseCtx.restoreContext());
await page.waitForFunction(() => { const n = document.getElementById('bud-note'); return !n || n.hidden; }, null, { timeout: 10000 }).catch(() => {});
const noticeAfterRestore = await noticeVisible();
console.log('notice gone after the context is restored (should be false):', noticeAfterRestore);

await finish(browser, {
  pass: supported && !noticeBefore && noticeAfterLoss && /reload/i.test(noticeText) && reloadButton && oldBarGone && !noticeAfterRestore,
  label: 'webgl-context-loss-notice.test.mjs',
  errors,
});
