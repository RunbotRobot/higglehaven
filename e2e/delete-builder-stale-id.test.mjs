// Regression test for #738: renderIdentityField's "Delete Account" handler
// (src/main.js) called deleteBuilder + fetchProfile to refresh the Settings
// panel's own local display, but never reset the module-level `builderId`
// variable the rest of the app reads. ensureBuilderIdentity()'s own
// `if (builderId) return builderId;` short-circuit then kept returning the
// dead, just-deleted id for the rest of the page's lifetime (until a full
// reload) — any code that reads `builderId` directly, like the Settings >
// Build > Auction section's own landlet-ownership lookup
// (renderStartSection's `fetchAllLandlets({ ownerBuilderId: builderId })`),
// silently misattributed ownership to a builder that no longer exists.
//
// Proven here by capturing the `ownerBuilderId` query param on the real
// GET /api/landlets requests that section issues, before and after delete
// — a network-level check rather than a UI-state check, since immediately
// after delete both the stale and the fresh builder legitimately own zero
// landlets (the deleted builder's own landlet was just released to
// greenbelt), so no on-screen text differs between the buggy and fixed
// behavior at that exact moment. The query param does, and it's exactly
// the value the fix (clearing builderId in the delete handler) is
// responsible for keeping correct.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, waitForText, finish } from './helpers.mjs';

const LABEL = 'Delete Builder Suite Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

const ownerBuilderIdsSeen = [];
page.on('request', (req) => {
  const url = new URL(req.url());
  if (url.pathname !== '/api/landlets') return;
  const ownerBuilderId = url.searchParams.get('ownerBuilderId');
  if (ownerBuilderId) ownerBuilderIdsSeen.push(ownerBuilderId);
});

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
// Settings opened directly into the Build tab (openSettingsModal derives
// activeSettingsTab from currentMode) — give its Auction section's own
// fetchAllLandlets({ ownerBuilderId: builderId }) call time to land before
// reading back which id it used.
await page.waitForTimeout(1200);
const originalBuilderId = ownerBuilderIdsSeen.at(-1);
console.log('builderId the Auction section used before delete:', originalBuilderId);

// --- Delete Account (launchPage's own dialog handler auto-accepts confirm()) ---
await page.click('#settings-section button:has-text("Delete Account")');
const deleteStatus = await waitForText(page, '#settings-section', 'Deleted', { timeout: 8000 });
console.log('Settings section text right after delete (should mention "Deleted"):', deleteStatus);

// Ground truth: whichever builder the session now really maps to, read
// directly from the server rather than trusting the app's own client
// state — this is exactly what deleteBuilder's own auto-provisioned
// replacement builder looks like.
const freshBuilderId = await page.evaluate(() =>
  fetch('/api/builders/me').then((r) => r.json()).then((d) => d.builder.builderId));
console.log('Fresh builderId the server now associates with this session:', freshBuilderId);

// Reopen Settings with no page reload — openSettingsModal() re-derives
// activeSettingsTab from currentMode ('build', unchanged), so this alone
// re-renders the Auction section and re-issues its landlet-ownership
// query using whatever the client's own builderId variable currently
// holds: the dead id if #738 regresses, the fresh one if the fix holds.
await page.click('#settings-close-btn');
await page.waitForSelector('#settings-modal:not(.visible)', { state: 'attached', timeout: 5000 });
ownerBuilderIdsSeen.length = 0;
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.waitForTimeout(1200);
const postDeleteBuilderId = ownerBuilderIdsSeen.at(-1);
console.log('builderId the Auction section used right after delete, no reload (should equal the fresh one, not the original):', postDeleteBuilderId);

const pass = deleteStatus.includes('Deleted') &&
  Boolean(freshBuilderId) && freshBuilderId !== originalBuilderId &&
  postDeleteBuilderId === freshBuilderId &&
  postDeleteBuilderId !== originalBuilderId &&
  errors.length === 0;
await finish(browser, { pass, label: 'Deleting a builder account clears the client-cached builderId (#738)', errors });
