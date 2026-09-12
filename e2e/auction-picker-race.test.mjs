// Regression test for #442: the "Sell Your Lándlet" landlet picker
// (renderForLandlet/renderAuctionSection in src/main.js, added by #249) had
// no stale-response guard, unlike its sibling panels this codebase has
// already fixed for the same shape (#424/#425). Switching the picker before
// the previously-selected landlet's own GET /api/auctions round-trip
// resolves could let that older, slower response land last and overwrite
// the panel with the wrong landlet's auction status. Delays the FIRST
// landlet's own /api/auctions fetch via Playwright route interception to
// get a deterministic reordering: select landlet A (slow fetch in flight,
// A itself carries a real but textually distinct $0 auction), immediately
// switch to landlet B (fast fetch, a real $5 active auction), then let A's
// stale response land afterward and confirm it does NOT clobber B's
// already-rendered "Your auction is live — $5.00" summary with A's own
// ($0.00) one.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, createGreenbeltLandletAsAdmin } from './helpers.mjs';

const LABEL = 'Auction Picker Race Tester';
const SECOND_LANDLET_ID = 'auction-picker-race-second-landlet';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const FIRST_LANDLET_ID = landlets[0].landletId;
console.log('first (Build-mode) landlet claimed via the UI:', FIRST_LANDLET_ID);

// A $0 auction on the FIRST landlet frees its own "one claimed landlet"
// lock immediately (#199), which is what makes a second simultaneously-
// claimed landlet reachable at all here — same mechanism
// e2e/land-auctions.test.mjs already relies on for its own picker coverage.
const firstAuctionStatus = (await fetchJson(`/api/landlets/${FIRST_LANDLET_ID}/auction`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
})).status;
console.log('starting a $0 auction on the first landlet, freeing the claim lock (should be 201):', firstAuctionStatus);

// A second claimed landlet, per #199/#249 — a normal state, not an edge
// case, once the seller owns more than one claimed landlet at once.
await createGreenbeltLandletAsAdmin(SECOND_LANDLET_ID);
const secondClaimStatus = (await fetchJson(`/api/landlets/${SECOND_LANDLET_ID}/claim`, { method: 'POST' })).status;
console.log('claiming a second landlet (should be 200):', secondClaimStatus);

// An active auction on the SECOND landlet too, but with a different
// starting bid ($5 vs the first's $0) so the two landlets' own "Your
// auction is live" summaries are textually distinguishable — the race
// this test proves is that landlet A's stale response must NOT overwrite
// landlet B's freshly-rendered summary with A's own ($0.00) text.
const startAuctionStatus = (await fetchJson(`/api/landlets/${SECOND_LANDLET_ID}/auction`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ startingBidCents: 500, durationHours: 1 }),
})).status;
console.log('starting a $5 auction on the second landlet (should be 201):', startAuctionStatus);

// Delay only the first landlet's own GET /api/auctions?...&landletId=<A>
// round-trip — the second landlet's fetch (issued moments later, once the
// picker is switched) resolves fast and unimpeded, the exact reordering
// #442 describes.
await page.route('**/api/auctions*', async (route) => {
  const url = route.request().url();
  if (route.request().method() === 'GET' && url.includes(`landletId=${FIRST_LANDLET_ID}`)) {
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }
  await route.continue();
});

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');

// The picker itself renders before its own renderForLandlet(A) call
// resolves (see renderStartSection in src/main.js) — wait for it, then
// switch to landlet B immediately, well before A's delayed fetch (1800ms)
// comes back.
await page.waitForSelector('.landlet-picker select', { timeout: 10000 });
await page.selectOption('.landlet-picker select', SECOND_LANDLET_ID);

// B's own fetch is not delayed — its "Your auction is live" summary
// should show up quickly.
await page.waitForFunction(
  () => document.querySelector('.settings-field .auction-row')?.textContent.includes('Your auction is live'),
  { timeout: 10000 },
);
// Scoped to the "Sell Your Lándlet" field's own DIRECT children — its
// .auction-row/.auction-start-form sit right under the .settings-field
// wrapper, unlike the world-wide "Active Auctions" list's own .auction-row
// items, which are nested one level deeper inside a .auction-list wrapper.
const sellYourLandRows = () => page.locator('.settings-field > .auction-row, .settings-field > .auction-start-form');

const rightAfterSwitchCount = await sellYourLandRows().count();
const rightAfterSwitchText = await sellYourLandRows().first().textContent();
console.log('row count right after switching to the second (auctioned) landlet (should be exactly 1):', rightAfterSwitchCount);
console.log('its text (should mention "Your auction is live" and $5.00):', rightAfterSwitchText);

// Now wait long enough for landlet A's stale, delayed fetch to land too.
await page.waitForTimeout(2500);

// The bug's real manifestation: renderForLandlet only removes old
// .auction-row/.auction-start-form elements at the very START of a call,
// before its own await — so a stale call resuming after a fresher call has
// already rendered doesn't overwrite that fresher row, it silently
// APPENDS a second, stale one next to it (landlet A's own $0.00 summary,
// alongside B's already-correct $5.00 one) rather than clobbering it
// outright. Either way the panel ends up showing something wrong for
// whichever landlet is actually selected.
const finalRowCount = await sellYourLandRows().count();
const allRowsText = await sellYourLandRows().allTextContents();
const pickerValueAfterStaleLanding = await page.locator('.landlet-picker select').inputValue();
console.log('row count after landlet A\'s stale response lands (should STILL be exactly 1, not a duplicate stale row):', finalRowCount);
console.log('all row texts at that point:', allRowsText);
console.log('picker still shows the second landlet selected (should be the second landlet id):', pickerValueAfterStaleLanding);

const pass = firstAuctionStatus === 201 &&
  secondClaimStatus === 200 &&
  startAuctionStatus === 201 &&
  rightAfterSwitchCount === 1 &&
  rightAfterSwitchText.includes('Your auction is live') && rightAfterSwitchText.includes('$5.00') &&
  finalRowCount === 1 &&
  allRowsText.some((t) => t.includes('Your auction is live') && t.includes('$5.00')) &&
  !allRowsText.some((t) => t.includes('$0.00')) &&
  pickerValueAfterStaleLanding === SECOND_LANDLET_ID &&
  errors.length === 0;
await finish(browser, { pass, label: '#442: a stale, delayed landlet-picker auction fetch does not clobber a fresher selection', errors });
