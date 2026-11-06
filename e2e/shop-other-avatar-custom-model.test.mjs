// #2045 (client half): GET /api/presence now carries each nearby builder's
// resolved equippedAvatar ({ templateId, modelUrl } | null). Shop mode used to
// draw every other player as the default procedural body; it must now draw the
// equipped custom model, swap back when it goes away, cap how many distinct
// models are drawn at once, and fall back to the default body (never an error
// state) when a model fails to load. Same real-two-session setup and
// page.route response-rewriting technique as
// e2e/shop-other-avatar-missed-poll-debounce.test.mjs: the server half has its
// own worker tests, so this rewrites the real response to control exactly what
// the client is told, and confirms what the browser actually drew via
// window.__shopOtherAvatars[].bodyTemplateId.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL_A = 'Custom Other-Avatar Builder A';
const LABEL_B = 'Custom Other-Avatar Builder B';
const LANDLET_ID = 'custom-other-avatar-landlet';
const CRATE = { templateId: 'tpl-crate-a', modelUrl: '/models/crate.glb' };

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
  body: JSON.stringify({ landletId: LANDLET_ID, name: 'Custom Other-Avatar Landlet', areaM2: 1000, status: 'claimed', ownerBuilderId: builderA.builderId }),
});
console.log('landlet created (status should be 201):', landletCreated.status);

await pageA.reload({ waitUntil: 'networkidle' });
await pageA.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageA.click('#shop-fly-btn');
await pageA.waitForTimeout(2500);
await pageA.waitForTimeout(2500);

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

// What the next GET /api/presence tells A about B (and any extra fake
// builders). Rewrites the real response so B's real position still flows.
let equippedForB = null;
let extraAvatars = [];
await pageA.route('**/api/presence*', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const res = await route.fetch();
  const body = await res.json();
  body.avatars = (body.avatars ?? []).map((a) => (a.builderId === builderB.builderId ? { ...a, equippedAvatar: equippedForB } : a));
  body.avatars.push(...extraAvatars);
  await route.fulfill({ response: res, body: JSON.stringify(body), contentType: 'application/json' });
});

const bodyOf = (builderId) => pageA.evaluate((id) => (window.__shopOtherAvatars ?? []).find((a) => a.builderId === id)?.bodyTemplateId, builderId);
const waitFor = (fn, arg) => pageA.waitForFunction(fn, arg, { timeout: 15000 }).then(() => true).catch(() => false);

// 0. Baseline: B visible with the default body (no equippedAvatar).
const baselineSeen = await waitFor((id) => (window.__shopOtherAvatars ?? []).some((a) => a.builderId === id), builderB.builderId);
const baselineBody = await bodyOf(builderB.builderId);
console.log('baseline: B seen, body template (should be null):', baselineSeen, baselineBody);

// 1. B equips a custom model -> A draws it.
equippedForB = CRATE;
const drewCustom = await waitFor(([id, t]) => (window.__shopOtherAvatars ?? []).find((a) => a.builderId === id)?.bodyTemplateId === t, [builderB.builderId, CRATE.templateId]);
console.log('custom model drawn for B (should be true):', drewCustom);

// 2. B's avatar goes away (unequipped / deleted / suspended) -> default body again.
equippedForB = null;
const backToDefault = await waitFor((id) => (window.__shopOtherAvatars ?? []).find((a) => a.builderId === id)?.bodyTemplateId === null, builderB.builderId);
console.log('back to the default body (should be true):', backToDefault);

// 3. A model that fails to load -> default body, no stuck/blank state.
equippedForB = { templateId: 'tpl-broken', modelUrl: '/models/this-file-does-not-exist.glb' };
await pageA.waitForTimeout(4000); // several polls: it must keep drawing B, with the default body
const brokenBody = await bodyOf(builderB.builderId);
const stillVisible = await pageA.evaluate((id) => (window.__shopOtherAvatars ?? []).some((a) => a.builderId === id), builderB.builderId);
console.log('failed model: body template (should be null) and still visible (should be true):', brokenBody, stillVisible);

// 4. Cap: B plus 9 fake builders, all wanting distinct models -> at most 6 drawn.
equippedForB = CRATE;
extraAvatars = Array.from({ length: 9 }, (_, i) => ({
  builderId: `fake-builder-${i}`, x: 2 + i, y: 2, z: 0, heading: 0,
  equippedAvatar: { templateId: `tpl-fake-${i}`, modelUrl: '/models/crate.glb' },
}));
await waitFor(() => (window.__shopOtherAvatars ?? []).filter((a) => a.bodyTemplateId).length >= 1);
await pageA.waitForTimeout(4000); // let every allowed load finish and any over-cap one try
const drawnCount = await pageA.evaluate(() => (window.__shopOtherAvatars ?? []).filter((a) => a.bodyTemplateId).length);
const totalSeen = await pageA.evaluate(() => (window.__shopOtherAvatars ?? []).length);
console.log('cap: custom bodies drawn (should be 1..6) of builders seen (should be 10):', drawnCount, totalSeen);

const errors = [...sessionA.errors, ...sessionB.errors].filter((e) => !/Failed to load resource|404/.test(String(e)));
const pass =
  landletCreated.status === 201 &&
  baselineSeen && baselineBody === null &&
  drewCustom && backToDefault &&
  brokenBody === null && stillVisible &&
  drawnCount >= 1 && drawnCount <= 6 && totalSeen === 10 &&
  errors.length === 0;

await sessionB.browser.close();
await finish(sessionA.browser, {
  pass,
  label: "other players are drawn with their equipped custom avatar, swap back, fall back on a failed load, and respect the distinct-model cap (#2045)",
  errors,
});
