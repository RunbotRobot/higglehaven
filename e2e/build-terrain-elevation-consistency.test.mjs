// #2871: #2851 lifts a landlet's ground mesh to its real elevationM, but
// left every placed product stranded at the old flat baseline in Build
// mode (the ground's own geometry got the offset baked in; products,
// added as siblings directly into `scene`, never did). Fixed by moving
// every placed product -- plus the trim preview, group-move pivot,
// alignment guides, and sold-out ghost markers, anything positioned
// relative to a real product's own x/y/z -- into a new
// landletElevationGroup that carries the same elevationM offset
// (src/build/scene.js). This drives that fix through the real production
// code: claims a landlet, places a real item, writes a genuine nonzero
// elevation_m directly into D1 (the only way to drive a real value through
// this deployment for a test-claimed landlet, same `wrangler d1 execute
// --local` technique e2e/control-room-admin-page.test.mjs's own #2526
// regression already uses), reloads, and confirms the placed item's own
// world z rose by exactly that amount -- not left behind at the old
// baseline.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'Build Elevation Consistency Tester';
const ELEVATION_M = 6.25;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

const before = await page.evaluate(() => window.__testLandletElevationWorldZ());
console.log('before writing a real elevation_m (elevationGroupZ should be 0, worldZ should equal localZ):', before);
const beforeConsistent = before.elevationGroupZ === 0 &&
  before.products.length === 1 &&
  Math.abs(before.products[0].worldZ - before.products[0].localZ) < 0.0001;
const placedLocalZ = before.products[0]?.localZ;

// A fresh local D1 (see e2e/run-all.mjs) only ever seeds one claimable
// landlet -- "starter-landlet" -- which claimLandlet() above always ends
// up claiming, so it's safe to name directly here.
execFileSync('npx', [
  'wrangler', 'd1', 'execute', 'higglehaven-db', '--local', '--command',
  `UPDATE landlets SET elevation_m = ${ELEVATION_M} WHERE landlet_id = 'starter-landlet'`,
], { cwd: REPO_ROOT, stdio: 'pipe' });
console.log(`wrote a real elevation_m = ${ELEVATION_M} directly to D1 for starter-landlet`);

// A raw reload lands in Shop mode by default unless this is set first, the
// same way every one of the app's own reload-triggering paths already
// does (see e.g. e2e/bundle-rename-sync.test.mjs's own identical comment).
await page.evaluate(() => sessionStorage.setItem('higglehaven.startMode', 'build'));
await page.reload();
await page.waitForSelector('#add-item-btn', { timeout: 15000 });
await page.waitForTimeout(500);

const after = await page.evaluate(() => window.__testLandletElevationWorldZ());
console.log(`after reload with a real nonzero elevation_m (elevationGroupZ should be ${ELEVATION_M}):`, after);
const groupPickedUpRealElevation = Math.abs(after.elevationGroupZ - ELEVATION_M) < 0.0001;
const afterProduct = after.products.find((p) => p.instanceId === before.products[0]?.instanceId);
console.log('the same placed item after reload (localZ should be unchanged, worldZ should be localZ + elevationM):', afterProduct);
const productLocalZUnchanged = afterProduct !== undefined && Math.abs(afterProduct.localZ - placedLocalZ) < 0.0001;
const productRoseWithGround = afterProduct !== undefined &&
  Math.abs(afterProduct.worldZ - (afterProduct.localZ + ELEVATION_M)) < 0.0001;

const pass = beforeConsistent &&
  groupPickedUpRealElevation &&
  productLocalZUnchanged &&
  productRoseWithGround &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Build mode: a placed product rises with the ground under a real nonzero landlet elevationM, not left behind at the old baseline',
  errors,
});
