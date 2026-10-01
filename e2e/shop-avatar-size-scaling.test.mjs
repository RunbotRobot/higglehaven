// #1091: shopPositionBlocked's collision footprint/height and
// positionShopCamera's follow-camera anchor height used to always read the
// default procedural body's own fixed SHOP_AVATAR_* constants, even once a
// custom equipped avatar (createCustomShopAvatar) had already measured its
// own real bounding-box size. Confirms the fix via window.__shopAvatarMetrics
// (a read-only diagnostic exposed for exactly this, same pattern as the
// existing window.__shopAvatarModelUrl) — the measured height/collision-half
// should change once a custom avatar is equipped instead of staying pinned
// to the default body's values, and the camera anchor should keep scaling
// proportionally to height rather than reusing the default's absolute one.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Shop Avatar Size Scaling Tester';
const PRODUCT_NAME = 'Scaling Suite Wearable Avatar';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// #556/N44: Build/Sell require the age/ID-verification gate Shop doesn't —
// entering via 'build' first (same as avatar-equip-render.test.mjs's own
// setup) clears it once for the whole account, so the later purchase/equip
// calls below don't get rejected as an unverified session.
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

// Baseline: visit Shop mode before anything is equipped, so the default
// procedural body is what's live-rendered.
await page.click('.mode-nav-btn[data-mode="shop"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
const baseline = await page.evaluate(() => window.__shopAvatarMetrics);
console.log('baseline metrics (default body, should be the fixed constants):', baseline);

// Upload and equip a custom avatar whose real geometry (crate.glb) is a
// totally different size from the default body's own proportions.
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: false });
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
console.log('uploaded avatar product (should have a real modelUrl):', template?.modelUrl);

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];

const instanceId = 'scaling-suite-wearable-avatar-instance';
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});
await fetchJson(`/api/instances/${instanceId}/purchase`, { method: 'POST' });
const equipped = await fetchJson('/api/builders/me/avatar', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ templateId: template.templateId }),
});
console.log('equip response (should carry the uploaded modelUrl):', equipped.status, equipped.body.avatar);

const modelResponsePromise = page.waitForResponse(
  (r) => r.url().includes(equipped.body.avatar.modelUrl) && r.request().method() === 'GET',
  { timeout: 15000 },
);
await page.click('.mode-nav-btn[data-mode="shop"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await modelResponsePromise;
const equippedMetrics = await page.evaluate(() => window.__shopAvatarMetrics);
console.log('metrics after equipping a custom avatar (should differ from baseline):', equippedMetrics);

const heightChanged = equippedMetrics.heightM !== baseline.heightM;
const collisionHalfChanged = equippedMetrics.collisionHalfM !== baseline.collisionHalfM;
const baselineRatio = baseline.cameraAnchorHeightM / baseline.heightM;
const equippedRatio = equippedMetrics.cameraAnchorHeightM / equippedMetrics.heightM;
const ratioPreserved = Math.abs(equippedRatio - baselineRatio) < 1e-9;
console.log('measured height changed after equip (should be true):', heightChanged);
console.log('measured collision half-width changed after equip (should be true):', collisionHalfChanged);
console.log('camera-anchor-to-height ratio preserved across the scale change (should be true):', ratioPreserved, { baselineRatio, equippedRatio });

const pass =
  baseline.heightM > 0 && baseline.collisionHalfM > 0 &&
  equippedMetrics.heightM > 0 && equippedMetrics.collisionHalfM > 0 &&
  heightChanged && collisionHalfChanged && ratioPreserved &&
  errors.length === 0;
await finish(browser, { pass, label: 'Shop-mode collision/camera sizing scales to a custom equipped avatar (#1091)', errors });
