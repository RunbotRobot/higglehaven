#!/usr/bin/env node
// Gives every existing product mid and far models (#3415, Model tiers 3/7,
// part of #3412). Products uploaded before #3414 have no simplified versions;
// this finds them, makes the tiers with the same code an upload runs, stores
// them the way an upload does (content-addressed objects in the MODELS
// bucket) and records them on the product. The selection, checks and
// recording rules are in backfill-model-tiers-lib.mjs, which has the tests.
//
//   node scripts/backfill-model-tiers.mjs --remote --dry-run     # what would be done
//   node scripts/backfill-model-tiers.mjs --remote               # production
//   node scripts/backfill-model-tiers.mjs --local                # the wrangler dev database
//
// Flags: --local | --remote (required; there is no default, so a run never
// reaches production by accident), --dry-run, --limit <n> (models per run),
// --max-total-bytes <n> (stop storing past this many bytes, default 200 MB),
// --database <name>, --bucket <name>, --persist-to <dir> (with --local: use that
// wrangler state directory instead of the default one).
//
// --redo-cracked (#3527, #4062): instead of products with no tiers, look at products
// that HAVE them. A tier is also redone when it no longer reads as the model (its silhouette from the
// six axes, src/tierFidelity.js), which is how the owner's brick wall turned into a net. Tiers made before #3528 can have holes along the model's UV
// and normal seams; this counts the hole edges of each stored tier and of the
// full model, and for a product whose tier has more it makes both tiers again
// with the current code and swaps them in (only on rows still pointing at the
// old tiers). A product with nothing cracked is left exactly as it is. Combine
// with --dry-run to see how many models it would check, --limit to do some at a
// time.
//
// Why wrangler and not the public API. The seller-side routes that record
// tiers (PATCH /api/catalog/:id) belong to each product's own seller session,
// which a script does not have for other people's products, and
// POST /api/models is rate limited per IP. The repo's established route for a
// one-off operator task is wrangler against the real database and bucket
// (AGENTS.md, "If the Cloudflare MCP connector says it needs authorization"),
// so this needs CLOUDFLARE_API_TOKEN for --remote and nothing else. It does
// the same checks the server applies to an upload (valid .glb, size limit, a
// tier must be smaller than its model) before it stores anything.
//
// Run it from main, after the PR that adds it has merged and migration 0220
// has been applied (npm run db:migrate:remote), by a session with wrangler
// access. Re-running is safe: a product that has tiers is never touched, and
// one that failed or was not reached is picked up again.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glbBatches } from './glb-batches-lib.mjs';
import { silhouetteFidelity, isFaithful } from '../src/tierFidelity.js';
import {
  CANDIDATES_SQL, CRACKED_CANDIDATES_SQL, GLB_CONTENT_TYPE, buildRecordStatements, buildRecordedCountStatement, buildReplaceStatements, formatRedoSummary,
  formatSummary, groupCandidates, groupCrackCandidates, parseArgs, runBackfill, runRedoCracked,
} from './backfill-model-tiers-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wranglerBin = path.join(root, 'node_modules', '.bin', 'wrangler');

function fail(message) {
  console.error(message);
  process.exit(1);
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  fail(`${err.message}\nUsage: node scripts/backfill-model-tiers.mjs (--local | --remote) [--dry-run] [--redo-cracked] [--limit n] [--max-total-bytes n]`);
}
if (options.mode === 'remote' && !process.env.CLOUDFLARE_API_TOKEN) {
  fail('--remote needs CLOUDFLARE_API_TOKEN in the environment (wrangler cannot reach production without it). Nothing was changed.');
}

// wrangler prints its banner to stderr, so stdout is only the command's own output.
function wrangler(args) {
  return execFileSync(wranglerBin, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// wrangler's own flags for choosing the target: --local/--remote, and for a
// local run optionally which state directory to use.
const targetFlags = [`--${options.mode}`, ...(options.persistTo ? ['--persist-to', options.persistTo] : [])];

function runSql(sql) {
  const out = wrangler(['d1', 'execute', options.database, ...targetFlags, '--json', '--command', sql]);
  const start = out.indexOf('[');
  return JSON.parse(out.slice(start));
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-tiers-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

async function main() {
  const rows = runSql(options.redoCracked ? CRACKED_CANDIDATES_SQL : CANDIDATES_SQL)[0].results;
  const { candidates, unrecognised, builtIn } = options.redoCracked ? groupCrackCandidates(rows) : groupCandidates(rows);
  for (const url of builtIn) console.log(`Built-in model, no stored versions by design (the viewer builds them): ${url}`);
  for (const url of unrecognised) console.warn(`Not a stored model, left alone: ${url}`);
  console.log(`Target: ${options.mode} database "${options.database}", bucket "${options.bucket}"${options.dryRun ? ' (dry run)' : ''}`);
  console.log(`${options.redoCracked ? 'Products with tiers' : 'Products without tiers'}: ${rows.length} rows over ${candidates.length} distinct models`);

  let browser = null;
  let server = null;
  let page = null;
  async function pageForGeneration() {
    if (page) return page;
    const { createServer } = await import('vite');
    const { chromium } = await import('playwright');
    server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
    await server.listen();
    const address = server.httpServer.address();
    browser = await chromium.launch();
    page = await browser.newPage();
    page.on('pageerror', (err) => console.warn(`page error: ${err.message}`));
    await page.goto(`http://127.0.0.1:${address.port}/scripts/backfill-model-tiers-page.html`);
    await page.waitForFunction(() => window.backfillTiersReady === true, null, { timeout: 120000 });
    return page;
  }

  const io = {
    async readModel(key) {
      const file = path.join(scratch, 'full.glb');
      fs.rmSync(file, { force: true });
      wrangler(['r2', 'object', 'get', `${options.bucket}/${key}`, '--file', file, ...targetFlags]);
      return new Uint8Array(fs.readFileSync(file));
    },
    async generateTiers(bytes) {
      const target = await pageForGeneration();
      const result = await target.evaluate((base64) => window.backfillTiers(base64), Buffer.from(bytes).toString('base64'));
      return {
        skinned: result.skinned,
        mid: result.mid ? new Uint8Array(Buffer.from(result.mid, 'base64')) : null,
        far: result.far ? new Uint8Array(Buffer.from(result.far, 'base64')) : null,
      };
    },
    async storeTier(key, bytes) {
      const file = path.join(scratch, 'tier.glb');
      fs.writeFileSync(file, bytes);
      wrangler(['r2', 'object', 'put', `${options.bucket}/${key}`, '--file', file, '--content-type', GLB_CONTENT_TYPE, ...targetFlags]);
    },
    async holeEdges(bytes) {
      const target = await pageForGeneration();
      return target.evaluate((base64) => window.countHoleEdges(base64), Buffer.from(bytes).toString('base64'));
    },
    // #4062: pure maths on the .glb triangles (no browser needed), the same check the generator applies.
    async fidelity(fullBytes, tierBytes, tier) {
      const full = glbBatches(Buffer.from(fullBytes));
      const parsed = glbBatches(Buffer.from(tierBytes));
      return isFaithful(silhouetteFidelity(full.batches, parsed.batches), tier);
    },
    async replaceTiers(modelUrl, oldTiers, urls) {
      for (const statement of buildReplaceStatements(modelUrl, oldTiers, urls)) runSql(statement);
      return runSql(buildRecordedCountStatement(modelUrl, urls))[0].results[0].recorded;
    },
    async recordTiers(modelUrl, urls) {
      for (const statement of buildRecordStatements(modelUrl, urls)) runSql(statement);
      return runSql(buildRecordedCountStatement(modelUrl, urls))[0].results[0].recorded;
    },
  };

  try {
    const run = options.redoCracked ? runRedoCracked : runBackfill;
    const summary = await run({
      candidates, io, dryRun: options.dryRun, limit: options.limit, maxTotalBytes: options.maxTotalBytes, log: (line) => console.log(line),
    });
    console.log(options.redoCracked ? formatRedoSummary(summary) : formatSummary(summary));
    if (!options.dryRun && !options.redoCracked) {
      const left = groupCandidates(runSql(CANDIDATES_SQL)[0].results).candidates.length;
      console.log(`  models still without tiers afterwards: ${left}`);
    }
    process.exitCode = summary.failed.length > 0 ? 1 : 0;
  } finally {
    await browser?.close();
    await server?.close();
  }
}

main().catch((err) => fail(err.stack || err.message));
