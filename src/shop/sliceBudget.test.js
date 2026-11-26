import { describe, expect, it } from 'vitest';
import { startSlice, DEFAULT_SLICE_MS } from './sliceBudget.js';
import { createFrameBudgetQueue } from '../world/frameBudgetQueue.js';

describe('startSlice (#4483)', () => {
  it('is over once the slice has used its milliseconds', () => {
    let clock = 0;
    const slice = startSlice({ now: () => clock });
    expect(slice.allowedMs).toBe(DEFAULT_SLICE_MS);
    expect(slice.over()).toBe(false);
    clock = 2.9;
    expect(slice.over()).toBe(false);
    clock = 3;
    expect(slice.over()).toBe(true);
    expect(slice.elapsedMs()).toBe(3);
  });

  it('never takes more than what is left of the tick, and is over at once when nothing is left', () => {
    let clock = 0;
    expect(startSlice({ remainingMs: 1.5, now: () => clock }).allowedMs).toBe(1.5);
    expect(startSlice({ remainingMs: 10, now: () => clock }).allowedMs).toBe(DEFAULT_SLICE_MS);
    const spent = startSlice({ remainingMs: 0, now: () => clock });
    expect(spent.over()).toBe(true); // a caller does one chunk first, then asks
  });
});

describe('a job in slices on the world work queue (#4483)', () => {
  // A job of 60 ms of work (1 ms chunks) and four small units queued behind it, the job's slices re-queued with the
  // same priority: the small units run between its slices rather than after the whole job.
  it('lets other units run between the slices of a long job', async () => {
    let clock = 0;
    const frames = [];
    const queue = createFrameBudgetQueue({ budgetMs: 4, now: () => clock, schedule: (callback) => frames.push(callback) });
    const order = [];
    let done = 0;
    const jobUnit = () => {
      order.push('job');
      const slice = startSlice({ remainingMs: queue.tickRemainingMs(), now: () => clock });
      do { clock += 1; done += 1; } while (done < 60 && !slice.over());
      if (done < 60) queue.enqueue(jobUnit, { priority: 0 });
    };
    queue.enqueue(jobUnit, { priority: 0 });
    for (let i = 0; i < 4; i++) queue.enqueue(() => { order.push(`small${i}`); clock += 0.1; }, { priority: 0 });
    let guard = 0;
    while (frames.length && guard++ < 200) { clock += 16; await frames.shift()(); }
    expect(done).toBe(60);
    const firstJob = order.indexOf('job');
    const lastJob = order.lastIndexOf('job');
    const smalls = order.filter((entry) => entry.startsWith('small')).length;
    expect(smalls).toBe(4);
    // every small unit ran before the job's last slice
    for (let i = 0; i < 4; i++) expect(order.indexOf(`small${i}`)).toBeLessThan(lastJob);
    expect(firstJob).toBe(0);
  });

  it('tickRemainingMs is the whole budget between ticks and shrinks inside one', async () => {
    let clock = 0;
    const frames = [];
    const queue = createFrameBudgetQueue({ budgetMs: 4, now: () => clock, schedule: (callback) => frames.push(callback) });
    expect(queue.tickRemainingMs()).toBe(4);
    const seen = [];
    queue.enqueue(() => { clock += 1; seen.push(queue.tickRemainingMs()); });
    queue.enqueue(() => { clock += 2.5; seen.push(queue.tickRemainingMs()); });
    await frames.shift()();
    expect(seen).toEqual([3, 0.5]);
    expect(queue.tickRemainingMs()).toBe(4);
  });
});
