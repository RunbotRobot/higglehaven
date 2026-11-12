import { describe, expect, it } from 'vitest';
import { ARRIVAL_MAX_WAIT_S, aliveArrivalFogCount, createArrivalRun } from './arrivalRun.js';
import { ARRIVAL_MAX_ALIVE_FOGS, ARRIVAL_RESOLVE_S } from './arrivalFog.js';

// Fakes with the same shape as arrivalEffect.js, so the lifecycle (what is
// created, driven and released) can be asserted without three.js.
function fakeEffects() {
  const log = { fogs: [], dissolves: [] };
  return {
    log,
    effects: {
      createFog(options) {
        const fog = {
          options,
          level: -1,
          disposed: false,
          object: { removed: false },
          setLevel(level) { fog.level = level; },
          dispose() { fog.disposed = true; },
        };
        log.fogs.push(fog);
        return fog;
      },
      createDissolve(object) {
        const dissolve = {
          object,
          level: -1,
          restored: false,
          setLevel(level) { dissolve.level = level; },
          restore() { dissolve.restored = true; },
        };
        log.dissolves.push(dissolve);
        return dissolve;
      },
    },
  };
}

function setup(instances, options = {}) {
  let now = 1000;
  const { log, effects } = fakeEffects();
  const added = [];
  const run = createArrivalRun({
    parent: { add: (object) => added.push(object) },
    instances,
    templateFor: () => ({ dimensions: { width: 1, depth: 1, height: 1 } }),
    clock: () => now,
    reducedMotion: false,
    effects,
    ...options,
  });
  return { run, log, added, advance: (ms) => { now += ms; }, setNow: (ms) => { now = ms; } };
}

const wall = (n) => Array.from({ length: n }, (_, i) => ({
  instanceId: `w${i}`, templateId: 't', x: i * 0.5, y: 0, z: 0.5, groupId: 'g1',
}));

describe('createArrivalRun', () => {
  it('starts one fog per cluster the moment the list arrives, before any item is built', () => {
    const { run, log, added } = setup([...wall(40), { instanceId: 'lamp', templateId: 't', x: 30, y: 30, z: 0.5 }]);
    expect(log.fogs.length).toBe(2); // the wall is one cluster, the lamp another
    expect(added.length).toBe(2);
    expect(log.fogs.every((fog) => fog.level === 0)).toBe(true);
    expect(log.dissolves.length).toBe(0);
    expect(run.stats().fogsAlive).toBe(2);
    run.dispose();
  });

  it('holds items invisible until their whole cluster has settled, then resolves them', () => {
    const { run, log, advance } = setup(wall(3));
    run.itemReady('w0', {});
    run.itemReady('w1', {});
    advance(2000);
    run.update();
    expect(log.fogs[0].level).toBe(1); // fully risen, waiting for the rest
    expect(log.dissolves.map((d) => d.level)).toEqual([0, 0]); // nothing visible yet
    run.itemReady('w2', {});
    advance((ARRIVAL_RESOLVE_S * 1000) / 2);
    run.update();
    expect(log.dissolves.every((d) => d.level > 0 && d.level < 1)).toBe(true);
    advance(ARRIVAL_RESOLVE_S * 1000);
    run.update();
    // At rest: fog gone and disposed, plain materials back.
    expect(log.fogs[0].disposed).toBe(true);
    expect(log.dissolves.every((d) => d.restored)).toBe(true);
    expect(run.stats().arriving).toBe(0);
  });

  it('is settled only once every cluster has fully arrived (#3479: the far view waits for this)', () => {
    const { run, advance } = setup(wall(2));
    expect(run.settled()).toBe(false);
    run.itemReady('w0', {});
    run.itemReady('w1', {});
    advance(500);
    run.update();
    expect(run.settled()).toBe(false); // still resolving out of its fog
    advance(ARRIVAL_RESOLVE_S * 2000);
    run.update();
    expect(run.settled()).toBe(true);
    expect(setup([]).run.settled()).toBe(true); // nothing to show
  });

  it('an item that never arrives does not hold its cluster back', () => {
    const { run, log, advance } = setup(wall(2));
    run.itemReady('w0', {});
    run.itemSettled('w1'); // its model failed to build
    advance(5000);
    run.update();
    advance(5000);
    run.update();
    expect(log.fogs[0].disposed).toBe(true);
    expect(log.dissolves[0].restored).toBe(true);
  });

  it('a cluster whose last item stalls resolves after the maximum wait', () => {
    const { run, log, advance } = setup(wall(2));
    run.itemReady('w0', {});
    advance((ARRIVAL_MAX_WAIT_S + 1) * 1000);
    run.update(); // forced ready now, starts resolving
    expect(log.dissolves[0].level).toBe(0);
    advance(ARRIVAL_RESOLVE_S * 1000 + 100);
    run.update();
    expect(log.fogs[0].disposed).toBe(true);
    expect(log.dissolves[0].restored).toBe(true);
  });

  it('dispose releases every fog and restores every material, mid-arrival', () => {
    const before = aliveArrivalFogCount();
    const { run, log } = setup([...wall(5), { instanceId: 'b', templateId: 't', x: 40, y: 40, z: 0 }]);
    run.itemReady('w0', {});
    expect(aliveArrivalFogCount()).toBe(before + 2);
    run.dispose();
    expect(log.fogs.every((fog) => fog.disposed)).toBe(true);
    expect(log.dissolves.every((d) => d.restored)).toBe(true);
    expect(aliveArrivalFogCount()).toBe(before);
    run.dispose(); // twice is harmless
    run.itemReady('w1', {}); // a late item of a disposed run is ignored
    expect(log.dissolves.length).toBe(1);
  });

  it('caps the fogs alive across runs and gives the rest the plain dissolve', () => {
    const many = Array.from({ length: ARRIVAL_MAX_ALIVE_FOGS + 6 }, (_, i) => ({
      instanceId: `s${i}`, templateId: 't', x: i * 40, y: 0, z: 0, // each far from the others
    }));
    const { run, log } = setup(many);
    expect(log.fogs.length).toBe(ARRIVAL_MAX_ALIVE_FOGS);
    // A cluster without a fog still dissolves in and finishes.
    run.itemReady(`s${ARRIVAL_MAX_ALIVE_FOGS + 5}`, {});
    run.dispose();
    expect(aliveArrivalFogCount()).toBe(0);
  });

  it('reduced motion creates no fog and just fades the items', () => {
    const { run, log, advance } = setup(wall(2), { reducedMotion: true });
    expect(log.fogs.length).toBe(0);
    run.itemReady('w0', {});
    run.itemReady('w1', {});
    advance(100);
    run.update();
    expect(log.dissolves[0].level).toBeGreaterThan(0);
    advance(500);
    run.update();
    expect(log.dissolves.every((d) => d.restored)).toBe(true);
  });

  it('ignores items it does not know and survives an empty or malformed list', () => {
    const { run } = setup([null, { templateId: 't' }]);
    run.itemReady('nope', {});
    run.itemSettled('nope');
    run.update();
    expect(run.stats().clusters).toBe(0);
    run.dispose();
  });
});
