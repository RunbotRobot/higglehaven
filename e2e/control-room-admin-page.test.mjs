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

// Post a new message through the compose form — the same validating API
// worker/control-room.test.js exercises directly, now driven through the
// real page instead of a raw fetch().
const title = `E2E admin-page message ${Date.now()}`;
await page.fill('.compose-row input[name="from"]', 'e2e-owner');
await page.fill('.compose-row input[name="title"]', title);
await page.click('#composeBtn');
const card = page.locator('.card', { has: page.locator('.title', { hasText: title }) });
await card.waitFor({ timeout: 10000 });
console.log('posted message appears in the list: true');

// Expand it, post a reply, and mark it done — the actions a real Control
// Room session exercises most often.
await card.locator('.card-head').click();
await card.locator('textarea[data-reply-text]').fill('A real reply, posted through the page itself.');
await card.locator('button[data-action="reply"]').click();
await card.locator('.msg-text', { hasText: 'A real reply, posted through the page itself.' }).waitFor({ timeout: 10000 });
console.log('reply landed in the thread: true');

await card.locator('button[data-action="status"][data-value="done"]').click();
await card.locator('.pill-done').waitFor({ timeout: 10000 });
console.log('status flipped to done: true');

const pass = anonStatus === 401 && anonSeesSignIn &&
  heading.includes('higglehaven Control Room') &&
  errors.length === 0;
await finish(browser, { pass, label: 'Control Room admin page (#N31 option 3): same-origin board at /admin/control-room', errors });
