// #3874: the claim sheet on a phone turned on its side (844x390). Its square map box used to be squeezed by
// the column to a strip a few pixels high, so a new builder could not choose a lándlet. On a short screen
// the sheet is two columns: the map square on the left (at least 200px a side), the words and buttons
// beside it, all inside the screen; and a lándlet can still be chosen on that map and claimed.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Short Claim';
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 844, height: 390 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await page.waitForSelector('#claim-modal.visible', { timeout: 120000 });
await page.waitForFunction(() => document.getElementById('claim-status').textContent !== 'Loading the world…', { timeout: 60000 });
await page.waitForTimeout(800);
const sheet = await page.evaluate(() => {
  const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
  return {
    vw: innerWidth, vh: innerHeight,
    modal: box('#claim-modal-content'), map: box('#claim-map-canvas'), confirm: box('#claim-confirm-btn'), refresh: box('#claim-refresh-btn'),
    hint: box('#claim-hint'), selection: box('#claim-selection-name'),
  };
});
console.log('Claim sheet 844x390:', JSON.stringify(sheet));
check(sheet.map.w >= 200 && sheet.map.h >= 200, `the map is at least 200px a side (${Math.round(sheet.map.w)}x${Math.round(sheet.map.h)})`);
check(sheet.modal.bottom <= sheet.vh && sheet.modal.right <= sheet.vw, 'the sheet is inside the screen');
check(sheet.confirm.bottom <= sheet.vh && sheet.refresh.bottom <= sheet.vh, `the Claim and Refresh buttons are on the screen (${Math.round(sheet.confirm.bottom)}, ${Math.round(sheet.refresh.bottom)})`);
check(sheet.hint.x >= sheet.map.right - 1, 'the words sit beside the map, not over it');

// A lándlet can be chosen on that map and claimed.
await claimLandlet(page);
await page.waitForTimeout(1500);
check((await page.locator('#claim-modal.visible').count()) === 0, 'the sheet closes once a lándlet is claimed');

await finish(browser, { pass, label: 'Claim sheet on a short screen', errors });
