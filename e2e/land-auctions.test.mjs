// Land acquisition auctions (docs/SPEC.md §5, docs/API.md's "Land
// acquisition auctions") — Settings' Build tab, alongside Land Cap. Two independent
// browser pages stand in for two different builders, the same pattern
// e2e/bundle-sharing.test.mjs already uses, since bidding is inherently a
// two-party interaction. Covers starting a voluntary auction, placing a
// bid, and the seller's resulting new-bid notification, all through the
// real UI end to end. Resolution itself (ownership
// transfer, dállers payout, greenbelt release) is NOT covered here — every
// path requires the auction to actually be past its end time, and the
// shortest duration the API accepts is 1 hour (matching the spec's own
// 24-hour default), so waiting for a real one isn't practical in an e2e
// run. That's covered instead by worker/commerce.test.js, which can set
// ends_at into the past directly via the D1 test binding.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, createGreenbeltLandletAsAdmin } from './helpers.mjs';

const SELLER = 'Auction Seller';
const BIDDER = 'Auction Bidder';

const sellerSession = await launchPage({ promptAnswer: SELLER });
const bidderSession = await launchPage({ promptAnswer: BIDDER });
const errors = [...sellerSession.errors, ...bidderSession.errors];

// --- Seller: claim a landlet, start an auction with a custom starting bid. ---
const sellerPage = sellerSession.page;
await chooseIdentity(sellerPage, { mode: 'build', label: SELLER, isNew: true });
await claimLandlet(sellerPage);

await openAccountMenu(sellerPage);
await sellerPage.click('#settings-btn');
await sellerPage.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await sellerPage.click('.settings-tab-btn[data-section="build"]');
await sellerPage.waitForTimeout(500);

const startForm = sellerPage.locator('.auction-start-form');
await startForm.waitFor({ timeout: 10000 });
await startForm.locator('input').nth(0).fill('10'); // starting bid $10
await startForm.locator('input').nth(1).fill('1'); // duration 1 hour
await sellerPage.click('.auction-start-btn');
await sellerPage.waitForFunction(
  () => document.querySelector('.settings-field .auction-row')?.textContent.includes('Your auction is live'),
  { timeout: 10000 },
);
const sellerOwnAuctionText = await sellerPage.locator('.auction-row').first().textContent();
console.log('seller\'s own auction row (should mention "Your auction is live" and "$10.00"):', sellerOwnAuctionText);

// Reopening Start doesn't offer a second form — the landlet already has
// an active auction.
const startFormGoneAfterStarting = await sellerPage.locator('.auction-start-form').count();
console.log('start form gone once an auction is already live (should be 0):', startFormGoneAfterStarting);

await sellerPage.click('#settings-close-btn');
await sellerPage.waitForTimeout(300);

// --- Bidder: a completely separate builder with their own landlet — owning
// land doesn't stop you from bidding on someone else's auction. ---
const bidderPage = bidderSession.page;
await chooseIdentity(bidderPage, { mode: 'build', label: BIDDER, isNew: true });
await claimLandlet(bidderPage);

await openAccountMenu(bidderPage);
await bidderPage.click('#settings-btn');
await bidderPage.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await bidderPage.click('.settings-tab-btn[data-section="build"]');
// Sell Your Land is itself gated behind an async fetch (a "Loading…"
// placeholder until it resolves — see renderStartSection in src/main.js) —
// wait for the actual form rather than guessing a fixed delay, the same
// class of flake fixed elsewhere in this suite earlier this session.
await bidderPage.waitForSelector('.auction-start-form', { timeout: 10000 });

// The bidder's OWN landlet has no auction on it — Sell Your Land should
// offer the start form, not show a live auction.
const bidderOwnStartFormVisible = await bidderPage.locator('.auction-start-form').count();
console.log('bidder sees their own start form (no auction on their landlet yet, should be 1):', bidderOwnStartFormVisible);

const auctionsListItems = bidderPage.locator('.auction-list .auction-row');
await auctionsListItems.first().waitFor({ timeout: 10000 });
const listedAuctionText = await auctionsListItems.first().textContent();
console.log('auction as seen by the bidder (should mention $10.00 starting bid, no bids yet):', listedAuctionText);

const bidInput = auctionsListItems.first().locator('.auction-row-bid-input');
await bidInput.fill('15');
await auctionsListItems.first().locator('.auction-bid-btn').click();
await bidderPage.waitForFunction(
  () => document.querySelector('.auction-list .auction-row')?.textContent.includes('$15.00'),
  { timeout: 10000 },
);
const afterBidText = await auctionsListItems.first().textContent();
console.log('auction after bidding (should mention high bid $15.00, 1 bid):', afterBidText);

// A bid lower than the current high bid is rejected server-side; the
// button click still fires (client only checks it's a finite number). The
// rejection surfaces as an alert() — already auto-accepted by launchPage's
// own dialog handler, so this just confirms the displayed high bid stays
// at $15.00 rather than the rejected $12.00 taking effect.
await bidInput.fill('12');
await auctionsListItems.first().locator('.auction-bid-btn').click();
await bidderPage.waitForTimeout(500);
const afterRejectedBidText = await auctionsListItems.first().textContent();
console.log('auction after a too-low bid attempt (should still say $15.00, not $12.00):', afterRejectedBidText);

// --- Back to the seller: confirm the bid shows up on their own view too. ---
await openAccountMenu(sellerPage);
await sellerPage.click('#settings-btn');
await sellerPage.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await sellerPage.click('.settings-tab-btn[data-section="build"]');
await sellerPage.waitForFunction(
  () => document.querySelector('.settings-field .auction-row')?.textContent.includes('$15.00'),
  { timeout: 10000 },
);
const sellerSeesBidText = await sellerPage.locator('.auction-row').first().textContent();
console.log('seller\'s own view after the bid (should mention $15.00):', sellerSeesBidText);

// The bid also fired a real builder-facing notification (see
// notifyOfNewBid in worker/index.js) — reuses the existing notifications
// system/UI wholesale (a plain message, no templateId), so this closes
// the loop on the actual end-user-visible surface, not just the API.
await sellerPage.click('#settings-close-btn');
await sellerPage.waitForTimeout(300);
await openAccountMenu(sellerPage);
await sellerPage.click('#notifications-btn');
await sellerPage.waitForSelector('#notifications-modal.visible', { timeout: 5000 });
await sellerPage.waitForFunction(
  () => document.querySelector('.notification-row')?.textContent.includes('New bid of $15.00'),
  { timeout: 10000 },
);
const sellerNoticeText = await sellerPage.locator('.notification-row').first().textContent();
console.log('seller\'s notification for the new bid (should mention "New bid of $15.00"):', sellerNoticeText);

await bidderSession.browser.close();

// --- Seller claims a SECOND landlet — #199 already freed their "one
// claimed landlet" slot the moment the bidder's $15 bid landed above
// (any starting bid becomes a commitment to sell once a bid exists, not
// just a $0 one) — and confirms Sell Your Land's picker (#249) lists
// both, defaults to the one they're actually in Build mode on (their
// first, which still has the live auction), and switches to the other
// landlet's own start form when reselected. ---
await sellerPage.click('#notifications-close-btn');
await sellerPage.waitForTimeout(300);
const SECOND_LANDLET_ID = 'auction-picker-second-landlet';
await createGreenbeltLandletAsAdmin(SECOND_LANDLET_ID);
const secondClaimStatus = await sellerPage.evaluate(
  (landletId) => fetch(`/api/landlets/${landletId}/claim`, { method: 'POST' }).then((r) => r.status),
  SECOND_LANDLET_ID,
);
console.log('claiming a second landlet after the first bid landed (should be 200):', secondClaimStatus);

await openAccountMenu(sellerPage);
await sellerPage.click('#settings-btn');
await sellerPage.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await sellerPage.click('.settings-tab-btn[data-section="build"]');
await sellerPage.waitForSelector('.landlet-picker select', { timeout: 10000 });
const pickerOptionCount = await sellerPage.locator('.landlet-picker select option').count();
console.log('landlet picker option count now that the seller owns 2 claimed landlets (should be 2):', pickerOptionCount);

const defaultPickerText = await sellerPage.locator('.auction-row').first().textContent().catch(() => '');
console.log('default picker selection still shows the live auction on the Build-mode landlet (should mention "Your auction is live"):', defaultPickerText);

await sellerPage.selectOption('.landlet-picker select', SECOND_LANDLET_ID);
await sellerPage.waitForSelector('.auction-start-form', { timeout: 10000 });
const secondLandletFormVisible = await sellerPage.locator('.auction-start-form').count();
console.log('second (unauctioned) landlet shows its own start form once selected (should be 1):', secondLandletFormVisible);

const pass = sellerOwnAuctionText.includes('Your auction is live') && sellerOwnAuctionText.includes('$10.00') &&
  startFormGoneAfterStarting === 0 &&
  bidderOwnStartFormVisible === 1 &&
  listedAuctionText.includes('$10.00') &&
  afterBidText.includes('$15.00') && afterBidText.includes('1 bid') &&
  afterRejectedBidText.includes('$15.00') && !afterRejectedBidText.includes('$12.00') &&
  sellerSeesBidText.includes('$15.00') &&
  sellerNoticeText.includes('New bid of $15.00') &&
  secondClaimStatus === 200 &&
  pickerOptionCount === 2 &&
  defaultPickerText.includes('Your auction is live') &&
  secondLandletFormVisible === 1 &&
  errors.length === 0;
await finish(sellerSession.browser, { pass, label: 'Land acquisition auctions: start + bid through the real UI, and a multi-landlet Sell Your Land picker (#249)', errors });
