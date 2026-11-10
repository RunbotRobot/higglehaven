// #3400: the pure batching rules.
import { describe, expect, it } from 'vitest';
import { MIN_BATCH_SIZE, batchKey, groupPlacements } from './instanceBatching.js';

const brick = { templateId: 'brick', modelUrl: '/m/brick.glb', metadata: {} };
const chair = { templateId: 'chair', modelUrl: '/m/chair.glb', metadata: {} };
const floor = { templateId: 'floor', modelUrl: '/m/floor.glb', metadata: { flooring: true } };
const crate = { templateId: 'crate', modelUrl: null, metadata: {} };
const templates = { brick, chair, floor, crate };
const templateFor = (id) => templates[id];
const place = (id, templateId, extra = {}) => ({ instanceId: id, templateId, ...extra });

describe('batchKey', () => {
  it('is the same for placements that look identical', () => {
    expect(batchKey(place('a', 'brick'), brick)).toBe(batchKey(place('b', 'brick', { x: 5, rotationZ: 1 }), brick));
  });

  it('separates different templates and different scales', () => {
    expect(batchKey(place('a', 'brick'), brick)).not.toBe(batchKey(place('b', 'chair'), chair));
    expect(batchKey(place('a', 'brick'), brick)).not.toBe(batchKey(place('b', 'brick', { scale: 2 }), brick));
    expect(batchKey(place('a', 'brick'), brick)).toBe(batchKey(place('b', 'brick', { scale: 1 }), brick));
  });

  it('is null for anything that must keep its own mesh', () => {
    expect(batchKey(place('a', 'brick', { crop: { x: 0.2 } }), brick)).toBeNull();
    expect(batchKey(place('a', 'floor'), floor)).toBeNull();
    expect(batchKey(place('a', 'crate'), crate)).toBeNull();
    expect(batchKey(place('a', 'brick', { isCommunitySign: true }), brick)).toBeNull();
    expect(batchKey(place('a', 'brick', { isCommunityCalendar: true }), brick)).toBeNull();
    expect(batchKey(place('a', 'ghost'), undefined)).toBeNull();
    expect(batchKey(null, brick)).toBeNull();
  });

  it('treats an empty crop as uncropped', () => {
    expect(batchKey(place('a', 'brick', { crop: {} }), brick)).not.toBeNull();
    expect(batchKey(place('a', 'brick', { crop: null }), brick)).not.toBeNull();
  });
});

describe('groupPlacements', () => {
  it('groups identical placements in file order and keeps the rest as singles in file order', () => {
    const wall = Array.from({ length: 6 }, (_, i) => place(`b${i}`, 'brick'));
    const input = [wall[0], place('c1', 'chair'), wall[1], place('f1', 'floor'), wall[2], wall[3], wall[4], place('s1', 'brick', { isCommunitySign: true }), wall[5]];
    const { batches, singles } = groupPlacements(input, templateFor);
    expect([...batches.values()]).toHaveLength(1);
    expect([...batches.values()][0].map((p) => p.instanceId)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5']);
    expect(singles.map((p) => p.instanceId)).toEqual(['c1', 'f1', 's1']);
  });

  it('puts a group below the minimum back into singles, keeping file order', () => {
    const input = Array.from({ length: MIN_BATCH_SIZE - 1 }, (_, i) => place(`c${i}`, 'chair'));
    const { batches, singles } = groupPlacements(input, templateFor);
    expect(batches.size).toBe(0);
    expect(singles.map((p) => p.instanceId)).toEqual(input.map((p) => p.instanceId));
  });

  it('every placement lands in exactly one place', () => {
    const input = [
      ...Array.from({ length: 5 }, (_, i) => place(`b${i}`, 'brick')),
      ...Array.from({ length: 2 }, (_, i) => place(`c${i}`, 'chair')),
      place('x', 'brick', { crop: { z: 0.1 } }),
    ];
    const { batches, singles } = groupPlacements(input, templateFor);
    const ids = [...[...batches.values()].flat(), ...singles].map((p) => p.instanceId).sort();
    expect(ids).toEqual(input.map((p) => p.instanceId).sort());
  });

  it('tolerates empty and missing input', () => {
    expect(groupPlacements([], templateFor)).toEqual({ batches: new Map(), singles: [] });
    expect(groupPlacements(undefined, templateFor)).toEqual({ batches: new Map(), singles: [] });
  });
});
