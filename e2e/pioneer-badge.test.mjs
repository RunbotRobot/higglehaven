// Founding/pioneer recognition (docs/SPEC.md §3, migrations/0043 +
// 0044) — the first PIONEER_COHORT_SIZE (100, see worker/index.js)
// builders to successfully claim a landlet in this world each earn a
// permanent, ranked "Pioneer #N" badge, shown next to their name in the
// identity roster (see renderIdentityList in src/main.js — this app has
// no separate profile page, so the roster row is the closest fit). A
// fresh D1 has nobody ranked yet, so the first two claims in this test
// deterministically land ranks #1 and #2 — exercising the actual
// user-facing change from a single "first claimer only" pioneer to a
// whole ranked cohort. The cutoff itself (rank stops being granted past
// the cohort size) is covered by worker/index.test.js instead, where
// filling 100 rows directly via the D1 binding is cheap; doing that
// through 100 real browser-driven claims here would not be.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Pioneer Suite Tester';
const SECOND_LABEL = 'Second Claimer';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

// Reopen the identity roster (doesn't switch the active identity, just
// re-renders the list — see #identity-btn's own doc comment in main.js)
// and confirm this builder's row shows rank #1.
await openAccountMenu(page);
await page.click('#identity-btn');
await page.waitForSelector('#identity-modal.visible', { timeout: 10000 });
await page.waitForTimeout(500);
const firstRow = page.locator('.identity-row').filter({ hasText: LABEL });
const firstRowText = await firstRow.first().textContent();
console.log('first claimer\'s row (should include "Pioneer #1"):', firstRowText);
await page.click('#identity-close-btn');
await page.waitForTimeout(300);

// A second builder, given a second landlet directly over the API (fast,
// and this test only cares about the badge/rank logic, not the claim-map
// UI which the first claimLandlet() call above already exercises), should
// also become a pioneer — rank #2, not excluded — demonstrating the wider
// founding cohort rather than a single "first ever" winner.
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
const firstBuilder = builders.find((b) => b.label === LABEL);
const secondBuilder = builders.find((b) => b.builderId === secondBuilderId);
console.log('first claimer pioneerRank (should be 1):', firstBuilder.pioneerRank);
console.log('second claimer isPioneer (should be true) and pioneerRank (should be 2):', secondBuilder.isPioneer, secondBuilder.pioneerRank);

const pass = firstRowText.includes('Pioneer #1') &&
  firstBuilder.pioneerRank === 1 &&
  secondBuilder.isPioneer === true &&
  secondBuilder.pioneerRank === 2 &&
  errors.length === 0;
await finish(browser, { pass, label: 'Pioneer rank granted to a founding cohort, not just the first claimer', errors });
