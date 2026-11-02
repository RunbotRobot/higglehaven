#!/usr/bin/env node
// #2976 (owner decision, resolving question-ci-concurrency-contention-20261101
// in the Control Room): the fleet's own habit of treating a slow-looking e2e
// CI shard as "frozen" and cancel+rerunning it by wall-clock-elapsed alone
// was making the underlying congestion worse, not better -- on PR #2943, a
// shard killed as "frozen" after 35 minutes had actually completed 18/53
// test files (34%), genuinely progressing, just slower than the ~20-25min
// healthy baseline under fleet-wide CI concurrency contention.
//
// CORRECTION, same PR (#2979) that introduced this script: the issue's own
// premise -- that a running shard's live job log can be read for its
// PASS/FAIL progress lines (e2e/run-all.mjs prints one per file as it
// finishes) *before* deciding whether to cancel -- does not hold. Verified
// empirically against several genuinely in-progress jobs, at 8, 31, 52, and
// 54 minutes elapsed: `GET .../actions/jobs/{id}/logs` returns 404
// BlobNotFound the entire time a job's status is "in_progress", no matter
// how long it's been running or how much real output it's already produced.
// The same endpoint against the *same* jobs once they reached a terminal
// state (completed -- success, failure, or cancelled) returned the full log
// immediately, progress lines included. GitHub simply does not serve partial
// job logs through this endpoint while a job is still running -- there is no
// live per-file signal available here, full stop. (The #2943 investigation
// this issue cites as its evidence was itself necessarily retroactive: that
// shard was already "killed" -- i.e. cancelled, a terminal state -- before
// its 18/53 progress could be read back at all.)
//
// So this script cannot tell you, while a shard is still running, whether
// it's stuck or just slow -- nothing can, through this API. What it's
// actually good for: once a job reaches a terminal state (most usefully,
// the moment right after you've cancelled one), it reports exactly how far
// that shard had actually gotten. Run it right after cancelling something
// that looked stuck -- if it turns out to have been well into its file list
// with no real gap in its progress, that's a concrete signal the cancel was
// premature, worth noting on the PR/issue so the fleet's own patience
// threshold keeps getting corrected rather than repeating the same mistake.
//
// Usage: node scripts/check-ci-shard-progress.mjs <job_id> [owner/repo]
// Requires `gh` (Claude Code's own built-in GitHub API client) on PATH --
// this is a fleet-session dev tool, not part of CI itself.

const PROGRESS_LINE_RE = /^(\S+Z)\s+(PASS|FAIL): (\S+)/gm;

// Exported for direct testing against captured job-log excerpts.
export function parseProgressLines(log) {
  const lines = [];
  for (const match of log.matchAll(PROGRESS_LINE_RE)) {
    lines.push({ timestamp: match[1], verdict: match[2], file: match[3] });
  }
  return lines;
}

// Exported for direct testing. Summarizes a terminal (completed) job's own
// progress-line history -- how many files it got through, and (for a
// cancelled job specifically) how long a gap preceded the cancellation,
// which is the concrete number worth citing when arguing a cancel was too
// eager.
export function summarizeTerminalProgress({ progressLines, startedAt, completedAt }) {
  const passed = progressLines.filter((l) => l.verdict === 'PASS').length;
  const failed = progressLines.filter((l) => l.verdict === 'FAIL').length;
  const lastLine = progressLines.length > 0 ? progressLines[progressLines.length - 1] : null;
  const referenceTimestamp = lastLine ? lastLine.timestamp : startedAt;
  const gapBeforeEndMs = new Date(completedAt).getTime() - new Date(referenceTimestamp).getTime();
  return { passed, failed, total: progressLines.length, lastLine, gapBeforeEndMs };
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

  if (job.status !== 'completed') {
    // Confirmed (see this file's own header comment): the logs endpoint
    // never returns real content for a job in this state, however long
    // it's been running. There is no live per-file progress signal to
    // report here -- only wall-clock, which is exactly the unreliable
    // signal #2976 exists because of.
    const sinceStartMin = ((Date.now() - new Date(job.started_at).getTime()) / 60000).toFixed(1);
    console.log(`Running for ${sinceStartMin} minute(s) so far. No live per-file progress is available for a job in this state --`);
    console.log("GitHub's own job-logs endpoint only returns content once a job reaches a terminal state (confirmed empirically; see this script's header comment).");
    console.log(
      "Cancelling early just to find out adds a fresh job to the same contended Actions pool -- if you do cancel, re-run this " +
      'script against the same job_id immediately afterward (it will now be "completed") to see exactly how much real progress was lost.',
    );
    return;
  }

  const log = ghApi(`repos/${owner}/${repo}/actions/jobs/${jobId}/logs`);
  const progressLines = parseProgressLines(log);
  const { passed, failed, total, lastLine, gapBeforeEndMs } = summarizeTerminalProgress({
    progressLines,
    startedAt: job.started_at,
    completedAt: job.completed_at,
  });

  if (total === 0) {
    console.log('No test file ever completed in this job -- genuinely stuck or failed before the first file ran.');
    return;
  }

  console.log(`${total} file(s) completed (${passed} pass, ${failed} fail). Last: ${lastLine.verdict} ${lastLine.file} at ${lastLine.timestamp}.`);
  console.log(`Gap between that last progress line and the job ending: ${(gapBeforeEndMs / 60000).toFixed(1)} minute(s).`);

  if (job.conclusion === 'cancelled') {
    console.log(
      `This job was cancelled after genuinely completing ${total} file(s) -- if that's a substantial fraction of the shard, ` +
      'the cancel was likely premature; consider noting this on the relevant PR/issue so the fleet waits longer next time.',
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
