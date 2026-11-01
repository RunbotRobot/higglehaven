import { describe, expect, it } from 'vitest';
import { judgeShardProgress, parseProgressLines, STUCK_THRESHOLD_MS } from './check-ci-shard-progress.mjs';

// #2976: parseProgressLines/judgeShardProgress exported "for direct testing
// against captured job-log excerpts" per their own comments -- these cases
// use a real line captured from a real e2e-tests job log (run 41339428486,
// job 124946205068) plus the FAIL shape e2e/run-all.mjs's own code prints,
// to confirm the parser handles both without needing a live job to test
// against.
describe('parseProgressLines (#2976)', () => {
  it('parses a real captured PASS line', () => {
    const log = '2026-11-01T19:02:48.9986744Z PASS: purchase-checkout-real-stripe.test.mjs\n';
    expect(parseProgressLines(log)).toEqual([
      { timestamp: '2026-11-01T19:02:48.9986744Z', verdict: 'PASS', file: 'purchase-checkout-real-stripe.test.mjs' },
    ]);
  });

  it('parses a FAIL line with its trailing parenthetical note, ignoring the note', () => {
    const log = '2026-11-01T19:10:00.0000000Z FAIL: measure-mode.test.mjs (full output printed at the end of this run)\n';
    expect(parseProgressLines(log)).toEqual([
      { timestamp: '2026-11-01T19:10:00.0000000Z', verdict: 'FAIL', file: 'measure-mode.test.mjs' },
    ]);
  });

  it('ignores unrelated log lines and returns multiple progress lines in order', () => {
    const log = [
      '2026-11-01T19:00:00.0000000Z Building the frontend once for this run...',
      '2026-11-01T19:02:00.0000000Z PASS: a.test.mjs',
      '2026-11-01T19:04:00.0000000Z PASS: b.test.mjs',
      '2026-11-01T19:06:00.0000000Z FAIL: c.test.mjs (full output printed at the end of this run)',
      '2026-11-01T19:07:00.0000000Z === e2e summary ===',
    ].join('\n');
    expect(parseProgressLines(log).map((l) => `${l.verdict}:${l.file}`)).toEqual([
      'PASS:a.test.mjs',
      'PASS:b.test.mjs',
      'FAIL:c.test.mjs',
    ]);
  });

  it('returns an empty array for a log with no progress lines yet', () => {
    expect(parseProgressLines('Building the frontend once for this run...\n')).toEqual([]);
  });
});

describe('judgeShardProgress (#2976)', () => {
  const now = new Date('2026-11-01T19:20:00.000Z').getTime();

  it('judges "progressing" when the last progress line is recent', () => {
    const progressLines = [{ timestamp: '2026-11-01T19:15:00.000Z', verdict: 'PASS', file: 'a.test.mjs' }];
    const result = judgeShardProgress({ progressLines, jobStartedAt: '2026-11-01T19:00:00.000Z', now });
    expect(result.verdict).toBe('progressing');
    expect(result.referenceTimestamp).toBe('2026-11-01T19:15:00.000Z');
  });

  it('judges "stuck" when the last progress line is older than the threshold', () => {
    const staleTimestamp = new Date(now - STUCK_THRESHOLD_MS - 1000).toISOString();
    const progressLines = [{ timestamp: staleTimestamp, verdict: 'PASS', file: 'a.test.mjs' }];
    const result = judgeShardProgress({ progressLines, jobStartedAt: '2026-11-01T18:00:00.000Z', now });
    expect(result.verdict).toBe('stuck');
  });

  it('falls back to jobStartedAt when no file has completed yet, and still judges "progressing" within the threshold', () => {
    const result = judgeShardProgress({ progressLines: [], jobStartedAt: '2026-11-01T19:18:00.000Z', now });
    expect(result.verdict).toBe('progressing');
    expect(result.referenceTimestamp).toBe('2026-11-01T19:18:00.000Z');
    expect(result.lastLine).toBeNull();
  });

  it('falls back to jobStartedAt and judges "stuck" if even the first file never completed within the threshold', () => {
    const staleStart = new Date(now - STUCK_THRESHOLD_MS - 1000).toISOString();
    const result = judgeShardProgress({ progressLines: [], jobStartedAt: staleStart, now });
    expect(result.verdict).toBe('stuck');
  });
});
