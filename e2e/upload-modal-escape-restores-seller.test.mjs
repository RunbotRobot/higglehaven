// #2515: the Upload Model modal only ever opens stacked on top of the
// still-visible Seller modal (openUploadModal never hides it -- see
// index.html's own comment on why it's a stacked overlay, not a swap like
// the Friends-map/DM pair #1679 already fixed). closeUploadModal used to
// only clear activeModalEl via closeModalA11y, never re-arming the Seller
// modal's own trap -- so Escape (or the explicit Cancel/X button, which
// goes through the same close function) left the Seller modal on screen
// but untrapped: Tab could walk straight out of it into the page behind,
// and a second Escape press did nothing. Same bug class, same fix shape
// (re-arm the parent's trap inside the close function) as #1679's own
// e2e/friends-map-and-dm-escape-restores-friends.test.mjs, just applied to
// a stacked pair instead of a swapped one.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Upload Modal Escape Restore Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });

// The Seller modal underneath was never hidden -- confirms this really is
// the stacked-overlay shape the issue describes, not a swap.
const sellerVisibleWhileUploadOpen = (await page.locator('#seller-modal.visible').count()) === 1;
console.log('Seller modal still visible underneath the open Upload modal (should be true):', sellerVisibleWhileUploadOpen);

await page.keyboard.press('Escape');
await page.waitForSelector('#upload-modal:not(.visible)', { state: 'attached', timeout: 5000 });
const uploadClosedByEscape = (await page.locator('#upload-modal.visible').count()) === 0;
const sellerStillVisibleAfterEscape = (await page.locator('#seller-modal.visible').count()) === 1;
console.log('Upload modal closed by Escape (should be true):', uploadClosedByEscape);
console.log('Seller modal still visible after Escape closes Upload (should be true):', sellerStillVisibleAfterEscape);

// The real proof this isn't just a CSS-visibility artifact: the Seller
// modal's own trap must be re-armed, so a SECOND Escape press now closes
// IT too (the pre-fix bug left activeModalEl null, so this second Escape
// would have done nothing at all).
await page.keyboard.press('Escape');
await page.waitForSelector('#seller-modal:not(.visible)', { state: 'attached', timeout: 5000 });
const sellerClosedBySecondEscape = (await page.locator('#seller-modal.visible').count()) === 0;
console.log('Seller modal closed by a second Escape press, proving its trap was re-armed (should be true):', sellerClosedBySecondEscape);

const pass =
  sellerVisibleWhileUploadOpen &&
  uploadClosedByEscape &&
  sellerStillVisibleAfterEscape &&
  sellerClosedBySecondEscape &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#2515: Escape on the Upload modal restores the Seller modal\'s own focus trap, matching Cancel/X',
  errors,
});
