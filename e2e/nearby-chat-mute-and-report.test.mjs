// #2956: parity with proximity voice chat's own per-peer mute+report pair
// (#2819, e2e/voice-chat-core.test.mjs) -- resolved directly by AGENTS.md's
// "Standing owner decisions" -> "Parity across sibling surfaces" default
// (2026-11-02) rather than left owner-gated. Mute is purely local/client-
// side (src/shop/nearbyChat.js) and removes/suppresses a sender's messages
// in the flat chat log; report hits the real POST /api/nearby-chat/report
// endpoint (mocked here, covered for real server-side in
// worker/nearby-chat-report.test.js).
//
// Same trustTier-client-side-patch workaround nearby-chat-send-failure.test.mjs
// already documents and uses (this deployment never configures
// DIDIT_API_KEY, so there's no real way to drive an account to
// trust_tier === 'id_verified' otherwise).
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPORT_REASON = 'inappropriate conduct';
const LABEL = 'Nearby Chat Mute Report Tester';
// chooseIdentity's own signup flow (below) fills real form fields, not a
// window.prompt() -- so this test's one and only prompt() is
// reportNearbyChatSender's own "optional reason" prompt
// (src/shop/nearbyChat.js). launchPage's own dialog handler answers every
// prompt() for the page's whole lifetime with `promptAnswer` -- reusing it
// here for the report's reason text, rather than also registering a
// second competing 'prompt' handler (two listeners on the same dialog
// both calling dialog.accept() throws "already handled").
const { browser, page, errors } = await launchPage({ promptAnswer: REPORT_REASON });

async function patchTrustTierToIdVerified(route) {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
}
await page.route('**/api/auth/me', patchTrustTierToIdVerified);
await page.route('**/api/auth/signup', patchTrustTierToIdVerified);

const MUTED_BUILDER_ID = 'builder-to-mute';
const REPORTED_BUILDER_ID = 'builder-to-report';

let pollCount = 0;
await page.route('**/api/nearby-chat?*', async (route) => {
  pollCount += 1;
  // First poll: one message from each of the two other builders. Second
  // and later polls: a fresh message from the muted builder, to confirm
  // muting suppresses *future* messages too, not just the already-
  // rendered one.
  const messages = pollCount === 1
    ? [
      { messageId: 'msg-from-muted-1', builderId: MUTED_BUILDER_ID, text: 'hello from the muted one', createdAt: new Date().toISOString() },
      { messageId: 'msg-from-reported-1', builderId: REPORTED_BUILDER_ID, text: 'hello from the reported one', createdAt: new Date().toISOString() },
    ]
    : [
      { messageId: 'msg-from-muted-2', builderId: MUTED_BUILDER_ID, text: 'a second message, after being muted', createdAt: new Date().toISOString() },
    ];
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages, nextCursor: `cursor-${pollCount}`, landletId: 'landlet-1' }) });
});

let reportRequestBody = null;
await page.route('**/api/nearby-chat/report', async (route) => {
  reportRequestBody = JSON.parse(route.request().postData());
  await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ reportId: 'nearby-chat-report-test-1' }) });
});

// Observes only -- launchPage's own built-in handler already accepts every
// dialog type (prompt with `promptAnswer`, everything else including the
// confirming alert below with no text), so this must not also call
// dialog.accept()/dismiss() itself (two listeners both resolving the same
// dialog throws "already handled").
const dialogMessages = [];
page.on('dialog', (dialog) => {
  dialogMessages.push({ type: dialog.type(), message: dialog.message() });
});

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

await page.waitForSelector('#shop-nearby-chat-btn.visible', { timeout: 10000 });
await page.click('#shop-nearby-chat-btn');
await page.waitForSelector('#shop-nearby-chat-panel.open', { timeout: 5000 });

await page.waitForSelector(`.shop-nearby-chat-message[data-builder-id="${MUTED_BUILDER_ID}"]`, { timeout: 10000 });
await page.waitForSelector(`.shop-nearby-chat-message[data-builder-id="${REPORTED_BUILDER_ID}"]`, { timeout: 10000 });

const bothMessagesVisibleBeforeMute = (await page.locator('.shop-nearby-chat-message').count()) === 2;
console.log('both messages visible before muting (should be true):', bothMessagesVisibleBeforeMute);

await page.click(`.shop-nearby-chat-message[data-builder-id="${MUTED_BUILDER_ID}"] button[data-action="mute"]`);

const mutedMessageRemoved = await page.waitForFunction(
  (builderId) => !document.querySelector(`.shop-nearby-chat-message[data-builder-id="${builderId}"]`),
  MUTED_BUILDER_ID,
  { timeout: 5000 },
).then(() => true).catch(() => false);
console.log('muted sender\'s already-visible message removed immediately (should be true):', mutedMessageRemoved);

const reportedMessageStillVisible = (await page.locator(`.shop-nearby-chat-message[data-builder-id="${REPORTED_BUILDER_ID}"]`).count()) === 1;
console.log('the other (non-muted) sender\'s message is untouched (should be true):', reportedMessageStillVisible);

// A later poll delivers a brand-new message from the now-muted builder --
// it should never be appended at all.
await page.waitForTimeout(2200); // > NEARBY_CHAT_POLL_INTERVAL_MS, so the next poll tick fires
const laterMessageFromMutedSuppressed = (await page.locator(`.shop-nearby-chat-message[data-builder-id="${MUTED_BUILDER_ID}"]`).count()) === 0;
console.log('a later message from the muted sender is never rendered (should be true):', laterMessageFromMutedSuppressed);

await page.click(`.shop-nearby-chat-message[data-builder-id="${REPORTED_BUILDER_ID}"] button[data-action="report"]`);
// Poll for both dialogs (prompt, then the confirming alert) to have landed
// -- same "poll, don't fixed-wait" idiom nearby-chat-send-failure.test.mjs's
// own comment already documents, rather than a single fixed sleep.
for (let i = 0; i < 20 && dialogMessages.length < 2; i += 1) {
  await page.waitForTimeout(250);
}

console.log('dialogs seen (should be one prompt then one alert):', dialogMessages.map((d) => d.type));
console.log('report request sent with the reported builder id and typed reason (should be true):',
  reportRequestBody?.reportedBuilderId === REPORTED_BUILDER_ID && reportRequestBody?.reason === REPORT_REASON);

const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));

const pass =
  bothMessagesVisibleBeforeMute &&
  mutedMessageRemoved &&
  reportedMessageStillVisible &&
  laterMessageFromMutedSuppressed &&
  dialogMessages.length === 2 &&
  dialogMessages[0].type === 'prompt' &&
  dialogMessages[1].type === 'alert' &&
  reportRequestBody?.reportedBuilderId === REPORTED_BUILDER_ID &&
  reportRequestBody?.reason === REPORT_REASON &&
  unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'Nearby chat mute hides a sender\'s messages (past and future) and report submits to the server (#2956)', errors });
