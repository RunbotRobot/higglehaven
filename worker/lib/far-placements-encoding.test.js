import { describe, expect, it } from 'vitest';
import { encodeFarPlacements, decodeFarPlacements } from './far-placements-encoding.js';

const row = (overrides) => ({
  landlet_id: 'l1', cx: 10.005, cy: -20, template_id: 't1',
  x_m: 1.234, y_m: 2, z_m: 0, rotation_x_rad: 0, rotation_y_rad: 0, rotation_z_rad: 0.12345, scale: 1.5, crop_json: '{}',
  ...overrides,
});

describe('far placement encoding (#3417)', () => {
  it('shares one product table, rounds, groups by landlet, and keeps a crop only when present', () => {
    const tile = { x: 1, y: 2, sizeM: 512 };
    const encoded = encodeFarPlacements(tile, [
      row({}),
      row({ template_id: 't2', crop_json: '{"minX":0,"maxX":0.5}' }),
      row({ x_m: 5 }),
      row({ landlet_id: 'l2', cx: 7, cy: 8 }),
    ]);
    expect(encoded.templates).toEqual(['t1', 't2']);
    expect(encoded.landlets.map((l) => [l.id, l.items.length])).toEqual([['l1', 3], ['l2', 1]]);
    expect(encoded.landlets[0].cx).toBe(10.01);
    expect(encoded.landlets[0].items[0]).toEqual([0, 1.23, 2, 0, 0, 0, 0.123, 1.5]); // no crop element
    expect(encoded.landlets[0].items[1]).toEqual([1, 1.23, 2, 0, 0, 0, 0.123, 1.5, { minX: 0, maxX: 0.5 }]);
    const decoded = decodeFarPlacements(encoded);
    expect(decoded.landlets[0].items[1]).toMatchObject({ templateId: 't2', crop: { minX: 0, maxX: 0.5 } });
    expect(decoded.landlets[0].items[0].crop).toBeNull();
  });

  it('tolerates bad crop JSON and null scale, and never emits negative zero', () => {
    const encoded = encodeFarPlacements({ x: 0, y: 0, sizeM: 512 }, [row({ crop_json: '{oops', scale: null, x_m: -0.0001 })]);
    const item = encoded.landlets[0].items[0];
    expect(item).toHaveLength(8);
    expect(item[7]).toBe(1);
    expect(Object.is(item[1], -0)).toBe(false);
  });

  it('encodes an empty tile', () => {
    expect(encodeFarPlacements({ x: 0, y: 0, sizeM: 512 }, [])).toEqual({ tile: { x: 0, y: 0, sizeM: 512 }, templates: [], landlets: [] });
  });
});
