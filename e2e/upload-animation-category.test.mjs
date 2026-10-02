// #1163 (sub-issue of #1161): the upload wizard's new "List as a
// standalone animation" checkbox, alongside #712's existing "List as an
// equippable avatar" one. The two are mutually exclusive (checking one
// clears the other — see their own change listeners in src/main.js) since
// a listing is "avatar" or "animation" or neither, never both. Confirms
// both the mutual exclusivity itself and that checking "animation" alone
// actually lands as category: 'animation' server-side, the same way
// e2e/seller-duplicate-preserves-category.test.mjs already confirms for
// "avatar".
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Animation Category Tester';
const PRODUCT_NAME = 'Standalone Animation Upload';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);

// Checking "avatar" first, then "animation" — the second check should
// clear the first (mutual exclusivity), not leave both checked.
await page.check('#upload-avatar-category-checkbox');
await page.check('#upload-animation-category-checkbox');
const avatarCheckedAfterAnimation = await page.locator('#upload-avatar-category-checkbox').isChecked();
console.log('avatar checkbox cleared after checking animation (should be true):', !avatarCheckedAfterAnimation);

// And the reverse direction: checking "avatar" again should clear
// "animation" right back.
await page.check('#upload-avatar-category-checkbox');
const animationCheckedAfterAvatar = await page.locator('#upload-animation-category-checkbox').isChecked();
console.log('animation checkbox cleared after checking avatar (should be true):', !animationCheckedAfterAvatar);

// Leave only "animation" checked for the actual submit below.
await page.check('#upload-animation-category-checkbox');
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const created = templates.find((t) => t.name === PRODUCT_NAME);
console.log('uploaded product has animation category (should be true):', created?.category === 'animation');

const pass =
  !avatarCheckedAfterAnimation &&
  !animationCheckedAfterAvatar &&
  created?.category === 'animation' &&
  errors.length === 0;
await finish(browser, { pass, label: 'Upload wizard: standalone "animation" category, mutually exclusive with "avatar" (#1163)', errors });
