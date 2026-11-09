// #3303 (owner decision: any text a user can read, they can copy; an error or
// refusal gets a Copy control): a modal error line gets a Copy button while it
// shows an error, the button puts that exact text on the clipboard, and it goes
// away when the line clears. Uses the log-in modal's own error line
// (#auth-status) at phone width, since a logged-out visit opens it on load.
import { launchPage, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ viewport: { width: 420, height: 860 } });
await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await page.waitForSelector('#auth-modal.visible', { timeout: 15000 });
const copyBtn = page.locator('#auth-status + .copy-error-btn');
check(await copyBtn.count() === 1, 'a Copy button follows #auth-status');
check(await copyBtn.isHidden(), 'the Copy button is hidden while the line is empty');

await page.click('.auth-tab-btn[data-auth-view="login"]');
await page.fill('#auth-login-email', 'nobody-copyable@example.test');
await page.fill('#auth-login-password', 'definitely-wrong-password');
await page.click('#auth-login-form button[type="submit"]');
await page.waitForSelector('#auth-status.error', { timeout: 30000 });
await page.waitForFunction(() => document.getElementById('auth-status').textContent.trim().length > 0);
await copyBtn.waitFor({ state: 'visible', timeout: 5000 });
const shown = (await page.textContent('#auth-status')).trim();
console.log('error shown:', shown);
check(shown.length > 0, 'the login failure shows an error');

const style = await page.evaluate(() => {
  const s = getComputedStyle(document.getElementById('auth-status'));
  return { pointerEvents: s.pointerEvents, userSelect: s.userSelect };
});
check(style.pointerEvents !== 'none' && style.userSelect !== 'none', `error text is selectable ${JSON.stringify(style)}`);

await copyBtn.click();
await page.waitForTimeout(300);
const copied = await page.evaluate(() => navigator.clipboard.readText());
check(copied === shown, `Copy puts the error text on the clipboard: "${copied}" vs "${shown}"`);
check((await copyBtn.textContent()) === 'Copied!', 'the button confirms with "Copied!"');

await page.evaluate(() => {
  const el = document.getElementById('auth-status');
  el.textContent = '';
  el.classList.remove('error');
});
await page.waitForTimeout(200);
check(await copyBtn.isHidden(), 'the Copy button goes away when the line clears');

await finish(browser, { pass: pass && errors.filter((e) => !/Failed to load resource|401/.test(e)).length === 0, label: 'copyable-error-lines', errors });
