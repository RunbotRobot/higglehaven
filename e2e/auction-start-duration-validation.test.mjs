// #1922: the Start Auction form's duration input had a `min` but no `max`,
// and the click handler only rejected `hours < 1` -- an unusually large
// duration (the server caps at 8760 hours / one year, worker/index.js's
// handleAuctions POST) passed client validation and surfaced the raw
// server error string instead of a friendly client-side one. This is
// pure client-side validation (checked before any fetch), so a single
// browser session with no bidder is enough.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Auction Duration Validator';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');

const startField = page.locator('.settings-field', { has: page.locator('.auction-start-form') });
const startForm = startField.locator('.auction-start-form');
await startForm.waitFor({ timeout: 10000 });
const durationInput = startForm.locator('input').nth(1);
const startStatus = startField.locator('.settings-empty-note');

const durationMaxAttr = await durationInput.getAttribute('max');
console.log('duration input has a max attribute matching the server cap (should be "8760"):', durationMaxAttr);

await durationInput.fill('100000'); // well past the server's 8760-hour (one year) cap
await page.click('.auction-start-btn');
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field .settings-empty-note')].some((el) => el.textContent.includes('8760')),
  { timeout: 5000 },
);
const overLimitStatusText = await startStatus.textContent();
console.log('status after an over-the-cap duration (should be a friendly client-side message, not the raw server one):', overLimitStatusText);
const friendlyMessageShown = overLimitStatusText.includes('Duration must be 8760 hours (one year) or fewer.');
const noRawServerMessageLeaked = !overLimitStatusText.includes('durationHours must be');

// The form must still be present (never submitted) after the rejected
// value -- confirms this was caught client-side, not by a round trip.
const formStillPresentAfterRejection = await page.locator('.auction-start-form').count();
console.log('start form still present after the rejected duration, confirming no fetch was sent (should be 1):', formStillPresentAfterRejection);

// A valid duration still works normally -- this isn't a regression to
// "nothing can ever start an auction".
await durationInput.fill('1');
await page.click('.auction-start-btn');
await page.waitForFunction(
  () => document.querySelector('.settings-field .auction-row')?.textContent.includes('Your auction is live'),
  { timeout: 10000 },
);
const auctionStartedText = await page.locator('.auction-row').first().textContent();
console.log('auction started normally with a valid duration (should mention "Your auction is live"):', auctionStartedText);

const pass = durationMaxAttr === '8760' &&
  friendlyMessageShown &&
  noRawServerMessageLeaked &&
  formStillPresentAfterRejection === 1 &&
  auctionStartedText.includes('Your auction is live') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1922: Start Auction\'s duration field rejects an over-the-cap value client-side with a friendly message',
  errors,
});
