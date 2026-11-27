#!/usr/bin/env node
// #4529: picks the e2e files a branch adds or changes, so CI can run just those files three
// times before the branch merges (the `e2e-stability-changed-files` job in .github/workflows/ci.yml).
//
// Why: in one day, 13 of the 17 red CI runs were two e2e files that were merged after one green
// run and then failed about half the time (shop-avatar-crowding-barrier: a random spawn distance;
// shop-other-avatar-afk). The in-job retry re-runs a failed file once, which cannot rescue a test
// that fails at a fixed rate, and nobody ran the new file twice before it merged. Each red run cost
// about an hour and a full new run for the author. A file that passes three fresh-D1 runs in a row
// is not proven stable, but one that fails half the time is caught on its own first push.
//
// Only e2e/*.test.mjs files this branch adds, modifies or renames count (a deleted file has
// nothing to run, and a changed helper does not name a test). The list is capped so a branch
// that touches dozens of tests does not turn into a 30-file job; the cap is stated in the job
// summary and the rest still runs once in the ordinary shards.
//
// Usage (CI):   node scripts/changed-e2e-files.mjs select            # diff against origin/main
//               node scripts/changed-e2e-files.mjs summary <log-file> # table for $GITHUB_STEP_SUMMARY
// Usage (local dry run, no git needed):
//               E2E_STABILITY_FILES="a.test.mjs b.test.mjs" node scripts/changed-e2e-files.mjs select
// `select` prints one JSON line and, when GITHUB_OUTPUT is set, writes files, count, run_list and
// capped for later steps. run_list repeats each file REPEATS times in a row (a.a.a.b.b.b), which
// e2e/run-all.mjs runs one after another, each against a fresh D1, with one build and one migration
// apply for the whole job.

// No top-level node: imports: the unit tests run this file in the Workers test pool, where
// child_process is not available, so the CLI half loads what it needs only when it runs.

export const MAX_FILES = 6;
export const REPEATS = 3;

// A bare file name only: the value goes into a shell command line in the workflow, so anything
// that is not a plain e2e test file name is dropped here rather than quoted there.
const E2E_PATH = /^e2e\/([A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs)$/;
const BARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/;

// names: paths as `git diff --name-only` prints them (relative to the repo root), or bare file
// names when E2E_STABILITY_FILES is used. exists: lets a caller drop a name whose file is gone.
export function selectChangedE2eFiles(names, { max = MAX_FILES, repeats = REPEATS, exists = () => true } = {}) {
  const seen = new Set();
  for (const raw of names) {
    const name = String(raw).trim();
    const match = E2E_PATH.exec(name);
    const bare = match ? match[1] : (BARE_NAME.test(name) ? name : null);
    if (bare && exists(bare)) seen.add(bare);
  }
  const all = [...seen].sort();
  const files = all.slice(0, max);
  const runList = files.flatMap((file) => Array(repeats).fill(file));
  return { files, total: all.length, capped: all.length > files.length, runList };
}

// log: the combined output of e2e/run-all.mjs. It prints one `PASS: <file> (<ms>ms)` or
// `FAIL: <file> (<ms>ms) (...)` line per run, in run order; a file run three times appears three times.
export function parseRuns(log) {
  const runs = [];
  for (const line of String(log).split('\n')) {
    const match = /(?:^|\s)(PASS|FAIL): (\S+\.test\.mjs)(?: \((\d+)ms\))?/.exec(line);
    if (match) runs.push({ verdict: match[1], file: match[2], ms: match[3] === undefined ? null : Number(match[3]) });
  }
  return runs;
}

export function summarizeRuns(log, { repeats = REPEATS, total = null, capped = false, max = MAX_FILES } = {}) {
  const runs = parseRuns(log);
  const byFile = new Map();
  for (const run of runs) {
    if (!byFile.has(run.file)) byFile.set(run.file, []);
    byFile.get(run.file).push(run);
  }
  const rows = [...byFile.entries()].map(([file, list]) => {
    const passed = list.filter((run) => run.verdict === 'PASS').length;
    return {
      file,
      ran: list.length,
      passed,
      stable: list.length >= repeats && passed === list.length,
      seconds: list.map((run) => (run.ms === null ? '?' : (run.ms / 1000).toFixed(0))),
    };
  });
  const lines = [`### e2e stability: files this branch adds or changes, run ${repeats} times each`, ''];
  if (rows.length === 0) {
    lines.push('No run lines found in the log (the job stopped before any file ran).');
    return lines.join('\n');
  }
  lines.push('| file | passed | seconds per run | verdict |', '| --- | --- | --- | --- |');
  for (const row of rows) {
    let verdict = 'stable';
    if (row.passed < row.ran) verdict = 'FLAKY: failed in some runs';
    else if (row.ran < repeats) verdict = 'incomplete (job stopped early)';
    lines.push(`| ${row.file} | ${row.passed}/${row.ran} | ${row.seconds.join(', ')} | ${verdict} |`);
  }
  if (capped) {
    lines.push('', `This branch changes ${total} e2e files; only the first ${max} (alphabetically) were run ${repeats} times here. The rest ran once in the ordinary shards.`);
  }
  return lines.join('\n');
}

// The whole `select` step, with every outside effect passed in so a test can drive it.
// override: E2E_STABILITY_FILES (local dry run); gitNames(): the diff; exists(bare): file present.
// Returns the JSON line to print and the step outputs to write.
export function runSelect({ override = '', gitNames = () => [], exists = () => true } = {}) {
  const names = override ? override.split(/\s+/).filter(Boolean) : gitNames();
  const picked = selectChangedE2eFiles(names, { exists });
  return {
    json: { files: picked.files, total: picked.total, capped: picked.capped, runs: picked.runList.length },
    outputs: {
      files: picked.files.join(' '),
      count: picked.files.length,
      run_list: picked.runList.join(' '),
      total: picked.total,
      capped: picked.capped,
    },
  };
}

async function main(argv) {
  const [command, arg] = argv;
  const { execFileSync } = await import('node:child_process');
  const { appendFileSync, existsSync, readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (command === 'select') {
    const result = runSelect({
      override: process.env.E2E_STABILITY_FILES,
      // Three dots: what this branch changed since it left main, not what main changed since.
      // AMR: added, modified, renamed (the new name). A deleted file has nothing to run.
      gitNames: () => execFileSync('git', ['diff', '--name-only', '--diff-filter=AMR', 'origin/main...HEAD'], { encoding: 'utf8' }).split('\n').filter(Boolean),
      exists: (bare) => existsSync(path.join(repoRoot, 'e2e', bare)),
    });
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result.outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
    }
    console.log(JSON.stringify(result.json));
    return 0;
  }
  if (command === 'summary') {
    if (!arg || !existsSync(arg)) {
      console.log('### e2e stability\n\nNo log file to summarise.');
      return 0;
    }
    const total = process.env.E2E_STABILITY_TOTAL ? Number(process.env.E2E_STABILITY_TOTAL) : null;
    console.log(summarizeRuns(readFileSync(arg, 'utf8'), { total, capped: process.env.E2E_STABILITY_CAPPED === 'true' }));
    return 0;
  }
  console.error('Usage: changed-e2e-files.mjs select | summary <log-file>');
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv.slice(2)));
}
