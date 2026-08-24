// Core golden path: a brand-new builder claims a landlet, places a catalog
// item, and reloading the page (a new session, same builder) shows the
// placement persisted server-side rather than only living in memory.
import { launchPage, chooseIdentity, claimLandlet, clickUntilSelected, finish } from './helpers.mjs';

const LABEL = 'Smoke Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

// Place a built-in placeholder item (Tree) via the ordinary Add Item flow —
// no upload needed, keeps this test fast and independent of the
// optimize/upload pipeline (covered separately by seller-upload-and-resize).
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(1000);

const placedInfo = await page.textContent('#product-info');
console.log('product-info right after placing (should mention Tree):', placedInfo);
const placedImmediately = Boolean(placedInfo && placedInfo.includes('Tree'));

// Reload — a fresh page load, same builder — and confirm the placement was
// actually written to D1, not just held in the previous session's memory.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: false });
await page.waitForSelector('#identity-btn', { timeout: 10000 });
await page.waitForTimeout(2000);

// The camera's default position/target is deterministic across a reload
// (confirmed via #camera-debug-panel), but the tree's own clickable
// footprint on screen is smaller now that it's not wearing the selection
// gizmo/highlight that made a wider area hit it right after placing it —
// scan a small vertical range rather than retrying the exact same pixel.
const infoAfterReload = await clickUntilSelected(page, {
  x: 210, yStart: 330, yEnd: 400, expectedText: 'Tree',
});
const reselected = infoAfterReload.includes('Tree');
console.log('product-info after reload (should still mention Tree):', infoAfterReload);

const pass = placedImmediately && reselected && errors.length === 0;
await finish(browser, { pass, label: 'claim + place + reload persistence', errors });
