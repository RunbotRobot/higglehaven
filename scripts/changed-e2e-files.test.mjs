import { describe, expect, it } from 'vitest';
import { MAX_FILES, REPEATS, parseRuns, runSelect, selectChangedE2eFiles, summarizeRuns } from './changed-e2e-files.mjs';

// #4529: which e2e files a branch changed, and the three-run summary the CI job writes.
describe('selectChangedE2eFiles (#4529)', () => {
  it('keeps only e2e/*.test.mjs, as bare names, sorted, each repeated three times in a row', () => {
    const picked = selectChangedE2eFiles([
      'src/shop/avatar.js',
      'e2e/shop-b.test.mjs',
      'e2e/helpers.mjs',
      'e2e/shop-a.test.mjs',
      'e2e/shard-weights.json',
      'docs/API.md',
    ]);
    expect(picked.files).toEqual(['shop-a.test.mjs', 'shop-b.test.mjs']);
    expect(picked.runList).toEqual([
      'shop-a.test.mjs', 'shop-a.test.mjs', 'shop-a.test.mjs',
      'shop-b.test.mjs', 'shop-b.test.mjs', 'shop-b.test.mjs',
    ]);
    expect(picked.capped).toBe(false);
    expect(REPEATS).toBe(3);
  });

  it('is empty (so the job does nothing) when no e2e test file changed', () => {
    const picked = selectChangedE2eFiles(['src/main.js', 'e2e/helpers.mjs', 'worker/index.js']);
    expect(picked.files).toEqual([]);
    expect(picked.runList).toEqual([]);
    expect(picked.total).toBe(0);
  });

  it('drops names that are not a plain file name (they end up on a shell command line)', () => {
    const picked = selectChangedE2eFiles([
      'e2e/ok.test.mjs',
      'e2e/a b.test.mjs',
      'e2e/$(rm -rf).test.mjs',
      'e2e/x;y.test.mjs',
      'e2e/sub/dir.test.mjs',
      'e2e/../etc.test.mjs',
      'e2e/.hidden.test.mjs',
      'e2e/-flag.test.mjs',
      'e2e/ok.test.mjs.bak',
    ]);
    expect(picked.files).toEqual(['ok.test.mjs']);
  });

  it('counts a file once however many times it is named, and drops one whose file is gone', () => {
    const picked = selectChangedE2eFiles(['e2e/a.test.mjs', 'e2e/a.test.mjs', 'e2e/gone.test.mjs'], { exists: (name) => name !== 'gone.test.mjs' });
    expect(picked.files).toEqual(['a.test.mjs']);
    expect(picked.total).toBe(1);
  });

  it(`caps at ${MAX_FILES} files and says so`, () => {
    const names = Array.from({ length: 9 }, (_, i) => `e2e/f${i}.test.mjs`);
    const picked = selectChangedE2eFiles(names);
    expect(picked.files).toHaveLength(MAX_FILES);
    expect(picked.total).toBe(9);
    expect(picked.capped).toBe(true);
    expect(picked.runList).toHaveLength(MAX_FILES * REPEATS);
  });

  it('accepts bare names (the local dry run)', () => {
    const picked = selectChangedE2eFiles(['shop-a.test.mjs', 'not-a-test.mjs']);
    expect(picked.files).toEqual(['shop-a.test.mjs']);
  });
});

const GOOD = [
  'Running 6 e2e test file(s), fresh D1 per file:',
  '2026-11-26T20:00:00.0000000Z PASS: shop-a.test.mjs (41000ms)',
  '2026-11-26T20:01:00.0000000Z PASS: shop-a.test.mjs (39000ms)',
  '2026-11-26T20:02:00.0000000Z PASS: shop-a.test.mjs (40500ms)',
  'PASS: shop-b.test.mjs (9000ms)',
  'PASS: shop-b.test.mjs (9100ms)',
  'PASS: shop-b.test.mjs (9200ms)',
  '=== e2e summary ===',
].join('\n');

describe('parseRuns / summarizeRuns (#4529)', () => {
  it('reads PASS and FAIL lines, with or without the CI timestamp, and ignores everything else', () => {
    const runs = parseRuns(`${GOOD}\n2026-11-26T20:03:00.0000000Z FAIL: shop-c.test.mjs (5000ms) (full output printed at the end of this run)\nFailed: shop-c.test.mjs\n`);
    expect(runs).toHaveLength(7);
    expect(runs[0]).toEqual({ verdict: 'PASS', file: 'shop-a.test.mjs', ms: 41000 });
    expect(runs[6]).toEqual({ verdict: 'FAIL', file: 'shop-c.test.mjs', ms: 5000 });
  });

  it('calls a file stable only when all three runs passed', () => {
    const text = summarizeRuns(GOOD);
    expect(text).toContain('| shop-a.test.mjs | 3/3 | 41, 39, 41 | stable |');
    expect(text).toContain('| shop-b.test.mjs | 3/3 | 9, 9, 9 | stable |');
    expect(text).not.toContain('FLAKY');
  });

  it('names a file that failed in some of its runs (this is what #4400 and the afk test looked like)', () => {
    const log = ['PASS: half.test.mjs (1000ms)', 'FAIL: half.test.mjs (900ms) (x)', 'PASS: half.test.mjs (1000ms)'].join('\n');
    const text = summarizeRuns(log);
    expect(text).toContain('| half.test.mjs | 2/3 | 1, 1, 1 | FLAKY: failed in some runs |');
  });

  it('says a file is incomplete when the job stopped before its third run', () => {
    const text = summarizeRuns('PASS: a.test.mjs (1000ms)\nPASS: a.test.mjs (1000ms)\n');
    expect(text).toContain('incomplete (job stopped early)');
  });

  it('says so when no run line is in the log, and states the cap when there was one', () => {
    expect(summarizeRuns('npm ERR! build failed')).toContain('No run lines found');
    expect(summarizeRuns(GOOD, { total: 9, capped: true })).toContain('changes 9 e2e files; only the first 6');
  });
});

describe('summarizeRuns verdicts for broken and unstarted files (#4529)', () => {
  it('calls 0 of 3 FAILS, not FLAKY', () => {
    const text = summarizeRuns('FAIL: bad.test.mjs (1000ms) (x)\nFAIL: bad.test.mjs (1000ms) (x)\nFAIL: bad.test.mjs (1000ms) (x)\n');
    expect(text).toContain('| bad.test.mjs | 0/3 | 1, 1, 1 | FAILS: failed all 3 runs |');
    expect(text).not.toContain('FLAKY');
  });

  it('lists a selected file that never started as not run', () => {
    const text = summarizeRuns(GOOD, { selected: ['shop-a.test.mjs', 'shop-b.test.mjs', 'zzz.test.mjs'] });
    expect(text).toContain('| zzz.test.mjs | 0/0 | - | not run (job stopped before it) |');
    expect(text).not.toContain('shop-a.test.mjs | 0/0');
    expect(summarizeRuns('npm ERR!', { selected: ['a.test.mjs'] })).toContain('not run');
  });
});

describe('runSelect, the select step with its outside effects passed in (#4529)', () => {
  it('uses the git diff when there is no override, and reports the step outputs', () => {
    const result = runSelect({ gitNames: () => ['e2e/shop-a.test.mjs', 'src/main.js'] });
    expect(result.json).toEqual({ files: ['shop-a.test.mjs'], total: 1, capped: false, runs: 3 });
    expect(result.outputs).toEqual({
      files: 'shop-a.test.mjs',
      count: 1,
      run_list: 'shop-a.test.mjs shop-a.test.mjs shop-a.test.mjs',
      total: 1,
      capped: false,
    });
  });

  it('uses E2E_STABILITY_FILES instead of git for a local dry run', () => {
    const result = runSelect({ override: 'smoke.test.mjs not-a-test.mjs', gitNames: () => { throw new Error('git must not run'); } });
    expect(result.outputs.files).toBe('smoke.test.mjs');
  });

  it('reports count 0 when nothing changed, so every later step is skipped', () => {
    const result = runSelect({ gitNames: () => ['README.md', 'e2e/helpers.mjs'] });
    expect(result.outputs.count).toBe(0);
    expect(result.outputs.run_list).toBe('');
  });

  it('drops a changed name whose file is not on disk', () => {
    const result = runSelect({ gitNames: () => ['e2e/gone.test.mjs'], exists: () => false });
    expect(result.outputs.count).toBe(0);
  });
});
