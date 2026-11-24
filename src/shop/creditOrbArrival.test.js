import { describe, expect, it, vi } from 'vitest';
import { createCreditOrbFades, orbFadeLevels, ORB_FADE_S, ORB_FADE_MAX_ACTIVE } from './creditOrbArrival.js';

function makeOrb() {
  const added = [];
  return {
    mesh: { visible: true, position: { x: 1, y: 2, z: 3 } },
    group: { add: (o) => added.push(o) },
    added,
  };
}

function setup(extra = {}) {
  const fogs = [];
  const dissolves = [];
  const fades = createCreditOrbFades({
    createFog: () => {
      const fog = { object: {}, level: 0, disposed: false, setLevel(l) { this.level = l; }, dispose() { this.disposed = true; } };
      fogs.push(fog);
      return fog;
    },
    createDissolve: () => {
      const d = { level: 0, restored: false, setLevel(l) { this.level = l; }, restore() { this.restored = true; } };
      dissolves.push(d);
      return d;
    },
    ...extra,
  });
  return { fades, fogs, dissolves };
}

describe('orbFadeLevels', () => {
  it('goes from nothing to the whole orb, with fog in the middle and none at the ends', () => {
    expect(orbFadeLevels(0)).toEqual({ fog: 0, body: 0 });
    const end = orbFadeLevels(1);
    expect(end.body).toBe(1);
    expect(end.fog).toBeCloseTo(0, 5);
    const mid = orbFadeLevels(0.5);
    expect(mid.fog).toBeCloseTo(1, 5);
    expect(mid.body).toBeGreaterThan(0);
    expect(mid.body).toBeLessThan(1);
  });
});

describe('createCreditOrbFades (#4174)', () => {
  it('hides an arriving orb behind fog, resolves it over ORB_FADE_S, then leaves it plain and shown', () => {
    const { fades, fogs, dissolves } = setup();
    const orb = makeOrb();
    fades.arrive(orb);
    expect(orb.mesh.visible).toBe(true); // the dither shows nothing at level 0; the fog is up
    expect(dissolves[0].level).toBe(0);
    expect(orb.added).toHaveLength(1);
    fades.update(ORB_FADE_S / 2);
    expect(fogs[0].level).toBeCloseTo(1, 1);
    expect(dissolves[0].level).toBeGreaterThan(0);
    fades.update(ORB_FADE_S);
    expect(dissolves[0].restored).toBe(true);
    expect(fogs[0].disposed).toBe(true);
    expect(fades.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it('caps how many fade at once and starts the rest as slots free, hidden until then', () => {
    const { fades, fogs } = setup({ maxActive: 2 });
    const orbs = [makeOrb(), makeOrb(), makeOrb(), makeOrb()];
    orbs.forEach((orb) => fades.arrive(orb));
    expect(fogs).toHaveLength(2);
    expect(orbs[2].mesh.visible).toBe(false);
    expect(fades.stats()).toEqual({ active: 2, waiting: 2 });
    fades.update(ORB_FADE_S + 0.01);
    expect(fogs).toHaveLength(4);
    expect(orbs[2].mesh.visible).toBe(true);
    fades.update(ORB_FADE_S + 0.01);
    expect(fades.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it('dissolves a departing orb, then releases it', () => {
    const { fades, fogs } = setup();
    const orb = makeOrb();
    const done = vi.fn();
    fades.depart(orb, done);
    expect(done).not.toHaveBeenCalled();
    fades.update(ORB_FADE_S / 2);
    expect(done).not.toHaveBeenCalled();
    fades.update(ORB_FADE_S);
    expect(done).toHaveBeenCalledTimes(1);
    expect(fogs[0].disposed).toBe(true);
  });

  it('lets a departing orb go at once when every slot is taken', () => {
    const { fades } = setup({ maxActive: 1 });
    fades.arrive(makeOrb());
    const done = vi.fn();
    fades.depart(makeOrb(), done);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('an orb that leaves before it was ever shown just goes', () => {
    const { fades } = setup({ maxActive: 1 });
    fades.arrive(makeOrb());
    const waitingOrb = makeOrb();
    fades.arrive(waitingOrb);
    const done = vi.fn();
    fades.depart(waitingOrb, done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(fades.stats()).toEqual({ active: 1, waiting: 0 });
  });

  it('turns an arrival around where it is when the orb leaves mid-fade', () => {
    const { fades } = setup();
    const orb = makeOrb();
    const done = vi.fn();
    fades.arrive(orb);
    fades.update(ORB_FADE_S * 0.4);
    fades.depart(orb, done);
    fades.update(ORB_FADE_S * 0.2);
    expect(done).not.toHaveBeenCalled();
    fades.update(ORB_FADE_S);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('finish leaves the orb plain and shown at once (the orb a person collects keeps its instant pop)', () => {
    const { fades, fogs, dissolves } = setup({ maxActive: 1 });
    const orb = makeOrb();
    fades.arrive(orb);
    fades.finish(orb);
    expect(dissolves[0].restored).toBe(true);
    expect(fogs[0].disposed).toBe(true);
    expect(orb.mesh.visible).toBe(true);
    expect(fades.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it('does nothing under reduced motion: orbs appear and go as before', () => {
    const { fades, fogs } = setup({ reducedMotion: () => true });
    const orb = makeOrb();
    fades.arrive(orb);
    expect(orb.mesh.visible).toBe(true);
    const done = vi.fn();
    fades.depart(orb, done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(fogs).toHaveLength(0);
  });

  it('exports its cap', () => {
    expect(ORB_FADE_MAX_ACTIVE).toBeGreaterThan(0);
  });
});
