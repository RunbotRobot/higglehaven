// Regression coverage for #1131: disposeClaimFlyover (src/main.js) removes
// the window 'resize' listener each loadLandletMap call attaches, but never
// removed the canvas 'click' listener it also attaches -- every ordinary,
// fully-sequential Refresh click (or a failed-claim retry, which calls
// loadLandletMap again from claimSelectedLandlet's own catch) left one more
// permanent listener on #claim-map-canvas, forever. Distinct from #125/
// claim-map-refresh-race.test.mjs, which only exercises *overlapping*,
// still-in-flight Refresh clicks racing each other -- this is the plain
// "click Refresh a few times, each one completes before the next" case,
// which #125's claimMapLoadToken guard was never meant to (and doesn't)
// address.
//
// Verified by wrapping EventTarget.prototype.addEventListener/
// removeEventListener (installed via an init script, so it's in place
// before chooseIdentity's own Build-mode entry triggers the reload that
// first opens the claim modal) to count net listeners ever attached to
// #claim-map-canvas for the 'click' type specifically -- the real bug would
// show this count growing by one per completed load instead of staying at a
// steady 1.
import { launchPage, chooseIdentity, growWorldAsAdmin, finish } from './helpers.mjs';

const LABEL = 'Claim Listener Leak Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await page.addInitScript(() => {
  window.__claimCanvasClickListenerCount = 0;
  const origAdd = EventTarget.prototype.addEventListener;
  const origRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'click' && this && this.id === 'claim-map-canvas') window.__claimCanvasClickListenerCount++;
    return origAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (type === 'click' && this && this.id === 'claim-map-canvas') window.__claimCanvasClickListenerCount--;
    return origRemove.call(this, type, listener, options);
  };
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await page.waitForSelector('#claim-modal.visible', { timeout: 10000 });
await page.waitForTimeout(2000);
const status = await page.textContent('#claim-status');
if (status?.includes('check back again shortly')) {
  await growWorldAsAdmin();
  await page.click('#claim-refresh-btn');
  await page.waitForTimeout(2000);
}

const afterFirstLoad = await page.evaluate(() => window.__claimCanvasClickListenerCount);
console.log('click listener count after the first completed load (should be 1):', afterFirstLoad);

// Each click here is awaited to full completion (a 2s settle, same wait
// claim-map-refresh-race.test.mjs itself uses after its own burst) before
// the next one fires -- deliberately sequential, not overlapping, since
// that's exactly the case #125's in-flight-race guard doesn't cover.
for (let i = 0; i < 3; i++) {
  await page.click('#claim-refresh-btn');
  await page.waitForTimeout(2000);
}

const afterRefreshes = await page.evaluate(() => window.__claimCanvasClickListenerCount);
console.log('click listener count after 3 sequential completed refreshes (should still be 1):', afterRefreshes);

// The ordinary claim flow should still work normally afterward.
const canvasBox = await page.locator('#claim-map-canvas').boundingBox();
const candidatePoints = [[0.5, 0.5], [0.4, 0.4], [0.4, 0.3], [0.5, 0.3], [0.2, 0.4], [0.1, 0.4]];
let selectedAvailable = false;
for (const [fx, fy] of candidatePoints) {
  await page.mouse.click(canvasBox.x + canvasBox.width * fx, canvasBox.y + canvasBox.height * fy);
  await page.waitForTimeout(250);
  const selection = await page.textContent('#claim-selection-name');
  if (selection && selection.includes('Available')) {
    selectedAvailable = true;
    break;
  }
}
await page.click('#claim-confirm-btn');
await page.waitForTimeout(2500);
const claimedThrough = await page.waitForSelector('#account-menu-toggle', { timeout: 10000 }).then(() => true).catch(() => false);
console.log('claim completed after the sequential refreshes (should be true):', claimedThrough);

const pass = afterFirstLoad === 1 && afterRefreshes === 1 && selectedAvailable && claimedThrough && errors.length === 0;
await finish(browser, { pass, label: 'claim-map-click-listener-leak', errors });
