// #634/#635 (sub-issues of #631): the Saved Layouts settings panel (list +
// Preview + Delete) and the faux-layout preview it opens into — a
// dedicated read-only 3D view rendering a removed level's swept-out
// instances (#633) at their true original positions, with drag-rectangle
// marquee selection over them. Setup goes through the real level-add/
// place/level-remove HTTP flow (the same one #522/#632/#633's own unit
// tests already cover in isolation) purely to get a real saved-layout row
// to exercise the NEW UI against — this test's own point is everything
// downstream of that: the Settings panel, Preview, marquee select, and
// Back/Delete.
import {
  launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, grantLandCapHeadroomAsAdmin,
} from './helpers.mjs';

const LABEL = 'Saved Layout Preview Suite Tester';
const LEVEL_HEIGHT_M = 10;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

// #1958: plain Node-side fetch, not page.evaluate(fetch(...)) -- same
// "don't clobber the real player identity's own cookie jar" reasoning
// e2e/helpers.mjs's own adminApi uses. Needs a second, genuinely separate
// builder identity (not the page's own LABEL one) to send a real friend
// request, which is the simplest existing action that fires a
// fireNotification() at a specific recipientBuilderId.
function extractSessionCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  const match = setCookie?.match(/hh_session=([^;]+)/);
  return match ? `hh_session=${match[1]}` : null;
}

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { builders } = (await fetchJson('/api/builders')).body;
const me = builders.find((b) => b.label === LABEL);
await grantLandCapHeadroomAsAdmin(me.builderId);

// #1958: a real unread notification for `me`, created before ever
// entering layout-preview mode below, so the badge-refresh assertion
// there has a real nonzero count to check against.
const friendSenderEmail = `e2e-layout-preview-friend-${crypto.randomUUID()}@e2e.test`;
const friendSenderSignup = await fetch(`${BASE_URL}/api/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: friendSenderEmail, password: 'e2e-layout-preview-friend-password-123',
    username: `e2e-layout-preview-friend-${crypto.randomUUID().slice(0, 8)}`, ageAttested: true,
  }),
});
const friendSenderCookie = extractSessionCookie(friendSenderSignup);
// Sending a friend request needs a verified session (requireSessionBuilder
// -> assertVerified) -- signup already age-attests, so only the credit-
// card/ID tier is missing. No Stripe secret is configured for this suite,
// so confirm-card's own simulated fallback grants it directly, no real
// card/SetupIntent needed.
await fetch(`${BASE_URL}/api/auth/confirm-card`, { method: 'POST', headers: { cookie: friendSenderCookie } });
const friendRequestSent = await fetch(`${BASE_URL}/api/friendships`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: friendSenderCookie },
  body: JSON.stringify({ recipientBuilderId: me.builderId }),
});
console.log('friend request sent to the preview-mode builder (status should be 201):', friendRequestSent.status);

const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`)).body;
const landletId = landlets[0].landletId;

const levelAdded = await fetchJson(`/api/landlets/${landletId}/levels`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'up' }),
});
console.log('level add status (should be 201):', levelAdded.status);

const instanceId = 'saved-layout-preview-suite-instance';
const placed = await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId, templateId: 'placeholder-tree', x: 1, y: 1, z: LEVEL_HEIGHT_M * 1.5 }),
});
console.log('instance place status (should be 201):', placed.status);

const levelRemoved = await fetchJson(`/api/landlets/${landletId}/levels/1`, { method: 'DELETE' });
console.log('level remove status (should be 200):', levelRemoved.status);

// Settings > Build > Saved Layouts should now show exactly one row.
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
// #2146 (sub-issue of #2138): waitForFunction's signature is (pageFunction,
// arg, options) -- a bare (fn, { timeout }) call puts the options object in
// the `arg` slot instead, so `options` stayed undefined and the real
// applied timeout was always Playwright's actual default (30000ms), never
// the smaller number written here. The explicit `null` arg reaches the
// options slot, and the timeout itself is widened to 60000ms for real
// headroom under CI load, same as e2e/helpers.mjs's own account-menu-modal
// wait.
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.settings-field span')).some((el) => el.textContent === 'Saved Layouts'),
  null,
  { timeout: 60000 },
);
await page.waitForFunction(() => document.querySelectorAll('.version-row').length >= 1, null, { timeout: 60000 });

const savedLayoutRow = page.locator('.settings-field', { hasText: 'Saved Layouts' }).locator('.version-row');
const rowText = await savedLayoutRow.locator('.version-row-info').textContent();
console.log('saved layout row text (should mention Level 1 and 1 item):', rowText);
const rowTextCorrect = /Level 1/.test(rowText) && /1 item/.test(rowText);

// Preview: reloads into the dedicated faux-layout view.
await savedLayoutRow.locator('button', { hasText: 'Preview' }).click();
// #2146 (sub-issue of #2138): same waitForFunction arg/options bug as above
// -- null arg, 60000ms real timeout.
await page.waitForFunction(() => document.getElementById('layout-preview-toolbar')?.classList.contains('visible'), null, { timeout: 60000 });
await page.waitForTimeout(1000); // let the model actually load/render before interacting with it
const previewNameShown = await page.locator('#layout-preview-name').textContent();
console.log('preview toolbar name (should mention Level 1):', previewNameShown);

// #1958: the notifications bell stays visible/clickable in this mode
// (SELL_HIDDEN_BUILDER_UI_IDS doesn't hide it), so its badge should
// reflect the real unread friend-request notification sent above, not
// the stale/default hidden state. Same "open the account menu first" step
// e2e/seller-upload-and-resize.test.mjs's own badge check uses -- the
// badge span itself only renders inside the expanded account-menu panel.
await openAccountMenu(page);
const previewBadgeVisible = await page.locator('#notifications-badge').isVisible();
const previewBadgeText = await page.locator('#notifications-badge').textContent();
console.log('notifications badge in layout-preview mode (should be visible, count 1):', previewBadgeVisible, previewBadgeText);
await page.click('#account-menu-toggle'); // collapse the panel back out before the marquee-drag step below needs the canvas clear
// state: 'attached', not the default 'visible' -- same reasoning
// chooseIdentity's own auth-modal wait documents: the collapsed panel is
// still attached to the DOM, just hidden, which Playwright's default
// "wait for visible" can never satisfy.
await page.waitForSelector('#account-menu-panel:not(.expanded)', { state: 'attached', timeout: 5000 });

// Marquee-select the whole visible canvas — coordinate-agnostic way to
// catch whatever's on screen without needing to know the exact projected
// pixel position of the one placed instance.
await page.mouse.move(10, 10);
await page.mouse.down();
await page.mouse.move(410, 850, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
const selectionAfterDrag = await page.locator('#layout-preview-selection-count').textContent();
console.log('selection count after marquee-drag over the whole canvas (should be "1 selected"):', selectionAfterDrag);

// A plain click (no real drag) clears the selection back out.
await page.mouse.click(200, 400);
await page.waitForTimeout(300);
const selectionAfterClick = await page.locator('#layout-preview-selection-count').textContent();
console.log('selection count after a plain click (should be empty):', JSON.stringify(selectionAfterClick));

// Back to Build.
await page.click('#layout-preview-back-btn');
// #2146 (sub-issue of #2138): same waitForFunction arg/options bug as above
// -- null arg, 60000ms real timeout.
await page.waitForFunction(() => !document.getElementById('layout-preview-toolbar')?.classList.contains('visible'), null, { timeout: 60000 });
await page.waitForSelector('#add-item-btn', { timeout: 10000 });
console.log('back in Build mode after Back to Build (add-item-btn visible): ok');

// Delete the saved layout from the settings panel.
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
// #2146 (sub-issue of #2138): same waitForFunction arg/options bug as above
// -- null arg, 60000ms real timeout.
await page.waitForFunction(() => document.querySelectorAll('.version-row').length >= 1, null, { timeout: 60000 });
await page.locator('.settings-field', { hasText: 'Saved Layouts' }).locator('.version-row')
  .locator('button', { hasText: 'Delete' }).click();
await page.waitForFunction(
  () => document.querySelector('.settings-field')?.textContent.includes('Nothing saved yet') ||
    !Array.from(document.querySelectorAll('.settings-field')).some((f) => f.textContent.includes('Saved Layouts') && f.querySelector('.version-row')),
  null,
  { timeout: 60000 },
);
const savedLayoutsAfterDelete = (await fetchJson('/api/builders/me/saved-layouts')).body.savedLayouts;
console.log('saved layouts after delete (should be 0):', savedLayoutsAfterDelete.length);

const pass = levelAdded.status === 201 &&
  placed.status === 201 &&
  friendRequestSent.status === 201 &&
  levelRemoved.status === 200 &&
  rowTextCorrect &&
  /Level 1/.test(previewNameShown) &&
  previewBadgeVisible && previewBadgeText.trim() === '1' &&
  selectionAfterDrag.includes('1 selected') &&
  selectionAfterClick.trim() === '' &&
  savedLayoutsAfterDelete.length === 0 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Saved Layouts panel + faux-layout preview + marquee select (#634/#635), notifications badge refreshes in layout-preview mode (#1958)',
  errors,
});
