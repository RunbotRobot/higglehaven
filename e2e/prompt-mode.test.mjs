// #329/#330: the Add Item catalog picker's "Prompt mode" tab — switching
// tabs swaps which panel shows, and an empty prompt is rejected client-side
// without ever calling the server. A real submission (which would surface
// the concept-image endpoint's "not configured" 503, since OPENAI_API_KEY
// is never set here) is deliberately NOT exercised — a real rejected fetch
// logs a "Failed to load resource" console error regardless of whether the
// app handled it gracefully, tripping this suite's own errors.length === 0
// check, the same reasoning auth.test.mjs/digital-goods.test.mjs document
// for avoiding their own real-rejection paths in e2e.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Prompt Mode Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });

// Manual mode is the default.
const manualVisibleInitially = await page.locator('#catalog-manual-mode').isVisible();
const promptHiddenInitially = await page.locator('#catalog-prompt-mode').isHidden();
console.log('manual mode visible by default (should be true):', manualVisibleInitially);
console.log('prompt mode hidden by default (should be true):', promptHiddenInitially);

// Switching tabs swaps which panel shows.
await page.click('.catalog-mode-tab-btn[data-catalog-mode="prompt"]');
await page.waitForTimeout(150);
const manualHiddenAfterSwitch = await page.locator('#catalog-manual-mode').isHidden();
const promptVisibleAfterSwitch = await page.locator('#catalog-prompt-mode').isVisible();
const promptTabActive = await page.locator('.catalog-mode-tab-btn[data-catalog-mode="prompt"]').evaluate((el) => el.classList.contains('active'));
console.log('manual mode hidden after switching to Prompt (should be true):', manualHiddenAfterSwitch);
console.log('prompt mode visible after switching (should be true):', promptVisibleAfterSwitch);
console.log('prompt tab shows active (should be true):', promptTabActive);

// An empty prompt is rejected without ever reaching the server.
await page.click('#prompt-mode-generate-btn');
await page.waitForTimeout(150);
const emptyPromptStatus = await page.locator('#prompt-mode-status').textContent();
const generateBtnStillEnabled = await page.locator('#prompt-mode-generate-btn').isEnabled();
console.log('status after clicking Generate with no prompt (should ask for a description):', emptyPromptStatus);
console.log('Generate button still enabled after the client-side rejection (should be true):', generateBtnStillEnabled);

const pass = manualVisibleInitially && promptHiddenInitially &&
  manualHiddenAfterSwitch && promptVisibleAfterSwitch && promptTabActive &&
  emptyPromptStatus.toLowerCase().includes('describe') && generateBtnStillEnabled &&
  errors.length === 0;
await finish(browser, { pass, label: 'Add Item catalog picker Prompt mode tab', errors });
