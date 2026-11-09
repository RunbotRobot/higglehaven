// #3303/#3348 (owner decision: any text a user can read, they can copy, by
// selecting it with the platform's own selection; no Copy control anywhere): a
// modal error line is real, hit-testable, selectable text. Uses the log-in
// modal's own error line (#auth-status) at phone width, since a logged-out
// visit opens it on load. A triple-click stands in for a long-press: it goes
// through the same hit test, so it only selects when nothing covers the text and
// pointer events and user-select allow it.
import { launchPage, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ viewport: { width: 390, height: 844 } });

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await page.waitForSelector('#auth-modal.visible', { timeout: 15000 });
await page.click('.auth-tab-btn[data-auth-view="login"]');
await page.fill('#auth-login-email', 'nobody-selectable@example.test');
await page.fill('#auth-login-password', 'definitely-wrong-password');
await page.click('#auth-login-form button[type="submit"]');
await page.waitForSelector('#auth-status.error', { timeout: 30000 });
await page.waitForFunction(() => document.getElementById('auth-status').textContent.trim().length > 0);
const shown = (await page.textContent('#auth-status')).trim();
console.log('error shown:', shown);
check(shown.length > 0, 'the login failure shows an error');

const style = await page.evaluate(() => {
  const s = getComputedStyle(document.getElementById('auth-status'));
  return { pointerEvents: s.pointerEvents, userSelect: s.userSelect, touchCallout: s.webkitTouchCallout, touchAction: s.touchAction };
});
check(style.pointerEvents !== 'none' && style.userSelect !== 'none', `error text is selectable ${JSON.stringify(style)}`);
check(style.touchCallout !== 'none' && style.touchAction !== 'none', `error text does not suppress long-press ${JSON.stringify(style)}`);

await page.locator('#auth-status').click({ clickCount: 3 });
const selected = await page.evaluate(() => String(window.getSelection()).trim());
check(selected.length > 0 && shown.includes(selected.slice(0, 10)), `triple-click selects the error text: "${selected}"`);

check((await page.locator('#auth-modal button', { hasText: /^Copy$/ }).count()) === 0, 'no Copy button exists in the modal');
check((await page.locator('.copy-error-btn').count()) === 0, 'no .copy-error-btn is added after the error line');

await finish(browser, { pass: pass && errors.filter((e) => !/Failed to load resource|401/.test(e)).length === 0, label: 'a modal error line is selectable and has no Copy button (#3348)', errors });
