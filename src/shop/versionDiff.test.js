import { describe, expect, it } from 'vitest';
import { diffVersionInstances, planVersionChange, sameInstance } from './versionDiff.js';
import { createDepartureRun, DEPARTURE_S } from './departureRun.js';

const inst = (id, extra = {}) => ({ instanceId: id, templateId: 't', x: 1, y: 2, z: 0, scale: 1, ...extra });
const mapOf = (list) => new Map(list.map((i) => [i.instanceId, i]));

describe('diffVersionInstances (#4391)', () => {
  it('leaves an identical list wholly untouched', () => {
    const list = [inst('a'), inst('b')];
    const diff = diffVersionInstances(mapOf(list), list.map((i) => ({ ...i })));
    expect(diff).toEqual({ removed: [], added: [], changed: [], unchanged: 2 });
  });
  it('finds what leaves, what arrives and what changed', () => {
    const before = [inst('a'), inst('b'), inst('c')];
    const after = [inst('a'), inst('c', { x: 5 }), inst('d')];
    const diff = diffVersionInstances(mapOf(before), after);
    expect(diff.removed).toEqual(['b']);
    expect(diff.added.map((i) => i.instanceId)).toEqual(['d']);
    expect(diff.changed.map((c) => c.id)).toEqual(['c']);
    expect(diff.unchanged).toBe(1);
  });
  it('sees a change in any field a shopper can see, and ignores the id spelling', () => {
    expect(sameInstance(inst('a'), { ...inst('a'), id: 'a' })).toBe(true);
    for (const patch of [{ templateId: 'u' }, { scale: 2 }, { z: 1 }, { rotationZ: 0.5 }, { crop: { x: 1 } }, { label: 'hi' }, { groupId: 'g' }, { bundleId: 'b' }]) {
      expect(sameInstance(inst('a'), { ...inst('a'), ...patch })).toBe(false);
    }
    expect(sameInstance({ ...inst('a'), crop: { x: 1 } }, { ...inst('a'), crop: { x: 1 } })).toBe(true);
    expect(sameInstance({ ...inst('a'), label: null }, inst('a'))).toBe(true); // null and missing are the same
  });
  it('treats a list that is wholly different as all leaving and all arriving', () => {
    const diff = diffVersionInstances(mapOf([inst('a')]), [inst('z')]);
    expect(diff.removed).toEqual(['a']);
    expect(diff.added).toHaveLength(1);
  });
});

describe('createDepartureRun (#4391)', () => {
  function fakes() {
    let now = 0;
    const levels = [];
    const restored = [];
    const gone = [];
    const run = createDepartureRun({
      clock: () => now,
      reducedMotion: false,
      createDissolve: (object) => ({ setLevel: (l) => levels.push([object.name, l]), restore: () => restored.push(object.name) }),
    });
    return { run, advance: (ms) => { now += ms; }, levels, restored, gone, onGone: (o) => gone.push(o.name) };
  }
  it('fades an item from fully drawn to nothing over the departure time, then hands it back', () => {
    const f = fakes();
    f.run.add({ name: 'lamp' }, f.onGone);
    expect(f.levels.at(-1)).toEqual(['lamp', 1]);
    f.advance(DEPARTURE_S * 500);
    f.run.update();
    const mid = f.levels.at(-1)[1];
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
    expect(f.gone).toEqual([]); // not removed while still visible
    f.advance(DEPARTURE_S * 500 + 10);
    f.run.update();
    expect(f.levels.at(-1)[1]).toBe(0);
    expect(f.restored).toEqual(['lamp']);
    expect(f.gone).toEqual(['lamp']);
    expect(f.run.settled()).toBe(true);
  });
  it('hands everything back at once on dispose, and an add after dispose goes straight back', () => {
    const f = fakes();
    f.run.add({ name: 'a' }, f.onGone);
    f.run.add({ name: 'b' }, f.onGone);
    f.run.dispose();
    expect(f.gone).toEqual(['a', 'b']);
    f.run.add({ name: 'c' }, f.onGone);
    expect(f.gone).toEqual(['a', 'b', 'c']);
  });
});

describe('planVersionChange (#4391)', () => {
  const objectsOf = (entries) => new Map(entries.map(([id, userData]) => [id, { userData }]));
  const before = [inst('a'), inst('b'), inst('c')];
  it('fades single items piece by piece', () => {
    const diff = diffVersionInstances(mapOf(before), [inst('a'), inst('c', { x: 9 }), inst('d')]);
    const plan = planVersionChange(diff, objectsOf([['a', {}], ['b', {}], ['c', {}]]), 300);
    expect(plan.plain).toBe(false);
    expect(plan.leaving).toHaveLength(2); // b removed, c changed
    expect(plan.arriving.map((i) => i.instanceId).sort()).toEqual(['c', 'd']);
  });
  it('loads plainly when a batched placement, a sign or a calendar would leave', () => {
    const diff = diffVersionInstances(mapOf(before), [inst('a'), inst('c')]); // b leaves
    for (const userData of [{ batch: {} }, { isCommunitySign: true }, { isCommunityCalendar: true }]) {
      expect(planVersionChange(diff, objectsOf([['b', userData]]), 300).plain).toBe(true);
    }
  });
  it('does not mind an unbatched arrival next to a batch it does not touch', () => {
    const diff = diffVersionInstances(mapOf(before), [...before, inst('d')]); // only an arrival
    expect(planVersionChange(diff, objectsOf([['a', { batch: {} }]]), 300).plain).toBe(false);
  });
  it('loads plainly when the change is too big to fade piece by piece', () => {
    const many = Array.from({ length: 12 }, (_, n) => inst(`n${n}`));
    const diff = diffVersionInstances(new Map(), many);
    expect(planVersionChange(diff, new Map(), 10).plain).toBe(true);
    expect(planVersionChange(diff, new Map(), 12).plain).toBe(false);
  });
  it('skips an id that was never drawn (a model that failed)', () => {
    const diff = diffVersionInstances(mapOf(before), [inst('a'), inst('c')]);
    expect(planVersionChange(diff, objectsOf([]), 300)).toEqual({ plain: false, leaving: [], arriving: [] });
  });
});
