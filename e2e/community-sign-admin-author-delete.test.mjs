// #4442: the owner (an admin, on their own lándlet) tapped Delete on their own sign note and got "Expected application/json
// request body": the admin moderation branch took the delete before the author's own, and wanted a removal category. The
// author's own delete is the author's whatever else they are. Setup follows community-sign-stale-post-recovery.test.mjs.
import { launchPage, chooseIdentity, claimLandlet, finish, shopStickBox, grantAdmin, emailForLabel } from './helpers.mjs';

const LABEL = 'Sign Admin Author Tester';
const NOTE_TEXT = 'This is a test.';

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

await grantAdmin(emailForLabel(LABEL)); // the owner is an admin on their own lándlet
await fetchJson(postsUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: NOTE_TEXT }),
});

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

const moveJoystickBox = await shopStickBox(page);
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


const postsBefore = (await fetchJson(postsUrl)).body.posts;
await page.click('#shop-sign-hint');
await page.waitForSelector('#note-modal.visible', { timeout: 5000 });
const title = await page.textContent('#note-modal-title');
await page.click('#note-modal-delete-btn');
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
await page.click('#confirm-modal-confirm-btn');
await page.waitForFunction(() => !document.getElementById('note-modal').classList.contains('visible'), null, { timeout: 5000 });
await page.waitForTimeout(500);
const noticeShown = await page.evaluate(() => document.getElementById('notice-modal')?.classList.contains('visible') || false);
const postsAfter = (await fetchJson(postsUrl)).body.posts;
console.log('notes before and after the delete:', postsBefore.length, postsAfter.length, '| edit title:', title, '| a notice appeared:', noticeShown);

const pass = postsBefore.length === 1 && /^Your note on this sign/.test(title) && postsAfter.length === 0 && !noticeShown && errors.length === 0;
await finish(browser, { pass, label: '#4442: an admin who owns the lándlet deletes their own sign note from the confirm, with no "Expected application/json request body" refusal', errors });
