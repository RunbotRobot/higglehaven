// #4189: the sets worked out in slices are the sets worked out at once, and nothing is written to an item until
// the job is complete.
import { describe, expect, it, vi } from 'vitest';
import { buildLodSets, startLodSetsJob, stepLodSetsJob, isHeldForSets } from './lodSets.js';

const reading = {
  hasTiers: () => true,
  groupIdOf: (object) => object.userData.groupId,
  templateKeyOf: (object) => object.userData.template?.templateId,
  positionOf: (object) => object.position,
  radiusOf: () => 0.3,
};

function item(templateId, x, y, z, groupId) {
  return { userData: { template: { templateId }, groupId }, position: { x, y, z } };
}

function layout(n) {
  const out = [];
  const side = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) out.push(item(i % 7 === 0 ? 'b' : 'a', (i % side) * 0.5, Math.floor(i / side) * 0.25, 0, i % 50 === 0 ? 'g' + (i % 3) : undefined));
  return out;
}

const shape = (sets) => [...sets].map(([id, set]) => [id, set.members.map((m) => `${m.position.x},${m.position.y}`), set.maxMemberRadiusM]);

// A clock that advances one tick per read, so a budget of N allows about N chunks.
function ticking() { let t = 0; return () => (t += 1); }

describe('set discovery in slices (#4189)', () => {
  it('gives the same sets as one go, in several slices', () => {
    for (const n of [0, 1, 40, 700, 3000]) {
      const oneShot = layout(n);
      const sliced = layout(n);
      const expected = shape(buildLodSets(oneShot, reading));
      const job = startLodSetsJob(sliced, reading);
      let result = null;
      let slices = 0;
      while (!(result = stepLodSetsJob(job, 1, ticking()))) slices += 1;
      expect(shape(result)).toEqual(expected);
      if (n >= 3000) expect(slices).toBeGreaterThan(5); // it really was cut into pieces
      expect(sliced.map((o) => o.userData.lodSetId)).toEqual(oneShot.map((o) => o.userData.lodSetId));
    }
  });

  it('leaves every item untouched until the job is complete', () => {
    const items = layout(1500);
    for (const o of items) o.userData.lodSetId = 'old';
    const job = startLodSetsJob(items, reading);
    expect(stepLodSetsJob(job, 1, ticking())).toBeNull();
    expect(items.every((o) => o.userData.lodSetId === 'old')).toBe(true);
    let result;
    while (!(result = stepLodSetsJob(job, 1, ticking())));
    expect(items.some((o) => o.userData.lodSetId === 'old')).toBe(false);
    expect(result.size).toBeGreaterThan(0);
  });

  it('works from the items as they were when it started, whatever is added or removed after', () => {
    const items = layout(1500);
    const expected = shape(buildLodSets(layout(1500), reading));
    const job = startLodSetsJob(items, reading);
    stepLodSetsJob(job, 1, ticking());
    items.pop();
    items.push(item('a', 900, 900, 0)); // a stray new item mid-job
    let result;
    while (!(result = stepLodSetsJob(job, 1, ticking())));
    expect(shape(result)).toEqual(expected);
  });

  it('returns the same sets again once complete', () => {
    const job = startLodSetsJob(layout(50), reading);
    let result;
    while (!(result = stepLodSetsJob(job, 1000)));
    expect(stepLodSetsJob(job, 1)).toBe(result);
  });
});

describe('set discovery keeps each step small and survives a bad reading (#4189)', () => {
  it('reads at most a couple of chunks of items between two yields, even for one big set and the write-back', () => {
    const items = [];
    for (let i = 0; i < 6000; i++) items.push(item('brick', (i % 100) * 0.5, Math.floor(i / 100) * 0.25, 0));
    let reads = 0;
    let writes = 0;
    const counting = {
      ...reading,
      positionOf: (object) => { reads += 1; return object.position; },
      radiusOf: () => { reads += 1; return 0.3; },
    };
    for (const o of items) {
      let id;
      Object.defineProperty(o.userData, 'lodSetId', { get: () => id, set: (v) => { writes += 1; id = v; }, enumerable: true });
    }
    const job = startLodSetsJob(items, counting);
    let worstReads = 0;
    let worstWrites = 0;
    for (;;) {
      reads = 0; writes = 0;
      const next = job.steps.next();
      worstReads = Math.max(worstReads, reads);
      worstWrites = Math.max(worstWrites, writes);
      if (next.done) break;
    }
    expect(worstReads).toBeLessThanOrEqual(4 * 256);
    expect(worstWrites).toBeLessThanOrEqual(2 * 256);
  });

  it('marks items as looked at only when the job completes', () => {
    const items = layout(1500);
    const job = startLodSetsJob(items, reading);
    stepLodSetsJob(job, 1, ticking());
    expect(items.some((o) => o.userData.lodSetsSeen)).toBe(false);
    while (!stepLodSetsJob(job, 1, ticking()));
    expect(items.every((o) => o.userData.lodSetsSeen === true)).toBe(true);
  });

  it('a throwing reading ends the job with no sets, says so once, and never throws or loops', () => {
    const items = layout(1500);
    for (const o of items) o.userData.lodSetId = 'old';
    let calls = 0;
    const job = startLodSetsJob(items, { ...reading, positionOf: (o) => { if (++calls > 700) throw new Error('bad position'); return o.position; } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let result;
    for (let n = 0; n < 50 && !(result = stepLodSetsJob(job, 1, ticking())); n++);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    expect(job.failed).toBe(true);
    expect(stepLodSetsJob(job, 1)).toBe(result); // asked again: the same answer, no second error
    expect(error).toHaveBeenCalledTimes(1);
    expect(items.every((o) => o.userData.lodSetId === 'old')).toBe(true); // nothing was written
    error.mockRestore();
  });
});

describe('an item no finished job has seen holds its version (#4189)', () => {
  it('is held on first load and after a reload, released when its job completes; items added later are held until the next job', () => {
    const items = layout(1500);
    expect(items.every((o) => isHeldForSets(o))).toBe(true); // first load / a reload: new objects
    const job = startLodSetsJob(items, reading);
    stepLodSetsJob(job, 1, ticking());
    expect(items.every((o) => isHeldForSets(o))).toBe(true); // mid-job
    while (!stepLodSetsJob(job, 1, ticking()));
    expect(items.every((o) => !isHeldForSets(o))).toBe(true);
    const added = item('a', 3, 3, 3);
    expect(isHeldForSets(added)).toBe(true);
    const next = startLodSetsJob([...items, added], reading);
    while (!stepLodSetsJob(next, 1, ticking()));
    expect(isHeldForSets(added)).toBe(false);
  });

  it('a failed job releases the hold', () => {
    const items = layout(10);
    const job = startLodSetsJob(items, { ...reading, radiusOf: () => { throw new Error('x'); } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stepLodSetsJob(job, 1);
    error.mockRestore();
    expect(isHeldForSets(items[0], job.failed)).toBe(false);
  });

  it('a job that is still running when more items arrive finishes on its own snapshot (no restart)', () => {
    const items = layout(2000);
    const job = startLodSetsJob(items, reading);
    let rounds = 0;
    while (!stepLodSetsJob(job, 1, ticking())) { items.push(item('a', 900 + rounds, 900, 0)); rounds += 1; if (rounds > 200) throw new Error('starved'); }
    expect(job.done).toBe(true);
    expect(items.slice(2000).every((o) => isHeldForSets(o))).toBe(true);
  });
});
