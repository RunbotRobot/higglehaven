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
// A literal IP, not the "localhost" hostname — Node/Chromium's dual-stack
// DNS resolution can intermittently try ::1 first (Happy Eyeballs), and a
// request that lands there gets refused outright if wrangler dev is only
// actually listening on the IPv4 loopback (or vice versa). Locally this
// never seems to bite, but on GitHub's runners it shows up as sporadic,
// otherwise-inexplicable "Failed to fetch" errors on an unpredictable file
// each run (seen hitting both a raw e2e-helper fetch and the real app's
// own fetch calls) — a literal address sidesteps the resolution race
// entirely rather than trying to win it. --ip below pins the server side
// to match.
const BASE_URL = `http://127.0.0.1:${PORT}`;

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

  const wrangler = spawn('npx', ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', PORT], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  // Kept only so a failure can show wrangler dev's own server-side output
  // (a stack trace behind a 500, a D1 lock error, etc.) — previously
  // discarded entirely via stdio: 'ignore', which left a real backend
  // error in a test run with nothing but "failed with HTTP 500" and no way
  // to see why. Capped and rolling so a long-running file's full request
  // log doesn't balloon memory; only the tail end (closest to the actual
  // failure) matters for diagnosis.
  const WRANGLER_LOG_MAX_CHARS = 50_000;
  let wranglerLog = '';
  const captureWranglerOutput = (chunk) => {
    wranglerLog += chunk.toString();
    if (wranglerLog.length > WRANGLER_LOG_MAX_CHARS) {
      wranglerLog = wranglerLog.slice(wranglerLog.length - WRANGLER_LOG_MAX_CHARS);
    }
  };
  wrangler.stdout.on('data', captureWranglerOutput);
  wrangler.stderr.on('data', captureWranglerOutput);

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
    // wrangler dev relays the Worker's own runtime console.* calls back to
    // its CLI output asynchronously (over the inspector protocol, not a
    // direct pipe from the request handler) — reading the captured buffer
    // in the same tick as the failure risked missing a console.error the
    // Worker had already made but wrangler hadn't relayed yet (confirmed:
    // a real HTTP 500 in a run showed nothing here but the startup banner,
    // even though worker/index.js's own catch-all does console.error every
    // unclassified error). A short grace period lets it land first.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log(`\n--- wrangler dev server output for ${testFile} (tail, may explain the failure above) ---`);
    console.log(wranglerLog || '(no server output captured)');
    console.log(`--- end wrangler dev server output for ${testFile} ---\n`);
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
