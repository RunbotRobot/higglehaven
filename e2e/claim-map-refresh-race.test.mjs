// Regression coverage for #125: loadLandletMap (the claim-modal's overhead
// flyover) had no re-entrancy guard against rapid Refresh clicks. Two
// overlapping calls could each build a full Three.js scene, attach their
// own canvas click listener and window resize listener, and race to
// overwrite the shared claimFlyover reference — leaking one call's
// listeners/RAF loop forever and risking a click resolving against a stale
// plotMeshes array. Firing Refresh several times back-to-back (before any
// of the underlying fetches can resolve) is what actually exercises that
// race; a single click never would.
import { launchPage, chooseIdentity, growWorldAsAdmin, finish } from './helpers.mjs';

const LABEL = 'Claim Race Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await page.waitForSelector('#claim-modal.visible', { timeout: 10000 });
await page.waitForTimeout(2000);
const status = await page.textContent('#claim-status');
if (status?.includes('check back again shortly')) {
  await growWorldAsAdmin();
  await page.click('#claim-refresh-btn');
  await page.waitForTimeout(2000);
}

// Fire the race: several Refresh clicks with no wait in between, so their
// loadLandletMap() calls' fetches are all in flight simultaneously. Each
// page.click() resolves once the click event has fired (synchronous work
// only — the fetch itself is what's async), so Promise.all here doesn't
// wait for any of them to actually finish loading.
await Promise.all([
  page.click('#claim-refresh-btn'),
  page.click('#claim-refresh-btn'),
  page.click('#claim-refresh-btn'),
]);
await page.waitForTimeout(3000); // let every in-flight load settle

// The ordinary claim flow should still work exactly as if only one Refresh
// had ever been clicked — a fixed guard means whichever load was actually
// last wins outright, with no leftover listener from an earlier one able
// to interfere.
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
console.log('selected an available plot after the refresh race (should be true):', selectedAvailable);

await page.click('#claim-confirm-btn');
await page.waitForTimeout(2500);
const claimedThrough = await page.waitForSelector('#account-menu-toggle', { timeout: 10000 }).then(() => true).catch(() => false);
console.log('claim completed after the refresh race (should be true):', claimedThrough);

const pass = selectedAvailable && claimedThrough && errors.length === 0;
await finish(browser, { pass, label: 'claim-map-refresh-race', errors });
