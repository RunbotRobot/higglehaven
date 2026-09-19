// #723: #624/#625 shipped GET/POST /api/builders/me/stripe-account and
// .../redeem — a builder's own exit from higgles to real cash — but
// nothing in src/main.js ever called either. This test exercises the real
// "Redeem Higgles" field (Settings > Build, alongside Land Cap) end to
// end: the available balance reflects the account's real higgles_balance_
// cents (granted via the same admin-only escape hatch grantHigglesAsAdmin
// already uses elsewhere), the account-status note reflects Stripe not
// being configured on this dev server (no STRIPE_SECRET_KEY in .dev.vars,
// same as every other Stripe-touching suite in this repo — see docs/
// API.md's own testing-limitation note), and clicking Redeem surfaces
// #653's real, current pause message.
//
// Not covered here (same limitation this repo's other Stripe-adjacent
// tests already document): actually submitting the onboarding form and a
// real transfers/payouts round trip, since neither is reachable without a
// real STRIPE_SECRET_KEY. #653's pause 503 fires before the "Stripe not
// configured" 503 in handleBuilderRedeem's own validation order, so the
// Redeem button's behavior is fully deterministic and testable regardless.
import { launchPage, chooseIdentity, claimLandlet, grantHigglesAsAdmin, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Higgles Cashout Suite Tester';
const GRANT_CENTS = 4200;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
await grantHigglesAsAdmin(builder.builderId, GRANT_CENTS);

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');

// The "Redeem Higgles" label/balance and the actual form + Redeem button
// live in separate sibling .settings-field divs (same multi-field split
// renderSellSettingsSection's own Payout Account/Payouts sections already
// use), so the button is found by its own exact text page-wide rather
// than scoped under the label's field.
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('Redeem Higgles') && f.textContent.includes('Available to redeem')),
  { timeout: 10000 },
);

const statusText = await page.locator('.settings-field', { hasText: 'Redeem Higgles' }).locator('.settings-empty-note').first().textContent();
console.log('Redeem Higgles status note (should show the granted balance and that Stripe isn\'t configured here):', statusText);

const redeemBtn = page.getByRole('button', { name: 'Redeem', exact: true });
const redeemBtnVisible = await redeemBtn.isVisible();
console.log('Redeem button visible (should be true, since the granted balance is > 0):', redeemBtnVisible);

// The button's own parent .settings-field also holds the status note that
// its click handler updates.
const redeemFormField = page.locator('.settings-field').filter({ has: redeemBtn });
await redeemBtn.click();
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('temporarily paused')),
  { timeout: 10000 },
);
const afterClickText = await redeemFormField.locator('.settings-empty-note').last().textContent();
console.log('Status after clicking Redeem (should surface #653\'s real pause message):', afterClickText);

// The Redeem click above deliberately triggers a real 503 (#653's pause) —
// Chromium logs any non-2xx fetch response as "Failed to load resource"
// independent of whether the app handled it gracefully, the same reason
// e2e/didit-verification.test.mjs and e2e/saved-layout-paste.test.mjs
// already filter this out of their own errors.length === 0 check.
const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));

const pass = statusText.includes(`$${(GRANT_CENTS / 100).toFixed(2)}`) &&
  statusText.includes("Stripe payouts aren't set up on this server yet") &&
  redeemBtnVisible &&
  afterClickText.includes('temporarily paused while we close a fraud gap') &&
  unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'Settings > Build "Redeem Higgles" field shows real balance and surfaces #653\'s pause (#723)', errors });
