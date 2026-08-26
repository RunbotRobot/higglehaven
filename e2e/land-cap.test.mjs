// Land cap (docs/SPEC.md §3, docs/API.md's "Land cap") — the growth-gating
// mechanic, distinct from land ACQUISITION (auctions, §5). This covers only
// the Settings > Build tab's own display of a builder's current cap and
// owned area, through the real UI. The formula/ratchet/per-event ledger
// themselves are covered by worker/index.test.js's own "Land cap" describe
// block, which documents in detail why this is deliberately tracking-only
// (displayed, not enforced against auction bids) for now.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Land Cap Suite Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForTimeout(800);

const landCapFieldLabel = await page.locator('#settings-section .settings-field').first().locator('span').textContent();
const landCapFieldText = await page.locator('#settings-section .settings-field').first().textContent();
console.log('Land Cap field label (should be "Land Cap"):', landCapFieldLabel);
console.log('Land Cap field full text (should mention "1,000 m²" twice — owned and cap):', landCapFieldText);

const pass = landCapFieldLabel.trim() === 'Land Cap' &&
  landCapFieldText.includes('You own 1,000 m²') &&
  landCapFieldText.includes('your 1,000 m² cap') &&
  errors.length === 0;
await finish(browser, { pass, label: 'Land cap: Settings > Build tab display', errors });
