// Shared flows for the e2e suite (see e2e/README.md). Extracted from the
// same handful of steps every test needs — launching a browser page against
// a running `wrangler dev`, picking/creating a builder or seller identity,
// and claiming a landlet — so individual test files read as "what's
// actually being verified" rather than repeating this boilerplate each time.
import { chromium } from 'playwright';

// Only overridden when PLAYWRIGHT_CHROMIUM_PATH is explicitly set — e.g. a
// sandbox with a pre-installed, version-pinned browser at a nonstandard
// path (skipping `playwright install`'s own download). Left unset,
// chromium.launch() finds the browser on its own via Playwright's normal
// resolution (honoring PLAYWRIGHT_BROWSERS_PATH when that's set too),
// which is what makes this portable to a plain `npx playwright install`
// environment like CI, instead of only ever working against one sandbox's
// specific directory layout.
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8787';
// Matches the value this repo's own .dev.vars sets for local `wrangler
// dev` (see worker/index.js's handleAdminBootstrap and migrations/
// 0055_admin_role.sql) — overridable for a CI/CD environment that
// provisions its own secret instead of committing one.
const ADMIN_BOOTSTRAP_SECRET = process.env.E2E_ADMIN_BOOTSTRAP_SECRET || 'local-dev-admin-secret';

// Plain Node-side fetch, deliberately not page.evaluate(fetch(...)) —
// running this inside the browser page would share (and overwrite) the
// cookie jar of whichever real player identity that page is mid-test as,
// clobbering their session. A bare fetch here has its own, entirely
// separate cookie state.
async function adminApi(path, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...options.headers,
    },
  });
  return { response, body: await response.json() };
}

function extractSessionCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  const match = setCookie?.match(/hh_session=([^;]+)/);
  return match ? `hh_session=${match[1]}` : null;
}

// One throwaway admin account, reused for the lifetime of this process
// (each e2e test file runs as its own process — see run-all.mjs — so this
// caches per file, not across the whole suite).
let adminCookiePromise = null;
async function ensureAdminSession() {
  if (adminCookiePromise) return adminCookiePromise;
  adminCookiePromise = (async () => {
    const email = `e2e-admin-${crypto.randomUUID()}@e2e.test`;
    const signedUp = await adminApi('/auth/signup', null, {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-admin-password-123', username: `e2e-admin-${crypto.randomUUID().slice(0, 8)}` }),
    });
    const cookie = extractSessionCookie(signedUp.response);
    const bootstrapped = await adminApi('/auth/admin-bootstrap', cookie, {
      method: 'POST',
      body: JSON.stringify({ secret: ADMIN_BOOTSTRAP_SECRET }),
    });
    if (bootstrapped.response.status !== 200) {
      throw new Error(`ensureAdminSession: admin-bootstrap failed (${bootstrapped.response.status}) — `
        + 'does .dev.vars configure ADMIN_BOOTSTRAP_SECRET for this wrangler dev instance?');
    }
    return cookie;
  })();
  return adminCookiePromise;
}

const GROW_WORLD_MAX_STEPS = 20;

// The real growth mechanism is now automatic (worker/index.js's scheduled()
// export, on a Cron Trigger) — nothing a real player's browser does
// anymore, and Cron Triggers don't fire inside a plain `wrangler dev`
// process the way this suite runs one. This is the e2e suite's own stand-in
// for that: log in as an admin (see ensureAdminSession above) and drive the
// exact same admin-gated endpoints the scheduled job itself calls, so a
// fresh test world always has something claimable. Ported from the removed
// growTheWorld/expandToEncloseGenerating/generateRingAtBoundary in
// src/main.js — same two-phase shape (expand to enclose what's already
// generating, then generate+complete a fresh ring at the boundary if
// nothing's greenbelt yet), just driven from Node instead of a browser.
export async function growWorldAsAdmin() {
  const cookie = await ensureAdminSession();
  const hasGreenbelt = async () => (await adminApi('/landlets?status=greenbelt&limit=1', cookie)).body.landlets.length > 0;
  const hasGenerating = async () => (await adminApi('/landlets?status=generating&limit=1', cookie)).body.landlets.length > 0;

  for (let i = 0; i < GROW_WORLD_MAX_STEPS; i++) {
    if (await hasGreenbelt()) return;
    if (!(await hasGenerating())) break;
    const expanded = await adminApi('/world/expand', cookie, { method: 'POST' });
    if (expanded.response.status !== 200) break; // ratio gate refused — nothing more to enclose this way
  }
  if (await hasGreenbelt()) return;

  let world = (await adminApi('/world', cookie)).body.world;
  let innerRadiusM = world.radiusM;
  let ring = null;
  for (let attempt = 0; attempt < GROW_WORLD_MAX_STEPS && !ring; attempt++) {
    const prefix = `e2e-ring-${Math.round(innerRadiusM)}-${Date.now().toString(36)}`;
    const generated = await adminApi('/land-candidates/generate-ring', cookie, {
      method: 'POST',
      body: JSON.stringify({ prefix, count: 12, innerRadiusM }),
    });
    if (generated.response.status === 201) {
      ring = { ringId: prefix, outerRadiusM: generated.body.outerRadiusM };
    } else if (generated.body.error === 'Generated ring would overlap existing land candidates') {
      innerRadiusM += world.expansionIncrementM;
    } else {
      throw new Error(`growWorldAsAdmin: generate-ring failed — ${generated.body.error}`);
    }
  }
  if (!ring) throw new Error('growWorldAsAdmin: could not find clear room to generate a new ring');

  for (let i = 0; i < GROW_WORLD_MAX_STEPS; i++) {
    world = (await adminApi('/world', cookie)).body.world;
    if (world.radiusM >= ring.outerRadiusM) break;
    await adminApi('/world/expand', cookie, { method: 'POST' });
  }
  const completed = await adminApi(`/land-candidate-rings/${ring.ringId}/generation-complete`, cookie, { method: 'POST' });
  if (completed.response.status !== 200) {
    throw new Error(`growWorldAsAdmin: generation-complete failed — ${completed.body.error}`);
  }
}

// Launches a fresh browser + page against the running dev server, with
// console/page errors collected (callers should assert `errors.length === 0`
// at the end) and window.prompt() dialogs (used throughout for naming a new
// builder/seller identity — there's no real text-input modal for it) always
// answered with `promptAnswer`.
export async function launchPage({ promptAnswer = 'E2E Tester', viewport = { width: 420, height: 860 } } = {}) {
  const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt') await dialog.accept(promptAnswer);
    else await dialog.accept();
  });
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  return { browser, page, errors };
}

// Drives entry into Build or Sell mode, which now requires a real account
// (docs/API.md's "Authentication") rather than the old free-text dev-mode
// identity picker. Clicking the mode-nav tab opens #auth-modal only if
// nobody's logged in yet (see ensureBuilderIdentity/ensureSellerIdentity
// in src/main.js) — already being logged in (e.g. Sell right after Build
// for the same account in one test, since both now share one login; or
// re-entering after a `page.reload()`, since the session cookie persists)
// skips straight past it, matching bootstrap()'s own silent auto-
// provisioning. `isNew`/`label` only matter for that first, actually-
// unauthenticated call: `label` becomes the account's display name (and,
// slugified, its email's local part — real inboxes are never involved,
// see worker/index.js's sendEmail dev-mode fallback), and `isNew: false`
// is for re-entry cases where nothing needs signing up again.
export async function chooseIdentity(page, { mode, label, isNew = true }) {
  await page.click(`.mode-nav-btn[data-mode="${mode}"]`);
  // Switching to Build (unlike Sell, a modal overlay with no reload —
  // see #mode-nav's own click handler in src/main.js) always reloads the
  // page first; bootstrap() only decides whether a login prompt is needed
  // once that reload has actually landed, so checking for the modal
  // before it finishes would race an in-flight navigation.
  if (mode !== 'sell') {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  }
  const authModalShown = await page.waitForSelector('#auth-modal.visible', { timeout: 8000 }).then(() => true).catch(() => false);
  if (!authModalShown) return; // already logged in — entry proceeds on its own

  if (!isNew) {
    throw new Error(`chooseIdentity: isNew:false but no session is active — expected to already be logged in as "${label}"`);
  }
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@e2e.test`;
  await page.click('.auth-tab-btn[data-auth-view="signup"]');
  await page.fill('#auth-signup-username', label);
  await page.fill('#auth-signup-email', email);
  await page.fill('#auth-signup-password', 'e2e-test-password-123');
  await page.click('#auth-signup-form button[type="submit"]');
  // The signup handler only auto-closes the modal once there's no dev-mode
  // verify-link status to show (see its own comment) — the test env never
  // configures RESEND_API_KEY, so that status always appears here. Either
  // way, ensureBuilderIdentity/ensureSellerIdentity's own requireLogin
  // closes the modal itself once login succeeds, so waiting for it to
  // disappear is the reliable signal regardless of which path fired.
  // state: 'attached' (not the default 'visible') — the modal element
  // itself is always attached to the DOM and this selector specifically
  // matches it once it's HIDDEN (no .visible class, so display:none),
  // which Playwright's default "wait for visible" can never satisfy.
  await page.waitForSelector('#auth-modal:not(.visible)', { state: 'attached', timeout: 10000 });
}

// Claims whatever landlet the claim-modal's overhead map offers first —
// grows the world as an admin if nothing's claimable yet (see
// growWorldAsAdmin's own comment on why this can no longer be a player-
// facing button click), tries a handful of candidate points until one
// reads "Available," and confirms. Leaves the page on the claimed
// landlet's own Build view (#account-menu-toggle visible).
export async function claimLandlet(page) {
  await page.waitForSelector('#claim-modal.visible', { timeout: 10000 });
  await page.waitForTimeout(2000);
  const status = await page.textContent('#claim-status');
  if (status?.includes('check back again shortly')) {
    await growWorldAsAdmin();
    await page.click('#claim-refresh-btn');
    await page.waitForTimeout(2000);
  }
  const canvasBox = await page.locator('#claim-map-canvas').boundingBox();
  const candidatePoints = [[0.5, 0.5], [0.4, 0.4], [0.4, 0.3], [0.5, 0.3], [0.2, 0.4], [0.1, 0.4]];
  for (const [fx, fy] of candidatePoints) {
    await page.mouse.click(canvasBox.x + canvasBox.width * fx, canvasBox.y + canvasBox.height * fy);
    await page.waitForTimeout(250);
    const selection = await page.textContent('#claim-selection-name');
    if (selection && selection.includes('Available')) break;
  }
  await page.click('#claim-confirm-btn');
  await page.waitForTimeout(2500);
  await page.waitForSelector('#account-menu-toggle', { timeout: 10000 });
}

// Identity/Notices/Friends/Settings live inside the collapsed account menu
// (#account-menu-toggle/#account-menu-panel in index.html) rather than as
// independent always-visible pills — open it before clicking any of the
// four rows inside. The panel auto-collapses again once a row is clicked
// (see main.js), so callers don't need to close it themselves.
export async function openAccountMenu(page) {
  await page.click('#account-menu-toggle');
  await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
}

// Clicks down a vertical strip of screen points around (x, yStart..yEnd)
// until #product-info's text includes `expectedText`, returning whatever
// text was showing when it stopped (a match, or the last attempt's text if
// none matched). A placed item's own clickable footprint can be
// meaningfully smaller once it's no longer wearing the selection
// gizmo/highlight that made a wider area hit it right after placing it —
// most visibly right after a reload, when nothing starts selected — so
// retrying the exact same point that worked once can miss forever; a small
// scan is more robust than a single fixed pixel.
export async function clickUntilSelected(page, { x, yStart, yEnd, yStep = 10, expectedText, waitAfterClick = 400 }) {
  let info = '';
  for (let y = yStart; y <= yEnd; y += yStep) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(waitAfterClick);
    info = (await page.textContent('#product-info')) || '';
    if (info.includes(expectedText)) return info;
  }
  return info;
}

// Polls `selector`'s textContent until it includes `expectedSubstring` or
// `timeout` elapses, returning whatever text was showing when it stopped —
// same "poll instead of guess a fixed delay" shape as clickUntilSelected
// above. Several UI updates this suite checks (account-button label after
// login/logout, the account panel's pioneer badge) are the client side of
// an async network round trip rather than a synchronous DOM write, so a
// single fixed waitForTimeout before reading them is a real flake source
// under variable load (e.g. several matrix runners hitting one CI host at
// once) even though the underlying app logic is correct — this trades that
// fixed guess for "wait until it's actually true, up to a generous cap."
export async function waitForText(page, selector, expectedSubstring, { timeout = 5000, interval = 100 } = {}) {
  const start = Date.now();
  let text = '';
  while (Date.now() - start < timeout) {
    text = (await page.textContent(selector)) || '';
    if (text.includes(expectedSubstring)) return text;
    await page.waitForTimeout(interval);
  }
  return text;
}

// Standard end-of-test report + exit, matched by run-all.mjs (which reads
// the child process's exit code) and by running a single file directly with
// `node e2e/whatever.test.mjs`.
export async function finish(browser, { pass, label, errors = [] }) {
  console.log('page errors:', errors.length ? errors : 'none');
  console.log(pass ? `PASS: ${label}` : `FAIL: ${label}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
}
