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
//
// Each file's own output (migration-apply table, the test's own console
// output, and on failure its wrangler-dev tail) is captured rather than
// streamed live, and only a failing file's buffer gets printed — at the very
// end of the whole run, after every other file has already finished (#2134).
// Why: CI's log-retrieval tools truncate to roughly the last ~500KB of a
// job's log regardless of how far back they're asked to go, so on a large
// shard a file positioned early (e.g. 11th of 40) had its own diagnostics
// pushed outside that window by everything printed after it, making a real
// failure undiagnosable from CI output alone. Printing failing files' full
// detail last, in a run whose own total output this suite's current shard
// sizes keep well under that ceiling, guarantees it survives instead.
import { execSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
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

// Like sh(), but captures the command's combined stdout+stderr instead of
// streaming it straight to this process's own output — see this file's own
// top comment (#2134) for why. `2>&1` merges stderr into the same pipe as
// stdout at the shell level, so the two interleave in their real
// chronological order rather than arriving as two separately-ordered
// buffers.
function execCapture(cmd) {
  try {
    // Node's own default maxBuffer (1MB) is comfortably under a single
    // file's typical output but not a guaranteed ceiling (the migration
    // table alone is tens of KB) — raised well above anything one file is
    // expected to print, so a verbose file gets ERR_CHILD_PROCESS_STDIO_
    // MAXBUFFER instead of this capture silently losing the real failure.
    const output = execSync(`${cmd} 2>&1`, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    return { output, failed: false };
  } catch (err) {
    return { output: typeof err.stdout === 'string' ? err.stdout : '', failed: true };
  }
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

// #2673: when `wrangler dev` itself crashes mid-test (as opposed to the
// Worker returning an ordinary error response), the real error text never
// reaches the stdout/stderr tail captured below at all -- wrangler prints
// only "✘ [ERROR]" plus a pointer to a log file on disk
// (~/.config/.wrangler/logs/wrangler-<timestamp>.log) and writes the actual
// message there instead. CI doesn't upload that file as an artifact, so a
// server crash like this previously left nothing to diagnose from beyond
// the ANSI-code remnants that survive in stdout. Snapshotting this
// directory's contents before each test file's own `wrangler dev` starts,
// then diffing after a failure, finds exactly the log file(s) that run's
// own crash (if any) wrote, without needing to know wrangler's own naming
// scheme or timestamp format up front.
const WRANGLER_LOG_DIR = path.join(os.homedir(), '.config', '.wrangler', 'logs');
const WRANGLER_CRASH_LOG_MAX_CHARS = 50_000;

function listWranglerLogFiles() {
  try {
    return new Set(readdirSync(WRANGLER_LOG_DIR));
  } catch {
    // Directory doesn't exist yet (e.g. wrangler has never crashed/logged
    // on this machine) -- same as "no new files", not an error.
    return new Set();
  }
}

// Reads whatever log file(s) appeared in WRANGLER_LOG_DIR since
// `before` was snapshotted, tail-capped the same way the in-memory
// stdout/stderr capture above already is. Best-effort: a file that's
// gone, unreadable, or mid-write by the time this runs just gets skipped
// rather than failing the whole diagnostic attempt.
function readNewWranglerLogFiles(before) {
  const after = listWranglerLogFiles();
  const newFiles = [...after].filter((name) => !before.has(name)).sort();
  const sections = [];
  for (const name of newFiles) {
    try {
      let content = readFileSync(path.join(WRANGLER_LOG_DIR, name), 'utf8');
      if (content.length > WRANGLER_CRASH_LOG_MAX_CHARS) {
        content = content.slice(content.length - WRANGLER_CRASH_LOG_MAX_CHARS);
      }
      sections.push(`--- ${name} ---\n${content}`);
    } catch {
      // Skip unreadable/already-cleaned-up files -- nothing more to do.
    }
  }
  return sections;
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
  let log = `\n=== ${testFile} ===\n`;
  killWranglerFamily();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  sh('rm -rf .wrangler/state');
  const migrationResult = execCapture('npx wrangler d1 migrations apply higglehaven-db --local');
  log += migrationResult.output;
  if (migrationResult.failed) {
    log += `\nFAILED: ${testFile} (migration apply itself failed, before the test ever ran)\n`;
    return { passed: false, log };
  }

  const wranglerLogFilesBefore = listWranglerLogFiles();
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
    const testResult = execCapture(`node ${JSON.stringify(path.join(__dirname, testFile))}`);
    log += testResult.output;
    passed = !testResult.failed;
    if (!passed) log += `\nFAILED: ${testFile}\n`;
  } catch (err) {
    log += `\nFAILED: ${testFile} (${err.message})\n`;
  }
  if (!passed) {
    // wrangler dev relays the Worker's own runtime console.* calls back to
    // its CLI output asynchronously (over the inspector protocol, not a
    // direct pipe from the request handler) — reading the captured buffer
    // in the same tick as the failure risked missing a console.error the
    // Worker had already made but wrangler hadn't relayed yet (confirmed:
    // a real HTTP 500 in a run showed nothing here but the startup banner,
    // even though worker/index.js's own catch-all does console.error every
    // unclassified error). A short grace period lets it land first.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    log += `\n--- wrangler dev server output for ${testFile} (tail, may explain the failure above) ---\n`;
    log += wranglerLog || '(no server output captured)';
    log += `\n--- end wrangler dev server output for ${testFile} ---\n`;
    const crashLogSections = readNewWranglerLogFiles(wranglerLogFilesBefore);
    if (crashLogSections.length > 0) {
      log += `\n--- wrangler dev crash log file(s) for ${testFile} (${WRANGLER_LOG_DIR}, written when wrangler itself errors out -- see this file's own #2673 comment) ---\n`;
      log += crashLogSections.join('\n');
      log += `\n--- end wrangler dev crash log file(s) for ${testFile} ---\n`;
    }
  }
  try {
    // Negative pid signals the whole detached process group, not just
    // the immediate wrangler-dev process — see killWranglerFamily above
    // for why the child (workerd) needs killing too either way.
    process.kill(-wrangler.pid, 'SIGTERM');
  } catch { /* already gone */ }
  killWranglerFamily();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { passed, log };
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
const failureLogs = [];
for (const testFile of testsToRun) {
  const { passed, log } = await runOneTest(testFile);
  // A one-line progress indicator per file, printed live — the full
  // diagnostics (buffered above, not streamed) only get printed for a
  // failing file, and only at the very end of the whole run (#2134).
  console.log(passed ? `PASS: ${testFile}` : `FAIL: ${testFile} (full output printed at the end of this run)`);
  if (!passed) {
    failures.push(testFile);
    failureLogs.push({ testFile, log });
  }
}

console.log('\n=== e2e summary ===');
console.log(`${testsToRun.length - failures.length}/${testsToRun.length} passed`);
if (failures.length > 0) {
  console.log('Failed:', failures.join(', '));
  console.log('\n=== full diagnostics for the failing file(s) above, printed last so CI\'s log-truncation keeps them (#2134) ===');
  for (const { testFile, log } of failureLogs) {
    console.log(log);
  }
  process.exit(1);
}
