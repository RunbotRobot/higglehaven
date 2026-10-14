// #1987 (sub-issue of #1983): the "Download My Data" button in the Account
// panel, wired to GET /auth/export-data (#1984) via a Blob/createObjectURL
// download link -- covers what's genuinely UI-specific: the button is
// visible without needing to collapse behind a confirmation (read-only,
// unlike Change Password/Delete Account next to it), the real download
// fires with the right filename shape, and the downloaded JSON actually
// contains this account's own exported data.
import { readFileSync } from 'node:fs';
import {
  launchPage, finish, waitForText, clearVerifyModalIfShown,
} from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Export Data Suite' });
const email = `export-data-suite-${Date.now()}@example.com`;
const password = 'a fine long password';

async function openAuthModal(page) {
  if ((await page.locator('#auth-modal.visible').count()) > 0) return;
  await page.click('#account-menu-toggle');
  await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
  await page.click('#account-auth-btn');
  await page.waitForSelector('#auth-modal.visible', { timeout: 5000 });
}

// --- Sign up ---
await openAuthModal(page);
await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-username', 'Export Data Suite');
await page.fill('#auth-signup-email', email);
await page.fill('#auth-signup-password', password);
await page.check('#auth-signup-age-attest');
await page.click('#auth-signup-form button[type="submit"]');
await waitForText(page, '#account-auth-btn', 'Export Data Suite');
await clearVerifyModalIfShown(page);

// --- Open the account panel; unlike Change Password/Delete Account, this
// is an immediate read-only action with no collapsed confirmation form. ---
await openAuthModal(page);
const exportBtnVisible = await page.locator('#auth-export-data-btn').isVisible();
console.log('Download My Data button visible (should be true):', exportBtnVisible);

// --- Clicking it fires a real browser download ---
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#auth-export-data-btn'),
]);
const downloadStatus = await waitForText(page, '#auth-status', 'download', { timeout: 8000 });
console.log('Status after clicking (should mention the download):', downloadStatus);

const suggestedFilename = download.suggestedFilename();
console.log('Downloaded filename (should look like a dated export filename):', suggestedFilename);

const downloadPath = await download.path();
const contents = JSON.parse(readFileSync(downloadPath, 'utf8'));
console.log('Export JSON has exportedAt (should be truthy):', contents.exportedAt);
console.log("Export JSON profile.account.username (should match this account's own signup):", contents.profile?.account?.username);

const pass = exportBtnVisible &&
  /^higglehaven-data-export-\d{4}-\d{2}-\d{2}\.json$/.test(suggestedFilename) &&
  downloadStatus.toLowerCase().includes('download') &&
  Boolean(contents.exportedAt) &&
  contents.profile?.account?.username === 'Export Data Suite' &&
  errors.length === 0;
await finish(browser, { pass, label: 'Download My Data triggers a real export download (#1987)', errors });
