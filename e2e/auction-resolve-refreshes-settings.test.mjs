// Regression test for #1346: clicking "Resolve Now" on a past-due auction
// (Settings > Build tab) used to call only renderAuctionList()/
// renderStartSection() -- both inner to renderAuctionSection() itself --
// instead of the shared renderSettingsSection() redraw every sibling tab
// mutation in this file already uses (same #1124 idiom). resolveAuctionNow
// settles synchronously server-side (credits the seller's higgles balance,
// transfers the landlet) before that call even returns, so Land Cap and
// Redeem Higgles -- sibling fields with their own independent GETs -- went
// stale right on the same tab until a manual close/reopen.
//
// A real past-due, resolvable auction isn't reachable through the real
// HTTP API in an e2e run (the shortest duration the API accepts is 1 hour,
// and there's no way to backdate endsAt -- see e2e/land-auctions.test.mjs's
// own comment). So this test starts one real 1-hour auction, then mocks
// just enough of the network (the same route.fetch()-then-fulfill idiom
// e2e/version-history-race.test.mjs already uses) to make the real auction
// look past-due client-side and to let the real "Resolve Now" click
// succeed -- everything else (the actual DOM/render behavior being tested)
// is the real, unmodified app code.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Auction Resolve Refresh Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

async function fetchJson(pathAndQuery) {
  return page.evaluate(async (p) => (await fetch(p)).json(), pathAndQuery);
}

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

const { builder } = await fetchJson('/api/builders/me');
const { landlets } = await fetchJson(`/api/landlets?ownerBuilderId=${builder.builderId}&limit=10`);
const myLandletId = landlets[0]?.landletId;

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForFunction(
  () => document.getElementById('land-cap-field')?.textContent.includes('cap'),
  { timeout: 10000 },
);

// Only the global "active, no landletId filter" list (fetchAllAuctions,
// what builds the Active Auctions panel's Resolve Now button) gets its
// endsAt rewritten into the past -- the per-landlet fetchAuctions call
// (status+landletId, "Your auction is live") and every other /api/auctions
// request pass through untouched.
let resolvableAuctionId = null;
await page.route('**/api/auctions**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() === 'GET' && url.pathname === '/api/auctions' && !url.searchParams.has('landletId')) {
    const response = await route.fetch();
    const body = await response.json();
    for (const auction of body.auctions || []) {
      if (auction.landletId === myLandletId) {
        auction.endsAt = new Date(Date.now() - 60_000).toISOString();
        resolvableAuctionId = auction.auctionId;
      }
    }
    await route.fulfill({ response, body: JSON.stringify(body) });
    return;
  }
  if (request.method() === 'POST' && url.pathname.endsWith('/resolve')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ auction: { auctionId: resolvableAuctionId, status: 'ended', endsAt: new Date().toISOString() } }),
    });
    return;
  }
  await route.continue();
});

// Start a real, real-API auction (1 hour -- the API's own minimum).
const startForm = page.locator('.auction-start-form');
await startForm.waitFor({ timeout: 10000 });
await startForm.locator('input').nth(0).fill('0');
await startForm.locator('input').nth(1).fill('1');
await page.click('.auction-start-btn');
await page.waitForFunction(
  () => document.querySelector('.settings-field .auction-row')?.textContent.includes('Your auction is live'),
  { timeout: 10000 },
);

// The Active Auctions list's own re-fetch (fired by the Start Auction
// handler itself) runs through the mock above, so our real auction now
// shows up there with its endsAt rewritten into the past -- a real
// "Resolve Now" button, same as any other genuinely past-due auction.
await page.waitForSelector('.auction-resolve-btn', { timeout: 10000 });
if (!resolvableAuctionId) throw new Error('mock never saw our own auction in the global active-auctions list');

const meRequestAfterResolve = page.waitForRequest(
  (req) => req.method() === 'GET' && new URL(req.url()).pathname === '/api/builders/me',
  { timeout: 8000 },
);
const redeemRequestAfterResolve = page.waitForRequest(
  (req) => req.method() === 'GET' && new URL(req.url()).pathname === '/api/builders/me/redeem',
  { timeout: 8000 },
);

await page.click('.auction-resolve-btn');

const [meRefetched, redeemRefetched] = await Promise.all([
  meRequestAfterResolve.then(() => true).catch(() => false),
  redeemRequestAfterResolve.then(() => true).catch(() => false),
]);
console.log('GET /api/builders/me re-fetched after Resolve Now (should be true -- was the #1346 bug):', meRefetched);
console.log('GET /api/builders/me/redeem re-fetched after Resolve Now (should be true -- was the #1346 bug):', redeemRefetched);

// The fixed handler's renderSettingsSection() redraw tears down and
// rebuilds the whole tab -- Land Cap should still be present and loaded,
// not left missing or stuck on "Loading…" by a redraw that started but
// never finished.
await page.waitForFunction(
  () => document.getElementById('land-cap-field')?.textContent.includes('cap'),
  { timeout: 10000 },
);
const landCapStillShowing = (await page.locator('#land-cap-field').textContent()).includes('cap');
console.log('Land Cap field still showing loaded text after the redraw (should be true):', landCapStillShowing);

const pass = meRefetched && redeemRefetched && landCapStillShowing && errors.length === 0;
await finish(browser, { pass, label: 'Resolve Now refreshes Land Cap/Redeem Higgles, not just the auction list (#1346)', errors });
