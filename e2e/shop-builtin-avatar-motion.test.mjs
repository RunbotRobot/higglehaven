// #3777 (owner, testing as a new person: "my avatar doesn't walk, he just kind
// of glides"): a custom avatar with no clips of its own (public/models/crate.glb
// has no skeleton and no animation clips) used to move across the ground with a
// perfectly still body. It now wears a small built-in motion: it breathes when
// standing and bobs, leans forward and sways when walking. This proves the
// motion is applied, that it differs between standing and walking, and that the
// avatar still travels. An avatar with its own clips, or an applied animation,
// replaces it (covered by shop-custom-avatar-facing-and-animation and
// animation-runtime-application, which keep __shopAvatarAnimationSource as before).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, emailForLabel, grantAdmin, goToMode, openAddProductLeaf, shopStickBox } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Builtin Motion Tester';
const AVATAR_PRODUCT_NAME = 'Clipless Test Avatar';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

await openAddProductLeaf(page);
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', AVATAR_PRODUCT_NAME);
await page.fill('#upload-price', '5');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.check('#upload-avatar-category-checkbox');
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
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
const avatarTemplate = templates.find((t) => t.name === AVATAR_PRODUCT_NAME);
const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
await grantAdmin(emailForLabel(LABEL));
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId: 'builtin-motion-avatar-instance', landletId: landlets[0].landletId, templateId: avatarTemplate.templateId, x: 0, y: 0 }),
});
const purchase = await fetchJson('/api/instances/builtin-motion-avatar-instance/purchase', { method: 'POST' });
console.log('avatar purchase (should be 201):', purchase.status);

await goToMode(page, 'shop');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
const defaultBodyHook = await page.evaluate(() => ({ flag: window.__shopAvatarBuiltinMotion, pose: window.__testShopAvatarBuiltinPose() }));
console.log('default body has no built-in motion (flag false, pose null):', JSON.stringify(defaultBodyHook));

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="shop"]');
const myAvatarsField = page.locator('.settings-field', { hasText: 'My avatars' });
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('My avatars') && f.querySelectorAll('.version-row').length >= 2),
  null,
  { timeout: 30000 },
);
await myAvatarsField.locator('.version-row', { hasText: AVATAR_PRODUCT_NAME }).locator('button', { hasText: 'Equip' }).click();
await page.waitForFunction(
  (name) => [...document.querySelectorAll('.version-row')].some((r) => r.textContent.includes(name) && r.textContent.includes('equipped')),
  AVATAR_PRODUCT_NAME,
  { timeout: 10000 },
);
await page.click('#settings-close-btn');
await page.waitForTimeout(300);

const equipped = await page.evaluate(() => ({ source: window.__shopAvatarAnimationSource, flag: window.__shopAvatarBuiltinMotion }));
console.log('equipped a clip-less avatar: animation source stays null, built-in motion on (null, true):', JSON.stringify(equipped));

// A fresh spawn starts airborne (see shop-custom-avatar-facing-and-animation's #2043 note):
// come down, then let the landing finish before judging walk against stand.
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForTimeout(4500);

const sample = async (ms) => {
  const poses = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    poses.push(await page.evaluate(() => window.__testShopAvatarBuiltinPose()));
    await page.waitForTimeout(50);
  }
  return poses.filter(Boolean);
};
const range = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);

const standing = await sample(2500);
const standingLean = Math.max(...standing.map((p) => Math.abs(p.leanRad)));
const standingBob = range(standing.map((p) => p.z));
console.log('standing: samples, lean (rad, ~0), bob range (m, small but moving):', standing.length, standingLean.toFixed(4), standingBob.toFixed(4));

const start = await page.evaluate(() => window.__testShopAvatarPosition());
const stick = await shopStickBox(page);
const cx = stick.x + stick.width / 2;
const cy = stick.y + stick.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx, cy - 40, { steps: 5 });
await page.waitForTimeout(800);
const walking = await sample(2000);
const end = await page.evaluate(() => window.__testShopAvatarPosition());
await page.mouse.up();
const walkLean = Math.min(...walking.map((p) => p.leanRad));
const walkBob = range(walking.map((p) => p.z));
const walkSway = range(walking.map((p) => p.swayRad));
const travelled = Math.hypot(end.x - start.x, end.y - start.y);
console.log('walking: lean (rad, forward is negative), bob range (m), sway range (rad), travelled (m):', walkLean.toFixed(4), walkBob.toFixed(4), walkSway.toFixed(4), travelled.toFixed(2));

const pass = defaultBodyHook.flag === false && defaultBodyHook.pose === null
  && equipped.source === null && equipped.flag === true
  && standing.length > 10 && standingLean < 0.005 && standingBob > 0.0005
  && walking.length > 10 && walkLean < -0.02 && walkBob > standingBob * 2 && walkSway > 0.02 && travelled > 0.5
  && errors.length === 0;
await finish(browser, { pass, label: '#3777: a clip-less custom avatar wears the built-in walk and stand motion', errors });
