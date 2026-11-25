import { describe, expect, it, vi } from 'vitest';
import { readWithRetry, scheduleRetry } from './retryRead.js';

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

describe('scheduleRetry (#4317)', () => {
  it('runs again after each wait with the next attempt number, then gives up', () => {
    const waits = [];
    const schedule = (fn, ms) => { waits.push(ms); fn(); };
    const attempts = [];
    const runAgain = (attempt) => { attempts.push(attempt); scheduleRetry(runAgain, attempt, { delaysMs: [2000, 8000], schedule }); };
    expect(scheduleRetry(runAgain, 0, { delaysMs: [2000, 8000], schedule })).toBe(true);
    expect(waits).toEqual([2000, 8000]);
    expect(attempts).toEqual([1, 2]);
  });

  it('schedules nothing once the waits are used up', () => {
    const schedule = vi.fn();
    expect(scheduleRetry(() => {}, 2, { delaysMs: [2000, 8000], schedule })).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
  });
});
