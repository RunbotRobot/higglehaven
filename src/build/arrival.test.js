// #4003 (slice a): Build's arrival through fog.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
const { createBuildArrival } = await import('./arrival.js');

function fakeEffects() {
  const log = { fogs: [], dissolves: [] };
  return {
    log,
    effects: {
      createFog: (args) => {
        const fog = { args, object: new THREE.Group(), level: -1, disposed: false, setLevel(l) { fog.level = l; }, dispose() { fog.disposed = true; fog.object.removeFromParent(); } };
        log.fogs.push(fog);
        return fog;
      },
      createDissolve: (root) => {
        const d = { root, level: -1, restored: false, setLevel(l) { d.level = l; }, restore() { d.restored = true; } };
        log.dissolves.push(d);
        return d;
      },
    },
  };
}

const home = new THREE.Group();
function items(positions, attached = home) {
  return positions.map(([x, y], i) => {
    const object = new THREE.Group();
    const model = new THREE.Group();
    model.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()));
    object.add(model);
    object.userData = { instanceId: `i${i}`, model, lodRadiusM: 0.5 };
    object.position.set(x, y, 0);
    if (attached) attached.add(object);
    return object;
  });
}

function setup(options = {}) {
  const parent = new THREE.Group();
  const { log, effects } = fakeEffects();
  let now = 0;
  const arrival = createBuildArrival({ parent, effects, clock: () => now, reducedMotion: () => options.reduced === true });
  return { parent, log, arrival, advance: (ms) => { now += ms; arrival.update(); } };
}

describe('Build arrival through fog', () => {
  it('gives a wall one fog and one dissolve, not one per brick', () => {
    const { arrival, log, parent } = setup();
    const wall = items(Array.from({ length: 200 }, (_, i) => [(i % 20) * 0.5, Math.floor(i / 20) * 0.5]));
    arrival.start(wall);
    expect(log.fogs).toHaveLength(1);
    expect(log.dissolves).toHaveLength(1);
    expect(parent.children).toHaveLength(1);
    expect(wall.every((o) => o.userData.lodArriving)).toBe(true);
    expect(log.dissolves[0].level).toBe(0);
  });

  it('rises the fog first, then dissolves the items in, then restores everything', () => {
    const { arrival, log, advance, parent } = setup();
    const wall = items([[0, 0], [1, 0]]);
    arrival.start(wall);
    advance(250);
    expect(log.fogs[0].level).toBeGreaterThan(0);
    expect(log.dissolves[0].level).toBe(0); // never seen before there is fog to come out of
    advance(750); // 1.0 s: items are part-way
    expect(log.dissolves[0].level).toBeGreaterThan(0);
    expect(log.dissolves[0].level).toBeLessThan(1);
    advance(1000);
    expect(log.dissolves[0].restored).toBe(true);
    expect(log.fogs[0].disposed).toBe(true);
    expect(parent.children).toHaveLength(0);
    expect(wall.some((o) => o.userData.lodArriving)).toBe(false);
    expect(arrival.arrivingCount()).toBe(0);
    expect(arrival.fogCount()).toBe(0);
  });

  it('under reduced motion makes no fog and fades the items plainly and briefly', () => {
    const { arrival, log, advance } = setup({ reduced: true });
    arrival.start(items([[0, 0], [30, 30]]));
    expect(log.fogs).toHaveLength(0);
    advance(100);
    expect(log.dissolves[0].level).toBeGreaterThan(0);
    advance(200);
    expect(log.dissolves.every((d) => d.restored)).toBe(true);
  });

  it('caps the fogs at once and gives the rest a plain dissolve', () => {
    const { arrival, log } = setup();
    arrival.start(items(Array.from({ length: 30 }, (_, i) => [i * 40, 0])));
    expect(log.fogs.length).toBeLessThanOrEqual(12);
    expect(log.dissolves).toHaveLength(30);
  });

  it('costs nothing when nothing is arriving and ends when every item has been removed', () => {
    const { arrival, log, advance } = setup();
    advance(1000);
    expect(log.fogs).toHaveLength(0);
    const one = items([[0, 0]], null);
    arrival.start(one); // removed before it arrived
    advance(16);
    expect(log.dissolves[0].restored).toBe(true);
  });
});
