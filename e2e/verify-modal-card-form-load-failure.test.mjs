// #4478: the "Verify to continue" modal has no Escape, and when the card form could not load (the card step's
// set-up refused, or Stripe.js blocked) Continue was left disabled and the status showed the loader's own text:
// a dead end. Now the status says in fixed words that nothing was charged and offers the ID route, and Continue
// reads "Try again" and loads the step again.
import { launchPage, finish } from './helpers.mjs';

const LABEL = `Card Form Load Failure ${Date.now()}`;
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await page.waitForSelector('#auth-modal.visible', { timeout: 8000 });

// A real-looking set-up (not simulated) whose Stripe.js cannot be loaded.
await page.route('**/api/auth/card-setup-intent', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ simulated: false, publishableKey: 'pk_test_e2e', clientSecret: 'seti_e2e_secret' }),
}));
await page.route('https://js.stripe.com/**', (route) => route.abort());

await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-username', LABEL.replace(/\s+/g, ''));
await page.fill('#auth-signup-email', `card-form-fail-${Date.now()}@e2e.test`);
await page.fill('#auth-signup-password', 'e2e-test-password-123');
await page.check('#auth-signup-age-attest');
await page.click('#auth-signup-form button[type="submit"]');
await page.waitForSelector('#verify-modal.visible', { timeout: 20000 });
if (await page.locator('#verify-age-step').isVisible()) {
  await page.check('#verify-age-attest');
  await page.click('#verify-continue-btn');
}

await page.waitForFunction(() => /couldn't load/.test(document.getElementById('verify-status').textContent), null, { timeout: 20000 });
const failed = await page.evaluate(() => ({
  status: document.getElementById('verify-status').textContent,
  isError: document.getElementById('verify-status').classList.contains('error'),
  continueText: document.getElementById('verify-continue-btn').textContent,
  continueDisabled: document.getElementById('verify-continue-btn').disabled,
  idVisible: !!document.getElementById('verify-id-instead-btn').offsetParent,
}));
console.log('after a card form that cannot load:', JSON.stringify(failed));
const sayssNotCharged = /not charged/i.test(failed.status) && /ID instead/i.test(failed.status) && !/stripe/i.test(failed.status);

// The service comes back: Try again loads the step.
await page.unroute('https://js.stripe.com/**');
await page.unroute('**/api/auth/card-setup-intent');
await page.click('#verify-continue-btn');
await page.waitForFunction(() => document.getElementById('verify-continue-btn').textContent === 'Verify (dev mode)', null, { timeout: 15000 });
const recovered = await page.evaluate(() => ({
  status: document.getElementById('verify-status').textContent,
  disabled: document.getElementById('verify-continue-btn').disabled,
}));
console.log('after Try again once the form loads:', JSON.stringify(recovered));

const pass = sayssNotCharged && failed.isError && failed.continueText === 'Try again' && !failed.continueDisabled && failed.idVisible
  && recovered.status === '' && !recovered.disabled;
await finish(browser, {
  pass, label: '#4478: a card form that cannot load says nothing was charged, offers the ID route and a working Try again',
  errors: errors.filter((e) => !/Failed to load resource|ERR_FAILED|stripe/i.test(e)),
});
