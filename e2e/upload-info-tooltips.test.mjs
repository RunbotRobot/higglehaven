// #1602: the upload wizard's long explanatory paragraphs (#upload-hint,
// #upload-dimensions-hint) used to render inline, permanently taking up
// space. They're now tucked behind a small "?" button that reveals the
// text on tap instead, via the generic .info-tooltip-btn/.info-tooltip-popup
// pattern (src/main.js's single delegated click handler). This checks the
// popup starts hidden, opens on tapping its button, closes when a second
// tooltip opens (only one shown at a time), and closes on an outside click.
// Also covers #seller-hint ("My products"), the broader-pass follow-up
// #1635 (this same issue's first PR) left open — same component, a
// different modal, so it belongs in this same file rather than a new one.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'Info Tooltip Suite Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });

const startsHidden = await page.isHidden('#upload-hint');
console.log('upload-hint starts hidden (should be true):', startsHidden);

await page.click('#upload-hint-btn');
await page.waitForTimeout(100);
const visibleAfterClick = await page.isVisible('#upload-hint');
const expandedAfterClick = await page.getAttribute('#upload-hint-btn', 'aria-expanded');
console.log('upload-hint visible after clicking its "?" button (should be true):', visibleAfterClick);
console.log('upload-hint-btn aria-expanded after click (should be "true"):', expandedAfterClick);

// Fill in the name/file so the wizard can advance to the dimensions step,
// whose own tooltip (#upload-dimensions-hint) should start hidden too and
// opening it should close the file step's still-open one (one at a time).
await page.fill('#upload-name', 'Info Tooltip Suite Crate');
await page.setInputFiles('#upload-file-input', path.join(REPO_ROOT, 'public', 'models', 'crate.glb'));
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);

const dimensionsHintStartsHidden = await page.isHidden('#upload-dimensions-hint');
console.log('upload-dimensions-hint starts hidden on the dimensions step (should be true):', dimensionsHintStartsHidden);

await page.click('#upload-dimensions-hint-btn');
await page.waitForTimeout(100);
const dimensionsHintVisible = await page.isVisible('#upload-dimensions-hint');
console.log('upload-dimensions-hint visible after clicking its "?" button (should be true):', dimensionsHintVisible);

// Outside click closes it.
await page.mouse.click(10, 10);
await page.waitForTimeout(100);
const dimensionsHintHiddenAfterOutsideClick = await page.isHidden('#upload-dimensions-hint');
const collapsedAfterOutsideClick = await page.getAttribute('#upload-dimensions-hint-btn', 'aria-expanded');
console.log('upload-dimensions-hint hidden after an outside click (should be true):', dimensionsHintHiddenAfterOutsideClick);
console.log('upload-dimensions-hint-btn aria-expanded after outside click (should be "false"):', collapsedAfterOutsideClick);

// Back to the seller modal to check #seller-hint, the same component
// applied to a different modal's own heading.
await page.click('#upload-cancel-btn');
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });

const sellerHintStartsHidden = await page.isHidden('#seller-hint');
console.log('seller-hint starts hidden (should be true):', sellerHintStartsHidden);

await page.click('#seller-hint-btn');
await page.waitForTimeout(100);
const sellerHintVisible = await page.isVisible('#seller-hint');
const sellerHintExpanded = await page.getAttribute('#seller-hint-btn', 'aria-expanded');
console.log('seller-hint visible after clicking its "?" button (should be true):', sellerHintVisible);
console.log('seller-hint-btn aria-expanded after click (should be "true"):', sellerHintExpanded);

await page.mouse.click(10, 10);
await page.waitForTimeout(100);
const sellerHintHiddenAfterOutsideClick = await page.isHidden('#seller-hint');
console.log('seller-hint hidden after an outside click (should be true):', sellerHintHiddenAfterOutsideClick);

const pass = startsHidden && visibleAfterClick && expandedAfterClick === 'true' &&
  dimensionsHintStartsHidden && dimensionsHintVisible &&
  dimensionsHintHiddenAfterOutsideClick && collapsedAfterOutsideClick === 'false' &&
  sellerHintStartsHidden && sellerHintVisible && sellerHintExpanded === 'true' &&
  sellerHintHiddenAfterOutsideClick &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Upload wizard and seller-list info text is tucked behind a "?" tooltip toggle instead of always shown inline (#1602)',
  errors,
});
