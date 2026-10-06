// #1340: renderShopSettingsSection (src/main.js) mounts "My Avatars" and
// "My Animations" as two independent sibling fields in the same open
// Settings > Shop panel. "My Animations"' own compatibility badges
// (animationCompatibilityLabel(animationCompatibility(...))) are a pure
// function of whichever avatar is currently equipped, fetched fresh only
// when renderMyAnimationsList itself runs -- but re-equipping through "My
// Avatars"' own Equip button never told "My Animations" to re-render, so
// its badges went stale until Settings was closed and reopened.
//
// public/models/crate.glb (this repo's only e2e-friendly upload fixture)
// has no skeleton, so every avatar/animation signature involved here comes
// back `null` either way (e2e/animation-equip-settings.test.mjs's own
// comment already documents this) -- a real "Incompatible" <-> "Compatible"
// badge-text transition isn't producible with this fixture, so this test
// instead asserts on the actual mechanism the fix adds: clicking Equip on
// an avatar triggers a fresh GET /api/builders/me/animations, proving
// renderMyAnimationsList actually re-ran rather than asserting on text that
// can't vary here.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Avatar Equip Refresh Tester';
const AVATAR_PRODUCT_NAME = 'Suite Refresh Avatar';
const ANIMATION_PRODUCT_NAME = 'Suite Refresh Animation';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

async function uploadProduct(name, categoryCheckboxId) {
  await page.click('#upload-model-btn');
  await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
  await page.fill('#upload-name', name);
  await page.fill('#upload-price', '5');
  await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
  await page.waitForTimeout(300);
  await page.check(categoryCheckboxId);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
  await page.waitForTimeout(500);
}

await uploadProduct(AVATAR_PRODUCT_NAME, '#upload-avatar-category-checkbox');
await uploadProduct(ANIMATION_PRODUCT_NAME, '#upload-animation-category-checkbox');
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const avatarTemplate = templates.find((t) => t.name === AVATAR_PRODUCT_NAME);
const animationTemplate = templates.find((t) => t.name === ANIMATION_PRODUCT_NAME);

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];

async function purchaseAsInstance(instanceId, templateId) {
  await fetchJson('/api/instances', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId, x: 0, y: 0 }),
  });
  return fetchJson(`/api/instances/${instanceId}/purchase`, { method: 'POST' });
}

const avatarPurchased = await purchaseAsInstance('suite-refresh-avatar-instance', avatarTemplate.templateId);
const animationPurchased = await purchaseAsInstance('suite-refresh-animation-instance', animationTemplate.templateId);
console.log('both purchases succeeded (status should both be 201):', avatarPurchased.status, animationPurchased.status);

await page.click('.mode-nav-btn[data-mode="shop"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="shop"]');
const myAvatarsField = page.locator('.settings-field', { hasText: 'My Avatars' });
const myAnimationsField = page.locator('.settings-field', { hasText: 'My Animations' });
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('My Avatars') && f.querySelectorAll('.version-row').length >= 2),
  { timeout: 10000 },
);
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('My Animations') && f.querySelectorAll('.version-row').length >= 2),
  { timeout: 10000 },
);

// Armed right before the click -- this only resolves for a *future*
// matching request, so it can only succeed if equipping the avatar itself
// triggers this fetch, not some earlier page-load request.
const animationsListRefetched = page.waitForRequest(
  (req) => req.url().includes('/api/builders/me/animations') && req.method() === 'GET',
  { timeout: 5000 },
).then(() => true).catch(() => false);

const purchasedAvatarRow = myAvatarsField.locator('.version-row', { hasText: AVATAR_PRODUCT_NAME });
await purchasedAvatarRow.locator('button', { hasText: 'Equip' }).click();

const refetched = await animationsListRefetched;
console.log('My Animations list re-fetched after equipping a different avatar (should be true):', refetched);

await page.waitForFunction(
  (name) => [...document.querySelectorAll('.version-row')].some((r) => r.textContent.includes(name) && r.textContent.includes('equipped')),
  AVATAR_PRODUCT_NAME,
  { timeout: 10000 },
);
const avatarRowTextsAfter = await myAvatarsField.locator('.version-row').allTextContents();
const purchasedAvatarRowAfter = avatarRowTextsAfter.find((t) => t.includes(AVATAR_PRODUCT_NAME));
console.log('purchased avatar row shows equipped after the click (should be true):', purchasedAvatarRowAfter?.includes('equipped'));

// My Animations' own list should still be intact and showing the purchased
// animation -- this re-fetch is a refresh, not a crash/empty-out.
const animationRowTexts = await myAnimationsField.locator('.version-row').allTextContents();
const purchasedAnimationRow = animationRowTexts.find((t) => t.includes(ANIMATION_PRODUCT_NAME));
console.log('My Animations rows after the avatar equip (purchased animation should still be listed):', animationRowTexts);

const pass =
  avatarPurchased.status === 201 &&
  animationPurchased.status === 201 &&
  refetched &&
  !!purchasedAvatarRowAfter?.includes('equipped') &&
  !!purchasedAnimationRow &&
  errors.length === 0;
await finish(browser, { pass, label: 'Equipping a different avatar refreshes My Animations\' own compatibility list, not just My Avatars (#1340)', errors });
