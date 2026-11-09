// #3230 (client half of #2045's animation piece): GET /api/presence carries
// each nearby builder's resolved equippedAnimation and equippedAvatar's
// skeletonSignature. Shop mode must play clips on other players' custom bodies
// the way it already does on the shopper's own avatar: the applied animation's
// clips when its signature matches the avatar's, else the avatar's own clips
// (never an error), idle while the avatar is still and walk while it moves,
// each avatar driven by its own mixer. Same two-session setup and page.route
// response-rewriting as e2e/shop-other-avatar-custom-model.test.mjs (the server
// half has its own worker tests); the rig/clips come from
// e2e/fixtures/test-rigged-avatar.glb (two bones, named idle/walk/fly clips).
// Read back via window.__shopOtherAvatars[].animationSource / .animState.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RIGGED_GLB = fs.readFileSync(path.join(REPO_ROOT, 'e2e', 'fixtures', 'test-rigged-avatar.glb'));

const LABEL_A = 'Animated Other-Avatar Builder A';
const LABEL_B = 'Animated Other-Avatar Builder B';
const LANDLET_ID = 'animated-other-avatar-landlet';
const SIG = 'sig-rigged';
const AVATAR = { templateId: 'tpl-rigged-avatar', modelUrl: '/models/rigged-avatar.glb', skeletonSignature: SIG };
const ANIMATION_OK = { templateId: 'tpl-anim-ok', modelUrl: '/models/rigged-animation.glb', skeletonSignature: SIG };
const ANIMATION_OTHER_RIG = { templateId: 'tpl-anim-other', modelUrl: '/models/rigged-animation.glb', skeletonSignature: 'a-different-rig' };
const ANIMATION_BROKEN = { templateId: 'tpl-anim-broken', modelUrl: '/models/rigged-missing-animation.glb', skeletonSignature: SIG };

const sessionA = await launchPage({ promptAnswer: LABEL_A });
const sessionB = await launchPage({ promptAnswer: LABEL_B });
const pageA = sessionA.page;
const pageB = sessionB.page;

async function fetchJson(page, path, options) {
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
  }, [path, options]);
}

await chooseIdentity(pageA, { mode: 'build', label: LABEL_A, isNew: true });
const builderA = (await fetchJson(pageA, '/api/builders/me')).body.builder;
const landletCreated = await fetchJson(pageA, '/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ landletId: LANDLET_ID, name: 'Animated Other-Avatar Landlet', areaM2: 1000, status: 'claimed', ownerBuilderId: builderA.builderId }),
});
console.log('landlet created (status should be 201):', landletCreated.status);

await pageA.reload({ waitUntil: 'networkidle' });
await pageA.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageA.click('#shop-fly-btn');
await pageA.waitForTimeout(5000);

await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
const builderB = (await fetchJson(pageB, '/api/builders/me')).body.builder;
await fetchJson(pageB, '/api/presence', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ x: 0, y: 0, z: 0, heading: 0, landletId: LANDLET_ID }),
});
await pageB.reload({ waitUntil: 'networkidle' });
await pageB.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageB.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageB.click('#shop-fly-btn');
await pageB.waitForTimeout(2500);

// Both model URLs serve the same rigged fixture; the "missing" animation URL
// is deliberately not routed so it fails to load.
await pageA.route('**/models/rigged-*.glb', (route) => {
  if (route.request().url().includes('rigged-missing')) return route.abort();
  return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: RIGGED_GLB });
});

// What the next GET /api/presence tells A about B (real, stationary) and about
// a fake builder that advances 3 m on every poll (so it is observably walking).
let equippedAvatarForB = null;
let equippedAnimationForB = null;
let walkerOn = false;
let walkerX = 3;
await pageA.route('**/api/presence*', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const res = await route.fetch();
  const body = await res.json();
  body.avatars = (body.avatars ?? []).map((a) => (a.builderId === builderB.builderId
    ? { ...a, equippedAvatar: equippedAvatarForB, equippedAnimation: equippedAnimationForB }
    : a));
  if (walkerOn) {
    walkerX += 3;
    body.avatars.push({ builderId: 'fake-walker', x: walkerX, y: 4, z: 0, heading: 0, equippedAvatar: AVATAR, equippedAnimation: null });
  }
  await route.fulfill({ response: res, body: JSON.stringify(body), contentType: 'application/json' });
});

const stateOf = (builderId) => pageA.evaluate((id) => {
  const a = (window.__shopOtherAvatars ?? []).find((x) => x.builderId === id);
  return a ? { body: a.bodyTemplateId, source: a.animationSource, anim: a.animState, clip: a.playingClip } : null;
}, builderId);
const waitFor = (fn, arg) => pageA.waitForFunction(fn, arg, { timeout: 20000 }).then(() => true).catch(() => false);
const waitSource = (id, source) => waitFor(([builderId, s]) => (window.__shopOtherAvatars ?? []).find((a) => a.builderId === builderId)?.animationSource === s, [id, source]);

// 0. Baseline: default body, no clips.
await waitFor((id) => (window.__shopOtherAvatars ?? []).some((a) => a.builderId === id), builderB.builderId);
const baseline = await stateOf(builderB.builderId);
console.log('baseline default body: no clip source (should be null):', baseline?.source);

// 1. Custom avatar, nothing applied -> its own clips, idle (B is standing still).
equippedAvatarForB = AVATAR;
const ownClips = await waitSource(builderB.builderId, 'own');
const ownIdle = await waitFor((id) => (window.__shopOtherAvatars ?? []).find((a) => a.builderId === id)?.animState === 'idle', builderB.builderId);
console.log('avatar with no applied animation plays its own clips (should be true):', ownClips, '| idle while still (should be true):', ownIdle);

// 2. A compatible applied animation -> its clips.
equippedAnimationForB = ANIMATION_OK;
const appliedClips = await waitSource(builderB.builderId, 'applied');
console.log('compatible applied animation is used (should be true):', appliedClips);

// 3. Same animation but a different rig -> back to the avatar's own clips.
equippedAnimationForB = ANIMATION_OTHER_RIG;
const incompatibleFallsBack = await waitSource(builderB.builderId, 'own');
console.log('incompatible animation falls back to own clips (should be true):', incompatibleFallsBack);

// 4. Compatible but the animation file will not load -> own clips, no error state.
equippedAnimationForB = ANIMATION_BROKEN;
await pageA.waitForTimeout(4000);
const brokenState = await stateOf(builderB.builderId);
console.log('animation that fails to load: still own clips, avatar still drawn (should be own / custom):', brokenState?.source, brokenState?.body);

// 5. Two avatars on the same model at once: the walker walks while B stays
// idle -- each has its own mixer and skeleton.
equippedAnimationForB = null;
walkerOn = true;
const walkerWalks = await waitFor(() => (window.__shopOtherAvatars ?? []).find((a) => a.builderId === 'fake-walker')?.animState === 'walk');
const bStillIdle = (await stateOf(builderB.builderId))?.anim;
console.log('moving avatar plays walk (should be true):', walkerWalks, '| the still one beside it stays idle (should be idle):', bStillIdle);

// 6. The seller's chosen clip roles (#3314) beat name matching, and follow a
// change on an avatar that is already drawn. B stands still, so its idle role
// plays: normally the clip named idle; with the roles swapped, the clip named walk.
walkerOn = false;
const waitClip = (clip) => waitFor(([id, c]) => (window.__shopOtherAvatars ?? []).find((a) => a.builderId === id)?.playingClip === c, [builderB.builderId, clip]);
const byNameClip = await waitClip('idle');
equippedAvatarForB = { ...AVATAR, clipRoles: { idle: 'walk', walk: 'idle', fly: null } };
const swappedClip = await waitClip('walk');
equippedAvatarForB = { ...AVATAR, clipRoles: { idle: null, walk: null, fly: null } };
const notUsed = await waitFor((id) => {
  const a = (window.__shopOtherAvatars ?? []).find((x) => x.builderId === id);
  return a && a.animationSource === null && a.playingClip === null;
}, builderB.builderId);
equippedAvatarForB = AVATAR;
const backToNames = await waitClip('idle');
console.log('by name, standing plays idle (should be true):', byNameClip, '| roles swapped plays the walk clip (should be true):', swappedClip,
  '| everything "not used" plays nothing (should be true):', notUsed, '| no roles back to name matching (should be true):', backToNames);

// 7. Back to the default body: clips are dropped.
walkerOn = false;
equippedAvatarForB = null;
const droppedClips = await waitFor((id) => {
  const a = (window.__shopOtherAvatars ?? []).find((x) => x.builderId === id);
  return a && a.bodyTemplateId === null && a.animationSource === null;
}, builderB.builderId);
console.log('default body again, no clips (should be true):', droppedClips);

const errors = [...sessionA.errors, ...sessionB.errors].filter((e) => !/Failed to load resource|404|ERR_FAILED|rigged-missing/.test(String(e)));
const pass =
  landletCreated.status === 201 &&
  baseline?.source === null &&
  ownClips && ownIdle &&
  appliedClips && incompatibleFallsBack &&
  brokenState?.source === 'own' && brokenState?.body === AVATAR.templateId &&
  walkerWalks && bStillIdle === 'idle' &&
  byNameClip && swappedClip && notUsed && backToNames &&
  droppedClips &&
  errors.length === 0;

await sessionB.browser.close();
await finish(sessionA.browser, {
  pass,
  label: "other players' custom avatars play their own or compatible applied clips, idle vs walk by observed movement, each independently (#3230)",
  errors,
});
