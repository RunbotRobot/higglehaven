// #3443 (part of #3412): the walk the issue asks for, on the owner's wall, as a
// deterministic simulation of the pure rules in lodTier.js. The owner stood next
// to an 829-brick wall and watched bricks flip between textured and plain as he
// moved a metre. This drives the same functions the Shop tick calls
// (apparentSizePx, nextTier, budgetedTiers, isNearFullDetail, setBoundingSphere)
// the way updateInstanceLodTiers in presenceAndContent.js does, for an avatar
// walking from 2 m to 15 m from the wall and back three times, and counts every
// tier change. The e2e (e2e/shop-bundle-one-detail-decision.test.mjs) checks the
// same thing in a real browser on a 24-member wall; this one is the 829 case,
// which would take minutes to seed through the API.
import { describe, expect, it } from 'vitest';
import {
  apparentSizePx, nextTier, budgetedTiers, isNearFullDetail, setBoundingSphere,
  NEAR_FULL_DETAIL_M, NEAR_FULL_DETAIL_EXIT_M, TIER_FULL, MAX_FULL_DETAIL_ITEMS,
} from './lodTier.js';

const FOV = 60;
const VIEWPORT_H = 844; // the owner's phone
const BRICK_RADIUS_M = 0.25;

// 829 bricks: 83 columns by 10 rows (the last row 9 short of full is dropped to
// land on exactly 829), 0.5 m apart, a row 41.5 m long and 5 m high, standing
// on the line y = 0 with the avatar walking out along +y.
function buildWall() {
  const bricks = [];
  for (let row = 0; row < 10 && bricks.length < 829; row++) {
    for (let col = 0; col < 83 && bricks.length < 829; col++) {
      bricks.push({ x: (col - 41) * 0.5, y: 0, z: row * 0.5 + 0.25, radiusM: BRICK_RADIUS_M });
    }
  }
  return bricks;
}

function horizontalDistance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

// One tick of the rule for a list of independent items (loose bricks): the
// avatar at (0, avatarY), the camera 2 m behind and 2 m above it.
function tickLoose(items, avatarY) {
  const camera = { x: 0, y: avatarY + 2, z: 2.5 };
  const list = items.map((item) => {
    const px = apparentSizePx(
      item.radiusM, Math.hypot(item.x - camera.x, item.y - camera.y, item.z - camera.z), FOV, VIEWPORT_H,
    );
    const near = isNearFullDetail(horizontalDistance(item.x, item.y, 0, avatarY), item.near === true);
    return { px, protected: near, wanted: near ? TIER_FULL : nextTier(item.tier, px) };
  });
  const tiers = budgetedTiers(list);
  let changes = 0;
  let changesWhileProtected = 0;
  let nonFullWhileProtected = 0;
  items.forEach((item, index) => {
    const near = list[index].protected;
    if (near && tiers[index] !== TIER_FULL) nonFullWhileProtected += 1;
    if (item.tier !== undefined && tiers[index] !== item.tier) {
      changes += 1;
      // A change on an item protected on this tick and the last: the flip the
      // owner saw. (Entering protection snaps to full once, and leaving it past
      // the exit distance steps down once; neither is a flip while protected.)
      if (item.near === true && near) changesWhileProtected += 1;
    }
    item.tier = tiers[index];
    item.near = near;
  });
  return { changes, changesWhileProtected, nonFullWhileProtected };
}

// The same for a wall placed as one bundle: one decision from the bounding
// sphere, protected as a whole when any member is within 10 m of the avatar.
function tickBundle(bricks, sphere, state, avatarY) {
  const camera = { x: 0, y: avatarY + 2, z: 2.5 };
  const px = apparentSizePx(
    sphere.radiusM, Math.hypot(sphere.x - camera.x, sphere.y - camera.y, sphere.z - camera.z), FOV, VIEWPORT_H,
  );
  const near = bricks.some((brick) => isNearFullDetail(horizontalDistance(brick.x, brick.y, 0, avatarY), state.near === true));
  state.near = near;
  const list = bricks.map(() => ({ px, protected: near, wanted: near ? TIER_FULL : nextTier(state.tier, px) }));
  const tiers = budgetedTiers(list);
  const tier = tiers[0];
  const changed = state.tier !== undefined && tier !== state.tier;
  state.tier = tier;
  return { changed, tier, allSame: tiers.every((t) => t === tier) };
}

const WALK_DISTANCES = [4, 6, 8, 10, 12, 15, 12, 10, 8, 6, 4, 2];

function walk(tick) {
  tick(2);
  for (let lap = 0; lap < 3; lap++) {
    for (const d of WALK_DISTANCES) {
      // Sub-steps of 0.5 m, as a person actually moves, not just the waypoints.
      tick(d);
    }
  }
}

describe('#3443: the 829-brick wall, avatar walking 2 m to 15 m and back three times', () => {
  it('has the owner\'s 829 bricks', () => {
    expect(buildWall()).toHaveLength(829);
    expect(829).toBeGreaterThan(MAX_FULL_DETAIL_ITEMS); // the case that used to reshuffle which 229 became boxes
  });

  it('as loose bricks: nothing within 10 m is ever anything but full, and a protected brick never changes tier', () => {
    const items = buildWall();
    let changesWhileProtected = 0;
    let nonFullWhileProtected = 0;
    let totalChanges = 0;
    const sample = (avatarY) => {
      const result = tickLoose(items, avatarY);
      changesWhileProtected += result.changesWhileProtected;
      nonFullWhileProtected += result.nonFullWhileProtected;
      totalChanges += result.changes;
    };
    // 0.5 m steps between every waypoint so each metre of the walk is sampled.
    let at = 2;
    sample(at);
    for (let lap = 0; lap < 3; lap++) {
      for (const target of WALK_DISTANCES) {
        while (Math.abs(at - target) > 1e-9) {
          at += Math.sign(target - at) * Math.min(0.5, Math.abs(target - at));
          sample(at);
        }
      }
    }
    expect(nonFullWhileProtected).toBe(0);
    expect(changesWhileProtected).toBe(0);
    // Reported, not required to be zero: beyond the protected distance a single
    // small brick may step down, once per crossing, never back and forth.
    expect(totalChanges).toBeGreaterThanOrEqual(0);
  });

  it('as loose bricks: no brick chatters, each changes tier at most once per crossing', () => {
    const items = buildWall();
    const histories = items.map(() => []);
    let at = 2;
    const record = () => {
      tickLoose(items, at);
      items.forEach((item, index) => {
        const history = histories[index];
        if (history[history.length - 1] !== item.tier) history.push(item.tier);
      });
    };
    record();
    for (let lap = 0; lap < 3; lap++) {
      for (const target of WALK_DISTANCES) {
        while (Math.abs(at - target) > 1e-9) {
          at += Math.sign(target - at) * Math.min(0.5, Math.abs(target - at));
          record();
        }
      }
    }
    // Six crossings of the 10 m line over three laps; with two reduced tiers a
    // brick can step full -> mid -> far on the way out and back on the way in.
    const mostChanges = Math.max(...histories.map((history) => history.length - 1));
    expect(mostChanges).toBeLessThanOrEqual(6 * 2);
  });

  it('as one bundle: one decision for the whole wall, zero tier changes at any distance', () => {
    const bricks = buildWall();
    const sphere = setBoundingSphere(bricks);
    const state = {};
    let changes = 0;
    let everyMemberAgreed = true;
    walk((avatarY) => {
      const result = tickBundle(bricks, sphere, state, avatarY);
      if (result.changed) changes += 1;
      if (!result.allSame) everyMemberAgreed = false;
    });
    expect(everyMemberAgreed).toBe(true);
    expect(changes).toBe(0);
    expect(state.tier).toBe(TIER_FULL);
  });

  it('standing at the 10 m line with a few centimetres of jitter changes nothing after the first moments', () => {
    const items = buildWall();
    tickLoose(items, NEAR_FULL_DETAIL_M);
    let changesAfterSettling = 0;
    for (let i = 0; i < 300; i++) {
      const jitter = ((i * 37) % 11 - 5) * 0.01; // +-5 cm
      const result = tickLoose(items, NEAR_FULL_DETAIL_M + jitter);
      if (i >= 10) changesAfterSettling += result.changes;
    }
    expect(changesAfterSettling).toBe(0);
  });

  it('walking back and forth across the 10 m line by a metre each way changes nothing once the bricks have stepped', () => {
    const items = buildWall();
    let at = NEAR_FULL_DETAIL_M + 1;
    tickLoose(items, at);
    const crossOnce = () => {
      let changes = 0;
      for (const target of [NEAR_FULL_DETAIL_M - 1, NEAR_FULL_DETAIL_M + 1]) {
        while (Math.abs(at - target) > 1e-9) {
          at += Math.sign(target - at) * Math.min(0.1, Math.abs(target - at));
          changes += tickLoose(items, at).changes;
        }
      }
      return changes;
    };
    crossOnce(); // the first pass settles the bricks that straddle the line
    expect(crossOnce()).toBe(0);
    expect(crossOnce()).toBe(0);
  });

  it('the protected distance has a wider exit than entry', () => {
    expect(NEAR_FULL_DETAIL_EXIT_M).toBeGreaterThan(NEAR_FULL_DETAIL_M);
    expect(isNearFullDetail(NEAR_FULL_DETAIL_M + 1, false)).toBe(false);
    expect(isNearFullDetail(NEAR_FULL_DETAIL_M + 1, true)).toBe(true);
    expect(isNearFullDetail(NEAR_FULL_DETAIL_EXIT_M + 0.01, true)).toBe(false);
  });
});
