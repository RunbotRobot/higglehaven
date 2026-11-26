import { describe, it, expect } from 'vitest';
import { stemPathD, STEM_CURL_REACH_PX } from './stemPath.js';

const nums = (d) => d.match(/-?\d+(?:\.\d+)?/g).map(Number);

describe('stemPathD (#4432)', () => {
  const base = { x0: 28, y0: 22, stemX: 88, y1: 120, y2: 150, lastMid: 400 };

  it('starts at the head base and leaves it along the bud axis (down and to the right, reversed)', () => {
    const d = stemPathD(base);
    expect(d.startsWith('M 28 22 C ')).toBe(true);
    const [mx, my, c1x, c1y] = nums(d);
    // the first control point sits up and to the left of the base at 45 degrees: the tangent into the base is the axis
    expect(c1x - mx).toBeLessThan(0);
    expect(c1y - my).toBeLessThan(0);
    expect(Math.abs(Math.abs(c1x - mx) - Math.abs(c1y - my))).toBeLessThan(1e-9);
  });

  it('rises beside the head, left of the base, and ends on the stem line at the last leaf', () => {
    const d = stemPathD(base);
    const n = nums(d);
    // the vertical run is STEM_CURL_REACH_PX left of the base
    expect(d).toContain(`L ${base.x0 - STEM_CURL_REACH_PX} `);
    expect(n.slice(-2)).toEqual([88, 400]);
  });

  it('never goes off the left edge of the screen', () => {
    const d = stemPathD({ ...base, x0: 10 });
    expect(nums(d).every((v) => v >= 0)).toBe(true);
  });

  it('keeps y increasing along the vertical runs (no loop back up the leaves)', () => {
    const d = stemPathD({ ...base, y1: 40, y2: 60 }); // little room above the first leaf
    const ys = [...d.matchAll(/L (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[2]));
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });
});
