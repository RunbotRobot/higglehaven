// Notifications pagination (issue #320): GET /api/notifications now
// cursor-paginates instead of a flat, un-pageable 100-row cap, and the
// Notices modal gets a "Load more" button once a builder has more
// notifications than one page (src/main.js's NOTIFICATIONS_PAGE_SIZE = 20).
// Bids are placed directly via fetch (not the real bid-form UI) purely to
// generate enough notifications fast — the UI surface actually under test
// here is the Notices modal's pagination, not the bidding flow itself
// (already covered end to end by e2e/land-auctions.test.mjs).
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const OWNER = 'Notifications Suite Owner';
const BIDDER = 'Notifications Suite Bidder';

const ownerSession = await launchPage({ promptAnswer: OWNER });
const bidderSession = await launchPage({ promptAnswer: BIDDER });
const errors = [...ownerSession.errors, ...bidderSession.errors];

const ownerPage = ownerSession.page;
const bidderPage = bidderSession.page;

await chooseIdentity(ownerPage, { mode: 'build', label: OWNER, isNew: true });
await claimLandlet(ownerPage);
await chooseIdentity(bidderPage, { mode: 'build', label: BIDDER, isNew: true });
await claimLandlet(bidderPage);

async function fetchJson(page, path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

const ownerMe = await fetchJson(ownerPage, '/api/builders/me');
const ownedList = await fetchJson(ownerPage, `/api/landlets?status=claimed&ownerBuilderId=${ownerMe.body.builder.builderId}&limit=1`);
const landletId = ownedList.body.landlets[0].landletId;

const started = await fetchJson(ownerPage, `/api/landlets/${landletId}/auction`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
});
const auctionId = started.body.auction.auctionId;

// 21 escalating bids from the bidder — 21 distinct "new bid" notifications
// for the owner, one more than the frontend's own 20-per-page size, so
// "Load more" has exactly one further row to reveal.
for (let amountCents = 100, i = 0; i < 21; amountCents += 100, i++) {
  const bid = await fetchJson(bidderPage, `/api/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amountCents }),
  });
  if (bid.status !== 201) {
    throw new Error(`Bid ${i} failed: ${bid.status} ${JSON.stringify(bid.body)}`);
  }
}

await openAccountMenu(ownerPage);
await ownerPage.click('#notifications-btn');
await ownerPage.waitForSelector('#notifications-modal.visible', { timeout: 5000 });
await ownerPage.waitForFunction(
  () => document.querySelectorAll('.notification-row').length > 0,
  { timeout: 5000 },
);

const firstPageCount = await ownerPage.locator('.notification-row').count();
console.log('Notices modal row count on first load (should be 20, the page size):', firstPageCount);

const loadMoreVisible = await ownerPage.locator('#notifications-load-more-btn').isVisible();
console.log('"Load more" button visible with a 21st notification still unfetched (should be true):', loadMoreVisible);

await ownerPage.click('#notifications-load-more-btn');
await ownerPage.waitForFunction(
  (expected) => document.querySelectorAll('.notification-row').length >= expected,
  21,
  { timeout: 5000 },
);

const afterLoadMoreCount = await ownerPage.locator('.notification-row').count();
console.log('Notices modal row count after "Load more" (should be 21, all of them):', afterLoadMoreCount);

const loadMoreHiddenAfter = await ownerPage.locator('#notifications-load-more-btn').isHidden();
console.log('"Load more" button hidden once every notification is loaded (should be true):', loadMoreHiddenAfter);

const pass = firstPageCount === 20 &&
  loadMoreVisible === true &&
  afterLoadMoreCount === 21 &&
  loadMoreHiddenAfter === true &&
  errors.length === 0;
await bidderSession.browser.close();
await finish(ownerSession.browser, { pass, label: 'Notifications: cursor pagination and "Load more" in the Notices modal', errors });
