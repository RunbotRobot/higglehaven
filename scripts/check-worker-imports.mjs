#!/usr/bin/env node
// #2684: worker/index.js <-> worker/lib/*.js extraction PRs have twice
// (issue-2529's own Control Room note, worker/lib/land-cap.js's own
// header comment on the #2538 fix) left a stale/renamed `import { x }
// from '...'` behind -- wrangler's esbuild bundling tolerated it with no
// bundle-time error, but `wrangler dev` then hung indefinitely instead of
// crashing, burning real CI time until a session finally root-caused it
// by reproducing `wrangler dev` locally. Neither `npm test` (vitest-pool-
// workers' own miniflare bundling) nor `npm run build` (Vite, frontend
// only, never touches worker/) catches this today.
//
// Node's own native ESM loader validates this for free: a static
// `import { x } from './y.js'` where y.js doesn't actually export `x`
// throws a precise SyntaxError at module-link time, before any code
// runs. So rather than a hand-rolled AST/export resolver, this just
// imports every real worker/ source file under plain Node once (the one
// wrinkle -- worker/index.js's bare `.json` import -- is handled by
// json-module-loader-hooks.mjs alongside this file) and fails loudly if
// any of them doesn't link cleanly. Run as `pretest` (see package.json),
// alongside the existing migration checks, so this surfaces immediately
// via `npm test` instead of only as an unexplained CI hang discovered
// hours later.
import { readdirSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workerDir = join(repoRoot, 'worker');

// worker/test-helpers.js imports the `cloudflare:test` virtual module
// vitest-pool-workers provides -- real test scaffolding (every worker/
// *.test.js file imports it the same way; those are already excluded by
// the .test.js filter below), never part of the actual deployed Worker
// bundle wrangler builds. Node's own loader can't resolve a `cloudflare:`
// specifier at all ("Only URLs with a scheme in: file, data, and node are
// supported"), so this is a deliberate exclusion, not a gap this check
// should have caught.
const EXCLUDED_FILENAMES = new Set(['test-helpers.js']);

// Exported for direct testing -- lists every non-test .js source file
// under `dir`, recursing into subdirectories (worker/lib/ as of this
// writing). Pure aside from the injectable readdir implementation, same
// shape as this repo's other check-*.mjs scripts' own file-discovery
// helpers (e.g. check-test-file-size.mjs's listTestFiles).
export function listSourceFiles(dir, readdirImpl = readdirSync) {
  const entries = readdirImpl(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full, readdirImpl));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') && !EXCLUDED_FILENAMES.has(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

// Imports `fileUrl` under Node's own native ESM loader and reports
// whether it linked cleanly -- see this file's own header for why a real
// `import()` is the mechanism here, not a hand-rolled export resolver.
// Exported for direct testing against a synthetic module graph (the
// json-module-loader-hooks.mjs hook only matters for real worker/ files
// that import a .json sibling, so a synthetic test graph of plain .mjs
// modules can exercise this directly, hook or no hook).
export async function checkModuleImports(fileUrl) {
  try {
    await import(fileUrl);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

async function main() {
  register('./json-module-loader-hooks.mjs', import.meta.url);

  const files = listSourceFiles(workerDir);
  const failures = [];
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop -- each import can itself
    // register more loader state; running these concurrently risks
    // cross-file interference for no real speed win (this is ~35 files).
    const result = await checkModuleImports(pathToFileURL(file).href);
    if (!result.ok) failures.push({ file, error: result.error });
  }

  if (failures.length > 0) {
    console.error(
      'worker/ module(s) failed to import cleanly under Node\'s own ESM loader -- this is exactly the ' +
      'dead/renamed-export bug class that has previously only surfaced as an unexplained `wrangler dev` ' +
      'hang hours into CI (see this script\'s own header comment, #2529/#2538):',
    );
    for (const { file, error } of failures) {
      console.error(`  ${file.slice(repoRoot.length + 1)}: ${error.message}`);
    }
    console.error('Fix the stale import (or the export it should be importing) before pushing.');
    process.exit(1);
  }

  console.log(`All ${files.length} worker/ source file(s) imported cleanly under Node's own ESM loader.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
