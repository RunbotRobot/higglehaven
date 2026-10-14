// Regression test for #2015: shopSignHintEl's "edit" branch (src/main.js,
// the choice==='edit' arm of its click handler) never had the #1920
// client-side 280-char guard the sibling "create a new note" branch 17
// lines below it already has. Without it, an over-280-char edit reaches
// the server's own PATCH /instances/:id/posts/:postId 280-char check,
// gets rejected, and the typed text is lost (the prompt isn't reopened
// with it prefilled) -- the exact UX bug #1920 fixed, just missed on this
// sibling branch.
//
// Shop mode's own real proximity detection (updateSignFade, driven by
// camera distance each frame) isn't reliably automatable via real avatar
// movement -- see community-signs.test.mjs's own header comment and
// index.html's #shop-sign-hint CSS comment. Instead this uses the same
// "teleport + force the real per-frame logic" convention
// shop-walk-after-landing-on-object.test.mjs (#1829) already established:
// window.__testTeleportShopAvatar lands the avatar within
// SIGN_INTERACT_RADIUS_M of the sign, and a real animate() tick (just a
// short wait, since updateSignFade runs unconditionally every frame,
// unlike the throttled window.__testForceShopProximityCheck) picks up the
// proximity and flips #shop-sign-hint to .visible on its own.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Sign Edit Char Limit Tester';
const ORIGINAL_TEXT = 'Original note left on this sign.';
const OVERLONG_TEXT = 'x'.repeat(300);

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

async function fetchJson(p, options) {
  return page.evaluate(async ([pp, opts]) => {
    const res = await fetch(pp, opts);
    return { status: res.status, body: await res.json() };
  }, [p, options]);
}

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

// Place a Tree (placeholder-tree) and flag it as a Community Sign, same
// setup as community-signs.test.mjs.
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

// mesh.position.x/y are landlet-local -- add the landlet's own world center
// to get the real world position the Shop-mode avatar needs to stand near
// (same computation shop-walk-after-landing-on-object.test.mjs uses).
const signWorldX = myLandlet.center.x + signInstance.x;
const signWorldY = myLandlet.center.y + signInstance.y;
// Leave a post under this same logged-in account -- #1830 means posts are
// tied to the real session (not a client-supplied author), so this lands
// as "my own post," reaching the edit/delete branch rather than the
// no-existing-post create branch.
await fetchJson(`/api/instances/${signInstance.instanceId}/posts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: ORIGINAL_TEXT }),
});

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// #1445: a brief real joystick deflection breaks Shop mode's own hands-off
// spawn orbit, freeing shopAvatarPosition for the teleport hook to drive.
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveCenterX, moveCenterY);
await page.mouse.down();
await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

// Teleport onto the landlet's own center first and force the load decision
// so the sign's own mesh is actually resolved into shopLandlets/shopSigns
// before standing right next to it -- same two-step sequence
// shop-walk-after-landing-on-object.test.mjs (#1829) uses for the same
// reason (a real load decision, not a teleport alone, is what populates
// the per-frame-scanned sign list updateSignFade reads).
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y);
  window.__testForceShopProximityCheck();
}, [myLandlet.center.x, myLandlet.center.y]);
await page.waitForTimeout(500);

await page.evaluate(([x, y, z]) => {
  window.__testTeleportShopAvatar(x, y, z);
  window.__testForceShopProximityCheck();
}, [signWorldX, signWorldY, 0]);
// updateSignFade runs every animate() frame unconditionally (unlike the
// throttled proximity check above) -- give it a couple of real frames to
// notice the teleport and flip #shop-sign-hint to .visible on its own.
await page.waitForSelector('#shop-sign-hint.visible', { timeout: 5000 });
// The teleport hook's own comment calls z!==undefined a genuine "already
// landed" snapshot (it force-sets shopFlightState to 'grounded'), but the
// spawn flow's still-in-progress orbit-and-descend choreography hasn't yet
// run the real landing transition that flips body.shop-flying off --
// leaving #shop-vertical-controls' fly-up/down buttons visually on top of
// #shop-sign-hint even though the avatar is, by every real state variable,
// already standing still next to the sign. Clearing the stale class
// directly matches what that real transition would do; nothing this test
// checks depends on the flight UI itself.
await page.evaluate(() => document.body.classList.remove('shop-flying'));

// Replace launchPage's own single-answer dialog handler: this flow shows
// three dialogs in strict sequence (the edit/delete choice prompt, the
// text prompt prefilled with the existing note, then the client-side
// guard's own alert), each needing a different answer.
const dialogMessages = [];
let dialogCount = 0;
page.removeAllListeners('dialog');
page.on('dialog', (dialog) => {
  dialogMessages.push(dialog.message());
  dialogCount += 1;
  if (dialogCount === 1) return dialog.accept('edit');
  if (dialogCount === 2) return dialog.accept(OVERLONG_TEXT);
  return dialog.accept();
});

let patchRequestCount = 0;
await page.route('**/api/instances/*/posts/*', async (route) => {
  if (route.request().method() === 'PATCH') patchRequestCount += 1;
  await route.continue();
});

await page.click('#shop-sign-hint');
await page.waitForTimeout(500);

const { posts: postsAfterOverlongEdit } = (await fetchJson(`/api/instances/${signInstance.instanceId}/posts`)).body;

console.log('dialogs shown (should be exactly 3 -- choice, text, guard alert):', dialogMessages.length);
console.log('third dialog message (should mention the 280-char guard):', dialogMessages[2]);
console.log('PATCH requests sent for the over-280-char edit (should be 0 -- caught client-side):', patchRequestCount);
console.log('post text server-side after the attempted over-long edit (should be unchanged):', postsAfterOverlongEdit[0]?.text === ORIGINAL_TEXT);

const pass = dialogMessages.length === 3 &&
  /280/.test(dialogMessages[2] || '') &&
  patchRequestCount === 0 &&
  postsAfterOverlongEdit.length === 1 &&
  postsAfterOverlongEdit[0].text === ORIGINAL_TEXT &&
  errors.length === 0;
await finish(browser, { pass, label: '#2015: sign-post edit prompt enforces the 280-char guard client-side, same as the create path', errors });
