// #1274: handleSignPosts (worker/index.js) windows sign posts to the newest
// 200 but already returns a real, uncapped `totalCount` alongside them (the
// same #356 fix handlePurchases/handleSignPosts/handleCalendarEvents all
// share) -- fetchSignPosts (src/api.js) used to discard that field and
// return only the bare `posts` array, so renderSignPosts (src/main.js) had
// no way to tell a builder older posts exist once a sign passes 200. Mocking
// the GET response directly proves the frontend now shows a truncation
// notice built from the real totalCount, without needing 200+ real posts
// (impractical here the same way e2e/review-feedback-summary-count.test.mjs's
// own comment explains for its own analogous mock).
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Sign Post Truncation Tester';
const FAKE_TOTAL_COUNT = 215;

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

const communitySignBtn = () => page.locator('#toggle-community-sign');
await communitySignBtn().click();
await page.waitForTimeout(500);

const { landlets } = (await fetchJson('/api/landlets?limit=100')).body;
const myLandlet = landlets.find((l) => l.ownerBuilderId);
const { instances } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const signInstance = instances.find((i) => i.templateId === 'placeholder-tree');

// Mock only the GET -- POST/DELETE (the panel's own delete button, were it
// used here) still hit the real backend untouched.
await page.route(`**/api/instances/${signInstance.instanceId}/posts*`, async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      posts: [
        { postId: 'fake-post-1', authorLabel: 'A Shopper', text: 'First', createdAt: new Date().toISOString() },
        { postId: 'fake-post-2', authorLabel: 'A Shopper', text: 'Second', createdAt: new Date().toISOString() },
        { postId: 'fake-post-3', authorLabel: 'A Shopper', text: 'Third', createdAt: new Date().toISOString() },
      ],
      totalCount: FAKE_TOTAL_COUNT,
    }),
  });
});

// A second click on the same (still-selected, now-flagged) button opens
// Manage Posts instead of un-flagging.
await communitySignBtn().click();
await page.waitForSelector('#sign-posts-modal.visible', { timeout: 5000 });
await page.waitForFunction(() => document.querySelectorAll('.sign-post-row').length === 3, { timeout: 5000 });

const rowCount = await page.locator('.sign-post-row').count();
const truncatedHidden = await page.locator('#sign-posts-truncated').evaluate((el) => el.hidden);
const truncatedText = await page.locator('#sign-posts-truncated').textContent();
console.log('rows shown in the panel (should be 3, the mocked window):', rowCount);
console.log('truncation notice hidden (should be false):', truncatedHidden);
console.log(`truncation notice text (should mention the real totalCount ${FAKE_TOTAL_COUNT}, not the mocked array length 3):`, truncatedText);

const pass =
  rowCount === 3 &&
  truncatedHidden === false &&
  truncatedText.includes(String(FAKE_TOTAL_COUNT)) &&
  truncatedText.includes('3') &&
  errors.length === 0;
await finish(browser, { pass, label: 'Sign posts panel shows a truncation notice built from the real totalCount, not the windowed array length (#1274)', errors });
