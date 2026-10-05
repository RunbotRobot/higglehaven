// Regression test for #1309: cropping an already-flagged Community Sign
// via Trim used to silently send isCommunitySign: false to the server
// (replaceMeshWithCrop's instanceLike never carried the flag forward, so
// the freshly-rebuilt mesh defaulted it to false), which the PATCH handler
// correctly reads as a real true->false transition and cascade-deletes the
// sign's posts. A builder who only ever touched the Trim gizmo would lose
// every post on the sign as a side effect, with the instance silently
// un-flagged too. Combines extensibility-trim.test.mjs's extensible-crate
// setup with community-signs.test.mjs's flag-then-post flow.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Sign Crop Suite Tester';
const PRODUCT_NAME = 'Sign Crop Suite Crate';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

async function fetchJson(p, options) {
  return page.evaluate(async ([pp, opts]) => {
    const res = await fetch(pp, opts);
    return { status: res.status, body: await res.json() };
  }, [p, options]);
}

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

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
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

// Mark it extensible on x with a 0.2m minimum, same as extensibility-trim.test.mjs.
const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('button', { hasText: 'Extensibility' }).click();
await page.waitForTimeout(300);
const xAxisRow = row().locator('.seller-axis-row').nth(0);
await xAxisRow.locator('input[type=checkbox]').check();
await xAxisRow.locator('.seller-min-input').fill('0.2');
await row().locator('button', { hasText: 'Save' }).and(page.locator('.seller-save-btn')).click();
await page.waitForTimeout(800);

await page.click('#seller-close-btn');
await page.waitForTimeout(300);
await page.click('.mode-nav-btn[data-mode="build"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#add-item-btn', { timeout: 15000 });
await page.waitForTimeout(500);

// Place it and select it.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: PRODUCT_NAME }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(1000);

// Flag it as a Community Sign.
const communitySignBtn = () => page.locator('#toggle-community-sign');
await communitySignBtn().click();
await page.waitForTimeout(500);
const labelAfterFlag = await communitySignBtn().textContent();
console.log('Community Sign button label after flagging (should mention Manage):', labelAfterFlag);

const { landlets } = (await fetchJson('/api/landlets?limit=100')).body;
const myLandlet = landlets.find((l) => l.ownerBuilderId);
const { instances } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const signInstance = instances[0];
console.log('isCommunitySign persisted right after flagging (should be true):', signInstance.isCommunitySign);

// Leave a post on it before cropping.
await fetchJson(`/api/instances/${signInstance.instanceId}/posts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ authorLabel: 'A Shopper', text: 'Love this place!' }),
});
const { posts: postsBeforeCrop } = (await fetchJson(`/api/instances/${signInstance.instanceId}/posts`)).body;
console.log('posts before cropping (should be 1):', postsBeforeCrop.length);

// Crop it via Trim mode's text field — the bug's actual trigger. The sign
// should survive this completely untouched: still flagged, post still there.
await page.click('#mode-trim');
await page.waitForTimeout(500);
await page.fill('.trim-axis-field[data-trim-axis="x"] .trim-length-input', '0.5');
await page.locator('.trim-axis-field[data-trim-axis="x"] .trim-length-input').dispatchEvent('change');
await page.waitForTimeout(800);

const labelAfterCrop = await communitySignBtn().textContent();
console.log('Community Sign button label after cropping (should still mention Manage, not reset to plain):', labelAfterCrop);

const { instances: instancesAfterCrop } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const signInstanceAfterCrop = instancesAfterCrop.find((i) => i.instanceId === signInstance.instanceId);
console.log('isCommunitySign persisted after cropping (should still be true):', signInstanceAfterCrop?.isCommunitySign);
console.log('crop persisted after cropping (should be 0.5):', signInstanceAfterCrop?.crop);

const { posts: postsAfterCrop } = (await fetchJson(`/api/instances/${signInstance.instanceId}/posts`)).body;
console.log('posts after cropping (should still be 1, not cascade-deleted):', postsAfterCrop.length);

const pass = signInstance.isCommunitySign === true &&
  postsBeforeCrop.length === 1 &&
  labelAfterCrop.includes('✓') &&
  signInstanceAfterCrop?.isCommunitySign === true &&
  postsAfterCrop.length === 1 &&
  errors.length === 0;
await finish(browser, { pass, label: 'Community Sign flag + posts survive a Trim crop', errors });
