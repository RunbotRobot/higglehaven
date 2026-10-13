// #1821 (sub-issue of #1817): the World & land-candidates admin panel.
// Same "a unit test using the workers-pool ASSETS binding can't run a real
// vite build, so the /admin/... page-serving route itself needs a real e2e
// check" reasoning as e2e/admin-dashboard-page.test.mjs's own comment —
// worker/worker-api.test.js already covers every endpoint's own validation
// (overlap checks, immutability, concurrency retries); this only needs to
// exercise the real static panel end to end: it calls the right endpoints
// with the right field names and renders what comes back.
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
// Chromium logs a console error for every non-2xx fetch response on its
// own, regardless of whether the page's own code handles it gracefully --
// and this test deliberately provokes one expected 409 (Expand world, when
// the fresh world's greenbelt reserve already meets the threshold, per
// worker-api.test.js's own coverage of that exact branch). Filter only that
// specific, known-expected network-status log; a real app bug would still
// show up as a genuine pageerror or a different console.error call.
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  if (/Failed to load resource: the server responded with a status of 409/.test(msg.text())) return;
  errors.push(msg.text());
});
// generate-mosaic/-ring, expand, and delete-candidate all surface their
// result via alert()/confirm() -- auto-accept both like the shell test does.
page.on('dialog', (dialog) => dialog.accept());
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="world"]');
const worldPanelVisible = await page.locator('#panel-world').isVisible();
console.log('world panel visible after clicking its nav item (should be true):', worldPanelVisible);

// --- World settings load + edit ---
await page.waitForSelector('#worldSummary .stat-grid', { timeout: 10000 });
const radiusStatVisible = await page.locator('#worldSummary', { hasText: 'radiusM' }).isVisible();
console.log('world summary renders a radiusM stat (should be true):', radiusStatVisible);

const dayCycleBefore = await page.inputValue('#worldDayCycleInput');
const newDayCycle = String(Number(dayCycleBefore) + 1);
await page.click('details.edit-world summary'); // open the <details> disclosure
await page.fill('#worldDayCycleInput', newDayCycle);
await page.click('#worldSaveBtn');
await page.waitForFunction(
  (expected) => document.getElementById('worldDayCycleInput').value === expected,
  newDayCycle,
  { timeout: 10000 },
);
const dayCycleAfterSave = await page.inputValue('#worldDayCycleInput');
console.log('editing + saving world settings persists dayCycleHours (expected/actual):', newDayCycle, dayCycleAfterSave);

// Expand may succeed (greenbelt reserve below threshold) or 409 ("Greenbelt
// reserve is at or above the expansion threshold") depending on the fresh
// world's starting state -- either is a normal, expected outcome (the
// worker-api.test.js suite already covers both branches' own logic), so
// this just confirms the button calls the real endpoint and the UI surfaces
// whichever outcome comes back, without crashing either way.
const radiusBeforeExpand = await page.inputValue('#worldRadiusInput');
const [expandResponse] = await Promise.all([
  page.waitForResponse((resp) => resp.url().includes('/api/world/expand')),
  page.click('#worldExpandBtn'),
]);
await page.waitForTimeout(200); // let the response handler finish rendering
const radiusAfterExpand = await page.inputValue('#worldRadiusInput');
const expandErrorVisible = await page.locator('#worldErr').isVisible();
const expandOutcomeSurfaced = expandResponse.status() === 200
  ? radiusAfterExpand !== radiusBeforeExpand
  : expandErrorVisible;
console.log('Expand world button surfaces a clear outcome either way (status/outcome ok):', expandResponse.status(), expandOutcomeSurfaced);

// #1866: generateMosaic()/generateRing() used to silently no-op on a
// missing required input (a bare `if (!prefix) return;`, no showError())
// -- unlike saveWorld()/submitBatch() on this same panel, which both call
// showError() for their own bad-input case. Confirm both now surface a
// clear error instead of doing nothing.
await page.fill('#mosaicPrefixInput', '');
await page.click('#mosaicGenerateBtn');
const mosaicMissingPrefixError = await page.textContent('#worldErr');
console.log('Generate mosaic with a blank prefix shows an error (should mention "required"):', mosaicMissingPrefixError);

await page.fill('#ringPrefixInput', '');
await page.fill('#ringCountInput', '');
await page.click('#ringGenerateBtn');
const ringMissingInputError = await page.textContent('#worldErr');
console.log('Generate ring with blank prefix/count shows an error (should mention "required"):', ringMissingInputError);

// --- Generate mosaic ---
const mosaicPrefix = `e2e-mosaic-${crypto.randomUUID().slice(0, 8)}`;
await page.fill('#mosaicPrefixInput', mosaicPrefix);
await page.click('#mosaicGenerateBtn');
await page.waitForSelector(`#candidatesTableWrap td.mono:has-text("${mosaicPrefix}")`, { timeout: 15000 }).catch(() => {});
const mosaicCandidateVisible = await page.locator('#candidatesTableWrap', { hasText: mosaicPrefix }).isVisible();
console.log('generated mosaic candidates show up in the candidates table (should be true):', mosaicCandidateVisible);

// --- Generate ring ---
const ringPrefix = `e2e-ring-${crypto.randomUUID().slice(0, 8)}`;
await page.fill('#ringPrefixInput', ringPrefix);
await page.fill('#ringCountInput', '6');
// The mosaic just generated above is a 4x4 grid of 1,000m² cells centered
// on the origin, wide enough that its own outer cells land past the
// world's default radius -- the ring's default innerRadiusM (the current
// world radius) would then overlap those pending mosaic candidates and
// 409. An explicit, generous innerRadiusM clears the whole mosaic.
await page.fill('#ringInnerRadiusInput', '1000');
// #1865: generateRing() should refresh the World settings stats itself
// (like generateMosaic() already does), not leave them stale until the
// separate World "Refresh" button is clicked.
const [ringWorldRefresh] = await Promise.all([
  page.waitForResponse((resp) => resp.url().endsWith('/api/world') && resp.request().method() === 'GET', { timeout: 15000 }).catch(() => null),
  page.click('#ringGenerateBtn'),
]);
console.log('generating a ring refreshes World settings stats on its own (should be true):', !!ringWorldRefresh);
await page.click('#ringsRefreshBtn');
await page.waitForSelector(`#ringsTableWrap td.mono:has-text("${ringPrefix}")`, { timeout: 15000 }).catch(() => {});
const ringRow = page.locator('#ringsTableWrap tr', { has: page.locator('td.mono', { hasText: ringPrefix }) });
const ringRowVisible = await ringRow.isVisible();
console.log('generated ring shows up in the rings table (should be true):', ringRowVisible);

let ringDetailShowsLifecycleResult = false;
if (ringRowVisible) {
  await ringRow.locator('.ring-view-btn').click();
  await page.waitForSelector('#ringDetailWrap:not([hidden])', { timeout: 10000 });
  const ringDetailText = await page.textContent('#ringDetailBody');
  ringDetailShowsLifecycleResult = ringDetailText.includes('lifecycle') && ringDetailText.includes(ringPrefix);
  console.log('ring detail view shows lifecycle info for the right ring (should be true):', ringDetailShowsLifecycleResult);
  await page.click('#ringDetailCloseBtn');
}

// --- Batch-create a standalone pending candidate, far from the world
// origin so it's never auto-materialized, then edit and delete it through
// the UI (ring-member and materialized candidates are deliberately
// immutable server-side, so a plain batch-created candidate is the only
// shape that can actually exercise the Edit/Delete buttons end to end).
const farCandidateName = `E2E Far Candidate ${crypto.randomUUID().slice(0, 8)}`;
await page.fill('#batchInput', JSON.stringify([
  { name: farCandidateName, areaM2: 1000, center: { x: 50000, y: 0 } },
]));
// #1865: submitBatch() should refresh World settings stats too, same
// reasoning as the ring-generate check above.
const [batchWorldRefresh] = await Promise.all([
  page.waitForResponse((resp) => resp.url().endsWith('/api/world') && resp.request().method() === 'GET', { timeout: 15000 }).catch(() => null),
  page.click('#batchSubmitBtn'),
]);
console.log('submitting a batch refreshes World settings stats on its own (should be true):', !!batchWorldRefresh);
await page.waitForSelector(`#candidatesTableWrap:has-text("${farCandidateName}")`, { timeout: 15000 }).catch(() => {});
const farCandidateRow = page.locator('#candidatesTableWrap tr', { has: page.locator('td', { hasText: farCandidateName }) });
const farCandidateVisible = await farCandidateRow.isVisible();
console.log('batch-created far candidate shows up in the candidates table (should be true):', farCandidateVisible);

let renamedCandidateVisible = false;
let deletedCandidateGone = false;
if (farCandidateVisible) {
  await farCandidateRow.locator('.candidate-edit-btn').click();
  await page.waitForSelector('#candidateEditWrap:not([hidden])', { timeout: 10000 });
  const editedName = farCandidateName + ' (edited)';
  const currentJson = await page.inputValue('#candidateEditInput');
  const patched = { ...JSON.parse(currentJson), name: editedName };
  await page.fill('#candidateEditInput', JSON.stringify(patched));
  await page.click('#candidateEditSaveBtn');
  const renamedRow = page.locator('#candidatesTableWrap tr', { has: page.locator('td', { hasText: editedName }) });
  await renamedRow.waitFor({ timeout: 10000 });
  renamedCandidateVisible = await renamedRow.isVisible();
  console.log('editing the far candidate through the UI persists its new name (should be true):', renamedCandidateVisible);

  await renamedRow.locator('.candidate-delete-btn').click();
  await renamedRow.waitFor({ state: 'detached', timeout: 10000 });
  deletedCandidateGone = await page.locator('#candidatesTableWrap', { hasText: editedName }).count() === 0;
  console.log('deleting the far candidate through the UI removes it from the table (should be true):', deletedCandidateGone);
}

const pass = worldPanelVisible &&
  radiusStatVisible &&
  dayCycleAfterSave === newDayCycle &&
  expandOutcomeSurfaced &&
  mosaicMissingPrefixError.includes('required') &&
  ringMissingInputError.includes('required') &&
  mosaicCandidateVisible &&
  !!ringWorldRefresh &&
  ringRowVisible &&
  ringDetailShowsLifecycleResult &&
  farCandidateVisible &&
  !!batchWorldRefresh &&
  renamedCandidateVisible &&
  deletedCandidateGone &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Admin Dashboard world & land-candidates panel (#1821): world settings view/edit, generate mosaic/ring (incl. #1865\'s auto-refresh), ring details, and candidate browse/edit/delete all work end to end',
  errors,
});
