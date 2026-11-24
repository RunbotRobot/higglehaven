// #4067: someone who wears a model is not drawn as the default body while it loads. Fog stands where
// they stand (no body, so the default's limbs never show), holds for as long as the load takes, and
// thins away once their own body is in; someone whose model cannot be loaded gets the default body
// (a failure is not a stand-in), and someone who wears nothing is the default body at once. The
// presence reply is rewritten to say who wears what, and the model file is held by a route, so the
// time between "arrived" and "body ready" is the test's to stretch.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Fog While Model Loads Tester';
const LANDLET_ID = 'fog-wait-avatar-landlet';
const sessionA = await launchPage({ promptAnswer: LABEL });
const page = sessionA.page;

async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
const me = (await fetchJson('/api/builders/me')).body.builder;
await fetchJson('/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ landletId: LANDLET_ID, name: 'Fog Wait Landlet', areaM2: 1000, status: 'claimed', ownerBuilderId: me.builderId }),
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForTimeout(2500);

// The wearer's model file is held until the test lets it go.
let releaseModel;
const modelHeld = new Promise((resolve) => { releaseModel = resolve; });
await page.route('**/models/crate.glb', async (route) => {
  await modelHeld;
  await route.continue();
});

let avatars = [];
await page.route('**/api/presence*', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const res = await route.fetch();
  const body = await res.json();
  body.avatars = [...(body.avatars ?? []), ...avatars];
  await route.fulfill({ response: res, body: JSON.stringify(body), contentType: 'application/json' });
});

const entry = (id) => page.evaluate((b) => (window.__shopOtherAvatars ?? []).find((a) => a.builderId === b) ?? null, id);
const waitFor = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true).catch(() => false);

avatars = [
  { builderId: 'fog-wearer', x: 2, y: 2, z: 0, heading: 0, equippedAvatar: { templateId: 'tpl-fog-crate', modelUrl: '/models/crate.glb' } },
  { builderId: 'fog-bare', x: 4, y: 2, z: 0, heading: 0, equippedAvatar: null },
];
const seen = await waitFor(() => (window.__shopOtherAvatars ?? []).length >= 2);
await page.waitForTimeout(3000); // several polls with the model still held
const waiting = await entry('fog-wearer');
const bare = await entry('fog-bare');
console.log('wearer while the model is held: waiting, no body motion, no template (should be true, null, null):', waiting?.waitingForModel, waiting?.motionKind, waiting?.bodyTemplateId);
console.log('someone wearing nothing is the default body at once (should be false, limbs):', bare?.waitingForModel, bare?.motionKind);

releaseModel();
const arrived = await waitFor((id) => (window.__shopOtherAvatars ?? []).find((a) => a.builderId === id)?.bodyTemplateId === 'tpl-fog-crate', 'fog-wearer');
const fogGone = await waitFor((id) => (window.__shopOtherAvatars ?? []).find((a) => a.builderId === id)?.waitingForModel === false, 'fog-wearer', 5000);
console.log('model arrived, fog gone after it (should be true, true):', arrived, fogGone);

// A model that cannot be loaded is the default body, with no fog left standing.
avatars = [
  { builderId: 'fog-broken', x: 6, y: 2, z: 0, heading: 0, equippedAvatar: { templateId: 'tpl-fog-broken', modelUrl: '/models/this-file-does-not-exist.glb' } },
];
const brokenDefault = await waitFor((id) => {
  const a = (window.__shopOtherAvatars ?? []).find((x) => x.builderId === id);
  return !!a && a.waitingForModel === false && a.motionKind === 'limbs';
}, 'fog-broken');
console.log('failed model: default body and no fog (should be true):', brokenDefault);

// #4107: seven people wearing seven distinct models (the cap is six): the first six are fog until their
// body is in, and the seventh, whose model may not be drawn, is the default body with no fog left
// standing (it used to stay an untappable patch of fog for good).
const capCount = 7;
avatars = Array.from({ length: capCount }, (_, i) => ({
  builderId: `cap-${i}`, x: 2 + i, y: 4, z: 0, heading: 0,
  equippedAvatar: { templateId: `tpl-cap-${i}`, modelUrl: '/models/crate.glb' },
}));
const capSettled = await waitFor((n) => {
  const list = window.__shopOtherAvatars ?? [];
  const over = list.find((a) => a.builderId === `cap-${n - 1}`);
  const first = list.find((a) => a.builderId === 'cap-0');
  return !!over && over.waitingForModel === false && over.motionKind === 'limbs' && !!first && first.bodyTemplateId === 'tpl-cap-0' && first.waitingForModel === false;
}, capCount, 20000);
const capEntries = await page.evaluate(() => (window.__shopOtherAvatars ?? []).filter((a) => a.builderId.startsWith('cap-')).map((a) => [a.builderId, a.waitingForModel, a.motionKind, a.bodyTemplateId]));
console.log('seven distinct models: the first is its model with no fog, the seventh the default body with no fog (should be true):', capSettled, JSON.stringify(capEntries));

const errors = sessionA.errors.filter((e) => !/Failed to load resource|404/.test(String(e)));
const pass = seen &&
  waiting?.waitingForModel === true && waiting?.motionKind === null && waiting?.bodyTemplateId === null &&
  bare?.waitingForModel === false && bare?.motionKind === 'limbs' &&
  arrived && fogGone && brokenDefault && capSettled && errors.length === 0;
await finish(sessionA.browser, {
  pass,
  label: 'Another person who wears a model is fog, never the default body, until their model is in; over the model cap they are the default body (#4067, #4107)',
  errors,
});
