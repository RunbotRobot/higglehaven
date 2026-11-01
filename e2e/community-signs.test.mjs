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

// Retries on a network-level failure (fetch() itself rejecting — seen in
// CI as "TypeError: Failed to fetch" right after the community-sign toggle
// POST, not reproducible locally) rather than a non-2xx response, which
// still resolves normally and is left for the caller to read via `status`.
// An uncaught rejection here crashes the whole test process instead of
// just failing an assertion, so a single transient blip shouldn't be fatal.
async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(p, opts);
        return { status: res.status, body: await res.json() };
      } catch (err) {
        lastErr = err;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    throw lastErr;
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

// #1830: posting now requires a session -- these fetch() calls run inside
// the page itself, so they automatically carry this same already-logged-in
// builder's own session cookie. That also means authorLabel is no longer
// client-supplied at all (the server derives it from that session), so
// both posts below land under the SAME real username -- distinguished
// below by their own text, not by a fabricated per-post author name the
// server would ignore anyway.
const { builder: myBuilder } = (await fetchJson('/api/builders/me')).body;
await fetchJson(`/api/instances/${signInstance.instanceId}/posts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'Love this place!' }),
});
await fetchJson(`/api/instances/${signInstance.instanceId}/posts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'Great selection.' }),
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
console.log(`first row mentions author+text (should mention "${myBuilder.label}" and "Love this place!"):`, firstRowText);

// Delete the second post via its row's own × button (not the API directly)
// — this is the actual moderation path a builder would use. Both posts
// share the same real authorLabel now (#1830), so the row is picked out
// by its own text instead.
await page.locator('.sign-post-row').filter({ hasText: 'Great selection.' }).locator('.sign-post-row-delete').click();
// #2388: the moderation delete now requires a removal category, collected
// via this themed modal instead of a plain confirm().
await page.waitForSelector('#moderation-category-modal.visible', { timeout: 5000 });
await page.locator('input[name="moderation-category"][value="other"]').check();
await page.locator('#moderation-category-delete-btn').click();
// #2635 (2nd waitForFunction arg/options sweep): the real applied timeout
// was always Playwright's dishonored 30000ms default, never 5000 -- 30000ms
// here matches that previously-dishonored default so this can't regress.
await page.waitForFunction(() => document.querySelectorAll('.sign-post-row').length === 1, null, { timeout: 30000 });
const rowCountAfterDelete = await page.locator('.sign-post-row').count();
console.log('rows shown after deleting one via the panel (should be 1):', rowCountAfterDelete);

const { posts: postsAfterDelete } = (await fetchJson(`/api/instances/${signInstance.instanceId}/posts`)).body;
console.log(`posts persisted server-side after the panel delete (should be 1, the surviving one authored by "${myBuilder.label}"):`, postsAfterDelete.map((p) => p.authorLabel));

// #2963: a post the panel is still showing a row for, but that's
// already gone server-side by the time its delete button is clicked
// (e.g. a second open copy of this same panel, or the author's own
// composer, got to it first), used to alert and then just leave that
// now-dead row in place, clickable forever, instead of refreshing like
// a successful delete already does.
await fetchJson(`/api/instances/${signInstance.instanceId}/posts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'Soon to be stale.' }),
});
// A fresh API post doesn't itself push an update into an already-open
// panel -- close and reopen via the same toggle button used earlier so
// the panel's own render picks it up.
await page.click('#sign-posts-close-btn');
await communitySignBtn().click();
await page.waitForSelector('#sign-posts-modal.visible', { timeout: 5000 });
await page.waitForTimeout(300);
const rowCountBeforeStaleDelete = await page.locator('.sign-post-row').count();

// Delete it out from under the panel via a direct API call, bypassing
// the panel's own delete button entirely -- simulates the concurrent-
// delete race this fix is for.
const { posts: postsBeforeStaleDelete } = (await fetchJson(`/api/instances/${signInstance.instanceId}/posts`)).body;
const stalePost = postsBeforeStaleDelete.find((p) => p.text === 'Soon to be stale.');
await fetchJson(`/api/instances/${signInstance.instanceId}/posts/${stalePost.postId}`, {
  method: 'DELETE',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ category: 'other' }),
});

// Now click the panel's own delete button for that already-gone row --
// the server rejects it (the post no longer exists), and the fix means
// the panel refreshes itself afterward instead of leaving the dead row
// in place.
await page.locator('.sign-post-row').filter({ hasText: 'Soon to be stale.' }).locator('.sign-post-row-delete').click();
await page.waitForSelector('#moderation-category-modal.visible', { timeout: 5000 });
await page.locator('input[name="moderation-category"][value="other"]').check();
await page.locator('#moderation-category-delete-btn').click();
await page.waitForFunction(() => document.querySelectorAll('.sign-post-row').length === 1, null, { timeout: 30000 });
const rowCountAfterStaleDelete = await page.locator('.sign-post-row').count();
const remainingRowTextAfterStaleDelete = await page.locator('.sign-post-row').first().textContent();
console.log('rows shown before attempting to delete an already-gone post (should be 2):', rowCountBeforeStaleDelete);
console.log('rows shown after that attempt self-heals (should be 1, not stuck at 2 with a dead row):', rowCountAfterStaleDelete);
console.log('remaining row after self-heal (should mention "Love this place!"):', remainingRowTextAfterStaleDelete);

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
// worker/land.test.js's own "Community signs" describe block instead of
// here, same reasoning as the #2963 stale-delete attempt above: a
// deliberately-triggered non-2xx fetch logs a "Failed to load resource"
// console error in the page itself, which this suite's own
// errors-must-be-empty convention would otherwise misread as a real
// bug -- filtered out below, same idiom
// credit-orb-collect-offline-notice.test.mjs's own unexpectedErrors uses.)
const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));

const pass = labelBefore.trim() === 'Community Sign' &&
  labelAfterOn.includes('✓') &&
  signInstance.isCommunitySign === true &&
  posts.length === 2 &&
  posts[0].text === 'Love this place!' &&
  posts.every((p) => p.authorLabel === myBuilder.label) &&
  rowCountInPanel === 2 &&
  firstRowText.includes(myBuilder.label) && firstRowText.includes('Love this place!') &&
  rowCountAfterDelete === 1 &&
  postsAfterDelete.length === 1 && postsAfterDelete[0].authorLabel === myBuilder.label &&
  rowCountBeforeStaleDelete === 2 &&
  rowCountAfterStaleDelete === 1 &&
  remainingRowTextAfterStaleDelete.includes('Love this place!') &&
  modalHiddenAfterUnflag &&
  labelAfterOff.trim() === 'Community Sign' &&
  signInstanceAfterOff.isCommunitySign === false &&
  unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'Community Sign toggle + Manage Posts panel + sign-posts API', errors: unexpectedErrors });
