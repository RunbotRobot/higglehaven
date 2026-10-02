// #1165 (sub-issue of #1161, last piece): applying a standalone animation
// (#1163/#1164) actually plays against the equipped avatar at runtime
// (createCustomShopAvatar's own compatibility check — see its doc comment)
// instead of just recording the choice server-side, and switching avatars
// or animations while already in Shop mode re-evaluates and re-binds live,
// with no page reload (mirroring e2e/avatar-picker-settings.test.mjs's own
// coverage shape for the avatar-equip half of this).
//
// Not exercised here: the true "applied animation's own clips actually
// bind and play" case. public/models/crate.glb (this repo's only
// e2e-friendly upload fixture) has no skeleton and no animation clips at
// all, so both sides of every compatibility check in this test come back
// `null`/`false` — window.__shopAvatarAnimationSource stays `null`
// throughout. That's still a real, meaningful path to cover (the "sane
// fallback, don't just break silently" requirement this issue's own text
// asks for), and this test confirms exactly that: applying/switching never
// throws, never shows a page error, and the diagnostic reflects the
// correct fallback state at every step. The actual exact-match bone-name
// binding logic itself has no further three.js/DOM dependency beyond
// THREE.AnimationMixer's own documented behavior (binding by name against
// whatever root it was constructed with, regardless of which file parsed
// the clip) and #1162's own already-covered signature equality — nothing
// new to re-verify here with a synthetic rig, per this project's own
// established "manual/scratch verification for anything needing a real
// skeleton fixture" precedent (see #1162's own PR description).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Animation Runtime Tester';
const AVATAR_PRODUCT_NAME = 'Runtime Test Avatar';
const ANIMATION_PRODUCT_NAME = 'Runtime Test Animation';

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

async function placeAndPurchase(instanceId, templateId) {
  await fetchJson('/api/instances', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId, x: 0, y: 0 }),
  });
  return fetchJson(`/api/instances/${instanceId}/purchase`, { method: 'POST' });
}

const avatarPurchased = await placeAndPurchase('runtime-avatar-instance', avatarTemplate.templateId);
const animationPurchased = await placeAndPurchase('runtime-animation-instance', animationTemplate.templateId);
console.log('avatar + animation purchase responses (both should be 201):', avatarPurchased.status, animationPurchased.status);

// --- Enter Shop mode with nothing equipped/applied yet ---
await page.click('.mode-nav-btn[data-mode="shop"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });

const sourceOnFreshEntry = await page.evaluate(() => window.__shopAvatarAnimationSource);
console.log('animation source on fresh Shop-mode entry, nothing equipped (should be null):', sourceOnFreshEntry);

await page.evaluate(() => { window.__noReloadMarker = 'still-here'; });

// --- Equip the purchased avatar, live, from Settings ---
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="shop"]');

const myAvatarsField = page.locator('.settings-field', { hasText: 'My Avatars' });
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('My Avatars') && f.querySelectorAll('.version-row').length >= 2),
  { timeout: 10000 },
);
await myAvatarsField.locator('.version-row', { hasText: AVATAR_PRODUCT_NAME }).locator('button', { hasText: 'Equip' }).click();
await page.waitForFunction(
  (name) => [...document.querySelectorAll('.version-row')].some((r) => r.textContent.includes(name) && r.textContent.includes('equipped')),
  AVATAR_PRODUCT_NAME,
  { timeout: 10000 },
);

const sourceAfterAvatarEquip = await page.evaluate(() => window.__shopAvatarAnimationSource);
console.log('animation source right after equipping a (skeleton-less) avatar, nothing applied yet (should be null):', sourceAfterAvatarEquip);

// --- Apply the purchased animation, live, from the same Settings tab ---
const myAnimationsField = page.locator('.settings-field', { hasText: 'My Animations' });
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('My Animations') && f.querySelectorAll('.version-row').length >= 1),
  { timeout: 10000 },
);
await myAnimationsField.locator('.version-row', { hasText: ANIMATION_PRODUCT_NAME }).locator('button', { hasText: 'Apply' }).click();
await page.waitForFunction(
  (name) => [...document.querySelectorAll('.version-row')].some((r) => r.textContent.includes(name) && r.textContent.includes('— applied')),
  ANIMATION_PRODUCT_NAME,
  { timeout: 10000 },
);

const sourceAfterApply = await page.evaluate(() => window.__shopAvatarAnimationSource);
console.log('animation source right after applying (crate.glb has no skeleton/clips, so this should still be null -- the fallback-to-own-clips path, with no crash):', sourceAfterApply);

// --- Revert to the default avatar while the animation stays applied --
// the "switch to an incompatible avatar" case, which should quietly fall
// back rather than erroring.
await myAvatarsField.locator('.version-row', { hasText: 'Default avatar' }).locator('button', { hasText: 'Equip' }).click();
await page.waitForFunction(
  () => [...document.querySelectorAll('.version-row')].some((r) => r.textContent.includes('Default avatar') && r.textContent.includes('equipped')),
  { timeout: 10000 },
);

const sourceAfterRevert = await page.evaluate(() => window.__shopAvatarAnimationSource);
console.log('animation source after reverting to the default avatar with the animation still applied (should be null -- no skeleton at all to compare against):', sourceAfterRevert);

const markerStillPresent = await page.evaluate(() => window.__noReloadMarker);
console.log('marker set before any of the above still present (proves none of this reloaded the page):', markerStillPresent);

const pass =
  avatarPurchased.status === 201 &&
  animationPurchased.status === 201 &&
  sourceOnFreshEntry === null &&
  sourceAfterAvatarEquip === null &&
  sourceAfterApply === null &&
  sourceAfterRevert === null &&
  markerStillPresent === 'still-here' &&
  errors.length === 0;
await finish(browser, { pass, label: 'Applying/switching an animation re-evaluates compatibility live, without a page reload or crash (#1165)', errors });
