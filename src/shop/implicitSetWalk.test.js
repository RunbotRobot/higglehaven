// #4063: a loose wall changes detail exactly as the same wall bundled does. The walk uses the same pure
// rules the Shop tick calls (lodTier.js) with the implicit set (implicitLodSets.js) standing in for the
// builder's bundle, from 2 m out to 120 m and back: the two walls pass through the same tiers at the same
// distances, as one decision, and a loose wall of a different product next to it is its own set.
import { describe, expect, it } from 'vitest';
import { apparentSizePx, nextTier, budgetedTiers, isNearFullDetail, setBoundingSphere } from './lodTier.js';
import { findImplicitSets } from './implicitLodSets.js';

const FOV = 60;
const VIEWPORT_H = 844;
const BRICK_RADIUS_M = 0.25;

function buildWall(columns = 83, rows = 10, key = 'brick', originX = 0) {
  const bricks = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) bricks.push({ key, x: originX + (col - 41) * 0.5, y: 0, z: row * 0.5 + 0.25, radiusM: BRICK_RADIUS_M });
  }
  return bricks;
}

// One tick for one set of members, as updateInstanceLodTiers does it.
function tickSet(members, state, avatarY) {
  const sphere = setBoundingSphere(members);
  const camera = { x: 0, y: avatarY + 2, z: 2.5 };
  const px = apparentSizePx(sphere.radiusM, Math.hypot(sphere.x - camera.x, sphere.y - camera.y, sphere.z - camera.z), FOV, VIEWPORT_H);
  const near = members.some((m) => isNearFullDetail(Math.hypot(m.x, m.y - avatarY), state.near === true));
  state.near = near;
  const tiers = budgetedTiers(members.map(() => ({ px, protected: near, wanted: near ? 'full' : nextTier(state.tier, px) })));
  state.tier = tiers[0];
  return { tier: tiers[0], allSame: tiers.every((t) => t === tiers[0]) };
}

function distances() {
  const out = [];
  for (let d = 2; d <= 120; d += 0.5) out.push(d);
  for (let d = 120; d >= 2; d -= 0.5) out.push(d);
  return out;
}

describe('a loose wall and the same wall bundled (#4063)', () => {
  it('the loose wall is found as one set with every brick in it', () => {
    const wall = buildWall();
    const sets = findImplicitSets(wall);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toHaveLength(wall.length);
  });

  it('walk 2 m to 120 m and back: the same tier at every distance, one decision for the whole wall', () => {
    const wall = buildWall(8, 4); // a small wall, so it is small enough on screen to step down with distance
    const bundled = { state: {}, members: wall };
    const loose = { state: {}, members: findImplicitSets(wall).map((indices) => indices.map((i) => wall[i]))[0] };
    const bundledTiers = [];
    const looseTiers = [];
    let everyoneAgreed = true;
    for (const d of distances()) {
      bundledTiers.push(tickSet(bundled.members, bundled.state, d).tier);
      const result = tickSet(loose.members, loose.state, d);
      looseTiers.push(result.tier);
      if (!result.allSame) everyoneAgreed = false;
    }
    expect(looseTiers).toEqual(bundledTiers);
    expect(everyoneAgreed).toBe(true);
    // It does go through the versions (full beside the avatar, simpler far away), not stay on one.
    expect(new Set(looseTiers).size).toBeGreaterThan(1);
  });

  it('a wall of a different product standing right beside it is its own set', () => {
    const sets = findImplicitSets([...buildWall(20, 4, 'brick'), ...buildWall(20, 4, 'stone', 0).map((s) => ({ ...s, y: 0.1 }))]);
    expect(sets).toHaveLength(2);
    expect(sets.map((s) => s.length)).toEqual([80, 80]);
  });
});
