// #4189: the sets worked out in slices are the sets worked out at once, and nothing is written to an item until
// the job is complete.
import { describe, expect, it } from 'vitest';
import { buildLodSets, startLodSetsJob, stepLodSetsJob } from './lodSets.js';

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
