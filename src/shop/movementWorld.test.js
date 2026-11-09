// #3293 (leaf 2/6 of #3291): the world adapter seam. A fake world blocks,
// lands and clamps through the same functions Shop's default world uses, and
// Shop's default adapter answers exactly what the old direct reads did
// (loaded landlets only, group offset added, live radius/terrain).
import { describe, expect, it } from 'vitest';
import flightSource from './flightMovement.js?raw';
import {
  setMovementWorld, movementWorld, createShopMovementWorld,
  positionBlockedIn, landingObstructionTopZIn, clampRadiusIn,
} from './movementWorld.js';

// Axis-aligned boxes: enough geometry to exercise the seam without three.js.
const geometry = {
  meshDimensions: (mesh) => mesh.size,
  footprintCorners: (mesh, x, y) => {
    const hw = mesh.size.width / 2;
    const hd = mesh.size.depth / 2;
    return [[x + hw, y + hd], [x + hw, y - hd], [x - hw, y - hd], [x - hw, y + hd]];
  },
  footprintsOverlap: (a, b) => {
    const box = (c) => ({ minX: c[2][0], maxX: c[0][0], minY: c[2][1], maxY: c[0][1] });
    const A = box(a);
    const B = box(b);
    return !(A.maxX < B.minX || B.maxX < A.minX || A.maxY < B.minY || B.maxY < A.minY);
  },
  isFlooring: (template) => template === 'flooring',
};

function mesh({ x = 0, y = 0, z = 0, width = 2, depth = 2, height = 2, template = 'crate' } = {}) {
  return { position: { x, y, z }, size: { width, depth, height }, userData: { template } };
}
function avatarCorners(x, y, half = 0.25) {
  return [[x + half, y + half], [x + half, y - half], [x - half, y - half], [x - half, y + half]];
}
// A world that is not Shop's: one obstacle list, flat ground, fixed radius.
function fakeWorld(meshes, { radius = 10, origin = [0, 0, 0] } = {}) {
  return {
    forEachObstacle(visit) {
      for (const m of meshes) if (visit(m, ...origin) === true) return true;
      return false;
    },
    groundHeightAt: () => 0,
    worldRadiusM: () => radius,
  };
}

describe('positionBlockedIn / landingObstructionTopZIn through a fake world', () => {
  it('blocks on a horizontal overlap with vertical overlap, not beside or above it', () => {
    const world = fakeWorld([mesh({ x: 5, y: 5, z: 1, height: 2 })]); // occupies z 0..2
    expect(positionBlockedIn(world, geometry, avatarCorners(5, 5), 0.5, 1.8)).toBe(true);
    expect(positionBlockedIn(world, geometry, avatarCorners(9, 5), 0.5, 1.8)).toBe(false);
    expect(positionBlockedIn(world, geometry, avatarCorners(5, 5), 2, 1.8)).toBe(false); // standing on top
    expect(positionBlockedIn(world, geometry, avatarCorners(5, 5), 5, 1.8)).toBe(false); // flying above
  });

  it('never treats flooring as an obstacle or a landing surface', () => {
    const world = fakeWorld([mesh({ x: 0, y: 0, z: 0.05, height: 0.1, template: 'flooring' })]);
    expect(positionBlockedIn(world, geometry, avatarCorners(0, 0), 0, 1.8)).toBe(false);
    expect(landingObstructionTopZIn(world, geometry, avatarCorners(0, 0))).toBe(null);
  });

  it('lands on the highest top under the footprint, ignoring avatar z', () => {
    const world = fakeWorld([
      mesh({ x: 0, y: 0, z: 0.5, height: 1 }), // top at 1
      mesh({ x: 0, y: 0, z: 1.5, height: 3 }), // top at 3
      mesh({ x: 20, y: 20, z: 5, height: 10 }), // elsewhere
    ]);
    expect(landingObstructionTopZIn(world, geometry, avatarCorners(0, 0))).toBe(3);
    expect(landingObstructionTopZIn(world, geometry, avatarCorners(-9, -9))).toBe(null);
  });

  it("adds the world's own origin offset to every obstacle (x, y and z)", () => {
    const world = fakeWorld([mesh({ x: 1, y: 1, z: 1, height: 2 })], { origin: [10, 20, 3] });
    // obstacle sits at world (11, 21), z 3..5
    expect(positionBlockedIn(world, geometry, avatarCorners(11, 21), 4, 1.8)).toBe(true);
    expect(positionBlockedIn(world, geometry, avatarCorners(1, 1), 4, 1.8)).toBe(false);
    expect(positionBlockedIn(world, geometry, avatarCorners(11, 21), 0, 1.8)).toBe(false); // below it
    expect(landingObstructionTopZIn(world, geometry, avatarCorners(11, 21))).toBe(5);
  });

  it('stops walking at the first blocking obstacle', () => {
    let visited = 0;
    const world = {
      forEachObstacle(visit) {
        for (const m of [mesh({ x: 0, y: 0 }), mesh({ x: 0, y: 0 })]) {
          visited++;
          if (visit(m, 0, 0, 0) === true) return true;
        }
        return false;
      },
    };
    expect(positionBlockedIn(world, geometry, avatarCorners(0, 0), 0.5, 1.8)).toBe(true);
    expect(visited).toBe(1);
  });
});

describe('clampRadiusIn', () => {
  it('pulls a point radially back inside the radius, in place', () => {
    const p = { x: 30, y: 40 }; // distance 50
    clampRadiusIn(fakeWorld([]), p, 5);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(5);
    expect(p.x / p.y).toBeCloseTo(30 / 40);
  });

  it('leaves a point already inside alone', () => {
    const p = { x: 1, y: 1 };
    clampRadiusIn(fakeWorld([]), p, 5);
    expect(p).toEqual({ x: 1, y: 1 });
  });

  it('is a no-op while the world has no boundary yet', () => {
    const p = { x: 300, y: 400 };
    clampRadiusIn(fakeWorld([], { radius: null }), p, 5);
    expect(p).toEqual({ x: 300, y: 400 });
  });
});

describe("Shop's default world", () => {
  function shopWorld() {
    const state = {
      radius: null,
      landlets: new Map(),
      terrainCalls: [],
    };
    const world = createShopMovementWorld({
      landlets: () => state.landlets,
      terrainHeightAt: (x, y) => { state.terrainCalls.push([x, y]); return x + y; },
      worldRadiusM: () => state.radius,
    });
    return { state, world };
  }
  const entry = (loaded, objects, [x, y, z]) => ({ loaded, objects, group: { position: { x, y, z } } });

  it('walks only loaded landlets, handing out each landlet group position as the origin', () => {
    const { state, world } = shopWorld();
    const a = mesh();
    const b = mesh();
    const hidden = mesh();
    state.landlets.set('a', entry(true, [a], [1, 2, 3]));
    state.landlets.set('b', entry(true, [b], [10, 20, 30]));
    state.landlets.set('far', entry(false, [hidden], [99, 99, 99]));
    const seen = [];
    world.forEachObstacle((m, x, y, z) => { seen.push([m, x, y, z]); });
    expect(seen).toEqual([[a, 1, 2, 3], [b, 10, 20, 30]]);
  });

  it('reads the landlet map, radius and terrain live, not as a snapshot', () => {
    const { state, world } = shopWorld();
    expect(world.worldRadiusM()).toBe(null);
    state.radius = 120;
    expect(world.worldRadiusM()).toBe(120);
    expect(world.groundHeightAt(3, 4)).toBe(7);
    expect(state.terrainCalls).toEqual([[3, 4]]);
    state.landlets = new Map([['late', entry(true, [mesh()], [0, 0, 0])]]);
    let count = 0;
    world.forEachObstacle(() => { count++; });
    expect(count).toBe(1);
  });

  it('collides and lands exactly as the old direct landlet walk did', () => {
    const { state, world } = shopWorld();
    // landlet elevated 4 m, a crate at local (2, 2, 1), 2 tall -> world z 4..6 at (12, 12)
    state.landlets.set('a', entry(true, [mesh({ x: 2, y: 2, z: 1, height: 2 })], [10, 10, 4]));
    expect(positionBlockedIn(world, geometry, avatarCorners(12, 12), 5, 1.8)).toBe(true);
    expect(positionBlockedIn(world, geometry, avatarCorners(12, 12), 6, 1.8)).toBe(false);
    expect(landingObstructionTopZIn(world, geometry, avatarCorners(12, 12))).toBe(6);
  });
});

describe('the registry', () => {
  it('hands back the registered world', () => {
    const world = fakeWorld([]);
    setMovementWorld(world);
    expect(movementWorld()).toBe(world);
  });
});

// flightMovement.js has no unit-test pool (three.js, live Shop state), so the
// structural promise of the seam is pinned in its source: the core reads
// obstacles, ground height and the boundary radius only through the adapter.
describe('flightMovement.js reads its world through the adapter', () => {
  function body(name) {
    const start = flightSource.search(new RegExp(`function ${name}\\(`));
    expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
    const open = flightSource.indexOf('{', flightSource.indexOf(')', start));
    let depth = 0;
    for (let i = open; i < flightSource.length; i++) {
      if (flightSource[i] === '{') depth++;
      else if (flightSource[i] === '}' && --depth === 0) return flightSource.slice(open, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
  }

  it('collision and landing no longer walk Shop landlets directly', () => {
    expect(body('shopPositionBlocked')).not.toContain('shopLandlets');
    expect(body('shopLandingObstructionTopZ')).not.toContain('shopLandlets');
  });

  it('only the default registration touches shopTerrainHeightAtM and shopWorldRadiusM as values', () => {
    const code = flightSource
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code.match(/shopTerrainHeightAtM\(/g) ?? []).toHaveLength(1);
    expect(code.match(/\bshopWorldRadiusM\b/g) ?? []).toHaveLength(2); // the import and the getter
  });
});
