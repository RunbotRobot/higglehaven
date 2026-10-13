// #1826 (sub-issue of #1817): the Admin Dashboard's Test/Ops Fixtures panel
// (public/admin-dashboard.html) gets real forms over the two existing
// admin-gated grant endpoints (POST .../land-cap-grants, .../higgles-grants
// -- already exercised directly by e2e/helpers.mjs's own
// grantLandCapHeadroomAsAdmin/grantHigglesAsAdmin for other suites' setup
// needs). This confirms the *UI* actually calls those real endpoints and
// reports their real result, rather than just rendering a static success
// message -- by cross-checking the panel's own displayed result against an
// independent GET /api/builders/me read of the same builder afterward.
import { launchPage, chooseIdentity, ensureAdminSession, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const LABEL = 'Fixtures Grant Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });

async function fetchJson(targetPage, path, options) {
  return targetPage.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

const before = (await fetchJson(page, '/api/builders/me')).body.builder;

const adminCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, adminToken] = adminCookie.split('=');

const adminPage = await browser.newPage();
adminPage.on('pageerror', (err) => errors.push(err.message));
adminPage.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await adminPage.context().addCookies([{ name: 'hh_session', value: adminToken, url: BASE_URL }]);
await adminPage.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await adminPage.click('button[data-panel="fixtures"]');

// --- Land cap grant ---
await adminPage.fill('input[name="landCapBuilderId"]', before.builderId);
await adminPage.fill('input[name="landCapAmountDollars"]', '12.34'); // amountCents=1234
await adminPage.click('.grant-form[data-grant="land-cap-grants"] button[type="submit"]');
await adminPage.waitForSelector('.grant-result[data-result="land-cap-grants"].success');
const landCapResultText = await adminPage.textContent('.grant-result[data-result="land-cap-grants"]');
console.log('land-cap-grant UI result text:', landCapResultText);

const afterLandCapGrant = (await fetchJson(page, '/api/builders/me')).body.builder;
console.log('land cap before/after:', before.landCapM2, afterLandCapGrant.landCapM2);
const landCapIncreased = afterLandCapGrant.landCapM2 > before.landCapM2;
const landCapResultMatchesRealRead = landCapResultText.includes(String(afterLandCapGrant.landCapM2));

// --- Higgles balance grant ---
await adminPage.fill('input[name="higglesBuilderId"]', before.builderId);
await adminPage.fill('input[name="higglesAmountDollars"]', '50.00'); // amountCents=5000
await adminPage.click('.grant-form[data-grant="higgles-grants"] button[type="submit"]');
await adminPage.waitForSelector('.grant-result[data-result="higgles-grants"].success');
const higglesResultText = await adminPage.textContent('.grant-result[data-result="higgles-grants"]');
console.log('higgles-grant UI result text:', higglesResultText);

const afterHigglesGrant = (await fetchJson(page, '/api/builders/me')).body.builder;
const expectedHigglesBalanceCents = before.higglesBalanceCents + 5000;
console.log('higgles balance expected/actual:', expectedHigglesBalanceCents, afterHigglesGrant.higglesBalanceCents);
const higglesBalanceCorrect = afterHigglesGrant.higglesBalanceCents === expectedHigglesBalanceCents;

// --- Error path: a nonexistent builder id surfaces a real error, not a false "success" ---
await adminPage.fill('input[name="landCapBuilderId"]', 'nonexistent-builder-id-e2e');
await adminPage.fill('input[name="landCapAmountDollars"]', '1.00');
await adminPage.click('.grant-form[data-grant="land-cap-grants"] button[type="submit"]');
await adminPage.waitForSelector('.grant-result[data-result="land-cap-grants"].error');
const errorResultText = await adminPage.textContent('.grant-result[data-result="land-cap-grants"]');
console.log('nonexistent-builder error result text:', errorResultText);

await adminPage.close();

// The deliberate 404 above (triggering the error path on purpose) makes
// Chromium log a "Failed to load resource: 404" console error independent
// of this page's own handling -- the same established, expected side
// effect e2e/control-room-admin-page.test.mjs and others already filter.
errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('Failed to load resource')));

const pass =
  landCapIncreased &&
  landCapResultMatchesRealRead &&
  higglesBalanceCorrect &&
  errorResultText.toLowerCase().includes('not found') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1826: Admin Dashboard Test/Ops Fixtures panel grants land cap/higgles balance through the real endpoints',
  errors,
});
