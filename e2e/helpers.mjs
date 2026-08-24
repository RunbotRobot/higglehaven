// Shared flows for the e2e suite (see e2e/README.md). Extracted from the
// same handful of steps every test needs — launching a browser page against
// a running `wrangler dev`, picking/creating a builder or seller identity,
// and claiming a landlet — so individual test files read as "what's
// actually being verified" rather than repeating this boilerplate each time.
import { chromium } from 'playwright';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8787';

// Launches a fresh browser + page against the running dev server, with
// console/page errors collected (callers should assert `errors.length === 0`
// at the end) and window.prompt() dialogs (used throughout for naming a new
// builder/seller identity — there's no real text-input modal for it) always
// answered with `promptAnswer`.
export async function launchPage({ promptAnswer = 'E2E Tester', viewport = { width: 420, height: 860 } } = {}) {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt') await dialog.accept(promptAnswer);
    else await dialog.accept();
  });
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  return { browser, page, errors };
}

// Drives the identity picker for either the Build or Sell nav tab. With
// `isNew` (the default) it creates a fresh identity via #identity-new-btn,
// answered by launchPage's own dialog handler; pass `isNew: false` to
// instead pick an identity that already exists in the roster (e.g.
// re-entering Build mode as the same builder after a reload). Leaves the
// picker having just clicked that row's Build/Sell button — callers that
// need the claim modal (mode: 'build', a brand-new builder) should follow
// with claimLandlet().
export async function chooseIdentity(page, { mode, label, isNew = true }) {
  await page.click(`.mode-nav-btn[data-mode="${mode}"]`);
  await page.waitForSelector('#identity-modal.visible', { timeout: 10000 });
  if (isNew) {
    await page.click('#identity-new-btn');
    await page.waitForTimeout(500);
  }
  const row = page.locator('.identity-row').filter({ hasText: label });
  // .last() disambiguates a roster that already has an earlier identity
  // whose id string happens to contain this run's label as a substring
  // (Playwright's hasText match is substring-based) — the just-created or
  // most-recently-listed row is always what a test actually wants.
  await row.locator('.identity-row-toggle').last().click();
  await page.waitForTimeout(300);
  const chooseLabel = mode === 'build' ? 'Build' : 'Sell';
  await row.locator('button', { hasText: chooseLabel }).last().click();
}

// Claims whatever landlet the claim-modal's overhead map offers first —
// grows the world if it hasn't yet, tries a handful of candidate points
// until one reads "Available," and confirms. Leaves the page on the
// claimed landlet's own Build view (#identity-btn visible).
export async function claimLandlet(page) {
  await page.waitForSelector('#claim-modal.visible', { timeout: 10000 });
  await page.waitForTimeout(2000);
  const status = await page.textContent('#claim-status');
  if (status?.includes("hasn't grown")) {
    await page.click('#claim-grow-btn');
    await page.waitForTimeout(3000);
  }
  const canvasBox = await page.locator('#claim-map-canvas').boundingBox();
  const candidatePoints = [[0.5, 0.5], [0.4, 0.4], [0.4, 0.3], [0.5, 0.3], [0.2, 0.4], [0.1, 0.4]];
  for (const [fx, fy] of candidatePoints) {
    await page.mouse.click(canvasBox.x + canvasBox.width * fx, canvasBox.y + canvasBox.height * fy);
    await page.waitForTimeout(250);
    const selection = await page.textContent('#claim-selection-name');
    if (selection && selection.includes('Available')) break;
  }
  await page.click('#claim-confirm-btn');
  await page.waitForTimeout(2500);
  await page.waitForSelector('#identity-btn', { timeout: 10000 });
}

// Clicks down a vertical strip of screen points around (x, yStart..yEnd)
// until #product-info's text includes `expectedText`, returning whatever
// text was showing when it stopped (a match, or the last attempt's text if
// none matched). A placed item's own clickable footprint can be
// meaningfully smaller once it's no longer wearing the selection
// gizmo/highlight that made a wider area hit it right after placing it —
// most visibly right after a reload, when nothing starts selected — so
// retrying the exact same point that worked once can miss forever; a small
// scan is more robust than a single fixed pixel.
export async function clickUntilSelected(page, { x, yStart, yEnd, yStep = 10, expectedText, waitAfterClick = 400 }) {
  let info = '';
  for (let y = yStart; y <= yEnd; y += yStep) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(waitAfterClick);
    info = (await page.textContent('#product-info')) || '';
    if (info.includes(expectedText)) return info;
  }
  return info;
}

// Standard end-of-test report + exit, matched by run-all.mjs (which reads
// the child process's exit code) and by running a single file directly with
// `node e2e/whatever.test.mjs`.
export async function finish(browser, { pass, label, errors = [] }) {
  console.log('page errors:', errors.length ? errors : 'none');
  console.log(pass ? `PASS: ${label}` : `FAIL: ${label}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
}
