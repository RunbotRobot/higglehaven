// #4509 (#4390, #4441): another person who has stepped away is shown by their avatar, not a label.
// Presence carries `afk`; a default body now does the same standing fidget your own does when idle
// (a slow weight shift, a gentle arm sway, a glance of the head), and a person who returns eases
// back to a plain stance instead of snapping. A person standing normally is perfectly still.
// Same page.route presence rewriting as shop-other-avatar-builtin-motion.test.mjs; read back through
// window.__testShopOtherAvatarPoses()[].motion (same order as window.__shopOtherAvatars): awayBlend and the
// pose actually written onto the body this frame.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Away Fidget Builder';
const LANDLET_ID = 'away-fidget-landlet';

const session = await launchPage({ promptAnswer: LABEL });
const page = session.page;

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
const builder = (await fetchJson('/api/builders/me')).body.builder;
await fetchJson('/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ landletId: LANDLET_ID, name: 'Away Fidget Landlet', areaM2: 1000, status: 'claimed', ownerBuilderId: builder.builderId }),
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForTimeout(3000);

// Two fake people standing still near the shopper: one away (until the test says they are back), one not.
let awayNow = true;
await page.route('**/api/presence*', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const res = await route.fetch().catch(() => null); // a poll can be in flight when the page closes
  if (!res) return;
  const body = await res.json();
  body.avatars = [
    ...(body.avatars ?? []),
    { builderId: 'fake-away', x: 4, y: 4, z: 0, heading: 0, afk: awayNow, equippedAvatar: null, equippedAnimation: null },
    { builderId: 'fake-standing', x: 8, y: 4, z: 0, heading: 0, afk: false, equippedAvatar: null, equippedAnimation: null },
  ];
  await route.fulfill({ response: res, body: JSON.stringify(body), contentType: 'application/json' }).catch(() => {});
});

const waitFor = (fn, arg, timeout = 25000) => page.waitForFunction(fn, arg, { timeout }).then(() => true).catch(() => false);
const ready = await waitFor(() => {
  const byId = Object.fromEntries((window.__shopOtherAvatars ?? []).map((a) => [a.builderId, a]));
  return byId['fake-away']?.motionKind === 'limbs' && byId['fake-away']?.afk === true && byId['fake-standing']?.motionKind === 'limbs';
});
console.log('both fake people are drawn as default bodies, one away (should be true):', ready);

// Sample both bodies' real pose for a while: away should fidget, the standing one should not.
const sample = (ms) => page.evaluate(async (duration) => {
  const out = { 'fake-away': { blend: [], maxArm: 0, maxYaw: 0, maxHead: 0, head: [] }, 'fake-standing': { blend: [], maxArm: 0, maxYaw: 0, maxHead: 0, head: [] } };
  const end = performance.now() + duration;
  while (performance.now() < end) {
    const ids = (window.__shopOtherAvatars ?? []).map((a) => a.builderId);
    window.__testShopOtherAvatarPoses().forEach((pose, i) => {
      const o = out[ids[i]];
      const m = pose.motion;
      if (!o || m?.kind !== 'limbs') return;
      o.blend.push(m.awayBlend);
      o.head.push(m.headRad);
      o.maxArm = Math.max(o.maxArm, Math.abs(m.armL));
      o.maxYaw = Math.max(o.maxYaw, Math.abs(m.bodyYawRad));
      o.maxHead = Math.max(o.maxHead, Math.abs(m.headRad));
    });
    await new Promise((resolve) => requestAnimationFrame(resolve)); // every drawn frame
  }
  return out;
}, ms);

const whileAway = await sample(12000);
const away = whileAway['fake-away'];
const standing = whileAway['fake-standing'];
console.log('away: blend', away.blend.at(0)?.toFixed(3), '->', away.blend.at(-1)?.toFixed(3), 'maxArm', away.maxArm.toFixed(4), 'maxYaw', away.maxYaw.toFixed(4), 'maxHead', away.maxHead.toFixed(4));
console.log('standing: maxArm', standing.maxArm, 'maxYaw', standing.maxYaw, 'maxHead', standing.maxHead);

const easesIn = away.blend.length > 10 && away.blend.at(0) < 0.2 && away.blend.at(-1) > away.blend.at(0) + 0.15;
const awayFidgets = away.maxArm > 0.005 && away.maxYaw > 0.004 && away.maxHead > 0.005;
const standingIsStill = standing.maxArm === 0 && standing.maxYaw === 0 && standing.maxHead === 0 && standing.blend.every((b) => b === 0);

// They come back: the fidget eases out (no single-frame snap) and ends at a plain stance.
awayNow = false;
await waitFor(() => (window.__shopOtherAvatars ?? []).find((a) => a.builderId === 'fake-away')?.afk === false);
const back = await sample(4000);
const returning = back['fake-away'];
// Not a single-frame cut: the blend is seen part-way on its way down, and never rises.
let rises = false;
for (let i = 1; i < returning.blend.length; i++) if (returning.blend[i] > returning.blend[i - 1] + 1e-9) rises = true;
const partWay = returning.blend.some((b) => b > 0.05 && b < 0.95);
const last = returning.blend.at(-1);
console.log('returning: blend', returning.blend.at(0)?.toFixed(3), '->', last?.toFixed(3), 'seen part-way', partWay, 'ever rises', rises, 'last head', returning.head.at(-1));
const easesOut = last === 0 && partWay && !rises && Math.abs(returning.head.at(-1)) < 0.001;

const errors = session.errors;
await finish(session.browser, {
  pass: ready && easesIn && awayFidgets && standingIsStill && easesOut && errors.length === 0,
  label: 'Another person who has stepped away is shown by their avatar and eases back when they return (#4509)',
  errors,
});
