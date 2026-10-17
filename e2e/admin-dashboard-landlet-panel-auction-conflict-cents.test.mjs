// #2396: the Admin Dashboard's landlet override panel (#1822) shows the
// active-auction conflict's startingBidCents/highBidCents as raw cents with
// a literal "¢" suffix instead of converting to dollars -- e.g. a $1,500.00
// bid rendered as "150000¢". worker/land.test.js already covers the real
// server-side 409/activeAuction payload itself (raw cents, by design -- see
// docs/API.md); this is the one thing that suite can't reach: the real
// static admin page's own client-side formatting of that payload, same
// "needs a real e2e check" reasoning admin-dashboard-landlet-panel.test.mjs's
// own header comment gives for the rest of this panel.
//
// Sets up a real active auction with a real bid entirely via direct fetch
// calls from two ordinary builder sessions (not the full Settings-modal UI
// flow e2e/land-auctions.test.mjs exercises -- that's already covered
// there; this test only cares about what the admin dashboard does with the
// resulting 409 payload), then drives the actual admin-dashboard reassign
// flow through the real UI to trigger it.
import {
  launchPage, chooseIdentity, ensureAdminSession, finish,
  createGreenbeltLandletAsAdmin, grantLandCapHeadroomAsAdmin, grantHigglesAsAdmin,
} from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const suffix = Date.now().toString(36);
const LANDLET_ID = `e2e-landlet-auction-conflict-cents-${suffix}`;
const STARTING_BID_CENTS = 1500; // $15.00
const BID_AMOUNT_CENTS = 2000; // $20.00

await createGreenbeltLandletAsAdmin(LANDLET_ID);

const sellerSession = await launchPage({ promptAnswer: 'Conflict Cents Seller' });
const bidderSession = await launchPage({ promptAnswer: 'Conflict Cents Bidder' });
const errors = [...sellerSession.errors, ...bidderSession.errors];

const sellerPage = sellerSession.page;
await chooseIdentity(sellerPage, { mode: 'build', label: 'Conflict Cents Seller', isNew: true });
const sellerBuilderId = await sellerPage.evaluate(() => fetch('/api/builders/me').then((r) => r.json()).then((body) => body.builder.builderId));

const bidderPage = bidderSession.page;
await chooseIdentity(bidderPage, { mode: 'build', label: 'Conflict Cents Bidder', isNew: true });
const bidderBuilderId = await bidderPage.evaluate(() => fetch('/api/builders/me').then((r) => r.json()).then((body) => body.builder.builderId));
// #489/#629: bidding needs land cap headroom and enough higgles to cover
// the bid -- same fixture grants e2e/land-auctions.test.mjs already needs
// for the identical reason, not what this test is actually about.
await grantLandCapHeadroomAsAdmin(bidderBuilderId);
await grantHigglesAsAdmin(bidderBuilderId);

// Seller claims the known-id landlet, then starts an auction on it with a
// real, non-round starting bid -- real money math, not round-number luck.
const claimResult = await sellerPage.evaluate(
  (landletId) => fetch('/api/landlets/' + landletId + '/claim', { method: 'POST' }).then((r) => r.status),
  LANDLET_ID,
);
console.log('seller claim status (should be 200):', claimResult);

const auctionId = await sellerPage.evaluate(
  ({ landletId, startingBidCents }) => fetch('/api/landlets/' + landletId + '/auction', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ startingBidCents }),
  }).then((r) => r.json()).then((body) => body.auction.auctionId),
  { landletId: LANDLET_ID, startingBidCents: STARTING_BID_CENTS },
);
console.log('auction started, id:', auctionId);

const bidResult = await bidderPage.evaluate(
  ({ auctionId, amountCents }) => fetch('/api/auctions/' + auctionId + '/bids', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amountCents }),
  }).then((r) => r.status),
  { auctionId, amountCents: BID_AMOUNT_CENTS },
);
console.log('bid placed status (should be 201):', bidResult);

// --- Now the actual thing under test: the admin dashboard's own reassign
// flow, hitting the real 409 activeAuction conflict and rendering it. ---
const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

const browser = sellerSession.browser;
const adminPage = await browser.newPage();
adminPage.on('pageerror', (err) => errors.push(err.message));
adminPage.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
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

const reassignWrapVisibleBeforeAttempt = await adminPage.locator('#landletReassignWrap').isVisible();
console.log('reassign section visible for a claimed landlet (should be true):', reassignWrapVisibleBeforeAttempt);

await adminPage.fill('#landletReassignTargetInput', bidderBuilderId);
await adminPage.click('#landletReassignBtn');
await adminPage.waitForFunction(
  () => !document.getElementById('landletAuctionConflictWrap').hidden,
  null,
  { timeout: 10000 },
);
const auctionDetailsText = await adminPage.textContent('#landletAuctionDetails');
console.log('auction conflict details text (should show $15.00 and $20.00, not raw cents):', auctionDetailsText.trim());

// The deliberate 409 above (triggering the conflict path on purpose) makes
// Chromium log a "Failed to load resource: 409" console error independent
// of this page's own handling -- the same established, expected side
// effect admin-dashboard-accounts-panel.test.mjs and others already filter.
errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('Failed to load resource')));

const showsStartingBidInDollars = auctionDetailsText.includes('$15.00');
const showsHighBidInDollars = auctionDetailsText.includes('$20.00');
const noRawCentsSuffix = !auctionDetailsText.includes('¢');

const pass =
  reassignWrapVisibleBeforeAttempt &&
  claimResult === 200 &&
  bidResult === 201 &&
  showsStartingBidInDollars &&
  showsHighBidInDollars &&
  noRawCentsSuffix &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Admin Dashboard landlet panel (#2396): active-auction conflict dialog shows dollar-formatted amounts, not raw cents',
  errors,
});
