// Land acquisition auctions (docs/SPEC.md §5, docs/API.md's "Land
// acquisition auctions") — Settings' own Auctions tab. Two independent
// browser pages stand in for two different builders, the same pattern
// e2e/bundle-sharing.test.mjs already uses, since bidding is inherently a
// two-party interaction. Covers starting a voluntary auction and placing a
// bid through the real UI end to end. Resolution itself (ownership
// transfer, dállers payout, greenbelt release) is NOT covered here — every
// path requires the auction to actually be past its end time, and the
// shortest duration the API accepts is 1 hour (matching the spec's own
// 24-hour default), so waiting for a real one isn't practical in an e2e
// run. That's covered instead by worker/index.test.js, which can set
// ends_at into the past directly via the D1 test binding.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const SELLER = 'Auction Seller';
const BIDDER = 'Auction Bidder';

const sellerSession = await launchPage({ promptAnswer: SELLER });
const bidderSession = await launchPage({ promptAnswer: BIDDER });
const errors = [...sellerSession.errors, ...bidderSession.errors];

// --- Seller: claim a landlet, start an auction with a custom starting bid. ---
const sellerPage = sellerSession.page;
await chooseIdentity(sellerPage, { mode: 'build', label: SELLER, isNew: true });
await claimLandlet(sellerPage);

await sellerPage.click('#settings-btn');
await sellerPage.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await sellerPage.click('.settings-tab-btn[data-section="auctions"]');
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

await bidderPage.click('#settings-btn');
await bidderPage.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await bidderPage.click('.settings-tab-btn[data-section="auctions"]');
await bidderPage.waitForTimeout(500);

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
await sellerPage.click('#settings-btn');
await sellerPage.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await sellerPage.click('.settings-tab-btn[data-section="auctions"]');
await sellerPage.waitForTimeout(500);
const sellerSeesBidText = await sellerPage.locator('.auction-row').first().textContent();
console.log('seller\'s own view after the bid (should mention $15.00):', sellerSeesBidText);

await bidderSession.browser.close();

const pass = sellerOwnAuctionText.includes('Your auction is live') && sellerOwnAuctionText.includes('$10.00') &&
  startFormGoneAfterStarting === 0 &&
  bidderOwnStartFormVisible === 1 &&
  listedAuctionText.includes('$10.00') &&
  afterBidText.includes('$15.00') && afterBidText.includes('1 bid') &&
  afterRejectedBidText.includes('$15.00') && !afterRejectedBidText.includes('$12.00') &&
  sellerSeesBidText.includes('$15.00') &&
  errors.length === 0;
await finish(sellerSession.browser, { pass, label: 'Land acquisition auctions: start + bid through the real UI', errors });
