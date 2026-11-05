// #3128: a nearby-chat mute used to last only for the page session -- a reload
// brought the muted sender straight back and there was no way to unmute. The
// mute is now kept per account in localStorage and a "Muted (N)" list in the
// chat panel offers Unmute. Same trustTier client-side-patch workaround and
// mocked poll endpoint as nearby-chat-mute-and-report.test.mjs (muting itself
// is purely local; nothing reaches the server).
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Nearby Chat Mute Persist Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: 'unused' });

async function patchTrustTierToIdVerified(route) {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
}
await page.route('**/api/auth/me', patchTrustTierToIdVerified);
await page.route('**/api/auth/signup', patchTrustTierToIdVerified);


const MUTED_BUILDER_ID = 'builder-to-mute';
const OTHER_BUILDER_ID = 'builder-other';

// Every poll returns the same two messages (the log dedupes by messageId), so
// after an Unmute the rebuilt log can be told apart by the muted one returning.
await page.route('**/api/nearby-chat?*', async (route) => {
  const messages = [
    { messageId: 'msg-muted-1', builderId: MUTED_BUILDER_ID, text: 'hello from the muted one', createdAt: new Date().toISOString() },
    { messageId: 'msg-other-1', builderId: OTHER_BUILDER_ID, text: 'hello from the other one', createdAt: new Date().toISOString() },
  ];
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages, nextCursor: 'cursor-1', landletId: 'landlet-1' }) });
});

const msg = (builderId) => `.shop-nearby-chat-message[data-builder-id="${builderId}"]`;

async function openChat() {
  await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
  await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
  await page.waitForSelector('#shop-nearby-chat-btn.visible', { timeout: 10000 });
  await page.click('#shop-nearby-chat-btn');
  await page.waitForSelector('#shop-nearby-chat-panel.open', { timeout: 5000 });
  await page.waitForSelector(msg(OTHER_BUILDER_ID), { timeout: 10000 });
}

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await openChat();
const mutedVisibleBefore = (await page.locator(msg(MUTED_BUILDER_ID)).count()) === 1;
const controlHiddenBefore = await page.locator('#shop-nearby-chat-muted').isHidden();
console.log('muted-to-be sender visible and the Muted control hidden before muting (should be true):', mutedVisibleBefore, controlHiddenBefore);

await page.click(`${msg(MUTED_BUILDER_ID)} button[data-action="mute"]`);
await page.waitForFunction((sel) => !document.querySelector(sel), msg(MUTED_BUILDER_ID), { timeout: 5000 });
await page.waitForSelector('#shop-nearby-chat-muted:not([hidden])', { timeout: 5000 });
const toggleTextAfterMute = (await page.locator('#shop-nearby-chat-muted-toggle').textContent()).trim();
console.log('Muted control shows "Muted (1)" (should be true):', toggleTextAfterMute === 'Muted (1)');

// --- Reload: the mute must hold. ---
await page.reload();
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await openChat();
await page.waitForTimeout(2600); // > one poll interval, so the muted sender's message would have arrived by now
const mutedStillHidden = (await page.locator(msg(MUTED_BUILDER_ID)).count()) === 0;
await page.waitForSelector('#shop-nearby-chat-muted:not([hidden])', { timeout: 5000 });
const toggleTextAfterReload = (await page.locator('#shop-nearby-chat-muted-toggle').textContent()).trim();
console.log('muted sender still hidden after a reload (should be true):', mutedStillHidden);
console.log('Muted control still shows "Muted (1)" after a reload (should be true):', toggleTextAfterReload === 'Muted (1)');

// --- Unmute: the sender comes back and the control goes away. ---
await page.click('#shop-nearby-chat-muted-toggle');
await page.waitForSelector('#shop-nearby-chat-muted-list:not([hidden]) button[data-action="unmute"]', { timeout: 5000 });
await page.click('#shop-nearby-chat-muted-list button[data-action="unmute"]');
const mutedBack = await page.waitForSelector(msg(MUTED_BUILDER_ID), { timeout: 10000 }).then(() => true).catch(() => false);
const controlHiddenAfterUnmute = await page.locator('#shop-nearby-chat-muted').isHidden();
console.log('unmuted sender\'s messages return (should be true):', mutedBack);
console.log('Muted control hidden again once nothing is muted (should be true):', controlHiddenAfterUnmute);

const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));
const pass = mutedVisibleBefore
  && controlHiddenBefore
  && toggleTextAfterMute === 'Muted (1)'
  && mutedStillHidden
  && toggleTextAfterReload === 'Muted (1)'
  && mutedBack
  && controlHiddenAfterUnmute
  && unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'Nearby chat mute survives a reload and Unmute restores the sender (#3128)', errors });
