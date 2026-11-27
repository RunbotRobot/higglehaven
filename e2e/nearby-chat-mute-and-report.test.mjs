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
import { launchPage, chooseIdentity, finish, budClick } from './helpers.mjs';

const REPORT_REASON = 'inappropriate conduct';
const LABEL = 'Nearby Chat Mute Report Tester';
// #3359: the report reason is collected in the in-app report modal and the
// outcome shown in the in-app notice -- no native dialogs are involved.
const { browser, page, errors } = await launchPage();

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

// Any native dialog is a regression (#3359): record it so the test fails.
const dialogMessages = [];
page.on('dialog', async (dialog) => {
  dialogMessages.push({ type: dialog.type(), message: dialog.message() });
  await dialog.dismiss();
});

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

await budClick(page, '#bud-petal-shop-chat'); // #3556: the Chat petal of the flower
await page.waitForSelector('#shop-nearby-chat-panel.open', { timeout: 5000 });

await page.waitForSelector(`.shop-nearby-chat-message[data-builder-id="${MUTED_BUILDER_ID}"]`, { timeout: 10000 });
await page.waitForSelector(`.shop-nearby-chat-message[data-builder-id="${REPORTED_BUILDER_ID}"]`, { timeout: 10000 });

const bothMessagesVisibleBeforeMute = (await page.locator('.shop-nearby-chat-message').count()) === 2;
console.log('both messages visible before muting (should be true):', bothMessagesVisibleBeforeMute);

// #3551: the actions are hidden until a line is tapped, one line at a time.
const actionsHiddenAtFirst = (await page.locator('.shop-nearby-chat-message-actions:visible').count()) === 0;
console.log('no line shows its actions until tapped (should be true):', actionsHiddenAtFirst);
await page.click(`.shop-nearby-chat-message[data-builder-id="${REPORTED_BUILDER_ID}"] .shop-nearby-chat-message-text`);
await page.click(`.shop-nearby-chat-message[data-builder-id="${MUTED_BUILDER_ID}"] .shop-nearby-chat-message-text`);
const onlyOneLineOpen = (await page.locator('.shop-nearby-chat-message-actions:visible').count()) === 1
  && (await page.locator(`.shop-nearby-chat-message[data-builder-id="${MUTED_BUILDER_ID}"] .shop-nearby-chat-message-actions:visible`).count()) === 1;
console.log('tapping a second line hides the first line\'s actions (should be true):', onlyOneLineOpen);
// #4596: the three safety actions are quiet buttons, so a thumb can hit each: at least 44px tall and 44px wide.
// Only the line that was tapped open is measured: a later poll can already have added a second line from the same
// sender (its actions stay hidden, 0 by 0), and on a slow machine that is where the six chips of one run came from.
const chipSizes = await page.evaluate((builderId) => [...document.querySelectorAll(`.shop-nearby-chat-message.actions-open[data-builder-id="${builderId}"] .shop-nearby-chat-message-actions button`)]
  .map((b) => { const r = b.getBoundingClientRect(); return { action: b.dataset.action, w: Math.round(r.width), h: Math.round(r.height) }; }), MUTED_BUILDER_ID);
console.log('action chip sizes:', JSON.stringify(chipSizes));
const chipsBigEnough = chipSizes.length === 3 && chipSizes.every((c) => c.h >= 44 && c.w >= 44);
console.log('Mute, Report and Block are each at least 44 by 44 px (should be true):', chipsBigEnough);
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

await page.click(`.shop-nearby-chat-message[data-builder-id="${REPORTED_BUILDER_ID}"] .shop-nearby-chat-message-text`);
await page.click(`.shop-nearby-chat-message[data-builder-id="${REPORTED_BUILDER_ID}"] button[data-action="report"]`);
await page.waitForSelector('#report-reason-modal.visible', { timeout: 5000 });
await page.fill('#report-reason-input', REPORT_REASON);
await page.click('#report-reason-submit-btn');
const reportedLine = `.shop-nearby-chat-message[data-builder-id="${REPORTED_BUILDER_ID}"] .inline-action-status`;
await page.waitForSelector(reportedLine, { state: 'visible', timeout: 5000 });
const noticeTitle = await page.textContent(reportedLine);
const blockingModalOpen = await page.evaluate(() => document.getElementById('notice-modal')?.classList.contains('visible') ?? false);
console.log('confirmation said on the reported message (should be "Report sent. Thank you."):', noticeTitle, '| blocking modal open (should be false):', blockingModalOpen);
const stillThere = await page.locator(reportedLine).isVisible();
const noFloatingNote = (await page.locator('#fading-note').count()) === 0;
console.log('the confirmation stays on the message, nothing floats over the world (should be true, true):', stillThere, noFloatingNote);
console.log('no native dialog was raised (should be 0):', dialogMessages.length);
console.log('report request sent with the reported builder id and typed reason (should be true):',
  reportRequestBody?.reportedBuilderId === REPORTED_BUILDER_ID && reportRequestBody?.reason === REPORT_REASON);

const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));

const pass =
  bothMessagesVisibleBeforeMute &&
  actionsHiddenAtFirst &&
  onlyOneLineOpen &&
  chipsBigEnough &&
  mutedMessageRemoved &&
  reportedMessageStillVisible &&
  laterMessageFromMutedSuppressed &&
  dialogMessages.length === 0 &&
  noticeTitle === 'Report sent. Thank you.' &&
  !blockingModalOpen &&
  reportRequestBody?.reportedBuilderId === REPORTED_BUILDER_ID &&
  reportRequestBody?.reason === REPORT_REASON &&
  unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'Nearby chat mute hides a sender\'s messages (past and future) and report submits to the server (#2956)', errors });
