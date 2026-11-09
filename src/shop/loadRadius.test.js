import { describe, expect, it } from 'vitest';
import {
  SHOP_BASE_LOAD_RADIUS_M, SHOP_BASE_UNLOAD_RADIUS_M, SHOP_MAX_LOAD_RADIUS_M, SHOP_MAX_LOADED_LANDLETS,
  shopLoadRadiusM, shopUnloadRadiusM, horizontalDistanceM, pickLandletsToLoad,
} from './loadRadius.js';

describe('shop load radius (#3261)', () => {
  it('is exactly the old fixed 60/90 m on the ground', () => {
    expect(shopLoadRadiusM(0)).toBe(SHOP_BASE_LOAD_RADIUS_M);
    expect(shopUnloadRadiusM(0)).toBe(SHOP_BASE_UNLOAD_RADIUS_M);
  });

  it('treats a missing, negative or non-finite altitude as the ground', () => {
    for (const bad of [undefined, null, NaN, -5, Infinity * -1]) {
      expect(shopLoadRadiusM(bad)).toBe(SHOP_BASE_LOAD_RADIUS_M);
    }
  });

  it('grows with altitude, so content on screen from up high is requested', () => {
    expect(shopLoadRadiusM(50)).toBeGreaterThan(shopLoadRadiusM(10));
    expect(shopLoadRadiusM(10)).toBeGreaterThan(shopLoadRadiusM(0));
    // From 50 m up, a landlet 120 m away (invisible under the old fixed 60 m) loads.
    expect(shopLoadRadiusM(50)).toBeGreaterThan(120);
  });

  it('never exceeds the hard cap, however high the shopper flies', () => {
    expect(shopLoadRadiusM(10_000)).toBe(SHOP_MAX_LOAD_RADIUS_M);
    expect(shopLoadRadiusM(1e9)).toBe(SHOP_MAX_LOAD_RADIUS_M);
  });

  it('keeps unload strictly above load at every altitude (hysteresis never closes)', () => {
    for (const altitude of [0, 1, 7, 25, 60, 100, 500, 10_000]) {
      expect(shopUnloadRadiusM(altitude)).toBeGreaterThan(shopLoadRadiusM(altitude) + 29);
    }
  });

  it('does not thrash: a landlet at a fixed distance is never both loadable and unloadable', () => {
    for (const altitude of [0, 5, 30, 90, 400]) {
      const load = shopLoadRadiusM(altitude);
      const unload = shopUnloadRadiusM(altitude);
      for (const distance of [load - 1, load, load + 1, (load + unload) / 2, unload - 1, unload, unload + 1]) {
        const wouldLoad = distance < load;
        const wouldUnload = distance > unload;
        expect(wouldLoad && wouldUnload).toBe(false);
      }
    }
  });

  it('measures horizontal distance only (altitude and camera height do not count)', () => {
    expect(horizontalDistanceM(0, 0, 3, 4)).toBe(5);
    // Avatar over the landlet centre: 0 m, however far the camera trails behind it.
    expect(horizontalDistanceM(10, 10, 10, 10)).toBe(0);
  });
});

describe('pickLandletsToLoad (#3261)', () => {
  const at = (distance, i = distance) => ({ key: `l${i}`, distance });

  it('loads only landlets inside the radius, nearest first', () => {
    const picked = pickLandletsToLoad([at(50), at(10), at(70), at(30)], 0, 0);
    expect(picked.map((p) => p.distance)).toEqual([10, 30, 50]);
  });

  it('loads further-away landlets from altitude', () => {
    expect(pickLandletsToLoad([at(120)], 0, 0)).toEqual([]);
    expect(pickLandletsToLoad([at(120)], 0, 50)).toHaveLength(1);
  });

  it('never loads past the total cap, nearest wins', () => {
    const many = Array.from({ length: 200 }, (_, i) => at(i + 1, i));
    const picked = pickLandletsToLoad(many, 0, 10_000);
    expect(picked).toHaveLength(SHOP_MAX_LOADED_LANDLETS);
    expect(picked[0].distance).toBe(1);
  });

  it('counts already-loaded landlets against the cap, and loads none when full', () => {
    const many = Array.from({ length: 10 }, (_, i) => at(i + 1, i));
    expect(pickLandletsToLoad(many, SHOP_MAX_LOADED_LANDLETS - 3, 0)).toHaveLength(3);
    expect(pickLandletsToLoad(many, SHOP_MAX_LOADED_LANDLETS, 0)).toEqual([]);
    expect(pickLandletsToLoad(many, SHOP_MAX_LOADED_LANDLETS + 5, 0)).toEqual([]);
  });
});
