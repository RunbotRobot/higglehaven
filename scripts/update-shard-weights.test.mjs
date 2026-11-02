import { describe, expect, it } from 'vitest';
import { mergeWeights, parseElapsedMsLines } from './update-shard-weights.mjs';

describe('parseElapsedMsLines (#3003)', () => {
  it('parses a real-shaped PASS line with its elapsed-ms suffix', () => {
    const log = '2026-11-02T01:02:48.9986744Z PASS: purchase-checkout-real-stripe.test.mjs (142318ms)\n';
    expect(parseElapsedMsLines(log)).toEqual([
      { file: 'purchase-checkout-real-stripe.test.mjs', elapsedMs: 142318 },
    ]);
  });

  it('parses a FAIL line, ignoring its trailing parenthetical note', () => {
    const log = '2026-11-02T01:10:00.0000000Z FAIL: measure-mode.test.mjs (5012ms) (full output printed at the end of this run)\n';
    expect(parseElapsedMsLines(log)).toEqual([
      { file: 'measure-mode.test.mjs', elapsedMs: 5012 },
    ]);
  });

  it('ignores a pre-#3003-shaped line with no elapsed-ms suffix at all', () => {
    const log = '2026-11-02T01:10:00.0000000Z PASS: old-style-line.test.mjs\n';
    expect(parseElapsedMsLines(log)).toEqual([]);
  });

  it('ignores unrelated log lines and returns multiple entries in order', () => {
    const log = [
      '2026-11-02T01:00:00.0000000Z Building the frontend once for this run...',
      '2026-11-02T01:02:00.0000000Z PASS: a.test.mjs (1000ms)',
      '2026-11-02T01:04:00.0000000Z PASS: b.test.mjs (2000ms)',
    ].join('\n');
    expect(parseElapsedMsLines(log)).toEqual([
      { file: 'a.test.mjs', elapsedMs: 1000 },
      { file: 'b.test.mjs', elapsedMs: 2000 },
    ]);
  });
});

describe('mergeWeights (#3003)', () => {
  it('adds new files without touching existing ones not re-measured this run', () => {
    const existing = { 'a.test.mjs': 1000, 'b.test.mjs': 2000 };
    const merged = mergeWeights(existing, [{ file: 'c.test.mjs', elapsedMs: 3000 }]);
    expect(merged).toEqual({ 'a.test.mjs': 1000, 'b.test.mjs': 2000, 'c.test.mjs': 3000 });
  });

  it('overwrites a re-measured file with the fresh value', () => {
    const existing = { 'a.test.mjs': 1000 };
    const merged = mergeWeights(existing, [{ file: 'a.test.mjs', elapsedMs: 1500 }]);
    expect(merged).toEqual({ 'a.test.mjs': 1500 });
  });

  it('never mutates the existing weights object passed in', () => {
    const existing = { 'a.test.mjs': 1000 };
    mergeWeights(existing, [{ file: 'a.test.mjs', elapsedMs: 9999 }]);
    expect(existing).toEqual({ 'a.test.mjs': 1000 });
  });
});
