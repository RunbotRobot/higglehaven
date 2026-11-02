// #2996: enterShopMode (src/shop/mode.js) fetches every landlet's own
// record exactly once, at Shop-mode bootstrap -- status/ownerBuilderId
// never change again for the rest of the session even though claims,
// auctions, and admin reassignment are real, frequent mutations on the
// very same landlets this snapshot came from. updateShopLandletInfo's
// "<name> -- built by <owner>" label (src/shop/presenceAndContent.js) is
// one of the concretely user-visible symptoms: it reads ownerBuilderId off
// the one-time snapshot, so a landlet that changes hands while a shopper
// is already standing on it keeps crediting the previous owner
// indefinitely, with no reload needed to trigger a refetch and no walk-off-
// and-back needed either (updateShopLandletInfo's own change-detection only
// re-renders on an actual landlet *transition*).
//
// This drives that exact scenario end to end: builder A claims a landlet
// and a shopper stands on it (label reads "built by A"); admin
// reassign-owner moves it to builder B entirely out from under the
// already-open Shop-mode session; confirms the label is still stale on the
// very next ordinary proximity tick (the bug, still reachable without the
// #2996 fix); then forces refreshShopLandletRecordsIfNeeded's own periodic
// re-sync to run immediately via window.__testForceShopLandletRecordRefresh
// (the fix) and confirms the label stops crediting A with no reload and no
// walk-off-and-back, matching enterShopMode's own "unbroken session" bar
// every other shop/*.js e2e test in this suite holds itself to.
//
// B is a plain signed-up builder account, not a landowner -- reassign-owner
// itself refuses a target who already owns a claimed landlet ("Builder
// already owns a claimed landlet" is a real, separate one-free-landlet-per-
// builder invariant, confirmed the hard way: an earlier version of this
// test had B claim a landlet first, purely so B would be among the
// visibleOwnerBuilderIds enterShopMode's bootstrap fetches real labels for
// -- every reassignment attempt 409'd). shopBuilderLabels therefore never
// has a real label for B, so the fixed label reads the generic "an unknown
// builder" fallback (updateShopLandletInfo's own fallback for exactly this
// case) rather than B's own name -- still a fully concrete assertion that
// the record actually refreshed and stopped crediting A, just not B's own
// name specifically.
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const LABEL_A = 'Record Refresh Suite Owner A';
const LABEL_B = 'Record Refresh Suite Owner B';

async function adminFetch(pathAndQuery, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${pathAndQuery}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...options.headers,
    },
  });
  return { response, body: await response.json() };
}

const adminCookie = await ensureAdminSession();

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL_A });

// Builder A claims a landlet -- this is the one a shopper will stand on.
await chooseIdentity(page, { mode: 'build', label: LABEL_A, isNew: true });
await claimLandlet(page);

async function pageFetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

// Builder B, claimed on a second page in the same browser/session storage
// (chooseIdentity's own signup flow needs its own page-level auth-modal
// interaction, but reassign-owner only needs B's builderId afterward --
// this page's own job is done once that id is read back below).
const page2 = await browser.newPage({ viewport: { width: 420, height: 860 } });
page2.on('dialog', async (dialog) => {
  if (dialog.type() === 'prompt') await dialog.accept(LABEL_B);
  else await dialog.accept();
});
await page2.goto(BASE_URL, { waitUntil: 'networkidle' });
await page2.waitForTimeout(1500);
await chooseIdentity(page2, { mode: 'build', label: LABEL_B, isNew: true });
await page2.close();

const { body: buildersBody } = await pageFetchJson('/api/builders');
const builderA = buildersBody.builders.find((b) => b.label === LABEL_A);
const builderB = buildersBody.builders.find((b) => b.label === LABEL_B);
console.log('builder A found:', !!builderA, '-- builder B found:', !!builderB);

const { body: landletsBody } = await pageFetchJson(
  `/api/landlets?status=claimed&ownerBuilderId=${builderA.builderId}&limit=100`,
);
const landlet = landletsBody.landlets[0];
console.log('A\'s claimed landlet found:', !!landlet);

// Now actually enter Shop mode and stand on A's own landlet, same
// teleport-and-force-tick idiom e2e/shop-landlet-instance-leak.test.mjs
// already established (#1479's window.__testTeleportShopAvatar +
// window.__testForceShopProximityCheck, avoiding a real but imprecise
// joystick walk).
await chooseIdentity(page, { mode: 'shop', label: LABEL_A, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// Same spawn-rotation-release gesture e2e/shop-landlet-instance-leak.test.mjs
// uses -- a fresh Shop-mode spawn otherwise keeps overwriting
// shopAvatarPosition every frame via its own hands-off orbit until real
// navigation input first arrives.
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveCenterX, moveCenterY);
await page.mouse.down();
await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

async function teleportOntoLandletAndTick() {
  await page.evaluate(([x, y]) => {
    window.__testTeleportShopAvatar(x, y);
    window.__testForceShopProximityCheck();
  }, [landlet.center.x, landlet.center.y]);
  // #1479's own window.__testForceShopProximityCheck only forces
  // updateShopProximity (the load/unload decision) immediately -- there's
  // no equivalent direct hook for updateShopLandletInfo (the "built by"
  // label), which only runs alongside it inside flightMovement.js's own
  // real SHOP_PROXIMITY_INTERVAL_MS-gated tick (400ms). A short real-frame
  // margin here is enough for that tick to actually land once on its own.
  await page.waitForTimeout(600);
}

await teleportOntoLandletAndTick();
const labelBeforeReassign = await page.textContent('#account-menu-landlet-info');
console.log('landlet-info label while still owned by A (should mention A):', labelBeforeReassign);

// The reassignment itself happens entirely server-side, out from under the
// already-open Shop-mode session above -- nothing on this page's own
// shopLandlets entry changes just from this call.
const reassign = await adminFetch(`/landlets/${landlet.landletId}/reassign-owner`, adminCookie, {
  method: 'POST',
  body: JSON.stringify({ ownerBuilderId: builderB.builderId }),
});
if (reassign.response.status !== 200) {
  throw new Error(`reassign-owner failed (${reassign.response.status}): ${JSON.stringify(reassign.body)}`);
}

// Still standing on the same landlet, no transition -- an ordinary
// proximity tick on its own should NOT pick up the new owner yet (this is
// the #2996 bug, still reachable without the fix below; a real session
// would keep reading this exact stale value indefinitely).
await teleportOntoLandletAndTick();
const labelStillStale = await page.textContent('#account-menu-landlet-info');
console.log('landlet-info label right after reassignment, before any refresh (should still mention A):', labelStillStale);

// The #2996 fix: force refreshShopLandletRecordsIfNeeded's own periodic
// re-sync to run immediately rather than waiting on its real
// SHOP_RECORD_REFRESH_INTERVAL_MS gate, then let an ordinary proximity tick
// pick up the now-current record the same way it already does for every
// other field.
await page.evaluate(() => window.__testForceShopLandletRecordRefresh());
await teleportOntoLandletAndTick();
const labelAfterRefresh = await page.textContent('#account-menu-landlet-info');
console.log(
  'landlet-info label after the forced record refresh (should no longer mention A -- B has no pre-fetched '
  + 'label, so this reads the "an unknown builder" fallback):',
  labelAfterRefresh,
);

const pass = !!landlet && !!builderA && !!builderB
  && !!labelBeforeReassign?.includes(LABEL_A)
  && !!labelStillStale?.includes(LABEL_A)
  && !labelAfterRefresh?.includes(LABEL_A)
  && !!labelAfterRefresh?.includes('unknown builder')
  && errors.length === 0;
await finish(browser, {
  pass,
  label: '#2996: Shop mode\'s landlet-info "built by" label stops showing a previous owner once refreshShopLandletRecordsIfNeeded re-syncs the record after an ownership change',
  errors,
});
