// #2250: "Restore to Editor" constructs its own version name by wrapping
// the restored version's own name in `Restored from "..."` (src/main.js) --
// a chain of real restores grows this past the server's own 100-char
// MAX_LABEL_LENGTH cap (worker/index.js), and the restore then fails
// outright with a 400 that has nothing to do with the instances being
// restored. Rather than drive 6+ slow real restores (each triggers a full
// page reload) to reach that length organically, this seeds one version
// with an already-near-the-cap name directly via POST /landlets/:id/versions
// (itself capped at 100 server-side, so this is a realistic value a real
// chain of restores would actually produce) and does a single real
// "Restore to Editor" click on it.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Restore Version Name Cap Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(path, options) {
  return page.evaluate(async ([p, o]) => (await fetch(p, o)).json(), [path, options]);
}

const { landlets } = await fetchJson('/api/landlets?limit=100');
const myLandlet = landlets.find((l) => l.ownerBuilderId);
console.log('claimed landlet found via the API (should be true):', !!myLandlet);

// 95 chars -- close to the 100-char cap, the same way a handful of real
// chained restores would organically produce, without needing to drive
// them one by one.
const nearCapName = `Restored from "${'x'.repeat(78)}"`;
console.log('seeded version name length (should be 94):', nearCapName.length);
const seeded = await fetchJson(`/api/landlets/${encodeURIComponent(myLandlet.landletId)}/versions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: nearCapName }),
});
console.log('seeded version name matches what was sent (should be true):', seeded.version?.name === nearCapName);

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForFunction(() => document.querySelectorAll('.version-row').length >= 1, null, { timeout: 20000 });

const seededRow = page.locator('.version-row').filter({ hasText: nearCapName.slice(0, 40) });
await seededRow.locator('button', { hasText: 'Restore to Editor' }).click();
await page.waitForLoadState('networkidle', { timeout: 15000 });
await page.waitForTimeout(1500);

// A successful restore reloads the page (location.reload() in the click
// handler) -- if it instead failed with the 400 this issue describes, the
// page stays put and #build-publish-status shows the error, but that
// element no longer exists post-reload for a successful one, so the real
// signal is simply that a new version actually got created.
await page.waitForSelector('#account-menu-toggle', { timeout: 10000 });
await page.waitForTimeout(1000);

const { versions } = await fetchJson(`/api/landlets/${encodeURIComponent(myLandlet.landletId)}/versions?limit=20`);
console.log('a new version was created by the restore (should be >= 2):', versions.length);
const restoredVersion = versions[0];
console.log('restored version name length (should be <= 100):', restoredVersion?.name?.length);
console.log('restored version name:', restoredVersion?.name);

const pass = !!myLandlet &&
  seeded.version?.name === nearCapName &&
  versions.length >= 2 &&
  typeof restoredVersion?.name === 'string' &&
  restoredVersion.name.length <= 100 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Restore to Editor truncates a near-cap-length version name instead of failing with a 400 (#2250)',
  errors,
});
