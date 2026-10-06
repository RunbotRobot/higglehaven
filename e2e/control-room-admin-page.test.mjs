// N31 option 3 (owner, Control Room, 2026-09-12: "I would like to do
// option 3. Isn't there a way to do it for free?"). The Control Room board
// now lives on this app's own Worker at GET /admin/control-room instead of
// a separate Claude Artifact, so the owner's ordinary admin session cookie
// (the same one logging into higglehaven itself sets) authenticates every
// fetch() the page makes to /api/control-room/* same-origin, with no
// CORS/SameSite fighting and no CONTROL_ROOM_API_KEY ever reaching browser-
// visible JS — see worker/index.js's handleControlRoomAdminPage for the
// full reasoning. worker/control-room.test.js covers the requireAdmin gate
// itself and the underlying API's own validation; this is the one place
// that reasoning is actually exercised end-to-end against a real build —
// a unit test using the workers-pool ASSETS binding can't do this, since
// that pool never runs `vite build` the way this suite's own run-all.mjs
// does (see that file's own comment on why).
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

// --- An anonymous visitor gets the sign-in message, never the real board ---
const anonPage = await browser.newPage();
anonPage.on('pageerror', (err) => errors.push(err.message));
const anonResponse = await anonPage.goto(`${BASE_URL}/admin/control-room`);
const anonStatus = anonResponse.status();
console.log('anonymous visitor status (should be 401):', anonStatus);
const anonBodyText = await anonPage.textContent('body');
const anonSeesSignIn = anonBodyText.includes('Sign in');
console.log('anonymous visitor sees the sign-in message (should be true):', anonSeesSignIn);
await anonPage.close();

// --- The owner's own admin session sees and can use the real board ---
const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');
const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([
  { name: 'hh_session', value: token, url: BASE_URL },
]);

await page.goto(`${BASE_URL}/admin/control-room`, { waitUntil: 'networkidle' });
const heading = await page.textContent('h1');
console.log('admin page heading (should be "higglehaven Control Room"):', heading);

// Control Room feedback: "Please let admins see a list of all admins" —
// the page's own admin session should show up in that list without any
// extra action.
await page.locator('#adminsList').filter({ hasText: '@' }).waitFor({ timeout: 10000 });
const adminsListText = await page.textContent('#adminsList');
console.log('admins list shows at least the current admin session (actual):', adminsListText.trim());

// Owner, Control Room: the header used to read "500 tasks total" forever
// once the board passed 500 rows, since it displayed tasks.length off the
// same LIMIT-500 result set the page renders from rather than a real,
// uncapped count from the API. Capture the count before posting and
// confirm it actually moves by exactly one afterward.
const totalBefore = Number((await page.textContent('#statusLine')).match(/^(\d+) tasks total/)[1]);

// Post a new message through the compose form — the same validating API
// worker/control-room.test.js exercises directly, now driven through the
// real page instead of a raw fetch().
const title = `E2E admin-page message ${Date.now()}`;
await page.fill('.compose-row input[name="from"]', 'e2e-owner');
await page.fill('.compose-row textarea[name="title"]', title);
await page.click('#composeBtn');
const card = page.locator('.card', { has: page.locator('.title', { hasText: title }) });
await card.waitFor({ timeout: 10000 });
console.log('posted message appears in the list: true');

const totalAfter = Number((await page.textContent('#statusLine')).match(/^(\d+) tasks total/)[1]);
console.log('tasks-total count moved by exactly 1 after posting (actual delta):', totalAfter - totalBefore);

// A freshly-posted task starts unviewed (control_room_tasks.viewed
// defaults to 0) — its collapsed card-head should show the "New" badge
// right away, no need to expand first.
const newlyPostedIsUnviewed = await card.locator('.card-head .pill-unviewed').isVisible();
console.log('freshly-posted task shows the "New" badge (should be true):', newlyPostedIsUnviewed);

// Expand it, post a reply, and mark it done — the actions a real Control
// Room session exercises most often.
await card.locator('.card-head').click();
await card.locator('textarea[data-reply-text]').fill('A real reply, posted through the page itself.');
await card.locator('button[data-action="reply"]').click();
// A real POST + the reply handler's own loadReplies() + loadTasks() round
// trips, not just a render off already-fetched data — this file's own
// most consistently flaky wait under load, so a longer timeout than the
// simpler DOM-only waits elsewhere in this file.
await card.locator('.msg-text', { hasText: 'A real reply, posted through the page itself.' }).waitFor({ timeout: 20000 });
console.log('reply landed in the thread: true');

// Mark viewed (Control Room feedback: "we've lost the ability to mark a
// task as Viewed after migrating from the artifact to the website") — the
// New badge should disappear and the button should flip to offer the
// reverse action, then flip back on a second click.
await card.locator('button[data-action="toggleViewed"]').click();
await card.locator('.card-head .pill-unviewed').waitFor({ state: 'detached', timeout: 10000 });
const markedViewedButtonText = await card.locator('button[data-action="toggleViewed"]').textContent();
console.log('button reads "Mark unviewed" once viewed (actual):', markedViewedButtonText.trim());

await card.locator('button[data-action="toggleViewed"]').click();
await card.locator('.card-head .pill-unviewed').waitFor({ timeout: 10000 });
const markedUnviewedButtonText = await card.locator('button[data-action="toggleViewed"]').textContent();
console.log('button reads "Mark viewed" once unviewed again (actual):', markedUnviewedButtonText.trim());

// #913: an in-progress task with no explicit waitingOn used to still fall
// through waitingBadge()'s default and show a "Ready for Claude" pill --
// a false green light contradicting AGENTS.md's own documented "an
// ordinary in-progress card stays quiet" design.
await card.locator('button[data-action="status"][data-value="in_progress"]').click();
await card.locator('.pill-in_progress').waitFor({ timeout: 10000 });
const readyForClaudePillShowsOnInProgress = await card.locator('.card-head .pill-waiting-claude').isVisible();
console.log('in-progress task with no explicit waitingOn shows no "Ready for Claude" pill (should be false):', readyForClaudePillShowsOnInProgress);

await card.locator('button[data-action="status"][data-value="done"]').click();
await card.locator('.pill-done').waitFor({ timeout: 10000 });
console.log('status flipped to done: true');

// Keyboard-disappears bug (owner feedback: "the keyboard occasionally
// disappears" while typing in the feedback input, "presumably because it's
// happening when the Control Room is updated by a session"). Every render()
// rebuild -- including the periodic poll -- used to recreate the reply
// <textarea> from scratch, dropping whatever had focus; on a real device
// losing focus on a textarea is exactly what makes the on-screen keyboard
// vanish mid-typing, even though the typed text itself already survived via
// the `drafts` cache. Type into this still-open card's reply box without
// sending, wait past one full poll interval (15s), and confirm the same
// textarea is still focused with its cursor position intact.
const replyBox = card.locator('textarea[data-reply-text]');
await replyBox.click();
await replyBox.fill('Typing without sending, to catch focus loss on the next poll tick.');
await replyBox.evaluate((el) => el.setSelectionRange(5, 5));
// #1398: the adjacent reply "From" input sits in the same reply-row but
// never got the same draft-preservation treatment as the textarea above —
// set its value here to prove it survives the same rebuild regardless of
// which field actually has focus. Deliberately not using Playwright's own
// .fill() (which always focuses its target first) — that would steal focus
// away from replyBox above and break this block's own focus/cursor checks
// on the textarea; dispatching a real 'input' event after setting .value
// directly exercises the same listener (see listEl's 'input' handler) that
// a real keystroke would, without moving focus.
const fromBox = card.locator('input[data-reply-from]');
await fromBox.evaluate((el) => {
  el.value = 'alice';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(16000);
const stillFocusedAfterPoll = await replyBox.evaluate((el) => document.activeElement === el);
const cursorPreservedAfterPoll = await replyBox.evaluate((el) => el.selectionStart === 5 && el.selectionEnd === 5);
const fromValuePreservedAfterPoll = await fromBox.inputValue();
console.log('reply textarea keeps focus across a poll tick (should be true):', stillFocusedAfterPoll);
console.log('cursor position preserved across a poll tick (should be true):', cursorPreservedAfterPoll);
console.log('reply "From" input keeps its typed value across a poll tick, not reverted to "owner" (should be "alice"):', fromValuePreservedAfterPoll);

// #988: clicking a status tab used to only filter the already-fetched,
// status-less 500-row page client-side, so "N tasks total" kept showing
// the grand total across every status instead of one scoped to the tab's
// own status (the API itself already scopes `total` to `?status=`, per
// worker/control-room.test.js's own "scopes total to the same status
// filter as the list itself" test) -- this exercises the frontend
// actually calling it, not just the endpoint. A second, still-queued task
// makes the grand total (2) diverge from the done-scoped total (1) --
// with only the one done task from the compose-form flow above, the two
// totals would coincidentally match and this check would pass either way.
await page.evaluate(async () => {
  await fetch('/api/control-room/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'e2e-owner', kind: 'feedback', title: 'E2E still-queued task' }),
  });
});
// Reload so the page's own (unfiltered) loadTasks() picks up both tasks
// into its cache before the tab click below -- without this, the
// pre-fix bug (tab click never re-fetches, just re-filters the same
// cache) would go unnoticed, since the cache wouldn't yet contain the
// second task either way.
await page.reload({ waitUntil: 'networkidle' });
const doneTotalFromApi = await page.evaluate(async () => {
  const res = await fetch('/api/control-room/tasks?status=done');
  const body = await res.json();
  return body.total;
});
await page.click('.tabs button[data-status="done"]');
await page.waitForFunction(
  (expected) => document.querySelector('#statusLine')?.textContent.startsWith(expected + ' tasks total'),
  doneTotalFromApi,
  { timeout: 10000 },
);
const doneTabStatusLine = (await page.textContent('#statusLine')).trim();
console.log('Done tab scopes "tasks total" to the status filter itself (actual):', doneTabStatusLine);
const doneTabTotalMatchesApi = doneTabStatusLine.startsWith(doneTotalFromApi + ' tasks total');

// Blocked-on jump (Control Room feedback: "When I tap 'blocked on #n', it
// should jump to that task in the Control Room.") — a task's own waitingOn
// can hold another task's `number` (a tracking task blocked on a real
// GitHub-issue-backed sub-task, e.g. #326 waiting on #583), not just
// 'owner'/'claude'. Seeded directly through the same validating API the
// compose form itself calls, since the compose form has no field for
// `number`/`waitingOn` on creation.
const blockingNumber = Math.floor(Date.now() / 1000) % 100000;
const blockingTitle = `E2E blocking task ${blockingNumber}`;
const blockedTitle = `E2E blocked task ${blockingNumber}`;
await page.evaluate(async ({ number, blockingTitle: bTitle, blockedTitle: kTitle }) => {
  const post = (body) => fetch('/api/control-room/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await post({ from: 'e2e-owner', kind: 'feedback', number, title: bTitle });
  await post({ from: 'e2e-owner', kind: 'feedback', title: kTitle, waitingOn: String(number) });
}, { number: blockingNumber, blockingTitle, blockedTitle });

await page.reload({ waitUntil: 'networkidle' });
const blockedCard = page.locator('.card', { has: page.locator('.title', { hasText: blockedTitle }) });
await blockedCard.waitFor({ timeout: 10000 });
const blockedPill = blockedCard.locator('.pill-blocked-on');
const blockedPillText = (await blockedPill.textContent()).trim();
console.log('blocked task shows a "Blocked on #n" pill (actual):', blockedPillText);

await blockedPill.click();
const blockingCard = page.locator('.card', { has: page.locator('.title', { hasText: blockingTitle }) });
await blockingCard.waitFor({ timeout: 10000 });
const blockingCardIsOpen = await blockingCard.evaluate((el) => el.classList.contains('open'));
console.log('tapping the pill expanded the blocking task\'s own card (actual):', blockingCardIsOpen);

// Quick Look (Control Room feedback: "Let's make a quick-look tab ... that
// shows the single most important thing needed from me with a textarea
// for me to respond.") — nothing is waiting on the owner yet in this
// fresh-per-file D1, so the tab should say so before any exists.
await page.click('.tabs button[data-status="__quicklook__"]');
await page.locator('.empty', { hasText: 'Nothing is waiting on you right now.' }).waitFor({ timeout: 10000 });
console.log('Quick Look says nothing is waiting before any owner-blocked task exists: true');

// Two owner-blocked tasks, posted a beat apart — Quick Look should pick
// the older (longer-waiting) one first, not whichever was posted last.
// #909: creating a task already waitingOn:'owner' now requires a `reason`,
// same as the update endpoint already did — these two seeds predate that
// fix and need one added to keep getting past creation at all.
const quickLookOlderTitle = `E2E quick-look older ${Date.now()}`;
await page.evaluate(async (title) => {
  await fetch('/api/control-room/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'higglehaven-e2e', kind: 'feedback', title, waitingOn: 'owner', reason: 'E2E seed.' }),
  });
}, quickLookOlderTitle);
await page.waitForTimeout(200); // comfortably past this board's own millisecond-precision updatedAt
const quickLookNewerTitle = `E2E quick-look newer ${Date.now()}`;
await page.evaluate(async (title) => {
  await fetch('/api/control-room/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'higglehaven-e2e', kind: 'feedback', title, waitingOn: 'owner', reason: 'E2E seed.' }),
  });
}, quickLookNewerTitle);

await page.reload({ waitUntil: 'networkidle' });
await page.click('.tabs button[data-status="__quicklook__"]');
const quickLookCard = page.locator('.card', { has: page.locator('.title', { hasText: quickLookOlderTitle }) });
// #1355: Quick Look's own tab click now re-fetches via loadTasks() (async)
// rather than the old synchronous render(), so the card can be visible
// (already rendered by the page's pre-click, unfiltered initial load)
// before the click's own re-render has applied the "open" class -- wait for
// that class specifically rather than just visibility, which would resolve
// against the stale pre-click render instead.
await page.waitForFunction(
  (title) => [...document.querySelectorAll('.card.open')].some((c) => c.querySelector('.title')?.textContent.includes(title)),
  quickLookOlderTitle,
  { timeout: 10000 },
);
const quickLookIsOpen = await quickLookCard.evaluate((el) => el.classList.contains('open'));
console.log('Quick Look picks the older of two owner-blocked tasks, already expanded (actual):', quickLookIsOpen);

// #1355 regression: switching to Quick Look used to only call render(),
// reusing whatever `tasks` array was already cached by the previously
// active tab's own status-scoped loadTasks() call -- so coming from the
// "Done" tab (cache scoped to status==='done'), pickQuickLookTask()'s own
// `status !== 'done'` filter always came up empty, falsely showing
// "Nothing is waiting on you right now" even though quickLookOlderTitle
// (seeded above, still waitingOn: 'owner') genuinely is. Checked with a
// short timeout -- well under this page's own 15s poll interval -- so a
// regression can't be masked by the next poll tick quietly self-healing it.
await page.click('.tabs button[data-status="done"]');
await page.waitForTimeout(100);
await page.click('.tabs button[data-status="__quicklook__"]');
const quickLookCardAfterDoneTab = page.locator('.card', { has: page.locator('.title', { hasText: quickLookOlderTitle }) });
await quickLookCardAfterDoneTab.waitFor({ timeout: 3000 });
const quickLookSurvivesDoneTabSwitch = await quickLookCardAfterDoneTab.count();
console.log('Quick Look still finds the owner-blocked task right after switching from the Done tab (should be 1):', quickLookSurvivesDoneTabSwitch);

// Replying doesn't clear waitingOn, but it does bump updatedAt — so the
// just-answered (older) task should lose its "longest waiting" spot to
// the other one, without Quick Look needing any "already handled"
// tracking of its own. Deliberately not waiting for the reply to show up
// inside quickLookCard's own thread first: the reply handler's own
// trailing loadTasks() naturally re-picks and re-renders Quick Look onto
// the *other* task once this one's updatedAt bumps past it, which can
// (correctly) remove this exact card from the DOM before any such wait
// resolves — racing against this feature's own intended behavior, not a
// real flake. Waiting directly for the actual next pick sidesteps that.
const replyText = 'Answered — the other one should be next.';
await quickLookCard.locator('textarea[data-reply-text]').fill(replyText);
await quickLookCard.locator('button[data-action="reply"]').click();
const quickLookAfterReply = page.locator('.card', { has: page.locator('.title', { hasText: quickLookNewerTitle }) });
await quickLookAfterReply.waitFor({ timeout: 20000 });
const advancedToOther = await quickLookAfterReply.count();
console.log('Quick Look advanced to the other owner-blocked task after the first was answered (should be 1):', advancedToOther);

// Confirm the reply actually landed server-side, independent of whatever
// the UI happened to be showing when it did.
const quickLookOlderId = await page.evaluate(async (title) => {
  const res = await fetch('/api/control-room/tasks');
  const body = await res.json();
  return body.tasks.find((t) => t.title === title)?.id;
}, quickLookOlderTitle);
const quickLookOlderReplies = await page.evaluate(async (id) => {
  const res = await fetch('/api/control-room/tasks/' + encodeURIComponent(id) + '/replies');
  const body = await res.json();
  return body.replies.map((r) => r.text);
}, quickLookOlderId);
console.log('reply actually recorded server-side on the older task (actual):', quickLookOlderReplies);
const replyRecorded = quickLookOlderReplies.includes(replyText);

// Clickable sub-issue chips (owner, Control Room: "make the subtasks listed
// below a tracking task header clickable, linking to that task"). Reuses
// the same data-jump-to click handling above -- a tracking task's
// subIssues chip is only clickable when the sub-issue's own task is
// actually loaded. Seeded through the same validating API, now that it
// accepts subIssues/subIssueSummaries on create.
const subNumber = Math.floor(Date.now() / 1000) % 100000 + 1;
const trackingTitle = `E2E tracking task ${subNumber}`;
const subTaskTitle = `E2E sub-task ${subNumber}`;
await page.evaluate(async ({ number, trackingTitle: tTitle, subTaskTitle: sTitle }) => {
  const post = (body) => fetch('/api/control-room/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await post({ from: 'e2e-owner', kind: 'feedback', number, title: sTitle });
  await post({
    from: 'e2e-owner', kind: 'feedback', title: tTitle,
    subIssues: [number], subIssueSummaries: { [number]: 'A sub-task summary' },
  });
}, { number: subNumber, trackingTitle, subTaskTitle });

await page.reload({ waitUntil: 'networkidle' });
const trackingCard = page.locator('.card', { has: page.locator('.title', { hasText: trackingTitle }) });
await trackingCard.waitFor({ timeout: 10000 });
const subChip = trackingCard.locator('.chip-jump', { hasText: '#' + subNumber });
const subChipVisible = await subChip.isVisible();
console.log('tracking task shows a clickable sub-issue chip (should be true):', subChipVisible);

await subChip.click();
const subTaskCard = page.locator('.card', { has: page.locator('.title', { hasText: subTaskTitle }) });
await subTaskCard.waitFor({ timeout: 10000 });
const subTaskCardIsOpen = await subTaskCard.evaluate((el) => el.classList.contains('open'));
console.log('tapping the sub-issue chip expanded the sub-task\'s own card (actual):', subTaskCardIsOpen);

// "Waiting on: Subtasks" (owner, Control Room: "make it possible for
// 'tracking' tasks to be able to change to status 'WAITING ON: SUBTASKS'
// instead of just 'WAITING ON: OWNER' or 'READY FOR CLAUDE'") — a third
// waitingOn value, only offered as a button on a task that actually has
// subIssues of its own.
await trackingCard.locator('.card-head').click();
const waitingSubtasksBtn = trackingCard.locator('button[data-action="waitingSubtasks"]');
await waitingSubtasksBtn.waitFor({ timeout: 10000 });
await waitingSubtasksBtn.click();
await trackingCard.locator('.pill-waiting-subtasks').waitFor({ timeout: 10000 });
const waitingSubtasksPillText = (await trackingCard.locator('.pill-waiting-subtasks').textContent()).trim();
console.log('tracking task shows the "Waiting on: Subtasks" pill after clicking its button (actual):', waitingSubtasksPillText);

// #1269: AGENTS.md documents an unanswered question (kind: 'question',
// status still 'queued') rendering an inline "Needs your answer" badge,
// but that behavior only ever existed on the old, decommissioned
// Claude-Artifact board -- it was never ported to this real page.
// Seeded through the same validating API as everything else above.
const questionTitle = `E2E unanswered question ${Date.now()}`;
await page.evaluate(async (title) => {
  await fetch('/api/control-room/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'e2e-owner', kind: 'question', title }),
  });
}, questionTitle);

await page.reload({ waitUntil: 'networkidle' });
const questionCard = page.locator('.card', { has: page.locator('.title', { hasText: questionTitle }) });
await questionCard.waitFor({ timeout: 10000 });
const needsAnswerPillVisible = await questionCard.locator('.card-head .pill-needs-answer').isVisible();
console.log('unanswered question task shows a "Needs your answer" badge (should be true):', needsAnswerPillVisible);

await questionCard.locator('.card-head').click();
await questionCard.locator('button[data-action="status"][data-value="done"]').click();
await questionCard.locator('.pill-done').waitFor({ timeout: 10000 });
const needsAnswerPillGoneOnceDone = await questionCard.locator('.card-head .pill-needs-answer').isVisible();
console.log('badge disappears once the question is marked done (should be false):', needsAnswerPillGoneOnceDone);

// #916: imageUrl round-trips fully through the API (task create, reply
// create) but the admin page never rendered it anywhere — a screenshot
// attached via imageUrl was silently invisible on the board. Seeded
// through the same validating API as everything else above: one task
// created with its own imageUrl (rendered as a small thumbnail in the
// collapsed card-head), then one reply posted with its own separate
// imageUrl (rendered inline in the thread entry).
const imageTaskTitle = `E2E image task ${Date.now()}`;
const taskImageUrl = '/uploads/e2e-task-thumb.png';
const replyImageUrl = '/uploads/e2e-reply-attachment.png';
await page.evaluate(async ({ title, imageUrl }) => {
  await fetch('/api/control-room/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'e2e-owner', kind: 'feedback', title, imageUrl }),
  });
}, { title: imageTaskTitle, imageUrl: taskImageUrl });

await page.reload({ waitUntil: 'networkidle' });
const imageTaskCard = page.locator('.card', { has: page.locator('.title', { hasText: imageTaskTitle }) });
await imageTaskCard.waitFor({ timeout: 10000 });
const cardThumbSrc = await imageTaskCard.locator('.card-head .card-thumb').getAttribute('src');
console.log('task card-head shows a thumbnail for its own imageUrl (actual):', cardThumbSrc);

await imageTaskCard.locator('.card-head').click();
const imageTaskId = await page.evaluate(async (title) => {
  const res = await fetch('/api/control-room/tasks');
  const body = await res.json();
  return body.tasks.find((t) => t.title === title)?.id;
}, imageTaskTitle);
await page.evaluate(async ({ id, imageUrl }) => {
  await fetch('/api/control-room/tasks/' + encodeURIComponent(id) + '/replies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'e2e-owner', text: 'A reply with its own attachment.', imageUrl }),
  });
}, { id: imageTaskId, imageUrl: replyImageUrl });

await imageTaskCard.locator('.msg-text', { hasText: 'A reply with its own attachment.' }).waitFor({ timeout: 20000 });
const replyImgSrc = await imageTaskCard.locator('.msg .msg-img').getAttribute('src');
console.log('reply thread entry shows an image for its own imageUrl (actual):', replyImgSrc);

// Neither imageUrl above points at a real R2 object (no upload flow was run
// to create one) -- rendering a real <img src> for it is exactly the thing
// under test, and Chromium logs a "Failed to load resource: 404" console
// error for that fetch as a result. That's an expected side effect of this
// fixture, not a product bug, so it's dropped here rather than tripping
// this suite's catch-all zero-console-errors bar below.
errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('Failed to load resource')));

const pass = anonStatus === 401 && anonSeesSignIn &&
  heading.includes('higglehaven Control Room') &&
  adminsListText.includes('@') &&
  totalAfter === totalBefore + 1 &&
  newlyPostedIsUnviewed &&
  markedViewedButtonText.trim() === 'Mark unviewed' &&
  markedUnviewedButtonText.trim() === 'Mark viewed' &&
  !readyForClaudePillShowsOnInProgress &&
  blockedPillText === ('Blocked on #' + blockingNumber) &&
  blockingCardIsOpen &&
  stillFocusedAfterPoll &&
  cursorPreservedAfterPoll &&
  fromValuePreservedAfterPoll === 'alice' &&
  doneTabTotalMatchesApi &&
  quickLookIsOpen &&
  quickLookSurvivesDoneTabSwitch === 1 &&
  advancedToOther === 1 &&
  replyRecorded &&
  subChipVisible &&
  subTaskCardIsOpen &&
  waitingSubtasksPillText === 'Waiting on: Subtasks' &&
  needsAnswerPillVisible &&
  !needsAnswerPillGoneOnceDone &&
  cardThumbSrc === taskImageUrl &&
  replyImgSrc === replyImageUrl &&
  errors.length === 0;
await finish(browser, { pass, label: 'Control Room admin page (#N31 option 3): same-origin board at /admin/control-room', errors });
