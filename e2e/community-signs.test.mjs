// Community signs (docs/SPEC.md §6, docs/API.md's "Community signs") — a
// builder flags a placed instance as a sign via the "Community Sign"
// toggle in the gizmo-mode-controls row, and shoppers can then leave short
// posts on it (rendered in-world as fading floating text in Shop mode —
// see updateSignFade/makeSignPostSprite in src/main.js, not covered here
// for the same reason raw TransformControls drags aren't: a real camera-
// distance-driven fade and a window.prompt-driven post flow are exercised
// manually instead, documented in docs/API.md). This test covers the two
// pieces that ARE reliably automatable: the build-mode toggle button
// itself, and the backend sign-posts API it unlocks.
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
console.log('Community Sign button label after toggling on (should include a checkmark):', labelAfterOn);

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
const secondPost = await fetchJson(`/api/instances/${signInstance.instanceId}/posts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ authorLabel: 'Another Shopper', text: 'Great selection.' }),
});
const { posts } = (await fetchJson(`/api/instances/${signInstance.instanceId}/posts`)).body;
console.log('posts on the sign (should be 2, oldest first):', posts.map((p) => `${p.authorLabel}: ${p.text}`));

// Moderation: delete one post.
const deleteResult = await fetchJson(`/api/instances/${signInstance.instanceId}/posts/${secondPost.body.post.postId}`, { method: 'DELETE' });
const { posts: postsAfterDelete } = (await fetchJson(`/api/instances/${signInstance.instanceId}/posts`)).body;
console.log('posts after deleting one (should be 1):', postsAfterDelete.length);

// Toggle back off — the button label and the persisted flag should both revert.
await communitySignBtn().click();
await page.waitForTimeout(500);
const labelAfterOff = await communitySignBtn().textContent();
const { instances: instancesAfterOff } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const signInstanceAfterOff = instancesAfterOff.find((i) => i.instanceId === signInstance.instanceId);
console.log('Community Sign button label after toggling off (should be plain again):', labelAfterOff);
console.log('isCommunitySign persisted after toggling off (should be false):', signInstanceAfterOff.isCommunitySign);

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
  deleteResult.status === 200 &&
  postsAfterDelete.length === 1 &&
  labelAfterOff.trim() === 'Community Sign' &&
  signInstanceAfterOff.isCommunitySign === false &&
  errors.length === 0;
await finish(browser, { pass, label: 'Community Sign toggle + sign-posts API', errors });
