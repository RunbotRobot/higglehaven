// #2883: public/admin-control-room.html's own setInterval (polls
// GET /api/control-room/tasks, plus one /replies call per expanded card,
// every POLL_MS) had no Page Visibility handling at all -- a backgrounded
// or simply forgotten-open admin tab kept polling indefinitely, against
// the same Control Room D1 database #2868's own voiceChat.js poll already
// drove to its free-tier daily row-read cap to zero once today (that
// issue's own commit message). Same fix, same narrow coverage shape as
// e2e/voice-chat-background-pause.test.mjs (that file's own header
// comment explains the document.hidden-override technique in full): the
// poll should stop while `document.hidden` is true and resume on the very
// next tick once it's false again -- no separate visibilitychange
// listener to verify, since the fix just re-reads document.hidden fresh
// each tick.
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
// Matches public/admin-control-room.html's own POLL_MS -- waiting a
// couple of these per phase is a couple of real poll ticks, not a coin
// flip, without padding the suite's own runtime more than needed.
const POLL_MS = 15000;

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');
const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([
  { name: 'hh_session', value: token, url: BASE_URL },
]);

// Count hits on /api/control-room/tasks -- loadTasks() is called on every
// tick of the interval under test regardless of which cards (if any) are
// expanded, unlike /replies, so it alone is enough to prove the fix.
let taskHits = 0;
await page.route('**/api/control-room/tasks*', async (route) => {
  taskHits += 1;
  await route.continue();
});

await page.goto(`${BASE_URL}/admin/control-room`, { waitUntil: 'networkidle' });
await page.waitForSelector('#list', { timeout: 10000 });

// Baseline: visible (document.hidden defaults to false), the loop should
// be polling normally. The page's own initial load already fired one
// loadTasks() call before the route was installed on some runs, and
// definitely one more right after -- reset the counter once the page has
// settled so only interval ticks are counted below.
taskHits = 0;
await page.waitForTimeout(POLL_MS * 2 + 2000);
const baselineHits = taskHits;
console.log('Baseline (visible) /tasks poll hits over ~2 intervals (should be > 0):', baselineHits);

// Simulate backgrounding: document.hidden is a getter on Document's own
// prototype, so defining an own property directly on the instance shadows
// it with no need for the prototype's property to be configurable. No
// visibilitychange event needs dispatching -- the fix under test just
// re-reads document.hidden fresh on each setInterval tick.
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
});
taskHits = 0;
await page.waitForTimeout(POLL_MS * 2 + 2000);
const hiddenHits = taskHits;
console.log('While hidden, /tasks poll hits over ~2 intervals (should be 0):', hiddenHits);

// Simulate foregrounding again -- the very next tick should resume
// polling with no separate recovery step needed.
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
});
taskHits = 0;
await page.waitForTimeout(POLL_MS * 2 + 2000);
const resumedHits = taskHits;
console.log('After becoming visible again, /tasks poll hits over ~2 intervals (should be > 0):', resumedHits);

const pass = baselineHits > 0 && hiddenHits === 0 && resumedHits > 0 && errors.length === 0;

await finish(browser, {
  pass,
  label: 'Control Room admin page background-tab poll pause (#2883): /tasks polling stops while document.hidden is true and resumes once visible again',
  errors,
});
