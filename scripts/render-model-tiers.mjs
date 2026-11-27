#!/usr/bin/env node
// #4111 point 2: draws each catalogue model and its stored mid and far versions from the six axes under the
// Shop's lights, at the size on screen where that version takes over, and reports how different the two pictures
// are (worst view): the shift of the mean colour and the mean per-pixel difference over the covered cells.
// Read-only, like scripts/scan-model-tiers.mjs: it downloads public files and writes nothing. It needs Chromium
// (software GL is fine, the figures are of colour, not speed) and reads textures, which the scan cannot.
// Reading the figures: the colour shift compares one face-on view at a time, so a model whose faces differ (a brick's
// end against its front) shows a shift from one axis that a distant wall of them, seen from the front, never does;
// it is a diagnostic to point at the models worth a still, not a gate, and nothing stored or generated reads it.
//
//   NODE_USE_ENV_PROXY=1 node scripts/render-model-tiers.mjs [--url http://127.0.0.1:8787] [--json] [--mid-px 80] [--far-px 24]
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const base = valueOf('--url', 'https://higglehaven.com').replace(/\/$/, '');
const asJson = args.includes('--json');
const SIZES = { mid: Number(valueOf('--mid-px', 80)), far: Number(valueOf('--far-px', 24)) };
const LIMITS = { colourShift: 0.08, pixelDiff: 0.12 }; // a first reading of "cannot be told apart"; tune against the stills
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const response = await fetch(base + url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}
const cache = new Map();
async function loadBase64(url) {
  if (cache.has(url)) return cache.get(url);
  await sleep(150);
  const response = await fetch(base + url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const text = Buffer.from(await response.arrayBuffer()).toString('base64');
  cache.set(url, text);
  return text;
}

const templates = [];
let cursor = null;
do {
  const page = await getJson('/api/catalog?limit=100' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
  templates.push(...page.templates);
  cursor = page.nextCursor || null;
} while (cursor);

const { createServer } = await import('vite');
const { chromium } = await import('playwright');
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.warn(`page error: ${err.message}`));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/render-model-tiers-page.html`);
  await page.waitForFunction(() => window.renderTiersReady === true, null, { timeout: 120000 });
  const seen = new Set();
  const rows = [];
  for (const template of templates) {
    const key = `${template.modelUrl}|${template.modelMidUrl}|${template.modelFarUrl}`;
    if (!template.modelUrl || seen.has(key) || (!template.modelMidUrl && !template.modelFarUrl)) continue;
    seen.add(key);
    const row = { templateId: template.templateId, name: template.name, tiers: {} };
    try {
      const full = await loadBase64(template.modelUrl);
      for (const [tier, url] of [['mid', template.modelMidUrl], ['far', template.modelFarUrl]]) {
        if (!url) continue;
        const result = await page.evaluate(([a, b, size]) => window.compareRendered(a, b, size), [full, await loadBase64(url), SIZES[tier]]);
        row.tiers[tier] = { colourShift: result.colourShift, pixelDiff: result.pixelDiff, visible: result.colourShift > LIMITS.colourShift || result.pixelDiff > LIMITS.pixelDiff };
      }
      row.status = Object.values(row.tiers).some((t) => t.visible) ? 'DIFFERS' : 'ok';
    } catch (error) {
      row.status = `skipped: ${error.message}`;
    }
    rows.push(row);
  }
  if (asJson) console.log(JSON.stringify(rows, null, 2));
  else {
    for (const row of rows) {
      console.log(`${row.status.padEnd(10)} ${row.name} (${row.templateId.slice(0, 8)})`);
      for (const [tier, t] of Object.entries(row.tiers)) console.log(`    ${tier} at ${SIZES[tier]} px: colour shift ${t.colourShift}, pixel difference ${t.pixelDiff}${t.visible ? '  <-- visible' : ''}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
