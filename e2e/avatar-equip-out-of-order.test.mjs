// #982: refreshEquippedShopAvatar (src/main.js) had no supersede guard — an
// in-flight custom-avatar equip (a real network fetch + GLTF parse that can
// take a while) could still resolve and overwrite the live scene AFTER a
// later, faster equip (e.g. reverting to the default avatar) had already
// taken effect. Same out-of-order-resolution hazard as the connectivity-
// indicator race (#545/#980), just on a different function that never got
// the same fix. This exercises the live "My Avatars" picker equip path
// (refreshEquippedShopAvatar) while already in Shop mode, not a fresh
// Shop-mode entry (enterShopMode) — that's the function this bug lived in.
//
// The slow side of the race is simulated via window.__testAvatarLoadDelayMs
// (createCustomShopAvatar's own test-only hook), not a network-level delay
// (e.g. page.route()) — found the hard way that holding a response open via
// route interception measurably delays *other*, unrelated same-origin
// requests too (the "Default avatar" equip's own PUT wasn't even dispatched
// until the intercepted request was released, regardless of delay length),
// constructing the wrong race entirely rather than a flaky one. A plain
// in-page setTimeout has no such side effect on other requests.
//
// Racing against "Default avatar" specifically (rather than some other
// owned avatar) needs a third, already-equipped placeholder avatar set up
// first: renderMyAvatarsList() only runs once a click's whole equip chain
// resolves, so mid-race the picker's own DOM (each row's disabled state)
// stays stale, showing whatever was equipped *before* this race started —
// if that were "Default avatar" itself (a fresh account's actual starting
// state), its own Equip button would still read disabled the entire time,
// making it unclickable until the slow equip already finished, which would
// never actually exercise the race this test is for.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Avatar Race Suite Tester';
const PRODUCT_NAME = 'Suite Race Avatar';
const PLACEHOLDER_PRODUCT_NAME = 'Suite Race Placeholder Avatar';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });

async function uploadAvatarProduct(name) {
  await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
  await page.waitForTimeout(300);
  await page.click('#upload-model-btn');
  await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
  await page.fill('#upload-name', name);
  await page.fill('#upload-price', '5');
  await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
  await page.waitForTimeout(300);
  await page.check('#upload-avatar-category-checkbox');
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
  await page.waitForTimeout(500);
}

await uploadAvatarProduct(PLACEHOLDER_PRODUCT_NAME);
await uploadAvatarProduct(PRODUCT_NAME);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const template = templates.find((t) => t.name === PRODUCT_NAME);
const placeholderTemplate = templates.find((t) => t.name === PLACEHOLDER_PRODUCT_NAME);

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];

async function placeAndPurchase(tpl, instanceId) {
  await fetchJson('/api/instances', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: tpl.templateId, x: 0, y: 0 }),
  });
  return fetchJson(`/api/instances/${instanceId}/purchase`, { method: 'POST' });
}

const placeholderPurchased = await placeAndPurchase(placeholderTemplate, 'suite-race-placeholder-instance');
const purchased = await placeAndPurchase(template, 'suite-race-avatar-instance');
console.log('purchase responses (status should both be 201):', placeholderPurchased.status, purchased.status);

// Equip the placeholder directly via the API (not the picker) so it's
// already the account's equipped avatar — and therefore the only row
// showing "disabled" — before the race below ever starts, per this file's
// own top comment.
const placeholderEquipped = await fetchJson('/api/builders/me/avatar', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ templateId: placeholderTemplate.templateId }),
});
console.log('placeholder pre-equip response (status should be 200):', placeholderEquipped.status);

await page.click('.mode-nav-btn[data-mode="shop"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="shop"]');
const myAvatarsField = page.locator('.settings-field', { hasText: 'My Avatars' });
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('My Avatars') && f.querySelectorAll('.version-row').length >= 3),
  { timeout: 10000 },
);

// Self-imposed and deterministic (a plain in-page setTimeout, not a real
// network operation), so waiting this long plus a margin further down is
// not a guess at real-world timing the way a network-based delay would be —
// same reasoning #980's own fix relies on for its artificial 1500ms delay,
// just longer here since it also needs to comfortably outlast the default-
// avatar equip's own real (fast) PUT round trip issued while it's pending.
const DELAY_MS = 3000;
await page.evaluate((ms) => { window.__testAvatarLoadDelayMs = ms; }, DELAY_MS);

const customEquipPutLanded = page.waitForResponse(
  (r) => r.url().includes('/api/builders/me/avatar') && r.request().method() === 'PUT',
  { timeout: 10000 },
);
const customRow = myAvatarsField.locator('.version-row', { hasText: PRODUCT_NAME });
await customRow.locator('button', { hasText: 'Equip' }).click();
// Confirms the custom equip's own PUT has landed server-side and it's now
// sitting inside its artificial load delay (createCustomShopAvatar hasn't
// even started fetching the model yet) — not a guess at how long that
// takes.
await customEquipPutLanded;

const defaultEquipPutLanded = page.waitForResponse(
  (r) => r.url().includes('/api/builders/me/avatar') && r.request().method() === 'PUT',
  { timeout: 10000 },
);
const defaultRow = myAvatarsField.locator('.version-row', { hasText: 'Default avatar' });
await defaultRow.locator('button', { hasText: 'Equip' }).click();
await defaultEquipPutLanded;
// Small, fixed buffer for this equip's own synchronous tail
// (refreshEquippedShopAvatar(null) — a plain createShopAvatar() call, no
// network wait at all) to run now that its own PUT has already landed —
// not a guess at how long a real operation takes, since nothing async is
// left in this branch by this point.
await page.waitForTimeout(200);

// Waits out the custom equip's own artificial delay so its resolution has
// definitely happened by the time this test asserts on it, regardless of
// how long the surrounding steps above actually took.
await page.waitForTimeout(DELAY_MS + 1000);

const rowTexts = await myAvatarsField.locator('.version-row').allTextContents();
console.log('My Avatars rows after the race (Default avatar should still say "— equipped"):', rowTexts);
const defaultRowText = rowTexts.find((t) => t.includes('Default avatar'));
const customRowText = rowTexts.find((t) => t.includes(PRODUCT_NAME) && !t.includes(PLACEHOLDER_PRODUCT_NAME));

const liveShopAvatarModelUrl = await page.evaluate(() => window.__shopAvatarModelUrl);
console.log(
  'live shop avatar after the race (should be null, the default avatar, matching the picker\'s own "equipped" label — not the superseded custom one overwriting it):',
  liveShopAvatarModelUrl,
);

const pass = placeholderPurchased.status === 201 &&
  purchased.status === 201 &&
  placeholderEquipped.status === 200 &&
  !!defaultRowText?.includes('equipped') &&
  !customRowText?.includes('equipped') &&
  liveShopAvatarModelUrl === null &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'A stale, superseded custom-avatar equip does not overwrite a newer default-avatar equip (#982)',
  errors,
});
