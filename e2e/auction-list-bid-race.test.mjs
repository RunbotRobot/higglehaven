// Regression test for #2016: renderAuctionList() (src/main.js, the "Active
// Auctions" world-wide list in Settings' Build tab) had no stale-response
// guard, unlike its sibling renderForLandlet() in the exact same panel
// (#442, see e2e/auction-picker-race.test.mjs). Each auction row's own
// "Place Bid" button only disables itself, not the whole panel or any other
// row, so two overlapping renderAuctionList() reloads (one per bid) can
// race: whichever fetchAllAuctions() round-trip resolves last wins the
// repaint, regardless of which one was actually issued most recently.
//
// Reproducing this deterministically through two independent live UI bids
// turns out to be fragile for two separate reasons (both confirmed
// empirically while writing this test):
//   - renderAuctionList() wipes the ENTIRE .auction-list to "Loading…" the
//     instant *any* bid's own reload starts, synchronously, before its own
//     fetch even goes out -- so a second row's input/button can go briefly
//     detached or get rebuilt empty mid-flight, serializing the two bids
//     rather than racing them if driven through separate Playwright
//     locator fill()/click() calls (each with its own slow actionability
//     wait).
//   - Even firing both bids at once, whichever one's own reload GET happens
//     to reach the server *after* the other bid has already committed
//     stops being a stale snapshot at all -- it's simply current data that
//     arrives late, which buggy code renders perfectly correctly. The two
//     bids' own POSTs resolving in a different order than they were
//     clicked (plausible under real network/server timing) silently
//     defeats the test.
//
// So instead of racing two live bid clicks against each other, this test
// takes direct control of the ordering: auction B's own placeBid POST is
// intercepted and held in-flight (never even reaching the server) until
// *after* auction A's reload has already dispatched and captured its own
// snapshot -- guaranteeing that snapshot is genuinely from before B's bid,
// not just a data point that happens to arrive late. Steps:
//   1. Fill both bid inputs and fire both "Place Bid" clicks back-to-back
//      via a single synchronous in-page evaluate() (so neither click has to
//      survive a DOM wipe triggered by the other -- see first bullet
//      above).
//   2. A's own placeBid POST is unimpeded and resolves normally, so A's own
//      renderAuctionList() reload fires. That reload's GET is intercepted:
//      its *request* is dispatched immediately via route.fetch() (so its
//      snapshot captures "A bid placed, B still unbid" -- true at this
//      point, since B's POST is being held), but *delivering* that
//      response back to the page is delayed via route.fulfill().
//   3. B's own placeBid POST, meanwhile, is held by a second route
//      interceptor and not forwarded at all until step 2's snapshot has
//      definitely been captured (synchronized via an in-test promise the
//      route handler resolves right after its own route.fetch() call).
//   4. Once that's confirmed, B's held POST is released. It resolves
//      normally, committing B's bid server-side and triggering B's own
//      renderAuctionList() reload -- not intercepted, so it's fast and
//      renders the fresh state (A=$15, B=$25) correctly.
//   5. A's still-delayed response from step 2 finally lands. Buggy code
//      unconditionally repaints with that stale (A-only) snapshot,
//      reverting B's row back to "no bids yet, starts at $20.00" even
//      though a newer render already showed its $25 bid. The fix's token
//      guard discards it instead.
import {
  launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish,
  grantLandCapHeadroomAsAdmin, grantHigglesAsAdmin,
} from './helpers.mjs';

const SELLER_A = 'Auction List Race Seller A';
const SELLER_B = 'Auction List Race Seller B';
const BIDDER = 'Auction List Race Bidder';

const sellerASession = await launchPage({ promptAnswer: SELLER_A });
const sellerBSession = await launchPage({ promptAnswer: SELLER_B });
const bidderSession = await launchPage({ promptAnswer: BIDDER });
const errors = [...sellerASession.errors, ...sellerBSession.errors, ...bidderSession.errors];

async function startAuction(session, label, startingBidDollars) {
  const page = session.page;
  await chooseIdentity(page, { mode: 'build', label, isNew: true });
  await claimLandlet(page);
  await openAccountMenu(page);
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
  await page.click('.settings-tab-btn[data-section="build"]');
  const startForm = page.locator('.auction-start-form');
  await startForm.waitFor({ timeout: 10000 });
  await startForm.locator('input').nth(0).fill(String(startingBidDollars));
  await startForm.locator('input').nth(1).fill('1'); // duration 1 hour
  await page.click('.auction-start-btn');
  await page.waitForFunction(
    () => document.querySelector('.settings-field .auction-row')?.textContent.includes('Your auction is live'),
    null,
    { timeout: 30000 },
  );
  await page.click('#settings-close-btn');
}

await startAuction(sellerASession, SELLER_A, 10);
await startAuction(sellerBSession, SELLER_B, 20);

const bidderPage = bidderSession.page;
await chooseIdentity(bidderPage, { mode: 'build', label: BIDDER, isNew: true });
await claimLandlet(bidderPage);

const bidderBuilderId = await bidderPage.evaluate(() => fetch('/api/builders/me').then((r) => r.json()).then((body) => body.builder.builderId));
await grantLandCapHeadroomAsAdmin(bidderBuilderId);
await grantHigglesAsAdmin(bidderBuilderId);

await openAccountMenu(bidderPage);
await bidderPage.click('#settings-btn');
await bidderPage.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await bidderPage.click('.settings-tab-btn[data-section="build"]');

const auctionRowA = bidderPage.locator('.auction-list .auction-row', { hasText: '$10.00' });
const auctionRowB = bidderPage.locator('.auction-list .auction-row', { hasText: '$20.00' });
await auctionRowA.waitFor({ timeout: 10000 });
await auctionRowB.waitFor({ timeout: 10000 });
console.log('both sellers\' auctions visible in the world-wide list before any bid (should be true):', (await auctionRowA.count()) === 1 && (await auctionRowB.count()) === 1);

const { auctions: activeAuctions } = await bidderPage.evaluate(() => fetch('/api/auctions?status=active&limit=100').then((r) => r.json()));
const auctionIdB = activeAuctions.find((a) => a.startingBidCents === 2000).auctionId;

// Hold B's own placeBid POST in-flight -- it never reaches the server at
// all until releaseB() is called below.
let releaseB;
const bHeld = new Promise((resolve) => { releaseB = resolve; });
await bidderPage.route(`**/api/auctions/${auctionIdB}/bids`, async (route) => {
  await bHeld;
  await route.continue();
});

// A plain glob here would also match the unrelated per-landlet auction
// check (?status=active&landletId=...) that renderStartSection fires right
// after every bid, and that one can win the "first match" race instead of
// the world-wide list's own ?status=active&limit=100 reload this test
// actually needs to delay (confirmed empirically). Match the exact query
// precisely instead.
const isWorldListReload = (url) => {
  const parsed = new URL(url);
  return parsed.pathname === '/api/auctions'
    && parsed.searchParams.get('status') === 'active'
    && parsed.searchParams.get('limit') === '100'
    && !parsed.searchParams.has('landletId');
};
let snapshotCaptured;
const aSnapshotCaptured = new Promise((resolve) => { snapshotCaptured = resolve; });
let delayedOne = false;
await bidderPage.route((url) => isWorldListReload(url.toString()), async (route) => {
  if (!delayedOne) {
    delayedOne = true;
    const response = await route.fetch();
    snapshotCaptured();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    await route.fulfill({ response });
    return;
  }
  await route.continue();
});

// Fire both "Place Bid" clicks back-to-back in one synchronous browser
// task -- see the big comment above for why.
await bidderPage.evaluate(() => {
  const rows = [...document.querySelectorAll('.auction-list .auction-row')];
  const rowA = rows.find((r) => r.textContent.includes('$10.00'));
  const rowB = rows.find((r) => r.textContent.includes('$20.00'));
  rowA.querySelector('.auction-row-bid-input').value = '15';
  rowB.querySelector('.auction-row-bid-input').value = '25';
  rowA.querySelector('.auction-bid-btn').click();
  rowB.querySelector('.auction-bid-btn').click();
});

// Don't release B's bid until A's reload has genuinely captured its own
// (at this point still B-less) snapshot.
await aSnapshotCaptured;
releaseB();

// B's own reload (unimpeded) should now show both fresh bids.
await bidderPage.waitForFunction(
  () => {
    const rows = [...document.querySelectorAll('.auction-list .auction-row')].map((r) => r.textContent);
    return rows.some((t) => t.includes('high bid $15.00')) && rows.some((t) => t.includes('high bid $25.00'));
  },
  null,
  { timeout: 30000 },
);
// Note: formatAuctionSummary's own "stays yours at $X if unsold" outcome
// text always echoes each auction's *starting* bid (startingBidCents),
// never the current highest bid -- so auction B's row legitimately keeps
// saying "$20.00" in that clause forever, bid or no bid. The staleness
// signal checked below is the *bid* text ("high bid $X" vs "no bids yet,
// starts at $X"), not a blanket absence of the starting-bid string.
const rightAfterBidsText = await bidderPage.locator('.auction-list').textContent();
console.log('both fresh bids visible right after B\'s own (fast) reload (should mention high bid $15.00 and $25.00):', rightAfterBidsText.includes('high bid $15.00') && rightAfterBidsText.includes('high bid $25.00'));

// Now wait out A's stale, delayed reload too.
await bidderPage.waitForTimeout(2200);

const finalText = await bidderPage.locator('.auction-list').textContent();
console.log('bids still show high bid $15.00 and $25.00 after A\'s stale reload lands (should be true, not reverted to "no bids yet"):', finalText.includes('high bid $15.00') && finalText.includes('high bid $25.00'));
console.log('no stale "no bids yet, starts at $20.00" (B\'s pre-bid snapshot) resurfaced:', !finalText.includes('no bids yet, starts at $20.00'));

const pass = finalText.includes('high bid $15.00') &&
  finalText.includes('high bid $25.00') &&
  !finalText.includes('no bids yet, starts at $20.00') &&
  errors.length === 0;
await finish(bidderSession.browser, {
  pass,
  label: '#2016: a stale, delayed Active-Auctions-list reload does not clobber a fresher bid rendered in the meantime',
  errors,
});
await sellerASession.browser.close();
await sellerBSession.browser.close();
