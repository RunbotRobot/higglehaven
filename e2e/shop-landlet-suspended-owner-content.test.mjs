// #3005: refreshShopLandletRecordsNow (src/shop/presenceAndContent.js,
// #2996/#2999's periodic landlet re-sync) only unloaded a claimed
// landlet's placed content on a `status` transition -- a mid-session
// owner suspension leaves `status` at 'claimed' on both sides of the
// change, only the new `ownerSuspended` field (this fix) flips. Without
// watching that field too, a shopper who already had the now-suspended
// builder's content loaded kept rendering it indefinitely, even though
// PR #2993 (#2989) already makes GET /instances?landletId= return nothing
// for it server-side.
//
// Drives the real sequence end to end: builder A claims a landlet, places
// a real catalog-template instance on it, and a separate shopper B (the
// owner always sees their own content, so A itself could never observe
// the hiding) stands on it with the instance loaded; an admin suspends A; confirms the instance
// is STILL rendered on the very next ordinary proximity tick alone (the
// bug, still reachable without the fix below); then forces
// refreshShopLandletRecordsIfNeeded's own periodic re-sync via
// window.__testForceShopLandletRecordRefresh (the fix) and confirms the
// instance disappears with no reload and no walk-off-and-back needed.
// Then lifts the suspension and confirms the same refresh+tick cycle
// brings the instance back, since #2993's own gate is purely a live read
// of account_suspensions, not a destructive removal (#2986, not yet
// built) -- the underlying placed_instances row never went anywhere.
//
// window.__testShopInstanceLodBand(instanceId) (src/main.js, #2378) is
// reused as the "is this instance's mesh actually present right now"
// probe: it already returns null when no entry.objects anywhere holds a
// matching instanceId, and a band string ('near'/'middle'/'none' for a
// proxy-less model) once createMeshForInstance's result is in the scene
// -- exactly the loaded/unloaded signal this fix needs, no new test hook
// required.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, emailForLabel, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL_A = 'Suspended Owner Content Suite Tester';
const LABEL_B = 'Suspended Owner Content Suite Shopper';
const PRODUCT_NAME = 'Suite Suspended Owner Content Product';

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

await chooseIdentity(page, { mode: 'build', label: LABEL_A, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL_A, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

async function pageFetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { body: sellerMeBody } = await pageFetchJson('/api/sellers/me');
const sellerId = sellerMeBody.seller.sellerId;

const modelBytes = await fs.readFile(CRATE_MODEL_PATH);
const modelForm = new FormData();
modelForm.append('file', new Blob([modelBytes], { type: 'model/gltf-binary' }), 'suspended-owner-content-crate.glb');
const modelUploadRes = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: modelForm });
const modelUpload = await modelUploadRes.json();
if (modelUploadRes.status !== 200 && modelUploadRes.status !== 201) {
  throw new Error(`model upload failed (${modelUploadRes.status}): ${JSON.stringify(modelUpload)}`);
}

const cookies = await page.context().cookies();
const sessionCookie = cookies.find((c) => c.name === 'hh_session');
const cookieHeader = sessionCookie ? `hh_session=${sessionCookie.value}` : '';
const templateRes = await fetch(`${BASE_URL}/api/catalog`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: cookieHeader },
  body: JSON.stringify({
    name: PRODUCT_NAME, category: 'placeholder', color: '#8899aa',
    dimensions: { width: 1, depth: 1, height: 1 },
    sellerId, modelUrl: modelUpload.modelUrl, modelSizeBytes: modelUpload.sizeBytes, priceCents: 500,
  }),
});
const templateBody = await templateRes.json();
if (templateRes.status !== 200 && templateRes.status !== 201) {
  throw new Error(`catalog template create failed (${templateRes.status}): ${JSON.stringify(templateBody)}`);
}
const template = templateBody.template;

const { body: buildersBody } = await pageFetchJson('/api/builders');
const builderA = buildersBody.builders.find((b) => b.label === LABEL_A);
const { body: landletsBody } = await pageFetchJson(
  `/api/landlets?status=claimed&ownerBuilderId=${builderA.builderId}&limit=100`,
);
const landlet = landletsBody.landlets[0];
console.log('A\'s claimed landlet found:', !!landlet);

const instanceId = `suspended-owner-content-instance-${crypto.randomUUID()}`;
await pageFetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});

// The shopper must be a different account from the landlet's owner:
// GET /instances?landletId= (#2989/#2993) always shows a suspended owner
// their own content, so an owner-as-shopper can never observe the hiding.
// A second browser gets its own cookie jar, so B's session is independent
// of A's (which is suspended below).
const { browser: browserB, page: pageB, errors: errorsB } = await launchPage({ promptAnswer: LABEL_B });
await chooseIdentity(pageB, { mode: 'shop', label: LABEL_B, isNew: true });
await pageB.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await pageB.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// Same spawn-rotation-release gesture e2e/shop-landlet-instance-leak.test.mjs
// and e2e/shop-landlet-record-refresh.test.mjs both use -- a fresh Shop-mode
// spawn otherwise keeps overwriting shopAvatarPosition every frame via its
// own hands-off orbit until real navigation input first arrives.
const moveJoystickBox = await pageB.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await pageB.mouse.move(moveCenterX, moveCenterY);
await pageB.mouse.down();
await pageB.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await pageB.waitForTimeout(100);
await pageB.mouse.up();
await pageB.waitForTimeout(100);

async function teleportOntoLandletAndTick() {
  await pageB.evaluate(([x, y]) => {
    window.__testTeleportShopAvatar(x, y);
    window.__testForceShopProximityCheck();
  }, [landlet.center.x, landlet.center.y]);
  await pageB.waitForTimeout(600);
}

async function instanceLodBand() {
  return pageB.evaluate((id) => window.__testShopInstanceLodBand(id), instanceId);
}

await teleportOntoLandletAndTick();
const bandWhileOwned = await instanceLodBand();
console.log('instance LOD band while owner is still in good standing (should NOT be null):', bandWhileOwned);

const suspend = await adminFetch('/auth/suspend-account', adminCookie, {
  method: 'POST',
  body: JSON.stringify({ email: emailForLabel(LABEL_A), reason: 'e2e #3005 suspended-owner-content coverage' }),
});
if (suspend.response.status !== 200) {
  throw new Error(`suspend-account failed (${suspend.response.status}): ${JSON.stringify(suspend.body)}`);
}

// Still standing on the same landlet, no status transition -- an ordinary
// proximity tick on its own should NOT drop the already-loaded instance yet
// (this is the #3005 bug, still reachable without the fix below; a real
// session would keep rendering this exact stale content indefinitely).
await teleportOntoLandletAndTick();
const bandStillStaleAfterSuspend = await instanceLodBand();
console.log('instance LOD band right after suspension, before any refresh (should still NOT be null):', bandStillStaleAfterSuspend);

// The #3005 fix: force refreshShopLandletRecordsIfNeeded's own periodic
// re-sync to run immediately, then let an ordinary proximity tick pick up
// the now-current ownerSuspended flag.
await pageB.evaluate(() => window.__testForceShopLandletRecordRefresh());
await teleportOntoLandletAndTick();
const bandAfterRefresh = await instanceLodBand();
console.log('instance LOD band after the forced record refresh while suspended (should be null -- content hidden):', bandAfterRefresh);

const unsuspend = await adminFetch('/auth/unsuspend-account', adminCookie, {
  method: 'POST',
  body: JSON.stringify({ email: emailForLabel(LABEL_A) }),
});
if (unsuspend.response.status !== 200) {
  throw new Error(`unsuspend-account failed (${unsuspend.response.status}): ${JSON.stringify(unsuspend.body)}`);
}

// The round trip: lifting the suspension doesn't destructively touch
// placed_instances (that's #2986, not yet built) -- GET /instances just
// stops filtering it out, so the very same refresh+tick cycle should bring
// the instance back without a reload or walk-off-and-back either.
await pageB.evaluate(() => window.__testForceShopLandletRecordRefresh());
await teleportOntoLandletAndTick();
const bandAfterUnsuspendRefresh = await instanceLodBand();
console.log('instance LOD band after unsuspending and refreshing again (should NOT be null again):', bandAfterUnsuspendRefresh);

const pass = !!landlet && !!builderA
  && bandWhileOwned !== null
  && bandStillStaleAfterSuspend !== null
  && bandAfterRefresh === null
  && bandAfterUnsuspendRefresh !== null
  && errors.length === 0;
await browserB.close();
await finish(browser, {
  pass,
  label: '#3005: Shop mode\'s periodic landlet-record re-sync unloads (and later reloads) a landlet\'s placed content when its owner\'s suspension status changes mid-session',
  errors: [...errors, ...errorsB],
});
