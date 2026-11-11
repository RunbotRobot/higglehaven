import { describe, expect, it } from 'vitest';
import {
  FAR_VIEW_TILE_M, FAR_VIEW_MIN_PX, FAR_VIEW_MAX_INSTANCES, farViewTilesInRange, farViewTileKey,
  decodeFarPlacementsPayload, planFarView,
} from './farViewPlan.js';

const view = { fovDeg: 60, viewportHeightPx: 844 };
const models = {
  has: (id) => id !== 'nomodel',
  radiusM: (id, scale) => (id === 'big' ? 5 : 0.5) * scale,
  triangles: (id) => (id === 'big' ? 200 : 20),
};
const camera = { x: 0, y: 0, z: 100 };

const landlet = (id, items) => ({ id, cx: 0, cy: 0, items });
const item = (templateId, x, y, extra = {}) => ({ templateId, x, y, z: 0, scale: 1, ...extra });

describe('farViewTilesInRange (#3477)', () => {
  it('lists the tile under the avatar first and only tiles within range', () => {
    const tiles = farViewTilesInRange(10, 10, 600);
    expect(farViewTileKey(tiles[0])).toBe('0,0');
    for (const tile of tiles) expect(tile.distance).toBeLessThanOrEqual(600);
    expect(tiles.map(farViewTileKey)).toContain('1,0');
    expect(tiles.map(farViewTileKey)).not.toContain('3,3');
  });

  it('handles negative coordinates with floor, like the server', () => {
    expect(farViewTilesInRange(-1, -1, 10).map(farViewTileKey)).toContain('-1,-1');
    expect(FAR_VIEW_TILE_M).toBe(512);
  });
});

describe('decodeFarPlacementsPayload (#3477)', () => {
  it('names the product and adds the landlet centre', () => {
    const [decoded] = decodeFarPlacementsPayload({
      templates: ['a', 'b'],
      landlets: [{ id: 'L', cx: 100, cy: -50, items: [[1, 2, 3, 4, 0, 0, 1.5, 2], [0, 0, 0, 0, 0, 0, 0, 1, { w: 0.5 }], [9, 0, 0, 0, 0, 0, 0, 1]] }],
    });
    expect(decoded.items).toHaveLength(2); // template index 9 does not exist: skipped
    expect(decoded.items[0]).toMatchObject({ templateId: 'b', x: 102, y: -47, z: 4, rotationZ: 1.5, scale: 2, crop: null });
    expect(decoded.items[1].crop).toEqual({ w: 0.5 });
  });

  it('tolerates an empty or malformed payload', () => {
    expect(decodeFarPlacementsPayload(null)).toEqual([]);
    expect(decodeFarPlacementsPayload({})).toEqual([]);
  });
});

describe('planFarView (#3477)', () => {
  it('groups by product across landlets', () => {
    const { byTemplate, stats } = planFarView({
      landlets: [landlet('A', [item('big', 100, 0), item('big', 120, 0)]), landlet('B', [item('big', 0, 150)])],
      loadedIds: new Set(), camera, view, models,
    });
    expect(byTemplate.get('big')).toHaveLength(3);
    expect(stats).toMatchObject({ instances: 3, triangles: 600, landlets: 2 });
  });

  it('skips landlets the normal loader has loaded (no double draw)', () => {
    const { byTemplate, stats } = planFarView({
      landlets: [landlet('A', [item('big', 100, 0)]), landlet('B', [item('big', 0, 150)])],
      loadedIds: new Set(['A']), camera, view, models,
    });
    expect(byTemplate.get('big')).toHaveLength(1);
    expect(stats.skippedLoaded).toBe(1);
  });

  it('drops an item under one pixel and keeps one just over it', () => {
    // 'small' is 0.5 m in radius: about 0.15 px at 5 km, about 2.4 px at 300 m.
    const { stats: tiny } = planFarView({ landlets: [landlet('A', [item('small', 5000, 0)])], loadedIds: new Set(), camera, view, models });
    expect(tiny.tooSmall).toBe(1);
    expect(tiny.instances).toBe(0);
    const { stats: seen } = planFarView({ landlets: [landlet('A', [item('small', 300, 0)])], loadedIds: new Set(), camera, view, models });
    expect(seen.instances).toBe(1);
  });

  it('never draws a product with no far model, and counts it', () => {
    const { byTemplate, stats } = planFarView({ landlets: [landlet('A', [item('nomodel', 100, 0)])], loadedIds: new Set(), camera, view, models });
    expect(byTemplate.size).toBe(0);
    expect(stats.noModel).toBe(1);
  });

  it('drops the smallest on screen first when over the instance cap', () => {
    const near = item('big', 50, 0);
    const far = item('big', 900, 0);
    const { byTemplate, stats } = planFarView({
      landlets: [landlet('A', [far, near])], loadedIds: new Set(), camera, view, models, caps: { maxInstances: 1 },
    });
    expect(byTemplate.get('big')).toHaveLength(1);
    expect(byTemplate.get('big')[0].x).toBe(50);
    expect(stats.overBudget).toBe(1);
  });

  it('drops the smallest on screen first when over the triangle cap', () => {
    const { byTemplate, stats } = planFarView({
      landlets: [landlet('A', [item('big', 900, 0), item('big', 50, 0), item('big', 400, 0)])],
      loadedIds: new Set(), camera, view, models, caps: { maxTriangles: 400 },
    });
    expect(byTemplate.get('big').map((i) => i.x)).toEqual([50, 400]);
    expect(stats).toMatchObject({ triangles: 400, overBudget: 1 });
  });

  it('orders each product list largest on screen first (the build order)', () => {
    const { byTemplate } = planFarView({
      landlets: [landlet('A', [item('big', 900, 0), item('big', 50, 0), item('big', 400, 0)])],
      loadedIds: new Set(), camera, view, models,
    });
    const px = byTemplate.get('big').map((i) => i.px);
    expect([...px].sort((a, b) => b - a)).toEqual(px);
  });

  it('states a phone-class default cap', () => {
    expect(FAR_VIEW_MAX_INSTANCES).toBe(4000);
  });
});
