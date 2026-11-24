// #4063: a loose wall changes detail exactly as the same wall bundled does. The walk uses the same pure
// rules the Shop tick calls (lodTier.js) with the implicit set (implicitLodSets.js) standing in for the
// builder's bundle, from 2 m out to 120 m and back: the two walls pass through the same tiers at the same
// distances, as one decision, and a loose wall of a different product next to it is its own set.
import { describe, expect, it } from 'vitest';
import { apparentSizePx, nextTier, budgetedTiers, isNearFullDetail, setBoundingSphere, setApparentPx, SET_WHOLE_JUDGEMENT_MAX_TRIANGLES } from './lodTier.js';
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

// #4089: a big set is judged by its biggest member from its nearest one, not by its whole size.
const REAL_BRICK_RADIUS_M = 0.5 * Math.hypot(0.5, 0.5, 0.5);
const BRICK_FULL_TRIS = 5120;
const BRICK_MID_TRIS = 310; // about a tenth and less (src/modelTiers.js); the far version is a few dozen
const BRICK_FAR_TRIS = 40;

// The wall of 1,650 bricks (55 wide, 3 thick, as seeded), the avatar standing `d` m in front of its middle.
function bigWallAt(d) {
  // The real brick's bounding radius is half the diagonal of its 0.5 m cube (lodRadiusM in presenceAndContent.js).
  const wall = buildWall(110, 15, 'brick', 0).map((b) => ({ ...b, radiusM: REAL_BRICK_RADIUS_M }));
  const sphere = setBoundingSphere(wall);
  const camera = { x: 0, y: -d, z: 2.5 };
  const dist = (m) => Math.hypot(m.x - camera.x, m.y - camera.y, m.z - camera.z);
  const nearest = Math.min(...wall.map(dist));
  const set = {
    sphere, centerDistanceM: dist(sphere), maxMemberRadiusM: REAL_BRICK_RADIUS_M,
    nearestMemberDistanceM: nearest, fullTriangles: wall.length * BRICK_FULL_TRIS,
  };
  return { wall, set, camera, dist };
}

describe('a big set is judged by its biggest member (#4089)', () => {
  it('the 1,650-brick wall is far over the whole-judgement cost', () => {
    const { wall } = bigWallAt(25);
    expect(wall).toHaveLength(1650);
    expect(wall.length * BRICK_FULL_TRIS).toBeGreaterThan(SET_WHOLE_JUDGEMENT_MAX_TRIANGLES);
  });

  it('no member ever gets less apparent size than it would have alone', () => {
    for (const d of [12, 25, 60, 100]) {
      const { wall, set, dist } = bigWallAt(d);
      const px = setApparentPx(set, FOV, VIEWPORT_H);
      for (const m of wall) expect(px).toBeGreaterThanOrEqual(apparentSizePx(m.radiusM, dist(m), FOV, VIEWPORT_H) - 1e-9);
    }
  });

  it('the wall is mid at 25 m and far at 60 m, and costs about what a mid wall costs, not 1.66 million', () => {
    const triangles = (d) => {
      const { wall, set } = bigWallAt(d);
      const px = setApparentPx(set, FOV, VIEWPORT_H);
      const tier = nextTier(undefined, px);
      return { tier, triangles: wall.length * (tier === 'full' ? BRICK_FULL_TRIS : tier === 'mid' ? BRICK_MID_TRIS : BRICK_FAR_TRIS) };
    };
    const at25 = triangles(25);
    const at60 = triangles(60);
    expect(at25.tier).toBe('mid');
    expect(at25.triangles).toBeLessThan(600_000);
    expect(at60.tier).toBe('far');
    expect(at60.triangles).toBeLessThan(100_000);
  });

  it('it is still one decision: every member of the set is given the same size', () => {
    const { set } = bigWallAt(25);
    expect(setApparentPx(set, FOV, VIEWPORT_H)).toBe(setApparentPx({ ...set }, FOV, VIEWPORT_H));
  });

  it('a small set (a house, a short wall) is judged by its whole size, exactly as before', () => {
    const wall = buildWall(8, 4);
    const sphere = setBoundingSphere(wall);
    const set = { sphere, centerDistanceM: 40, maxMemberRadiusM: BRICK_RADIUS_M, nearestMemberDistanceM: 38, fullTriangles: wall.length * BRICK_FULL_TRIS };
    expect(set.fullTriangles).toBeLessThanOrEqual(SET_WHOLE_JUDGEMENT_MAX_TRIANGLES);
    expect(setApparentPx(set, FOV, VIEWPORT_H)).toBe(apparentSizePx(sphere.radiusM, 40, FOV, VIEWPORT_H));
  });
});
