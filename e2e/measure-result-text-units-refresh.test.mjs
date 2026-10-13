// #1939: refreshUnitDisplays() (src/main.js) updates the Trim gizmo's length
// field and the Seller modal the moment the Units preference changes, but
// never the Measure tool's own live result text (updateMeasureResultText(),
// only ever re-rendered by the drag handlers and a fresh measurement tap) --
// so an in-progress measurement keeps showing its stale, pre-change unit
// text until the builder touches it again.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Measure Units Refresh Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

await page.click('#toggle-measure');
await page.waitForFunction(() => document.getElementById('toggle-measure').classList.contains('active'));

// Two distinct ground taps -- same "known good ground click" coordinates
// (with a small offset for the second) every other build-mode e2e test in
// this suite already relies on to land a successful raycast hit.
await page.mouse.click(210, 400);
await page.waitForTimeout(300);
await page.mouse.click(230, 420);
await page.waitForTimeout(300);

const productInfoInMeters = await page.textContent('#product-info');
console.log('product-info right after measuring, default Meters (should contain "m", not "ft"):', productInfoInMeters);

// #settings-btn lives inside the collapsed account-menu panel -- open it
// first (same as a real user would).
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded', { timeout: 10000 });

// Settings opens on the Build tab while in Build mode (openSettingsModal's
// own currentMode -> activeSettingsTab logic) -- Units lives on General.
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 10000 });
await page.click('button[data-section="general"]');
await page.click('input[name="settings-units"][value="ft"]');
await page.waitForTimeout(300);
await page.click('#settings-close-btn');

const productInfoAfterUnitsChange = await page.textContent('#product-info');
console.log('product-info after switching Units to Feet, same measurement untouched (should now contain "ft", not "m"):', productInfoAfterUnitsChange);

const pass =
  productInfoInMeters.includes('m') && !productInfoInMeters.includes('ft') &&
  productInfoAfterUnitsChange.includes('ft') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1939: refreshUnitDisplays() keeps an in-progress Measure result in sync with a Units change',
  errors,
});
