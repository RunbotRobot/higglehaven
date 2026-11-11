// #3300 (owner report, a textured Mixamo .fbx): convertFbxToGlb exported
// before the embedded textures had decoded, so GLTFExporter threw "No valid
// image data found" and the upload failed. A textured .fbx must now convert
// with its texture intact, and one whose texture genuinely cannot be decoded
// must still convert (plain, with a notice) rather than fail.
//
// e2e/fixtures/test-textured-triangle.fbx is test-triangle.fbx plus a UV map
// and a 4x4 PNG embedded as base64 in the file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXTURED = path.join(REPO_ROOT, 'e2e', 'fixtures', 'test-textured-triangle.fbx');

const LABEL = 'FBX Texture Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

// Collect every model upload body so the stored GLB can be inspected. An
// upload also stores a mid and a far version of the model (#3414, sent as
// ?tier=mid|far), and the far one has no textures by design, so the full
// model is the upload that carries no tier.
const uploadBodies = [];
page.on('request', (req) => {
  const url = new URL(req.url());
  if (req.method() === 'POST' && /\/api\/models$/.test(url.pathname) && !url.searchParams.has('tier')) {
    const buf = req.postDataBuffer();
    if (buf) uploadBodies.push(buf);
  }
});

async function runWizard(fileArg, name) {
  await page.click('#upload-model-btn');
  await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
  await page.fill('#upload-name', name);
  await page.fill('#upload-price', '5');
  await page.setInputFiles('#upload-file-input', fileArg);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(
    () => !document.getElementById('upload-step-dimensions').hidden
      || /could not convert/i.test(document.getElementById('upload-status').textContent),
    null,
    { timeout: 40000 },
  );
  await page.waitForTimeout(500);
  return page.evaluate(() => ({
    onDimensions: !document.getElementById('upload-step-dimensions').hidden,
    status: document.getElementById('upload-status').textContent.trim(),
    notice: (() => {
      const el = document.getElementById('upload-conversion-notice');
      return { hidden: el.hidden, text: el.textContent.trim() };
    })(),
  }));
}

// 1. A readable embedded texture: converts, keeps the image, no notice.
const good = await runWizard(TEXTURED, 'Textured FBX');
const goodBody = uploadBodies.at(-1)?.toString('latin1') ?? '';
const goodHasImages = /"images"\s*:/.test(goodBody);
console.log('textured fbx reaches the dimensions step (should be true):', good.onDimensions, '| status:', good.status);
console.log('stored glb carries the texture image (should be true):', goodHasImages);
console.log('no notice for a readable texture (hidden should be true):', good.notice.hidden);
await page.click('#upload-cancel-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 10000 });

// 2. A texture that cannot be decoded: still converts, with a notice.
const corrupt = Buffer.from(fs.readFileSync(TEXTURED, 'utf8').replace(/Content: "[^"]+"/, 'Content: "bm90IGEgcmVhbCBwbmc="'));
const bad = await runWizard({ name: 'corrupt-texture.fbx', mimeType: 'application/octet-stream', buffer: corrupt }, 'Corrupt Texture FBX');
console.log('corrupt-texture fbx still reaches the dimensions step (should be true):', bad.onDimensions, '| status:', bad.status);
console.log('notice shown (hidden should be false):', bad.notice.hidden, '|', bad.notice.text);
await page.click('#upload-cancel-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 10000 });

const pass =
  good.onDimensions && goodHasImages && good.notice.hidden === true &&
  bad.onDimensions && bad.notice.hidden === false && /could not be read/.test(bad.notice.text) &&
  !/#\d|No valid image/.test(bad.notice.text + bad.status) &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'a textured .fbx converts with its texture, and an undecodable texture is skipped with a notice (#3300)',
  errors,
});
