// #3873 (part of #3539): a mode switch reloads the page. The tap draws the world the person is looking at
// into a small image (src/ui/switchSnapshot.js); public/bud-switch.js, the first script on the new page,
// puts it behind a pale fog veil on the loading screen in place of the cold-open bud and wordmark. This
// checks the whole path: the snapshot is stored at the tap, the new page's first script uses it (once), and
// a cold open (no switch) still shows the cold-open screen.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Switch Snapshot Tester' });
await chooseIdentity(page, { mode: 'shop', label: 'Switch Snapshot Tester', isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 30000 });

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

// A cold open has no snapshot: the screen carries no image and not the class.
const cold = await page.evaluate(() => ({
  cls: document.documentElement.classList.contains('switch-snapshot'),
  bg: document.getElementById('loading-screen').style.backgroundImage,
}));
check(!cold.cls && cold.bg === '', `a cold open keeps the cold-open screen (${JSON.stringify(cold)})`);

// Tap Sell's petal: the snapshot is written, then the page reloads.
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded');
await page.waitForTimeout(400);
const stored = await page.evaluate(() => {
  // Capture what the tap will store without leaving: the click handler runs in the page, so read the key
  // from the first paint of the next document instead (below); here only check the petal is there.
  return !!document.querySelector('#bud-modes .mode-nav-btn[data-mode="sell"]');
});
check(stored, 'the Sell petal is there');

// Keep the snapshot key across the reload for inspection: the new page's first script removes it.
await page.addInitScript(() => {
  window.__snapshotAtStart = sessionStorage.getItem('higglehaven.switchSnapshot');
});
const [ , ] = await Promise.all([
  page.waitForEvent('domcontentloaded'),
  page.click('#bud-modes .mode-nav-btn[data-mode="sell"]'),
]);
const warm = await page.evaluate(() => ({
  cls: document.documentElement.classList.contains('switch-snapshot'),
  bg: document.getElementById('loading-screen').style.backgroundImage,
  atStart: (window.__snapshotAtStart || '').length,
  left: sessionStorage.getItem('higglehaven.switchSnapshot'),
}));
check(warm.atStart > 200, `the tap stored a snapshot (${warm.atStart} chars at the new page's start)`);
check(warm.cls, 'the loading screen is marked as keeping the world');
check(/^url\("data:image\/jpeg;base64,/.test(warm.bg), `the loading screen shows the snapshot (${String(warm.bg).slice(0, 40)})`);
check(warm.left === null, 'the snapshot is used once');

await finish(browser, { pass: pass && errors.length === 0, label: 'mode-switch-keeps-world (#3873)', errors });
