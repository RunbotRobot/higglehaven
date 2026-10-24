// #2402: the Admin Dashboard's landlet override panel (#1822) auction-conflict
// dialog interpolates the active auction's `endsAt` as a raw ISO-8601 instant
// (e.g. "...ends 2026-11-02T14:00:00.000Z.") instead of formatting it, the
// same bug class #2396/#2397 already fixed for the cents half of this exact
// line. This codebase has an established precedent for formatting exactly
// this concept -- src/main.js's formatAuctionTimeRemaining/formatAuctionSummary
// for an auction's own endsAt, and #2352's handleSuspendAccount fix for a
// different *EndsAt field -- so the fix runs the raw instant through
// `new Date(...).toLocaleString()` before display.
//
// Sets up a real active auction entirely via direct fetch calls from an
// ordinary builder session (same approach #2397's cents test uses), then
// drives the actual admin-dashboard reassign flow through the real UI to
// trigger the 409, asserting the dialog shows the formatted endsAt rather
// than the raw ISO instant the server actually returned.
import {
  launchPage, chooseIdentity, ensureAdminSession, finish,
  createGreenbeltLandletAsAdmin,
} from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const suffix = Date.now().toString(36);
const LANDLET_ID = `e2e-landlet-auction-conflict-endsat-${suffix}`;

await createGreenbeltLandletAsAdmin(LANDLET_ID);

const sellerSession = await launchPage({ promptAnswer: 'Conflict EndsAt Seller' });
const otherSession = await launchPage({ promptAnswer: 'Conflict EndsAt Other' });

const sellerPage = sellerSession.page;
await chooseIdentity(sellerPage, { mode: 'build', label: 'Conflict EndsAt Seller', isNew: true });

const otherPage = otherSession.page;
await chooseIdentity(otherPage, { mode: 'build', label: 'Conflict EndsAt Other', isNew: true });
// reassign-owner rejects a reassignment to the landlet's current owner
// before it ever reaches the auction-conflict check (worker/index.js:
// "Landlet is already owned by this builder") -- the reassign target must
// be a genuinely different, but real (requireBuilder validates it exists),
// builder for the request to reach the 409 this test is about.
const otherBuilderId = await otherPage.evaluate(() => fetch('/api/builders/me').then((r) => r.json()).then((body) => body.builder.builderId));

const claimResult = await sellerPage.evaluate(
  (landletId) => fetch('/api/landlets/' + landletId + '/claim', { method: 'POST' }).then((r) => r.status),
  LANDLET_ID,
);
console.log('seller claim status (should be 200):', claimResult);

const { auctionId, rawEndsAt } = await sellerPage.evaluate(
  (landletId) => fetch('/api/landlets/' + landletId + '/auction', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ startingBidCents: 0 }),
  }).then((r) => r.json()).then((body) => ({ auctionId: body.auction.auctionId, rawEndsAt: body.auction.endsAt })),
  LANDLET_ID,
);
console.log('auction started, id:', auctionId, 'raw endsAt:', rawEndsAt);

// --- Now the actual thing under test: the admin dashboard's own reassign
// flow, hitting the real 409 activeAuction conflict and rendering it. ---
const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

const browser = sellerSession.browser;
const adminPage = await browser.newPage();
const adminErrors = [];
adminPage.on('pageerror', (err) => adminErrors.push(err.message));
adminPage.on('console', (msg) => { if (msg.type() === 'error') adminErrors.push(msg.text()); });
await adminPage.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

await adminPage.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await adminPage.click('button[data-panel="landlets"]');
await adminPage.fill('#landletLookupInput', LANDLET_ID);
await adminPage.click('#landletLookupBtn');
await adminPage.waitForFunction(
  (id) => document.getElementById('landletStatGrid')?.textContent.includes(id),
  LANDLET_ID,
  { timeout: 10000 },
);

await adminPage.fill('#landletReassignTargetInput', otherBuilderId);
await adminPage.click('#landletReassignBtn');
await adminPage.waitForFunction(
  () => !document.getElementById('landletAuctionConflictWrap').hidden,
  null,
  { timeout: 10000 },
);
const auctionDetailsText = await adminPage.textContent('#landletAuctionDetails');
console.log('auction conflict details text:', auctionDetailsText.trim());

// The deliberate 409 above (triggering the conflict path on purpose) makes
// Chromium log a "Failed to load resource: 409" console error independent
// of this page's own handling -- the same established, expected side
// effect admin-dashboard-accounts-panel.test.mjs and others already filter.
// Assembled here, after every interaction has happened, rather than at
// launch time -- #2735: a spread copy taken right after launchPage() would
// freeze on the still-empty source arrays and never see a real error.
const errors = [
  ...sellerSession.errors,
  ...otherSession.errors,
  ...adminErrors.filter((e) => !e.includes('Failed to load resource')),
];

// The admin page and this test script run in the same container, so
// formatting the same raw instant the same way (`toLocaleString()`) in
// Node produces the same string Chromium renders.
const expectedFormatted = new Date(rawEndsAt).toLocaleString();
const showsFormattedEndsAt = auctionDetailsText.includes(expectedFormatted);
const noRawIsoInstant = !auctionDetailsText.includes(rawEndsAt);

const pass =
  claimResult === 200 &&
  !!auctionId &&
  showsFormattedEndsAt &&
  noRawIsoInstant &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Admin Dashboard landlet panel (#2402): active-auction conflict dialog shows formatted endsAt, not the raw ISO instant',
  errors,
});
