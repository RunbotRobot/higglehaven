#!/usr/bin/env node
// #4062: reports every product in the catalogue whose stored mid or far version does not still read as the
// model (src/tierFidelity.js: the silhouette from the six axes, and for a mid version the surface it kept and
// the open edges it grew, #4114: the same check the generator applies).
// Read-only: it lists the public catalogue and downloads the public model files, one at a time with a short
// pause, and writes nothing anywhere. Products with no stored versions are listed apart (the viewer makes
// those itself); a model this reader cannot parse (skinned, compressed) is listed as skipped.
//
//   NODE_USE_ENV_PROXY=1 node scripts/scan-model-tiers.mjs    # the live catalogue (from a fleet session the proxy adds the key node needs)
//   node scripts/scan-model-tiers.mjs --url http://127.0.0.1:8787
//   node scripts/scan-model-tiers.mjs --json                  # machine-readable
import { glbBatches } from './glb-batches-lib.mjs';
import { silhouetteFidelity, isFaithful } from '../src/tierFidelity.js';

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const base = valueOf('--url', 'https://higglehaven.com').replace(/\/$/, '');
const asJson = args.includes('--json');
const pauseMs = Number(valueOf('--pause-ms', 150));
const MAX_BYTES = 12 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function getJson(path) {
  const response = await fetch(base + path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}
const cache = new Map();
async function loadModel(url) {
  if (cache.has(url)) return cache.get(url);
  await sleep(pauseMs);
  const response = await fetch(base + url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error(`${url}: ${bytes.length} bytes, over the scan limit`);
  const parsed = glbBatches(bytes);
  cache.set(url, parsed);
  return parsed;
}

const templates = [];
let cursor = null;
do {
  const page = await getJson('/api/catalog?limit=100' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
  templates.push(...page.templates);
  cursor = page.nextCursor || null;
} while (cursor);

const seen = new Set();
const rows = [];
for (const template of templates) {
  const key = `${template.modelUrl}|${template.modelMidUrl}|${template.modelFarUrl}`;
  if (!template.modelUrl || seen.has(key)) continue;
  seen.add(key);
  const row = { templateId: template.templateId, name: template.name, modelUrl: template.modelUrl, tiers: {} };
  if (!template.modelMidUrl && !template.modelFarUrl) {
    row.status = 'no stored versions';
    rows.push(row);
    continue;
  }
  try {
    const full = await loadModel(template.modelUrl);
    for (const [tier, url] of [['mid', template.modelMidUrl], ['far', template.modelFarUrl]]) {
      if (!url) { row.tiers[tier] = { status: 'none' }; continue; }
      const parsed = await loadModel(url);
      const report = silhouetteFidelity(full.batches, parsed.batches);
      row.tiers[tier] = { triangles: parsed.triangles, coverage: +report.coverage.toFixed(2), extra: +report.extra.toFixed(2), areaKept: +report.areaKept.toFixed(2), openGrowth: +report.openGrowth.toFixed(2), faithful: isFaithful(report, tier) }; // #4114: surface kept and open-edge growth beside the outline
    }
    row.fullTriangles = full.triangles;
    row.status = Object.values(row.tiers).every((t) => t.status === 'none' || t.faithful) ? 'ok' : 'FAILS';
  } catch (error) {
    row.status = `skipped: ${error.message}`;
  }
  rows.push(row);
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const fmt = (t) => (t ? (t.status === 'none' ? 'none' : `${t.triangles} tris, covers ${t.coverage}, extra ${t.extra}, surface kept ${t.areaKept}, open edges x${t.openGrowth}${t.faithful ? '' : '  <-- fails'}`) : '');
  for (const row of rows) {
    console.log(`${row.status.padEnd(18)} ${row.name} (${row.templateId.slice(0, 8)})${row.fullTriangles ? `  full ${row.fullTriangles} tris` : ''}`);
    if (row.tiers.mid || row.tiers.far) console.log(`    mid: ${fmt(row.tiers.mid)}\n    far: ${fmt(row.tiers.far)}`);
  }
  const fails = rows.filter((r) => r.status === 'FAILS');
  console.log(`\n${rows.length} distinct models scanned: ${fails.length} fail, ${rows.filter((r) => r.status === 'ok').length} ok, ${rows.filter((r) => r.status === 'no stored versions').length} without stored versions, ${rows.filter((r) => String(r.status).startsWith('skipped')).length} skipped.`);
}
