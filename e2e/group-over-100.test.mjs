// #3304 (remainder of #3263): Group/Ungroup of MORE than 100 placed items
// through the real Build UI. The batch endpoints cap at 100 per request, so
// the client has to chunk; this proves a 250-item group persists with one
// shared groupId (across a reload), then Ungroup clears all 250.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Group Over 100 Tester';
const COUNT = 250;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

async function pageFetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  }, [pathAndQuery, options]);
}
const json = (body, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const { body: buildersBody } = await pageFetchJson('/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landletId = landletsBody.landlets[0].landletId;

const instances = Array.from({ length: COUNT }, (_, i) => ({
  instanceId: `group-over-100-${i}`,
  landletId,
  templateId: 'placeholder-tree',
  x: 1 + (i % 25) * 0.1,
  y: 1 + Math.floor(i / 25) * 0.1,
}));
const statuses = [];
for (let i = 0; i < COUNT; i += 100) {
  statuses.push((await pageFetchJson('/api/instances/batch', json({ instances: instances.slice(i, i + 100) }))).status);
}
console.log('seeded 250 instances in 3 batches (all 201):', statuses);

async function fetchAll() {
  const all = [];
  let cursor = null;
  for (let guard = 0; guard < 20; guard++) {
    const q = `/api/instances?landletId=${encodeURIComponent(landletId)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { body } = await pageFetchJson(q);
    all.push(...body.instances);
    cursor = body.nextCursor || body.cursor || null;
    if (!cursor || !body.instances.length) break;
  }
  return all;
}

async function reloadBuild() {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: false });
  await page.waitForSelector('#account-menu-toggle', { timeout: 10000 });
  await page.waitForTimeout(2500);
}

await reloadBuild();
const selected = await page.evaluate(() => window.__testSelectAllProducts());
console.log('selected in scene (should be 250):', selected);

await page.click('#group-item');
await page.waitForTimeout(3000);

const grouped = await fetchAll();
const groupIds = new Set(grouped.map((i) => i.groupId));
console.log('instances / distinct groupIds after grouping (250 / 1, non-null):', grouped.length, groupIds.size, [...groupIds][0]);

await reloadBuild();
const reselected = await page.evaluate(() => window.__testSelectAllProducts());
await page.waitForSelector('#ungroup-item:not([disabled])', { timeout: 5000 });
await page.click('#ungroup-item');
await page.waitForTimeout(3000);

const ungrouped = await fetchAll();
const stillGrouped = ungrouped.filter((i) => i.groupId).length;
console.log('instances still grouped after Ungroup (should be 0):', stillGrouped, 'of', ungrouped.length);

const pass =
  statuses.every((s) => s === 201) &&
  selected === COUNT &&
  grouped.length === COUNT &&
  groupIds.size === 1 && !![...groupIds][0] &&
  reselected === COUNT &&
  ungrouped.length === COUNT &&
  stillGrouped === 0 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#3304: a 250-item group persists with one groupId and Ungroup clears all of it',
  errors,
});
