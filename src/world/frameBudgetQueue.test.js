import { describe, expect, it } from 'vitest';
import { DroppedWorkError, createFrameBudgetQueue } from './frameBudgetQueue.js';

// A fake clock and frame scheduler: a "frame" runs only when the test says so.
function harness({ budgetMs = 4 } = {}) {
  let clock = 0;
  const frames = [];
  const errors = [];
  const queue = createFrameBudgetQueue({
    budgetMs,
    now: () => clock,
    schedule: (callback) => frames.push(callback),
    onError: (error) => errors.push(error),
  });
  return {
    queue,
    errors,
    advance: (ms) => { clock += ms; },
    frameCount: () => frames.length,
    // Run the next scheduled frame to completion; false if none was scheduled.
    async runFrame() {
      const callback = frames.shift();
      if (!callback) return false;
      await callback();
      return true;
    },
    async runAllFrames() {
      let n = 0;
      while (await this.runFrame()) n += 1;
      return n;
    },
  };
}

describe('frameBudgetQueue (#3396)', () => {
  it('runs units in priority order, ties in the order queued', async () => {
    const h = harness({ budgetMs: 1000 });
    const order = [];
    h.queue.enqueue(() => order.push('c'), { priority: 5 });
    h.queue.enqueue(() => order.push('a1'), { priority: 1 });
    h.queue.enqueue(() => order.push('b'), { priority: 3 });
    h.queue.enqueue(() => order.push('a2'), { priority: 1 });
    await h.runAllFrames();
    expect(order).toEqual(['a1', 'a2', 'b', 'c']);
  });

  it('stops a frame once its time is spent, and carries the rest to the next frame', async () => {
    const h = harness({ budgetMs: 4 });
    const ran = [];
    for (let i = 0; i < 6; i += 1) h.queue.enqueue(() => { h.advance(2); ran.push(i); }, { priority: i });
    await h.runFrame();
    expect(ran).toEqual([0, 1]); // 2 ms each: the 4 ms budget is spent after two
    await h.runFrame();
    expect(ran).toEqual([0, 1, 2, 3]);
    expect(h.queue.pending()).toBe(2);
    await h.runAllFrames();
    expect(ran).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('never runs past the budget by more than one unit', async () => {
    const h = harness({ budgetMs: 4 });
    for (let i = 0; i < 40; i += 1) h.queue.enqueue(() => h.advance(1.5), { priority: i });
    await h.runAllFrames();
    expect(h.queue.stats().longestTickMs).toBeLessThanOrEqual(4 + 1.5);
  });

  it('always runs at least one unit per frame, even one longer than the budget', async () => {
    const h = harness({ budgetMs: 4 });
    const ran = [];
    h.queue.enqueue(() => { h.advance(50); ran.push('slow'); }, { priority: 1 });
    h.queue.enqueue(() => ran.push('next'), { priority: 2 });
    await h.runFrame();
    expect(ran).toEqual(['slow']);
    await h.runFrame();
    expect(ran).toEqual(['slow', 'next']);
  });

  it('schedules one frame at a time, and none when idle', async () => {
    const h = harness();
    expect(h.frameCount()).toBe(0);
    h.queue.enqueue(() => {});
    h.queue.enqueue(() => {});
    expect(h.frameCount()).toBe(1);
    await h.runAllFrames();
    expect(h.frameCount()).toBe(0);
    expect(h.queue.pending()).toBe(0);
  });

  it('drops every pending unit of a group and leaves the others', async () => {
    const h = harness({ budgetMs: 1000 });
    const ran = [];
    const loadA = { name: 'load A' };
    const loadB = { name: 'load B' };
    for (let i = 0; i < 3; i += 1) h.queue.enqueue(() => ran.push(`A${i}`), { group: loadA, priority: i });
    for (let i = 0; i < 2; i += 1) h.queue.enqueue(() => ran.push(`B${i}`), { group: loadB, priority: i + 10 });
    expect(h.queue.dropGroup(loadA)).toBe(3);
    expect(h.queue.pending()).toBe(2);
    await h.runAllFrames();
    expect(ran).toEqual(['B0', 'B1']);
  });

  it('dropping a group that is gone, or already empty, is harmless', () => {
    const h = harness();
    expect(h.queue.dropGroup({})).toBe(0);
    const group = {};
    h.queue.enqueue(() => {}, { group });
    h.queue.dropGroup(group);
    expect(h.queue.dropGroup(group)).toBe(0);
  });

  it('a unit that is already running when its group is dropped finishes', async () => {
    const h = harness({ budgetMs: 1000 });
    const group = {};
    const ran = [];
    h.queue.enqueue(() => { ran.push('first'); h.queue.dropGroup(group); }, { group, priority: 1 });
    h.queue.enqueue(() => ran.push('second'), { group, priority: 2 });
    await h.runAllFrames();
    expect(ran).toEqual(['first']);
  });

  it('awaits an async unit before starting the next one', async () => {
    const h = harness({ budgetMs: 1000 });
    const log = [];
    h.queue.enqueue(async () => {
      log.push('start 1');
      await Promise.resolve();
      await Promise.resolve();
      log.push('end 1');
    }, { priority: 1 });
    h.queue.enqueue(() => log.push('2'), { priority: 2 });
    await h.runAllFrames();
    expect(log).toEqual(['start 1', 'end 1', '2']);
  });

  it('keeps going when a unit throws, and reports the error', async () => {
    const h = harness({ budgetMs: 1000 });
    const ran = [];
    h.queue.enqueue(() => { throw new Error('boom'); }, { priority: 1 });
    h.queue.enqueue(async () => { throw new Error('async boom'); }, { priority: 2 });
    h.queue.enqueue(() => ran.push('after'), { priority: 3 });
    await h.runAllFrames();
    expect(ran).toEqual(['after']);
    expect(h.errors.map((e) => e.message)).toEqual(['boom', 'async boom']);
  });

  it('runs a unit queued from inside another unit', async () => {
    const h = harness({ budgetMs: 1000 });
    const ran = [];
    h.queue.enqueue(() => {
      ran.push('outer');
      h.queue.enqueue(() => ran.push('inner'), { priority: 0 });
    }, { priority: 1 });
    await h.runAllFrames();
    expect(ran).toEqual(['outer', 'inner']);
  });

  it('drain runs everything at once, ignoring the budget', async () => {
    const h = harness({ budgetMs: 1 });
    const ran = [];
    for (let i = 0; i < 5; i += 1) h.queue.enqueue(() => { h.advance(10); ran.push(i); }, { priority: i });
    await h.queue.drain();
    expect(ran).toEqual([0, 1, 2, 3, 4]);
    expect(h.queue.pending()).toBe(0);
  });

  it('counts the frames and units it ran', async () => {
    const h = harness({ budgetMs: 4 });
    for (let i = 0; i < 5; i += 1) h.queue.enqueue(() => h.advance(2), { priority: i });
    await h.runAllFrames();
    expect(h.queue.stats()).toMatchObject({ unitsRun: 5, ticks: 3, pending: 0 });
  });

  describe('run (#3427)', () => {
    it('resolves with the unit\'s result once a frame has run it', async () => {
      const h = harness();
      const promise = h.queue.run(() => 42);
      let settled = false;
      promise.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false); // nothing runs until a frame does
      await h.runAllFrames();
      await expect(promise).resolves.toBe(42);
    });

    it('awaits an async unit and resolves with its value', async () => {
      const h = harness();
      const promise = h.queue.run(async () => { await Promise.resolve(); return 'built'; });
      await h.runAllFrames();
      await expect(promise).resolves.toBe('built');
    });

    it('rejects the promise when the unit throws, without calling onError, and keeps going', async () => {
      const h = harness({ budgetMs: 1000 });
      const failing = h.queue.run(() => { throw new Error('boom'); });
      const after = h.queue.run(() => 'still ran');
      await h.runAllFrames();
      await expect(failing).rejects.toThrow('boom');
      await expect(after).resolves.toBe('still ran');
      expect(h.errors).toEqual([]);
    });

    it('orders run units with enqueued ones by priority', async () => {
      const h = harness({ budgetMs: 1000 });
      const order = [];
      h.queue.enqueue(() => order.push('enqueued-late'), { priority: 9 });
      const a = h.queue.run(() => { order.push('run-1'); }, { priority: 1 });
      const b = h.queue.run(() => { order.push('run-2'); }, { priority: 1 });
      await h.runAllFrames();
      await Promise.all([a, b]);
      expect(order).toEqual(['run-1', 'run-2', 'enqueued-late']);
    });

    it('queues many units up front and finishes them across frames inside the budget', async () => {
      const h = harness({ budgetMs: 4 });
      const promises = Array.from({ length: 10 }, (_, i) => h.queue.run(() => { h.advance(1); return i; }));
      const frames = await h.runAllFrames();
      expect(frames).toBeGreaterThan(1); // not all in one tick
      await expect(Promise.all(promises)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('rejects with DroppedWorkError when its group is dropped before it ran', async () => {
      const h = harness();
      const group = {};
      const promise = h.queue.run(() => 'never', { group });
      const caught = promise.catch((error) => error);
      expect(h.queue.dropGroup(group)).toBe(1);
      expect(await caught).toBeInstanceOf(DroppedWorkError);
    });
  });
});
