#!/usr/bin/env node
// #2976 (owner decision, resolving question-ci-concurrency-contention-20261101
// in the Control Room): the fleet's own habit of treating a slow-looking e2e
// CI shard as "frozen" and cancel+rerunning it by wall-clock-elapsed alone
// was making the underlying congestion worse, not better -- on PR #2943, a
// shard killed as "frozen" after 35 minutes had actually completed 18/53
// test files (34%), genuinely progressing, just slower than the ~20-25min
// healthy baseline under fleet-wide CI concurrency contention. Cancelling a
// shard that's still making progress just adds a fresh job to the same
// contended Actions pool instead of letting real progress finish.
//
// e2e/run-all.mjs already prints a one-line `PASS: <file>` / `FAIL: <file>`
// progress indicator to the job log the moment each test file finishes (see
// that file's own comment above its test loop) -- the data needed to tell
// "slow" from "actually stuck" already exists, nothing was reading it before
// deciding to cancel. This script reads a running job's own log and reports
// how long it's been since the last progress line, instead of just how long
// the job has been running in total.
//
// Usage: node scripts/check-ci-shard-progress.mjs <job_id> [owner/repo]
// Requires `gh` (Claude Code's own built-in GitHub API client) on PATH --
// this is a fleet-session dev tool for judging a running job before
// deciding whether to cancel it, not part of CI itself.

// Mirrors e2e/run-all.mjs's own TEST_FILE_TIMEOUT_MS (10 minutes, the hard
// per-file execSync timeout a genuinely hung test file self-reports a FAIL
// at). Not imported directly -- that file runs its whole test suite as a
// top-level side effect the instant it's imported, so importing it here
// would start a real e2e run. Kept as a literal with this comment as the
// cross-reference instead; if that constant ever changes, reconsider this
// one too.
export const PER_FILE_HARD_TIMEOUT_MS = 10 * 60 * 1000;

// A single hung file already self-reports a FAIL at PER_FILE_HARD_TIMEOUT_MS,
// so genuine "no progress line yet" silence should never exceed that by
// much. The buffer covers a slow-to-start shard (frontend build + D1
// migrations + wrangler boot, all before the first test even begins) and
// the time for that FAIL line's own output to actually reach the log.
export const STUCK_THRESHOLD_MS = PER_FILE_HARD_TIMEOUT_MS + 2 * 60 * 1000;

const PROGRESS_LINE_RE = /^(\S+Z)\s+(PASS|FAIL): (\S+)/gm;

// Exported for direct testing against captured job-log excerpts.
export function parseProgressLines(log) {
  const lines = [];
  for (const match of log.matchAll(PROGRESS_LINE_RE)) {
    lines.push({ timestamp: match[1], verdict: match[2], file: match[3] });
  }
  return lines;
}

// Exported for direct testing. `now`/`jobStartedAt` are injected (rather
// than read live) so this core judgment is testable without a real clock or
// a real job.
export function judgeShardProgress({ progressLines, jobStartedAt, now }) {
  const lastLine = progressLines.length > 0 ? progressLines[progressLines.length - 1] : null;
  const referenceTimestamp = lastLine ? lastLine.timestamp : jobStartedAt;
  const sinceMs = now - new Date(referenceTimestamp).getTime();
  const verdict = sinceMs > STUCK_THRESHOLD_MS ? 'stuck' : 'progressing';
  return { verdict, referenceTimestamp, sinceMs, lastLine };
}

async function main() {
  // Imported lazily, inside main(): a top-level `node:child_process` import
  // segfaults this repo's vitest-pool-workers test runtime outright (see
  // scripts/check-migration-drift.mjs's own comment on the same issue),
  // even though main() itself is the only thing that touches it.
  const { execFileSync } = await import('node:child_process');

  const [jobId, repoArg] = process.argv.slice(2);
  if (!jobId) {
    console.error('Usage: node scripts/check-ci-shard-progress.mjs <job_id> [owner/repo]');
    process.exit(2);
  }
  const [owner, repo] = (repoArg || 'RunbotRobot/higglehaven').split('/');

  function ghApi(apiPath) {
    return execFileSync('gh', ['api', apiPath], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  }

  const job = JSON.parse(ghApi(`repos/${owner}/${repo}/actions/jobs/${jobId}`));
  console.log(`Job: ${job.name} (status: ${job.status}${job.conclusion ? `, conclusion: ${job.conclusion}` : ''})`);

  if (job.status === 'completed') {
    console.log(
      'Already completed -- nothing to judge. This tool is only for an ' +
      'in-progress job you are deciding whether to cancel as stuck.',
    );
    return;
  }

  // A genuinely in-progress job's logs aren't always downloadable yet --
  // GitHub only materializes the blob this endpoint serves once enough
  // output has been archived, so a job early in its run (still building/
  // migrating/booting, before its first log chunk flushes) 404s here. That
  // 404 means "no progress yet", not an error -- fall back to judging off
  // job.started_at alone, same as a completed-but-empty log would.
  let log = '';
  try {
    log = ghApi(`repos/${owner}/${repo}/actions/jobs/${jobId}/logs`);
  } catch (error) {
    console.log("No log available yet for this job (still early in its run) -- judging by the job's own start time instead.");
  }
  const progressLines = parseProgressLines(log);
  const { verdict, referenceTimestamp, sinceMs, lastLine } = judgeShardProgress({
    progressLines,
    jobStartedAt: job.started_at,
    now: Date.now(),
  });

  if (lastLine) {
    console.log(`${progressLines.length} file(s) completed so far. Last: ${lastLine.verdict} ${lastLine.file} at ${referenceTimestamp}`);
  } else {
    console.log(`No file has completed yet (still building/booting since ${referenceTimestamp}).`);
  }
  console.log(`Time since last progress: ${(sinceMs / 60000).toFixed(1)} minute(s).`);

  if (verdict === 'stuck') {
    console.log(
      `VERDICT: likely genuinely stuck -- longer than a single hung file's ` +
      `own ${PER_FILE_HARD_TIMEOUT_MS / 60000}-minute hard timeout would ever ` +
      `take to self-report. Safe to treat as frozen.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      'VERDICT: still within normal per-file range -- likely just slow ' +
      "(e.g. fleet-wide CI contention), not stuck. Don't cancel on wall-clock alone.",
    );
    process.exitCode = 0;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
