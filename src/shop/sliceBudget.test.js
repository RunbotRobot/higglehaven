import { describe, expect, it } from 'vitest';
import { createSliceBudget } from './sliceBudget.js';

function clockedBudget(sliceMs = 3) {
  let clock = 0;
  const frames = [];
  const budget = createSliceBudget({
    sliceMs,
    now: () => clock,
    nextFrame: () => new Promise((resolve) => { frames.push(resolve); }),
  });
  return { budget, advance: (ms) => { clock += ms; }, frames, now: () => clock };
}

describe('createSliceBudget (#4483)', () => {
  it('lets work continue while the slice has time left', async () => {
    const { budget, advance, frames } = clockedBudget();
    advance(1);
    expect(await budget.yieldIfSpent()).toBe(false);
    advance(1.5);
    expect(await budget.yieldIfSpent()).toBe(false);
    expect(frames.length).toBe(0);
  });

  it('waits for the next frame once the slice is spent, then starts a fresh slice', async () => {
    const { budget, advance, frames } = clockedBudget();
    advance(3);
    const waiting = budget.yieldIfSpent();
    expect(frames.length).toBe(1);
    let settled = false;
    waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false); // still waiting for the frame
    advance(16); // the frame comes
    frames[0]();
    expect(await waiting).toBe(true);
    // the new slice starts at the frame, not at the old start
    advance(1);
    expect(await budget.yieldIfSpent()).toBe(false);
  });

  it('a whole run is a number of frames about the work divided by the slice, never one long stretch', async () => {
    const { budget, advance, frames } = clockedBudget(3);
    let yields = 0;
    let longestStretch = 0;
    let stretch = 0;
    for (let chunk = 0; chunk < 100; chunk++) {
      advance(1); // each chunk costs 1 ms
      stretch += 1;
      const pending = budget.yieldIfSpent();
      if (frames.length > yields) {
        yields += 1;
        longestStretch = Math.max(longestStretch, stretch);
        stretch = 0;
        advance(16);
        frames[frames.length - 1]();
      }
      await pending;
    }
    expect(yields).toBeGreaterThanOrEqual(30); // 100 ms of work in 3 ms slices
    expect(longestStretch).toBeLessThanOrEqual(3);
    expect(budget.stats().slices).toBeGreaterThanOrEqual(30);
  });

  it('restart() makes the time spent waiting for a download not count against the slice', async () => {
    const { budget, advance, frames } = clockedBudget(3);
    advance(500); // a download
    budget.restart();
    advance(1);
    expect(await budget.yieldIfSpent()).toBe(false);
    expect(frames.length).toBe(0);
    expect(budget.stats().longestSliceMs).toBeLessThan(3);
  });
});
