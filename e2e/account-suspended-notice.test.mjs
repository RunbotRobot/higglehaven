// #3359: a suspended person is told why in a persistent in-app notice, not a
// native alert() (which a browser that suppresses dialogs drops silently).
// Suspends the account through the admin API, reloads, and checks that the
// notice appears with the reason, that no native dialog opened, and that it
// stays until closed.
import { launchPage, chooseIdentity, ensureAdminSession, emailForLabel, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const LABEL = 'Suspended Notice Tester';
const REASON = 'e2e 3359 suspended notice coverage';

const adminCookie = await ensureAdminSession();
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

let nativeDialogs = 0;
page.on('dialog', () => { nativeDialogs += 1; });

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });

const suspend = await fetch(`${BASE_URL}/api/auth/suspend-account`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: adminCookie },
  body: JSON.stringify({ email: emailForLabel(LABEL), reason: REASON }),
});
if (suspend.status !== 200) throw new Error(`suspend-account failed (${suspend.status})`);

await page.reload();
await page.waitForSelector('#notice-modal.visible', { timeout: 30000 });
const text = await page.locator('#notice-modal-message').textContent();
const title = await page.locator('#notice-modal-title').textContent();
const showsReason = text.includes(REASON);
console.log('notice title (should say suspended):', title);
console.log('notice shows the reason (should be true):', showsReason);

await page.waitForTimeout(9000);
const stillShown = await page.locator('#notice-modal').evaluate((el) => el.classList.contains('visible'));
console.log('notice still shown after 9 s (should be true):', stillShown);

await page.click('#notice-modal-ok-btn');
await page.waitForTimeout(300);
const closed = await page.locator('#notice-modal').evaluate((el) => !el.classList.contains('visible'));
console.log('notice closes on OK (should be true):', closed);
console.log('native dialogs opened (should be 0):', nativeDialogs);

// A suspended account's other authenticated requests are refused with 403;
// that is the point of the test, so those console lines are not failures.
const unexpectedErrors = errors.filter((e) => !String(e).includes('403 (Forbidden)'));
const pass = /suspended/i.test(title) && showsReason && stillShown && closed && nativeDialogs === 0 && unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'Suspended account notice is an in-app modal', errors: unexpectedErrors });
