// #681 (sub-issue of #679/#680): once an account has purchased and equipped
// an "avatar"-category catalog template (#680's own backend), Shop mode's
// player character should render that real .glb model instead of today's
// hardcoded procedural avatar (createShopAvatar in src/main.js). This
// covers the actual browser-side rendering path end to end — the
// ownership/equip backend itself is already covered by worker/avatar-
// ownership.test.js, so this test creates/purchases/equips the avatar via
// the real API (like simulated-purchases.test.mjs's own setup shortcuts)
// and focuses on what only a real browser can confirm: the equipped
// model's own file actually gets fetched and loaded, with no fallback to
// the default avatar.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Avatar Equip Suite Tester';
const PRODUCT_NAME = 'Suite Wearable Avatar';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// createCustomShopAvatar's own fallback (src/main.js) logs via
// console.warn, not console.error — launchPage's own `errors` array only
// captures 'error'-level console messages and page errors, so it would
// never see a silent fallback. A second listener for 'warning' messages
// catches that case specifically.
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
console.log('uploaded product found in catalog with a real modelUrl:', template?.modelUrl);

// The upload wizard has no category picker — set it directly via the same
// PATCH the Seller modal's own per-field "Edit ..." panels already use
// (merges into the existing row, worker/index.js's catalog PATCH handler).
// "avatar" needs no schema change to be a valid category (freeform text).
const patched = await fetchJson(`/api/catalog/${template.templateId}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ category: 'avatar' }),
});
console.log('category patched to avatar (status should be 200):', patched.status, patched.body.template?.category);

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];

const instanceId = 'suite-wearable-avatar-instance';
const placed = await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});
console.log('instance placed (status should be 201):', placed.status);

// Same account buys its own listing — purchasing is gated on a real,
// verified session (N44) regardless of who's buying, the same shortcut
// worker/avatar-ownership.test.js and worker/commerce.test.js's own #683
// test already use.
const purchased = await fetchJson(`/api/instances/${instanceId}/purchase`, { method: 'POST' });
console.log('purchase response (status should be 201):', purchased.status);

const equipped = await fetchJson('/api/builders/me/avatar', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ templateId: template.templateId }),
});
console.log('equip response (should carry the uploaded modelUrl):', equipped.status, equipped.body.avatar);

// --- Enter Shop mode and confirm the equipped model actually renders,
// instead of the hardcoded default avatar (#681's own scope) ---
const modelResponsePromise = page.waitForResponse(
  (r) => r.url().includes(equipped.body.avatar.modelUrl) && r.request().method() === 'GET',
  { timeout: 15000 },
);
await page.click('.mode-nav-btn[data-mode="shop"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
const modelResponse = await modelResponsePromise;
console.log('equipped avatar model fetched by the browser in Shop mode (status should be 200):', modelResponse.status());

const fallbackWarningLogged = consoleWarnings.some((w) => w.includes('Failed to load equipped avatar model'));
console.log('no fallback-to-default-avatar warning logged (should be true):', !fallbackWarningLogged);

const pass = !!template?.modelUrl &&
  patched.status === 200 && patched.body.template?.category === 'avatar' &&
  placed.status === 201 &&
  purchased.status === 201 &&
  equipped.status === 200 &&
  equipped.body.avatar?.equippedTemplateId === template.templateId &&
  equipped.body.avatar?.modelUrl === template.modelUrl &&
  modelResponse.status() === 200 &&
  !fallbackWarningLogged &&
  errors.length === 0;
await finish(browser, { pass, label: 'Equipped custom avatar model renders in Shop mode (#681)', errors });
