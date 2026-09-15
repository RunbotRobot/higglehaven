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
await card.locator('.msg-text', { hasText: 'A real reply, posted through the page itself.' }).waitFor({ timeout: 10000 });
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

await card.locator('button[data-action="status"][data-value="done"]').click();
await card.locator('.pill-done').waitFor({ timeout: 10000 });
console.log('status flipped to done: true');

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

const pass = anonStatus === 401 && anonSeesSignIn &&
  heading.includes('higglehaven Control Room') &&
  adminsListText.includes('@') &&
  totalAfter === totalBefore + 1 &&
  newlyPostedIsUnviewed &&
  markedViewedButtonText.trim() === 'Mark unviewed' &&
  markedUnviewedButtonText.trim() === 'Mark viewed' &&
  blockedPillText === ('Blocked on #' + blockingNumber) &&
  blockingCardIsOpen &&
  subChipVisible &&
  subTaskCardIsOpen &&
  waitingSubtasksPillText === 'Waiting on: Subtasks' &&
  errors.length === 0;
await finish(browser, { pass, label: 'Control Room admin page (#N31 option 3): same-origin board at /admin/control-room', errors });
