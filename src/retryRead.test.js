import { describe, expect, it } from 'vitest';
import { readWithRetry } from './retryRead.js';

const noWait = () => Promise.resolve();

describe('readWithRetry (#4298)', () => {
  it('returns the first answer without waiting when the read works', async () => {
    const waits = [];
    const result = await readWithRetry(async () => 'ok', { sleep: async (ms) => { waits.push(ms); } });
    expect(result).toBe('ok');
    expect(waits).toEqual([]);
  });

  it('asks again after a failure, waiting the given delays in order, and returns the answer that comes', async () => {
    let calls = 0;
    const waits = [];
    const result = await readWithRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error('blip');
      return 'late';
    }, { delaysMs: [10, 20], sleep: async (ms) => { waits.push(ms); } });
    expect(result).toBe('late');
    expect(calls).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  it('gives the last error to the caller once the delays are used up', async () => {
    let calls = 0;
    await expect(readWithRetry(async () => { calls += 1; throw new Error(`fail ${calls}`); }, { delaysMs: [1, 1], sleep: noWait }))
      .rejects.toThrow('fail 3');
    expect(calls).toBe(3);
  });

  it('stops asking when the screen it was for has gone', async () => {
    let calls = 0;
    let stale = false;
    await expect(readWithRetry(async () => { calls += 1; throw new Error('blip'); }, {
      delaysMs: [1, 1, 1],
      sleep: async () => { stale = true; },
      isStale: () => stale,
    })).rejects.toThrow('blip');
    expect(calls).toBe(1);
  });
});
