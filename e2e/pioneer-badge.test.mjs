// Founding/pioneer recognition (docs/SPEC.md §3, migrations/0043) — the
// very first builder to successfully claim a landlet in this world earns a
// permanent "Pioneer" badge, shown next to their name in the identity
// roster (see renderIdentityList in src/main.js — this app has no separate
// profile page, so the roster row is the closest fit). A fresh D1 has
// nobody claimed yet, so the very first claim in this test deterministically
// becomes the pioneer.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Pioneer Suite Tester';
const SECOND_LABEL = 'Second Claimer';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

// Reopen the identity roster (doesn't switch the active identity, just
// re-renders the list — see #identity-btn's own doc comment in main.js)
// and confirm this builder's row shows the badge.
await page.click('#identity-btn');
await page.waitForSelector('#identity-modal.visible', { timeout: 10000 });
await page.waitForTimeout(500);
const firstRow = page.locator('.identity-row').filter({ hasText: LABEL });
const firstRowText = await firstRow.first().textContent();
console.log('first claimer\'s row (should include "Pioneer"):', firstRowText);
await page.click('#identity-close-btn');
await page.waitForTimeout(300);

// A second builder, given a second landlet directly over the API (fast,
// and this test only cares about the badge logic, not the claim-map UI
// which the first claimLandlet() call above already exercises), should
// NOT also become pioneer.
const secondBuilderId = await page.evaluate(async (label) => {
  const res = await fetch('/api/builders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  return (await res.json()).builder.builderId;
}, SECOND_LABEL);
await page.evaluate(async () => {
  await fetch('/api/landlets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ landletId: 'second-claimer-landlet', name: 'Second', areaM2: 1000, status: 'greenbelt' }),
  });
});
await page.evaluate(async (builderId) => {
  await fetch('/api/landlets/second-claimer-landlet/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ builderId }),
  });
}, secondBuilderId);

const { builders } = await page.evaluate(async () => (await fetch('/api/builders')).json());
const secondBuilder = builders.find((b) => b.builderId === secondBuilderId);
console.log('second claimer isPioneer (should be false):', secondBuilder.isPioneer);
const pioneerCount = builders.filter((b) => b.isPioneer).length;
console.log('total builders with isPioneer (should be 1):', pioneerCount);

const pass = firstRowText.includes('Pioneer') &&
  secondBuilder.isPioneer === false &&
  pioneerCount === 1 &&
  errors.length === 0;
await finish(browser, { pass, label: 'Pioneer badge granted to the first landlet claimer only', errors });
