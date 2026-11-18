#!/usr/bin/env node
// #3727 (part of the CI-time work): when the CI run on `main` goes red, say so where the fleet
// already looks, with the failing files named, so the next session fixes main first and the rest
// stop pushing runs that cannot pass. When the run on `main` is green again, close that notice.
//
// Why: on 2026-11-17 two tests went red on `main` after one merge and stayed red for hours; every
// PR's two-hour run failed on the same files, and nothing said so. The notice is one open GitHub
// issue titled "main is red: ..." (an issue, not a Control Room card: a card needs the control-room
// key as a repository secret, which only the owner can add; the workflow's own token is enough here).
//
// Run by the `main-red-alert` job in .github/workflows/ci.yml with GITHUB_TOKEN, GITHUB_REPOSITORY,
// GITHUB_RUN_ID and GITHUB_SHA set. The parsing and the issue logic are pure and take an `api`
// function, so scripts/main-red-alert.test.mjs runs them without a network.
import { pathToFileURL } from 'node:url';

export const TITLE_PREFIX = 'main is red';

// The e2e runner's own lines (e2e/run-all.mjs): "FAILED: <file>" per failing file per attempt, and
// "Attempt 1 failed -- retrying only: ..." between the first attempt and the retry. Only the last
// attempt's failures are real, so take the FAILED lines after the retry marker when there is one.
export function failedFilesFromLog(text) {
  const lines = String(text || '').split('\n');
  let start = 0;
  lines.forEach((line, i) => { if (/Attempt \d+ failed/.test(line)) start = i + 1; });
  const files = new Set();
  for (const line of lines.slice(start)) {
    const found = /\bFAILED: (\S+\.test\.mjs)\b/.exec(line);
    if (found) files.add(found[1]);
  }
  return [...files];
}

// What failed in this run, by name: unit tests as a whole, and the files of each failed e2e shard.
// `jobs` is the REST shape ({ id, name, conclusion }); `logOf(job)` returns that job's log text.
export async function describeRun(jobs, logOf) {
  const failedJobs = jobs.filter((job) => job.conclusion === 'failure');
  const files = new Set();
  const unexplained = [];
  let unit = false;
  for (const job of failedJobs) {
    if (/^unit-tests/.test(job.name)) { unit = true; continue; }
    if (!/^e2e-tests/.test(job.name)) { unexplained.push(job.name); continue; }
    let found = [];
    try { found = failedFilesFromLog(await logOf(job)); } catch { found = []; }
    if (found.length === 0) unexplained.push(job.name);
    for (const file of found) files.add(file);
  }
  return { unit, files: [...files].sort(), unexplained, failedJobCount: failedJobs.length };
}

export function titleFor(summary) {
  const parts = [];
  if (summary.unit) parts.push('unit tests');
  parts.push(...summary.files.slice(0, 3));
  if (summary.files.length > 3) parts.push(`${summary.files.length - 3} more`);
  return `${TITLE_PREFIX}: ${parts.length ? parts.join(', ') : 'see the run'}`;
}

export function bodyFor(summary, { runUrl, sha, subject }) {
  const lines = [
    `The CI run on \`main\` failed (${runUrl}) at ${sha.slice(0, 7)}${subject ? `, "${subject}"` : ''}.`,
    '',
  ];
  if (summary.unit) lines.push('- the unit tests failed');
  for (const file of summary.files) lines.push(`- \`${file}\``);
  for (const name of summary.unexplained) lines.push(`- job "${name}" failed and its log named no test file (a crash, a build error or a timeout: read the job)`);
  lines.push(
    '',
    '**What to do:** fix `main` first. A pull request whose run fails on exactly these files is not at fault, and pushing more runs that cannot pass wastes the shards; a fix for these files is worth merging ahead of other work. This notice closes itself when the run on `main` is green again.',
    '',
    '---',
    '_Opened by the `main-red-alert` job in CI (scripts/main-red-alert.mjs)._',
  );
  return lines.join('\n');
}

// One open "main is red" issue at a time: a second red run updates it, a green run closes it.
// `api(method, path, body)` returns parsed JSON.
export async function reconcile({ api, repo, red, summary, context }) {
  const open = await api('GET', `/repos/${repo}/issues?state=open&per_page=100`);
  const existing = (open || []).find((issue) => !issue.pull_request && String(issue.title).startsWith(TITLE_PREFIX));
  if (!red) {
    if (!existing) return { action: 'none' };
    await api('POST', `/repos/${repo}/issues/${existing.number}/comments`, { body: `The run on \`main\` is green again (${context.runUrl}). Closing.` });
    await api('PATCH', `/repos/${repo}/issues/${existing.number}`, { state: 'closed', state_reason: 'completed' });
    return { action: 'closed', number: existing.number };
  }
  const body = bodyFor(summary, context);
  if (existing) {
    await api('PATCH', `/repos/${repo}/issues/${existing.number}`, { title: titleFor(summary), body });
    await api('POST', `/repos/${repo}/issues/${existing.number}/comments`, { body: `Still red at ${context.sha.slice(0, 7)} (${context.runUrl}).` });
    return { action: 'updated', number: existing.number };
  }
  const created = await api('POST', `/repos/${repo}/issues`, { title: titleFor(summary), body });
  return { action: 'opened', number: created.number };
}

async function main() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA, GITHUB_SERVER_URL = 'https://github.com' } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID are required');
  const headers = { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const api = async (method, path, body) => {
    const response = await fetch(`https://api.github.com${path}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response.status === 204 ? null : response.json();
  };
  const { jobs } = await api('GET', `/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/jobs?per_page=100`);
  const others = jobs.filter((job) => job.name !== 'main-red-alert');
  // A run superseded by a newer push to main is cancelled, which says nothing either way: leave the
  // notice as it is (the newer run decides).
  if (others.some((job) => job.conclusion === 'cancelled')) {
    console.log(JSON.stringify({ red: null, action: 'none', reason: 'the run was cancelled' }));
    return;
  }
  const red = others.some((job) => job.conclusion === 'failure');
  const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  let subject = '';
  try { subject = (await api('GET', `/repos/${GITHUB_REPOSITORY}/commits/${GITHUB_SHA}`)).commit.message.split('\n')[0].slice(0, 120); } catch { /* the notice reads fine without it */ }
  const logOf = async (job) => {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/jobs/${job.id}/logs`, { headers, redirect: 'follow' });
    if (!response.ok) throw new Error(`log ${job.id}: ${response.status}`);
    return response.text();
  };
  const summary = red ? await describeRun(others, logOf) : null;
  const result = await reconcile({ api, repo: GITHUB_REPOSITORY, red, summary, context: { runUrl, sha: GITHUB_SHA, subject } });
  console.log(JSON.stringify({ red, ...result, summary }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
