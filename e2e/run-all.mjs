#!/usr/bin/env node
// Runs every e2e/*.test.mjs file against a locally-run wrangler dev, one at
// a time, each against a completely fresh D1 database.
//
// Why fresh D1 per file, not once for the whole run: a shared local D1
// instance's landlets get claimed and never released across test files —
// after a handful of claims in one run, the claim modal's map has nothing
// left to offer and #claim-confirm-btn stays permanently disabled for every
// later test. This isn't a real regression, just the shared-world dev
// database running out of greenbelt landlets — resetting between files
// avoids it entirely rather than requiring each test to clean up after
// itself (which claiming and placing don't have any real UI path to do
// anyway; that's not a feature builders need).
//
// Usage:
//   node e2e/run-all.mjs                  # run every *.test.mjs file
//   node e2e/run-all.mjs smoke.test.mjs    # run just this one
import { execSync, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const PORT = process.env.E2E_PORT || '8787';
const BASE_URL = `http://localhost:${PORT}`;

function sh(cmd) {
  execSync(cmd, { stdio: 'inherit', cwd: repoRoot });
}

// Killing only `workerd serve` isn't enough — the wrangler-dev parent
// process notices its child died and immediately respawns a fresh one,
// leaving the port bound and the next test's D1 reset unable to take
// effect. Both layers need killing together.
function killWranglerFamily() {
  try {
    execSync("pkill -f 'wrangler dev' || true", { cwd: repoRoot });
  } catch { /* no matching process — fine */ }
  try {
    execSync("pkill -f 'workerd serve' || true", { cwd: repoRoot });
  } catch { /* no matching process — fine */ }
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/api/catalog?limit=1`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`wrangler dev did not become ready within ${timeoutMs}ms`);
}

async function runOneTest(testFile) {
  console.log(`\n=== ${testFile} ===`);
  killWranglerFamily();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  sh('rm -rf .wrangler/state');
  sh('npx wrangler d1 migrations apply higglehaven-db --local');

  const wrangler = spawn('npx', ['wrangler', 'dev', '--local', '--port', PORT], {
    cwd: repoRoot,
    stdio: 'ignore',
    detached: true,
  });

  let passed = false;
  try {
    await waitForServer();
    execSync(`node ${JSON.stringify(path.join(__dirname, testFile))}`, {
      stdio: 'inherit',
      cwd: repoRoot,
    });
    passed = true;
  } catch (err) {
    console.error(`FAILED: ${testFile}`);
  } finally {
    try {
      // Negative pid signals the whole detached process group, not just
      // the immediate wrangler-dev process — see killWranglerFamily above
      // for why the child (workerd) needs killing too either way.
      process.kill(-wrangler.pid, 'SIGTERM');
    } catch { /* already gone */ }
    killWranglerFamily();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return passed;
}

const args = process.argv.slice(2);
const allTestFiles = readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();
const testsToRun = args.length > 0 ? args : allTestFiles;

if (testsToRun.length === 0) {
  console.error('No e2e test files found (expected e2e/*.test.mjs).');
  process.exit(1);
}

console.log('Building the frontend once for this run (wrangler dev serves dist/, not raw src/)...');
sh('npm run build');

console.log(`\nRunning ${testsToRun.length} e2e test file(s), fresh D1 per file:\n${testsToRun.join('\n')}`);

const failures = [];
for (const testFile of testsToRun) {
  const ok = await runOneTest(testFile);
  if (!ok) failures.push(testFile);
}

console.log('\n=== e2e summary ===');
console.log(`${testsToRun.length - failures.length}/${testsToRun.length} passed`);
if (failures.length > 0) {
  console.log('Failed:', failures.join(', '));
  process.exit(1);
}
