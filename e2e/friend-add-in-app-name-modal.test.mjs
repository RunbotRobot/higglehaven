// #3359 (part of #3249's native-dialog sweep): "+ Add Friend" asked for the
// friend's name with window.prompt(), which a browser that suppresses native
// dialogs answers with nothing, so the button silently did nothing. It now uses
// the in-app name modal. Every native dialog is dismissed the way a suppressing
// browser would, at phone width: Cancel does nothing, a name nobody has shows
// the "No builder named" message in the Friends modal, and no native dialog is
// ever raised.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, addFriendByName, finish } from './helpers.mjs';

const LABEL = 'Add Friend Modal Tester';
const NOBODY = 'Nobody Has This Builder Name';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 800 } });

let nativeDialogs = 0;
page.removeAllListeners('dialog');
page.on('dialog', async (dialog) => {
  nativeDialogs += 1;
  await dialog.dismiss();
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await openAccountMenu(page);
await page.click('#friends-btn');
await page.waitForSelector('#friends-modal.visible', { timeout: 5000 });

// The button opens the in-app modal, titled with the exact-match guidance.
await page.click('#friends-add-btn');
await page.waitForSelector('#bundle-name-modal.visible', { timeout: 10000 });
const title = (await page.textContent('#bundle-name-modal-title')).trim();
const titleMentionsFriend = /Friend's name/.test(title);
const focusOnInput = await page.evaluate(() => document.activeElement?.id === 'bundle-name-input');

// Cancel: nothing is sent, the Friends modal is still open and untouched.
await page.click('#bundle-name-cancel-btn');
await page.waitForFunction(() => !document.getElementById('bundle-name-modal').classList.contains('visible'), null, { timeout: 5000 });
const friendsStillOpen = (await page.locator('#friends-modal.visible').count()) === 1;
const statusAfterCancel = (await page.textContent('#friends-status')).trim();

// A name nobody has: the not-found message appears in the Friends modal.
await addFriendByName(page, NOBODY);
await page.waitForFunction(() => document.getElementById('friends-status').textContent.includes('No builder named'), null, { timeout: 15000 });
const notFound = (await page.textContent('#friends-status')).trim();
const notFoundIsError = await page.evaluate(() => document.getElementById('friends-status').classList.contains('error'));

console.log('modal title:', title, '| focus on input:', focusOnInput);
console.log('status after cancel (should be empty):', JSON.stringify(statusAfterCancel));
console.log('not-found message:', notFound);
console.log('native dialogs raised (should be 0):', nativeDialogs);

const pass = titleMentionsFriend && focusOnInput && friendsStillOpen && statusAfterCancel === ''
  && notFound.includes(NOBODY) && notFoundIsError && nativeDialogs === 0 && errors.length === 0;
await finish(browser, { pass, label: '+ Add Friend asks for the name in the in-app modal and works with native dialogs suppressed (#3359)', errors });
