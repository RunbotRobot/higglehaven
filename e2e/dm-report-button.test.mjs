// #4169: "Report this person" in the Messages header, next to Block. Reporting someone you have a thread with was the
// one thing nearby chat and voice offered and direct messages did not. Same mocking technique as dm-load-more.test.mjs
// (a real DM needs two ID-verified accounts, which this deployment cannot make): the thread and friends list are mocked
// and the report request is recorded. Checks: the button sits in the header beside Block; Cancel sends nothing; sending
// posts the person's id and the optional reason once and says so in the thread's own status line; a refusal is said
// there too and stays; and nothing about it reaches the other person (the client sends only the one request).
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'DM Report Tester';
const FRIEND_LABEL = 'DM Report Friend';
const FRIEND_BUILDER_ID = 'fake-dm-report-friend';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await page.route('**/api/auth/me', async (route) => {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
});
await page.route('**/api/voice/signal*', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], nextCursor: null, landletId: null }) });
});
await page.route('**/api/voice/friend-channels*', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ channels: [] }) });
});
await page.route('**/api/friendships*', async (route) => {
  const friendships = [{
    friendshipId: 'fake-friendship-report', otherBuilderId: FRIEND_BUILDER_ID, otherLabel: FRIEND_LABEL,
    status: 'accepted', direction: 'outgoing', otherLandlet: null,
  }];
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ friendships, nextCursor: null }) });
});
await page.route('**/api/direct-messages/unread-count', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0 }) });
});
await page.route('**/api/direct-messages/mark-read', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
});
await page.route('**/api/direct-messages*', async (route) => {
  await route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ messages: [{ messageId: 'fake-report-msg', senderBuilderId: FRIEND_BUILDER_ID, text: 'hello', createdAt: new Date().toISOString() }], nextCursor: null }),
  });
});

const reportBodies = [];
let refuseNext = false;
await page.route('**/api/direct-messages/reports', async (route) => {
  reportBodies.push(JSON.parse(route.request().postData() || '{}'));
  if (refuseNext) {
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'You can only report someone you have exchanged messages with' }) });
    return;
  }
  await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ reportId: 'fake-report' }) });
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await openAccountMenu(page);
await page.click('#friends-btn');
await page.waitForSelector('#friends-modal.visible', { timeout: 5000 });
await page.waitForFunction(() => document.querySelectorAll('#friends-accepted-list .friend-row').length > 0, null, { timeout: 30000 });
await page.locator('#friends-accepted-list .friend-row').filter({ hasText: FRIEND_LABEL }).locator('button', { hasText: 'Message' }).click();
await page.waitForSelector('#dm-modal.visible', { timeout: 5000 });
await page.waitForFunction(() => document.querySelectorAll('#dm-list .dm-row').length === 1, null, { timeout: 60000 });

const beside = await page.evaluate(() => {
  const report = document.getElementById('dm-report-btn')?.getBoundingClientRect();
  const block = document.getElementById('dm-block-btn')?.getBoundingClientRect();
  const list = document.getElementById('dm-list')?.getBoundingClientRect();
  return { present: !!report && !!block, sameRow: !!report && !!block && Math.abs(report.top - block.top) < 4, aboveList: !!report && !!list && report.bottom <= list.top };
});
console.log('Report sits in the header beside Block, above the thread (should be true, true, true):', beside.present, beside.sameRow, beside.aboveList);

// Cancel sends nothing.
await page.click('#dm-report-btn');
await page.waitForSelector('#report-reason-modal.visible', { timeout: 5000 });
await page.click('#report-reason-cancel-btn');
await page.waitForSelector('#report-reason-modal:not(.visible)', { state: 'attached', timeout: 5000 });
const afterCancel = reportBodies.length;
console.log('Cancel sent no report (should be 0):', afterCancel);

// Send with a reason.
await page.click('#dm-report-btn');
await page.waitForSelector('#report-reason-modal.visible', { timeout: 5000 });
await page.fill('#report-reason-input', 'keeps messaging after I asked them to stop');
await page.click('#report-reason-submit-btn');
await page.waitForFunction(() => /Report sent/.test(document.getElementById('dm-status').textContent), null, { timeout: 10000 });
const sent = { ...reportBodies[0] };
console.log('Report posted the person and the reason once (should be the friend id, the reason, 1):', sent.reportedBuilderId, sent.reason, reportBodies.length);
const sentStatusIsError = await page.evaluate(() => document.getElementById('dm-status').classList.contains('error'));

// A refusal is said in the same line, as an error, and stays.
refuseNext = true;
await page.click('#dm-report-btn');
await page.waitForSelector('#report-reason-modal.visible', { timeout: 5000 });
await page.click('#report-reason-submit-btn');
await page.waitForFunction(() => /Couldn't submit the report/.test(document.getElementById('dm-status').textContent), null, { timeout: 10000 });
const refusal = await page.evaluate(() => ({
  text: document.getElementById('dm-status').textContent,
  isError: document.getElementById('dm-status').classList.contains('error'),
}));
await page.waitForTimeout(1500);
const stillThere = await page.evaluate(() => /Couldn't submit the report/.test(document.getElementById('dm-status').textContent));
console.log('Refusal says why, in the error style, and stays (should be true, true, true):', /exchanged messages/.test(refusal.text), refusal.isError, stillThere);

// The refusal above is a deliberate 403, which the browser itself logs as one console line; any other error fails.
const unexpectedErrors = errors.filter((message) => !(typeof message === 'string' && /status of 403/.test(message)));

const pass = beside.present && beside.sameRow && beside.aboveList
  && afterCancel === 0
  && sent.reportedBuilderId === FRIEND_BUILDER_ID && sent.reason === 'keeps messaging after I asked them to stop' && !sentStatusIsError
  && /exchanged messages/.test(refusal.text) && refusal.isError && stillThere
  && unexpectedErrors.length === 0 && errors.length <= 1;
await finish(browser, { pass, label: '#4169: Messages header has Report this person beside Block; it asks for an optional reason, posts once, and says the outcome in the thread status', errors: unexpectedErrors });
