import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createTierCrossfades, TIER_CROSSFADE_MS } from './tierCrossfade.js';

// models.js builds its ground texture on a canvas when it loads; the node test
// environment has no DOM, so give it a canvas that accepts and ignores drawing.
const noop = () => {};
globalThis.document ??= {
  createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: () => noop, set: () => true }) }),
};
const { setInstanceLodState } = await import('../world/models.js');

function fakeDissolve() {
  const dissolve = { level: null, restored: false, setLevel(l) { dissolve.level = l; }, restore() { dissolve.restored = true; } };
  return dissolve;
}

function makeFades(overrides = {}) {
  const state = { now: 1000, dissolves: [] };
  const fades = createTierCrossfades({
    createDissolve: () => { const d = fakeDissolve(); state.dissolves.push(d); return d; },
    clock: () => state.now,
    reducedMotion: () => false,
    ...overrides,
  });
  return { fades, state };
}

function makeItem() {
  const full = new THREE.Group();
  const mid = new THREE.Group();
  const far = new THREE.Group();
  mid.visible = false;
  far.visible = false;
  const object = new THREE.Group();
  object.add(full, mid, far);
  new THREE.Group().add(object); // a placed item always has a parent
  object.userData.lodTiers = { mid, far };
  return { object, full, mid, far };
}

describe('tier crossfade', () => {
  it('keeps the outgoing version drawn while the incoming one dissolves in, then hides it', () => {
    const { fades, state } = makeFades();
    const { object, full, mid } = makeItem();
    setInstanceLodState(object, 'full', fades);
    setInstanceLodState(object, 'mid', fades);
    expect(mid.visible).toBe(true);
    expect(full.visible).toBe(true);
    expect(state.dissolves[0].level).toBe(0);
    expect(fades.inFlightCount).toBe(1);
    state.now += TIER_CROSSFADE_MS / 2;
    fades.update();
    expect(state.dissolves[0].level).toBeCloseTo(0.5);
    expect(full.visible).toBe(true);
    state.now += TIER_CROSSFADE_MS;
    fades.update();
    expect(full.visible).toBe(false);
    expect(mid.visible).toBe(true);
    expect(state.dissolves[0].restored).toBe(true);
    expect(fades.inFlightCount).toBe(0);
  });

  it('only the incoming version takes taps while both are drawn', () => {
    const { fades } = makeFades();
    const { object, full, mid } = makeItem();
    setInstanceLodState(object, 'full', fades);
    setInstanceLodState(object, 'mid', fades);
    expect(full.raycast()).toBe(false);
    expect(mid.raycast).not.toBe(full.raycast);
    expect(Object.prototype.hasOwnProperty.call(mid, 'raycast')).toBe(false);
  });

  it('swaps instantly for reduced motion, the first state, and past the in-flight cap', () => {
    const reduced = makeFades({ reducedMotion: () => true });
    const a = makeItem();
    setInstanceLodState(a.object, 'full', reduced.fades);
    setInstanceLodState(a.object, 'mid', reduced.fades);
    expect(a.full.visible).toBe(false);
    expect(a.mid.visible).toBe(true);
    expect(reduced.fades.inFlightCount).toBe(0);

    const capped = makeFades({ maxInFlight: 1 });
    const b = makeItem();
    const c = makeItem();
    for (const item of [b, c]) setInstanceLodState(item.object, 'full', capped.fades);
    setInstanceLodState(b.object, 'mid', capped.fades);
    setInstanceLodState(c.object, 'mid', capped.fades);
    expect(b.full.visible).toBe(true); // fading
    expect(c.full.visible).toBe(false); // over the cap: instant
    expect(capped.fades.inFlightCount).toBe(1);
  });

  it('a newer swap settles the fade first, and an unloaded item gives its clones back', () => {
    const { fades, state } = makeFades();
    const { object, full, mid, far } = makeItem();
    const root = object.parent;
    setInstanceLodState(object, 'full', fades);
    setInstanceLodState(object, 'mid', fades);
    setInstanceLodState(object, 'far', fades);
    expect(full.visible).toBe(false);
    expect(mid.visible).toBe(true); // settled fade: mid still draws until far finishes
    expect(far.visible).toBe(true);
    expect(state.dissolves[0].restored).toBe(true);
    root.remove(object);
    fades.update();
    expect(fades.inFlightCount).toBe(0);
    expect(state.dissolves[1].restored).toBe(true);
  });
});
