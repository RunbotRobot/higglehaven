// #3777 (slice 2; the owner, testing as a new person: "my avatar doesn't walk,
// he just kind of glides"): another person's avatar used to slide across your
// screen with its body still, because presence carries only a position and
// nothing drove a pose for them. Now:
//   - a DEFAULT body swings its limbs while it walks and is still when it
//     stands (limbs, the same swing your own body has);
//   - a custom body with NO clips (public/models/crate.glb has no skeleton and
//     no clips) wears the small built-in motion: it leans, bobs and sways when
//     walking and only breathes when standing (rigid);
//   - a custom body that DOES have clips keeps its own clips and gets no
//     built-in motion (its clips replace it);
//   - an avatar far beyond the cutoff keeps the pose it last had (#3396).
// Same page.route presence rewriting as shop-other-avatar-animation.test.mjs;
// the fake builders walk by alternating between two spots 3 m apart on every
// poll. Read back via window.__shopOtherAvatars[].motionKind and
// window.__testShopOtherAvatarPoses()[].motion (same order).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RIGGED_GLB = fs.readFileSync(path.join(REPO_ROOT, 'e2e', 'fixtures', 'test-rigged-avatar.glb'));
const CRATE_GLB = fs.readFileSync(path.join(REPO_ROOT, 'public', 'models', 'crate.glb'));

const LABEL = 'Other Avatar Motion Builder';
const LANDLET_ID = 'other-avatar-motion-landlet';
const CLIPLESS = { templateId: 'tpl-clipless-avatar', modelUrl: '/models/clipless-avatar.glb', skeletonSignature: null };
const CLIPPED = { templateId: 'tpl-clipped-avatar', modelUrl: '/models/rigged-avatar.glb', skeletonSignature: 'sig-rigged' };

const session = await launchPage({ promptAnswer: LABEL });
const page = session.page;

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(p, opts);
        return { status: res.status, body: await res.json() };
      } catch (err) {
        if (attempt > 0) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, [pathAndQuery, options]);
}

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
const builder = (await fetchJson('/api/builders/me')).body.builder;
const landletCreated = await fetchJson('/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ landletId: LANDLET_ID, name: 'Other Avatar Motion Landlet', areaM2: 1000, status: 'claimed', ownerBuilderId: builder.builderId }),
});
console.log('landlet created (status should be 201):', landletCreated.status);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForTimeout(3000);

await page.route('**/models/clipless-avatar.glb', (route) => route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: CRATE_GLB }));
await page.route('**/models/rigged-avatar.glb', (route) => route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: RIGGED_GLB }));

// Five fake builders near the shopper plus one far past the cutoff. The
// "walkers" alternate between two spots 3 m apart on each poll.
let poll = 0;
await page.route('**/api/presence*', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const res = await route.fetch();
  const body = await res.json();
  poll += 1;
  const swing = poll % 2 === 0 ? 3 : 6;
  body.avatars = [
    ...(body.avatars ?? []),
    { builderId: 'fake-default-walker', x: swing, y: 4, z: 0, heading: 0, equippedAvatar: null, equippedAnimation: null },
    { builderId: 'fake-default-still', x: 8, y: 8, z: 0, heading: 0, equippedAvatar: null, equippedAnimation: null },
    { builderId: 'fake-clipless-walker', x: swing, y: -4, z: 0, heading: 0, equippedAvatar: CLIPLESS, equippedAnimation: null },
    { builderId: 'fake-clipless-still', x: 8, y: -8, z: 0, heading: 0, equippedAvatar: CLIPLESS, equippedAnimation: null },
    { builderId: 'fake-clipped-walker', x: swing, y: 10, z: 0, heading: 0, equippedAvatar: CLIPPED, equippedAnimation: null },
    { builderId: 'fake-far-walker', x: swing + 100, y: 4, z: 0, heading: 0, equippedAvatar: null, equippedAnimation: null },
  ];
  await route.fulfill({ response: res, body: JSON.stringify(body), contentType: 'application/json' });
});

const waitFor = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 25000 }).then(() => true).catch(() => false);
// Everyone drawn, each with the motion kind we expect once its body has loaded.
const ready = await waitFor(() => {
  const byId = Object.fromEntries((window.__shopOtherAvatars ?? []).map((a) => [a.builderId, a]));
  return byId['fake-default-walker']?.motionKind === 'limbs'
    && byId['fake-default-still']?.motionKind === 'limbs'
    && byId['fake-far-walker']?.motionKind === 'limbs'
    && byId['fake-clipless-walker']?.motionKind === 'rigid' && byId['fake-clipless-walker']?.bodyTemplateId === 'tpl-clipless-avatar'
    && byId['fake-clipless-still']?.motionKind === 'rigid'
    && byId['fake-clipped-walker']?.animationSource === 'own';
});
console.log('every fake builder is drawn with the expected body (should be true):', ready);

// Sample the live pose of each for a few seconds.
const samples = await page.evaluate(async () => {
  const out = {};
  const end = performance.now() + 4500;
  while (performance.now() < end) {
    const ids = (window.__shopOtherAvatars ?? []).map((a) => a.builderId);
    const poses = window.__testShopOtherAvatarPoses();
    poses.forEach((pose, i) => {
      const id = ids[i];
      const m = pose.motion;
      if (!m) return;
      const o = out[id] ?? (out[id] = { kind: m.kind, maxLeg: 0, maxArm: 0, maxLean: 0, maxBob: 0, maxSway: 0, applied: false });
      if (m.kind === 'limbs') {
        o.maxLeg = Math.max(o.maxLeg, Math.abs(m.legL));
        o.maxArm = Math.max(o.maxArm, Math.abs(m.armL));
      } else {
        o.maxLean = Math.max(o.maxLean, Math.abs(m.leanRad));
        o.maxBob = Math.max(o.maxBob, Math.abs(m.bobM));
        o.maxSway = Math.max(o.maxSway, Math.abs(m.swayRad));
        o.applied = o.applied || m.applied;
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return out;
});
console.log('samples:', JSON.stringify(samples));

const defaultWalker = samples['fake-default-walker'];
const defaultStill = samples['fake-default-still'];
const clipless = samples['fake-clipless-walker'];
const cliplessStill = samples['fake-clipless-still'];
const clipped = samples['fake-clipped-walker'];
const far = samples['fake-far-walker'];

const defaultWalkerSwings = defaultWalker?.maxLeg > 0.15 && defaultWalker?.maxArm > 0.1;
const defaultStillIsStill = defaultStill?.maxLeg < 0.01 && defaultStill?.maxArm < 0.01;
const cliplessWalks = clipless?.maxLean > 0.03 && clipless?.maxBob > 0.004 && clipless?.maxSway > 0.005 && clipless?.applied === true;
const cliplessStillBreathes = cliplessStill?.maxLean < 0.005 && cliplessStill?.maxBob < 0.03;
const clippedGetsNothing = clipped?.maxLean === 0 && clipped?.maxBob < 0.0001 && clipped?.applied === false;
const farKeepsItsPose = far?.maxLeg < 0.0001;
console.log('a default body swings its limbs while walking (should be true):', defaultWalkerSwings);
console.log('a default body stands still (should be true):', defaultStillIsStill);
console.log('a clip-less custom body leans, bobs and sways while walking (should be true):', cliplessWalks);
console.log('a clip-less custom body standing only breathes (should be true):', cliplessStillBreathes);
console.log('a custom body with its own clips gets no built-in motion (should be true):', clippedGetsNothing);
console.log('an avatar beyond the cutoff is left alone (should be true):', farKeepsItsPose);

const pass = landletCreated.status === 201 && ready
  && defaultWalkerSwings && defaultStillIsStill && cliplessWalks && cliplessStillBreathes && clippedGetsNothing && farKeepsItsPose
  && session.errors.length === 0;
await finish(session.browser, {
  pass,
  label: "other players' avatars walk instead of gliding: default bodies swing their limbs, clip-less custom bodies wear the built-in motion, clipped ones keep their clips, far ones are left alone (#3777)",
  errors: session.errors,
});
