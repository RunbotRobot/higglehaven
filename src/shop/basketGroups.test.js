// #4612: the Basket leaf groups lines by seller, and a line whose seller is gone is grouped, never dropped.
import { describe, it, expect } from 'vitest';
import { groupBasketLines } from './basketGroups.js';

describe('groupBasketLines (#4612)', () => {
  it('groups by seller in the order each seller first appears, keeping the line order inside a group', () => {
    const lines = [
      { instanceId: 'a', sellerId: 's1', sellerName: 'Lamp Works' },
      { instanceId: 'b', sellerId: 's2', sellerName: 'Rug Co' },
      { instanceId: 'c', sellerId: 's1', sellerName: 'Lamp Works' },
    ];
    const groups = groupBasketLines(lines);
    expect(groups.map((g) => g.sellerName)).toEqual(['Lamp Works', 'Rug Co']);
    expect(groups[0].lines.map((l) => l.instanceId)).toEqual(['a', 'c']);
  });

  it('puts lines with no seller under one plain heading', () => {
    const groups = groupBasketLines([{ instanceId: 'x', sellerId: null, sellerName: null }, { instanceId: 'y', sellerId: null, sellerName: null }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sellerName).toBe('Unknown seller');
    expect(groups[0].lines).toHaveLength(2);
  });
});
