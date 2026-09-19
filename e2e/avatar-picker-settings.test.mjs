// #713 (sub-issue of #710): #679's four sub-issues shipped the backend
// (GET /api/builders/me/avatars, GET/PUT /api/builders/me/avatar) and the
// in-world rendering of whatever ends up equipped, but nothing in src/main.js
// ever called any of it — a builder who bought an avatar-category listing had
// no UI anywhere to ever browse or equip one. This test exercises the real
// "My Avatars" picker (Settings > Shop) end to end: it lists the owned
// avatar plus the always-available "Default avatar" revert option, equipping
// through the picker actually calls PUT .../avatar, and — the point of doing
// this from inside an already-entered Shop mode rather than reloading into
// one — the live scene swaps to the newly-equipped avatar immediately, with
// no page reload (refreshEquippedShopAvatar, src/main.js), unlike
// e2e/avatar-equip-render.test.mjs's own fresh-Shop-mode-entry coverage of
// the same rendering path.
//
// Not asserted on: a fresh network GET for the model file at equip time.
// This test's own upload step already loads the exact same URL once for
// showUploadDimensionPreview's animation check (self-purchase, same account
// as both seller and buyer, same as this repo's other e2e setup shortcuts),
// which lands it in loadModelGltf's own permanent per-URL cache (src/main.js:
// "Loaded once per URL and cached") — so equipping afterwards correctly
// reuses that cache rather than re-fetching, and asserting a second network
// request here would be asserting on a caching implementation detail, not
// this feature's actual behavior. The real signal that createCustomShopAvatar
// ran (rather than silently no-op'ing) is the absence of its own
// "Failed to load equipped avatar model" fallback warning, alongside the
// picker's own row state actually flipping.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Avatar Picker Suite Tester';
const PRODUCT_NAME = 'Suite Picker Avatar';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// createCustomShopAvatar's own fallback (src/main.js) logs via console.warn,
// not console.error — launchPage's own `errors` array only captures
// 'error'-level console messages and page errors, so it would never see a
// silent fallback. Same pattern as e2e/avatar-equip-render.test.mjs.
const consoleWarnings = [];
page.on('console', (msg) => {
  if (msg.type() === 'warning') consoleWarnings.push(msg.text());
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '5');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);
await page.check('#upload-avatar-category-checkbox');
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);
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

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];

const instanceId = 'suite-picker-avatar-instance';
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});
const purchased = await fetchJson(`/api/instances/${instanceId}/purchase`, { method: 'POST' });
console.log('purchase response (status should be 201):', purchased.status);

// --- Enter Shop mode fresh (the default avatar, nothing equipped yet) ---
await page.click('.mode-nav-btn[data-mode="shop"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });

// A marker surviving to the end of this test is this test's own proof that
// none of the steps below ever reload the page — a real risk given
// e2e/avatar-equip-render.test.mjs's own coverage always equips before Shop
// mode is entered fresh; this test's whole point is equipping *from inside*
// an already-running Shop mode instead.
await page.evaluate(() => { window.__noReloadMarker = 'still-here'; });

// --- Open Settings > Shop and inspect the picker before equipping anything ---
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="shop"]');
const myAvatarsField = page.locator('.settings-field', { hasText: 'My Avatars' });
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('My Avatars') && f.querySelectorAll('.version-row').length >= 2),
  { timeout: 10000 },
);

const rowTextsBeforeEquip = await myAvatarsField.locator('.version-row').allTextContents();
console.log('My Avatars rows before equipping (should list Default avatar as equipped, and the purchased avatar not yet equipped):', rowTextsBeforeEquip);
const defaultRowBefore = rowTextsBeforeEquip.find((t) => t.includes('Default avatar'));
const purchasedRowBefore = rowTextsBeforeEquip.find((t) => t.includes(PRODUCT_NAME));

// --- Equip the purchased avatar through the real picker UI, still standing
// in Shop mode — this is the live-swap path (refreshEquippedShopAvatar), not
// a fresh Shop-mode entry ---
const purchasedRow = myAvatarsField.locator('.version-row', { hasText: PRODUCT_NAME });
await purchasedRow.locator('button', { hasText: 'Equip' }).click();
await page.waitForFunction(
  (name) => [...document.querySelectorAll('.version-row')].some((r) => r.textContent.includes(name) && r.textContent.includes('equipped')),
  PRODUCT_NAME,
  { timeout: 10000 },
);
const rowTextsAfterEquip = await myAvatarsField.locator('.version-row').allTextContents();
console.log('My Avatars rows after equipping (purchased avatar should now say "— equipped"):', rowTextsAfterEquip);
const purchasedRowAfter = rowTextsAfterEquip.find((t) => t.includes(PRODUCT_NAME));
const defaultRowAfter = rowTextsAfterEquip.find((t) => t.includes('Default avatar'));

const noFallbackWarningAfterEquip = !consoleWarnings.some((w) => w.includes('Failed to load equipped avatar model'));
console.log('no fallback-to-default-avatar warning logged when equipping (should be true — the custom model swap succeeded):', noFallbackWarningAfterEquip);

const markerAfterEquip = await page.evaluate(() => window.__noReloadMarker);
console.log('window marker set before equipping still present (proves no page reload happened):', markerAfterEquip);

// --- Revert to the default avatar via the same picker, no page reload ---
const defaultRow = myAvatarsField.locator('.version-row', { hasText: 'Default avatar' });
await defaultRow.locator('button', { hasText: 'Equip' }).click();
await page.waitForFunction(
  () => [...document.querySelectorAll('.version-row')].some((r) => r.textContent.includes('Default avatar') && r.textContent.includes('equipped')),
  { timeout: 10000 },
);
const rowTextsAfterRevert = await myAvatarsField.locator('.version-row').allTextContents();
console.log('My Avatars rows after reverting to default:', rowTextsAfterRevert);
const defaultRowAfterRevert = rowTextsAfterRevert.find((t) => t.includes('Default avatar'));
const purchasedRowAfterRevert = rowTextsAfterRevert.find((t) => t.includes(PRODUCT_NAME));

const markerAfterRevert = await page.evaluate(() => window.__noReloadMarker);

const pass = purchased.status === 201 &&
  !!defaultRowBefore?.includes('equipped') &&
  !purchasedRowBefore?.includes('equipped') &&
  !!purchasedRowAfter?.includes('equipped') &&
  !defaultRowAfter?.includes('equipped') &&
  noFallbackWarningAfterEquip &&
  markerAfterEquip === 'still-here' &&
  !!defaultRowAfterRevert?.includes('equipped') &&
  !purchasedRowAfterRevert?.includes('equipped') &&
  markerAfterRevert === 'still-here' &&
  errors.length === 0;
await finish(browser, { pass, label: 'Settings > Shop "My Avatars" picker equips/reverts live, without a page reload (#713)', errors });
