// Land cap (docs/SPEC.md §3, docs/API.md's "Land cap") — the growth-gating
// mechanic, distinct from land ACQUISITION (auctions, §5). This covers only
// the Settings > Build tab's own display of a builder's current cap and
// owned area, through the real UI. The formula/ratchet/per-event ledger,
// and the actual enforcement against vertical construction and auction
// bidding (#489), are covered instead by worker/land.test.js's own "Land
// cap" and "Landlet levels" describe blocks.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, waitForText, finish } from './helpers.mjs';

const LABEL = 'Land Cap Suite Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await openAccountMenu(page);
// Owner feedback: "Builders should see their lánd cap in the menu
// somewhere" — shown in the My lándlets leaf (#4202), read when it opens.
// #4202: the cap is a meter inside the My lándlets leaf (it was a loose line under the menu): two figures, a bar that
// is full for a builder at the cap, and what raises it.
await page.click('#my-lands-btn');
await page.waitForSelector('#my-lands-modal.visible', { timeout: 5000 });
const menuLandCapText = await waitForText(page, '#my-lands-cap-words', 'You hold');
const meterNow = await page.getAttribute('#my-lands-cap-meter', 'aria-valuenow');
const meterMax = await page.getAttribute('#my-lands-cap-meter', 'aria-valuemax');
const fillWidth = await page.evaluate(() => document.getElementById('my-lands-cap-fill').style.width);
const capNote = await page.textContent('#my-lands-cap-note');
console.log('My lándlets cap meter (should read "You hold 1,000m² of the 1,000m² you may hold."):', menuLandCapText, `| ${meterNow}/${meterMax} fill ${fillWidth} | note: ${capNote}`);
const looseLineGone = (await page.locator('#account-menu-landcap').count()) === 0;
console.log('the loose line under the menu is gone (should be true):', looseLineGone);
await page.click('#my-lands-close-btn');
await page.waitForSelector('#my-lands-modal:not(.visible)', { state: 'attached', timeout: 5000 });
await openAccountMenu(page);

// #613: same "refresh on open" wiring, right next to the land cap line —
// a fresh builder has earned nothing yet, so this stays hidden rather than
// showing a 0%-of-threshold notice nobody needs to see.
const taxNoticeHidden = await page.locator('#account-menu-tax-notice').isHidden();
console.log('Tax notice hidden for a fresh builder with no earnings (should be true):', taxNoticeHidden);

await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');

// The field starts as a "Loading…" placeholder, filled in by an async
// fetch — poll for the resolved text instead of guessing a fixed delay,
// which is exactly the class of flake fixed elsewhere in this suite
// earlier this session (see e2e/helpers.mjs's waitForText) and which this
// file's own fixed waitForTimeout(800) turned out to share.
// formatArea (src/settings.js) rounds to the nearest whole unit and
// comma-groups thousands by default (owner feedback) — a 1000m² cap
// reads as "1,000m²".
// #land-cap-field, not the generic first '.settings-field' match — #724
// added a Username field ahead of Land Cap in the Build tab.
const landCapFieldText = await waitForText(page, '#land-cap-field', 'You own 1,000m²');
const landCapFieldLabel = await page.locator('#land-cap-field').locator('span').textContent();
console.log('Land Cap field label (should be "Lándlet cap"):', landCapFieldLabel);
console.log('Land Cap field full text (should mention "1,000m²" twice — owned and cap):', landCapFieldText);

const pass = menuLandCapText === 'You hold 1,000m² of the 1,000m² you may hold.' && meterNow === meterMax && fillWidth === '100%' && /earn higgles/.test(capNote) && looseLineGone &&
  taxNoticeHidden &&
  landCapFieldLabel.trim() === 'Lándlet cap' &&
  landCapFieldText.includes('You own 1,000m²') &&
  landCapFieldText.includes('your 1,000m² cap') &&
  errors.length === 0;
await finish(browser, { pass, label: 'Land cap: Settings > Build tab + account menu display', errors });
