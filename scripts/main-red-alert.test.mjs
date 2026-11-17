// #3727: the pieces of scripts/main-red-alert.mjs that decide what a red `main` run says.
import { describe, expect, it } from 'vitest';
import { failedFilesFromLog, describeRun, titleFor, bodyFor, reconcile, TITLE_PREFIX } from './main-red-alert.mjs';

const LOG_RETRY_PASSED_ONE = [
  'noise',
  'FAILED: a.test.mjs',
  'FAILED: b.test.mjs',
  'Attempt 1 failed — retrying only: a.test.mjs b.test.mjs',
  'more noise',
  'FAILED: b.test.mjs',
  'FAILED: b.test.mjs',
].join('\n');

describe('failedFilesFromLog', () => {
  it('keeps only the last attempt\'s failures (a file that passed on the retry is not red)', () => {
    expect(failedFilesFromLog(LOG_RETRY_PASSED_ONE)).toEqual(['b.test.mjs']);
  });
  it('reads every FAILED line when there was no retry marker', () => {
    expect(failedFilesFromLog('x\nFAILED: c.test.mjs\nFAILED: d.test.mjs')).toEqual(['c.test.mjs', 'd.test.mjs']);
  });
  it('is empty for a log with no failures, or no log', () => {
    expect(failedFilesFromLog('all fine')).toEqual([]);
    expect(failedFilesFromLog(undefined)).toEqual([]);
  });
  it('ignores a line that only mentions a file', () => {
    expect(failedFilesFromLog('PASS: e.test.mjs (1 ms)')).toEqual([]);
  });
});

describe('describeRun', () => {
  const jobs = [
    { id: 1, name: 'unit-tests', conclusion: 'failure' },
    { id: 2, name: 'e2e-tests (a.test.mjs, b.test.mjs)', conclusion: 'failure' },
    { id: 3, name: 'e2e-tests (c.test.mjs)', conclusion: 'success' },
    { id: 4, name: 'e2e-tests (d.test.mjs)', conclusion: 'failure' },
    { id: 5, name: 'discover-e2e-files', conclusion: 'success' },
  ];
  it('names the failed e2e files, the unit tests, and a failed shard whose log named nothing', async () => {
    const logs = { 2: LOG_RETRY_PASSED_ONE, 4: 'the runner died' };
    const summary = await describeRun(jobs, async (job) => logs[job.id]);
    expect(summary).toEqual({ unit: true, files: ['b.test.mjs'], unexplained: ['e2e-tests (d.test.mjs)'], failedJobCount: 3 });
  });
  it('falls back to "unexplained" when a log cannot be fetched', async () => {
    const summary = await describeRun([{ id: 2, name: 'e2e-tests (a.test.mjs)', conclusion: 'failure' }], async () => { throw new Error('404'); });
    expect(summary.unexplained).toEqual(['e2e-tests (a.test.mjs)']);
  });
});

describe('titleFor and bodyFor', () => {
  it('names up to three files and counts the rest', () => {
    const title = titleFor({ unit: false, files: ['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'd.test.mjs', 'e.test.mjs'], unexplained: [] });
    expect(title).toBe(`${TITLE_PREFIX}: a.test.mjs, b.test.mjs, c.test.mjs, 2 more`);
  });
  it('says "see the run" when nothing could be named', () => {
    expect(titleFor({ unit: false, files: [], unexplained: ['x'] })).toBe(`${TITLE_PREFIX}: see the run`);
  });
  it('the body carries the run, the commit, every file and the instruction', () => {
    const body = bodyFor({ unit: true, files: ['a.test.mjs'], unexplained: ['e2e-tests (d)'] }, { runUrl: 'https://x/run/1', sha: 'abcdef1234', subject: 'Some change' });
    expect(body).toContain('https://x/run/1');
    expect(body).toContain('abcdef1');
    expect(body).toContain('"Some change"');
    expect(body).toContain('- the unit tests failed');
    expect(body).toContain('- `a.test.mjs`');
    expect(body).toContain('fix `main` first');
  });
});

describe('reconcile', () => {
  const context = { runUrl: 'https://x/run/2', sha: 'abcdef1234', subject: '' };
  const summary = { unit: false, files: ['a.test.mjs'], unexplained: [] };
  const recorder = (open) => {
    const calls = [];
    const api = async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'GET') return open;
      if (method === 'POST' && path.endsWith('/issues')) return { number: 99 };
      return null;
    };
    return { api, calls };
  };

  it('opens one issue when red and none is open', async () => {
    const { api, calls } = recorder([{ number: 5, title: 'Something else' }]);
    expect(await reconcile({ api, repo: 'o/r', red: true, summary, context })).toEqual({ action: 'opened', number: 99 });
    expect(calls.at(-1).body.title).toBe(`${TITLE_PREFIX}: a.test.mjs`);
  });
  it('updates and comments on the open one when still red, never a second issue', async () => {
    const { api, calls } = recorder([{ number: 7, title: `${TITLE_PREFIX}: old.test.mjs` }]);
    expect(await reconcile({ api, repo: 'o/r', red: true, summary, context })).toEqual({ action: 'updated', number: 7 });
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/issues'))).toBe(false);
  });
  it('closes the open notice when green', async () => {
    const { api, calls } = recorder([{ number: 7, title: `${TITLE_PREFIX}: old.test.mjs` }]);
    expect(await reconcile({ api, repo: 'o/r', red: false, summary: null, context })).toEqual({ action: 'closed', number: 7 });
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { state: 'closed' } });
  });
  it('does nothing when green and nothing is open, and never touches a pull request that shares the title', async () => {
    const { api } = recorder([{ number: 8, title: `${TITLE_PREFIX}: x`, pull_request: {} }]);
    expect(await reconcile({ api, repo: 'o/r', red: false, summary: null, context })).toEqual({ action: 'none' });
  });
});
