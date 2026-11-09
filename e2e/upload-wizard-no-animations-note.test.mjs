// #2744 (owner, 2026-11-08): an uploaded avatar model that carries no animation
// clips at all is a static mesh, and the upload wizard said nothing about it,
// which is what sent everyone looking for a clip-naming problem instead. When a
// seller lists such a model as an equippable avatar, the Confirm Dimensions
// step must now say so plainly. It must stay quiet for an ordinary product (no
// avatar box ticked), go away when the box is unticked, and stay quiet for a
// model that does have clips.
//
// public/models/crate.glb has no skeleton and no clips (the repo's usual
// e2e-friendly upload fixture); e2e/fixtures/test-rigged-avatar.glb carries
// idle/walk/fly clips.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NO_CLIPS_MODEL = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const CLIPS_MODEL = path.join(REPO_ROOT, 'e2e', 'fixtures', 'test-rigged-avatar.glb');

const LABEL = 'No Animations Note Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

async function openWizardOnDimensionsStep(modelPath, name) {
  await page.click('#upload-model-btn');
  await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
  await page.fill('#upload-name', name);
  await page.fill('#upload-price', '5');
  await page.setInputFiles('#upload-file-input', modelPath);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
  // The clip count is read asynchronously after the preview loads.
  await page.waitForTimeout(1500);
}

const noteState = () => page.evaluate(() => {
  const el = document.getElementById('upload-no-animations-note');
  return { hidden: el.hidden, text: el.textContent.trim() };
});

// 1. A model with no clips.
await openWizardOnDimensionsStep(NO_CLIPS_MODEL, 'Static Model');
const beforeTicking = await noteState();
console.log('no clips, avatar box not ticked: note hidden (should be true):', beforeTicking.hidden);

await page.check('#upload-avatar-category-checkbox');
const afterTicking = await noteState();
console.log('no clips, avatar box ticked: note shown (hidden should be false):', afterTicking.hidden, '| text:', afterTicking.text);

await page.uncheck('#upload-avatar-category-checkbox');
const afterUnticking = await noteState();
console.log('no clips, avatar box unticked again: note hidden (should be true):', afterUnticking.hidden);

// Switching to the standalone-animation category clears the avatar box, so the
// avatar note must not linger.
await page.check('#upload-avatar-category-checkbox');
await page.check('#upload-animation-category-checkbox');
const afterAnimationCategory = await noteState();
console.log('no clips, switched to the animation category: note hidden (should be true):', afterAnimationCategory.hidden);

await page.click('#upload-cancel-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 10000 });

// 2. A model that does have clips: the avatar box must not bring the note up.
await openWizardOnDimensionsStep(CLIPS_MODEL, 'Rigged Model');
await page.check('#upload-avatar-category-checkbox');
const withClips = await noteState();
const clipsLine = await page.evaluate(() => {
  const el = document.getElementById('upload-animations-detected');
  return { hidden: el.hidden, text: el.textContent.trim() };
});
console.log('model with clips, avatar box ticked: note hidden (should be true):', withClips.hidden, '| clip line (should list idle, walk, fly):', clipsLine.text);

const pass =
  beforeTicking.hidden === true &&
  afterTicking.hidden === false && /no animations/i.test(afterTicking.text) &&
  afterUnticking.hidden === true &&
  afterAnimationCategory.hidden === true &&
  withClips.hidden === true &&
  clipsLine.hidden === false && /idle, walk, fly/.test(clipsLine.text) &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'the upload wizard says plainly when an avatar model has no animations, and only then (#2744)',
  errors,
});
