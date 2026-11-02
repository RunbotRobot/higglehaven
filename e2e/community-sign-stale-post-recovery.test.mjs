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
// recovery lets a fresh note be created) stale delete.
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

// Answers by dialog index (see each step's comment below).
const dialogMessages = [];
const answers = [
  'edit',                   // 1: edit/delete choice, against the stale original note
  'Edited text that is lost', // 2: edit text prompt
  null,                     // 3: alert -- note already removed
  FRESH_TEXT,               // 4: create prompt (only reachable if the stale post was dropped)
  'delete',                 // 5: edit/delete choice, against the stale fresh note
  null,                     // 6: alert -- note already removed
  undefined,                // 7: create prompt again -- cancel it
];
page.removeAllListeners('dialog');
page.on('dialog', async (dialog) => {
  dialogMessages.push(dialog.message());
  const answer = answers[dialogMessages.length - 1];
  if (answer === undefined) await dialog.dismiss();
  else if (answer === null) await dialog.accept();
  else await dialog.accept(answer);
});

async function deleteMyPostsServerSide() {
  const { body } = await fetchJson(postsUrl);
  for (const post of body.posts) {
    await fetchJson(`${postsUrl}/${post.postId}`, { method: 'DELETE' });
  }
  return (await fetchJson(postsUrl)).body.posts.length;
}

// Step A: a moderator removes the original note; the shopper's client still
// holds the stale snapshot and tries to edit it.
const remainingAfterFirstDelete = await deleteMyPostsServerSide();
await page.click('#shop-sign-hint');
await page.waitForTimeout(800);

// Step A2: with the stale post dropped, the next click offers "leave a note"
// (the create prompt), not the edit/delete choice.
await page.click('#shop-sign-hint');
await page.waitForTimeout(800);
const { body: afterCreate } = await fetchJson(postsUrl);

// Step B: the fresh note is removed the same way; the shopper tries to delete it.
const remainingAfterSecondDelete = await deleteMyPostsServerSide();
await page.click('#shop-sign-hint');
await page.waitForTimeout(800);

// Step B2: again the next click must be the create prompt.
await page.click('#shop-sign-hint');
await page.waitForTimeout(800);

// The deliberate 404s above also log Chromium "Failed to load resource"
// console errors independent of the app's own handling.
errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('Failed to load resource')));

const isChoicePrompt = (m) => /^Your note on this sign:/.test(m || '');
console.log('dialogs shown (should be exactly 7):', dialogMessages.length);
console.log('dialog 1 is the edit/delete choice:', isChoicePrompt(dialogMessages[0]));
console.log('dialog 3 (edit on removed note):', dialogMessages[2]);
console.log('dialog 4 is the create prompt, not the stale choice:', !isChoicePrompt(dialogMessages[3]));
console.log('fresh note created server-side after recovery:', afterCreate.posts.length === 1 && afterCreate.posts[0].text === FRESH_TEXT);
console.log('dialog 5 is the edit/delete choice for the fresh note:', isChoicePrompt(dialogMessages[4]));
console.log('dialog 6 (delete on removed note):', dialogMessages[5]);
console.log('dialog 7 is the create prompt, not the stale choice:', !isChoicePrompt(dialogMessages[6]));

const pass = remainingAfterFirstDelete === 0 &&
  remainingAfterSecondDelete === 0 &&
  dialogMessages.length === 7 &&
  isChoicePrompt(dialogMessages[0]) &&
  /already removed/.test(dialogMessages[2] || '') &&
  !isChoicePrompt(dialogMessages[3]) &&
  afterCreate.posts.length === 1 &&
  afterCreate.posts[0].text === FRESH_TEXT &&
  isChoicePrompt(dialogMessages[4]) &&
  /already removed/.test(dialogMessages[5] || '') &&
  !isChoicePrompt(dialogMessages[6]) &&
  errors.length === 0;
await finish(browser, { pass, label: '#2962: a sign note deleted out from under the shopper is dropped locally on the 404, so the next click offers a fresh note instead of the same dead end', errors });
