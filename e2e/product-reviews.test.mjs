// Product reviews (docs/SPEC.md §5's "Review incentives," docs/API.md's
// "Product reviews") — a third structural twin of community signs
// (e2e/community-signs.test.mjs) and community calendar
// (e2e/community-calendar.test.mjs): a builder flags a placed instance via
// the "Product Reviews" toggle, and shoppers can then rate it (rendered
// in-world as fading floating text, via the same updateReviewFade/
// makeSignPostSprite machinery signs and calendars use — not covered here
// for the same reason as those two: real camera movement and native
// browser dialogs are exercised manually instead, documented in
// docs/API.md). This test covers what IS reliably automatable: the
// build-mode toggle-then-manage button, the Manage Reviews moderation panel
// (#product-reviews-modal, including its own "Remove Product Reviews"
// button and averaged summary), and the backend reviews API all three
// unlock.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Product Reviews Suite Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

// Place a tree and select it (placement auto-selects, per handlePlacementClick).
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

const productReviewsBtn = () => page.locator('#toggle-product-reviews');
const labelBefore = await productReviewsBtn().textContent();
console.log('Product Reviews button label before toggling (should be plain "Product Reviews"):', labelBefore);

await productReviewsBtn().click();
await page.waitForTimeout(500);
const labelAfterOn = await productReviewsBtn().textContent();
console.log('Product Reviews button label after toggling on (should mention Manage):', labelAfterOn);

// Read back the persisted flag directly from the API.
const { landlets } = (await fetchJson('/api/landlets?limit=100')).body;
const myLandlet = landlets.find((l) => l.ownerBuilderId);
const { instances } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const reviewableInstance = instances.find((i) => i.templateId === 'placeholder-tree');
console.log('isReviewable persisted after toggling on (should be true):', reviewableInstance.isReviewable);

// Leave a couple of reviews via the same API the in-world "Rate this
// Product" button calls (createProductReview in src/api.js), then list them
// back.
await fetchJson(`/api/instances/${reviewableInstance.instanceId}/reviews`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5, text: 'Lovely spot!' }),
});
await fetchJson(`/api/instances/${reviewableInstance.instanceId}/reviews`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ authorLabel: 'Another Shopper', rating: 3 }),
});
const { reviews, averageRating, count } = (await fetchJson(`/api/instances/${reviewableInstance.instanceId}/reviews`)).body;
console.log('reviews on the instance (should be 2, oldest first):', reviews.map((r) => `${r.authorLabel}: ${r.rating}★${r.text ? ` (${r.text})` : ''}`));
console.log('averageRating (should be 4) and count (should be 2):', averageRating, count);

// A second click on the same (still-selected) button now opens Manage
// Reviews instead of un-flagging.
await productReviewsBtn().click();
await page.waitForSelector('#product-reviews-modal.visible', { timeout: 5000 });
await page.waitForTimeout(300);
const rowCountInPanel = await page.locator('.product-review-row').count();
const firstRowText = await page.locator('.product-review-row').first().textContent();
const summaryText = await page.textContent('#product-reviews-summary');
console.log('rows shown in the panel (should be 2):', rowCountInPanel);
console.log('first row mentions author+rating+text (should mention "A Shopper", stars, and "Lovely spot"):', firstRowText);
console.log('summary text (should mention the 4.0 average and "2 reviews"):', summaryText);

// Delete the second review via its row's own × button (not the API
// directly) — this is the actual moderation path a builder would use.
await page.locator('.product-review-row').filter({ hasText: 'Another Shopper' }).locator('.product-review-row-delete').click();
await page.waitForFunction(() => document.querySelectorAll('.product-review-row').length === 1, { timeout: 5000 });
const rowCountAfterDelete = await page.locator('.product-review-row').count();
console.log('rows shown after deleting one via the panel (should be 1):', rowCountAfterDelete);

const afterDelete = (await fetchJson(`/api/instances/${reviewableInstance.instanceId}/reviews`)).body;
console.log('reviews persisted server-side after the panel delete (should be 1, the surviving one authored by "A Shopper"):', afterDelete.reviews.map((r) => r.authorLabel));

// (The 400 rejection for posting to a non-reviewable instance is covered by
// worker/index.test.js's own "Product reviews" describe block instead of
// here — triggering a real rejected fetch from inside the page logs a
// "Failed to load resource" console error that would trip this suite's own
// errors.length === 0 check, same reasoning as community-signs.test.mjs and
// community-calendar.test.mjs's own notes.)

// "Remove Product Reviews," inside the panel, un-flags and closes it.
await page.click('#product-reviews-unflag-btn');
await page.waitForTimeout(500);
const modalHiddenAfterUnflag = await page.locator('#product-reviews-modal').evaluate((el) => !el.classList.contains('visible'));
const labelAfterOff = await productReviewsBtn().textContent();
const { instances: instancesAfterOff } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const reviewableInstanceAfterOff = instancesAfterOff.find((i) => i.instanceId === reviewableInstance.instanceId);
console.log('product-reviews-modal closed after unflagging (should be true):', modalHiddenAfterUnflag);
console.log('Product Reviews button label after unflagging (should be plain again):', labelAfterOff);
console.log('isReviewable persisted after unflagging (should be false):', reviewableInstanceAfterOff.isReviewable);

const pass = labelBefore.trim() === 'Product Reviews' &&
  labelAfterOn.includes('✓') &&
  reviewableInstance.isReviewable === true &&
  reviews.length === 2 &&
  reviews[0].text === 'Lovely spot!' &&
  averageRating === 4 &&
  count === 2 &&
  rowCountInPanel === 2 &&
  firstRowText.includes('A Shopper') && firstRowText.includes('Lovely spot') &&
  summaryText.includes('4.0') && summaryText.includes('2 reviews') &&
  rowCountAfterDelete === 1 &&
  afterDelete.reviews.length === 1 && afterDelete.reviews[0].authorLabel === 'A Shopper' &&
  modalHiddenAfterUnflag &&
  labelAfterOff.trim() === 'Product Reviews' &&
  reviewableInstanceAfterOff.isReviewable === false &&
  errors.length === 0;
await finish(browser, { pass, label: 'Product Reviews toggle + Manage Reviews panel + reviews API', errors });
