// #4198: shared/landlet-outline.js on a real outline (central-mosaic-002, 24 points, 1000 m2) and on shapes whose
// answer is obvious by eye.
import { describe, expect, it } from 'vitest';
import {
  parseOutline, scaleOutline, footprintCorners, pointInOutline, footprintInsideOutline, itemInsideLandletOutline,
} from '../shared/landlet-outline.js';

const REAL = [
  [-1.0352059562743006, -19.43562189789646], [3.2943859505707693, -16.07872786349931], [8.348278113357052, -13.963951836370894],
  [13.402170276143325, -11.849175809242482], [17.73176218298839, -8.49228177484537], [19.0938489513751, -5.7693126547413485],
  [18.256386715365075, -2.8421129354001486], [17.418924479355052, 0.08508678394104763], [18.78101124774176, 2.8080559040450375],
  [18.071499234972617, 6.8283644498598655], [15.273053582693393, 9.8007355624659], [12.474607930414178, 12.773106675071926],
  [11.76509591764504, 16.793415220886754], [5.504520081614361, 14.142556188917684], [-1.1762105490858334, 15.403389899637428],
  [-7.8569411797860305, 16.664223610357194], [-14.117517015816707, 14.013364578388131], [-15.03544835512479, 9.303331100918125],
  [-17.635228343990445, 5.269950718154082], [-20.235008332856104, 1.2365703353900344], [-21.152939672164187, -3.4734631420799644],
  [-14.76739729685068, -5.754845624319575], [-11.094072814219249, -11.454542519988216], [-7.420748331587804, -17.154239415656846],
].map(([x, y]) => ({ x, y }));

const SQUARE = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
// A "C": the square with a notch cut into its right side.
const C_SHAPE = [
  { x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: -2 }, { x: 0, y: -2 }, { x: 0, y: 2 }, { x: 10, y: 2 }, { x: 10, y: 10 }, { x: -10, y: 10 },
];

describe('parseOutline', () => {
  it('reads a list or its JSON text, and refuses anything unusable with null', () => {
    expect(parseOutline(SQUARE)).toHaveLength(4);
    expect(parseOutline(JSON.stringify(SQUARE))).toHaveLength(4);
    expect(parseOutline('not json')).toBeNull();
    expect(parseOutline([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
    expect(parseOutline([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 'a', y: 2 }])).toBeNull();
    expect(parseOutline(null)).toBeNull();
  });
});

describe('footprintCorners', () => {
  it('is the width by depth rectangle about the centre, turned by the rotation', () => {
    const flat = footprintCorners({ x: 5, y: 1, width: 4, depth: 2 });
    expect(flat.map((p) => [p.x, p.y])).toEqual([[3, 0], [7, 0], [7, 2], [3, 2]]);
    const turned = footprintCorners({ x: 0, y: 0, width: 4, depth: 2, rotationZ: Math.PI / 2 });
    expect(turned[0].x).toBeCloseTo(1);
    expect(turned[0].y).toBeCloseTo(-2);
  });
});

describe('footprintInsideOutline', () => {
  it('accepts a footprint well inside and refuses one past an edge', () => {
    expect(itemInsideLandletOutline(SQUARE, { x: 0, y: 0, width: 4, depth: 4 })).toBe(true);
    expect(itemInsideLandletOutline(SQUARE, { x: 9, y: 0, width: 4, depth: 4 })).toBe(false);
  });

  it('counts a turn: a 24 m item is too long square-on in a 20 m square but fits along the diagonal, and 30 m fits neither', () => {
    expect(itemInsideLandletOutline(SQUARE, { x: 0, y: 0, width: 24, depth: 1 })).toBe(false);
    expect(itemInsideLandletOutline(SQUARE, { x: 0, y: 0, width: 24, depth: 1, rotationZ: Math.PI / 4 })).toBe(true);
    expect(itemInsideLandletOutline(SQUARE, { x: 0, y: 0, width: 30, depth: 1, rotationZ: Math.PI / 4 })).toBe(false);
  });

  it('does not let a rectangle straddle a dent in a concave outline even with every corner inside', () => {
    // Corners at (1,-4) to (9,4) are all inside the C, but the notch (x 0 to 10, y -2 to 2) lies between them.
    const wide = footprintCorners({ x: 5, y: 0, width: 8, depth: 8 });
    expect(wide.every((corner) => pointInOutline(corner, C_SHAPE))).toBe(true);
    expect(footprintInsideOutline(C_SHAPE, wide)).toBe(false);
    // Above the notch the same size is simply inside.
    expect(footprintInsideOutline(C_SHAPE, footprintCorners({ x: 5, y: 6, width: 8, depth: 3 }))).toBe(true);
  });

  it('lets a corner rest exactly on an edge', () => {
    expect(footprintInsideOutline(SQUARE, [{ x: 10, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 0 }, { x: 5, y: -5 }])).toBe(true);
  });

  it('scales the outline with the height of the item', () => {
    const wide = { x: 9.5, y: 0, width: 1, depth: 1 };
    expect(itemInsideLandletOutline(SQUARE, wide, 1)).toBe(true);
    expect(itemInsideLandletOutline(SQUARE, wide, 0.9)).toBe(false);
    expect(scaleOutline(SQUARE, 1)).toBe(SQUARE);
  });

  it('answers true when the lándlet has no usable outline, leaving the caller to apply its own fallback', () => {
    expect(itemInsideLandletOutline(null, { x: 500, y: 500, width: 1, depth: 1 })).toBe(true);
  });
});

describe('the real outline of central-mosaic-002', () => {
  it('lets an item stand in the part of the lándlet a 31.6 m square would have refused, and refuses the square\'s corner', () => {
    // The outline reaches x = -21.15, past the square's edge at -15.8: buildable now.
    expect(itemInsideLandletOutline(REAL, { x: -19, y: 0, width: 1.5, depth: 1.5 })).toBe(true);
    // The square's corner (15.8, -15.8) is off this lándlet.
    expect(itemInsideLandletOutline(REAL, { x: 15, y: -15, width: 1.5, depth: 1.5 })).toBe(false);
  });

  it('finds the owner\'s stored brick position (about x 3.9, y 14.6, inside the old square) outside', () => {
    // The outline's top edge at x = 3.9 is at y about 14.44, so the owner's stored bricks at y 14.6 stand off the lándlet
    // although the old square (to y 15.8) accepted them; a brick a metre in is fine.
    expect(itemInsideLandletOutline(REAL, { x: 3.9, y: 14.6, width: 0.4, depth: 0.4 })).toBe(false);
    expect(itemInsideLandletOutline(REAL, { x: 3.9, y: 13.4, width: 0.4, depth: 0.4 })).toBe(true);
  });
});
