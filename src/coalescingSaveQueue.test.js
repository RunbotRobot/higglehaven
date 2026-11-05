import { describe, expect, it } from 'vitest';
import { createCoalescingSaveQueue } from './coalescingSaveQueue.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe('coalescing save queue (#1062)', () => {
  it('never lets a later save start before the earlier one has finished', async () => {
    const gates = [];
    const log = [];
    const queue = createCoalescingSaveQueue(async (state) => {
      const gate = deferred();
      gates.push(gate);
      const sentVersion = state.v;
      log.push(`start ${sentVersion}`);
      await gate.promise;
      log.push(`end ${sentVersion}`);
    });
    const state = { v: 1 };
    const first = queue.request('a', state);
    await Promise.resolve();
    state.v = 2;
    const second = queue.request('a', state);
    await Promise.resolve();
    expect(log).toEqual(['start 1']); // second waits for the first
    gates[0].resolve();
    await first;
    await Promise.resolve();
    gates[1].resolve();
    await second;
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('shares one waiting save among a burst and sends the newest state', async () => {
    const gates = [];
    const sent = [];
    const queue = createCoalescingSaveQueue(async (state) => {
      sent.push(state.v);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
    });
    const state = { v: 1 };
    let queuedCount = 0;
    const onQueued = () => { queuedCount += 1; };
    const first = queue.request('a', state, onQueued);
    await Promise.resolve();
    state.v = 2;
    const second = queue.request('a', state, onQueued);
    state.v = 3;
    const third = queue.request('a', state, onQueued);
    state.v = 4;
    const fourth = queue.request('a', state, onQueued);
    expect(third).toBe(second);
    expect(fourth).toBe(second);
    expect(queuedCount).toBe(2);
    gates[0].resolve();
    await first;
    await Promise.resolve();
    await Promise.resolve();
    gates[1].resolve();
    await Promise.all([second, third, fourth]);
    expect(sent).toEqual([1, 4]);
  });

  it('does not make different keys wait on each other', async () => {
    const gate = deferred();
    const started = [];
    const queue = createCoalescingSaveQueue(async (key) => {
      started.push(key);
      if (key === 'slow') await gate.promise;
    });
    const slow = queue.request('slow', 'slow');
    const fast = queue.request('fast', 'fast');
    await fast;
    expect(started).toEqual(['slow', 'fast']);
    gate.resolve();
    await slow;
  });

  it('keeps going after a send rejects', async () => {
    let calls = 0;
    const queue = createCoalescingSaveQueue(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    });
    await expect(queue.request('a', null)).rejects.toThrow('boom');
    await queue.request('a', null);
    expect(calls).toBe(2);
  });
});
