// Community signs (docs/SPEC.md §6, docs/API.md's "Community signs") — a
// builder flags a placed instance as a sign via the "Community Sign"
// toggle in the gizmo-mode-controls row, and shoppers can then leave short
// posts on it (rendered in-world as fading floating text in Shop mode —
// see updateSignFade/makeSignPostSprite in src/main.js, not covered here
// for the same reason raw TransformControls drags aren't: a real camera-
// distance-driven fade and a window.prompt-driven post flow are exercised
// manually instead, documented in docs/API.md). This test covers the
// pieces that ARE reliably automatable: the build-mode toggle button (a
// second click, once already flagged, opens the Manage Posts panel
// instead of un-flagging directly — see that button's own click-handler
// comment in src/main.js for why), the Manage Posts moderation panel
// (#sign-posts-modal, including its own "Remove Community Sign" button),
// and the backend sign-posts API all three unlock.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Community Sign Suite Tester';

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
const labelBefore = await communitySignBtn().textContent();
console.log('Community Sign button label before toggling (should be plain "Community Sign"):', labelBefore);

await communitySignBtn().click();
await page.waitForTimeout(500);
const labelAfterOn = await communitySignBtn().textContent();
console.log('Community Sign button label after toggling on (should mention Manage):', labelAfterOn);

// Read back the persisted flag directly from the API.
const { landlets } = (await fetchJson('/api/landlets?limit=100')).body;
const myLandlet = landlets.find((l) => l.ownerBuilderId);
const { instances } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const signInstance = instances.find((i) => i.templateId === 'placeholder-tree');
console.log('isCommunitySign persisted after toggling on (should be true):', signInstance.isCommunitySign);

// Leave a couple of posts via the same API the in-world "Leave a Note"
// button calls (createSignPost in src/api.js), then list them back.
await fetchJson(`/api/instances/${signInstance.instanceId}/posts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ authorLabel: 'A Shopper', text: 'Love this place!' }),
});
await fetchJson(`/api/instances/${signInstance.instanceId}/posts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ authorLabel: 'Another Shopper', text: 'Great selection.' }),
});
const { posts } = (await fetchJson(`/api/instances/${signInstance.instanceId}/posts`)).body;
console.log('posts on the sign (should be 2, oldest first):', posts.map((p) => `${p.authorLabel}: ${p.text}`));

// A second click on the same (still-selected) button now opens Manage
// Posts instead of un-flagging.
await communitySignBtn().click();
await page.waitForSelector('#sign-posts-modal.visible', { timeout: 5000 });
await page.waitForTimeout(300);
const rowCountInPanel = await page.locator('.sign-post-row').count();
const firstRowText = await page.locator('.sign-post-row').first().textContent();
console.log('rows shown in the panel (should be 2):', rowCountInPanel);
console.log('first row mentions author+text (should mention "A Shopper" and "Love this place!"):', firstRowText);

// Delete the second post via its row's own × button (not the API directly)
// — this is the actual moderation path a builder would use.
await page.locator('.sign-post-row').filter({ hasText: 'Another Shopper' }).locator('.sign-post-row-delete').click();
await page.waitForFunction(() => document.querySelectorAll('.sign-post-row').length === 1, { timeout: 5000 });
const rowCountAfterDelete = await page.locator('.sign-post-row').count();
console.log('rows shown after deleting one via the panel (should be 1):', rowCountAfterDelete);

const { posts: postsAfterDelete } = (await fetchJson(`/api/instances/${signInstance.instanceId}/posts`)).body;
console.log('posts persisted server-side after the panel delete (should be 1, the surviving one authored by "A Shopper"):', postsAfterDelete.map((p) => p.authorLabel));

// "Remove Community Sign," inside the panel, un-flags and closes it.
await page.click('#sign-posts-unflag-btn');
await page.waitForTimeout(500);
const modalHiddenAfterUnflag = await page.locator('#sign-posts-modal').evaluate((el) => !el.classList.contains('visible'));
const labelAfterOff = await communitySignBtn().textContent();
const { instances: instancesAfterOff } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const signInstanceAfterOff = instancesAfterOff.find((i) => i.instanceId === signInstance.instanceId);
console.log('sign-posts-modal closed after unflagging (should be true):', modalHiddenAfterUnflag);
console.log('Community Sign button label after unflagging (should be plain again):', labelAfterOff);
console.log('isCommunitySign persisted after unflagging (should be false):', signInstanceAfterOff.isCommunitySign);

// (The 400 rejection for posting to a non-sign instance is covered by
// worker/index.test.js's own "Community signs" describe block instead of
// here — a deliberately-triggered non-2xx fetch logs a "Failed to load
// resource" console error in the page itself, which this suite's own
// errors-must-be-empty convention would otherwise misread as a real bug.)

const pass = labelBefore.trim() === 'Community Sign' &&
  labelAfterOn.includes('✓') &&
  signInstance.isCommunitySign === true &&
  posts.length === 2 &&
  posts[0].text === 'Love this place!' &&
  rowCountInPanel === 2 &&
  firstRowText.includes('A Shopper') && firstRowText.includes('Love this place!') &&
  rowCountAfterDelete === 1 &&
  postsAfterDelete.length === 1 && postsAfterDelete[0].authorLabel === 'A Shopper' &&
  modalHiddenAfterUnflag &&
  labelAfterOff.trim() === 'Community Sign' &&
  signInstanceAfterOff.isCommunitySign === false &&
  errors.length === 0;
await finish(browser, { pass, label: 'Community Sign toggle + Manage Posts panel + sign-posts API', errors });
