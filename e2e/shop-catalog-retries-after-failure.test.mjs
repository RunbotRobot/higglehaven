// #4295 (from the #4277 audit): Shop asks for the catalog once as it opens. A request that failed once left the
// built-in sample catalog in place for the whole visit, so no real product had a template, every placement on every
// lándlet "never arrived", and nothing asked again. The first catalog request is made to fail here; the page asks
// again in the background and the placed products appear without the person moving.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Catalog Retry Tester';
const ITEMS = 3;

async function adminFetch(pathAndQuery, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${pathAndQuery}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...options.headers },
  });
  return { response, body: await response.json() };
}

// Room to stand on and a filler landlet so the avatar can be placed beside the claimed one (as shop-arrival-fog).
{
  const cookie = await ensureAdminSession();
  const worldPatch = await adminFetch('/world', cookie, { method: 'PATCH', body: JSON.stringify({ radiusM: 200 }) });
  if (worldPatch.response.status !== 200) throw new Error(`world radius patch failed: ${JSON.stringify(worldPatch.body)}`);
  const filler = await adminFetch('/landlets', cookie, {
    method: 'POST',
    body: JSON.stringify({ landletId: `e2e-catalog-retry-filler-${crypto.randomUUID()}`, name: 'Catalog Retry Filler', areaM2: 300 * 300, centerX: 0, centerY: 0, status: 'generating' }),
  });
  if (filler.response.status !== 201) throw new Error(`filler landlet create failed: ${JSON.stringify(filler.body)}`);
}

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 780 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

const pageFetchJson = (pathAndQuery, options) => page.evaluate(async ([p, opts]) => {
  const res = await fetch(p, opts);
  return { status: res.status, body: await res.json() };
}, [pathAndQuery, options]);

const { body: sellerMe } = await pageFetchJson('/api/sellers/me');
const modelForm = new FormData();
modelForm.append('file', new Blob([await fs.readFile(CRATE_MODEL_PATH)], { type: 'model/gltf-binary' }), 'catalog-retry-crate.glb');
const modelUpload = await (await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: modelForm })).json();
const sessionCookie = (await page.context().cookies()).find((c) => c.name === 'hh_session');
const templateRes = await fetch(`${BASE_URL}/api/catalog`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: sessionCookie ? `hh_session=${sessionCookie.value}` : '' },
  body: JSON.stringify({
    name: 'Catalog Retry Crate', category: 'placeholder', color: '#8899aa', dimensions: { width: 1, depth: 1, height: 1 },
    sellerId: sellerMe.seller.sellerId, modelUrl: modelUpload.modelUrl, modelSizeBytes: modelUpload.sizeBytes, priceCents: 500,
  }),
});
const template = (await templateRes.json()).template;
const { body: buildersBody } = await pageFetchJson('/api/builders');
const me = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];
for (let i = 0; i < ITEMS; i += 1) {
  await pageFetchJson('/api/instances', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: `catalog-retry-${crypto.randomUUID()}`, landletId: landlet.landletId, templateId: template.templateId, x: i * 1.5 - 1.5, y: 0 }),
  });
}

// The first catalog request fails; every later one goes through.
let catalogRequests = 0;
let failed = 0;
await page.route('**/api/catalog?*', (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  catalogRequests += 1;
  if (failed < Number(process.env.CATALOG_FAILS ?? 1)) { failed += 1; return route.abort('failed'); }
  return route.continue();
});

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 15000 });
await page.evaluate(([x, y]) => { window.__testTeleportShopAvatar(x, y, 0); window.__testForceShopProximityCheck(); }, [landlet.center.x + 4, landlet.center.y]);

let drawn = 0;
for (let i = 0; i < 60 && drawn < ITEMS; i += 1) {
  await page.evaluate(() => window.__testForceShopProximityCheck());
  await page.waitForTimeout(500);
  drawn = await page.evaluate(() => window.__testShopLoadedInstanceCount());
}
console.log('placements drawn after the catalog was asked for again (should be', ITEMS + '):', drawn, '| catalog requests:', catalogRequests);

const pass = failed === Number(process.env.CATALOG_FAILS ?? 1) && drawn === ITEMS && catalogRequests >= 2;
await finish(browser, {
  pass: pass && errors.filter((e) => !/Failed to load resource|net::ERR_FAILED/.test(e)).length === 0,
  label: '#4295: a catalog request that fails once is asked for again, and the placed products appear without moving',
  errors,
});
