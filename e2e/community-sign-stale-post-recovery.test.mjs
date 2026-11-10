// Regression test for #2962: shopSignHintEl's edit/delete branches
// (src/main.js) derive "my post" from sign.posts, which is fetched once and
// deliberately not re-fetched (worldSprites.js registerShopSign). When a
// moderator deletes the shopper's note meanwhile, the server correctly 404s
// the edit/delete (#2354) -- but nothing dropped the stale post locally, so
// every later click offered the same edit/delete prompt against a post that
// no longer exists, a dead end the shopper could never leave.
//
// Setup (teleport next to a real community sign, force the real per-frame
// proximity logic) follows community-sign-edit-char-limit-guard.test.mjs.
// Both branches are driven through the real UI: stale edit, then (after the
// recovery lets a fresh note be created) stale delete. (#3359: the note flow is
// an in-app modal now, so this drives that modal and reads the notice.)
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Sign Stale Post Tester';
const ORIGINAL_TEXT = 'Original note left on this sign.';
const FRESH_TEXT = 'Fresh note after the first was removed.';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

async function fetchJson(p, options) {
  return page.evaluate(async ([pp, opts]) => {
    const res = await fetch(pp, opts);
    let body = null;
    try { body = await res.json(); } catch { /* DELETE may return an empty body */ }
    return { status: res.status, body };
  }, [p, options]);
}

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);
await page.locator('#toggle-community-sign').click();
await page.waitForTimeout(500);

const { landlets } = (await fetchJson('/api/landlets?limit=100')).body;
const myLandlet = landlets.find((l) => l.ownerBuilderId);
const { instances } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const signInstance = instances.find((i) => i.templateId === 'placeholder-tree');
const signWorldX = myLandlet.center.x + signInstance.x;
const signWorldY = myLandlet.center.y + signInstance.y;
const postsUrl = `/api/instances/${signInstance.instanceId}/posts`;

await fetchJson(postsUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: ORIGINAL_TEXT }),
});

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveCenterX, moveCenterY);
await page.mouse.down();
await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y);
  window.__testForceShopProximityCheck();
}, [myLandlet.center.x, myLandlet.center.y]);
await page.waitForTimeout(500);
await page.evaluate(([x, y, z]) => {
  window.__testTeleportShopAvatar(x, y, z);
  window.__testForceShopProximityCheck();
}, [signWorldX, signWorldY, 0]);
await page.waitForSelector('#shop-sign-hint.visible', { timeout: 5000 });
await page.evaluate(() => document.body.classList.remove('shop-flying'));

// #3359: the sign note flow is an in-app modal (src/ui/textNoteModal.js) and the
// "already removed" message an in-app notice, not native prompt()/alert().
// Native dialogs are dismissed and recorded as a tripwire for a regression.
const nativeDialogs = [];
page.removeAllListeners('dialog');
page.on('dialog', async (dialog) => {
  nativeDialogs.push(dialog.message());
  await dialog.dismiss();
});

async function deleteMyPostsServerSide() {
  const { body } = await fetchJson(postsUrl);
  for (const post of body.posts) {
    await fetchJson(`${postsUrl}/${post.postId}`, { method: 'DELETE' });
  }
  return (await fetchJson(postsUrl)).body.posts.length;
}

async function tapSign() {
  await page.click('#shop-sign-hint');
  await page.waitForSelector('#note-modal.visible', { timeout: 5000 });
  return page.textContent('#note-modal-title');
}
async function closeNotice() {
  await page.waitForSelector('#notice-modal.visible', { timeout: 5000 });
  const text = `${await page.textContent('#notice-modal-title')} -- ${await page.textContent('#notice-modal-message')}`;
  await page.click('#notice-modal-ok-btn');
  await page.waitForFunction(() => !document.getElementById('notice-modal').classList.contains('visible'), null, { timeout: 5000 });
  return text;
}
const noteModalClosed = () => page.waitForFunction(() => !document.getElementById('note-modal').classList.contains('visible'), null, { timeout: 5000 });
const isEditTitle = (t) => /^Your note on this sign/.test(t || '');

// Step A: a moderator removes the original note; the shopper's client still
// holds the stale snapshot and tries to edit it.
const remainingAfterFirstDelete = await deleteMyPostsServerSide();
const titleA = await tapSign();
await page.fill('#note-modal-text', 'Edited text that is lost');
await page.click('#note-modal-save-btn');
const noticeA = await closeNotice();
await noteModalClosed();

// Step A2: with the stale post dropped, the next click offers "leave a note"
// (the create modal), not the edit/delete one.
const titleA2 = await tapSign();
await page.fill('#note-modal-text', FRESH_TEXT);
await page.click('#note-modal-save-btn');
await noteModalClosed();
await page.waitForTimeout(500);
const { body: afterCreate } = await fetchJson(postsUrl);

// Step B: the fresh note is removed the same way; the shopper tries to delete it.
const remainingAfterSecondDelete = await deleteMyPostsServerSide();
const titleB = await tapSign();
await page.click('#note-modal-delete-btn');
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
await page.click('#confirm-modal-confirm-btn');
const noticeB = await closeNotice();
await noteModalClosed();

// Step B2: again the next click must be the create modal -- cancel it.
const titleB2 = await tapSign();
await page.click('#note-modal-cancel-btn');
await noteModalClosed();

// The deliberate 404s above also log Chromium "Failed to load resource"
// console errors independent of the app's own handling.
errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('Failed to load resource')));

console.log('modal titles (edit, create, edit, create):', titleA, '|', titleA2, '|', titleB, '|', titleB2);
console.log('notice after the edit on a removed note:', noticeA);
console.log('notice after the delete on a removed note:', noticeB);
console.log('fresh note created server-side after recovery:', afterCreate.posts.length === 1 && afterCreate.posts[0].text === FRESH_TEXT);
console.log('native dialogs (should be none):', nativeDialogs);

const pass = remainingAfterFirstDelete === 0 &&
  remainingAfterSecondDelete === 0 &&
  isEditTitle(titleA) &&
  /already removed/.test(noticeA) &&
  !isEditTitle(titleA2) &&
  afterCreate.posts.length === 1 &&
  afterCreate.posts[0].text === FRESH_TEXT &&
  isEditTitle(titleB) &&
  /already removed/.test(noticeB) &&
  !isEditTitle(titleB2) &&
  nativeDialogs.length === 0 &&
  errors.length === 0;
await finish(browser, { pass, label: '#2962: a sign note deleted out from under the shopper is dropped locally on the 404, so the next click offers a fresh note instead of the same dead end', errors });
