#!/usr/bin/env node
// #3003: regenerates e2e/shard-weights.json (the per-file duration
// snapshot scripts/bin-pack-e2e-shards.mjs's own discover-e2e-files step
// bin-packs from) by scraping a real CI run's own e2e-tests job logs for
// the elapsed-ms figure e2e/run-all.mjs now prints on every `PASS:`/
// `FAIL:` line (added alongside this script, same PR).
//
// Usage: node scripts/update-shard-weights.mjs <run_id> [owner/repo]
// Requires `gh` (Claude Code's own built-in GitHub API client) on PATH --
// same fleet-session-dev-tool shape as scripts/check-ci-shard-progress.mjs.
//
// Run this against any green (or even partially-green -- a file's own
// elapsed-ms line is real regardless of whether some *other* file in the
// same shard later failed) e2e-tests run, any time the suite's file list
// or relative weights have drifted enough to be worth re-measuring. Merges
// into whatever e2e/shard-weights.json already has rather than replacing
// it wholesale, so scraping a run that only covers some shards (e.g. a
// shard that was retried and only the retry's logs are worth trusting)
// doesn't erase weights for files that happened to be in a different,
// unscraped shard.

// Same leading-timestamp shape scripts/check-ci-shard-progress.mjs's own
// PROGRESS_LINE_RE already matches (a real captured job-log line always
// starts with GitHub's own per-line timestamp, not the bare "PASS:"/
// "FAIL:" text) -- this one additionally captures the elapsed-ms figure
// e2e/run-all.mjs prints alongside the file name.
const PROGRESS_LINE_WITH_MS_RE = /^\S+Z\s+(PASS|FAIL): (\S+) \((\d+)ms\)/gm;

// Exported for direct testing against captured job-log excerpts.
export function parseElapsedMsLines(log) {
  const entries = [];
  for (const match of log.matchAll(PROGRESS_LINE_WITH_MS_RE)) {
    entries.push({ file: match[2], elapsedMs: Number(match[3]) });
  }
  return entries;
}

// Exported for direct testing. Merges freshly-scraped entries into an
// existing weights object, last-observed-wins per file (a file that
// appears more than once across the scraped jobs -- e.g. it's in two
// different runs being merged in separate invocations -- just takes
// whichever this call saw last, same as a fresh measurement always
// superseding an older one).
export function mergeWeights(existingWeights, entries) {
  const merged = { ...existingWeights };
  for (const { file, elapsedMs } of entries) {
    merged[file] = elapsedMs;
  }
  return merged;
}

async function main() {
  // Imported lazily, inside main(): a top-level `node:child_process`/
  // `node:fs` import segfaults this repo's vitest-pool-workers test
  // runtime outright (see scripts/check-migration-drift.mjs's own comment
  // on the same issue), even though main() itself is the only thing that
  // touches either here -- same precaution scripts/check-ci-shard-progress.mjs
  // already takes.
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const [runId, repoArg] = process.argv.slice(2);
  if (!runId) {
    console.error('Usage: node scripts/update-shard-weights.mjs <run_id> [owner/repo]');
    process.exit(2);
  }
  const [owner, repo] = (repoArg || 'RunbotRobot/higglehaven').split('/');

  function ghApi(apiPath) {
    return execFileSync('gh', ['api', apiPath], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  }

  const { jobs } = JSON.parse(ghApi(`repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`));
  const e2eJobs = jobs.filter((job) => job.name.startsWith('e2e-tests') && job.status === 'completed');
  if (e2eJobs.length === 0) {
    console.error(`No completed e2e-tests jobs found on run ${runId} -- nothing to scrape.`);
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, '..');
  const weightsPath = path.join(repoRoot, 'e2e', 'shard-weights.json');

  let existingWeights = {};
  try {
    existingWeights = JSON.parse(readFileSync(weightsPath, 'utf8'));
  } catch {
    // Missing or unparseable -- start fresh.
  }

  let weights = existingWeights;
  let totalEntries = 0;
  for (const job of e2eJobs) {
    const log = ghApi(`repos/${owner}/${repo}/actions/jobs/${job.id}/logs`);
    const entries = parseElapsedMsLines(log);
    totalEntries += entries.length;
    weights = mergeWeights(weights, entries);
  }

  if (totalEntries === 0) {
    console.error(
      `Found ${e2eJobs.length} completed e2e-tests job(s) on run ${runId}, but none of their logs had an `
      + 'elapsed-ms PASS/FAIL line -- likely scraping a run from before this instrumentation existed. Nothing written.',
    );
    process.exit(1);
  }

  // Sorted keys -- stable diffs across regenerations, same reasoning any
  // other checked-in JSON snapshot in this repo already follows.
  const sortedWeights = Object.fromEntries(Object.keys(weights).sort().map((key) => [key, weights[key]]));
  writeFileSync(weightsPath, `${JSON.stringify(sortedWeights, null, 2)}\n`);
  console.log(`Scraped ${totalEntries} file timing(s) from ${e2eJobs.length} job(s) on run ${runId}.`);
  console.log(`Wrote ${Object.keys(sortedWeights).length} total weight(s) to ${weightsPath}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
