// Regression test for #1124: Delete Account in Settings > Build only
// patched its own identity field's nameRow/status, leaving Land
// Cap/Redeem Higgles/Active Auctions showing the just-deleted builder's
// stale figures until a tab switch or modal reopen. Fixed by having the
// delete handler trigger a full renderSettingsSection() redraw (the same
// thing switching tabs already does) instead of patching only its own
// field.
//
// Verified here via the Redeem Higgles field's own "Available to
// redeem: $X.XX" text -- grants a real higgles balance to the original
// builder, confirms it's visible before delete, then confirms it's gone
// (replaced by the fresh builder's $0.00) immediately after delete, with
// no tab switch or modal reopen in between -- exactly the gap #1124
// describes.
import {
  launchPage, chooseIdentity, claimLandlet, openAccountMenu, grantHigglesAsAdmin, waitForText, finish,
} from './helpers.mjs';

const LABEL = 'Settings Stale After Delete Tester';
const GRANTED_CENTS = 5000; // $50.00

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

const builderId = await page.evaluate(() =>
  fetch('/api/builders/me').then((r) => r.json()).then((d) => d.builder.builderId));
await grantHigglesAsAdmin(builderId, GRANTED_CENTS);

await openAccountMenu(page);
await page.click('#settings-btn');
// Widened from 5000/8000ms -- this run observed CI-only intermittent
// failures (settings-stale-after-delete.test.mjs failing twice in a
// shard, then failing again -- alongside a *different* file that time
// -- on a manual re-run) with a clean 2/2 local pass of the exact same
// files on the exact same commit, matching this fleet's established
// #978-class pattern of CI-runner-load timing margin rather than a real
// bug (see e2e/helpers.mjs's own 60000ms account-menu-modal wait, and
// the #2135/#2136/#2157 precedent of widening tight timeouts for the
// same symptom).
await page.waitForSelector('#settings-modal.visible', { timeout: 15000 });

const beforeText = await waitForText(page, '#settings-section', 'Available to redeem: $50.00', { timeout: 20000 });
console.log('Redeem Higgles text before delete (should show the granted $50.00):', beforeText.includes('$50.00'));

// --- Reset Profile (launchPage's own dialog handler auto-accepts confirm()) ---
// #1149 renamed this button from "Delete Account" (never true -- it only
// ever reset this profile, not the login) to "Reset Profile"; the
// underlying deleteBuilder behavior this test exercises is unchanged.
await page.click('#settings-section button:has-text("Reset Profile")');
await waitForText(page, '#settings-section', 'Reset', { timeout: 20000 });

// No tab switch, no modal reopen -- straight read of whatever's on screen
// right now, which is exactly what #1124's bug left stale. Widened from
// 500ms for the same CI-load margin as above.
await page.waitForTimeout(1500);
const afterText = await page.textContent('#settings-section');
const afterShowsFreshZero = afterText.includes('Available to redeem: $0.00');
const afterStillShowsStaleBalance = afterText.includes('$50.00');
console.log('Redeem Higgles shows the fresh $0.00 right after delete, same tab, no reopen (should be true):', afterShowsFreshZero);
console.log('Stale $50.00 still visible anywhere in the section (should be false):', afterStillShowsStaleBalance);

const pass = beforeText.includes('$50.00') &&
  afterShowsFreshZero &&
  !afterStillShowsStaleBalance &&
  errors.length === 0;
await finish(browser, { pass, label: 'Settings > Build fields refresh after Reset Profile, not just the identity field (#1124)', errors });
