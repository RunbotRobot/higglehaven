// #1822 (sub-issue of #1817): the landlet override panel — look up a
// landlet by id, force-complete a stuck `generating` one, or reassign a
// claimed one's owner by hand. The server-side endpoints themselves
// (POST /api/landlets/:id/generation-complete, .../reassign-owner) are
// already covered by worker/land.test.js; this exercises the real static
// page's own client-side wiring, same "a unit test using the workers-pool
// ASSETS binding can't run a real vite build" reasoning
// admin-dashboard-page.test.mjs's own comment already gives.
//
// Focus: #1888 — force-completing a landlet the world circle doesn't yet
// fully enclose succeeds (sets generatedAt) but leaves status: 'generating'
// by design, and the panel used to give no sign anything happened at all.
import { chromium } from 'playwright';
import { createGeneratingLandletAsAdmin, ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

const suffix = Date.now().toString(36);
const FAR_LANDLET_ID = `e2e-landlet-far-${suffix}`;
const ENCLOSED_LANDLET_ID = `e2e-landlet-enclosed-${suffix}`;

// Far enough from the origin that landletMaxWorldRadius (worker/geometry.js:
// hypot(center) + sameAreaRadius(areaM2), no polygon) exceeds any real test
// world's own radiusM (seeded at ~31.6m) by a huge margin -- guarantees
// generation-complete leaves this one still 'generating'.
await createGeneratingLandletAsAdmin(FAR_LANDLET_ID, { center: { x: 500000, y: 0 } });
// Centered at the origin -- always enclosed by any positive world radius,
// so generation-complete should promote this one straight to greenbelt.
await createGeneratingLandletAsAdmin(ENCLOSED_LANDLET_ID, { center: { x: 0, y: 0 } });

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="landlets"]');
const panelVisible = await page.locator('#panel-landlets').isVisible();
console.log('landlets panel visible after clicking its nav item (should be true):', panelVisible);

async function lookup(landletId) {
  await page.fill('#landletLookupInput', landletId);
  await page.click('#landletLookupBtn');
  await page.waitForFunction(
    (id) => document.getElementById('landletStatGrid')?.textContent.includes(id),
    landletId,
    { timeout: 10000 },
  );
}

// --- Not-yet-enclosed landlet: force-complete should leave it visibly
// still "generating" with an explanatory note, not a silent no-op. ---
await lookup(FAR_LANDLET_ID);
const farBtnVisibleBeforeClick = await page.locator('#landletForceCompleteBtn').isVisible();
const farNoteHiddenBeforeClick = await page.locator('#landletForceCompleteNote').isHidden();
console.log('force-complete button visible for the far (generating) landlet before clicking (should be true):', farBtnVisibleBeforeClick);
console.log('force-complete note hidden before clicking (should be true):', farNoteHiddenBeforeClick);

await page.click('#landletForceCompleteBtn');
await page.waitForFunction(
  () => !document.getElementById('landletForceCompleteNote').hidden,
  { timeout: 10000 },
);
const farStatusAfterClick = await page.locator('#landletStatGrid').textContent();
const farNoteText = await page.textContent('#landletForceCompleteNote');
const farBtnStillVisibleAfterClick = await page.locator('#landletForceCompleteBtn').isVisible();
console.log('far landlet status after force-complete (should still say generating):', farStatusAfterClick.trim());
console.log('explanatory note text (should mention greenbelt/world expansion):', farNoteText.trim());
console.log('force-complete button still visible after click (should be true, still generating):', farBtnStillVisibleAfterClick);

// A fresh lookup resets the note -- it's tied to the force-complete click
// that just happened, not a persistent fact about the landlet. Wait on the
// note's own hidden state directly, not just the stat grid containing the
// id -- that text was already there from the previous step, so it can't
// tell "re-rendered" apart from "hasn't changed yet".
await lookup(FAR_LANDLET_ID);
await page.waitForFunction(
  () => document.getElementById('landletForceCompleteNote').hidden,
  { timeout: 10000 },
);
const farNoteHiddenAfterFreshLookup = await page.locator('#landletForceCompleteNote').isHidden();
console.log('note hidden again after a fresh lookup (should be true):', farNoteHiddenAfterFreshLookup);

// --- Already-enclosed landlet: force-complete should promote it straight
// to greenbelt, hide the force-complete section, and never show the note. ---
await lookup(ENCLOSED_LANDLET_ID);
await page.click('#landletForceCompleteBtn');
await page.waitForFunction(
  () => document.getElementById('landletStatGrid')?.textContent.includes('greenbelt'),
  { timeout: 10000 },
);
const enclosedBtnHiddenAfterClick = await page.locator('#landletForceCompleteBtn').isHidden();
const enclosedNoteHiddenAfterClick = await page.locator('#landletForceCompleteNote').isHidden();
console.log('force-complete button hidden after promoting to greenbelt (should be true):', enclosedBtnHiddenAfterClick);
console.log('note never shown for the enclosed landlet (should be true):', enclosedNoteHiddenAfterClick);

const pass =
  panelVisible &&
  farBtnVisibleBeforeClick &&
  farNoteHiddenBeforeClick &&
  farStatusAfterClick.includes('generating') &&
  /greenbelt|world expansion/i.test(farNoteText) &&
  farBtnStillVisibleAfterClick &&
  farNoteHiddenAfterFreshLookup &&
  enclosedBtnHiddenAfterClick &&
  enclosedNoteHiddenAfterClick &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Admin Dashboard landlet override panel (#1822): force-complete on a not-yet-enclosed landlet surfaces an explanatory note instead of a silent no-op (#1888)',
  errors,
});
