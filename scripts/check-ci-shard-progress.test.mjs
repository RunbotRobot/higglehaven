import { describe, expect, it } from 'vitest';
import { parseProgressLines, summarizeTerminalProgress } from './check-ci-shard-progress.mjs';

// #2976: parseProgressLines/summarizeTerminalProgress exported "for direct
// testing against captured job-log excerpts" per their own comments -- the
// first case uses a real line captured from a real e2e-tests job log (run
// 41339428486, job 124946205068); the cancelled-job case mirrors a second
// real capture (run 41339428486, job 124946205087 -- genuinely cancelled,
// 4 files had already passed).
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

describe('summarizeTerminalProgress (#2976)', () => {
  it('counts pass/fail and reports the gap before a real cancelled job ended (real capture: 4 passed, cancelled ~1min later)', () => {
    const progressLines = parseProgressLines(
      [
        '2026-11-01T19:00:54.0000000Z PASS: claim-map-click-listener-leak.test.mjs',
        '2026-11-01T19:02:12.6337918Z PASS: claim-map-click-listener-leak.test.mjs',
        '2026-11-01T19:03:30.5736689Z PASS: claim-map-refresh-race.test.mjs',
        '2026-11-01T19:04:44.6656515Z PASS: community-calendar-truncation.test.mjs',
        '2026-11-01T19:06:03.9698568Z PASS: community-calendar.test.mjs',
      ].join('\n'),
    );
    const result = summarizeTerminalProgress({
      progressLines,
      startedAt: '2026-11-01T19:00:14Z',
      completedAt: '2026-11-01T19:07:29Z',
    });
    expect(result.passed).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(5);
    expect(result.lastLine.file).toBe('community-calendar.test.mjs');
    // 19:07:29 - 19:06:03.97 ~= 85s
    expect(result.gapBeforeEndMs).toBeGreaterThan(80_000);
    expect(result.gapBeforeEndMs).toBeLessThan(90_000);
  });

  it('counts a mix of pass and fail', () => {
    const progressLines = parseProgressLines(
      [
        '2026-11-01T19:00:00.0000000Z PASS: a.test.mjs',
        '2026-11-01T19:02:00.0000000Z FAIL: b.test.mjs (full output printed at the end of this run)',
      ].join('\n'),
    );
    const result = summarizeTerminalProgress({
      progressLines,
      startedAt: '2026-11-01T18:58:00Z',
      completedAt: '2026-11-01T19:02:30Z',
    });
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(2);
  });

  it('falls back to startedAt as the reference point when no file ever completed', () => {
    const result = summarizeTerminalProgress({
      progressLines: [],
      startedAt: '2026-11-01T19:00:00Z',
      completedAt: '2026-11-01T19:05:00Z',
    });
    expect(result.total).toBe(0);
    expect(result.lastLine).toBeNull();
    expect(result.gapBeforeEndMs).toBe(5 * 60 * 1000);
  });
});
