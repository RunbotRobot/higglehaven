// Regression coverage for #545: syncCreate/syncUpdate/syncDelete are
// fire-and-forget and used to give the builder no signal at all when a
// write failed to reach the server. Owner-confirmed UX (Control Room): a
// small icon in the corner, shown only while the server is genuinely
// unreachable, that explains itself on tap — see setServerReachable in
// src/main.js and api.js's requestJson (isConnectivityFailure).
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Connectivity Indicator Suite Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

const placeItem = async (x, y) => {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').first().click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
};

const indicatorHidden = () => page.isHidden('#connectivity-indicator');

const hiddenBeforeAnything = await indicatorHidden();
console.log('indicator hidden before any sync attempt (should be true):', hiddenBeforeAnything);

// A genuine connectivity failure (route.abort() makes the underlying fetch
// itself throw, exactly like a real offline/DNS failure) should show the
// icon.
await page.route('**/api/instances', (route) => route.abort());
await placeItem(180, 380);
const hiddenAfterConnectivityFailure = await indicatorHidden();
console.log('indicator visible after a connectivity failure (should be false):', hiddenAfterConnectivityFailure);

await page.click('#connectivity-indicator');
const panelText = (await page.textContent('#connectivity-indicator-panel')) || '';
console.log('clicking the icon shows an explanation (should be non-empty):', JSON.stringify(panelText.trim()));

// Recover first (a successful sync clears the icon), THEN check that a
// real rejection from a reachable server (a 4xx) never re-shows it — a
// reachable server legitimately rejecting a request isn't a connectivity
// problem, so the icon must not claim it's unreachable.
await page.unroute('**/api/instances');
await placeItem(200, 390);
const hiddenAfterRecoveryBeforeRejection = await indicatorHidden();
console.log('indicator hidden once a sync succeeds (should be true):', hiddenAfterRecoveryBeforeRejection);

await page.route('**/api/instances', (route) => route.fulfill({
  status: 400,
  contentType: 'application/json',
  body: JSON.stringify({ error: 'simulated validation rejection' }),
}));
await placeItem(220, 400);
const hiddenAfterRejection = await indicatorHidden();
console.log('indicator stays hidden after a mere 4xx rejection (should be true):', hiddenAfterRejection);

// Once more: another real connectivity failure shows it again, and
// recovering clears it again.
await page.unroute('**/api/instances');
await page.route('**/api/instances', (route) => route.abort());
await placeItem(150, 420);
const hiddenBeforeRecovery = await indicatorHidden();
console.log('indicator visible again after another connectivity failure (should be false):', hiddenBeforeRecovery);
await page.unroute('**/api/instances');
await placeItem(260, 440);
const hiddenAfterRecovery = await indicatorHidden();
console.log('indicator hidden again once a sync succeeds (should be true):', hiddenAfterRecovery);

// Chromium logs every intercepted abort()/non-2xx response as its own
// "Failed to load resource" console error — an expected side effect of
// this test deliberately simulating both failure modes above, not a real
// page bug, so it's excluded from the pass/fail error check below.
const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));

const pass =
  hiddenBeforeAnything &&
  !hiddenAfterConnectivityFailure &&
  panelText.trim().length > 0 &&
  hiddenAfterRecoveryBeforeRejection &&
  hiddenAfterRejection &&
  !hiddenBeforeRecovery &&
  hiddenAfterRecovery &&
  unexpectedErrors.length === 0;
await finish(browser, { pass, label: '#545: connectivity indicator shows only for real connectivity failures, explains on tap, clears on recovery', errors: unexpectedErrors });
