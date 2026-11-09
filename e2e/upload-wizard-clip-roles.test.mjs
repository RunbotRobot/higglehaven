// #3315 (part of #3301): the upload wizard's "Which motion is this clip?"
// picker. For an equippable-avatar listing whose file has clips, each clip gets
// an Idle / Walk / Fly / Not used pick, pre-filled from the clip's name, so a
// correctly named file needs no interaction and sends no clipRoles. Changing a
// pick sends the chosen clip names; picking a role another clip holds moves it.
//
// e2e/fixtures/test-rigged-avatar.glb carries clips named idle, walk and fly.
// Phone-width viewport (launchPage's default).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIPS_MODEL = path.join(REPO_ROOT, 'e2e', 'fixtures', 'test-rigged-avatar.glb');

const LABEL = 'Clip Roles Picker Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

const createBodies = [];
page.on('request', (request) => {
  if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/catalog') {
    try { createBodies.push(JSON.parse(request.postData())); } catch { /* not JSON */ }
  }
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

async function openWizardOnDimensionsStep(name) {
  await page.click('#upload-model-btn');
  await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
  await page.fill('#upload-name', name);
  await page.fill('#upload-price', '5');
  await page.setInputFiles('#upload-file-input', CLIPS_MODEL);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
  // The clip list is read asynchronously after the preview loads.
  await page.waitForFunction(() => document.getElementById('upload-animations-detected').hidden === false, null, { timeout: 15000 });
}
const pickerVisible = () => page.evaluate(() => !document.getElementById('upload-clip-roles').hidden);
const pickerValues = () => page.evaluate(() => [...document.querySelectorAll('.upload-clip-role-select')].map((el) => el.value));
const pickerNames = () => page.evaluate(() => [...document.querySelectorAll('.upload-clip-role-name')].map((el) => el.textContent.trim()));

async function submitAndWaitForClose() {
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
  await page.waitForTimeout(300);
}

// 1. Hidden until the avatar box is ticked; pre-filled from the clip names.
await openWizardOnDimensionsStep('Clip Roles Untouched');
const hiddenBeforeTicking = !(await pickerVisible());
await page.check('#upload-avatar-category-checkbox');
const shownAfterTicking = await pickerVisible();
const names = await pickerNames();
const prefilled = await pickerValues();
console.log('picker hidden before the avatar box is ticked (should be true):', hiddenBeforeTicking);
console.log('picker shown once ticked (should be true):', shownAfterTicking, '| clips:', names.join(','), '| picks:', prefilled.join(','));
const prefilledMatchesNames = names.length === 3 && names.every((name, i) => prefilled[i] === name.toLowerCase());
await page.uncheck('#upload-avatar-category-checkbox');
const hiddenAfterUnticking = !(await pickerVisible());
await page.check('#upload-avatar-category-checkbox');

// 2. Untouched picks send no clipRoles.
await submitAndWaitForClose();
const untouchedBody = createBodies.find((body) => body.name === 'Clip Roles Untouched');
console.log('untouched picker: request carries no clipRoles (should be true):', untouchedBody && !('clipRoles' in untouchedBody));

// 3. Changing a pick sends the chosen clip names; picking a held role moves it.
await openWizardOnDimensionsStep('Clip Roles Changed');
await page.check('#upload-avatar-category-checkbox');
// Make the clip called "fly" play as Walk: the walk role leaves the "walk" clip.
const flyIndex = names.indexOf('fly');
await page.locator('.upload-clip-role-select').nth(flyIndex).selectOption('walk');
const afterMove = await pickerValues();
console.log('after picking Walk for the fly clip, picks (should be idle,none,walk):', afterMove.join(','));
const moved = afterMove.join(',') === ['idle', 'none', 'walk'].join(',');
await submitAndWaitForClose();
const changedBody = createBodies.find((body) => body.name === 'Clip Roles Changed');
console.log('changed picker: clipRoles sent (should be {idle:"idle",walk:"fly",fly:null}):', JSON.stringify(changedBody?.clipRoles));
const changedSent = changedBody?.clipRoles?.idle === 'idle' && changedBody.clipRoles.walk === 'fly' && changedBody.clipRoles.fly === null;

const pass = hiddenBeforeTicking && shownAfterTicking && prefilledMatchesNames && hiddenAfterUnticking
  && untouchedBody && !('clipRoles' in untouchedBody) && moved && changedSent && errors.length === 0;
await finish(browser, {
  pass,
  label: '#3315: the upload wizard shows a pre-filled "Which motion is this clip?" picker for avatar listings and sends clipRoles only when a pick changed',
  errors,
});
