// #4577: a session that ended while the page was open answered every call with "Not authenticated", which each leaf
// showed word for word with no way back in. Now the leaf says the session ended, and the sign-in form opens with that
// sentence; signing back in closes it and the page is where it was (the same leaf open), so the person just tries again.
// The 401 is forced with page.route (the real worker answers the same body), then lifted before signing in.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, emailForLabel, finish } from './helpers.mjs';

const LABEL = 'Session Ended Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

const handler = (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Not authenticated' }) });
await page.route('**/api/notifications?*', handler);

await openAccountMenu(page);
await page.click('#notifications-btn');
await page.waitForSelector('#notifications-modal.visible', { timeout: 5000 });
await page.waitForSelector('#auth-modal.visible', { timeout: 10000 });
const status = (await page.locator('#auth-status').textContent())?.trim();
const leafText = (await page.locator('#notifications-modal').innerText()).trim();
console.log('sign-in form status (should say the session ended):', status);
console.log('the Notices leaf text (should say the same, not "Not authenticated"):', leafText);
const formOpenedOnce = (await page.locator('#auth-modal.visible').count()) === 1;

// Back in: lift the 401, sign in with the same account; the form closes and Notices is still open.
await page.unroute('**/api/notifications?*', handler);
await page.fill('#auth-login-email', emailForLabel(LABEL));
await page.fill('#auth-login-password', 'e2e-test-password-123');
await page.click('#auth-login-form button[type="submit"]');
await page.waitForSelector('#auth-modal.visible', { state: 'hidden', timeout: 10000 });
const noticesStillOpen = (await page.locator('#notifications-modal.visible').count()) === 1;
console.log('Notices still open after signing back in (should be true):', noticesStillOpen);

const pass = formOpenedOnce
  && /session ended/i.test(status ?? '')
  && /session ended/i.test(leafText)
  && !/Not authenticated/.test(leafText)
  && noticesStillOpen
  && errors.filter((message) => !/401/.test(String(message))).length === 0;
await finish(browser, { pass, label: '#4577: an ended session says so, opens sign-in, and signing back in leaves the page where it was', errors });
